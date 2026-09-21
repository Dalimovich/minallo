"""Shared German Exam Engine — deterministic, pre-TTS content validation.

Dispatched by `task_type` (not `profile_id`), so a future exam family
reusing e.g. `sentence_completion_mc3` gets this validator for free.

Each validator returns a list of `ValidationIssue`s — empty means the part
passed. `german_exam_listening.py` (and later module adapters) use this list
to drive the bounded per-item repair loop; a non-empty list is never
silently accepted.

Only structural/deterministic checks live here — "is the shape right, do
ids resolve, are counts exact." Whether the CONTENT is actually defensible
(is the correct answer really supported by the transcript, is a distractor
plausible rather than absurd, are two options both arguably correct) is
judged by `german_exam_semantic_verify.py`, which always runs AFTER this
validator passes — see `german_exam_listening.py`'s generation pipeline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from .german_exams import PartBlueprint
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


def _check_evidence_segment_ids(
    questions: list[dict[str, Any]], segments: list[dict[str, Any]], payload_key: str, *, allow_empty: bool = False
) -> list[ValidationIssue]:
    """Every objective item must point at real segment id(s) it's supported
    by — this is what Replay evidence, transcript highlighting, and the
    semantic verifier all key off. `allow_empty` is only true for HV1's
    distractor items, which have no single speaker to point at."""
    valid_ids = {s.get("id") for s in segments if s.get("id")}
    issues: list[ValidationIssue] = []
    for q in questions:
        payload = q.get(payload_key) or {}
        ev_ids = payload.get("evidenceSegmentIds")
        if ev_ids is not None and (not isinstance(ev_ids, list) or any(not isinstance(sid, str) for sid in ev_ids)):
            issues.append(ValidationIssue(q.get("questionId"), "evidenceSegmentIds must be a list of strings"))
            continue
        if not ev_ids:
            if allow_empty and payload.get("isDistractor"):
                continue
            issues.append(ValidationIssue(q.get("questionId"), "evidenceSegmentIds is missing or empty"))
            continue
        unknown = [sid for sid in ev_ids if sid not in valid_ids]
        if unknown:
            issues.append(ValidationIssue(q.get("questionId"), f"evidenceSegmentIds references unknown segment id(s): {unknown}"))
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
    issues.extend(_check_evidence_segment_ids(questions, segments, "matching", allow_empty=True))
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
    issues.extend(_check_evidence_segment_ids(questions, segments, "mc3"))
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
    issues.extend(_check_evidence_segment_ids(questions, segments, "note"))
    return issues


def validate_text_reconstruction_sentence_matching(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    text = content.get("text") or {}
    gaps = text.get("gaps") if isinstance(text, dict) else None
    candidates = content.get("candidates") or []
    questions = content.get("questions") or []

    gap_count = part.constraints.get("gapCount", 6)
    candidate_count = part.constraints.get("candidateCount", 8)
    unused_count = part.constraints.get("unusedCandidates", 2)

    if not isinstance(gaps, list) or len(gaps) != gap_count:
        issues.append(ValidationIssue(None, f"expected {gap_count} gaps, got {len(gaps) if isinstance(gaps, list) else 0}"))
        gap_ids: set[str] = set()
    else:
        gap_ids = {g.get("gapId") for g in gaps if isinstance(g, dict) and g.get("gapId")}
        if len(gap_ids) != len(gaps):
            issues.append(ValidationIssue(None, "duplicate or missing gapId across gaps"))

    if len(candidates) != candidate_count:
        issues.append(ValidationIssue(None, f"expected {candidate_count} candidates, got {len(candidates)}"))
    candidate_ids = {c.get("candidateId") for c in candidates if isinstance(c, dict) and c.get("candidateId")}
    if len(candidate_ids) != len(candidates):
        issues.append(ValidationIssue(None, "duplicate or missing candidateId across candidates"))
    candidate_texts = [((c.get("text") or "").strip().lower()) for c in candidates if isinstance(c, dict)]
    if len({t for t in candidate_texts if t}) != len([t for t in candidate_texts if t]):
        issues.append(ValidationIssue(None, "duplicate candidate text across candidates"))

    if len(questions) != gap_count:
        issues.append(ValidationIssue(None, f"expected {gap_count} gap-mapping questions, got {len(questions)}"))

    mapped_gaps: list[str] = []
    used_candidates: list[str] = []
    for q in questions:
        gap_id = q.get("gapId")
        correct = q.get("correctCandidateId")
        if not gap_id or gap_ids and gap_id not in gap_ids:
            issues.append(ValidationIssue(q.get("questionId"), "gapId is missing or does not resolve to a real gap"))
        else:
            mapped_gaps.append(gap_id)
        if not correct or (candidate_ids and correct not in candidate_ids):
            issues.append(ValidationIssue(q.get("questionId"), "correctCandidateId is missing or unknown"))
        else:
            used_candidates.append(correct)

    if len(mapped_gaps) != len(set(mapped_gaps)):
        issues.append(ValidationIssue(None, "a gap is mapped by more than one question"))
    if gap_ids and set(mapped_gaps) != gap_ids:
        issues.append(ValidationIssue(None, "not every gap has exactly one mapping"))
    if len(used_candidates) != len(set(used_candidates)):
        issues.append(ValidationIssue(None, "a candidate is used for more than one gap"))
    unused = candidate_ids - set(used_candidates) if candidate_ids else set()
    if candidate_ids and len(unused) != unused_count:
        issues.append(ValidationIssue(None, f"expected {unused_count} unused candidates, got {len(unused)}"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


def validate_section_statement_matching(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    sections = content.get("sections") or []
    questions = content.get("questions") or []

    section_count = part.constraints.get("sectionCount", 5)
    statement_count = part.constraints.get("statementCount", 6)

    if len(sections) != section_count:
        issues.append(ValidationIssue(None, f"expected {section_count} sections, got {len(sections)}"))
    section_ids = {s.get("sectionId") for s in sections if isinstance(s, dict) and s.get("sectionId")}
    if len(section_ids) != len(sections):
        issues.append(ValidationIssue(None, "duplicate or missing sectionId across sections"))

    if len(questions) != statement_count:
        issues.append(ValidationIssue(None, f"expected {statement_count} statements, got {len(questions)}"))

    for q in questions:
        correct = q.get("correctSectionId")
        if not correct or (section_ids and correct not in section_ids):
            issues.append(ValidationIssue(q.get("questionId"), "correctSectionId is missing or unknown"))
        if not (q.get("statement") or "").strip():
            issues.append(ValidationIssue(q.get("questionId"), "statement is empty"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


_TRISTATE_ANSWERS = {"richtig", "falsch", "nicht_im_text"}


def validate_detail_tristate_with_global_heading(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    questions = content.get("questions") or []

    detail_count = part.constraints.get("detailItemCount", 11)
    heading_item_count = part.constraints.get("globalHeadingItemCount", 1)
    heading_option_count = part.constraints.get("globalHeadingOptionCount", 3)

    details = [q for q in questions if q.get("kind") == "detail"]
    headings = [q for q in questions if q.get("kind") == "global_heading"]
    other_kinds = [q for q in questions if q.get("kind") not in ("detail", "global_heading")]

    if other_kinds:
        issues.append(ValidationIssue(None, f"unknown question kind(s): {[q.get('kind') for q in other_kinds]}"))
    if len(details) != detail_count:
        issues.append(ValidationIssue(None, f"expected {detail_count} detail items, got {len(details)}"))
    if len(headings) != heading_item_count:
        issues.append(ValidationIssue(None, f"expected {heading_item_count} global-heading item(s), got {len(headings)}"))

    for q in details:
        tristate = q.get("tristate") or {}
        answer = tristate.get("answer")
        if answer not in _TRISTATE_ANSWERS:
            issues.append(ValidationIssue(q.get("questionId"), f"tristate.answer must be one of {sorted(_TRISTATE_ANSWERS)}"))
            continue
        evidence = tristate.get("evidenceParagraphIds")
        if not isinstance(evidence, list) or any(not isinstance(e, str) for e in evidence):
            issues.append(ValidationIssue(q.get("questionId"), "tristate.evidenceParagraphIds must be a list of strings"))
        elif not evidence and answer != "nicht_im_text":
            issues.append(ValidationIssue(q.get("questionId"), "evidenceParagraphIds is required unless answer is nicht_im_text"))

    for q in headings:
        heading = q.get("heading") or {}
        options = heading.get("options") or []
        if len(options) != heading_option_count:
            issues.append(ValidationIssue(q.get("questionId"), f"expected {heading_option_count} heading options, got {len(options)}"))
        option_ids = {o.get("headingId") for o in options if isinstance(o, dict) and o.get("headingId")}
        if len(option_ids) != len(options):
            issues.append(ValidationIssue(q.get("questionId"), "duplicate or missing headingId across options"))
        correct = heading.get("correctHeadingId")
        if not correct or (option_ids and correct not in option_ids):
            issues.append(ValidationIssue(q.get("questionId"), "correctHeadingId is missing or unknown"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


_LANGUAGE_ELEMENT_CATEGORIES = {"grammar", "lexicon", "orthography"}


def validate_cloze_mc4_language_elements(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """telc-style Sprachbausteine: one continuous text with N numbered gaps
    (marked inline as the literal placeholder "{{gapId}}", same convention as
    text_reconstruction_sentence_matching), each gap answered by exactly one
    four-option MC item. Unlike Lesen 1, options are plain per-item strings
    (like sentence_completion_mc3), not a shared candidates pool — there is
    no bijection to enforce across items, only per-item option validity plus
    the official grammar/lexicon/orthography category-range split."""
    issues: list[ValidationIssue] = []
    text = content.get("text") or {}
    gaps = text.get("gaps") if isinstance(text, dict) else None
    questions = content.get("questions") or []

    item_count = part.constraints.get("itemCount", 22)
    option_count = part.constraints.get("optionCount", 4)
    word_min = part.constraints.get("wordCountMin", 320)
    word_max = part.constraints.get("wordCountMax", 350)

    if not isinstance(gaps, list) or len(gaps) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} gaps, got {len(gaps) if isinstance(gaps, list) else 0}"))
        gap_ids: set[str] = set()
    else:
        gap_ids = {g.get("gapId") for g in gaps if isinstance(g, dict) and g.get("gapId")}
        if len(gap_ids) != len(gaps):
            issues.append(ValidationIssue(None, "duplicate or missing gapId across gaps"))

    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if isinstance(paragraphs, list):
        word_count = sum(len(str(p).split()) for p in paragraphs)
        if not (word_min <= word_count <= word_max):
            issues.append(ValidationIssue(None, f"expected {word_min}-{word_max} words, got {word_count}"))
    else:
        issues.append(ValidationIssue(None, "text.paragraphs must be a list"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items, got {len(questions)}"))

    mapped_gaps: list[str] = []
    category_counts: dict[str, int] = {}
    for q in questions:
        gap_id = q.get("gapId")
        if not gap_id or (gap_ids and gap_id not in gap_ids):
            issues.append(ValidationIssue(q.get("questionId"), "gapId is missing or does not resolve to a real gap"))
        else:
            mapped_gaps.append(gap_id)

        options = q.get("options") or []
        if len(options) != option_count:
            issues.append(ValidationIssue(q.get("questionId"), f"expected {option_count} options, got {len(options)}"))
        category = q.get("category")
        # Orthography options may differ only by capitalization (Allgemeinen / allgemeinen): the
        # contrast IS the item. Grammar/lexicon stay case-insensitive.
        option_key = (lambda o: " ".join(o.split())) if category == "orthography" else (lambda o: o.strip().lower())
        if len({option_key(o) for o in options if isinstance(o, str)}) != len(options):
            issues.append(ValidationIssue(q.get("questionId"), "duplicate options within one item"))
        correct_index = q.get("correctIndex")
        if not isinstance(correct_index, int) or not (0 <= correct_index < max(1, option_count)):
            issues.append(ValidationIssue(q.get("questionId"), "correctIndex missing or out of range"))

        category = q.get("category")
        if category not in _LANGUAGE_ELEMENT_CATEGORIES:
            issues.append(ValidationIssue(q.get("questionId"), f"category must be one of {sorted(_LANGUAGE_ELEMENT_CATEGORIES)}"))
        else:
            category_counts[category] = category_counts.get(category, 0) + 1

    if len(mapped_gaps) != len(set(mapped_gaps)):
        issues.append(ValidationIssue(None, "a gap is answered by more than one item"))
    if gap_ids and set(mapped_gaps) != gap_ids:
        issues.append(ValidationIssue(None, "not every gap has exactly one item"))

    grammar_min = part.constraints.get("grammarCountMin", 12)
    grammar_max = part.constraints.get("grammarCountMax", 16)
    lexical_min = part.constraints.get("lexicalCountMin", 4)
    lexical_max = part.constraints.get("lexicalCountMax", 8)
    ortho_min = part.constraints.get("orthographyCountMin", 1)
    ortho_max = part.constraints.get("orthographyCountMax", 4)
    grammar_n = category_counts.get("grammar", 0)
    lexical_n = category_counts.get("lexicon", 0)
    ortho_n = category_counts.get("orthography", 0)
    if not (grammar_min <= grammar_n <= grammar_max):
        issues.append(ValidationIssue(None, f"expected {grammar_min}-{grammar_max} grammar items, got {grammar_n}"))
    if not (lexical_min <= lexical_n <= lexical_max):
        issues.append(ValidationIssue(None, f"expected {lexical_min}-{lexical_max} lexicon items, got {lexical_n}"))
    if not (ortho_min <= ortho_n <= ortho_max):
        issues.append(ValidationIssue(None, f"expected {ortho_min}-{ortho_max} orthography items, got {ortho_n}"))
    if grammar_n + lexical_n + ortho_n != item_count:
        issues.append(ValidationIssue(None, f"category counts must sum to {item_count}"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


# telc C1 Hochschule Schreiben topics realistically frame as one of these —
# mirrors (a controlled subset of) writing_coach.ALLOWED_TASK_TYPES so a
# generated topic's writingCoachTaskType is guaranteed valid input to
# analyse_writing() at grading time (see german_exam_writing_grading.py).
# Deliberately narrower than the full Writing Coach vocabulary: "email" /
# "zusammenfassung" / "bericht" / "motivationsschreiben" aren't realistic
# framings for this exam's academic/study-related Schreiben topics.
TELC_SCHREIBEN_TASK_TYPES = frozenset({"stellungnahme", "argumentation", "freier_text"})
_MIN_TASK_INSTRUCTION_CHARS = 40


def validate_choice_long_form_writing(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """telc-style Schreiben: exactly 2 generated topics (as `questions`, the
    generic per-part item array every task type uses), no answer key —
    grading happens separately, on the learner's own submitted text (see
    german_exam_writing_grading.py), never against this generated content.
    Only structural well-formedness and a HARD (identical-text) duplicate
    guard live here; genuine near-duplicate/answerability/register judgment
    is german_exam_semantic_verify.py's job, run against this same content
    after this validator passes."""
    issues: list[ValidationIssue] = []
    questions = content.get("questions") or []
    topic_count = part.constraints.get("topicChoiceCount", 2)

    if len(questions) != topic_count:
        issues.append(ValidationIssue(None, f"expected {topic_count} topics, got {len(questions)}"))

    if set(content) - {"questions"}:
        issues.append(ValidationIssue(None, "writing content must contain only topics, never an answer key or model solution"))
    seen_titles: list[str] = []
    seen_instructions: list[str] = []
    for q in questions:
        if set(q) - {"questionId", "title", "statements", "communicativeSituation", "taskInstructions", "writingCoachTaskType"}:
            issues.append(ValidationIssue(q.get("questionId"), "unexpected topic fields: no answer key or model solution is allowed"))
        title = (q.get("title") or "").strip()
        situation = (q.get("communicativeSituation") or "").strip()
        instructions = (q.get("taskInstructions") or "").strip()
        task_type = q.get("writingCoachTaskType")
        statements = q.get("statements")
        if (not isinstance(statements, list) or len(statements) != 2 or
                any(not isinstance(s, str) or not s.strip() for s in statements)):
            issues.append(ValidationIssue(q.get("questionId"), "exactly 2 nonempty statements are required"))
        else:
            if len({" ".join(s.casefold().split()).strip(".!? ") for s in statements}) != 2:
                issues.append(ValidationIssue(q.get("questionId"), "duplicate statements"))
            words = len(" ".join([*statements, situation, instructions]).split())
            if not part.constraints["inputWordCountMin"] <= words <= part.constraints["inputWordCountMax"]:
                issues.append(ValidationIssue(q.get("questionId"), f"topic input must have 45–55 words, got {words}"))

        if not title:
            issues.append(ValidationIssue(q.get("questionId"), "title is missing or empty"))
        if not situation:
            issues.append(ValidationIssue(q.get("questionId"), "communicativeSituation is missing or empty"))
        if len(instructions) < _MIN_TASK_INSTRUCTION_CHARS:
            issues.append(ValidationIssue(q.get("questionId"), f"taskInstructions is missing or too short (min {_MIN_TASK_INSTRUCTION_CHARS} chars)"))
        if task_type not in TELC_SCHREIBEN_TASK_TYPES:
            issues.append(ValidationIssue(q.get("questionId"), f"writingCoachTaskType must be one of {sorted(TELC_SCHREIBEN_TASK_TYPES)}"))

        if title:
            seen_titles.append(title.lower())
        if instructions:
            seen_instructions.append(instructions.lower())

    if len(seen_titles) != len(set(seen_titles)):
        issues.append(ValidationIssue(None, "two topics have identical titles — they must be genuinely distinct"))
    if len(seen_instructions) != len(set(seen_instructions)):
        issues.append(ValidationIssue(None, "two topics have identical taskInstructions — they must be genuinely distinct"))

    return issues


def validate_speaking(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues = []
    def nonempty(value):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= 2000
    if part.task_type == "presentation_summary_followup":
        topics = content.get("questions")
        if not isinstance(topics, list) or len(topics) != 2:
            return [ValidationIssue(None, "exactly two presentation topics required")]
        for q in topics:
            if (not isinstance(q, dict) or set(q) != {"questionId", "title", "taskInstructions"}
                    or not all(nonempty(q.get(k)) for k in ("questionId", "title", "taskInstructions"))):
                issues.append(ValidationIssue(None, "malformed presentation topic"))
        if not issues and (len({q["title"].strip().casefold() for q in topics}) != 2 or
                           len({q["taskInstructions"].strip().casefold() for q in topics}) != 2):
            issues.append(ValidationIssue(None, "presentation choices must be distinct"))
        if set(content) != {"questions"}:
            issues.append(ValidationIssue(None, "unexpected presentation fields; no solutions allowed"))
    else:
        if set(content) != {"quote", "sourceLabel", "guidingPoints"}:
            issues.append(ValidationIssue(None, "discussion requires quote, sourceLabel and guidingPoints only"))
        if not nonempty(content.get("quote")) or content.get("sourceLabel") != "Generiertes Übungszitat (keine reale Quelle)":
            issues.append(ValidationIssue(None, "quote must be explicitly labelled generated practice material"))
        from .german_exam_speaking import DISCUSSION_GUIDING_POINTS
        if content.get("guidingPoints") != DISCUSSION_GUIDING_POINTS:
            issues.append(ValidationIssue(None, "use the standardized four discussion guiding points"))
    return issues


def _normalized_words(text: str) -> list[str]:
    return re.findall(r"[\wäöüÄÖÜß]+", text.lower())


def _copied_run(option: str, article_words: list[str], run: int) -> bool:
    """True if `option` reproduces `run` consecutive words of the article (a phrase-copy answer)."""
    words = _normalized_words(option)
    if len(words) < run:
        return False
    grams = {tuple(article_words[i:i + run]) for i in range(len(article_words) - run + 1)}
    return any(tuple(words[i:i + run]) in grams for i in range(len(words) - run + 1))


def validate_reading_multiple_choice(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """One informational article + N multiple-choice comprehension items.

    Generic: counts, option count, text order and length all come from the blueprint."""
    issues: list[ValidationIssue] = []
    text = content.get("text")
    questions = content.get("questions") or []
    item_count = part.constraints["itemCount"]
    option_count = part.constraints["optionCount"]

    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    para_ids: list[str] = []
    article_words: list[str] = []
    if not isinstance(paragraphs, list) or not paragraphs:
        issues.append(ValidationIssue(None, "text.paragraphs must be a non-empty list"))
    else:
        for p in paragraphs:
            pid = p.get("paragraphId") if isinstance(p, dict) else None
            body = p.get("text") if isinstance(p, dict) else None
            if not isinstance(pid, str) or not pid.strip() or not isinstance(body, str) or not body.strip():
                issues.append(ValidationIssue(None, "every paragraph needs a paragraphId and non-empty text"))
                continue
            para_ids.append(pid)
            article_words.extend(_normalized_words(body))
        if len(set(para_ids)) != len(para_ids):
            issues.append(ValidationIssue(None, "duplicate paragraphId"))
        expected_paragraphs = part.constraints["generationParagraphCount"]
        if para_ids != [f"p{i}" for i in range(1, expected_paragraphs + 1)]:
            issues.append(ValidationIssue(None, "paragraph IDs must match the configured numbered paragraph sequence"))
        count = sum(len(p["text"].split()) for p in paragraphs if isinstance(p, dict) and isinstance(p.get("text"), str))
        low, high = part.constraints["generationWordCountMin"], part.constraints["generationWordCountMax"]
        if not low <= count <= high:
            issues.append(ValidationIssue(None, f"article has {count} words, practice target is {low}-{high}"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items, got {len(questions)}"))

    stems: list[str] = []
    previous_first = -1
    order_broken = False
    for index, q in enumerate(questions):
        qid = q.get("questionId")
        mc3 = q.get("mc3") or {}
        if qid != f"q{index + 1}":
            issues.append(ValidationIssue(None, "question IDs must be sequential q1..qN"))
        if not isinstance(mc3, dict):
            issues.append(ValidationIssue(qid, "mc3 must be an object"))
            continue
        stem = mc3.get("stem")
        options = mc3.get("options")
        if not isinstance(stem, str) or not stem.strip():
            issues.append(ValidationIssue(qid, "mc3.stem is missing"))
        else:
            stems.append(stem.strip().lower())
        if not isinstance(options, list) or len(options) != option_count or any(not isinstance(o, str) or not o.strip() for o in options):
            issues.append(ValidationIssue(qid, f"expected {option_count} non-empty options"))
            continue
        if len({o.strip().lower() for o in options}) != len(options):
            issues.append(ValidationIssue(qid, "duplicate options within one item"))
        correct = mc3.get("correctIndex")
        if not isinstance(correct, int) or isinstance(correct, bool) or not 0 <= correct < option_count:
            issues.append(ValidationIssue(qid, "correctIndex missing or out of range"))
        elif article_words and _copied_run(options[correct], article_words, 7):
            issues.append(ValidationIssue(qid, "correct option copies 7+ consecutive words of the article; it must be a paraphrase"))
        evidence = mc3.get("evidenceParagraphIds")
        if not isinstance(evidence, list) or not evidence or any(e not in para_ids for e in evidence):
            issues.append(ValidationIssue(qid, "evidenceParagraphIds must list real paragraph ids"))
        else:
            scopes = part.constraints["questionScopes"]
            scope = scopes[index] if index < len(scopes) else None
            expected = para_ids if scope == "global" else [scope]
            if evidence != expected:
                issues.append(ValidationIssue(qid, f"evidenceParagraphIds must match scope {scope}"))
        if isinstance(evidence, list) and evidence and all(e in para_ids for e in evidence) and part.constraints.get("itemsFollowTextOrder") and index < len(part.constraints["questionScopes"]) and part.constraints["questionScopes"][index] != "global":
            first = min(para_ids.index(e) for e in evidence)
            if first < previous_first:
                order_broken = True
            previous_first = max(previous_first, first)
    if order_broken:
        issues.append(ValidationIssue(None, "items must follow the order of the article (evidence paragraphs must not move backwards)"))
    if len(set(stems)) != len(stems):
        issues.append(ValidationIssue(None, "two items ask the same question"))

    for q in questions:
        if any(tag not in part.allowed_skill_tags for tag in q.get("skillTags") or []):
            issues.append(ValidationIssue(q.get("questionId"), "skill tag not allowed by blueprint"))
    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


VALIDATORS: dict[str, Callable[[PartBlueprint, dict[str, Any]], list[ValidationIssue]]] = {
    "presentation_summary_followup": validate_speaking,
    "quote_guided_discussion": validate_speaking,
    "reading_multiple_choice": validate_reading_multiple_choice,
    "speaker_statement_matching": validate_speaker_statement_matching,
    "sentence_completion_mc3": validate_sentence_completion_mc3,
    "structured_note_completion": validate_structured_note_completion,
    "text_reconstruction_sentence_matching": validate_text_reconstruction_sentence_matching,
    "section_statement_matching": validate_section_statement_matching,
    "detail_tristate_with_global_heading": validate_detail_tristate_with_global_heading,
    "cloze_mc4_language_elements": validate_cloze_mc4_language_elements,
    "choice_long_form_writing": validate_choice_long_form_writing,
}

# Reading task types don't carry a top-level "segments" array (they have
# "text"/"candidates"/"sections" instead) — the generic pre-check below only
# applies to listening, whose validators all assume "segments" exists.
_SEGMENTS_REQUIRED_TASK_TYPES = frozenset(
    {"speaker_statement_matching", "sentence_completion_mc3", "structured_note_completion"}
)


def validate_content(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    from .german_exam_productive import WRITING_TYPES, SPEAKING_TYPES, validate_productive
    if part.task_type in WRITING_TYPES | SPEAKING_TYPES:
        try:
            validate_productive(part, content)
            return []
        except (ValueError, TypeError, AttributeError, KeyError) as exc:
            return [ValidationIssue(None, str(exc))]
    from .german_exam_media_tasks import MEDIA_TASKS, validate_media_task
    if part.task_type in MEDIA_TASKS:
        try:
            validate_media_task(part, content)
            return []
        except (ValueError, TypeError, AttributeError, KeyError) as exc:
            return [ValidationIssue(None, str(exc))]
    from .german_exam_objective import SELECTION_TYPES, validate_selection
    if part.task_type in SELECTION_TYPES:
        try:
            validate_selection(part, content)
            return []
        except (ValueError, TypeError, AttributeError, KeyError) as exc:
            return [ValidationIssue(None, str(exc))]
    if part.task_type == "quote_guided_discussion":
        return validate_speaking(part, content)
    generic_keys = [("questions", "questionId")]
    if part.task_type in _SEGMENTS_REQUIRED_TASK_TYPES:
        generic_keys.insert(0, ("segments", "id"))
    for key, id_key in generic_keys:
        rows = content.get(key)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            return [ValidationIssue(None, f"{key} must be an array of objects")]
        ids = [row.get(id_key) for row in rows]
        if any(not isinstance(value, str) or not value.strip() for value in ids):
            return [ValidationIssue(None, f"{id_key} must be a nonempty string")]
        if len(ids) != len(set(ids)):
            return [ValidationIssue(None, f"duplicate {id_key}")]
    validator = VALIDATORS.get(part.task_type)
    if validator is None:
        return [ValidationIssue(None, f"no validator registered for task_type {part.task_type!r}")]
    try:
        return validator(part, content)
    except (TypeError, AttributeError, ValueError):
        return [ValidationIssue(None, "malformed task payload")]


def hard_issues(issues: list[ValidationIssue]) -> list[ValidationIssue]:
    return [i for i in issues if i.hard]
