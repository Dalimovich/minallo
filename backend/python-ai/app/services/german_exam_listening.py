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
from time import perf_counter
from typing import Any

from ..config import get_settings

from .german_exam_adaptation import AdaptationInstruction
from .german_exam_profiles import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full as verify_semantic
from .german_exam_semantic_repair import repair_items_semantic
from .german_exam_semantic_verify import SemanticVerificationResult
from .german_exam_validator import ValidationIssue, hard_issues, validate_content
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_ITEM_REPAIR_ATTEMPTS = 2
_MAX_FULL_REGENERATIONS = 2
_MAX_SEMANTIC_REPAIR_ROUNDS = 2


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
        " Wrong options and unused statements must be reasonable alternative positions on the topic. "
        "Avoid straw-man extremes, universal bans, or obviously self-defeating policies that can be "
        "eliminated without listening. For MC3 distribute correctIndex across all three positions; "
        "do not always put the answer first."
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
        "Every item must also include evidenceSegmentIds: the id(s) of the segment(s) in your own "
        "'segments' array that directly support the correct continuation — this is what the app uses "
        "for 'Replay evidence' and must point at real segment ids from this same response.\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "...", "displayText": "..."}, ...],\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["detail_fact"], "difficulty": "c1",\n'
        '     "mc3": {"stem": "...", "options": ["...", "...", "..."], "correctIndex": 1, "evidenceSegmentIds": ["s3"]}},\n'
        '    {"questionId": "q2", "skillTags": ["causal_relationship", "negation_contrast"], "difficulty": "c1",\n'
        '     "mc3": {"stem": "...", "options": ["...", "...", "..."], "correctIndex": 0, "evidenceSegmentIds": ["s5", "s6"]}}\n'
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
        "Every item must also include evidenceSegmentIds: the id(s) of the segment(s) in your own "
        "'segments' array that directly state the correctFill — this is what the app uses for "
        "'Replay evidence' and must point at real segment ids from this same response.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "...", "displayText": "..."}, ...],\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["academic_structure"], "difficulty": "c1",\n'
        '     "note": {"fieldLabel": "...", "outlineContext": "...", "correctFill": "...", "evidenceSegmentIds": ["s1"]}},\n'
        '    {"questionId": "q2", "skillTags": ["detail_fact", "numbers_dates"], "difficulty": "c1",\n'
        '     "note": {"fieldLabel": "...", "outlineContext": "...", "correctFill": "...", "evidenceSegmentIds": ["s3"]}}\n'
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


def _populate_hv1_evidence(content: dict[str, Any]) -> dict[str, Any]:
    """HV1's evidence is fully derivable from matching.correctSpeakerId (each
    speaker maps 1:1 to one segment) — computed here rather than asked of the
    LLM, since it's guaranteed-correct by construction instead of trusted
    model output. Distractor items get an empty list (no single speaker to
    point at)."""
    segments = content.get("segments") or []
    speaker_to_segment = {s.get("speakerId"): s.get("id") for s in segments if s.get("speakerId")}
    for q in content.get("questions") or []:
        matching = q.get("matching") or {}
        speaker_id = matching.get("correctSpeakerId")
        matching["evidenceSegmentIds"] = [speaker_to_segment[speaker_id]] if speaker_id in speaker_to_segment else []
        q["matching"] = matching
    return content


