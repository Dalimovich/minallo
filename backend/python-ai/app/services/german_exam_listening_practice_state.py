"""Server-side grading state for the generated (AI) Hören practice path —
public.german_exam_listening_practice_generations.

Same role as german_exam_dsh_practice_state.py plays for DSH's practice path: the generate step
writes the answer-bearing grading_content here instead of handing it to the browser, and grading
reads it back server-side. The shape of the read differs from DSH's on purpose — DSH's path is
one generation, one grading submission, consumed exactly once (`claim_generation_for_grading`
sets `graded_at`); Hören's path is one generation holding MANY questions, each graded
independently as the learner reaches it, and a question may legitimately be re-attempted after a
hint (the existing attempts/hintLevel UX). There is therefore no one-time-use claim here:
get_grading_entry() is a plain read, gated only by ownership (user_id) and expiry (expires_at),
and may be called more than once for the same question.

Unknown generation id, wrong owner, expired row, and unknown questionId within an otherwise
valid row all return None — this module does not and must not distinguish between them, so a
caller can never learn whether a generation exists for another user."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase

TABLE = "german_exam_listening_practice_generations"


def create_generation(user_id: str, part_id: str, grading_content: dict[str, Any], *, generation_id: str) -> str:
    """Inserts one row with id=generation_id (the hex id generate_task() already minted for this
    envelope — a uuid column accepts a 32-char hex string with or without dashes, so no
    conversion is needed), defaulting to the table's own 2-hour expires_at. Returns that same id
    unchanged, so the caller never needs a second id concept: the existing `generationId` already
    threaded through the envelope/attemptsBuffer/results doubles as this row's grading-claim
    key."""
    sb = get_supabase()
    response = (
        sb.table(TABLE)
        .insert({"id": generation_id, "user_id": user_id, "part_id": part_id, "grading_content": grading_content})
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise RuntimeError(f"{TABLE} insert returned no row")
    return str(rows[0]["id"])


def get_grading_entry(user_id: str, generation_id: str, question_id: str) -> dict[str, Any] | None:
    """Returns the stored grading entry for one question — {taskType, correct,
    evidenceSegmentIds?} — only if `generation_id` belongs to `user_id`, has not expired, and
    actually contains `question_id`. Returns None, indistinguishably, for an unknown generation
    id, a different owner, an expired row, or an unknown question id — callers must treat every
    None the same way (fail closed, generic error)."""
    sb = get_supabase()
    now_iso = datetime.now(timezone.utc).isoformat()
    response = (
        sb.table(TABLE)
        .select("grading_content")
        .eq("id", generation_id)
        .eq("user_id", user_id)
        .gt("expires_at", now_iso)
        .execute()
    )
    rows = response.data or []
    if not rows:
        return None
    grading_content = rows[0]["grading_content"] or {}
    entry = grading_content.get(question_id)
    if not isinstance(entry, dict):
        return None
    return dict(entry)
