"""Shared German Exam Engine — targeted repair of semantically-flawed items.

Repairs ONE item at a time, preserving everything except the flawed
part — question id, task type, skill tags, and the exam's official
structure never change here. This module never touches the transcript or
other items; a part-wide semantic issue (PART_WIDE_INCOHERENCE,
INSUFFICIENT_SOURCE_CONTENT) is NOT this module's job — the orchestrator
in german_exam_listening.py handles that by regenerating the whole part.

Kept as its own module (not folded into german_exam_semantic_verify.py or
german_exam_listening.py's existing _repair_items) specifically so
chat_json()'s automatic per-module usage tracking records repair calls
under feature="german_exam_semantic_repair", separate from
"german_exam_semantic_verify" — see section 15's cost-tracking requirement.
"""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from contextvars import copy_context
from .gen_timing import ContextThreadPoolExecutor as ThreadPoolExecutor
from typing import Any

from ..config import get_settings

from .german_exams import PartBlueprint
from .german_exam_semantic_verify import SemanticIssue
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_ITEM_REPAIR_ATTEMPTS = 2


def _repair_prompt(part: PartBlueprint, content: dict[str, Any], item_id: str, issues: list[SemanticIssue]) -> tuple[str, str]:
    issue_lines = "\n".join(f"- {i.code}: {i.message}; evidence={json.dumps(i.evidence)}" for i in issues)
    system = (
        f"You are repairing ONE item (questionId={item_id!r}) in a generated German exam exercise "
        f"({part.module}, {part.task_type}) that failed independent semantic review:\n{issue_lines}\n\n"
        "Repair ONLY this item while preserving: its questionId, the task type's field shape, its "
        "skillTags exactly, the correct answer meaning, the "
        "overall intended difficulty, and the exam's official structure (do not add/remove options, "
        "speakers, sections, or fields). If the issue requires referencing the source material for "
        "evidence, use the source material already supplied in the full part content below (whatever form "
        "it takes for this task type) — do not invent new source material or change what's already there. "
        "Return ONLY a JSON object for the corrected single item, in the exact same shape as the original "
        "item. Reply with ONLY valid JSON, no markdown fences, no commentary."
    )
    user = f"Full part content for context:\n{json.dumps(content, ensure_ascii=False)}\n\nFix item {item_id!r}."
    return system, user


def _constrain_repair(original: dict, fixed: dict, issues: list[SemanticIssue], part: PartBlueprint | None = None) -> dict:
    candidate = deepcopy(original)
    for key, value in fixed.items():
        if key not in original:
            continue
        if isinstance(original[key], dict) and isinstance(value, dict):
            candidate[key].update({name: item for name, item in value.items() if name in original[key]})
        elif not isinstance(original[key], dict):
            candidate[key] = deepcopy(value)
    fixed = candidate
    for key in ("questionId", "skillTags", "difficulty"):
        if key in original:
            fixed[key] = deepcopy(original[key])
    if "matching" in original:
        for key in ("correctSpeakerId", "isDistractor"):
            fixed.setdefault("matching", {})[key] = original["matching"].get(key)
    # Sprachbausteine: the correct answer/correctIndex came from Stage A
    # (the passage was written around it) — semantic repair, triggered by a
    # distractor-quality finding, must never be able to silently turn a
    # wrong option into a new "correct" one or otherwise touch which option
    # is correct. Applied unconditionally for this task type (not gated by
    # issue code, unlike the mc3 case below) — Stage B repair owns
    # distractors only, always.
    if part is not None and part.task_type == "cloze_mc4_language_elements" and "options" in original and "correctIndex" in original:
        result = deepcopy(original)
        fixed_options = fixed.get("options")
        idx = original.get("correctIndex")
        if isinstance(fixed_options, list) and len(fixed_options) == len(original["options"]) and isinstance(idx, int):
            for n in range(len(fixed_options)):
                if n != idx:
                    result["options"][n] = fixed_options[n]
        return result
    if "mc3" in original and all(i.code in {
        "IMPLAUSIBLE_DISTRACTOR", "DISTRACTOR_ACCIDENTALLY_CORRECT"
    } for i in issues):
        candidate = fixed.get("mc3", {}).get("options")
        result = deepcopy(original)
        if isinstance(candidate, list) and len(candidate) == len(original["mc3"]["options"]):
            index = original["mc3"]["correctIndex"]
            for n in range(len(candidate)):
                if n != index:
                    result["mc3"]["options"][n] = candidate[n]
        return result
    return fixed


def repair_items_semantic(
    part: PartBlueprint, content: dict[str, Any], item_issues: dict[str, list[SemanticIssue]]
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Repairs each item in `item_issues` (questionId -> its error-severity
    SemanticIssues) in bounded parallel. Returns (new_content,
    issues_resolved) where issues_resolved is [{"itemId":..., "code":...}]
    for every issue that was targeted (not necessarily confirmed fixed —
    the caller re-verifies)."""
    if not item_issues:
        return content, []

    questions_by_id = {q.get("questionId"): q for q in content.get("questions") or []}
    issues_resolved: list[dict[str, str]] = []

    def _fix_one(item_id: str, issues: list[SemanticIssue]) -> tuple[str, dict[str, Any] | None]:
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _repair_prompt(part, content, item_id, issues)
                result = chat_json(system=system, user=user, max_tokens=1200, model=part.constraints.get("generationModel") or get_settings().german_exam_model)
                fixed = result.data
                if isinstance(fixed, dict) and fixed.get("questionId") == item_id:
                    return item_id, _constrain_repair(questions_by_id[item_id], fixed, issues, part)
            except Exception:  # noqa: BLE001
                log.warning("semantic repair attempt failed for item %s", item_id, exc_info=True)
        return item_id, None

    with ThreadPoolExecutor(max_workers=min(4, len(item_issues))) as pool:
        futures = [pool.submit(copy_context().run, _fix_one, key, value)
                   for key, value in item_issues.items() if key in questions_by_id]
        results = [future.result() for future in futures]

    for item_id, fixed in results:
        if fixed is not None:
            questions_by_id[item_id] = fixed
            for issue in item_issues[item_id]:
                issues_resolved.append({"itemId": item_id, "code": issue.code})

    new_content = dict(content)
    new_content["questions"] = [
        questions_by_id.get(q.get("questionId"), q) for q in content.get("questions") or []
    ]
    return new_content, issues_resolved
