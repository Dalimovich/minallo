"""Pre-generated German Exam task inventory.

Official telc parts are served from a stock of already-generated, already
validated envelopes (table `german_exam_inventory`) so the learner never waits
on live LLM generation. Serving is a single atomic RPC
(`german_exam_inventory_take`): pick a task this learner has not seen, record
it, return it. When the learner's unseen stock runs low, a daemon thread
generates more in the background — the learner never waits for that either.

Everything here is best-effort and fail-open: if the table/RPC is missing
(migration not applied), the stock is empty/exhausted, or anything raises,
`take()` returns None and the caller falls back to live generation exactly as
before. Replenishment only starts after a take RPC round-trip succeeded, so an
un-migrated database can never trigger paid generation whose result cannot be
stored.

Stocked tasks are official-blueprint, cold-start content (no per-learner
weakness plan) — personalization for stocked parts is by selection/rotation,
never by baking one learner's weaknesses into a shared task.
"""

from __future__ import annotations

import logging
import os
import random
import threading
import uuid
from typing import Any

from ..supabase_client import get_supabase
from . import gen_timing
from .german_exam_profiles import get_part, get_profile

log = logging.getLogger(__name__)

# Speaking has its own cost gate and no stockable generated content.
STOCKED_MODULES = {"listening", "reading", "language_elements", "writing"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def enabled() -> bool:
    return os.getenv("GERMAN_EXAM_INVENTORY_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}


def low_water_mark() -> int:
    return _int_env("GERMAN_EXAM_INVENTORY_LOW", 5)


def target_stock() -> int:
    return _int_env("GERMAN_EXAM_INVENTORY_TARGET", 10)


def max_stock() -> int:
    """Hard ceiling on stocked tasks per part — bounds background spend."""
    return _int_env("GERMAN_EXAM_INVENTORY_MAX", 30)


def batch_per_trigger() -> int:
    return _int_env("GERMAN_EXAM_INVENTORY_BATCH", 3)


def is_stocked(module: str, mode: str, topic_override: str | None) -> bool:
    """A custom topic or the reserved exam_simulation mode always generates live."""
    return enabled() and module in STOCKED_MODULES and mode == "adaptive_practice" and not topic_override


# ── Serving ─────────────────────────────────────────────────────────────────


def take(user_id: str, profile_id: str, module: str, part_id: str) -> dict[str, Any] | None:
    """Returns a ready envelope (fresh generationId, `source: "inventory"`) or
    None when nothing servable exists. Never raises."""
    try:
        profile = get_profile(profile_id)
        rows = (
            get_supabase()
            .rpc(
                "german_exam_inventory_take",
                {
                    "p_user_id": user_id,
                    "p_profile_id": profile_id,
                    "p_module": module,
                    "p_part_id": part_id,
                    "p_profile_version": profile.profile_version,
                },
            )
            .execute()
            .data
        )
    except Exception:  # noqa: BLE001
        log.warning("german-exam inventory take failed; falling back to live generation", exc_info=True)
        return None

    row = rows[0] if isinstance(rows, list) and rows else None
    remaining = int(row["remaining_unserved"]) if row else 0
    if remaining < low_water_mark():
        replenish_async(profile_id, module, part_id, need=target_stock() - remaining)
    if not row or not isinstance(row.get("content"), dict):
        return None

    envelope = dict(row["content"])
    # Fresh per-serve id: attempts/topic-history key on generationId, and the
    # same stocked task is served to many learners.
    envelope["generationId"] = uuid.uuid4().hex
    envelope["inventoryId"] = row["id"]
    envelope["source"] = "inventory"
    return envelope


# ── Replenishment ───────────────────────────────────────────────────────────

_inflight: set[tuple[str, str, str]] = set()
_inflight_lock = threading.Lock()


def replenish_async(profile_id: str, module: str, part_id: str, need: int) -> bool:
    """Starts (at most one per part per process) a daemon thread generating up
    to `need` stocked tasks, capped per trigger and by the per-part ceiling."""
    count = min(need, batch_per_trigger())
    if count <= 0:
        return False
    key = (profile_id, module, part_id)
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight.add(key)
    thread = threading.Thread(
        target=_replenish, args=(profile_id, module, part_id, count), name=f"exam-inventory-{part_id}", daemon=True
    )
    thread.start()
    return True


def _replenish(profile_id: str, module: str, part_id: str, count: int) -> None:
    try:
        for _ in range(count):
            if stock_size(profile_id, module, part_id) >= max_stock():
                break
            if generate_and_store(profile_id, module, part_id) is None:
                break  # a failed generation should not be hammered in a loop
    except Exception:  # noqa: BLE001
        log.exception("german-exam inventory replenish failed part=%s", part_id)
    finally:
        with _inflight_lock:
            _inflight.discard((profile_id, module, part_id))


def stock_size(profile_id: str, module: str, part_id: str) -> int:
    resp = (
        get_supabase()
        .table("german_exam_inventory")
        .select("id", count="exact")
        .eq("profile_id", profile_id)
        .eq("module", module)
        .eq("part_id", part_id)
        .eq("active", True)
        .execute()
    )
    return int(resp.count or 0)


def _pick_stock_topic(profile_id: str, module: str, part_id: str) -> dict[str, str]:
    """Least-represented topic in the current stock, so the bank stays varied."""
    from .german_exam_generator import _topic_bank  # noqa: WPS433 (circular at import time)

    candidates = _topic_bank(module, get_profile(profile_id))
    if not candidates:
        return {"topicId": "general", "label": "General practice"}
    rows = (
        get_supabase()
        .table("german_exam_inventory")
        .select("topic_id")
        .eq("profile_id", profile_id)
        .eq("module", module)
        .eq("part_id", part_id)
        .eq("active", True)
        .execute()
        .data
        or []
    )
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["topic_id"]] = counts.get(r["topic_id"], 0) + 1
    fewest = min(counts.get(c["topicId"], 0) for c in candidates)
    return random.choice([c for c in candidates if counts.get(c["topicId"], 0) == fewest])


def generate_and_store(
    profile_id: str, module: str, part_id: str, source: str = "background", topic: dict[str, str] | None = None
) -> str | None:
    """Generates one official-blueprint task with the normal validation
    pipeline and stores it as approved stock. Returns the inventory id, or
    None if generation failed (nothing is stored on failure)."""
    from .german_exam_generator import generate_stock_task  # noqa: WPS433

    profile = get_profile(profile_id)
    get_part(profile_id, module, part_id)  # validates the (profile, module, part) triple
    chosen = topic or _pick_stock_topic(profile_id, module, part_id)
    # Background work gets a generous wall-clock budget: nobody is waiting.
    with gen_timing.timed_request(module, part_id, budget_s=float(_int_env("GERMAN_EXAM_INVENTORY_BUDGET_S", 600))) as timer:
        try:
            envelope = generate_stock_task(profile_id, module, part_id, chosen)
        except Exception:  # noqa: BLE001
            gen_timing.finish(timer, "error")
            log.exception("german-exam stock generation failed part=%s topic=%s", part_id, chosen.get("topicId"))
            return None
        gen_timing.finish(timer, "ok")

    envelope.pop("generationId", None)
    row = {
        "profile_id": profile_id,
        "profile_version": profile.profile_version,
        "module": module,
        "part_id": part_id,
        "topic_id": chosen["topicId"],
        "content": envelope,
        "quality_status": "approved",
        "generation_source": source,
        "generator_revision": os.getenv("MINALLO_REVISION", "unknown"),
    }
    inserted = get_supabase().table("german_exam_inventory").insert(row).execute().data or []
    return inserted[0]["id"] if inserted else None
