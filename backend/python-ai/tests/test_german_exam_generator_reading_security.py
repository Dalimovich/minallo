"""generate_task()'s reading/language_elements answer-key protection (german_exam_generator.
_secure_envelope, german_exam_reading_grading.py) — closes the exposure QA run 2 (2026-10-12)
found live: Reading and Sprachbausteine task generation handed the browser the full answer key
(correctIndex, correctCandidateId, correctSectionId, correctAuthorId, correctHeadingId, answerId,
tristate.answer, evidenceParagraphIds, evidenceQuote, evidenceIds) embedded in every question,
because nothing held it server-side between generation and grading — the same class of bug
test_german_exam_generator_listening_security.py already proved fixed for listening.

Mocked throughout, same style as that file: compute_weakness/build_adaptation_plan/pick_topic/
record_topic_used/the module adapter are stubbed, and listening_practice_state.create_generation
is stubbed to a recording fake — no network, no database.
"""

from __future__ import annotations

import re

import pytest

from app.services import german_exam_generator as gen
from app.services import german_exam_reading_grading as grading
from app.services.german_exams import GERMAN_EXAM_PROFILES

_ANSWER_KEY_PATTERN = re.compile(r'"(correct[A-Za-z]*|answerId|evidence[A-Za-z]*|explanation|solution)"')


def _stub_common(monkeypatch):
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: None)
    monkeypatch.setattr(gen, "build_adaptation_plan", lambda *a, **k: [])
    monkeypatch.setattr(gen, "pick_topic", lambda *a, **k: {"topicId": "urban_mobility", "label": "Stadtplanung"})
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: None)


def _recording_create_generation(monkeypatch, store: list):
    def fake(user_id, part_id, grading_content, *, generation_id):
        store.append({"user_id": user_id, "part_id": part_id, "grading_content": grading_content, "generation_id": generation_id})
        return generation_id

    monkeypatch.setattr(gen.listening_practice_state, "create_generation", fake)


# ---- exhaustive guard: every reading/language_elements part in every registered profile must be
# in a protected set — a future part whose task type nobody registers here fails automatically,
# without needing a generation fixture for it. ---------------------------------------------------


def test_every_registered_reading_and_language_elements_task_type_is_answer_key_protected():
    """Checks EVERY registered part, available or not — a part flipped available=True later must
    already be covered, not discovered unprotected at that point. DSH's reading module
    (dsh_lv_text_tasks) is the one documented exception: generate_reading_part() routes it to a
    wholly different generator/content shape (german_exam_dsh_generators.generate_dsh_lv_part,
    open-answer content points, no correct*/answerId field at all) with its own, separately
    audited protection (german_exam_dsh_grading.py) — never this envelope's correct*/answerId
    shape, and never reachable through generate_task() at all while every DSH part stays
    available=False (see routers/german_exam.py's DSH section docstring)."""
    unprotected: list[str] = []
    for profile in GERMAN_EXAM_PROFILES.values():
        for module in ("reading", "language_elements"):
            for part in profile.modules.get(module, ()):
                if part.task_type.startswith("dsh_"):
                    continue
                if part.task_type not in grading.READING_ANSWER_KEY_TASK_TYPES:
                    unprotected.append(f"{profile.profile_id}/{module}/{part.part_id} ({part.task_type!r})")
    assert not unprotected, f"reading/language_elements task types missing answer-key protection: {unprotected}"


# ---- live generation path, one fixture per answer-key shape -------------------------------------

_FIXTURES: dict[str, dict] = {
    "text_reconstruction_sentence_matching": {
        "text": {"paragraphs": ["... {{g1}} ..."], "gaps": [{"gapId": "g1"}]},
        "candidates": [{"candidateId": "c1", "text": "x"}, {"candidateId": "c2", "text": "y"}],
        "questions": [{"questionId": "q1", "gapId": "g1", "correctCandidateId": "c1", "skillTags": ["text_structure"]}],
    },
    "section_statement_matching": {
        "sections": [{"sectionId": "a", "text": "x"}],
        "questions": [{"questionId": "q1", "statement": "s", "correctSectionId": "a", "skillTags": ["inference"]}],
    },
    "detail_tristate_with_global_heading": {
        "text": {"paragraphs": [{"paragraphId": "p1", "text": "x"}]},
        "questions": [
            {"questionId": "q1", "kind": "detail", "statement": "s",
             "tristate": {"answer": "richtig", "evidenceParagraphIds": ["p1"]}, "skillTags": ["detail_comprehension"]},
            {"questionId": "q2", "kind": "global_heading",
             "heading": {"options": [{"headingId": "h1", "text": "x"}], "correctHeadingId": "h1"}, "skillTags": ["global_comprehension"]},
        ],
    },
    "reading_detail_mc3": {
        "text": {"paragraphs": [{"paragraphId": "p1", "text": "x"}]},
        "questions": [{"questionId": "q1", "skillTags": ["detail_comprehension"],
                       "mc3": {"stem": "s", "options": ["a", "b", "c"], "correctIndex": 1, "evidenceParagraphIds": ["p1"]}}],
    },
    "multi_author_statement_matching_with_none": {
        "text": {"authors": [{"authorId": "a", "name": "A", "text": "x"}]},
        "questions": [{"questionId": "q1", "statement": "s", "correctAuthorId": "a", "evidenceQuote": "secret proof",
                       "skillTags": ["author_intention"]}],
    },
    "contextual_cloze_mc4": {
        "text": {"paragraphs": ["{{g0}} ... {{g1}} ..."]},
        "example": {"gapId": "g0", "options": ["a", "b"], "correctIndex": 0},
        "questions": [{"questionId": "q1", "gapId": "g1", "options": ["a", "b", "c", "d"], "correctIndex": 2, "skillTags": ["paraphrase_mapping"]}],
    },
    "cloze_mc4_language_elements": {
        "text": {"paragraphs": ["... {{g1}} ..."]},
        "questions": [{"questionId": "q1", "gapId": "g1", "options": ["a", "b", "c", "d"], "correctIndex": 3, "skillTags": ["lexicon"]}],
    },
    "speech_act_matching": {
        "schemaVersion": "source-selection-v1",
        "source": {"paragraphs": [{"id": "p1", "text": "x"}]},
        "options": [{"id": "a", "text": "x"}],
        "questions": [{"id": "q1", "prompt": "p", "answerId": "a", "evidenceIds": ["p1"], "skillTags": ["inference"]}],
    },
}


