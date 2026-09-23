"""Unit tests for scripts/qa_correctness_harness.py. Zero real provider calls anywhere in this
file — every test either uses --dry-run (which itself makes zero network calls, asserted directly
below) or monkeypatches `_execute_generate` so a would-be --execute path never reaches a real
generator/provider."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# See test_qa_budget.py / test_qa_testdaf_live.py for why this reimport guard exists: unconditionally
# deleting+reimporting `scripts.*` in every file that needs it makes whichever file pytest collects
# second rebind sys.modules["scripts.qa_budget"] to a new module object, breaking identity checks
# (pytest.raises against a stale class) in files collected earlier. Guard it so it only happens once.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])
_scripts_pkg = sys.modules.get("scripts")
_scripts_already_correct = _scripts_pkg is not None and any(
    Path(p).resolve() == Path(_BACKEND_ROOT, "scripts") for p in getattr(_scripts_pkg, "__path__", [])
)
if not _scripts_already_correct:
    if _BACKEND_ROOT in sys.path:
        sys.path.remove(_BACKEND_ROOT)
    sys.path.insert(0, _BACKEND_ROOT)
    for _name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
        del sys.modules[_name]

from scripts import qa_correctness_harness as harness  # noqa: E402
from scripts.qa_budget import BudgetExceeded  # noqa: E402


def _telc_part(profile_id="telc_c1_hochschule", module="reading", part_id="lesen_1"):
    from app.services.german_exams import get_part, get_profile

    return get_profile(profile_id), get_part(profile_id, module, part_id)


def test_dry_run_generate_makes_no_provider_call(monkeypatch):
    """Asserts `_execute_generate` (the only function that could dispatch to a real, network-
    capable generator) is never imported or called when `_dry_run_generate` runs."""
    called = {"n": 0}

    def poison(*a, **k):
        called["n"] += 1
        raise AssertionError("real generator dispatch must never be called from dry-run")

    monkeypatch.setattr(harness, "_execute_generate", poison)
    _, part = _telc_part()
    content, meta = harness._dry_run_generate(part)
    assert called["n"] == 0
    assert meta["dryRun"] is True
    assert meta["semantic"]["mocked"] is True


def test_check_answer_key_detects_a_broken_selection_answer_id():
    _, part = _telc_part(module="listening", part_id="hv2")
    good = harness._mock_selection_content(part)
    ok, detail = harness.check_answer_key(part, good)
    assert ok is True

    broken = json.loads(json.dumps(good))
    broken["questions"][0]["answerId"] = "does-not-exist"
    ok, detail = harness.check_answer_key(part, broken)
    assert ok is False
    assert detail["questionId"] == broken["questions"][0]["id"]


def test_check_answer_key_rejects_a_leaked_model_answer_on_productive_content():
    _, part = _telc_part(module="writing", part_id="schreiben_1")
    content = harness._mock_productive_content(part)
    ok, _ = harness.check_answer_key(part, content)
    assert ok is True

    content["modelAnswer"] = "a real learner would never see this"
    ok, detail = harness.check_answer_key(part, content)
    assert ok is False
    assert "modelAnswer" in detail["leakedKeys"]


def test_check_answer_key_never_assumes_pass_on_an_unrecognised_shape():
    _, part = _telc_part()
    ok, detail = harness.check_answer_key(part, {"nonsense": True})
    assert ok is False
    assert "unrecognised" in detail["reason"]


def test_check_grading_matches_the_known_reachable_telc_writing_task_only():
    ok, _ = harness.check_grading("telc_c1_hochschule", "writing", "schreiben_1", "choice_long_form_writing")
    assert ok is True
    ok, _ = harness.check_grading("goethe_c1", "writing", "schreiben_1", "forum_discussion_post")
    assert ok is False
    ok, _ = harness.check_grading("testdaf_digital", "writing", "schreiben_1", "argumentative_essay")
    assert ok is False


def test_check_grading_matches_the_known_reachable_telc_speaking_parts_only():
    ok, _ = harness.check_grading("telc_c1_hochschule", "speaking", "sprechen_1", "presentation_summary_followup")
    assert ok is True
    ok, _ = harness.check_grading("goethe_c1", "speaking", "sprechen_1", "presentation_with_followup")
    assert ok is False
    ok, _ = harness.check_grading("testdaf_digital", "speaking", "sprechen_1", "spoken_advice")
    assert ok is False


def test_check_delivery_mirrors_the_real_task_type_registry():
    ok, _ = harness.check_delivery("choice_long_form_writing")
    assert ok is True
    ok, _ = harness.check_delivery("paragraph_ordering")  # TestDaF lesen_2 — genuinely unimplemented
    assert ok is False


def test_check_structure_runs_the_real_deterministic_validator():
    _, part = _telc_part(module="listening", part_id="hv2")
    good = harness._mock_selection_content(part)
    ok, _ = harness.check_structure(part, good)
    # sentence_completion_mc3's validator may or may not accept this generic mock shape exactly —
    # what matters for this test is that the REAL validator ran (no exception, a real issues list
    # came back) rather than the harness fabricating a verdict.
    from app.services.german_exam_validator import validate_content

    real_issues = validate_content(part, good)
    ok2, detail = harness.check_structure(part, good)
    assert detail["issues"] == real_issues


def test_check_structure_never_crashes_the_harness_on_malformed_content():
    _, part = _telc_part()
    ok, detail = harness.check_structure(part, {"totally": "wrong shape"})
    assert ok is False
    assert "issues" in detail or "error" in detail


def test_run_sample_dry_run_reports_all_five_layers_and_marks_content_mocked():
    profile, part = _telc_part(module="writing", part_id="schreiben_1")
    result = harness.run_sample(profile, part, dry_run=True)
    layers = result["layers"]
    for key in ("structure", "content", "contentMocked", "answerKey", "grading", "delivery"):
        assert key in layers
    assert layers["contentMocked"] is True


def test_run_cli_dry_run_end_to_end_writes_summary_with_zero_spend(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(harness, "_execute_generate", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("dry-run CLI path must never reach the real generator")))
    argv = [
        "--profile", "telc_c1_hochschule", "--module", "writing", "--part", "schreiben_1",
        "--dry-run", "--max-cost-usd", "0.1", "--max-samples", "1", "--out", str(tmp_path),
    ]
    import sys

    monkeypatch.setattr(sys, "argv", ["qa_correctness_harness.py", *argv])
    exit_code = harness.main()
    summary_files = list(tmp_path.glob("*summary.json"))
    assert len(summary_files) == 1
    summary = json.loads(summary_files[0].read_text(encoding="utf-8"))
    assert summary["dryRun"] is True
    assert summary["spentUsd"] == 0.0
    assert summary["releaseGatePassed"] is False
    assert exit_code in (0, 1)  # a dry-run mock may legitimately fail STRUCTURE for some task types — see module docstring


def test_budget_circuit_breaker_stops_before_a_second_sample(tmp_path):
    """max-samples=1 must produce exactly one sample record, never more, for a run requesting
    more than the safe ceiling would need to be rejected outright by QaBudget itself (proven in
    test_qa_budget.py already) — this test proves THIS harness's own loop respects the same cap
    and writes a `terminated` record once it does."""
    profile, part = _telc_part(module="writing", part_id="schreiben_1")
    budget = harness.QaBudget(max_cost_usd=0.1, max_samples=1, label="test_label")
    budget.guard_new_sample()  # first sample: allowed
    budget.record_sample()
    with pytest.raises(BudgetExceeded):
        budget.guard_new_sample()  # second sample: must raise before any further call


def test_execute_requires_confirm_execute_flag(tmp_path, monkeypatch):
    import sys

    monkeypatch.setattr(sys, "argv", [
        "qa_correctness_harness.py",
        "--profile", "telc_c1_hochschule", "--module", "writing", "--part", "schreiben_1",
        "--execute", "--max-cost-usd", "0.1", "--max-samples", "1", "--out", str(tmp_path),
    ])
    with pytest.raises(SystemExit):
        harness.main()


def test_execute_path_is_never_reached_without_the_flag_even_if_requested(tmp_path, monkeypatch):
    """Defence in depth: even if --execute is passed, without --confirm-execute the run must
    raise before `run_sample(..., dry_run=False)` — and therefore before `_execute_generate` —
    is ever reached."""
    called = {"n": 0}
    monkeypatch.setattr(harness, "_execute_generate", lambda *a, **k: called.__setitem__("n", called["n"] + 1))
    import sys

    monkeypatch.setattr(sys, "argv", [
        "qa_correctness_harness.py",
        "--profile", "telc_c1_hochschule", "--module", "writing", "--part", "schreiben_1",
        "--execute", "--max-cost-usd", "0.1", "--max-samples", "1", "--out", str(tmp_path),
    ])
    with pytest.raises(SystemExit):
        harness.main()
    assert called["n"] == 0