_EVIDENCE_POSTPROCESSORS = {
    "speaker_statement_matching": _populate_hv1_evidence,
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
                result = chat_json(system=system, user=user, max_tokens=800, model=get_settings().german_exam_model)
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


def _postprocess(part: PartBlueprint, content: dict[str, Any]) -> dict[str, Any]:
    fn = _EVIDENCE_POSTPROCESSORS.get(part.task_type)
    try:
        return fn(content) if fn else content
    except (TypeError, AttributeError):
        return content  # The deterministic validator reports malformed payloads.


def _semantic_phase(part: PartBlueprint, content: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Runs semantic verification, and targeted repair for item-level error
    issues, for up to _MAX_SEMANTIC_REPAIR_ROUNDS rounds. A part-wide error
    issue can't be fixed at item level — verification stops immediately and
    the caller decides whether to fall back to a full regeneration. Returns
    (content, semantic_meta, passed)."""
    started = perf_counter()
    verification_count = 0
    repair_count = 0
    issues_resolved: list[dict[str, str]] = []
    issue_counts: dict[str, int] = {}

    def record_findings(result: SemanticVerificationResult) -> None:
        findings = list(result.part_wide_issues)
        findings.extend(issue for item in result.items for issue in item.issues)
        for issue in findings:
            issue_counts[issue.code] = issue_counts.get(issue.code, 0) + 1

    def check() -> SemanticVerificationResult:
        nonlocal verification_count
        for attempt in range(2):
            result = verify_semantic(part, content)
            record_findings(result)
            verification_count += 1
            findings = list(result.part_wide_issues) + [issue for item in result.items for issue in item.issues]
            if not any(issue.code == "VERIFIER_RESPONSE_INVALID" for issue in findings):
                return result
        return result

    result = check()

    for _round in range(_MAX_SEMANTIC_REPAIR_ROUNDS):
        part_wide_errors = result.part_wide_error_issues()
        item_errors = result.item_error_issues()
        if not part_wide_errors and not item_errors:
            break
        if any(issue.code == "VERIFIER_RESPONSE_INVALID" for issues in item_errors.values() for issue in issues):
            break
        if part_wide_errors:
            # Not repairable at item level — stop here; caller falls back to
            # a full regeneration if budget remains.
            break

        content, resolved = repair_items_semantic(part, content, item_errors)
        repair_count += len(item_errors)
        issues_resolved.extend(resolved)
        content = _postprocess(part, content)

        # Semantic repair must never move the official structure — if it
        # somehow did, stop and let the caller fall back to full regeneration
        # rather than trusting content that's now deterministically invalid.
        if hard_issues(validate_content(part, content)):
            log.warning("semantic repair for part %s broke deterministic structure — abandoning item-level repair", part.part_id)
            break

        result = check()

    passed = result.passed and not hard_issues(validate_content(part, content))
    meta = {
        "passed": passed,
        "verificationCount": verification_count,
        "repairCount": repair_count,
        "issuesResolved": issues_resolved if passed else [],
        "issueCounts": issue_counts,
        "durationMs": round((perf_counter() - started) * 1000),
    }
    return content, meta, passed


def generate_listening_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). content has NO audio fields.

    Pipeline: LLM generation -> deterministic validation (+ targeted repair)
    -> semantic verification (+ targeted repair) -> deterministic
    re-validation -> semantic re-verification -> accept. A part-wide problem
    at either stage (structural count wrong, or the transcript itself can't
    semantically support the part) falls back to a full regeneration, bounded
    by _MAX_FULL_REGENERATIONS shared across both stages. Raises
    ListeningGenerationError rather than ever returning known-invalid
    content once that budget is exhausted."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise ListeningGenerationError(f"no prompt builder for task_type {part.task_type!r}")

    last_issues: list[ValidationIssue] = []
    last_semantic: dict[str, Any] | None = None
    semantic_totals = {"verificationCount": 0, "repairCount": 0, "durationMs": 0}
    total_det_repairs = 0
    total_issue_counts: dict[str, int] = {}

    for regeneration in range(_MAX_FULL_REGENERATIONS + 1):
        system, user = builder(profile, part, plan, topic)
        result = chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model)
        content = result.data if isinstance(result.data, dict) else {}
        content = _postprocess(part, content)

        issues = validate_content(part, content)
        h_issues = hard_issues(issues)

        # Part-level issues (item_id is None) cannot be fixed per-item.
        part_level = [i for i in h_issues if i.item_id is None]
        if part_level and regeneration < _MAX_FULL_REGENERATIONS:
            last_issues = h_issues
            continue

        item_level = [i for i in h_issues if i.item_id is not None]
        det_repair_count = 0
        if item_level:
            content = _repair_items(part, content, item_level)
            content = _postprocess(part, content)
            det_repair_count = len(item_level)
            total_det_repairs += det_repair_count
            issues = validate_content(part, content)
            h_issues = hard_issues(issues)

        if h_issues:
            last_issues = h_issues
            if regeneration < _MAX_FULL_REGENERATIONS:
                continue
            raise ListeningGenerationError(
                f"could not produce a deterministically valid {part.task_type} part after "
                f"{_MAX_FULL_REGENERATIONS} regenerations: "
                + "; ".join(f"{i.item_id}: {i.message}" for i in last_issues)
            )

        # Deterministically valid — now judge whether the content is defensible.
        content, semantic_meta, semantic_ok = _semantic_phase(part, content)
        for key in semantic_totals:
            semantic_totals[key] += semantic_meta[key]
        for code, count in semantic_meta["issueCounts"].items():
            total_issue_counts[code] = total_issue_counts.get(code, 0) + count
        log.info("german_exam_semantic part=%s regeneration=%s passed=%s verificationCount=%s repairCount=%s issueCounts=%s",
                 part.part_id, regeneration, semantic_ok, semantic_meta["verificationCount"], semantic_meta["repairCount"], semantic_meta["issueCounts"])
        if semantic_ok:
            semantic_meta.update(semantic_totals)
            semantic_meta["issueCounts"] = total_issue_counts
            semantic_meta["regenerationCount"] = regeneration
            return content, {
                "deterministicPassed": True,
                "deterministicRepairCount": total_det_repairs,
                "semantic": semantic_meta,
            }

        last_semantic = semantic_meta
        if regeneration < _MAX_FULL_REGENERATIONS:
            continue
        raise ListeningGenerationError(
            f"could not produce semantically valid {part.task_type} content after "
            f"{_MAX_FULL_REGENERATIONS} regenerations: {last_semantic}"
        )

    raise ListeningGenerationError(f"unreachable: exhausted regeneration budget for {part.task_type!r}")
