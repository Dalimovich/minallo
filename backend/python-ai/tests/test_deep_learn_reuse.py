"""Unit tests for Deep Learn lesson reuse (deep_learn_reuse.py)."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import deep_learn_reuse as reuse  # noqa: E402


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Records every filter call so tests can assert on the exact predicate
    sent to Supabase, and returns canned rows on execute()."""

    def __init__(self, rows):
        self._rows = rows
        self.calls: list[tuple[str, tuple, dict]] = []

    def _record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        return self

    def table(self, *a, **kw):
        return self._record("table", *a, **kw)

    def select(self, *a, **kw):
        return self._record("select", *a, **kw)

    def eq(self, *a, **kw):
        return self._record("eq", *a, **kw)

    def gte(self, *a, **kw):
        return self._record("gte", *a, **kw)

    def order(self, *a, **kw):
        return self._record("order", *a, **kw)

    def limit(self, *a, **kw):
        return self._record("limit", *a, **kw)

    def execute(self):
        return _FakeResult(self._rows)

    def gte_value(self):
        for name, args, _ in self.calls:
            if name == "gte" and args and args[0] == "updated_at":
                return args[1]
        raise AssertionError("no gte('updated_at', ...) call was recorded")


def test_a_lesson_saved_before_the_prompt_fix_cutoff_is_not_reused(monkeypatch):
    # The whole point of _PROMPT_FIX_CUTOFF: a lesson generated under an
    # older, less strict prompt must not be handed back as if it were fresh
    # just because it's within max_age_days. Without this, a math-formatting
    # fix to the prompt would never actually reach a student re-opening a
    # topic they'd already generated before the fix shipped.
    stale_row = {
        "id": "n1", "title": "T", "content_markdown": "raw text, no $ delimiters",
        "lesson_status": "ready",
        "updated_at": (reuse._PROMPT_FIX_CUTOFF - timedelta(days=1)).isoformat(),
        "visual_ids": [],
    }
    fake = _FakeQuery([stale_row])
    monkeypatch.setattr(reuse, "get_supabase", lambda: fake)

    reuse.find_existing_lesson(
        user_id="u1", course_id="c1", topic="screws", revision_hash="rev1",
    )

    # The fake query is a dumb recorder — it doesn't actually filter by the
    # gte() value — so the real assertion is on the predicate ITSELF, which
    # Supabase would apply: it must exclude this row.
    gte_value = fake.gte_value()
    assert gte_value >= reuse._PROMPT_FIX_CUTOFF.isoformat()
    assert datetime.fromisoformat(stale_row["updated_at"]) < datetime.fromisoformat(gte_value)


def test_the_effective_cutoff_is_never_older_than_the_prompt_fix_even_with_a_long_max_age(monkeypatch):
    fake = _FakeQuery([])
    monkeypatch.setattr(reuse, "get_supabase", lambda: fake)

    reuse.find_existing_lesson(
        user_id="u1", course_id="c1", topic="screws", revision_hash="rev1",
        max_age_days=3650,  # ~10 years — would predate the cutoff on its own
    )

    gte_value = datetime.fromisoformat(fake.gte_value())
    assert gte_value >= reuse._PROMPT_FIX_CUTOFF


def test_a_short_max_age_window_still_wins_once_the_prompt_fix_is_old_enough(monkeypatch):
    # Once _PROMPT_FIX_CUTOFF itself is old news (the next prompt fix will move
    # it forward again, but this one is now stale relative to "today"), a
    # short max_age_days must go back to being the effective, more recent
    # cutoff — this fix must not permanently override normal freshness once
    # it's no longer the newest thing that happened.
    monkeypatch.setattr(reuse, "_PROMPT_FIX_CUTOFF", datetime(2000, 1, 1, tzinfo=timezone.utc))
    fake = _FakeQuery([])
    monkeypatch.setattr(reuse, "get_supabase", lambda: fake)

    reuse.find_existing_lesson(
        user_id="u1", course_id="c1", topic="screws", revision_hash="rev1",
        max_age_days=1,
    )

    gte_value = datetime.fromisoformat(fake.gte_value())
    expected_age_cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    assert abs((gte_value - expected_age_cutoff).total_seconds()) < 5
