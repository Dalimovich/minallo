"""Arm D LIVE runner design -- Jev-assisted interpretation with MANDATORY
escalation to Milestone 4 (Arm B), structural or confidence-based.

NOT RUNNABLE YET: this arm consumes a real Jev report in
jev_corpus_evaluation.py's exact per-turn shape (``jev_result`` with
``target``/``objective``/``target_confidence``/``objective_confidence``),
collected against the SAME gold-independent transcript Arms A/B use
(scripts.semantic_blind_ab_transcript) -- the existing 2026-10-22 Jev
report does not qualify (no assistant turns in its context at all; see
jev_policy_rescoring.py's module docstring) and no qualifying report
exists yet. Running this arm for real needs its own approved Jev budget
(a fresh corpus pass) BEFORE it can run at all -- building this script now
does not spend anything; ``main()`` below still requires --live and a real
Jev report path.

Escalation rule (2026-10-23 review requirement: "Arm D must combine Jev
with mandatory structural and confidence-based escalation" -- not
confidence alone):

- MANDATORY, always escalate regardless of confidence: any of
  jev_policy_adapter's own explicit-tracking flags fire for this turn --
  ``target_unverified``, ``objective_unsupported``, multi-target, or a
  permission-change-dependent turn. These are cases no confidence number
  from Jev can rescue, because the schema itself cannot carry the needed
  information (see jev_policy_adapter.py's docstring).
- CONFIDENCE-based: Jev's own ``target_confidence``/``objective_confidence``
  (from the real API response -- see jev_corpus_evaluation.py's
  ``_ask_jev``) falls below ``CONFIDENCE_THRESHOLD``.

CONFIDENCE_THRESHOLD is deliberately UNSET (``None``) here. Per the
2026-10-23 review's Phase 2/5 requirement, it must be chosen on a
DEVELOPMENT split of the corpus, then evaluated once, unchanged, against
tests/fixtures/semantic_blind_ab_holdout.json -- never tuned against the
holdout itself. Choosing it is real analysis work that needs the real Arm
C data this script doesn't have yet; it is left as a required CLI argument
(``--confidence-threshold``) with no default, so a future run cannot
silently proceed without that analysis having happened first.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.jev_policy_adapter import (  # noqa: E402
    is_permission_change_untestable, load_corpus, load_documents, rescore_jev_answer,
)
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402

CORPUS = load_corpus()
DOCUMENTS = load_documents()
_SCENARIO_BY_ID = {c["id"]: c for c in CORPUS["cases"]}


def should_escalate_to_milestone4(
    *, jev_turn: dict, gold_form: str, category: str, turn_index: int,
    target_unverified: bool, confidence_threshold: float,
) -> tuple[bool, str]:
    """Returns (escalate, reason). Mandatory reasons are checked first and
    never overridden by a high confidence score -- see module docstring."""
    if is_permission_change_untestable(category=category, turn_index=turn_index):
        return True, "mandatory:permission_change_untestable"
    if target_unverified:
        return True, "mandatory:target_unverified"
    from scripts.jev_policy_adapter import UNSUPPORTED_FORMS
    if gold_form in UNSUPPORTED_FORMS:
        return True, "mandatory:objective_unsupported"
    target_confidence = jev_turn.get("target_confidence")
    objective_confidence = jev_turn.get("objective_confidence")
    lowest = min(c for c in (target_confidence, objective_confidence) if c is not None) \
        if (target_confidence is not None or objective_confidence is not None) else 0.0
    if lowest < confidence_threshold:
        return True, f"confidence:{lowest:.2f}<{confidence_threshold:.2f}"
    return False, "jev_sufficient"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument(
        "--jev-report", type=Path, required=True,
        help="A real Jev corpus report collected against the shared transcript -- does not exist yet.",
    )
    parser.add_argument(
        "--confidence-threshold", type=float, required=True,
        help="Chosen on a DEV split, never on the holdout -- no default provided deliberately.",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.live:
        parser.error("requires --live; this is a real-spend arm (escalated turns call Arm B for real)")
    if not args.jev_report.exists():
        parser.error(
            f"{args.jev_report} does not exist -- Arm D needs a real Jev report collected against "
            "scripts.semantic_blind_ab_transcript's shared history first (its own approved run)"
        )
    if args.output.exists():
        parser.error("output already exists; no reruns/overwrites")

    from scripts.semantic_intent_eval_arm_ab_live import _run_arm_b_turn  # only needed when escalating

    jev_report = json.loads(args.jev_report.read_text(encoding="utf-8"))
    rows = []
    for jev_turn in jev_report["turns"]:
        scenario = _SCENARIO_BY_ID[jev_turn["scenario"]]
        document = DOCUMENTS[scenario["document"]]
        turn_index = jev_turn["turn"] - 1
        turn = scenario["turns"][turn_index]
        gold_form = turn["expected"][0]["form"]

        rescored = rescore_jev_answer(
            jev_target=jev_turn["jev_result"]["target"], jev_objective=jev_turn["jev_result"]["objective"],
            gold_form=gold_form, message=turn["student"], document=document,
        )
        escalate, reason = should_escalate_to_milestone4(
            jev_turn=jev_turn["jev_result"], gold_form=gold_form, category=jev_turn["category"],
            turn_index=turn_index, target_unverified=rescored.target_unverified,
            confidence_threshold=args.confidence_threshold,
        )
        if escalate:
            previous_turns = build_history_turns(scenario, turn_index)
            b_result = _run_arm_b_turn(turn["student"], previous_turns=previous_turns, document=document)
            actions = b_result["actions"]
        else:
            actions = [{
                "target": jev_turn["jev_result"]["target"], "objective": jev_turn["jev_result"]["objective"],
                "final_answer": rescored.compiled_final_answer,
            }]
        rows.append({
            "scenario": jev_turn["scenario"], "turn": jev_turn["turn"],
            "escalated": escalate, "escalation_reason": reason, "actions": actions,
        })
    args.output.write_text(json.dumps({"rows": rows}, indent=2, ensure_ascii=True), encoding="utf-8")
    print(f"{sum(r['escalated'] for r in rows)}/{len(rows)} turns escalated to Arm B. Written to {args.output}")


if __name__ == "__main__":
    main()
