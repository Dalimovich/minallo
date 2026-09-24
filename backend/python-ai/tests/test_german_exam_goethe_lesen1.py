"""Goethe Lesen Teil 1 — the generic contextual_cloze_mc4 task type (offline: fixtures only)."""

from __future__ import annotations

import copy

from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult, _apply_audits
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part, get_profile
from app.services.german_exams.task_types import is_task_type_implemented

PID = "goethe_c1"
PART = get_part(PID, "reading", "lesen_1")


def _text() -> dict:
    filler = " ".join(f"Satz{i} bringt die Lage Schritt für Schritt voran." for i in range(1, 27))
    paras = [
        "Die Debatte über neue Arbeitszeitmodelle {{g0}} in den letzten Jahren spürbar an Schärfe. " + filler[:400],
        "Befürworter verweisen auf {{g1}} Erfahrungen aus Pilotprojekten, während Kritiker {{g2}} Kosten fürchten. " + filler[400:800],
        "Entscheidend ist {{g3}}, wie die Arbeit organisiert wird, {{g4}} nicht, wie viele Stunden gezählt werden. " + filler[800:1200],
        "Manche Betriebe {{g5}} bereits eigene Lösungen, {{g6}} andere noch abwarten und {{g7}} die Politik hoffen. " + filler[1200:1600],
        "Am Ende {{g8}} sich zeigen, welches Modell trägt. " + filler[1600:2000],
    ]
    return {"title": "Neue Arbeitszeit", "paragraphs": paras}


def _item(i: int, key: int) -> dict:
    options = [f"wort{i}a", f"wort{i}b", f"wort{i}c", f"wort{i}d"]
    return {"gapId": f"g{i}", "options": options, "correctIndex": key}


def _content() -> dict:
    keys = [0, 1, 2, 3, 1, 2, 0, 3]
    return {
        "text": _text(),
        "example": _item(0, 2),
        "questions": [
            {"questionId": f"q{i}", **_item(i, keys[i - 1]), "skillTags": ["paraphrase_mapping"], "difficulty": "c1"}
            for i in range(1, 9)
        ],
    }


def _issues(content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(PART, content))]


def test_profile_wiring() -> None:
    assert PART.task_type == "contextual_cloze_mc4"
    assert PART.available is False, "Goethe parts stay unavailable until live qualification"
    assert is_task_type_implemented("contextual_cloze_mc4")
    assert reading._PROMPT_BUILDERS["contextual_cloze_mc4"] is reading._prompt_contextual_cloze_mc4
    assert "contextual_cloze_mc4" in verify._VERIFY_PROMPT_BUILDERS
    assert PART.constraints["gapCount"] == 8 and PART.constraints["exampleGapCount"] == 1


def test_prompt_is_built_from_the_blueprint() -> None:
    system, user = reading._prompt_contextual_cloze_mc4(get_profile(PID), PART, [], {"topicId": "t", "label": "Arbeitszeit"})
    assert "about 320 words" in system and "exactly 4 options" in system
    assert "{{g0}}" in system and "g8" in system and "Arbeitszeit" in user
    assert "example" in system


def test_valid_content_passes() -> None:
    assert _issues(_content()) == []


def test_placeholders_must_be_exact_and_in_order() -> None:
    c = _content()
    c["text"]["paragraphs"][1] = c["text"]["paragraphs"][1].replace("{{g2}}", "{{g9}}")
    assert any("placeholders must be exactly" in m for m in _issues(c))
    c = _content()
    c["text"]["paragraphs"][0] = c["text"]["paragraphs"][0].replace("{{g0}} ", "")
    assert any("placeholders must be exactly" in m for m in _issues(c))
    c = _content()
    c["text"]["paragraphs"][4] += " {{g8}}"
    assert any("placeholders must be exactly" in m for m in _issues(c))
    c = _content()
    c["text"]["paragraphs"][4] += " {{kaputt"
    assert any("malformed gap placeholder" in m for m in _issues(c))


