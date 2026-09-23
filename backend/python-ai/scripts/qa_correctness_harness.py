"""Bounded content-qualification harness for any German Exam profile/module/part.

Extends the `qa_testdaf_live.py` / `qa_budget.py` pattern (this file reuses `QaBudget`,
`add_budget_args`, `labeled_usage` unchanged) with a single addition: for every sample it produces,
it independently reports five separate PASS/FAIL layers instead of one pass/fail status —

    STRUCTURE   — did the deterministic validator accept the generated content?
    CONTENT     — did semantic verification accept it? (mocked in --dry-run, real in --execute)
    ANSWER_KEY  — is the answer key internally resolvable (every answerId points at a real
                  option of that same question; no leaked model-answer field on productive tasks)?
    GRADING     — does a production grading route actually exist for this part today (a static,
                  code-derived reachability table — see GRADING_AUDIT.md Phase 5 for how this was
                  established by reading `routers/german_exam.py`)?
    DELIVERY    — is this task type registered as implemented in `german_exams/task_types.py`
                  (the same gate `manifest.py`/the generation router use)?

`--dry-run` (the default — see `main()`) never imports a real generator module and never makes a
provider call: it builds deterministic mock content shaped for the part's task-type family
(selection vs productive) and runs it through the REAL, pure-Python deterministic validator
(`german_exam_validator.validate_content`) and a REAL, pure-Python answer-key check — only the
CONTENT (semantic) layer is mocked, clearly labelled `"contentMocked": true` in every record, since
semantic verification is inherently an LLM call.

`--execute` wires the same 5-layer check onto the REAL generator dispatch
(`german_exam_generator._dispatch_module`) and REAL semantic verification, incurring a real,
`QaBudget`-capped cost. This code path is built and unit-tested with mocks only (see
`tests/test_qa_correctness_harness.py`) — it is never invoked against a real provider from this
repository's own test suite, CI, or any automated path. Running it for real is a separate,
human-initiated, human-supervised action outside this task, exactly like `qa_testdaf_live.py`.

Nothing here writes to inventory, flips an `available` flag, or makes an unbounded retry loop —
`guard_new_sample()` is called immediately before every sample, exactly like `qa_testdaf_live.py`.

KNOWN LIMITATION (by design, not fixed in this pass): `--dry-run`'s mock content only covers two
generic shapes (`source-selection-v1` and `productive-task-v1`). Several task types have a more
specific real shape (e.g. `speaker_statement_matching`'s `segments` array, media tasks' `media`
object) that the generic selection mock does not reproduce, so STRUCTURE may honestly FAIL in
dry-run for those task types even though the real generator produces valid content — this is
surfaced truthfully (never masked as a pass) rather than special-cased per task type, which would
have meant hand-authoring ~24 bespoke mocks. Building fully shape-accurate mocks for every task
type was judged out of scope for this pass; the harness's value in --dry-run is proving the
pipeline (budget enforcement, per-sample layer reporting, record writing) works end to end, not
certifying every task type's STRUCTURE layer against a mock. Real STRUCTURE/CONTENT verification
for these task types requires --execute (not run in this task) against the real generator.
"""

from __future__ import annotations

import argparse
import json
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

from scripts.qa_budget import BudgetExceeded, QaBudget, add_budget_args, labeled_usage

DEFAULT_TOPIC: dict[str, str] = {"topicId": "qa_sample", "label": "Digitalisierung des Hochschulalltags"}

# --- GRADING reachability: a static table derived from reading routers/german_exam.py
# (see GRADING_AUDIT.md Phase 5). This harness never calls a grading endpoint itself — it only
# reports whether one exists, from code inspection frozen into this table. Update this table only
# when the routing actually changes (grep routers/german_exam.py to re-derive it), never guess.
_GRADING_REACHABLE_TASK_TYPES = frozenset({"choice_long_form_writing"})  # TELC schreiben_1, via /grade-writing
_GRADING_REACHABLE_PARTS = frozenset({
    ("telc_c1_hochschule", "speaking", "sprechen_1"),  # via /german-exam/speaking (Literal-gated to TELC)
    ("telc_c1_hochschule", "speaking", "sprechen_2"),
})


@dataclass
class LayerResult:
    structure: bool
    content: bool
    contentMocked: bool
    answerKey: bool
    grading: bool
    delivery: bool
    detail: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def check_structure(part, content: Any) -> tuple[bool, dict[str, Any]]:
    """Runs the REAL deterministic validator (pure Python, no network) against `content`."""
    from app.services.german_exam_validator import hard_issues, validate_content

    try:
        issues = validate_content(part, content)
    except Exception as exc:  # noqa: BLE001 — a validator crash is a STRUCTURE fail, not a harness crash
        return False, {"error": f"{type(exc).__name__}: {exc}"}
    ok = not hard_issues(issues)
    return ok, {"issues": issues}


