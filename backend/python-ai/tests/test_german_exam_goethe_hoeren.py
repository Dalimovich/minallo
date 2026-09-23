"""Goethe Hören Teil 1-4 — offline: fixtures only, no provider calls.

Covers the generic multi_source_statement_matching / listening_tristate /
segmented_dialogue_mc3 / listening_detail_mc3 task types: profile wiring,
prompt builders, deterministic validators, and (where the shape is shared
with an existing telc task type) semantic-verify audit reuse."""

from __future__ import annotations

from app.services import german_exam_listening as listening
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult, _apply_audits
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part, get_profile
from app.services.german_exams.task_types import is_task_type_implemented

PID = "goethe_c1"
HOEREN_1 = get_part(PID, "listening", "hoeren_1")
HOEREN_2 = get_part(PID, "listening", "hoeren_2")
HOEREN_3 = get_part(PID, "listening", "hoeren_3")
HOEREN_4 = get_part(PID, "listening", "hoeren_4")


def _issues(part, content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(part, content))]


# ── profile / registration wiring ───────────────────────────────────────────


def test_profile_wiring() -> None:
    for part, task_type in (
        (HOEREN_1, "multi_source_statement_matching"),
        (HOEREN_2, "listening_tristate"),
        (HOEREN_3, "segmented_dialogue_mc3"),
        (HOEREN_4, "listening_detail_mc3"),
    ):
        assert part.task_type == task_type
        assert part.available is False, "Goethe parts stay unavailable until live qualification"
        assert is_task_type_implemented(task_type)
        assert task_type in listening._PROMPT_BUILDERS
        assert task_type in verify._VERIFY_PROMPT_BUILDERS


def test_prompts_are_built_from_the_blueprint() -> None:
    system, user = listening._prompt_goethe_hoeren1(get_profile(PID), HOEREN_1, [], {"topicId": "t", "label": "Umwelt"})
    assert "exactly 3" in system and "exactly 6" in system and "Umwelt" in user

    system, _ = listening._prompt_goethe_hoeren2(get_profile(PID), HOEREN_2, [], {"topicId": "t", "label": "Umwelt"})
    assert "exactly 9" in system and "richtig" in system

    system, _ = listening._prompt_goethe_hoeren3(get_profile(PID), HOEREN_3, [], {"topicId": "t", "label": "Umwelt"})
    assert "exactly 4" in system and "exactly 2" in system

    system, _ = listening._prompt_goethe_hoeren4(get_profile(PID), HOEREN_4, [], {"topicId": "t", "label": "Umwelt"})
    assert "exactly 7" in system and "solo academic lecture" in system


# ── Hören 1: multi_source_statement_matching ────────────────────────────────


def _hv1_content(unmatched: int = 0) -> dict:
    segments = [{"id": f"s{i}", "speakerId": f"source_{i}", "spokenText": f"Text {i}", "displayText": f"Text {i}"} for i in range(1, 4)]
    questions = []
    mapping = [1, 2, 3, 1, 2, 3]
    for i, src in enumerate(mapping, start=1):
        questions.append({
            "questionId": f"q{i}", "statement": f"Statement {i}", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1",
            "matching": {"correctSpeakerId": f"source_{src}", "isDistractor": False, "evidenceSegmentIds": [f"s{src}"]},
        })
    if unmatched:
        for i in range(len(questions) - unmatched, len(questions)):
            questions[i]["matching"] = {"correctSpeakerId": None, "isDistractor": True}
    return {"segments": segments, "questions": questions}


def test_hoeren1_valid_content_passes() -> None:
    assert _issues(HOEREN_1, _hv1_content()) == []


def test_hoeren1_is_not_a_bijection() -> None:
    # source_1 answers two statements — this must NOT be flagged (unlike speaker_statement_matching).
    c = _hv1_content()
    assert _issues(HOEREN_1, c) == []


def test_hoeren1_wrong_unmatched_count() -> None:
    c = _hv1_content()
    c["questions"][0]["matching"] = {"correctSpeakerId": None, "isDistractor": True}
    assert any("unmatched statements" in m for m in _issues(HOEREN_1, c))


def test_hoeren1_source_never_used_is_flagged() -> None:
    c = _hv1_content()
    for q in c["questions"]:
        q["matching"]["correctSpeakerId"] = "source_1"
    assert any("at least one statement" in m for m in _issues(HOEREN_1, c))


