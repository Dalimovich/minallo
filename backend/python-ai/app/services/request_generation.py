"""Best-effort stale-request protection within each service process."""

from __future__ import annotations

from threading import Lock


_latest: dict[tuple[str, str], int] = {}
_lock = Lock()


def register_generation(user_id: str, conversation_id: str | None, generation: int | None) -> None:
    if not conversation_id or generation is None:
        return
    key = (user_id, conversation_id)
    with _lock:
        _latest[key] = max(generation, _latest.get(key, -1))


def is_current_generation(
    user_id: str,
    conversation_id: str | None,
    generation: int | None,
) -> bool:
    if not conversation_id or generation is None:
        return True
    with _lock:
        return generation >= _latest.get((user_id, conversation_id), generation)


def clear_generations_for_tests() -> None:
    with _lock:
        _latest.clear()


__all__ = ["clear_generations_for_tests", "is_current_generation", "register_generation"]
