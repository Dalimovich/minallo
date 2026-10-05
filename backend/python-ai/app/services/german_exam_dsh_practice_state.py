"""Server-side grading state for the DSH LV/HV practice path — public.dsh_lv_hv_practice_generations.

Closes the gap audited across 336cc2c2/1a173aad: the generate/grade endpoints previously had to
hand the full generated content (answer key included) back to the browser because nothing held
it server-side between the two calls. This module is that hold.

create_generation() stores german_exam_dsh_grading.minimal_grading_content()'s output — grading-
essential fields only (question/maxPoints/requiredPoints/optionalPoints/gradingNotes per item),
never referenceAnswer/errorfulVariant (generation-quality-only, grading never reads them) and
never the lecture/source text or any other learner/UI metadata the grader never touches.

claim_generation_for_grading() is the ONLY read path, and it is also the write that marks the
generation consumed — ownership, expiry and one-time-use are all enforced by a single atomic SQL
UPDATE (one PostgREST PATCH request = one UPDATE statement; Postgres evaluates the WHERE clause
and applies the update as one indivisible operation, so two concurrent calls for the same
generation can never both match the IS NULL check — whichever reaches Postgres first claims the
row, and the second matches zero rows). Unknown id, wrong user, expired, and already-graded all
produce the exact same empty result from here — this module does not and must not distinguish
between them, so a caller can never learn whether a generation exists for another user.

Practice-only: nothing here is read by or written to dsh_result.py, and no DSH PartBlueprint
reads this table either."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase

TABLE = "dsh_lv_hv_practice_generations"


def create_generation(user_id: str, part: str, grading_content: dict[str, Any]) -> str:
    """Inserts one row, defaulting to the table's own 30-minute expires_at. Returns the new
    row's id — this becomes `generationId` in the learner-facing response."""
    sb = get_supabase()
    response = (
        sb.table(TABLE)
        .insert({"user_id": user_id, "part": part, "grading_content": grading_content})
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise RuntimeError("dsh_lv_hv_practice_generations insert returned no row")
    return str(rows[0]["id"])


def claim_generation_for_grading(user_id: str, generation_id: str) -> dict[str, Any] | None:
    """Atomically claims the generation for grading: sets graded_at (so it can never be claimed
    again) and returns its stored grading_content, but ONLY if `generation_id` belongs to
    `user_id`, has not expired, and has not already been graded. Returns None, indistinguishably,
    for an unknown id, a different owner, an expired row, or an already-graded row — the caller
    must treat every None the same way (fail closed, generic error)."""
    sb = get_supabase()
    now_iso = datetime.now(timezone.utc).isoformat()
    response = (
        sb.table(TABLE)
        .update({"graded_at": now_iso})
        .eq("id", generation_id)
        .eq("user_id", user_id)
        .is_("graded_at", "null")
        .gt("expires_at", now_iso)
        .execute()
    )
    rows = response.data or []
    if not rows:
        return None
    return dict(rows[0]["grading_content"])