def test_hoeren1_verifier_reuses_speaker_statement_matching_audit() -> None:
    q = {"questionId": "q1", "matching": {"correctSpeakerId": "source_2", "isDistractor": False}}
    content = {"segments": [{"speakerId": "source_2"}], "questions": [q]}
    clean = SemanticVerificationResult(True, [], [ItemSemanticResult("q1", True, [])])
    data = {"items": [{"questionId": "q1", "audit": {"supportedSpeakerIds": ["source_2"], "plausible": True}}]}
    result = _apply_audits(clean, data, HOEREN_1, content)
    assert result.passed


# ── Hören 2: listening_tristate ─────────────────────────────────────────────


def _hv2_content() -> dict:
    segments = [{"id": "s1", "speakerId": "speaker_1", "spokenText": "Text", "displayText": "Text"}]
    answers = ["richtig", "falsch", "nicht_im_text"] * 3
    questions = [
        {"questionId": f"q{i}", "statement": f"Statement {i}", "skillTags": ["detail_fact"], "difficulty": "c1",
         "tristate": {"answer": ans, "evidenceSegmentIds": [] if ans == "nicht_im_text" else ["s1"]}}
        for i, ans in enumerate(answers, start=1)
    ]
    return {"segments": segments, "questions": questions}


def test_hoeren2_valid_content_passes() -> None:
    assert _issues(HOEREN_2, _hv2_content()) == []


def test_hoeren2_bad_answer_value_rejected() -> None:
    c = _hv2_content()
    c["questions"][0]["tristate"]["answer"] = "vielleicht"
    assert any("tristate.answer" in m for m in _issues(HOEREN_2, c))


def test_hoeren2_wrong_item_count() -> None:
    c = _hv2_content()
    c["questions"] = c["questions"][:5]
    assert any("expected 9 items" in m for m in _issues(HOEREN_2, c))


def test_hoeren2_verifier_audit() -> None:
    q = {"questionId": "q1", "tristate": {"answer": "richtig"}}
    content = {"segments": [], "questions": [q]}
    clean = SemanticVerificationResult(True, [], [ItemSemanticResult("q1", True, [])])
    data = {"items": [{"questionId": "q1", "audit": {"trueVerdict": "falsch"}}]}
    result = _apply_audits(clean, data, HOEREN_2, content)
    assert not result.passed
    assert result.items[0].issues[0].code == "TRISTATE_VERDICT_MISMATCH"


# ── Hören 3: segmented_dialogue_mc3 ─────────────────────────────────────────


def _hv3_content() -> dict:
    segments = [{"id": f"s{i}", "speakerId": f"speaker_{i % 3 + 1}", "sectionId": f"sec{i // 2 + 1}",
                 "spokenText": f"Text {i}", "displayText": f"Text {i}"} for i in range(8)]
    questions = []
    n = 1
    for sec in range(1, 5):
        for _ in range(2):
            questions.append({
                "questionId": f"q{n}", "sectionId": f"sec{sec}", "skillTags": ["detail_fact"], "difficulty": "c1",
                "mc3": {"stem": f"Stem {n}", "options": ["a", "b", "c"], "correctIndex": 1, "evidenceSegmentIds": ["s0"]},
            })
            n += 1
    return {"segments": segments, "questions": questions}


def test_hoeren3_valid_content_passes() -> None:
    assert _issues(HOEREN_3, _hv3_content()) == []


def test_hoeren3_unbalanced_sections_rejected() -> None:
    c = _hv3_content()
    c["questions"][0]["sectionId"] = "sec2"
    assert any("unbalanced" in m for m in _issues(HOEREN_3, c))


def test_hoeren3_verifier_reuses_mc3_audit() -> None:
    assert "segmented_dialogue_mc3" in verify._MC3_TASK_TYPES


# ── Hören 4: listening_detail_mc3 (reuses sentence_completion_mc3's validator) ──


def _hv4_content() -> dict:
    segments = [{"id": "s1", "speakerId": "speaker_1", "spokenText": "Text", "displayText": "Text"}]
    questions = [
        {"questionId": f"q{i}", "skillTags": ["detail_fact"], "difficulty": "c1",
         "mc3": {"stem": f"Stem {i}", "options": ["a", "b", "c"], "correctIndex": 0, "evidenceSegmentIds": ["s1"]}}
        for i in range(1, 8)
    ]
    return {"segments": segments, "questions": questions}


def test_hoeren4_valid_content_passes_with_a_single_speaker() -> None:
    # Solo Vortrag: only 1 speaker — must not require speakerCountMin=2 (telc's default).
    assert _issues(HOEREN_4, _hv4_content()) == []
    assert HOEREN_4.constraints["speakerCountMin"] == 1


def test_hoeren4_reuses_sentence_completion_mc3_validator() -> None:
    from app.services.german_exam_validator import VALIDATORS, validate_sentence_completion_mc3
    assert VALIDATORS["listening_detail_mc3"] is validate_sentence_completion_mc3