def check_answer_key(part, content: Any) -> tuple[bool, dict[str, Any]]:
    """Structural answer-key resolvability — never assumes PASS on an unrecognised content shape."""
    if isinstance(content, dict) and isinstance(content.get("questions"), list) and content["questions"]:
        for q in content["questions"]:
            option_ids = {o.get("id") for o in (q.get("options") or [])}
            if not option_ids or q.get("answerId") not in option_ids:
                return False, {"reason": "answerId does not resolve to one of that question's own options", "questionId": q.get("id")}
        return True, {"questionCount": len(content["questions"])}
    if isinstance(content, dict) and content.get("schemaVersion") == "productive-task-v1":
        leaked = [k for k in ("answer", "modelAnswer") if k in content]
        return (not leaked), {"leakedKeys": leaked}
    return False, {"reason": "unrecognised content shape — cannot verify an answer key, never assumed"}


def check_grading(profile_id: str, module: str, part_id: str, task_type: str) -> tuple[bool, dict[str, Any]]:
    reachable = task_type in _GRADING_REACHABLE_TASK_TYPES or (profile_id, module, part_id) in _GRADING_REACHABLE_PARTS
    return reachable, {"source": "static table derived from routers/german_exam.py, see GRADING_AUDIT.md"}


def check_delivery(task_type: str) -> tuple[bool, dict[str, Any]]:
    from app.services.german_exams.task_types import is_task_type_implemented

    return is_task_type_implemented(task_type), {"registry": "german_exams/task_types.py"}


def _mock_selection_content(part) -> dict[str, Any]:
    item_count = int(part.constraints.get("itemCount") or part.constraints.get("gapCount") or 3)
    option_count = int(part.constraints.get("optionCount") or 4)
    options = [{"id": f"o{i}", "text": f"Option {i}"} for i in range(option_count)]
    questions = [
        {
            "id": f"q{i}",
            "prompt": f"Mock prompt {i}",
            "answerId": options[i % option_count]["id"],
            "options": options,
            "evidenceIds": ["p1"],
            "skillTags": list(part.allowed_skill_tags[:1]) or ["detail_comprehension"],
        }
        for i in range(item_count)
    ]
    return {
        "schemaVersion": "source-selection-v1",
        "source": {"paragraphs": [{"id": "p1", "text": "Mock source paragraph text for dry-run only."}]},
        "options": options,
        "questions": questions,
    }


def _mock_productive_content(part) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    for kind in part.constraints.get("requiredSourceKinds", ()):
        if kind == "graphic":
            sources.append({
                "id": "s1", "kind": "graphic",
                "graphic": {"title": "Mock", "unit": "%", "columns": [{"id": "a", "label": "A"}],
                            "rows": [{"id": "r1", "label": "R1", "values": {"a": 1}}]},
            })
        else:
            sources.append({"id": f"s_{kind}", "kind": kind, "text": "Mock source text for dry-run only."})
    return {"schemaVersion": "productive-task-v1", "id": "task", "prompt": "Mock task prompt.", "sources": sources}


_PRODUCTIVE_TASK_TYPES = frozenset({
    "choice_long_form_writing", "forum_discussion_post", "formal_context_message",
    "argumentative_essay", "text_graph_summary",
    "spoken_advice", "spoken_option_comparison", "spoken_text_summary", "spoken_information_comparison",
    "recorded_topic_presentation", "spoken_argument_response", "spoken_measure_critique",
    "presentation_summary_followup", "quote_guided_discussion",
    "presentation_with_followup", "guided_pair_discussion",
})


def _dry_run_generate(part) -> tuple[dict[str, Any], dict[str, Any]]:
    """Zero provider/network calls. Builds mock content shaped for this part's task-type family,
    then reports a mocked (never real) CONTENT/semantic verdict — real content shape validity is
    still checked for real by `check_structure`/`check_answer_key` below, which run on this exact
    mock data."""
    if part.task_type in _PRODUCTIVE_TASK_TYPES:
        content = _mock_productive_content(part)
    else:
        content = _mock_selection_content(part)
    meta = {"deterministicPassed": True, "semantic": {"passed": True, "mocked": True}, "dryRun": True}
    return content, meta


def _execute_generate(profile, part):
    """Real generation dispatch — see module docstring: built and unit-tested with mocks only,
    never invoked against a real provider by this repository's own tests/CI/automation."""
    from app.services.german_exam_generator import _dispatch_module

    return _dispatch_module(part.module)(profile, part, [], dict(DEFAULT_TOPIC))


