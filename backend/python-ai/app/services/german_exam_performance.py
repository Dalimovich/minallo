"""Shared German Exam Engine — attempt persistence and topic anti-repetition.

This is the SINGLE place attempt-writing logic lives. The Cloudflare results
function (backend/functions/ai-german-exam-results.ts) forwards here rather
than writing to Supabase itself, so profile/module/part/skill-tag validation
and any future score-normalization logic stays in one backend service.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

from ..supabase_client import get_supabase
from .german_exam_adaptation import compute_weakness, instruction_to_dict
from .german_exam_profiles import GermanExamProfileError, get_part, get_profile
from .german_exam_skill_tags import UnknownSkillTagError, validate_tags

_MAX_ITEMS_PER_SUBMISSION = 50


@dataclass
class AttemptItem:
    profile_id: str
    profile_version: int
    module: str
    part_id: str
    task_type: str
    item_id: str
    skill_tags: list[str]
    difficulty: str | None
    attempt_count: int | None
    first_attempt_correct: bool | None
    final_correct: bool | None
    hint_level: int | None
    replay_count: int | None
    transcript_revealed: bool | None
    score_value: float | None
    max_score_value: float | None
    metadata: dict[str, Any]


def _validate_item(user_id: str, item: AttemptItem) -> str | None:
    """Returns an error string if the item should be dropped, else None."""
    try:
        profile = get_profile(item.profile_id)
        get_part(item.profile_id, item.module, item.part_id)
    except GermanExamProfileError as exc:
        return str(exc)
    if item.module not in {"listening", "reading", "writing", "speaking", "language_elements"}:
        return f"unknown module: {item.module}"
    try:
        validate_tags(item.module, item.skill_tags or [])
    except UnknownSkillTagError as exc:
        return str(exc)
    del user_id, profile  # ownership is enforced upstream (trusted userId from the verified JWT)
    return None


def record_attempts(user_id: str, exam_family: str, exam_variant: str | None, target_level: str, items: list[AttemptItem]) -> dict:
    """Batch-validates and inserts attempt rows. Rejects (drops, with a
    reported count) any item whose profile/module/part/skill-tag is unknown
    — never trusts the client's own labeling of its answers."""
    if len(items) > _MAX_ITEMS_PER_SUBMISSION:
        items = items[:_MAX_ITEMS_PER_SUBMISSION]

    rows: list[dict[str, Any]] = []
    dropped = 0
    for item in items:
        err = _validate_item(user_id, item)
        if err:
            dropped += 1
            continue
        rows.append(
            {
                "user_id": user_id,
                "exam_family": exam_family,
                "exam_variant": exam_variant,
                "profile_id": item.profile_id,
                "profile_version": item.profile_version,
                "target_level": target_level,
                "module": item.module,
                "part_id": item.part_id,
                "task_type": item.task_type,
                "item_id": item.item_id,
                "skill_tags": item.skill_tags,
                "difficulty": item.difficulty,
                "attempt_count": item.attempt_count,
                "first_attempt_correct": item.first_attempt_correct,
                "final_correct": item.final_correct,
                "hint_level": item.hint_level,
                "replay_count": item.replay_count,
                "transcript_revealed": item.transcript_revealed,
                "score_value": item.score_value,
                "max_score_value": item.max_score_value,
                "metadata": item.metadata or {},
            }
        )

    if rows:
        get_supabase().table("german_exam_attempts").insert(rows).execute()

    return {"accepted": len(rows), "dropped": dropped}


def get_weakness_snapshot(user_id: str, profile_id: str, module: str) -> dict:
    report = compute_weakness(user_id, profile_id, module)
    return {
        "overallConfidence": report.overall_confidence,
        "tags": {
            tag: {"score": w.score, "nAttempts": w.n_attempts, "confidence": w.confidence}
            for tag, w in report.tags.items()
        },
    }


# ── Topic anti-repetition ───────────────────────────────────────────────────

_RECENT_TOPIC_AVOID_COUNT = 5


def pick_topic(user_id: str, profile_id: str, module: str, part_id: str, candidates: list[dict[str, str]]) -> dict[str, str]:
    """candidates: list of {"topicId": str, "label": str}. Avoids the most
    recently used topics for this (user, profile, module, part)."""
    if not candidates:
        return {"topicId": "general", "label": "General practice"}

    sb = get_supabase()
    resp = (
        sb.table("german_exam_topic_history")
        .select("topic_id")
        .eq("user_id", user_id)
        .eq("profile_id", profile_id)
        .eq("module", module)
        .eq("part_id", part_id)
        .order("used_at", desc=True)
        .limit(_RECENT_TOPIC_AVOID_COUNT)
        .execute()
    )
    recent_ids = {r["topic_id"] for r in (resp.data or [])}

    fresh = [c for c in candidates if c["topicId"] not in recent_ids]
    pool = fresh or candidates  # if every candidate was recently used, allow repeats rather than fail
    return random.choice(pool)


def record_topic_used(user_id: str, profile_id: str, module: str, part_id: str, topic_id: str) -> None:
    try:
        get_supabase().table("german_exam_topic_history").insert(
            {
                "user_id": user_id,
                "profile_id": profile_id,
                "module": module,
                "part_id": part_id,
                "topic_id": topic_id,
            }
        ).execute()
    except Exception:  # noqa: BLE001
        # Topic history is a nice-to-have anti-repetition signal, not
        # load-bearing — never fail generation because this write failed.
        pass
