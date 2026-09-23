"""Phase 12 regression tests for audit/exam-correctness. Uses the real profile registry (not
stubs) so a future accidental change to a profile file or the task_types registry is caught here,
matching the pattern `test_german_exam_inventory_testdaf.py` (T7) already established. No live
provider call, no inventory write, no `available` flag change anywhere in this file.
"""

from __future__ import annotations

import pytest

from app.services.german_exam_generator import _require_available, generate_task
from app.services.german_exam_productive import SPEAKING_TYPES
from app.services.german_exams import GERMAN_EXAM_PROFILES, get_part, get_profile
from app.services.german_exams.task_types import is_task_type_implemented
from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL


def _all_parts(profile):
    for module, parts in profile.modules.items():
        for part in parts or ():
            yield module, part


# --- Every TestDaF part must stay unavailable and must fail cleanly (never silently succeed,
# never fall through to another exam's generator) -------------------------------------------

@pytest.mark.parametrize("module,part_id", [(m, p.part_id) for m, p in _all_parts(TESTDAF_DIGITAL)])
def test_every_testdaf_part_is_unavailable(module, part_id):
    part = get_part("testdaf_digital", module, part_id)
    assert part.available is False, f"{module}/{part_id} must stay available=False pending live qualification"


@pytest.mark.parametrize("module,part_id", [(m, p.part_id) for m, p in _all_parts(TESTDAF_DIGITAL)])
def test_every_testdaf_part_fails_cleanly_via_require_available(module, part_id):
    """`_require_available` is the single gate `generate_task` calls before any dispatch — this
    proves every TestDaF part still raises through it today, independent of which specific reason
    (available=False, or an unimplemented task type) is responsible."""
    profile = get_profile("testdaf_digital")
    part = get_part("testdaf_digital", module, part_id)
    with pytest.raises(NotImplementedError):
        _require_available(profile, part)


def test_generate_task_501_equivalent_for_a_testdaf_part_end_to_end():
    """Exercises the real, top-level `generate_task()` entrypoint (not just the inner gate) for
    one representative TestDaF part per module, with no monkeypatching of the gate itself —
    proving the public function a router actually calls still refuses to generate."""
    for module, part_id in (("reading", "lesen_1"), ("listening", "hoeren_1"),
                             ("writing", "schreiben_1"), ("speaking", "sprechen_1")):
        with pytest.raises(NotImplementedError):
            generate_task("fake-user-id", "testdaf_digital", module, part_id, mode="practice")


# --- TestDaF speaking must remain honestly blocked: a submission/feedback CONTRACT exists (and
# structurally forbids a numeric score), but no grader/route serves it. This must keep failing,
# not silently start "working" via some other exam's grading path. ---------------------------

def test_testdaf_speaking_task_types_all_route_through_the_generic_productive_contract():
    """Confirms generation (not grading) for TestDaF speaking uses the shared productive contract
    — this is a structural fact this test locks in, not a claim that grading exists."""
    from app.services.german_exams.testdaf_digital import _SPEAKING

    testdaf_speaking_task_types = {part.task_type for part in _SPEAKING}
    assert testdaf_speaking_task_types == SPEAKING_TYPES


def test_testdaf_speaking_has_no_grading_route_reachability(monkeypatch):
    """Mirrors GRADING_AUDIT.md's Phase 5 finding as a locked-in regression: the harness's own
    static reachability table (qa_correctness_harness.py) must continue reporting every TestDaF
    speaking part as grading-unreachable. If this ever flips to True, it must be because a human
    deliberately wired a real grader/route — not silently."""
    import sys
    from pathlib import Path

    backend_root = str(Path(__file__).resolve().parents[1])
    scripts_pkg = sys.modules.get("scripts")
    already_correct = scripts_pkg is not None and any(
        Path(p).resolve() == Path(backend_root, "scripts") for p in getattr(scripts_pkg, "__path__", [])
    )
    if not already_correct:
        if backend_root in sys.path:
            sys.path.remove(backend_root)
        sys.path.insert(0, backend_root)
        for name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
            del sys.modules[name]
    from scripts.qa_correctness_harness import check_grading

    for part_id in ("sprechen_1", "sprechen_2", "sprechen_3", "sprechen_4", "sprechen_5", "sprechen_6", "sprechen_7"):
        part = get_part("testdaf_digital", "speaking", part_id)
        ok, _ = check_grading("testdaf_digital", "speaking", part_id, part.task_type)
        assert ok is False, f"TestDaF {part_id} must remain grading-unreachable until a human wires a real grader"


