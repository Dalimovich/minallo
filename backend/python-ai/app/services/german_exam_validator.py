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


def validate_multi_source_statement_matching(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """Several spoken sources (e.g. Goethe Hören Teil 1: three reviews) + N written statements, each
    matching exactly one source or (if the blueprint allows it) none. Unlike speaker_statement_matching
    this is NOT a bijection — a source may legitimately be the answer to more than one statement, and
    unmatchedStatements defaults to 0 (every statement matches a source) rather than a fixed 2. Reuses
    the same `matching.correctSpeakerId` / `matching.isDistractor` shape so the shared semantic-verify
    audit (built for speaker_statement_matching) applies unchanged."""
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []

    source_count = part.constraints.get("sourceCount", 3)
    statement_count = part.constraints.get("statementCount", 6)
    unmatched_expected = part.constraints.get("unmatchedStatements", 0)

    if len(segments) != source_count:
        issues.append(ValidationIssue(None, f"expected {source_count} source segments, got {len(segments)}"))
    source_ids = [s.get("speakerId") for s in segments]
    if len(set(source_ids)) != len(source_ids):
        issues.append(ValidationIssue(None, "duplicate speakerId across source segments"))
    for s in segments:
        if not (s.get("spokenText") or "").strip():
            issues.append(ValidationIssue(s.get("id"), "segment spokenText is empty"))

    if len(questions) != statement_count:
        issues.append(ValidationIssue(None, f"expected {statement_count} statements, got {len(questions)}"))

    mapped_sources: list[str] = []
    distractor_count = 0
    statements: list[str] = []
    for q in questions:
        statement = q.get("statement")
        if not isinstance(statement, str) or not statement.strip():
            issues.append(ValidationIssue(q.get("questionId"), "statement is empty"))
        else:
            statements.append(statement.strip().lower())
        matching = q.get("matching") or {}
        if matching.get("isDistractor"):
            distractor_count += 1
            if matching.get("correctSpeakerId"):
                issues.append(ValidationIssue(q.get("questionId"), "distractor item must not carry correctSpeakerId"))
            continue
        correct = matching.get("correctSpeakerId")
        if not correct or correct not in set(source_ids):
            issues.append(ValidationIssue(q.get("questionId"), "correctSpeakerId is missing or unknown"))
            continue
        mapped_sources.append(correct)

    if distractor_count != unmatched_expected:
        issues.append(ValidationIssue(None, f"expected {unmatched_expected} unmatched statements, got {distractor_count}"))
    if len(set(statements)) != len(statements):
        issues.append(ValidationIssue(None, "duplicate statements"))
    if questions and unmatched_expected == 0 and set(mapped_sources) != set(source_ids) and len(segments) == source_count:
        issues.append(ValidationIssue(None, "every source must be the answer to at least one statement"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    issues.extend(_check_evidence_segment_ids(questions, segments, "matching", allow_empty=True))
    return issues


_LISTENING_TRISTATE_ANSWERS = {"richtig", "falsch", "nicht_im_text"}


def validate_listening_tristate(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """One extended audio (e.g. Goethe Hören Teil 2: an interview) + N tristate items — each item's
    stated proposition is either supported (richtig), contradicted (falsch), or simply absent
    (nicht_im_text) in the audio. No global-heading item (unlike detail_tristate_with_global_heading,
    which is reading-only and carries one); itemCount/answerOptions come from the blueprint."""
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []
    item_count = part.constraints.get("itemCount", 9)

    if len(segments) < 1:
        issues.append(ValidationIssue(None, "expected at least 1 audio segment"))
    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items, got {len(questions)}"))

    statements: list[str] = []
    for q in questions:
        statement = q.get("statement")
        if not isinstance(statement, str) or not statement.strip():
            issues.append(ValidationIssue(q.get("questionId"), "statement is empty"))
        else:
            statements.append(statement.strip().lower())
        tristate = q.get("tristate") or {}
        answer = tristate.get("answer")
        if answer not in _LISTENING_TRISTATE_ANSWERS:
            issues.append(ValidationIssue(q.get("questionId"), f"tristate.answer must be one of {sorted(_LISTENING_TRISTATE_ANSWERS)}"))
            continue
        evidence = tristate.get("evidenceSegmentIds")
        valid_segment_ids = {s.get("id") for s in segments if s.get("id")}
        if not isinstance(evidence, list) or any(not isinstance(e, str) for e in evidence):
            issues.append(ValidationIssue(q.get("questionId"), "tristate.evidenceSegmentIds must be a list of strings"))
        elif not evidence and answer != "nicht_im_text":
            issues.append(ValidationIssue(q.get("questionId"), "evidenceSegmentIds is required unless answer is nicht_im_text"))
        elif evidence and any(e not in valid_segment_ids for e in evidence):
            issues.append(ValidationIssue(q.get("questionId"), "evidenceSegmentIds references unknown segment id(s)"))

    if len(set(statements)) != len(statements):
        issues.append(ValidationIssue(None, "duplicate statements"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


def validate_segmented_dialogue_mc3(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """A dialogue split into named sections (e.g. Goethe Hören Teil 3: four sections, three speakers)
    with exactly `itemsPerSection` three-option comprehension items PER section. Shares the mc3 item
    shape with sentence_completion_mc3 but additionally enforces the per-section item balance, keyed by
    each question's own `sectionId`."""
    issues: list[ValidationIssue] = []
    segments = content.get("segments") or []
    questions = content.get("questions") or []

    section_count = part.constraints.get("sectionCount", 4)
    items_per_section = part.constraints.get("itemsPerSection", 2)
    option_count = part.constraints.get("optionCount", 3)
    speaker_count = part.constraints.get("speakerCount", 3)
    item_count = section_count * items_per_section

    if len(segments) < 1:
        issues.append(ValidationIssue(None, "expected at least 1 dialogue segment"))
    speaker_ids = {s.get("speakerId") for s in segments if s.get("speakerId")}
    if len(speaker_ids) != speaker_count:
        issues.append(ValidationIssue(None, f"expected {speaker_count} distinct speakers, got {len(speaker_ids)}"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items ({section_count} sections x {items_per_section}), got {len(questions)}"))

    per_section: dict[str, int] = {}
    for q in questions:
        section_id = q.get("sectionId")
        if not isinstance(section_id, str) or not section_id.strip():
            issues.append(ValidationIssue(q.get("questionId"), "sectionId is missing"))
        else:
            per_section[section_id] = per_section.get(section_id, 0) + 1
        mc3 = q.get("mc3") or {}
        options = mc3.get("options") or []
        if len(options) != option_count:
            issues.append(ValidationIssue(q.get("questionId"), f"expected {option_count} options, got {len(options)}"))
        if len({o.strip().lower() for o in options if isinstance(o, str)}) != len(options):
            issues.append(ValidationIssue(q.get("questionId"), "duplicate options within one item"))
        correct_index = mc3.get("correctIndex")
        if not isinstance(correct_index, int) or not (0 <= correct_index < max(1, option_count)):
            issues.append(ValidationIssue(q.get("questionId"), "correctIndex missing or out of range"))

    if len(per_section) != section_count:
        issues.append(ValidationIssue(None, f"expected {section_count} distinct sectionIds, got {len(per_section)}"))
    uneven = [sid for sid, n in per_section.items() if n != items_per_section]
    if uneven:
        issues.append(ValidationIssue(None, f"expected exactly {items_per_section} items per section; unbalanced: {uneven}"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    issues.extend(_check_evidence_segment_ids(questions, segments, "mc3"))
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

    if part.constraints.get("strictPlaceholders"):
        issues.extend(_check_reconstruction_integrity(part, text, gap_ids, candidates))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")
_PLACEHOLDER_NAME = re.compile(
    r"\b(?:XYZ|ABC[- ]?(?:GmbH|AG)|Mustermann|Musterfirma|Musterstadt|Beispiel(?:firma|stadt|GmbH)|Lorem ipsum|Firma [A-Z]{1,3})\b"
)
_SENTENCE_BREAK = re.compile(r"\w{3,}[.!?][\"”“)]?\s+[A-ZÄÖÜ]")


def _check_reconstruction_integrity(
    part: PartBlueprint, text: Any, gap_ids: set[str], candidates: list[Any]
) -> list[ValidationIssue]:
    """Placeholder / length / candidate-shape checks for blueprints that opt in with
    `strictPlaceholders` (Goethe). All findings are part-level: a broken gap layout or candidate
    list cannot be repaired one question at a time, so the caller regenerates."""
    issues: list[ValidationIssue] = []
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list) or not paragraphs or any(not isinstance(p, str) or not p.strip() for p in paragraphs):
        return [ValidationIssue(None, "text.paragraphs must be a non-empty list of non-empty strings")]
    joined = "\n".join(paragraphs)

    found = _PLACEHOLDER.findall(joined)
    for gap_id in sorted(gap_ids):
        n = found.count(gap_id)
        if n != 1:
            issues.append(ValidationIssue(None, f"placeholder {{{{{gap_id}}}}} must appear exactly once in the text, found {n}"))
    unknown = sorted({g for g in found if g not in gap_ids})
    if unknown:
        issues.append(ValidationIssue(None, f"text contains placeholders that are not declared gaps: {unknown}"))
    if re.search(r"\}\}\s*\{\{", joined):
        issues.append(ValidationIssue(None, "two gaps are adjacent — every gap needs text around it"))

    approx = part.constraints.get("wordCountApprox")
    if approx:
        words = len(_PLACEHOLDER.sub(" ", joined).split())
        low, high = round(approx * 0.75), round(approx * 1.25)
        if not low <= words <= high:
            issues.append(ValidationIssue(None, f"gapped text has {words} words, expected about {approx} ({low}-{high})"))

    # Filler names an LLM invents when it has no real example ("Firma XYZ", "Max Mustermann"): never
    # acceptable in an exam text — the item would read as a template.
    everything = joined + " " + " ".join(str(c.get("text", "")) for c in candidates if isinstance(c, dict))
    m = _PLACEHOLDER_NAME.search(everything)
    if m:
        issues.append(ValidationIssue(None, f"text contains a placeholder name ({m.group(0)!r}); use a concrete, plausible example"))

    flat = re.sub(r"\s+", " ", joined).lower()
    for c in candidates:
        if not isinstance(c, dict):
            continue
        cid = c.get("candidateId")
        sentence = (c.get("text") or "").strip()
        n_words = len(sentence.split())
        if not 3 <= n_words <= 45:
            issues.append(ValidationIssue(None, f"candidate {cid} has {n_words} words; a removed sentence should have 3-45"))
        if not re.search(r"[.!?][\"”“)]?$", sentence):
            issues.append(ValidationIssue(None, f"candidate {cid} is not a complete sentence (no closing punctuation)"))
        if _SENTENCE_BREAK.search(sentence):
            issues.append(ValidationIssue(None, f"candidate {cid} contains more than one sentence"))
        if sentence and re.sub(r"\s+", " ", sentence).lower() in flat:
            issues.append(ValidationIssue(None, f"candidate {cid} already appears verbatim in the text"))
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


def validate_reading_detail_mc3(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """One informational article + N three-option comprehension items (Goethe Lesen Teil 2).

    Generic: counts, option count, text order and length all come from the blueprint."""
    issues: list[ValidationIssue] = []
    text = content.get("text")
    questions = content.get("questions") or []
    item_count = part.constraints.get("itemCount", 7)
    option_count = part.constraints.get("optionCount", 3)

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
        approx = part.constraints.get("wordCountApprox")
        if approx:
            low, high = round(approx * 0.75), round(approx * 1.25)
            if not low <= len(article_words) <= high:
                issues.append(ValidationIssue(None, f"article has {len(article_words)} words, expected about {approx} ({low}-{high})"))

    if len(questions) != item_count:
        issues.append(ValidationIssue(None, f"expected {item_count} items, got {len(questions)}"))

    stems: list[str] = []
    previous_first = -1
    order_broken = False
    for q in questions:
        qid = q.get("questionId")
        mc3 = q.get("mc3") or {}
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
        elif part.constraints.get("itemsFollowTextOrder"):
            first = min(para_ids.index(e) for e in evidence)
            if first < previous_first:
                order_broken = True
            previous_first = max(previous_first, first)
    if order_broken:
        issues.append(ValidationIssue(None, "items must follow the order of the article (evidence paragraphs must not move backwards)"))
    if len(set(stems)) != len(stems):
        issues.append(ValidationIssue(None, "two items ask the same question"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues


_NONE_ANSWER = "none"


def validate_multi_author_statement_matching_with_none(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """Several short texts by different authors + N statements, each matching exactly one author or none
    (Goethe Lesen Teil 4). Generic: counts, word budget and the number of unmatched statements all come
    from the blueprint; nothing here knows which exam it is.

    Every match must carry an `evidenceQuote` that really occurs in the named author's text and in no
    other author's text, and no statement may copy a run of the source wording (it must be a paraphrase)."""
    issues: list[ValidationIssue] = []
    text = content.get("text")
    questions = content.get("questions") or []
    author_count = part.constraints.get("authorCount", 3)
    statement_count = part.constraints.get("statementCount", 7)
    unmatched_expected = part.constraints.get("unmatchedStatements", 2)

    authors = text.get("authors") if isinstance(text, dict) else None
    author_ids: list[str] = []
    author_text: dict[str, str] = {}
    author_words: dict[str, list[str]] = {}
    if not isinstance(authors, list) or not authors:
        issues.append(ValidationIssue(None, "text.authors must be a non-empty list"))
    else:
        if len(authors) != author_count:
            issues.append(ValidationIssue(None, f"expected {author_count} authors, got {len(authors)}"))
        for a in authors:
            aid = a.get("authorId") if isinstance(a, dict) else None
            name = a.get("name") if isinstance(a, dict) else None
            body = a.get("text") if isinstance(a, dict) else None
            if not isinstance(aid, str) or not aid.strip() or aid.strip().lower() == _NONE_ANSWER:
                issues.append(ValidationIssue(None, "every author needs a unique authorId (not 'none')"))
                continue
            if not isinstance(name, str) or not name.strip() or not isinstance(body, str) or not body.strip():
                issues.append(ValidationIssue(None, f"author {aid} needs a name and non-empty text"))
                continue
            author_ids.append(aid)
            author_text[aid] = " ".join(_normalized_words(body))
            author_words[aid] = _normalized_words(body)
        if len(set(author_ids)) != len(author_ids):
            issues.append(ValidationIssue(None, "duplicate authorId"))
        approx = part.constraints.get("wordCountApprox")
        total = sum(len(w) for w in author_words.values())
        if approx and not round(approx * 0.75) <= total <= round(approx * 1.25):
            issues.append(ValidationIssue(None, f"texts have {total} words in total, expected about {approx} ({round(approx * 0.75)}-{round(approx * 1.25)})"))
        for aid, words in author_words.items():
            if len(words) < 40:
                issues.append(ValidationIssue(None, f"author {aid} has only {len(words)} words; each author needs a substantial text"))

    if len(questions) != statement_count:
        issues.append(ValidationIssue(None, f"expected {statement_count} statements, got {len(questions)}"))

    valid_answers = set(author_ids) | {_NONE_ANSWER}
    counts: dict[str, int] = {}
    statements: list[str] = []
    for q in questions:
        qid = q.get("questionId")
        statement = q.get("statement")
        answer = q.get("correctAuthorId")
        if not isinstance(statement, str) or not statement.strip():
            issues.append(ValidationIssue(qid, "statement is empty"))
        else:
            statements.append(statement.strip().lower())
        if answer not in valid_answers:
            issues.append(ValidationIssue(qid, "correctAuthorId must be an author id or 'none'"))
            continue
        counts[answer] = counts.get(answer, 0) + 1
        if isinstance(statement, str):
            swords = _normalized_words(statement)
            for aid, words in author_words.items():
                if _copied_run(statement, words, 6):
                    issues.append(ValidationIssue(qid, f"statement copies 6+ consecutive words of author {aid}; it must be a paraphrase"))
                    break
        if answer == _NONE_ANSWER:
            continue
        quote = q.get("evidenceQuote")
        if not isinstance(quote, str) or not quote.strip():
            issues.append(ValidationIssue(qid, "a matched statement needs an evidenceQuote from the named author"))
            continue
        needle = " ".join(_normalized_words(quote))
        if not needle or needle not in author_text.get(answer, ""):
            issues.append(ValidationIssue(qid, f"evidenceQuote does not occur in author {answer}'s text"))
        elif any(needle in body for aid, body in author_text.items() if aid != answer):
            issues.append(ValidationIssue(qid, "evidenceQuote also occurs in another author's text (ambiguous evidence)"))

    if len(set(statements)) != len(statements):
        issues.append(ValidationIssue(None, "duplicate statements"))
    if questions and counts.get(_NONE_ANSWER, 0) != unmatched_expected:
        issues.append(ValidationIssue(None, f"expected {unmatched_expected} statements with no matching author, got {counts.get(_NONE_ANSWER, 0)}"))
    for aid in author_ids:
        if questions and counts.get(aid, 0) < 1:
            issues.append(ValidationIssue(None, f"author {aid} is not the answer to any statement"))
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


_PLACEHOLDER = re.compile(r"\{\{(g\d+)\}\}")


def validate_contextual_cloze_mc4(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """One continuous text with an already-solved example gap and N four-option gaps (Goethe Lesen Teil 1).

    Gaps are the literal placeholders {{g0}} (the example) and {{g1}}..{{gN}}, each exactly once and in
    reading order. Counts, option count and length come from the blueprint; nothing here knows the exam."""
    issues: list[ValidationIssue] = []
    text = content.get("text")
    questions = content.get("questions") or []
    example = content.get("example")
    gap_count = part.constraints.get("gapCount", 8)
    example_count = part.constraints.get("exampleGapCount", 0)
    option_count = part.constraints.get("optionCount", 4)

    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    joined = ""
    if not isinstance(paragraphs, list) or not paragraphs or any(not isinstance(p, str) or not p.strip() for p in paragraphs):
        issues.append(ValidationIssue(None, "text.paragraphs must be a non-empty list of strings"))
    else:
        joined = "\n".join(paragraphs)
        expected = ([f"g0"] if example_count else []) + [f"g{i}" for i in range(1, gap_count + 1)]
        found = _PLACEHOLDER.findall(joined)
        if found != expected:
            issues.append(ValidationIssue(None, f"gap placeholders must be exactly {expected} once each in reading order, found {found}"))
        if "{{" in _PLACEHOLDER.sub("", joined) or "}}" in _PLACEHOLDER.sub("", joined):
            issues.append(ValidationIssue(None, "malformed gap placeholder in the text"))
        approx = part.constraints.get("wordCountApprox")
        if approx:
            words = len(_PLACEHOLDER.sub("X", joined).split())
            if not round(approx * 0.8) <= words <= round(approx * 1.2):
                issues.append(ValidationIssue(None, f"text has {words} words, expected about {approx} ({round(approx * 0.8)}-{round(approx * 1.2)})"))

    def check_item(item: Any, item_id: str | None, gap_id: str) -> int | None:
        if not isinstance(item, dict):
            issues.append(ValidationIssue(item_id, "item is missing"))
            return None
        if item.get("gapId") != gap_id:
            issues.append(ValidationIssue(item_id, f"gapId must be {gap_id}"))
        options = item.get("options")
        if not isinstance(options, list) or len(options) != option_count or any(not isinstance(o, str) or not o.strip() for o in options):
            issues.append(ValidationIssue(item_id, f"expected {option_count} non-empty options"))
            return None
        if len({o.strip().lower() for o in options}) != len(options):
            issues.append(ValidationIssue(item_id, "duplicate options within one item"))
        correct = item.get("correctIndex")
        if not isinstance(correct, int) or isinstance(correct, bool) or not 0 <= correct < option_count:
            issues.append(ValidationIssue(item_id, "correctIndex missing or out of range"))
            return None
        return correct

    if example_count:
        check_item(example, "example", "g0")
    if len(questions) != gap_count:
        issues.append(ValidationIssue(None, f"expected {gap_count} gap items, got {len(questions)}"))
    keys: list[int] = []
    for i, q in enumerate(questions, start=1):
        key = check_item(q, q.get("questionId"), f"g{i}")
        if key is not None:
            keys.append(key)
    if part.constraints.get("balanceOptionPositions") and len(keys) == gap_count:
        most = max(keys.count(k) for k in set(keys))
        if most > -(-gap_count // 2):
            issues.append(ValidationIssue(None, f"the correct option sits in the same position for {most} of {gap_count} items"))

    issues.extend(_check_skill_tags(part.module, questions, "questionId"))
    return issues



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


# Goethe C1 Schreiben task types framed as one scenario a candidate must respond to (no topic choice) —
# writingCoachTaskType stays constrained to the same telc-derived vocabulary so grading (which routes
# through the shared writing_coach evaluator) always gets valid input.
_GOETHE_SCHREIBEN_TASK_TYPES = frozenset({"stellungnahme", "argumentation", "freier_text"})


def _validate_single_scenario_writing_task(
    part: PartBlueprint, content: dict[str, Any], *, extra_fields: frozenset[str] = frozenset()
) -> list[ValidationIssue]:
    """Shared shape for Goethe's one-scenario Schreiben task types: exactly ONE generated task (as
    `questions`, the generic per-part item array every task type uses) with a fixed number of content
    points the response must cover — no topic choice, no answer key. `extra_fields` lets a specific
    task type (e.g. formal_context_message's `addressForm`) declare additional allowed top-level item
    fields without duplicating this whole function."""
    issues: list[ValidationIssue] = []
    questions = content.get("questions") or []
    content_point_count = part.constraints.get("contentPointCount", 4)

    if len(questions) != 1:
        issues.append(ValidationIssue(None, f"expected exactly 1 generated task, got {len(questions)}"))
    if set(content) - {"questions"}:
        issues.append(ValidationIssue(None, "writing content must contain only the task, never an answer key or model solution"))

    allowed_fields = {"questionId", "title", "communicativeSituation", "contentPoints", "taskInstructions",
                      "writingCoachTaskType"} | extra_fields
    for q in questions:
        if set(q) - allowed_fields:
            issues.append(ValidationIssue(q.get("questionId"), "unexpected task fields: no answer key or model solution is allowed"))
        title = (q.get("title") or "").strip()
        situation = (q.get("communicativeSituation") or "").strip()
        instructions = (q.get("taskInstructions") or "").strip()
        task_type = q.get("writingCoachTaskType")
        points = q.get("contentPoints")
        if (not isinstance(points, list) or len(points) != content_point_count
                or any(not isinstance(p, str) or not p.strip() for p in points)):
            issues.append(ValidationIssue(q.get("questionId"), f"expected {content_point_count} nonempty contentPoints"))
        elif len({" ".join(p.casefold().split()).strip(".!? ") for p in points}) != content_point_count:
            issues.append(ValidationIssue(q.get("questionId"), "duplicate content points"))

        if not title:
            issues.append(ValidationIssue(q.get("questionId"), "title is missing or empty"))
        if not situation:
            issues.append(ValidationIssue(q.get("questionId"), "communicativeSituation is missing or empty"))
        if len(instructions) < _MIN_TASK_INSTRUCTION_CHARS:
            issues.append(ValidationIssue(q.get("questionId"), f"taskInstructions is missing or too short (min {_MIN_TASK_INSTRUCTION_CHARS} chars)"))
        if task_type not in _GOETHE_SCHREIBEN_TASK_TYPES:
            issues.append(ValidationIssue(q.get("questionId"), f"writingCoachTaskType must be one of {sorted(_GOETHE_SCHREIBEN_TASK_TYPES)}"))

    return issues


def validate_forum_discussion_post(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """Goethe C1 Schreiben Teil 1: a forum discussion scenario with exactly `contentPointCount` points
    the candidate's post must address (register is neutral/informal-plausible, no addressForm)."""
    return _validate_single_scenario_writing_task(part, content)


def validate_formal_context_message(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    """Goethe C1 Schreiben Teil 2: a (semi-)formal message scenario, same shape as
    forum_discussion_post plus a required addressForm field (blueprint pins it to "Sie")."""
    issues = _validate_single_scenario_writing_task(part, content, extra_fields=frozenset({"addressForm"}))
    expected_address_form = part.constraints.get("addressForm")
    for q in content.get("questions") or []:
        if expected_address_form and q.get("addressForm") != expected_address_form:
            issues.append(ValidationIssue(q.get("questionId"), f"addressForm must be {expected_address_form!r}"))
    return issues


def validate_speaking(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    issues = []
    def nonempty(value):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= 2000
    if part.task_type in ("presentation_summary_followup", "presentation_with_followup"):
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


VALIDATORS: dict[str, Callable[[PartBlueprint, dict[str, Any]], list[ValidationIssue]]] = {
    "presentation_summary_followup": validate_speaking,
    "quote_guided_discussion": validate_speaking,
    "speaker_statement_matching": validate_speaker_statement_matching,
    "sentence_completion_mc3": validate_sentence_completion_mc3,
    "structured_note_completion": validate_structured_note_completion,
    "text_reconstruction_sentence_matching": validate_text_reconstruction_sentence_matching,
    "section_statement_matching": validate_section_statement_matching,
    "detail_tristate_with_global_heading": validate_detail_tristate_with_global_heading,
    "reading_detail_mc3": validate_reading_detail_mc3,
    "multi_author_statement_matching_with_none": validate_multi_author_statement_matching_with_none,
    "cloze_mc4_language_elements": validate_cloze_mc4_language_elements,
    "contextual_cloze_mc4": validate_contextual_cloze_mc4,
    "choice_long_form_writing": validate_choice_long_form_writing,
    # --- Goethe-Zertifikat C1 ---
    "multi_source_statement_matching": validate_multi_source_statement_matching,
    "listening_tristate": validate_listening_tristate,
    "segmented_dialogue_mc3": validate_segmented_dialogue_mc3,
    "listening_detail_mc3": validate_sentence_completion_mc3,  # same segments+mc3 shape (speakerCountMin:1 for a solo Vortrag)
    "forum_discussion_post": validate_forum_discussion_post,
    "formal_context_message": validate_formal_context_message,
    "presentation_with_followup": validate_speaking,
    "guided_pair_discussion": validate_speaking,
}

# Reading task types don't carry a top-level "segments" array (they have
# "text"/"candidates"/"sections" instead) — the generic pre-check below only
# applies to listening, whose validators all assume "segments" exists.
_SEGMENTS_REQUIRED_TASK_TYPES = frozenset(
    {"speaker_statement_matching", "sentence_completion_mc3", "structured_note_completion",
     "multi_source_statement_matching", "listening_tristate", "segmented_dialogue_mc3", "listening_detail_mc3"}
)


def validate_content(part: PartBlueprint, content: dict[str, Any]) -> list[ValidationIssue]:
    if part.task_type in ("quote_guided_discussion", "guided_pair_discussion"):
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
