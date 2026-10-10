"""Unit tests for the reading (_apply_audits) branches added to
german_exam_semantic_verify.py: lesen_1 (candidate best-fit/tie), lesen_2
(section support/tie), lesen_3 (tristate mismatch + heading best-fit/tie,
dispatched by the item's "kind")."""

from __future__ import annotations

from app.services.german_exams import get_part
from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult, _apply_audits

LESEN1 = get_part("telc_c1_hochschule", "reading", "lesen_1")
LESEN2 = get_part("telc_c1_hochschule", "reading", "lesen_2")
LESEN3 = get_part("telc_c1_hochschule", "reading", "lesen_3")


def _clean_result(ids):
    return SemanticVerificationResult(True, [], [ItemSemanticResult(i, True, []) for i in ids])


def test_lesen1_mismatch_flags_unsupported_correct_answer():
    content = {"questions": [{"questionId": "q1", "correctCandidateId": "c4"}]}
    data = {"items": [{"questionId": "q1", "audit": {"bestCandidateId": "c7", "tiedCandidateIds": []}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN1, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_lesen1_tie_flags_ambiguous_mapping():
    content = {"questions": [{"questionId": "q1", "correctCandidateId": "c4"}]}
    data = {"items": [{"questionId": "q1", "audit": {"bestCandidateId": "c4", "tiedCandidateIds": ["c2", "c6"]}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN1, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["AMBIGUOUS_MAPPING"]


def test_lesen1_clean_audit_passes():
    content = {"questions": [{"questionId": "q1", "correctCandidateId": "c4"}]}
    data = {"items": [{"questionId": "q1", "audit": {"bestCandidateId": "c4", "tiedCandidateIds": []}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN1, content)
    assert result.passed


def test_lesen2_unsupported_by_keyed_section():
    content = {"questions": [{"questionId": "q1", "correctSectionId": "c"}]}
    data = {"items": [{"questionId": "q1", "audit": {"supportingSectionIds": ["a", "b"]}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN2, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_lesen2_two_sections_equally_support_flags_ambiguous():
    content = {"questions": [{"questionId": "q1", "correctSectionId": "c"}]}
    data = {"items": [{"questionId": "q1", "audit": {"supportingSectionIds": ["c", "d"]}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN2, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["AMBIGUOUS_MAPPING"]


def test_lesen3_detail_tristate_mismatch():
    content = {"questions": [{"questionId": "q1", "kind": "detail", "tristate": {"answer": "falsch"}}]}
    data = {"items": [{"questionId": "q1", "audit": {"trueVerdict": "nicht_im_text", "bestHeadingId": None, "tiedHeadingIds": []}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN3, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["TRISTATE_VERDICT_MISMATCH"]


def test_lesen3_detail_tristate_match_passes():
    content = {"questions": [{"questionId": "q1", "kind": "detail", "tristate": {"answer": "richtig"}}]}
    data = {"items": [{"questionId": "q1", "audit": {"trueVerdict": "richtig", "bestHeadingId": None, "tiedHeadingIds": []}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN3, content)
    assert result.passed


def test_lesen3_global_heading_mismatch():
    content = {"questions": [{"questionId": "q12", "kind": "global_heading", "heading": {"correctHeadingId": "h2"}}]}
    data = {"items": [{"questionId": "q12", "audit": {"trueVerdict": None, "bestHeadingId": "h1", "tiedHeadingIds": []}}]}
    result = _apply_audits(_clean_result(["q12"]), data, LESEN3, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_lesen3_global_heading_tie_flags_ambiguous():
    content = {"questions": [{"questionId": "q12", "kind": "global_heading", "heading": {"correctHeadingId": "h2"}}]}
    data = {"items": [{"questionId": "q12", "audit": {"trueVerdict": None, "bestHeadingId": "h2", "tiedHeadingIds": ["h1"]}}]}
    result = _apply_audits(_clean_result(["q12"]), data, LESEN3, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["AMBIGUOUS_MAPPING"]


def test_lesen3_unknown_kind_fails_closed():
    content = {"questions": [{"questionId": "q1", "kind": "bogus"}]}
    data = {"items": [{"questionId": "q1", "audit": {}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN3, content)
    assert not result.passed
    assert [i.code for i in result.items[0].issues] == ["VERIFIER_RESPONSE_INVALID"]


def test_apply_audits_does_not_keyerror_without_segments():
    # Reading content has no top-level "segments" key at all — this must
    # not KeyError (regression guard for the content["segments"] fix).
    content = {"questions": [{"questionId": "q1", "correctCandidateId": "c4"}]}
    data = {"items": [{"questionId": "q1", "audit": {"bestCandidateId": "c4", "tiedCandidateIds": []}}]}
    result = _apply_audits(_clean_result(["q1"]), data, LESEN1, content)
    assert result.passed
