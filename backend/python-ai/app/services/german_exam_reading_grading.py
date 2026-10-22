"""Answer-key protection for reading (Lesen) and language_elements (Sprachbausteine) — generalizes
german_exam_listening_grading.py's pattern (audited 2026-10-10, closed for listening) to every
other AI-generated task type that carries an answer field. See _TOP_*/_MC3_TYPES/etc. below for
where each task type's answer field lives; READING_ANSWER_KEY_TASK_TYPES is the complete set.

Two task types key their answer at the whole PART, not per question:
  - paragraph_ordering: content.correctOrder (the one correct reading order)
  - reading_summary_error_detection: content.correctIds (which summary sentences are wrong)
build_grading_content() reformulates both into the same {questionId: {taskType, correct, ...}}
shape every other task type uses (paragraph_ordering's `correct` is each paragraph's correct
0-based position; reading_summary_error_detection's `correct` is a bool — "is this sentence one of
the content errors") so the stored shape, get_grading_entry(), and the shared grade-item endpoint
need no part-level special case.

contextual_cloze_mc4's `example` item is a DELIBERATELY solved worked example shown to the learner
with its answer already visible — it is not a `questions` entry, is never read by this module, and
must never be stripped.

Does NOT cover writing/speaking (their own grading paths — german_exam_writing_grading.py,
german_exam_testdaf_speaking.py, german_exam_speaking_practice.py — already never embed a key in
the generate response) or DSH's practice sandbox (german_exam_dsh_grading.py, already secure)."""

from __future__ import annotations

import copy
from typing import Any

from .german_exam_objective import SELECTION_TYPES

_TOP_CANDIDATE_TYPES = {"text_reconstruction_sentence_matching"}  # correctCandidateId
_TOP_SECTION_TYPES = {"section_statement_matching"}  # correctSectionId
_TOP_AUTHOR_TYPES = {"multi_author_statement_matching_with_none"}  # correctAuthorId + evidenceQuote
_TOP_INDEX_TYPES = {"contextual_cloze_mc4", "cloze_mc4_language_elements"}  # correctIndex
_MC3_TYPES = {"reading_detail_mc3", "reading_multiple_choice"}  # mc3.correctIndex + evidenceParagraphIds
_MIXED_TRISTATE_HEADING_TYPES = {"detail_tristate_with_global_heading"}  # tristate.answer | heading.correctHeadingId
_PART_LEVEL_ORDER_TYPES = {"paragraph_ordering"}  # content.correctOrder
_PART_LEVEL_IDS_TYPES = {"reading_summary_error_detection"}  # content.correctIds

READING_ANSWER_KEY_TASK_TYPES = (
    _TOP_CANDIDATE_TYPES
    | _TOP_SECTION_TYPES
    | _TOP_AUTHOR_TYPES
    | _TOP_INDEX_TYPES
    | _MC3_TYPES
    | _MIXED_TRISTATE_HEADING_TYPES
    | _PART_LEVEL_ORDER_TYPES
    | _PART_LEVEL_IDS_TYPES
    | SELECTION_TYPES
)


class UnknownReadingTaskTypeError(ValueError):
    pass