def test_testdaf_speaking_feedback_contract_still_structurally_forbids_a_numeric_score():
    """`validate_feedback` (the contract TestDaF speaking would use if a grader ever called it)
    must keep rejecting any of scaledScore/tdn/pass/officialScore/rawScore — proving the
    'never invent a TestDaF numeric speaking score' rule is enforced in code, not only in docs."""
    from app.services.german_exam_productive import grading_request, validate_feedback

    part = get_part("testdaf_digital", "speaking", "sprechen_1")
    content = {
        "schemaVersion": "productive-task-v1", "id": "t1", "prompt": "Geben Sie Ihrem Freund einen Rat.",
        "sources": [],
    }
    submission = {"recordingId": "rec-1", "durationSeconds": 30}
    request = grading_request(part, content, submission)
    honest_feedback = {
        "kind": "practice_feedback",
        "dimensions": [{"id": d, "feedback": "placeholder", "evidence": []} for d in part.grading_dimensions],
    }
    # A qualitative-only feedback shape is accepted...
    validate_feedback(part, request, honest_feedback)
    # ...but any numeric-score key must still be rejected.
    for forbidden_key in ("scaledScore", "tdn", "pass", "officialScore", "rawScore"):
        poisoned = dict(honest_feedback)
        poisoned[forbidden_key] = 15
        with pytest.raises(ValueError):
            validate_feedback(part, request, poisoned)


# --- TELC and Goethe behaviour is unchanged by this audit -------------------------------------

def test_telc_parts_remain_available_by_default_unchanged():
    """This audit set no `available=True` anywhere; TELC's live status comes entirely from the
    dataclass default, which this test locks in as still true post-audit."""
    profile = get_profile("telc_c1_hochschule")
    for module, part in _all_parts(profile):
        assert part.available is True, f"telc {module}/{part.part_id} unexpectedly not available"


def test_goethe_parts_all_remain_unavailable_unchanged():
    profile = get_profile("goethe_c1")
    for module, part in _all_parts(profile):
        assert part.available is False, f"goethe {module}/{part.part_id} unexpectedly available"


def test_no_part_anywhere_sets_available_true_explicitly_except_via_the_dataclass_default():
    """Structural proxy for `grep -rn "available=True"` (run separately, see final report):
    every TELC part's availability is the dataclass default (True), not something re-asserted
    in the profile file itself — confirmed by re-reading the source text once, here, as a test
    rather than only a manual grep step."""
    import inspect

    from app.services.german_exams import telc_c1_hochschule

    source = inspect.getsource(telc_c1_hochschule)
    assert "available=True" not in source


# --- Unsupported-modality / unimplemented-task-type handling stays fail-closed ----------------

def test_an_unimplemented_task_type_cannot_be_served_even_if_a_part_were_hypothetically_available():
    """Uses the REAL registry (no monkeypatching) to prove `is_task_type_implemented` alone is
    enough to block a hypothetically-available part — the double-gate this audit's
    IMPLEMENTATION_AUDIT.md flagged as currently-safe-but-latent for TestDaF speaking."""
    import dataclasses

    profile = get_profile("testdaf_digital")
    part = get_part("testdaf_digital", "speaking", "sprechen_1")
    assert is_task_type_implemented(part.task_type) is False  # today's real registry state
    hypothetically_available = dataclasses.replace(part, available=True)
    with pytest.raises(NotImplementedError):
        _require_available(profile, hypothetically_available)


def test_registry_contains_every_profiles_task_types_with_no_kerror():
    """Every task_type referenced by any of the three real profiles must at least be a KEY in the
    registry (even if False) — an absent key would silently default to `False` via `.get(...,
    False)`, which is safe, but this test still locks in that no part references a task type the
    registry has literally never heard of, which would indicate a profile/registry drift."""
    from app.services.german_exams.task_types import TASK_TYPES

    for profile in GERMAN_EXAM_PROFILES.values():
        for _module, part in _all_parts(profile):
            assert part.task_type in TASK_TYPES, f"{profile.profile_id}/{part.part_id}: task_type {part.task_type!r} missing from TASK_TYPES registry entirely"
