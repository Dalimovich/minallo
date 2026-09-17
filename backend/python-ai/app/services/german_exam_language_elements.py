"""Shared German Exam Engine — Sprachbausteine (language elements) module adapter.

Mirrors german_exam_reading.py's pipeline shape exactly (LLM generation ->
deterministic validation+repair -> semantic verification+repair ->
re-validation -> accept, bounded regeneration). Content has no audio/segments
concept, same as reading — one continuous cloze text with per-gap four-option
items, no shared-candidate-pool bijection to reason about (unlike Lesen 1),
so item-level semantic repair is always safe here (a defect lives entirely
inside one `questions` entry: its own options/correctIndex/category).
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
# A 2026-09-17 production smoke run found gpt-5.4-mini reliably missing this
# part's simultaneous constraints (word-count window + an exact 3-way
# grammar/lexicon/orthography split summing to itemCount) on the first two
# tries, so a real learner got a 502 after both full regenerations were
# exhausted. One extra regeneration is the cheapest possible headroom (worst
# case: one more mini-model call) short of reworking the pipeline.
_MAX_FULL_REGENERATIONS = 3
_MAX_SEMANTIC_REPAIR_ROUNDS = 2


class LanguageElementsGenerationError(Exception):
    pass


def _adaptation_guidance(instructions: list[AdaptationInstruction]) -> str:
    if not instructions:
        return "No specific weakness data yet — generate a balanced, exam-representative item mix covering the part's normal range of grammar/lexicon/orthography skills."
    lines = ["Content-difficulty guidance (do NOT change item count, option count, category ranges, or any structural rule):"]
    for instr in instructions:
        lines.append(f"- {instr.direction} {instr.axis.replace('_', ' ')} for content touching: {', '.join(instr.target_tags)}.")
    return "\n".join(lines)


def _prompt_sprachbausteine(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[str, str]:
    item_count = part.constraints.get("itemCount", 22)
    option_count = part.constraints.get("optionCount", 4)
    word_min = part.constraints.get("wordCountMin", 320)
    word_max = part.constraints.get("wordCountMax", 350)
    grammar_min = part.constraints.get("grammarCountMin", 12)
    grammar_max = part.constraints.get("grammarCountMax", 16)
    lexical_min = part.constraints.get("lexicalCountMin", 4)
    lexical_max = part.constraints.get("lexicalCountMax", 8)
    ortho_min = part.constraints.get("orthographyCountMin", 1)
    ortho_max = part.constraints.get("orthographyCountMax", 4)

    system = (
        f"You generate ORIGINAL German language-elements (Sprachbausteine) exam practice content for "
        f"{profile.family} {profile.variant or ''}, matching the official cloze_mc4_language_elements task "
        "format. You must NOT copy any real exam content — generate an entirely new, coherent factual, "
        "popular-academic, or study-related text with the same structure and difficulty. Reply with ONLY "
        "valid JSON, no markdown fences, no commentary.\n\n"
        f"Task structure (IMMUTABLE): one continuous {word_min}-{word_max} word text on the topic "
        f"'{topic['label']}', split into paragraphs, with exactly {item_count} gaps marked inline in the "
        'paragraph text as the literal placeholder "{{gapId}}" (e.g. "{{g1}}") at the point a word or short '
        f"phrase was removed, numbered in reading order g1..g{item_count}. Then exactly {item_count} items, "
        f"one per gap, each with exactly {option_count} answer options (plain strings, not lettered) and "
        "exactly one correctIndex (0-based) into that item's own options array — options are per-item, NOT "
        "a shared pool (unlike a sentence-reconstruction task).\n\n"
        f"Each item has a category, exactly one of \"grammar\", \"lexicon\", or \"orthography\". Across all "
        f"{item_count} items: {grammar_min}-{grammar_max} must be category \"grammar\" (verb forms, cases, "
        f"connectors, prepositions, syntax), {lexical_min}-{lexical_max} must be \"lexicon\" (collocations, "
        f"word choice, word formation), and {ortho_min}-{ortho_max} must be \"orthography\" (spelling, "
        "capitalization, punctuation conventions). The three counts must sum to exactly "
        f"{item_count}. The three wrong options per item must be genuinely plausible for a C1 learner — "
        "real near-misses (a wrong case ending, a confusable preposition, a near-synonym with a different "
        "register or collocation, a plausible misspelling) — never trivial, absurd, or obviously wrong on "
        "sight; avoid options that differ only in an unrelated word so the gap tests genuine C1 competence, "
        "not elimination by pattern-matching.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: use grammar for verb/case "
        "issues, connectors for logical-connector choices, prepositions for preposition choices, "
        "word_formation for derivation/compounding, collocation or lexical_choice for lexicon items, "
        "register when formality level is being tested, syntax for word-order/clause-structure items. Use "
        f"at least 4 different tags across the {item_count} items.\n\n"
        "BEFORE YOU OUTPUT, silently self-check and fix any violation (these are hard requirements, not "
        "targets — content outside them is rejected):\n"
        f"1. Count the running text's words (excluding the {{{{gapId}}}} placeholders): must be "
        f"{word_min}-{word_max}. If over {word_max}, cut a clause or sentence; if under {word_min}, add one. "
        "Do not just estimate — count.\n"
        f"2. Count how many items you gave each category: grammar must be {grammar_min}-{grammar_max}, "
        f"lexicon must be {lexical_min}-{lexical_max}, orthography must be {ortho_min}-{ortho_max}, and the "
        f"three counts must sum to exactly {item_count}. If any count is outside its range (most often "
        "orthography ending up at 0, or grammar/lexicon drifting to equal counts instead of grammar being "
        "the larger share), reclassify enough items to fix it — do not add or remove items to compensate.\n"
        "3. Within each item's own options array, make sure all "
        f"{option_count} strings are distinct from one another — no two options identical.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags/category below are illustrative, not literal — pick "
        "values that actually fit each item per the guidance above):\n"
        "{\n"
        '  "text": {\n'
        '    "title": "...",\n'
        '    "paragraphs": ["Erster Absatz ... {{g1}} ... weiter {{g2}} ...", "Zweiter Absatz ... {{g3}} ..."],\n'
        f'    "gaps": [{{"gapId": "g1"}}, {{"gapId": "g2"}}, ...] // exactly {item_count} entries\n'
        "  },\n"
        '  "questions": [\n'
        '    {"questionId": "q1", "gapId": "g1", "options": ["...", "...", "...", "..."], "correctIndex": 2,\n'
        '     "category": "grammar", "skillTags": ["grammar"], "difficulty": "c1"},\n'
        '    ...\n'
        f'  ] // exactly {item_count} entries, one per gap, in gap order\n'
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


_PROMPT_BUILDERS = {
    "cloze_mc4_language_elements": _prompt_sprachbausteine,
}


def _repair_prompt(part: PartBlueprint, content: dict[str, Any], issue: ValidationIssue) -> tuple[str, str]:
    system = (
        f"You are repairing ONE invalid item in a generated German Sprachbausteine exercise "
        f"({part.task_type}). The item with questionId={issue.item_id!r} failed validation: "
        f"{issue.message}. Return ONLY a JSON object for the corrected single question item, in the "
        "exact same shape as the other items in the 'questions' array of the original content. Do not "
        "change its questionId or gapId. Reply with ONLY valid JSON, no markdown fences, no commentary."
    )
    user = f"Original content for context:\n{json.dumps(content, ensure_ascii=False)}\n\nFix item {issue.item_id!r}."
    return system, user


def _repair_items(part: PartBlueprint, content: dict[str, Any], issues: list[ValidationIssue]) -> dict[str, Any]:
    """Deterministic, structural per-item repair — identical shape to
    german_exam_reading.py's version (already task_type/module agnostic)."""
    by_item: dict[str, ValidationIssue] = {}
    for issue in issues:
        if issue.item_id and issue.hard:
            by_item[issue.item_id] = issue

    if not by_item:
        return content

    questions_by_id = {q.get("questionId"): q for q in content.get("questions") or []}

    def _fix_one(item_id: str, issue: ValidationIssue) -> tuple[str, dict[str, Any] | None]:
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _repair_prompt(part, content, issue)
                result = chat_json(system=system, user=user, max_tokens=500, model=get_settings().german_exam_model)
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
    content["questions"] = [
        questions_by_id.get(q.get("questionId"), q) for q in content.get("questions") or []
    ]
    return content