def test_item_shape_is_enforced() -> None:
    c = _content()
    c["questions"] = c["questions"][:7]
    assert any("expected 8 gap items" in m for m in _issues(c))
    c = _content()
    c["questions"][0]["options"].append("noch")
    assert any("expected 4 non-empty options" in m for m in _issues(c))
    c = _content()
    c["questions"][1]["options"][1] = c["questions"][1]["options"][0]
    assert any("duplicate options" in m for m in _issues(c))
    c = _content()
    c["questions"][2]["correctIndex"] = 4
    assert any("correctIndex" in m for m in _issues(c))
    c = _content()
    c["questions"][3]["gapId"] = "g7"
    assert any("gapId must be g4" in m for m in _issues(c))
    c = _content()
    del c["example"]
    assert any("example" in (i.item_id or "") or "missing" in i.message for i in validate_content(PART, c))


def test_length_is_enforced() -> None:
    c = _content()
    c["text"]["paragraphs"] = c["text"]["paragraphs"][:3]
    assert any("words, expected about 320" in m or "placeholders" in m for m in _issues(c))
    c = _content()
    c["text"]["paragraphs"].append(" ".join(f"w{i}" for i in range(400)))
    assert any("words, expected about 320" in m for m in _issues(c))


def test_answer_position_must_be_balanced() -> None:
    c = _content()
    for q in c["questions"]:
        q["options"] = ["a" + q["gapId"], "b" + q["gapId"], "c" + q["gapId"], "d" + q["gapId"]]
        q["correctIndex"] = 1
    assert any("same position" in m for m in _issues(c))


def test_balancing_postprocess_keeps_keys_consistent_for_cloze_items() -> None:
    c = _content()
    for q in c["questions"]:
        q["correctIndex"] = 1
    before = {q["questionId"]: q["options"][q["correctIndex"]] for q in c["questions"]}
    out = reading.balance_option_positions(c)
    after = {q["questionId"]: q["options"][q["correctIndex"]] for q in out["questions"]}
    assert after == before, "the correct answer text must not change"
    assert len({q["correctIndex"] for q in out["questions"]}) > 1
    assert [q["correctIndex"] for q in c["questions"]] == [1] * 8, "input is not mutated"
    assert _issues(out) == []
    # the mc3 path still works
    mc3 = {"questions": [{"mc3": {"options": ["a", "b", "c"], "correctIndex": 0}} for _ in range(6)]}
    balanced = reading.balance_option_positions(mc3)
    assert all(q["mc3"]["options"][q["mc3"]["correctIndex"]] == "a" for q in balanced["questions"])


def test_skill_tags_must_exist_for_reading() -> None:
    c = _content()
    c["questions"][0]["skillTags"] = ["nope"]
    assert _issues(c)


# ── verifier interpretation (no provider call) ─────────────────────────────


def _audit(question: dict, verdicts):
    data = {"items": [{"questionId": question["questionId"], "audit": {"optionVerdicts": verdicts}}]}
    clean = SemanticVerificationResult(True, [], [ItemSemanticResult(question["questionId"], True, [])])
    return _apply_audits(clean, data, PART, {"questions": [question]})


def test_verifier_accepts_one_supported_option() -> None:
    q = {"questionId": "q1", "correctIndex": 2}
    assert _audit(q, ["plausible_wrong", "plausible_wrong", "supported", "plausible_wrong"]).passed


def test_verifier_flags_second_defensible_option_and_implausible_and_wrong_key() -> None:
    q = {"questionId": "q1", "correctIndex": 2}
    r = _audit(q, ["supported", "plausible_wrong", "supported", "plausible_wrong"])
    assert [i.code for i in r.items[0].issues] == ["MULTIPLE_DEFENSIBLE_ANSWERS"]
    r = _audit(q, ["plausible_wrong", "implausible_wrong", "supported", "plausible_wrong"])
    assert [i.code for i in r.items[0].issues] == ["IMPLAUSIBLE_DISTRACTOR"]
    r = _audit(q, ["supported", "plausible_wrong", "plausible_wrong", "plausible_wrong"])
    assert [i.code for i in r.items[0].issues] == ["UNSUPPORTED_CORRECT_ANSWER"]
    r = _audit(q, ["supported"])
    assert [i.code for i in r.items[0].issues] == ["VERIFIER_RESPONSE_INVALID"]


def test_verifier_prompt_carries_the_example_and_no_exam_specific_wording() -> None:
    system, user = verify._verify_prompt_contextual_cloze(PART, _content())
    assert "Lückentext" in system and "g0" in system
    assert "example" in user and "Sprachbausteine" not in system