@pytest.mark.parametrize("task_type", sorted(_FIXTURES))
def test_secure_envelope_strips_every_answer_key_shape(monkeypatch, task_type):
    """Exercises german_exam_generator._secure_envelope directly against a synthetic envelope for
    every answer-key shape, independent of which exam profile currently wires that task type as
    available — several of these (speech_act_matching, the TestDaF-only cloze/ordering types) are
    not yet available=True anywhere, so they cannot be driven through the real generate_task()
    pipeline today, but their protection must already be correct (see the exhaustive guard test
    above for why that matters)."""
    _stub_common(monkeypatch)
    stored: list = []
    _recording_create_generation(monkeypatch, stored)
    content = _FIXTURES[task_type]
    envelope = {
        "generationId": "gen-1",
        "module": "language_elements" if task_type == "cloze_mc4_language_elements" else "reading",
        "part": {"id": "part-1", "title": "x", "taskType": task_type, "approxDurationSeconds": 600},
        "content": content,
    }

    secured = gen._secure_envelope(envelope, "u1")

    serialized = str(secured)
    for match in _ANSWER_KEY_PATTERN.finditer(serialized):
        pytest.fail(f"{task_type}: answer-key-looking field {match.group(1)!r} present in envelope: {serialized}")
    assert len(stored) == 1
    assert stored[0]["grading_content"] == grading.build_grading_content(task_type, content)


def test_generate_task_end_to_end_strips_and_stores_for_a_real_available_part(monkeypatch):
    """One full generate_task() pipeline run (real get_profile/get_part/_require_available gate,
    not a synthetic envelope) for a real, available=True part — proves the dispatcher is actually
    wired into generate_task(), mirroring the listening security test's own end-to-end case."""
    _stub_common(monkeypatch)
    stored: list = []
    _recording_create_generation(monkeypatch, stored)
    content = _FIXTURES["text_reconstruction_sentence_matching"]
    monkeypatch.setattr(gen, "_generate_reading", lambda profile, part, plan, topic: (content, {"deterministicPassed": True}))

    envelope = gen.generate_task("u1", "telc_c1_hochschule", "reading", "lesen_1", "adaptive_practice")

    assert "correctCandidateId" not in str(envelope)
    assert len(stored) == 1
    assert stored[0]["grading_content"]["q1"]["correct"] == "c1"


def test_contextual_cloze_mc4_example_is_never_stripped():
    """The `example` item is a deliberately solved worked example shown to the learner — unlike
    every `questions` entry, its correctIndex must survive stripping untouched."""
    content = _FIXTURES["contextual_cloze_mc4"]
    stripped = grading.strip_reading_answer_key("contextual_cloze_mc4", content)
    assert stripped["example"] == {"gapId": "g0", "options": ["a", "b"], "correctIndex": 0}
    assert "correctIndex" not in stripped["questions"][0]


def test_paragraph_ordering_and_summary_error_detection_use_part_level_answer_fields():
    order_content = {"questions": [{"questionId": "p1", "text": "a"}, {"questionId": "p2", "text": "b"}], "correctOrder": ["p2", "p1"]}
    gc = grading.build_grading_content("paragraph_ordering", order_content)
    assert gc == {"p2": {"taskType": "paragraph_ordering", "correct": 0}, "p1": {"taskType": "paragraph_ordering", "correct": 1}}
    stripped = grading.strip_reading_answer_key("paragraph_ordering", order_content)
    assert "correctOrder" not in stripped

    errors_content = {"questions": [{"questionId": "s1"}, {"questionId": "s2"}], "correctIds": ["s2"]}
    gc2 = grading.build_grading_content("reading_summary_error_detection", errors_content)
    assert gc2 == {
        "s1": {"taskType": "reading_summary_error_detection", "correct": False},
        "s2": {"taskType": "reading_summary_error_detection", "correct": True},
    }
    stripped2 = grading.strip_reading_answer_key("reading_summary_error_detection", errors_content)
    assert "correctIds" not in stripped2


def test_non_reading_modules_never_touch_listening_practice_state(monkeypatch):
    _stub_common(monkeypatch)
    stored: list = []
    _recording_create_generation(monkeypatch, stored)
    monkeypatch.setattr(gen, "_generate_writing", lambda profile, part, plan, topic: ({"questions": []}, {"deterministicPassed": True}))

    gen.generate_task("u1", "telc_c1_hochschule", "writing", "schreiben_1", "adaptive_practice")

    assert stored == []