def _postprocess(part: PartBlueprint, content: dict[str, Any]) -> dict[str, Any]:
    return content


def _semantic_phase(part: PartBlueprint, content: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Same shape as german_exam_reading.py's _semantic_phase — but every
    item-level semantic error here IS eligible for targeted repair (no
    task_type is excluded), since a Sprachbausteine defect always lives
    entirely inside one item's own options/correctIndex/category."""
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
        result: SemanticVerificationResult | None = None
        for attempt in range(2):
            result = verify_semantic(part, content)
            record_findings(result)
            verification_count += 1
            findings = list(result.part_wide_issues) + [issue for item in result.items for issue in item.issues]
            if not any(issue.code == "VERIFIER_RESPONSE_INVALID" for issue in findings):
                return result
        assert result is not None
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
            break

        content, resolved = repair_items_semantic(part, content, item_errors)
        repair_count += len(item_errors)
        issues_resolved.extend(resolved)
        content = _postprocess(part, content)

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


def generate_language_elements_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). Pipeline identical in shape to
    generate_reading_part(): LLM generation -> deterministic validation (+
    targeted repair) -> semantic verification (+ targeted repair) ->
    deterministic re-validation -> semantic re-verification -> accept. Raises
    LanguageElementsGenerationError rather than ever returning known-invalid
    content once the regeneration budget is exhausted."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise LanguageElementsGenerationError(f"no prompt builder for task_type {part.task_type!r}")

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
            raise LanguageElementsGenerationError(
                f"could not produce a deterministically valid {part.task_type} part after "
                f"{_MAX_FULL_REGENERATIONS} regenerations: "
                + "; ".join(f"{i.item_id}: {i.message}" for i in last_issues)
            )

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
        raise LanguageElementsGenerationError(
            f"could not produce semantically valid {part.task_type} content after "
            f"{_MAX_FULL_REGENERATIONS} regenerations: {last_semantic}"
        )

    raise LanguageElementsGenerationError(f"unreachable: exhausted regeneration budget for {part.task_type!r}")
