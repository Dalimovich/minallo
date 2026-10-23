"""Zero-cost rescoring of the already-saved 2026-10-22 Jev evaluation
(reports/jev-corpus-evaluation-2026-10-22.json) through the real, trusted
policy compiler -- NO new API calls; reuses only data already paid for.

Why: jev_corpus_evaluation.py's own scoring used Jev's raw
``final_answer_permitted`` noul >= 0.5 directly as the release-authorization
decision (``final_answer = "permitted" if noul >= 0.5 else "prohibited"``).
That IS "an independent universal numeric-answer gate" -- the trusted
``compile_policy``, not Jev, must decide what gets released (2026-10-23
review finding). This script instead treats Jev's ``target``/``objective``
choices as UNTRUSTED INTERPRETATION PROPOSALS -- Jev's own
``final_answer_permitted`` value is read from the saved file only for the
side-by-side comparison column, never fed into the compiled action -- grounds
the target through ``diagnostic_policy.resolve_target_identity`` (the exact
same trust boundary the deterministic production path uses: Jev is not
trusted to invent an exercise identity any more than any other model claim
is), and lets ``compile_policy``'s own existing, already-tested fallback
rules decide ``final_answer``.

Deliberate limitations of this rescoring, reported rather than hidden:
- No cross-turn ``TurnLedger`` (``turn_ledger=None``, matching
  ``semantic_intent_deterministic_baseline.py``'s own setting) -- a fair
  comparison of the SAME single-turn-at-a-time slice for both arms, not a
  claim that either one has real persisted-restriction behavior here.
- Jev's 3-question schema has no slot for an explicit multi-target split --
  turns whose gold expectation names more than one target are EXCLUDED from
  the headline accuracy (reported separately), never scored as a lucky
  partial match the way the original harness did.
- Jev's objective vocabulary (hint/explain/solve/summarize/other) has no
  distinguished "quiz" value the way the deterministic path's
  ``AcademicIntent`` does (``diagnostic_policy.py`` deliberately maps
  ``QUIZ_GENERATION`` -> ``"hint"`` to reuse hint's protective fallback) --
  quiz-shaped requests landing on Jev's ``objective="other"`` get
  ``compile_policy``'s ordinary tutoring default (final_answer permitted),
  not a quiz-specific one. Reported as a real structural gap, not patched
  with an unvalidated heuristic invented for this script.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.diagnostic_policy import resolve_target_identity  # noqa: E402
from app.services.policy_compiler import compile_policy  # noqa: E402
from app.services.resolved_student_intent import (  # noqa: E402
    Action, ReleaseConstraints, ResolvedStudentIntent,
)

SAVED = json.loads((ROOT / "reports/jev-corpus-evaluation-2026-10-22.json").read_text(encoding="utf-8"))
DOCUMENTS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))
CORPUS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))
_SCENARIO_BY_ID = {c["id"]: c for c in CORPUS["cases"]}

_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}
# Jev's own choice-option names already match the real Objective literal
# values 1:1 (hint/explain/solve/summarize/other) -- confirmed against
# resolved_student_intent.Objective -- so no separate mapping table is
# needed here, unlike diagnostic_policy.py's AcademicIntent bridge.
_VALID_OBJECTIVES = frozenset({"hint", "explain", "solve", "summarize", "other"})
# The subset of diagnostic_policy._OBJECTIVES_WITHOUT_EXERCISE_IDENTITY that
# Jev's vocabulary can even express -- ported, not invented: production
# treats these as never needing a verified numbered-exercise identity.
_OBJECTIVES_WITHOUT_EXERCISE_IDENTITY = frozenset({"explain", "summarize"})


def _authorized_labels(document: dict) -> frozenset[str]:
    return frozenset((document.get("exercises") or {}).keys())


def _rescore_action(*, jev_target: str, jev_objective: str, message: str, document: dict) -> dict:
    labels = _authorized_labels(document)
    is_content_scope = jev_target == "document" or jev_target.startswith("section:") or jev_target == "none"
    target_resolved = (not is_content_scope) and resolve_target_identity(
        jev_target, original_message=message, verified_active_question=None,
        authorized_exercise_labels=labels,
    )
    objective = jev_objective if jev_objective in _VALID_OBJECTIVES else "other"
    # Mirrors diagnostic_policy.py's "current_request" placeholder
    # convention exactly: a claim that isn't a grounded numbered exercise
    # only ever gets a "requested" state when the objective itself has no
    # answer-key concept to protect in the first place.
    action_target = jev_target if target_resolved else "current_request"
    state = (
        "requested" if (target_resolved or objective in _OBJECTIVES_WITHOUT_EXERCISE_IDENTITY)
        else "unresolved"
    )
    action = Action(
        objective=objective, target=action_target,
        release=ReleaseConstraints(),  # fully unspecified -- Jev's noul is NEVER read into this
        state=state,
    )
    intent = ResolvedStudentIntent(
        schema_version="1.0.0", original_message=message, student_goal=message,
        actions=(action,), conversation="new", references=None,
        response_language="en", teaching=None, trust=None,
    )
    policy = compile_policy(intent, turn_ledger=None, conversation_id=None)
    compiled = policy.actions[0]
    return {"target_resolved": target_resolved or is_content_scope, "state": compiled.state,
            "final_answer": compiled.release.final_answer}


def main() -> None:
    rows: list[dict] = []
    multi_target_excluded = 0
    counts = {
        "turns": 0, "target_match": 0, "objective_match": 0,
        "final_answer_match_raw_noul_gate": 0, "final_answer_match_compiled_policy": 0,
        "all_match_raw_noul_gate": 0, "all_match_compiled_policy": 0,
    }

    for turn in SAVED["turns"]:
        scenario = _SCENARIO_BY_ID[turn["scenario"]]
        document = DOCUMENTS[scenario["document"]]
        expected = turn["expected"]
        is_multi_target = len(expected) > 1
        expected_final_answers = {_RELEASE_TO_FINAL_ANSWER.get(e["release"], "unspecified") for e in expected}

        jev = turn["jev_result"]
        rescored = _rescore_action(
            jev_target=jev["target"], jev_objective=jev["objective"],
            message=turn["student"], document=document,
        )

        target_match = turn["score"]["target_match"]
        objective_match = turn["score"]["objective_match"]
        raw_final_match = turn["score"]["final_answer_match"]
        compiled_final_match = target_match and (
            rescored["final_answer"] in expected_final_answers or "unspecified" in expected_final_answers
        )

        row = {
            "scenario": turn["scenario"], "category": turn["category"], "turn": turn["turn"],
            "student": turn["student"], "is_multi_target": is_multi_target,
            "jev_target": jev["target"], "jev_objective": jev["objective"],
            "expected_final_answers": sorted(expected_final_answers),
            "raw_final_answer": jev["final_answer"], "raw_final_answer_noul": jev.get("final_answer_noul"),
            "compiled_final_answer": rescored["final_answer"], "compiled_state": rescored["state"],
            "target_match": target_match, "objective_match": objective_match,
            "raw_final_match": raw_final_match, "compiled_final_match": compiled_final_match,
        }
        rows.append(row)

        if is_multi_target:
            multi_target_excluded += 1
            continue  # excluded from headline accuracy -- see module docstring

        counts["turns"] += 1
        counts["target_match"] += target_match
        counts["objective_match"] += objective_match
        counts["final_answer_match_raw_noul_gate"] += raw_final_match
        counts["final_answer_match_compiled_policy"] += compiled_final_match
        counts["all_match_raw_noul_gate"] += target_match and objective_match and raw_final_match
        counts["all_match_compiled_policy"] += target_match and objective_match and compiled_final_match

    n = counts["turns"]
    summary = {
        "single_target_turns_scored": n,
        "multi_target_turns_excluded_from_headline": multi_target_excluded,
        "target_accuracy": round(counts["target_match"] / n, 4),
        "objective_accuracy": round(counts["objective_match"] / n, 4),
        "final_answer_accuracy_raw_noul_gate": round(counts["final_answer_match_raw_noul_gate"] / n, 4),
        "final_answer_accuracy_compiled_policy": round(counts["final_answer_match_compiled_policy"] / n, 4),
        "all_fields_accuracy_raw_noul_gate": round(counts["all_match_raw_noul_gate"] / n, 4),
        "all_fields_accuracy_compiled_policy": round(counts["all_match_compiled_policy"] / n, 4),
    }

    changed = [
        r for r in rows if not r["is_multi_target"] and r["raw_final_match"] != r["compiled_final_match"]
    ]
    out = {"summary": summary, "changed_by_rescoring": changed, "all_rows": rows}
    out_path = ROOT / "reports" / "jev-policy-compiler-rescoring-2026-10-23.json"
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=True), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\n{len(changed)} single-target turns changed final_answer verdict after compiling through the real policy.")
    print(f"Full results written to {out_path}")


if __name__ == "__main__":
    main()
