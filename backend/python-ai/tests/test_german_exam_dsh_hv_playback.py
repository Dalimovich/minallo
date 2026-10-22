"""DSH HV two-play state machine (MPO §10(1)1, §10(4)1b): max two plays, both windows, no reload reset.

The scripted vectors are shared with the browser mirror (tests/frontend/dsh-hv-playback.test.mjs)."""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest

from app.services.german_exams.dsh_hv_playback import (
    MAX_PLAYS, TERMINAL_PHASES, PlaybackError, advance, can_start_play, new_state, recover, remaining_ms,
)

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/dsh-hv-playback-vectors.json").read_text(encoding="utf8"))


def _apply(state, event, now):
    return recover(state, now) if event == "recover" else advance(state, event, now)


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_scripted_vectors(vector) -> None:
    state = new_state(VECTORS["attemptId"])
    for step in vector["steps"]:
        if step.get("expectError"):
            with pytest.raises(PlaybackError):
                _apply(state, step["event"], step["nowMs"])
            continue
        state = _apply(state, step["event"], step["nowMs"])
        for key, value in step["expect"].items():
            assert state[key] == value, (vector["name"], step, key, state)


def test_windows_come_from_the_profile() -> None:
    s = advance(new_state("a"), "start_play", 0)
    s = advance(s, "playback_ended", 1000)
    assert s["windowDeadlineMs"] == 1000 + 600_000
    s = advance(advance(s, "tick", 700_000), "start_play", 700_000)
    s = advance(s, "playback_ended", 800_000)
    assert s["windowDeadlineMs"] == 800_000 + 2_400_000
    assert remaining_ms(s, 800_000 + 60_000) == 2_340_000


def test_never_more_than_two_plays_over_every_short_event_sequence() -> None:
    events = ("start_play", "playback_ended", "tick", "submit", "recover")
    times = (0, 599_999, 600_000, 3_100_000)
    for seq in itertools.product(events, repeat=6):
        state = new_state("a")
        for i, event in enumerate(seq):
            now = times[i % len(times)] + i
            try:
                state = _apply(state, event, now)
            except PlaybackError:
                continue
            assert state["playsStarted"] <= MAX_PLAYS
            assert state["playsCompleted"] <= state["playsStarted"]


def test_reload_cannot_reset_or_extend_the_play_count() -> None:
    state = advance(new_state("a"), "start_play", 0)
    persisted = json.loads(json.dumps(state))  # what storage would hold across a reload
    resumed = recover(persisted, 10_000)
    assert resumed["playsStarted"] == 1 and not can_start_play(resumed, 10_001)
    for now in (10_002, 20_000, 30_000):  # reloading again never returns to a startable "ready"
        resumed = recover(json.loads(json.dumps(resumed)), now)
        assert resumed["playsStarted"] >= 1 and resumed["phase"] != "ready"


def test_terminal_phases_accept_nothing() -> None:
    state = new_state("a")
    for event, now in (("start_play", 0), ("playback_ended", 1), ("tick", 700_000), ("start_play", 700_001),
                       ("playback_ended", 700_002), ("submit", 700_003)):
        state = advance(state, event, now)
    assert state["phase"] in TERMINAL_PHASES
    for event in ("start_play", "playback_ended", "submit"):
        with pytest.raises(PlaybackError):
            advance(state, event, 800_000)


@pytest.mark.parametrize("bad", [{"schemaVersion": 2}, {"phase": "bogus"}, {"playsStarted": 3}, {"playsStarted": -1}])
def test_corrupt_state_is_rejected(bad) -> None:
    state = {**new_state("a"), **bad}
    with pytest.raises(PlaybackError):
        advance(state, "tick", 0)
    with pytest.raises(PlaybackError):
        recover(state, 0)


def test_browser_mirror_uses_the_same_windows_as_the_profile() -> None:
    from app.services.german_exams import get_part

    ts = (Path(__file__).resolve().parents[3] / "frontend/js/features/german-exam/dsh-hv-playback.ts").read_text(encoding="utf8")
    windows = {w["afterPresentation"]: w["seconds"] * 1000 for w in get_part("dsh", "listening", "hv_1").constraints["processingWindows"]}
    assert f"{{ 1: {windows[1]:_}, 2: {windows[2]:_} }}" in ts


def test_time_must_be_a_non_negative_integer() -> None:
    for bad in (-1, 1.5, True, None):
        with pytest.raises(PlaybackError):
            advance(new_state("a"), "tick", bad)
    with pytest.raises(PlaybackError):
        new_state("")
