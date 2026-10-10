"""DSH Hörverstehen delivery state machine — the authoritative rules for the two-play flow.

MPO §10(1)1 / §10(4)1b (2025): the lecture is presented exactly TWICE; processing time is 10 minutes
after the first and 40 minutes after the second presentation (the presentation itself does not count).

    ready --start_play--> playing_1 --playback_ended--> processing_1 --(10 min)--> awaiting_play_2
      --start_play--> playing_2 --playback_ended--> processing_2 --submit / (40 min)--> submitted | expired

Design rules:
  * The state is a plain JSON-serialisable dict; `advance()` is a pure function (state, event, now) ->
    new state. The browser mirrors it (frontend/js/features/german-exam/dsh-hv-playback.ts) and both
    are checked against the SAME vectors (tests/fixtures/dsh-hv-playback-vectors.json).
  * `playsStarted` is incremented when a play STARTS and the caller must persist the new state BEFORE
    the audio starts. A reload in the middle of a play therefore cannot restore the play: `recover()`
    treats an interrupted play as consumed.
  * There is no third play and no play while a processing window runs; an illegal event raises.

LIMITATION (documented, not hidden): a client-held state can be cleared by the user. Making the play
count tamper-proof needs a server-side attempt record (table + endpoint + migration), which is
FUTURE WORK. This module is the rule set that server record will reuse.
"""

from __future__ import annotations

from typing import Any

from .registry import get_part
from .shared import GermanExamProfileError

SCHEMA_VERSION = 1
MAX_PLAYS = 2
PHASES = ("ready", "playing_1", "processing_1", "awaiting_play_2", "playing_2", "processing_2", "submitted", "expired")
TERMINAL_PHASES = ("submitted", "expired")
# The timings are read from the DSH profile's own HV part, never repeated here.
_WINDOWS_MS = {w["afterPresentation"]: w["seconds"] * 1000
               for w in get_part("dsh", "listening", "hv_1").constraints["processingWindows"]}


class PlaybackError(GermanExamProfileError):
    """An event that the DSH two-play flow does not allow in the current state."""


def new_state(attempt_id: str) -> dict[str, Any]:
    if not isinstance(attempt_id, str) or not attempt_id:
        raise PlaybackError("attempt_id is required")
    return {"schemaVersion": SCHEMA_VERSION, "attemptId": attempt_id, "phase": "ready", "playsStarted": 0,
            "playsCompleted": 0, "windowDeadlineMs": None}


def _validate(state: dict[str, Any]) -> None:
    if state.get("schemaVersion") != SCHEMA_VERSION or state.get("phase") not in PHASES:
        raise PlaybackError("invalid playback state")
    if not isinstance(state.get("playsStarted"), int) or not 0 <= state["playsStarted"] <= MAX_PLAYS:
        raise PlaybackError("invalid play count")


def _tick(state: dict[str, Any], now_ms: int) -> dict[str, Any]:
    deadline = state["windowDeadlineMs"]
    if deadline is None or now_ms < deadline:
        return state
    if state["phase"] == "processing_1":
        return {**state, "phase": "awaiting_play_2", "windowDeadlineMs": None}
    if state["phase"] == "processing_2":
        return {**state, "phase": "expired", "windowDeadlineMs": None}
    return state


def advance(state: dict[str, Any], event: str, now_ms: int) -> dict[str, Any]:
    """Return the next state. Events: start_play, playback_ended, tick, submit."""
    _validate(state)
    if not isinstance(now_ms, int) or isinstance(now_ms, bool) or now_ms < 0:
        raise PlaybackError("now_ms must be a non-negative integer")
    state = _tick(state, now_ms)  # a lapsed window always resolves first, whatever the event is
    phase = state["phase"]
    if event == "tick":
        return state
    if event == "start_play":
        if phase == "ready":
            return {**state, "phase": "playing_1", "playsStarted": 1}
        if phase == "awaiting_play_2":
            return {**state, "phase": "playing_2", "playsStarted": 2}
        raise PlaybackError(f"cannot start a play in phase {phase!r} (plays started: {state['playsStarted']})")
    if event == "playback_ended":
        if phase in ("playing_1", "playing_2"):
            n = 1 if phase == "playing_1" else 2
            return {**state, "phase": f"processing_{n}", "playsCompleted": n, "windowDeadlineMs": now_ms + _WINDOWS_MS[n]}
        raise PlaybackError(f"no play is running in phase {phase!r}")
    if event == "submit":
        if phase == "processing_2":
            return {**state, "phase": "submitted", "windowDeadlineMs": None}
        raise PlaybackError(f"submission opens after the second presentation (phase {phase!r})")
    raise PlaybackError(f"unknown event {event!r}")


def recover(state: dict[str, Any], now_ms: int) -> dict[str, Any]:
    """Resume after a reload. A play that was interrupted counts as consumed: the play is over and
    its processing window starts now — it is never granted again."""
    _validate(state)
    if state["phase"] in ("playing_1", "playing_2"):
        state = advance(state, "playback_ended", now_ms)
    return advance(state, "tick", now_ms)


def can_start_play(state: dict[str, Any], now_ms: int) -> bool:
    try:
        advance(state, "start_play", now_ms)
        return True
    except PlaybackError:
        return False


def remaining_ms(state: dict[str, Any], now_ms: int) -> int | None:
    deadline = _tick(state, now_ms)["windowDeadlineMs"]
    return None if deadline is None else max(0, deadline - now_ms)