def build_grading_content(task_type: str, content: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Returns {questionId: {taskType, correct, evidence*?}} — grading-essential fields only, for
    every question in `content` (or, for the two part-level task types, derived from the part-wide
    answer field instead). This is what gets persisted server-side, exactly mirroring
    german_exam_listening_grading.build_grading_content's contract."""
    if task_type in _PART_LEVEL_ORDER_TYPES:
        order = content.get("correctOrder") or []
        return {question_id: {"taskType": task_type, "correct": i} for i, question_id in enumerate(order)}
    if task_type in _PART_LEVEL_IDS_TYPES:
        correct_ids = set(content.get("correctIds") or [])
        return {
            q["questionId"]: {"taskType": task_type, "correct": q["questionId"] in correct_ids}
            for q in content.get("questions") or ()
            if q.get("questionId")
        }
    grading_content: dict[str, dict[str, Any]] = {}
    for q in content.get("questions") or ():
        question_id = q.get("questionId") or q.get("id")
        if not question_id:
            continue
        grading_content[question_id] = _question_entry(task_type, q)
    return grading_content


def _question_entry(task_type: str, q: dict[str, Any]) -> dict[str, Any]:
    if task_type in _TOP_CANDIDATE_TYPES:
        return {"taskType": task_type, "correct": q.get("correctCandidateId")}
    if task_type in _TOP_SECTION_TYPES:
        return {"taskType": task_type, "correct": q.get("correctSectionId")}
    if task_type in _TOP_AUTHOR_TYPES:
        entry: dict[str, Any] = {"taskType": task_type, "correct": q.get("correctAuthorId")}
        if q.get("evidenceQuote"):
            entry["evidenceQuote"] = q["evidenceQuote"]
        return entry
    if task_type in _TOP_INDEX_TYPES:
        return {"taskType": task_type, "correct": q.get("correctIndex")}
    if task_type in _MC3_TYPES:
        mc3 = q.get("mc3") or {}
        entry = {"taskType": task_type, "correct": mc3.get("correctIndex")}
        if mc3.get("evidenceParagraphIds"):
            entry["evidenceParagraphIds"] = list(mc3["evidenceParagraphIds"])
        return entry
    if task_type in _MIXED_TRISTATE_HEADING_TYPES:
        if q.get("kind") == "global_heading":
            heading = q.get("heading") or {}
            return {"taskType": task_type, "correct": heading.get("correctHeadingId")}
        tristate = q.get("tristate") or {}
        entry = {"taskType": task_type, "correct": tristate.get("answer")}
        if tristate.get("evidenceParagraphIds"):
            entry["evidenceParagraphIds"] = list(tristate["evidenceParagraphIds"])
        return entry
    if task_type in SELECTION_TYPES:
        entry = {"taskType": task_type, "correct": q.get("answerId")}
        if q.get("evidenceIds"):
            entry["evidenceIds"] = list(q["evidenceIds"])
        return entry
    raise UnknownReadingTaskTypeError(task_type)


def strip_reading_answer_key(task_type: str, content: dict[str, Any]) -> dict[str, Any]:
    """Returns a deep copy of generated content with every answer-bearing field removed. Everything
    else — text/options/skillTags/the contextual_cloze_mc4 `example` worked example — is kept."""
    stripped = copy.deepcopy(content)
    if task_type in _PART_LEVEL_ORDER_TYPES:
        stripped.pop("correctOrder", None)
        return stripped
    if task_type in _PART_LEVEL_IDS_TYPES:
        stripped.pop("correctIds", None)
        return stripped
    for q in stripped.get("questions") or ():
        _strip_question(task_type, q)
    return stripped


def _strip_question(task_type: str, q: dict[str, Any]) -> None:
    if task_type in _TOP_CANDIDATE_TYPES:
        q.pop("correctCandidateId", None)
    elif task_type in _TOP_SECTION_TYPES:
        q.pop("correctSectionId", None)
    elif task_type in _TOP_AUTHOR_TYPES:
        q.pop("correctAuthorId", None)
        q.pop("evidenceQuote", None)
    elif task_type in _TOP_INDEX_TYPES:
        q.pop("correctIndex", None)
    elif task_type in _MC3_TYPES:
        mc3 = q.get("mc3")
        if isinstance(mc3, dict):
            mc3.pop("correctIndex", None)
            mc3.pop("evidenceParagraphIds", None)
    elif task_type in _MIXED_TRISTATE_HEADING_TYPES:
        if q.get("kind") == "global_heading":
            heading = q.get("heading")
            if isinstance(heading, dict):
                heading.pop("correctHeadingId", None)
        else:
            tristate = q.get("tristate")
            if isinstance(tristate, dict):
                tristate.pop("answer", None)
                tristate.pop("evidenceParagraphIds", None)
    elif task_type in SELECTION_TYPES:
        q.pop("answerId", None)
        q.pop("evidenceIds", None)
    else:
        raise UnknownReadingTaskTypeError(task_type)


def grade_answer(task_type: str, correct: Any, selected: Any) -> bool:
    """The exact comparison each rdGrade*/sbCheckGeneratedAnswers/gradeSelection used to do
    client-side (frontend/views/practice/practice.js, frontend/js/features/german-exam/
    source-selection.ts) now run here against server-held `correct` instead of a client-supplied
    one. Moves WHERE the comparison runs, not what it does."""
    if task_type in _PART_LEVEL_IDS_TYPES:
        return bool(selected) == bool(correct)
    if task_type in (_PART_LEVEL_ORDER_TYPES | _TOP_INDEX_TYPES | _MC3_TYPES):
        try:
            return int(selected) == int(correct)
        except (TypeError, ValueError):
            return False
    if task_type in (_TOP_CANDIDATE_TYPES | _TOP_SECTION_TYPES | _TOP_AUTHOR_TYPES | _MIXED_TRISTATE_HEADING_TYPES | SELECTION_TYPES):
        return str(selected) == str(correct)
    raise UnknownReadingTaskTypeError(task_type)
