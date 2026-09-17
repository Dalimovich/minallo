"""Shared German Exam Engine — Schreiben (writing) TASK GENERATION.

Deliberately separate from german_exam_writing_grading.py (learner
SUBMISSION grading) — see that module's docstring for why generation and
grading must never be the same code path. This module only ever produces
the two generated topics; it never sees a learner's own text and never runs
against one.

Mirrors german_exam_language_elements.py's pipeline shape (LLM generation ->
deterministic validation+repair -> semantic verification+repair ->
re-validation -> accept, bounded regeneration). Content has no answer key at
all — there is nothing to grade objectively here, unlike every other module.
Item-level (per-topic) repair is always safe, like Sprachbausteine: a
defect always lives entirely inside one topic's own
title/communicativeSituation/taskInstructions/writingCoachTaskType, except
the cross-topic "not genuinely distinct" defect, which is part-wide and
handled by falling back to full regeneration (mirrors lesen_1's shared-pool
defects, for the same reason: no single-item repair call can fix "these two
things are too similar" without seeing both).
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
from .german_exam_validator import TELC_SCHREIBEN_TASK_TYPES, ValidationIssue, hard_issues, validate_content
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_ITEM_REPAIR_ATTEMPTS = 2
_MAX_FULL_REGENERATIONS = 2
_MAX_SEMANTIC_REPAIR_ROUNDS = 2

# A DUPLICATE_INFORMATION verdict here means "these two topics aren't
# genuinely distinct" — a cross-topic defect no single-item repair call can
# fix (repair_items_semantic() only ever rewrites ONE item in isolation, so
# it cannot make topic B different FROM whatever topic A already is).
# Mirrors lesen_1's _NO_ITEM_LEVEL_SEMANTIC_REPAIR, but scoped to just this
# one issue code rather than the whole task type, since every OTHER
# per-topic defect (unclear instructions, wrong register, leaked answer) IS
# safely repairable in isolation.
_PART_WIDE_LIKE_ITEM_CODES = frozenset({"DUPLICATE_INFORMATION"})


class WritingGenerationError(Exception):
    pass


def _adaptation_guidance(instructions: list[AdaptationInstruction]) -> str:
    if not instructions:
        return "No specific weakness data yet — generate balanced, exam-representative topics."
    lines = ["Content-difficulty guidance (do NOT change topic count or any structural rule):"]
    for instr in instructions:
        lines.append(f"- {instr.direction} {instr.axis.replace('_', ' ')} for content touching: {', '.join(instr.target_tags)}.")
    return "\n".join(lines)


def _prompt_schreiben1(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[str, str]:
    topic_count = part.constraints.get("topicChoiceCount", 2)
    target_words = part.constraints.get("targetWordCount", 350)

    system = (
        f"You generate ORIGINAL German writing-exam TASK PROMPTS (not a written response) for "
        f"{profile.family} {profile.variant or ''}, matching the official choice_long_form_writing task "
        "format (telc-style Schreiben). You must NOT copy any real exam content, and you must NEVER write "
        "a model answer, example response, or sample text anywhere in your output — this task has no "
        "answer key; a learner will write their own free-text response to whichever topic they choose, "
        "graded separately by a different process. Reply with ONLY valid JSON, no markdown fences, no "
        "commentary.\n\n"
        f"Task structure (IMMUTABLE): exactly {topic_count} topics, genuinely different from each other "
        "(different underlying question, not just reworded phrasing of the same one), each academic or "
        f"study-related and answerable by a C1 Hochschule candidate using general knowledge — target "
        f"response length is at least {target_words} words, but that is guidance for the CANDIDATE's answer, "
        "not a constraint on your own output. Each topic needs: a short title; a clear communicative "
        "situation (who is writing to whom, in what context, and why); precise task instructions listing "
        "the concrete content the response must cover; and a writingCoachTaskType classifying how the "
        f"topic is framed, exactly one of {sorted(TELC_SCHREIBEN_TASK_TYPES)} — use 'stellungnahme' for a "
        "take-a-position-on-an-issue framing, 'argumentation' for a build-a-case/weigh-arguments framing, "
        "'freier_text' only if neither fits. Do not require any niche specialist/professional knowledge — "
        "general academic/study-life familiarity must be enough to answer either topic.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "questions": [\n'
        '    {"questionId": "a", "title": "...", "communicativeSituation": "...",\n'
        '     "taskInstructions": "...", "writingCoachTaskType": "stellungnahme"},\n'
        '    {"questionId": "b", "title": "...", "communicativeSituation": "...",\n'
        '     "taskInstructions": "...", "writingCoachTaskType": "argumentation"}\n'
        f"  ] // exactly {topic_count} entries\n"
        "}"
    )
    user = f"Generate the two topics now. Broad subject-area steer (not the topic itself): {topic['label']}."
    return system, user


_PROMPT_BUILDERS = {
    "choice_long_form_writing": _prompt_schreiben1,
}


def _repair_prompt(part: PartBlueprint, content: dict[str, Any], issue: ValidationIssue) -> tuple[str, str]:
    system = (
        f"You are repairing ONE invalid topic in a generated German Schreiben task "
        f"({part.task_type}). The topic with questionId={issue.item_id!r} failed validation: "
        f"{issue.message}. Return ONLY a JSON object for the corrected single topic, in the exact same "
        "shape as the other topic in the 'questions' array of the original content — never a model answer "
        "or sample response, only the task prompt fields. Do not change its questionId. Reply with ONLY "
        "valid JSON, no markdown fences, no commentary."
    )
    user = f"Original content for context:\n{json.dumps(content, ensure_ascii=False)}\n\nFix topic {issue.item_id!r}."
    return system, user


def _repair_items(part: PartBlueprint, content: dict[str, Any], issues: list[ValidationIssue]) -> dict[str, Any]:
    """Deterministic, structural per-topic repair — identical shape to the
    other modules' version (already task_type/module agnostic)."""
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
                result = chat_json(system=system, user=user, max_tokens=600, model=get_settings().german_exam_model)
                fixed = result.data
                if isinstance(fixed, dict) and fixed.get("questionId") == item_id:
                    return item_id, fixed
            except Exception:  # noqa: BLE001
                log.warning("repair attempt failed for topic %s", item_id, exc_info=True)
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
    """Same shape as the other modules' _semantic_phase, with one addition
    mirroring lesen_1: a DUPLICATE_INFORMATION (not-genuinely-distinct)
    finding on either topic is treated like a part-wide error (stop, fall
    back to full regeneration) instead of item-level repair — see
    _PART_WIDE_LIKE_ITEM_CODES."""
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
        if any(issue.code in _PART_WIDE_LIKE_ITEM_CODES for issues in item_errors.values() for issue in issues):
            # "Topics aren't distinct enough" can't be fixed by rewriting
            # one topic in isolation — fall back to full regeneration.
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