def run_sample(profile, part, *, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        content, meta = _dry_run_generate(part)
        content_mocked = True
    else:
        content, meta = _execute_generate(profile, part)
        content_mocked = False

    structure_ok, structure_detail = check_structure(part, content)
    if content_mocked:
        content_ok, content_detail = bool((meta.get("semantic") or {}).get("passed")), {"mocked": True}
    else:
        content_ok, content_detail = bool((meta.get("semantic") or {}).get("passed")), {"mocked": False}
    answer_key_ok, answer_key_detail = check_answer_key(part, content)
    grading_ok, grading_detail = check_grading(profile.profile_id, part.module, part.part_id, part.task_type)
    delivery_ok, delivery_detail = check_delivery(part.task_type)

    layers = LayerResult(
        structure=structure_ok, content=content_ok, contentMocked=content_mocked,
        answerKey=answer_key_ok, grading=grading_ok, delivery=delivery_ok,
        detail={"structure": structure_detail, "content": content_detail,
                "answerKey": answer_key_detail, "grading": grading_detail, "delivery": delivery_detail},
    )
    return {"content": content, "generatorMeta": meta, "layers": layers.to_dict()}


def run(args: argparse.Namespace) -> int:
    dry_run = bool(args.dry_run)
    if not dry_run and not args.confirm_execute:
        raise SystemExit("--execute requires --confirm-execute as a second, explicit guard against accidental live calls")

    from app.services.german_exams import get_part, get_profile

    profile = get_profile(args.profile)
    part = get_part(args.profile, args.module, args.part)
    label = f"{args.profile}_{args.module}_qa_correctness"
    budget = QaBudget(max_cost_usd=args.max_cost_usd, max_samples=args.max_samples, label=label)

    args.out.mkdir(parents=True, exist_ok=True)
    failures = 0
    terminated: dict[str, Any] | None = None

    with labeled_usage(label):
        for index in range(1, args.max_samples + 1):
            try:
                budget.guard_new_sample()
            except BudgetExceeded as exc:
                terminated = {"terminated": True, "reason": str(exc), "beforeSample": index}
                print(json.dumps(terminated), flush=True)
                break

            started = perf_counter()
            try:
                result = run_sample(profile, part, dry_run=dry_run)
                status, error = "pass", None
            except Exception as exc:  # noqa: BLE001 — a generator/validator crash is a recorded failure, not a harness crash
                result, status, error = None, "fail", f"{type(exc).__name__}: {exc}"

            budget.record_sample()
            cost = 0.0 if dry_run else None  # real cost accounting belongs to --execute's own gen_timing wiring, not built/exercised here
            budget.record_call(cost, sample=index, module=args.module, part=part.part_id)
            layer_failed = result is None or not all(result["layers"][k] for k in ("structure", "content", "answerKey", "grading", "delivery"))
            failures += int(status != "pass" or layer_failed)

            record = {
                "profileId": profile.profile_id, "profileVersion": profile.profile_version,
                "module": args.module, "partId": part.part_id, "partAvailable": part.available,
                "taskType": part.task_type, "sample": index, "status": status, "error": error,
                "result": result, "wallSeconds": round(perf_counter() - started, 3),
                "usageLabel": label, "generationId": uuid.uuid4().hex, "dryRun": dry_run,
            }
            path = args.out / f"{args.profile}-{args.module}-{part.part_id}-sample-{index}.json"
            path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
            print(json.dumps({
                "sample": index, "status": status,
                "layers": (result or {}).get("layers"),
                "spentUsd": round(budget.spent_usd, 6), "error": error,
            }), flush=True)

            if budget.spent_usd >= budget.max_cost_usd:
                terminated = {"terminated": True, "reason": "cost budget reached after this sample", "afterSample": index}
                print(json.dumps(terminated), flush=True)
                break

    summary_path = args.out / f"{args.profile}-{args.module}-{part.part_id}-summary.json"
    summary_path.write_text(json.dumps({
        "profileId": args.profile, "module": args.module, "partId": part.part_id, "usageLabel": label,
        "samplesRun": budget.samples_run, "maxSamples": budget.max_samples,
        "spentUsd": round(budget.spent_usd, 6), "maxCostUsd": budget.max_cost_usd,
        "failures": failures, "terminated": terminated, "dryRun": dry_run,
        "releaseGatePassed": False,  # this script never self-certifies a release; human review is always required
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    return int(failures > 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", required=True, choices=("telc_c1_hochschule", "goethe_c1", "testdaf_digital"))
    parser.add_argument("--module", required=True, choices=("reading", "listening", "writing", "speaking", "language_elements"))
    parser.add_argument("--part", required=True, help="e.g. lesen_1, hv2, schreiben_1, sprechen_5")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--dry-run", action="store_true", default=True,
        help="Default. Zero provider/network calls; mock content run through the real deterministic "
             "validator and answer-key check; CONTENT (semantic) layer is mocked and labelled as such.",
    )
    parser.add_argument(
        "--execute", dest="dry_run", action="store_false",
        help="Real generation + real semantic verification, incurring real cost capped by "
             "--max-cost-usd/--max-samples. Requires --confirm-execute. NEVER invoked by this "
             "repository's own tests, CI, or by the agent that built this harness — a separate, "
             "human-initiated action.",
    )
    parser.add_argument(
        "--confirm-execute", action="store_true",
        help="Required in addition to --execute, as a second explicit guard against an accidental live run.",
    )
    add_budget_args(parser)
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
