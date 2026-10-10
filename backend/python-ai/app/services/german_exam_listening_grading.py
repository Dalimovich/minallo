"""Answer-key protection for the generated (AI) Hören path — what a learner-facing generate
response may contain, what gets held server-side instead, and how a submitted answer is graded
against that server-held state.

Covers every listening task type whose generated question object carries an answer field:
  speaker_statement_matching / multi_source_statement_matching -> matching.correctSpeakerId
  sentence_completion_mc3 / segmented_dialogue_mc3 / listening_detail_mc3 -> mc3.correctIndex
  structured_note_completion -> note.correctFill
  listening_tristate -> tristate.answer
matching.evidenceSegmentIds is also answer-bearing for the matching types (german_exam_listening.
_populate_hv1_evidence derives it 1:1 from correctSpeakerId — each speaker maps to exactly one
segment, so the segment id alone recovers the answer); it is treated the same as the answer field
itself: stripped from the learner-facing copy, returned only once grading actually happens.

Three of these task types are live today (telc C1 Hochschule: speaker_statement_matching,
sentence_completion_mc3, structured_note_completion, all available=True in
telc_c1_hochschule.py). The other four are Goethe C1's, still available=False everywhere
(goethe_c1.py) and unreachable through generate_task()'s _require_available() gate regardless of
this module — but the strip/grade logic here is generic per task_type, so Goethe inherits the
same protection automatically whenever/if those parts are ever flipped available, with no second
round of this fix needed.

Does NOT cover: main-idea/detail/tf/dictation/fill-gap (the older, hand-authored LISTEN_SETS
fixture content, not AI-generated) or the reading (Lesen) / source-selection.ts modules, which
have the identical embedded-answer-key architecture but are out of scope for this change — see
the audit note this module's introduction was paired with."""

from __future__ import annotations

import copy
from typing import Any

_MATCHING_TYPES = {"speaker_statement_matching", "multi_source_statement_matching"}
_MC3_TYPES = {"sentence_completion_mc3", "segmented_dialogue_mc3", "listening_detail_mc3"}
_NOTE_TYPES = {"structured_note_completion"}
_TRISTATE_TYPES = {"listening_tristate"}

ANSWER_KEY_TASK_TYPES = _MATCHING_TYPES | _MC3_TYPES | _NOTE_TYPES | _TRISTATE_TYPES


class UnknownListeningTaskTypeError(ValueError):
    pass


def _answer_field(task_type: str) -> tuple[str, str]:
    """Returns (sub_object_key, answer_key) for a given task type — where the answer lives
    inside one generated question object, e.g. ("matching", "correctSpeakerId")."""
    if task_type in _MATCHING_TYPES:
        return "matching", "correctSpeakerId"
    if task_type in _MC3_TYPES:
        return "mc3", "correctIndex"
    if task_type in _NOTE_TYPES:
        return "note", "correctFill"
    if task_type in _TRISTATE_TYPES:
        return "tristate", "answer"
    raise UnknownListeningTaskTypeError(task_type)


def build_grading_content(task_type: str, content: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Returns {questionId: {taskType, correct, evidenceSegmentIds?}} — grading-essential fields
    only, for every question in `content`. This, not the full generated content, is what
    german_exam_listening_practice_state.create_generation() persists."""
    sub_key, answer_key = _answer_field(task_type)
    grading_content: dict[str, dict[str, Any]] = {}
    for q in content.get("questions") or ():
        question_id = q.get("questionId")
        if not question_id:
            continue
        sub = q.get(sub_key) or {}
        entry: dict[str, Any] = {"taskType": task_type, "correct": sub.get(answer_key)}
        evidence = sub.get("evidenceSegmentIds")
        if evidence:
            entry["evidenceSegmentIds"] = list(evidence)
        grading_content[question_id] = entry
    return grading_content


def strip_listening_answer_key(task_type: str, content: dict[str, Any]) -> dict[str, Any]:
    """Returns a deep copy of generated listening content with the answer field (and
    evidenceSegmentIds, equally answer-bearing for the matching types) removed from every
    question's sub-object. Everything else — prompt/statement text, mc3 options, note
    fieldLabel/outlineContext, segments/speakers metadata — is kept unchanged; none of it is an
    answer key."""
    sub_key, answer_key = _answer_field(task_type)
    stripped = copy.deepcopy(content)
    for q in stripped.get("questions") or ():
        sub = q.get(sub_key)
        if isinstance(sub, dict):
            sub.pop(answer_key, None)
            sub.pop("evidenceSegmentIds", None)
    return stripped


def grade_answer(task_type: str, correct: Any, selected: Any) -> bool:
    """The exact comparison each LS_GRADERS entry used to do client-side, now run here against
    server-held `correct` instead of a client-supplied one. Mirrors lsGradeSpeakerMatchingType/
    lsGradeMc3Type/lsGradeNoteCompletionType/lsGradeMcqLikeType in frontend/views/practice/
    practice.js exactly, so moving the comparison here changes WHERE it runs, not what it does."""
    if task_type in _MATCHING_TYPES:
        return str(selected) == str(correct or "no_match")
    if task_type in _MC3_TYPES:
        try:
            return int(selected) == int(correct)
        except (TypeError, ValueError):
            return False
    if task_type in _NOTE_TYPES:
        return str(selected or "").strip().lower() == str(correct or "").strip().lower()
    if task_type in _TRISTATE_TYPES:
        return str(selected) == str(correct)
    raise UnknownListeningTaskTypeError(task_type)
