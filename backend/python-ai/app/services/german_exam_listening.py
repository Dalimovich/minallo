"""Shared German Exam Engine — Hören (listening) module adapter.

Builds task_type-specific prompts, calls the shared `chat_json()` helper,
validates via `german_exam_validator`, and repairs invalid items in a
bounded loop. Returns CONTENT ONLY — no TTS call, no audioUrl/durationMs
anywhere in the returned dict. Audio synthesis is entirely the Hören
frontend's responsibility via the existing `/api/ai/tts-batch` endpoint,
after this content comes back from `/german-exam/generate`. This keeps the
module reusable by Lesen/Schreiben/Sprechen/Sprachbausteine (none of which
need TTS) and means a Qwen/TTS outage never fails content generation.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .german_exam_adaptation import AdaptationInstruction
from .german_exam_profiles import ExamProfile, PartBlueprint
from .german_exam_validator import ValidationIssue, hard_issues, validate_content
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_ITEM_REPAIR_ATTEMPTS = 2
_MAX_FULL_REGENERATIONS = 2


class ListeningGenerationError(Exception):
    pass


def _adaptation_guidance(instructions: list[AdaptationInstruction]) -> str:
    if not instructions:
        return "No specific weakness data yet — generate balanced, exam-representative content covering the part's normal range of skills."
    lines = ["Content-difficulty guidance (do NOT change item count, task type, option count, or any structural rule):"]
    for instr in instructions:
        lines.append(f"- {instr.direction} {instr.axis.replace('_', ' ')} for content touching: {', '.join(instr.target_tags)}.")
    return "\n".join(lines)


def _base_system_preamble(profile: ExamProfile, part: PartBlueprint) -> str:
    return (
        f"You generate ORIGINAL German listening-exam practice content for {profile.family} "
        f"{profile.variant or ''} ({part.title}), matching the official {part.task_type} task format. "
        "You must NOT copy any real exam content — generate entirely new material with the same "
        "structure and difficulty. Reply with ONLY valid JSON, no markdown fences, no commentary."
    )


# ── HV1: speaker_statement_matching ─────────────────────────────────────────


def _prompt_hv1(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    speaker_count = part.constraints.get("speakerCount", 8)
    statement_count = part.constraints.get("statementCount", 10)
    unused = part.constraints.get("unusedStatements", 2)
    mapped = statement_count - unused

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): exactly {speaker_count} short spoken statements from "
        f"{speaker_count} different speakers on the topic '{topic['label']}', each giving a genuinely "
        f"different viewpoint (not near-duplicates of each other). Then exactly {statement_count} "
        f"written statements: {mapped} of them each PARAPHRASE (never quote verbatim) exactly one "
        f"speaker's view, and exactly {unused} are distractors that do not correctly match any speaker. "
        "Every correct written statement must fit exactly one speaker — no ambiguity between two "
        "speakers. Written statements must not reuse the same vocabulary as the spoken text; they "
        "must express the same idea in different words.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: think about what "
        "this specific statement actually requires the listener to do. If it hinges on wording distance "
        "from the audio, use paraphrase_mapping; if it captures a speaker's stance/attitude, use "
        "speaker_opinion or attitude_tone; if it requires inferring something not stated outright, use "
        "implicit_inference; if it is mainly about correctly identifying WHICH speaker said something "
        "(matching itself), use speaker_matching. Most items should combine 1-2 tags, and across the 10 "
        "items you should use at least 3 different tags overall, not the same single tag on every item.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "...", "displayText": "..."}, ...],\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "prompt": "<written statement>", "skillTags": ["paraphrase_mapping", "speaker_matching"],\n'
        '     "difficulty": "c1", "matching": {"correctSpeakerId": "speaker_3", "isDistractor": false}},\n'
        '    {"questionId": "q2", "prompt": "<written statement>", "skillTags": ["speaker_opinion", "attitude_tone"],\n'
        '     "difficulty": "c1", "matching": {"correctSpeakerId": "speaker_5", "isDistractor": false}},\n'
        '    {"questionId": "q9", "prompt": "<distractor statement>", "skillTags": ["implicit_inference"],\n'
        '     "difficulty": "c1", "matching": {"correctSpeakerId": null, "isDistractor": true}}\n'
        "  ]\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


# ── HV2: sentence_completion_mc3 ────────────────────────────────────────────


def _prompt_hv2(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    item_count = part.constraints.get("itemCount", 10)
    option_count = part.constraints.get("optionCount", 3)
    speaker_min = part.constraints.get("speakerCountMin", 2)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one coherent interview or discussion involving at least "
        f"{speaker_min} distinct speakers on the topic '{topic['label']}', roughly chronological. "
        f"Then exactly {item_count} items, each a sentence stem with exactly {option_count} possible "
        "continuations, exactly one of which is correct. Wrong continuations must be plausible: "
        "derived from a nearby fact, a partially true detail, reversed causality, a negation/contrast "
        "confusion, or something a DIFFERENT speaker said — never arbitrary, absurd, or unrelated to "
        "the topic. A distractor a listener could reject purely from general knowledge, without having "
        "heard the audio, is not acceptable.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: pick whichever tags "
        "from the allowed list actually describe what makes THIS item hard (a specific fact, a "
        "cause/effect, a negation the learner must parse, something implied rather than stated, "
        "something requiring elimination of a not-stated option, etc.). Use at least 3 different tags "
        "across the 10 items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "...", "displayText": "..."}, ...],\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["detail_fact"], "difficulty": "c1",\n'
        '     "mc3": {"stem": "...", "options": ["...", "...", "..."], "correctIndex": 1}},\n'
        '    {"questionId": "q2", "skillTags": ["causal_relationship", "negation_contrast"], "difficulty": "c1",\n'
        '     "mc3": {"stem": "...", "options": ["...", "...", "..."], "correctIndex": 0}}\n'
        "  ]\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


# ── HV3: structured_note_completion ─────────────────────────────────────────


def _prompt_hv3(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    item_count = part.constraints.get("itemCount", 10)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one academic lecture or talk on '{topic['label']}' with "
        f"clear sections, signposting, examples, and arguments. The lecture must contain at least "
        f"{item_count} genuinely DISTINCT pieces of information — do not write a short lecture and pad "
        "the fields by restating the same 2-3 points in different words. If a section doesn't naturally "
        "yield a new fact, expand that section with more real content (an example, a cause, a "
        "consequence, a number) rather than re-deriving an existing answer. Then a structured "
        f"outline/handout with exactly {item_count} missing-information fields, each field's "
        "correctFill drawn from a DIFFERENT point in the lecture — no two fields may share the same "
        "answer OR be near-paraphrases of each other. Each missing field must be CONCISE note-worthy "
        "content (a short phrase or key fact), never a single arbitrary word.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: use note_taking "
        "only when the item is genuinely about capturing a key phrase; use academic_structure when it's "
        "about the lecture's organization/signposting; use detail_fact/numbers_dates/argument_structure/ "
        "summary_error_detection when those fit better. Use at least 3 different tags across the 10 "
        "items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "...", "displayText": "..."}, ...],\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["academic_structure"], "difficulty": "c1",\n'
        '     "note": {"fieldLabel": "...", "outlineContext": "...", "correctFill": "..."}},\n'
        '    {"questionId": "q2", "skillTags": ["detail_fact", "numbers_dates"], "difficulty": "c1",\n'
        '     "note": {"fieldLabel": "...", "outlineContext": "...", "correctFill": "..."}}\n'
        "  ]\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


_PROMPT_BUILDERS = {
    "speaker_statement_matching": _prompt_hv1,
    "sentence_completion_mc3": _prompt_hv2,
    "structured_note_completion": _prompt_hv3,
}


def _repair_prompt(part: PartBlueprint, content: dict[str, Any], issue: ValidationIssue) -> tuple[str, str]:
    system = (
        f"You are repairing ONE invalid item in a generated German listening exercise "
        f"({part.task_type}). The item with questionId={issue.item_id!r} failed validation: "
        f"{issue.message}. Return ONLY a JSON object for the corrected single question item, in the "
        "exact same shape as the other items in the 'questions' array of the original content. Do not "
        "change its questionId. Reply with ONLY valid JSON, no markdown fences, no commentary."
    )
    user = f"Original content for context:\n{json.dumps(content, ensure_ascii=False)}\n\nFix item {issue.item_id!r}."
    return system, user


def _repair_items(part: PartBlueprint, content: dict[str, Any], issues: list[ValidationIssue]) -> dict[str, Any]:
    """Repairs each hard, item-scoped issue in bounded parallel, up to
    _MAX_ITEM_REPAIR_ATTEMPTS attempts per item. Part-level issues (item_id
    is None — e.g. wrong overall item count) cannot be repaired per-item and
    force a full regeneration instead (handled by the caller)."""
    by_item: dict[str, ValidationIssue] = {}
    for issue in issues:
        if issue.item_id and issue.hard:
            by_item[issue.item_id] = issue

    if not by_item:
        return content

    questions_by_id = {q.get("questionId"): q for q in content.get("questions") or []}

    def _fix_one(item_id: str, issue: ValidationIssue) -> tuple[str, dict[str, Any] | None]:
        # chat_json() already acquires an llm_fanout_slot() internally per call,
        # so the bounded ThreadPoolExecutor below is the only concurrency guard needed here.
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _repair_prompt(part, content, issue)
                result = chat_json(system=system, user=user, max_tokens=800)
                fixed = result.data
                if isinstance(fixed, dict) and fixed.get("questionId") == item_id:
                    return item_id, fixed
            except Exception:  # noqa: BLE001
                log.warning("repair attempt failed for item %s", item_id, exc_info=True)
        return item_id, None

    with ThreadPoolExecutor(max_workers=min(4, len(by_item))) as pool:
        results = list(pool.map(lambda kv: _fix_one(kv[0], kv[1]), by_item.items()))

    for item_id, fixed in results:
        if fixed is not None:
            questions_by_id[item_id] = fixed

    content = dict(content)
    # Preserve original item order; swap in repaired items by questionId.
    content["questions"] = [
        questions_by_id.get(q.get("questionId"), q) for q in content.get("questions") or []
    ]
    return content


def generate_listening_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). content has NO audio fields.
    Raises ListeningGenerationError if generation cannot be made valid within
    the bounded repair/regeneration budget."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise ListeningGenerationError(f"no prompt builder for task_type {part.task_type!r}")

    total_repair_count = 0
    last_issues: list[ValidationIssue] = []

    for regeneration in range(_MAX_FULL_REGENERATIONS + 1):
        system, user = builder(profile, part, plan, topic)
        result = chat_json(system=system, user=user, max_tokens=4000)
        content = result.data if isinstance(result.data, dict) else {}

        issues = validate_content(part, content)
        h_issues = hard_issues(issues)

        # Part-level issues (item_id is None) cannot be fixed per-item.
        part_level = [i for i in h_issues if i.item_id is None]
        if part_level and regeneration < _MAX_FULL_REGENERATIONS:
            last_issues = h_issues
            continue

        item_level = [i for i in h_issues if i.item_id is not None]
        if item_level:
            content = _repair_items(part, content, item_level)
            total_repair_count += len(item_level)
            issues = validate_content(part, content)
            h_issues = hard_issues(issues)

        if not h_issues:
            resolved = [f"{i.item_id}: {i.message}" for i in item_level]
            return content, {
                "deterministicPassed": True,
                "repairCount": total_repair_count,
                "issuesResolved": resolved,
            }

        last_issues = h_issues

    raise ListeningGenerationError(
        f"could not produce a valid {part.task_type} part after {_MAX_FULL_REGENERATIONS} regenerations: "
        + "; ".join(f"{i.item_id}: {i.message}" for i in last_issues)
    )