def generate_writing_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). Pipeline identical in shape to the
    other modules: LLM generation -> deterministic validation (+ targeted
    repair) -> semantic verification (+ targeted repair, except a
    not-genuinely-distinct finding, which always regenerates) ->
    deterministic re-validation -> semantic re-verification -> accept.
    Raises WritingGenerationError rather than ever returning known-invalid
    content once the regeneration budget is exhausted. Content has NO answer
    key — nothing here is ever graded against this generated content; see
    german_exam_writing_grading.py for how a learner's own submission is
    actually graded."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise WritingGenerationError(f"no prompt builder for task_type {part.task_type!r}")

    last_issues: list[ValidationIssue] = []
    last_semantic: dict[str, Any] | None = None
    semantic_totals = {"verificationCount": 0, "repairCount": 0, "durationMs": 0}
    total_det_repairs = 0
    total_issue_counts: dict[str, int] = {}

    for regeneration in range(_MAX_FULL_REGENERATIONS + 1):
        system, user = builder(profile, part, plan, topic)
        result = chat_json(system=system, user=user, max_tokens=2500, model=get_settings().german_exam_model)
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
            raise WritingGenerationError(
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
        raise WritingGenerationError(
            f"could not produce semantically valid {part.task_type} content after "
            f"{_MAX_FULL_REGENERATIONS} regenerations: {last_semantic}"
        )

    raise WritingGenerationError(f"unreachable: exhausted regeneration budget for {part.task_type!r}")
