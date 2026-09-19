"""Deterministic validator: hand-written valid + deliberately-broken fixtures
per telc_c1_hochschule Lesen part."""

from __future__ import annotations


from app.services.german_exam_profiles import get_part
from app.services.german_exam_validator import hard_issues, validate_content

LESEN1 = get_part("telc_c1_hochschule", "reading", "lesen_1")
LESEN2 = get_part("telc_c1_hochschule", "reading", "lesen_2")
LESEN3 = get_part("telc_c1_hochschule", "reading", "lesen_3")


def _valid_lesen1() -> dict:
    gaps = [{"gapId": f"g{i}"} for i in range(1, 7)]
    paragraphs = [f"Absatz {i} {{{{g{i}}}}}" for i in range(1, 7)]
    candidates = [{"candidateId": f"c{i}", "text": f"Satz {i}"} for i in range(1, 9)]
    questions = [
        {"questionId": f"q{i}", "gapId": f"g{i}", "correctCandidateId": f"c{i}",
         "skillTags": ["reference_resolution"], "difficulty": "c1"}
        for i in range(1, 7)
    ]
    return {"text": {"title": "T", "paragraphs": paragraphs, "gaps": gaps}, "candidates": candidates, "questions": questions}


def test_lesen1_valid_fixture_passes() -> None:
    assert hard_issues(validate_content(LESEN1, _valid_lesen1())) == []


def test_lesen1_wrong_gap_count_fails() -> None:
    content = _valid_lesen1()
    content["text"]["gaps"] = content["text"]["gaps"][:5]
    assert hard_issues(validate_content(LESEN1, content))


def test_lesen1_wrong_candidate_count_fails() -> None:
    content = _valid_lesen1()
    content["candidates"] = content["candidates"][:7]
    assert hard_issues(validate_content(LESEN1, content))


def test_lesen1_unmapped_gap_fails() -> None:
    content = _valid_lesen1()
    content["questions"][0]["gapId"] = "g2"  # g1 now has no mapping, g2 has two
    assert hard_issues(validate_content(LESEN1, content))


def test_lesen1_duplicate_candidate_text_fails() -> None:
    content = _valid_lesen1()
    content["candidates"][1]["text"] = content["candidates"][0]["text"]
    assert hard_issues(validate_content(LESEN1, content))


def test_lesen1_wrong_unused_candidate_count_fails() -> None:
    content = _valid_lesen1()
    # Reuse c1 for two gaps so 3 candidates end up unused instead of 2.
    content["questions"][1]["correctCandidateId"] = "c1"
    content["questions"][0]["gapId"] = "g1"
    assert hard_issues(validate_content(LESEN1, content))


def _valid_lesen2() -> dict:
    sections = [{"sectionId": chr(ord("a") + i), "text": f"Abschnitt {i}"} for i in range(5)]
    questions = [
        {"questionId": f"q{i+1}", "statement": f"Aussage {i+1}", "correctSectionId": chr(ord("a") + (i % 5)),
         "skillTags": ["author_intention"], "difficulty": "c1"}
        for i in range(6)
    ]
    return {"sections": sections, "questions": questions}


def test_lesen2_valid_fixture_passes() -> None:
    assert hard_issues(validate_content(LESEN2, _valid_lesen2())) == []


def test_lesen2_wrong_section_count_fails() -> None:
    content = _valid_lesen2()
    content["sections"] = content["sections"][:4]
    assert hard_issues(validate_content(LESEN2, content))


def test_lesen2_wrong_statement_count_fails() -> None:
    content = _valid_lesen2()
    content["questions"] = content["questions"][:5]
    assert hard_issues(validate_content(LESEN2, content))


def test_lesen2_unknown_section_id_fails() -> None:
    content = _valid_lesen2()
    content["questions"][0]["correctSectionId"] = "z"
    assert hard_issues(validate_content(LESEN2, content))


def test_lesen2_repeated_section_across_statements_is_allowed() -> None:
    content = _valid_lesen2()
    content["questions"][0]["correctSectionId"] = "a"
    content["questions"][1]["correctSectionId"] = "a"
    assert hard_issues(validate_content(LESEN2, content)) == []


def _valid_lesen3() -> dict:
    paragraphs = [{"paragraphId": f"p{i}", "text": f"Absatz {i}"} for i in range(1, 6)]
    answers = ["richtig", "falsch", "nicht_im_text"] * 3 + ["richtig", "falsch"]
    questions = []
    for i in range(11):
        answer = answers[i]
        questions.append({
            "questionId": f"q{i+1}", "kind": "detail", "statement": f"Aussage {i+1}",
            "tristate": {"answer": answer, "evidenceParagraphIds": [] if answer == "nicht_im_text" else ["p1"]},
            "skillTags": ["detail_comprehension"], "difficulty": "c1",
        })
    questions.append({
        "questionId": "q12", "kind": "global_heading",
        "heading": {"options": [{"headingId": "h1", "text": "A"}, {"headingId": "h2", "text": "B"}, {"headingId": "h3", "text": "C"}],
                    "correctHeadingId": "h2"},
        "skillTags": ["global_comprehension"], "difficulty": "c1",
    })
    return {"text": {"title": "T", "paragraphs": paragraphs}, "questions": questions}


def test_lesen3_valid_fixture_passes() -> None:
    assert hard_issues(validate_content(LESEN3, _valid_lesen3())) == []


def test_lesen3_wrong_detail_item_count_fails() -> None:
    content = _valid_lesen3()
    content["questions"] = [q for q in content["questions"] if q["questionId"] != "q11"]
    assert hard_issues(validate_content(LESEN3, content))


def test_lesen3_invalid_tristate_answer_fails() -> None:
    content = _valid_lesen3()
    content["questions"][0]["tristate"]["answer"] = "maybe"
    assert hard_issues(validate_content(LESEN3, content))


def test_lesen3_missing_evidence_for_non_absent_item_fails() -> None:
    content = _valid_lesen3()
    q = next(q for q in content["questions"] if q["tristate"]["answer"] == "richtig")
    q["tristate"]["evidenceParagraphIds"] = []
    assert hard_issues(validate_content(LESEN3, content))


def test_lesen3_empty_evidence_allowed_for_nicht_im_text() -> None:
    content = _valid_lesen3()
    q = next(q for q in content["questions"] if q["tristate"]["answer"] == "nicht_im_text")
    q["tristate"]["evidenceParagraphIds"] = []
    assert hard_issues(validate_content(LESEN3, content)) == []


def test_lesen3_wrong_heading_option_count_fails() -> None:
    content = _valid_lesen3()
    heading_q = next(q for q in content["questions"] if q["kind"] == "global_heading")
    heading_q["heading"]["options"] = heading_q["heading"]["options"][:2]
    assert hard_issues(validate_content(LESEN3, content))


def test_lesen3_unknown_correct_heading_id_fails() -> None:
    content = _valid_lesen3()
    heading_q = next(q for q in content["questions"] if q["kind"] == "global_heading")
    heading_q["heading"]["correctHeadingId"] = "h99"
    assert hard_issues(validate_content(LESEN3, content))


def test_lesen3_unknown_kind_fails() -> None:
    content = _valid_lesen3()
    content["questions"][0]["kind"] = "bogus"
    assert hard_issues(validate_content(LESEN3, content))
