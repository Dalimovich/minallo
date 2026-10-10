"""Deterministic validator: hand-written valid + deliberately-broken fixtures
per telc_c1_hochschule listening part."""

from __future__ import annotations

from app.services.german_exams import get_part
from app.services.german_exam_validator import hard_issues, validate_content

HV1 = get_part("telc_c1_hochschule", "listening", "hv1")
HV2 = get_part("telc_c1_hochschule", "listening", "hv2")
HV3 = get_part("telc_c1_hochschule", "listening", "hv3")


def _valid_hv1() -> dict:
    segments = [{"id": f"s{i}", "speakerId": f"speaker_{i}", "spokenText": f"Text {i}"} for i in range(1, 9)]
    questions = []
    for i in range(1, 9):
        questions.append({
            "questionId": f"q{i}", "prompt": f"Statement {i}", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1",
            "matching": {"correctSpeakerId": f"speaker_{i}", "isDistractor": False, "evidenceSegmentIds": [f"s{i}"]},
        })
    for i in range(9, 11):
        questions.append({
            "questionId": f"q{i}", "prompt": f"Distractor {i}", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1",
            "matching": {"correctSpeakerId": None, "isDistractor": True, "evidenceSegmentIds": []},
        })
    return {"segments": segments, "questions": questions}


def test_hv1_valid_fixture_passes() -> None:
    issues = hard_issues(validate_content(HV1, _valid_hv1()))
    assert issues == []


def test_hv1_wrong_speaker_count_fails() -> None:
    content = _valid_hv1()
    content["segments"] = content["segments"][:7]
    issues = hard_issues(validate_content(HV1, content))
    assert any("speaker segments" in i.message for i in issues)


def test_hv1_duplicate_mapping_fails() -> None:
    content = _valid_hv1()
    content["questions"][1]["matching"]["correctSpeakerId"] = "speaker_1"  # now maps twice to speaker_1
    issues = hard_issues(validate_content(HV1, content))
    assert any("bijection" in i.message for i in issues)


def test_hv1_wrong_distractor_count_fails() -> None:
    content = _valid_hv1()
    content["questions"][9]["matching"] = {"correctSpeakerId": "speaker_1", "isDistractor": False}
    issues = hard_issues(validate_content(HV1, content))
    assert any("distractor" in i.message for i in issues)


def _valid_hv2() -> dict:
    segments = [
        {"id": "s1", "speakerId": "speaker_1", "spokenText": "..."},
        {"id": "s2", "speakerId": "speaker_2", "spokenText": "..."},
    ]
    questions = [
        {
            "questionId": f"q{i}", "skillTags": ["detail_fact"], "difficulty": "c1",
            "mc3": {"stem": f"Stem {i}", "options": ["A", "B", "C"], "correctIndex": 0, "evidenceSegmentIds": ["s1"]},
        }
        for i in range(1, 11)
    ]
    return {"segments": segments, "questions": questions}


def test_hv2_valid_fixture_passes() -> None:
    issues = hard_issues(validate_content(HV2, _valid_hv2()))
    assert issues == []


def test_hv2_wrong_option_count_fails() -> None:
    content = _valid_hv2()
    content["questions"][0]["mc3"]["options"] = ["A", "B"]
    issues = hard_issues(validate_content(HV2, content))
    assert any("options" in i.message for i in issues)


def test_hv2_duplicate_options_fail() -> None:
    content = _valid_hv2()
    content["questions"][0]["mc3"]["options"] = ["A", "A", "B"]
    issues = hard_issues(validate_content(HV2, content))
    assert any("duplicate options" in i.message for i in issues)


def test_hv2_below_minimum_speaker_count_fails() -> None:
    content = _valid_hv2()
    content["segments"] = content["segments"][:1]
    issues = hard_issues(validate_content(HV2, content))
    assert any("distinct speakers" in i.message for i in issues)


def _valid_hv3() -> dict:
    segments = [{"id": "s1", "speakerId": "speaker_1", "spokenText": "Lecture..."}]
    questions = [
        {
            "questionId": f"q{i}", "skillTags": ["note_taking"], "difficulty": "c1",
            "note": {"fieldLabel": f"Field {i}", "outlineContext": "...", "correctFill": f"unique answer {i}",
                     "evidenceSegmentIds": ["s1"]},
        }
        for i in range(1, 11)
    ]
    return {"segments": segments, "questions": questions}


def test_hv3_valid_fixture_passes() -> None:
    issues = hard_issues(validate_content(HV3, _valid_hv3()))
    assert issues == []


def test_hv3_single_token_answer_fails() -> None:
    content = _valid_hv3()
    content["questions"][0]["note"]["correctFill"] = "x"
    issues = hard_issues(validate_content(HV3, content))
    assert any("too short" in i.message for i in issues)


def test_hv3_duplicate_answers_fail() -> None:
    content = _valid_hv3()
    content["questions"][1]["note"]["correctFill"] = content["questions"][0]["note"]["correctFill"]
    issues = hard_issues(validate_content(HV3, content))
    assert any("duplicate" in i.message for i in issues)


def test_hv3_mcq_shaped_item_fails() -> None:
    content = _valid_hv3()
    content["questions"][0]["mc3"] = {"stem": "x", "options": ["a", "b", "c"], "correctIndex": 0}
    issues = hard_issues(validate_content(HV3, content))
    assert any("must not carry" in i.message for i in issues)


def test_unknown_skill_tag_fails() -> None:
    content = _valid_hv1()
    content["questions"][0]["skillTags"] = ["not_a_real_tag"]
    issues = hard_issues(validate_content(HV1, content))
    assert any("unknown skill tag" in i.message for i in issues)


def test_hv2_missing_evidence_segment_ids_fails() -> None:
    content = _valid_hv2()
    del content["questions"][0]["mc3"]["evidenceSegmentIds"]
    issues = hard_issues(validate_content(HV2, content))
    assert any("evidenceSegmentIds" in i.message for i in issues)


def test_hv3_unknown_evidence_segment_id_fails() -> None:
    content = _valid_hv3()
    content["questions"][0]["note"]["evidenceSegmentIds"] = ["s99"]
    issues = hard_issues(validate_content(HV3, content))
    assert any("unknown segment id" in i.message for i in issues)


def test_hv1_distractor_may_have_empty_evidence() -> None:
    # Distractors have no single speaker to point at — empty evidenceSegmentIds is fine.
    content = _valid_hv1()
    issues = hard_issues(validate_content(HV1, content))
    assert issues == []
