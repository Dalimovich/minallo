"""Shared German Exam Engine — deterministic, pre-TTS content validation.

Dispatched by `task_type` (not `profile_id`), so a future exam family
reusing e.g. `sentence_completion_mc3` gets this validator for free.

Each validator returns a list of `ValidationIssue`s — empty means the part
passed. `german_exam_listening.py` (and later module adapters) use this list
to drive the bounded per-item repair loop; a non-empty list is never
silently accepted.

Only structural/deterministic checks live here. Semantic checks (e.g. "does
this distractor actually come from a nearby fact") are logged as soft issues
(`hard=False`) in Phase 1 — informational only, not blocking — pending the
optional semantic verifier pass (deferred, see german_exam_generator.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .german_exam_profiles import PartBlueprint
from .german_exam_skill_tags import UnknownSkillTagError, validate_tags


@dataclass
class ValidationIssue:
    item_id: str | None  # None means the issue is part-level, not one item
    message: str
    hard: bool = True  # hard issues block freezing; soft issues are logged only


def _check_skill_tags(module: str, items: list[dict[str, Any]], id_key: str) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for item in items:
        tags = item.get("skillTags") or []
        if not tags:
            issues.append(ValidationIssue(item.get(id_key), "skillTags must be non-empty"))
            continue
        try:
            validate_tags(module, tags)
        except UnknownSkillTagError as exc:
            issues.append(ValidationIssue(item.get(id_key), str(exc)))
    return issues


def validate_speaker_statement_matching(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []

    speaker_count = part.constraints.get("speakerCount", 8)
    statement_count = part.constraints.get("statementCount", 10)
    unused_count = part.constraints.get("unusedStatements", 2)

    if len(segments) != speaker_count:
        issues.append(ValidationIssue(None, f"expected {speaker_count} speaker segments, got {len(segments)}"))
    speaker_ids = [s.get("speakerId") for s in segments]
    if len(set(speaker_ids)) != len(speaker_ids):
        issues.append(ValidationIssue(None, "duplicate speakerId across segments"))
    for s in segments:
        if not (s.get("spokenText") or "").strip():
            issues.append(ValidationIssue(s.get("id"), "segment spokenText is empty"))

    if len(questions) != statement_count:
        issues.append(ValidationIssue(None, f"expected {statement_count} statements, got {len(questions)}"))

    mapped_speakers: list[str] = []
    distractor_count = 0
    for q in questions:
        matching = q.get("matching") or {}
        if matching.get("isDistractor"):
            distractor_count += 1
            if matching.get("correctSpeakerId"):
                issues.append(ValidationIssue(q.get("questionId"), "distractor item must not carry correctSpeakerId"))
            continue
        correct = matching.get("correctSpeakerId")
        if not correct or correct not in set(speaker_ids):
            issues.append(ValidationIssue(q.get("questionId"), "correctSpeakerId is missing or unknown"))
            continue
        mapped_speakers.append(correct)

    if distractor_count != unused_count:
        issues.append(ValidationIssue(None, f"expected {unused_count} distractor statements, got {distractor_count}"))
    if len(mapped_speakers) != len(set(mapped_speakers)):
        issues.append(ValidationIssue(None, "a speaker is mapped by more than one statement (not a bijection)"))
    if set(mapped_speakers) != set(speaker_ids) and len(segments) == speaker_count:
        issues.append(ValidationIssue(None, "not every speaker has exactly one correct mapping"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


def validate_sentence_completion_mc3(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []

    item_count = part.constraints.get("itemCount", 10)
    option_count = part.constraints.get("optionCount", 3)
    speaker_min = part.constraints.get("speakerCountMin", 2)

    if len(segments) < 1:
        issues.append(ValidationIssue(None, "expected at least 1 dialogue segment"))
    speaker_ids = {s.get("speakerId") for s in segments if s.get("speakerId")}
    if len(speaker_ids) < speaker_min:
        issues.append(ValidationIssue(None, f"expected at least {speaker_min} distinct speakers, got {len(speaker_ids)}"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items, got {len(questions)}"))

    for q in questions:
        mc3 = q.get("mc3") or {}
        options = mc3.get("options") or []
        if len(options) != option_count:
            issues.append(ValidationIssue(q.get("questionId"), f"expected {option_count} options, got {len(options)}"))
        if len({o.strip().lower() for o in options if isinstance(o, str)}) != len(options):
            issues.append(ValidationIssue(q.get("questionId"), "duplicate options within one item"))
        correct_index = mc3.get("correctIndex")
        if not isinstance(correct_index, int) or not (0 <= correct_index < max(1, option_count)):
            issues.append(ValidationIssue(q.get("questionId"), "correctIndex missing or out of range"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


def validate_structured_note_completion(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []

    item_count = part.constraints.get("itemCount", 10)

    if len(segments) < 1:
        issues.append(ValidationIssue(None, "expected at least 1 lecture segment"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} note-completion fields, got {len(questions)}"))

    seen_fills: list[str] = []
    for q in questions:
        if q.get("matching") or q.get("mc3"):
            issues.append(ValidationIssue(q.get("questionId"), "structured_note_completion item must not carry matching/mc3 keys"))
        note = q.get("note") or {}
        fill = (note.get("correctFill") or "").strip()
        if len(fill) < 2:
            issues.append(ValidationIssue(q.get("questionId"), "correctFill is too short (guards against single-token answers)"))
        if fill:
            seen_fills.append(fill.lower())

    if len(seen_fills) != len(set(seen_fills)):
        issues.append(ValidationIssue(None, "duplicate correctFill answers across fields"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


VALIDATORS: dict[str, Callable[[PartBlueprint, dict[str, Any]], list[ValidationIssue]]] = {
    "speaker_statement_matching": validate_speaker_statement_matching,
    "sentence_completion_mc3": validate_sentence_completion_mc3,
    "structured_note_completion": validate_structured_note_completion,
}


def validate_content(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    validator = VALIDATORS.get(part.task_type)
    if validator is None:
        return [ValidationIssue(None, f"no validator registered for task_type {part.task_type!r}")]
    return validator(part, content)


def hard_issues(issues: list[ValidationIssue]) -> list[ValidationIssue]:
    return [i for i in issues if i.hard]
