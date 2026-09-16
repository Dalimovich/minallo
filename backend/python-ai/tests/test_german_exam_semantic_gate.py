"""Phase 2.6: verify_semantic_full() combines the detector with the
targeted HV2/HV3 adjudicator. The adjudication LOGIC is correct (verified
here with _ADJUDICATION_ENABLED patched on) — a detector false-positive
gets overridden by an adjudicator that finds the item clean, and a detector
false-negative gets caught because the adjudicator ALWAYS runs for HV2/HV3.
But live testing found the adjudicator's PROMPT is not yet calibrated well
enough (see german_exam_semantic_gate.py's module docstring and
scripts/GERMAN_EXAM_SEMANTIC_QA.md "Phase 2.6"), so _ADJUDICATION_ENABLED
defaults to False in production — test_adjudication_disabled_by_default
locks that in."""
from app.services import german_exam_semantic_gate as gate
from app.services.german_exam_profiles import get_part
from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult

HV1 = get_part("telc_c1_hochschule", "listening", "hv1")
HV2 = get_part("telc_c1_hochschule", "listening", "hv2")


def _content(ids=("q1", "q2")):
    return {
        "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "..."}],
        "questions": [{"questionId": qid} for qid in ids],
    }


def _clean_result(ids=("q1", "q2")):
    return SemanticVerificationResult(True, [], [ItemSemanticResult(qid, True, []) for qid in ids])


def _flagged_result(ids=("q1", "q2"), flagged_id="q1", code="IMPLAUSIBLE_DISTRACTOR"):
    items = [ItemSemanticResult(qid, qid != flagged_id,
                                 [SemanticIssue(code, "error", "detector says so")] if qid == flagged_id else [])
             for qid in ids]
    return SemanticVerificationResult(False, [], items)


def test_adjudication_disabled_by_default(monkeypatch):
    # Locks in the production default: verify_semantic_full() must NOT call
    # adjudicate_items() at all unless _ADJUDICATION_ENABLED is explicitly
    # turned on (it currently isn't — see the module docstring for why).
    called = []
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: _flagged_result())
    monkeypatch.setattr(gate, "adjudicate_items", lambda *a, **k: called.append(1))
    result = gate.verify_semantic_full(HV2, _content())
    assert called == []
    assert not result.passed  # the detector's own (unmodified) verdict stands


def test_hv1_result_passes_through_unchanged(monkeypatch):
    # adjudicate_items() itself is the thing that returns None for HV1 (no
    # per-task-type prompt builder exists) -- verify_semantic_full() must
    # treat that None as "nothing to apply" and leave the detector's own
    # result untouched, not mistake it for an adjudication result.
    monkeypatch.setattr(gate, "_ADJUDICATION_ENABLED", True)
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: _clean_result())
    monkeypatch.setattr(gate, "adjudicate_items", lambda part, content, ids: None)
    result = gate.verify_semantic_full(HV1, _content())
    assert result.passed
    assert all(item.passed for item in result.items)


def test_hv2_adjudicator_catches_what_detector_missed(monkeypatch):
    # Detector says everything is clean -- this is the false-negative failure
    # mode Phase 2.5b measured (20% of runs on real defective content).
    monkeypatch.setattr(gate, "_ADJUDICATION_ENABLED", True)
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: _clean_result())
    monkeypatch.setattr(gate, "adjudicate_items", lambda part, content, ids: {
        "q1": [SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "adjudicator caught it")],
        "q2": [],
    })
    result = gate.verify_semantic_full(HV2, _content())
    assert not result.passed
    q1 = next(i for i in result.items if i.item_id == "q1")
    assert not q1.passed
    assert [i.code for i in q1.issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_hv2_adjudicator_overrides_detector_false_positive(monkeypatch):
    # Detector flags q1 -- this is the false-positive failure mode Phase
    # 2.5b measured (20% of runs falsely flagged clean content). The
    # adjudicator disagrees and finds it clean; its verdict must win.
    monkeypatch.setattr(gate, "_ADJUDICATION_ENABLED", True)
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: _flagged_result())
    monkeypatch.setattr(gate, "adjudicate_items", lambda part, content, ids: {"q1": [], "q2": []})
    result = gate.verify_semantic_full(HV2, _content())
    assert result.passed
    assert all(item.passed for item in result.items)


def test_hv2_part_wide_issues_untouched_by_adjudication(monkeypatch):
    monkeypatch.setattr(gate, "_ADJUDICATION_ENABLED", True)
    detector_result = _clean_result()
    detector_result.part_wide_issues = [SemanticIssue("PART_WIDE_INCOHERENCE", "error", "structural problem")]
    detector_result.passed = False
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: detector_result)
    monkeypatch.setattr(gate, "adjudicate_items", lambda part, content, ids: {"q1": [], "q2": []})
    result = gate.verify_semantic_full(HV2, _content())
    assert not result.passed  # part-wide issue alone still blocks acceptance
    assert [i.code for i in result.part_wide_issues] == ["PART_WIDE_INCOHERENCE"]
    assert all(item.passed for item in result.items)  # adjudicator still corrected the item-level verdict


def test_detector_already_failed_closed_skips_adjudication(monkeypatch):
    # A malformed detector response (items=[]) is already fail-closed and
    # correct -- adjudicating an incomplete item list would waste a call.
    monkeypatch.setattr(gate, "_ADJUDICATION_ENABLED", True)
    called = []
    monkeypatch.setattr(gate, "verify_semantic", lambda part, content: SemanticVerificationResult(
        False, [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "bad response")], []))
    monkeypatch.setattr(gate, "adjudicate_items", lambda *a, **k: called.append(1))
    result = gate.verify_semantic_full(HV2, _content())
    assert not result.passed
    assert called == []
