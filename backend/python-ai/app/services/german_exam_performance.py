"""Shared German Exam Engine — attempt persistence and topic anti-repetition.

This is the SINGLE place attempt-writing logic lives. The Cloudflare results
function (backend/functions/ai-german-exam-results.ts) forwards here rather
than writing to Supabase itself, so profile/module/part/skill-tag validation
and any future score-normalization logic stays in one backend service.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass
from typing import Any

from ..supabase_client import get_supabase
from .german_exam_adaptation import compute_weakness
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
    # Ties this attempt back to the exact POST /german-exam/generate call
    # that produced the item (envelope.generationId) — not independently
    # derivable/validated server-side (unlike profile/task_type), so it's
    # recorded as supplied, same trust level as item_id itself.
    generation_id: str | None = None


def _resolve_item(item: AttemptItem) -> tuple[dict[str, Any], str | None]:
    """Derives every exam-structure field the client cannot be trusted to
    self-report (profile family/variant/CEFR/version, task type, skill-tag
    membership) from the profile registry via profile_id + part_id, rather
    than trusting the browser's own copies of them — a client-poisoned
    submission (stale cache, tampered payload, a future profile-id/level
    mismatch bug) must not silently corrupt the weakness model with a
    profile_version, task_type, or skill_tags that don't actually match the
    server-authoritative part definition. Returns (row_fields, error)."""
    try:
        profile = get_profile(item.profile_id)
        part = get_part(item.profile_id, item.module, item.part_id)
    except GermanExamProfileError as exc:
        return {}, str(exc)

    tags = item.skill_tags or []
    try:
        validate_tags(part.module, tags)
    except UnknownSkillTagError as exc:
        return {}, str(exc)
    unknown_for_part = sorted(set(tags) - set(part.allowed_skill_tags))
    if unknown_for_part:
        return {}, f"skill tags not allowed for part {part.part_id!r}: {unknown_for_part}"

    return {
        "exam_family": profile.family,
        "exam_variant": profile.variant,
        "profile_id": profile.profile_id,
        "profile_version": profile.profile_version,
        "target_level": profile.cefr_level,
        "module": part.module,
        "part_id": part.part_id,
        "task_type": part.task_type,
        "skill_tags": tags,
    }, None


def record_attempts(user_id: str, exam_family: str, exam_variant: str | None, target_level: str, items: list[AttemptItem]) -> dict:
    """Batch-validates and inserts attempt rows. Rejects (drops, with a
    reported count) any item whose profile/module/part/skill-tag is unknown.
    `exam_family`/`exam_variant`/`target_level` arguments are accepted for
    request-shape backward-compat only and are NOT written — every
    structural field is derived server-side per item from the profile
    registry (see `_resolve_item`), never trusted from the client."""
    del exam_family, exam_variant, target_level
    if len(items) > _MAX_ITEMS_PER_SUBMISSION:
        items = items[:_MAX_ITEMS_PER_SUBMISSION]

    rows: list[dict[str, Any]] = []
    dropped = 0
    for item in items:
        resolved, err = _resolve_item(item)
        if err:
            dropped += 1
            continue
        rows.append(
            {
                "user_id": user_id,
                "exam_family": resolved["exam_family"],
                "exam_variant": resolved["exam_variant"],
                "profile_id": resolved["profile_id"],
                "profile_version": resolved["profile_version"],
                "target_level": resolved["target_level"],
                "module": resolved["module"],
                "part_id": resolved["part_id"],
                "task_type": resolved["task_type"],
                "item_id": item.item_id,
                "skill_tags": resolved["skill_tags"],
                "difficulty": item.difficulty,
                "attempt_count": item.attempt_count,
                "first_attempt_correct": None if resolved["module"] == "writing" else item.first_attempt_correct,
                "final_correct": None if resolved["module"] == "writing" else item.final_correct,
                "hint_level": item.hint_level,
                "replay_count": item.replay_count,
                "transcript_revealed": item.transcript_revealed,
                "score_value": item.score_value,
                "max_score_value": item.max_score_value,
                "metadata": item.metadata or {},
                "generation_id": item.generation_id,
            }
        )

    if rows:
        # One scored submission per generated writing task. A lost HTTP response
        # followed by Save retry must not double-count the rubric in Weak Areas.
        writing_rows = [row for row in rows if row["module"] == "writing" and row["generation_id"]]
        other_rows = [row for row in rows if row not in writing_rows]
        sb = get_supabase()
        for row in writing_rows:
            row["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL,
                f"minallo:writing:{user_id}:{row['profile_id']}:{row['generation_id']}:{row['item_id']}"))
        if writing_rows:
            sb.table("german_exam_attempts").upsert(writing_rows, on_conflict="id", ignore_duplicates=True).execute()
        if other_rows:
            sb.table("german_exam_attempts").insert(other_rows).execute()

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


def record_topic_used(
    user_id: str, profile_id: str, module: str, part_id: str, topic_id: str, generation_id: str | None = None
) -> None:
    """`generation_id`, when supplied, is an idempotency key: a repeated
    call for the same generation_id must not record the topic as used a
    second time. This matters specifically for the prefetch consume path
    (POST /german-exam/consume) — unlike the direct-generation path, which
    calls this exactly once inside generate_task(), a consume call could
    plausibly be retried (a flaky network response the frontend re-sends,
    a duplicate click) without this guarantee."""
    row = {
        "user_id": user_id,
        "profile_id": profile_id,
        "module": module,
        "part_id": part_id,
        "topic_id": topic_id,
        "generation_id": generation_id,
    }
    try:
        table = get_supabase().table("german_exam_topic_history")
        if generation_id:
            table.upsert(row, on_conflict="generation_id", ignore_duplicates=True).execute()
        else:
            table.insert(row).execute()
    except Exception:  # noqa: BLE001
        # Topic history is a nice-to-have anti-repetition signal, not
        # load-bearing — never fail generation because this write failed.
        pass
