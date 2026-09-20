"""Deterministic validator: hand-written valid + deliberately-broken fixtures
for telc_c1_hochschule Sprachbausteine (cloze_mc4_language_elements)."""

from __future__ import annotations

from app.services.german_exams import get_part
from app.services.german_exam_validator import hard_issues, validate_content

SPRACHBAUSTEINE = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")

# 22 items: 14 grammar, 6 lexicon, 2 orthography (within the official ranges).
_CATEGORY_PLAN = ["grammar"] * 14 + ["lexicon"] * 6 + ["orthography"] * 2


def _valid_content() -> dict:
    words = ["Wort"] * 40  # 40 words per paragraph * 8 paragraphs = 320 words, within 320-350.
    # 8 paragraphs of 40 words each, with 22 gap markers distributed across them.
    paragraphs = []
    gap_n = 1
    for p in range(8):
        para_words = list(words)
        # Distribute 22 gaps across 8 paragraphs (some paragraphs get more than one).
        gaps_here = 3 if p < 6 else 2
        for _ in range(gaps_here):
            if gap_n > 22:
                break
            para_words.append(f"{{{{g{gap_n}}}}}")
            gap_n += 1
        paragraphs.append(" ".join(para_words))

    gaps = [{"gapId": f"g{i}"} for i in range(1, 23)]
    questions = []
    for i in range(1, 23):
        category = _CATEGORY_PLAN[i - 1]
        questions.append({
            "questionId": f"q{i}",
            "gapId": f"g{i}",
            "options": [f"opt{i}a", f"opt{i}b", f"opt{i}c", f"opt{i}d"],
            "correctIndex": 0,
            "category": category,
            "skillTags": ["grammar"] if category == "grammar" else (["lexical_choice"] if category == "lexicon" else ["register"]),
            "difficulty": "c1",
        })
    return {"text": {"title": "Titel", "paragraphs": paragraphs, "gaps": gaps}, "questions": questions}


def test_valid_fixture_passes() -> None:
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, _valid_content()))
    assert issues == []


def test_wrong_gap_count_fails() -> None:
    content = _valid_content()
    content["text"]["gaps"] = content["text"]["gaps"][:20]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("gaps" in i.message for i in issues)


def test_wrong_item_count_fails() -> None:
    content = _valid_content()
    content["questions"] = content["questions"][:21]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("expected 22 items" in i.message for i in issues)


def test_wrong_option_count_fails() -> None:
    content = _valid_content()
    content["questions"][0]["options"] = content["questions"][0]["options"][:3]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("options" in i.message for i in issues)


def test_duplicate_options_fails() -> None:
    content = _valid_content()
    content["questions"][0]["options"] = ["same", "same", "different", "another"]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("duplicate options" in i.message for i in issues)


def test_correct_index_out_of_range_fails() -> None:
    content = _valid_content()
    content["questions"][0]["correctIndex"] = 4
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("correctIndex" in i.message for i in issues)


def test_gap_answered_twice_fails() -> None:
    content = _valid_content()
    content["questions"][1]["gapId"] = "g1"  # now g1 is answered by both q1 and q2
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("more than one item" in i.message for i in issues)


def test_missing_category_fails() -> None:
    content = _valid_content()
    del content["questions"][0]["category"]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("category must be one of" in i.message for i in issues)


def test_grammar_count_out_of_range_fails() -> None:
    content = _valid_content()
    # Push grammar count from 14 to 22 (over the 12-16 range) by relabeling everything.
    for q in content["questions"]:
        q["category"] = "grammar"
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("grammar items" in i.message for i in issues)


def test_word_count_out_of_range_fails() -> None:
    content = _valid_content()
    content["text"]["paragraphs"] = ["short text"]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("words" in i.message for i in issues)


def test_unknown_skill_tag_fails() -> None:
    content = _valid_content()
    content["questions"][0]["skillTags"] = ["not_a_real_tag"]
    issues = hard_issues(validate_content(SPRACHBAUSTEINE, content))
    assert any("unknown skill tag" in i.message for i in issues)
