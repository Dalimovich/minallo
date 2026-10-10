"""Goethe Lesen Teil 2 — the generic reading_detail_mc3 task type."""

from __future__ import annotations

import copy

from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part, get_profile

PID = "goethe_c1"
PART = get_part(PID, "reading", "lesen_2")


def _content(words_per_paragraph: int = 80) -> dict:
    paragraphs = [
        {"paragraphId": f"p{i}", "text": " ".join(f"wort{i}x{j}" for j in range(words_per_paragraph))}
        for i in range(1, 9)
    ]
    questions = [
        {
            "questionId": f"q{i}",
            "skillTags": ["detail_comprehension", "inference"][: 1 + i % 2],
            "difficulty": "c1",
            "mc3": {
                "stem": f"Frage Nummer {i}?",
                "options": [f"Antwort a{i}", f"Antwort b{i}", f"Antwort c{i}"],
                "correctIndex": i % 3,
                "evidenceParagraphIds": [f"p{min(i, 8)}"],
            },
        }
        for i in range(1, 8)
    ]
    return {"text": {"title": "T", "paragraphs": paragraphs}, "questions": questions}


def _issues(content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(PART, content))]


def test_profile_wiring() -> None:
    assert PART.task_type == "reading_detail_mc3"
    assert reading._PROMPT_BUILDERS["reading_detail_mc3"] is reading._prompt_reading_detail_mc3
    assert "reading_detail_mc3" in verify._VERIFY_PROMPT_BUILDERS


def test_valid_content_passes() -> None:
    assert _issues(_content()) == []


def test_counts_and_options_are_enforced() -> None:
    c = _content()
    c["questions"] = c["questions"][:6]
    assert any("expected 7 items" in m for m in _issues(c))
    c = _content()
    c["questions"][0]["mc3"]["options"].append("noch eine")
    assert any("expected 3 non-empty options" in m for m in _issues(c))
    c = _content()
    c["questions"][1]["mc3"]["options"][1] = c["questions"][1]["mc3"]["options"][0]
    assert any("duplicate options" in m for m in _issues(c))
    c = _content()
    c["questions"][2]["mc3"]["correctIndex"] = 3
    assert any("correctIndex" in m for m in _issues(c))


def test_evidence_must_resolve_and_items_follow_the_text() -> None:
    c = _content()
    c["questions"][0]["mc3"]["evidenceParagraphIds"] = ["p99"]
    assert any("evidenceParagraphIds" in m for m in _issues(c))
    c = _content()
    c["questions"][5]["mc3"]["evidenceParagraphIds"] = ["p1"]  # item 6 points back before item 5's paragraph
    assert any("follow the order of the article" in m for m in _issues(c))


def test_length_and_duplicate_questions() -> None:
    assert any("article has" in m for m in _issues(_content(words_per_paragraph=10)))
    c = _content()
    c["questions"][1]["mc3"]["stem"] = c["questions"][0]["mc3"]["stem"]
    assert any("same question" in m for m in _issues(c))


def test_a_correct_option_copying_the_article_is_rejected() -> None:
    c = _content()
    p = c["text"]["paragraphs"][2]["text"].split()
    c["questions"][2]["mc3"]["options"][c["questions"][2]["mc3"]["correctIndex"]] = " ".join(p[10:19])
    assert any("copies 7+ consecutive words" in m for m in _issues(c))
    # copying inside a WRONG option is not the correct answer being findable by word matching
    c = _content()
    idx = c["questions"][2]["mc3"]["correctIndex"]
    c["questions"][2]["mc3"]["options"][(idx + 1) % 3] = " ".join(p[10:19])
    assert not any("copies 7+" in m for m in _issues(c))


def test_balancing_moves_the_key_consistently_and_is_stable() -> None:
    c = _content()
    for q in c["questions"]:
        q["mc3"]["correctIndex"] = 1  # the typical LLM bias: key always in the middle
        q["mc3"]["options"] = [f"falsch1-{q['questionId']}", f"RICHTIG-{q['questionId']}", f"falsch2-{q['questionId']}"]
    out = reading.balance_option_positions(c)
    positions = [q["mc3"]["correctIndex"] for q in out["questions"]]
    assert set(positions) == {0, 1, 2}
    for q in out["questions"]:
        assert q["mc3"]["options"][q["mc3"]["correctIndex"]] == f"RICHTIG-{q['questionId']}"
        assert sorted(q["mc3"]["options"]) == sorted([f"falsch1-{q['questionId']}", f"RICHTIG-{q['questionId']}", f"falsch2-{q['questionId']}"])
    assert reading.balance_option_positions(c) == out
    before = copy.deepcopy(c)
    reading.balance_option_positions(c)
    assert c == before  # input untouched


def test_prompts_carry_the_goethe_constraints() -> None:
    system, _ = reading._prompt_reading_detail_mc3(get_profile(PID), PART, [], {"topicId": "t", "label": "Ein Thema"})
    assert "exactly 7 multiple-choice items" in system and "exactly 3 options" in system
    assert "612-748 words" in system
    assert "ORDER of the text" in system
    assert "seven or more consecutive" in system
    v, _ = verify._verify_prompt_reading_detail_mc3(PART, _content())
    assert "reading_detail_mc3" in v and "listening" not in v.replace("Reading", "").lower().split("german")[0]
    assert "telc" not in v.lower() and "Hochschule" not in v


def test_semantic_audit_uses_the_shared_mc3_verdict_format() -> None:
    schema = verify._verification_schema(PART, _content())
    audit = schema["properties"]["items"]["items"]["properties"]["audit"]
    assert "optionVerdicts" in audit["properties"]
