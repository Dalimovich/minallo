"""Shared, gold-independent conversation-history builder for the
semantic_blind_ab_corpus.json / semantic_blind_ab_holdout.json evaluation
harnesses (2026-10-23 fix, 2026-10-24 correction).

Problem history:

1. (2026-10-23) Both original harnesses built fake prior-assistant-turn
   text FROM the gold ``expected`` answer -- one wrote the gold target
   label directly into the placeholder text, the other had no assistant
   turn at all. Fixed by sharing one transcript builder across every arm.

2. (2026-10-24 correction) That first fix was STILL gold-dependent: it
   looked up a reply template by this turn's own ``(form, release)`` pair
   -- so even with no label or number in the text, which TEMPLATE got
   picked still revealed the gold teaching mode and restriction state
   (e.g. picking the "hint, I won't give the result away" template IS
   telling the interpreter under test that this turn was correctly a
   hint request with release withheld). Confirmed correct to flag: that
   is gold leakage, just moved from the text's CONTENT into the text's
   SELECTION.

Fix: ``assistant_reply_for`` below takes ONLY ``language`` and
``turn_index`` -- never ``form``, ``release``, ``target``,
``verifiedAnswer``, or any other field of ``turn["expected"]``, and never
even the student's own message text (which risks a reviewer's judgment
call smuggling in form/release information while "reading" it). It cycles
through a small, FIXED, independently-authored set of content-free
acknowledgments, selected by ``turn_index % len(REPLIES)`` -- a value
computable before the corpus is even loaded. This is mechanically,
exhaustively provable rather than merely asserted: test_semantic_blind_ab_
transcript.py's ``test_mutating_expected_labels_never_changes_the_built_
history`` rewrites every scenario's ``expected`` entries to nonsense
values and asserts byte-identical history output.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Content-free by construction: no exercise/section/document label, no
# number, no claim about correctness, teaching mode, or restriction state.
# Selected by turn_index % len(...) only -- see module docstring.
_REPLIES_EN: tuple[str, ...] = (
    "Okay, let's work through this together.",
    "Got it -- let's continue from here.",
    "Sure, let's take a look.",
    "Alright, one moment while we go through that.",
)
_REPLIES_DE: tuple[str, ...] = (
    "Okay, lass uns das gemeinsam angehen.",
    "Verstanden -- machen wir weiter.",
    "Klar, schauen wir uns das an.",
    "Gut, einen Moment, wir gehen das durch.",
)


def assistant_reply_for(*, language: str, turn_index: int) -> str:
    """``turn_index`` is the 0-based index of the turn this reply FOLLOWS
    (i.e. it is the synthetic assistant reply inserted after
    ``scenario["turns"][turn_index]``). Takes no gold-derived argument at
    all -- see module docstring."""
    replies = _REPLIES_DE if language == "de" else _REPLIES_EN
    return replies[turn_index % len(replies)]


def build_history_turns(scenario: dict, upto_turn_index: int) -> list[dict]:
    """Real previous turns for ``scenario['turns'][upto_turn_index]`` --
    every student turn strictly before it, each followed by a gold-
    independent synthetic assistant reply. ``upto_turn_index`` is 0-based
    into ``scenario['turns']``; for index 0 this returns ``[]`` (no prior
    turns at all). Never reads ``turn["expected"]`` for any turn --
    confirmed by test_mutating_expected_labels_never_changes_the_built_
    history, not merely by this docstring."""
    history: list[dict] = []
    for index, turn in enumerate(scenario["turns"][:upto_turn_index]):
        history.append({"role": "user", "text": turn["student"]})
        history.append({
            "role": "assistant",
            "text": assistant_reply_for(language=scenario["language"], turn_index=index),
        })
    return history


def load_corpus() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))


def load_documents() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))


def load_holdout() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_holdout.json").read_text(encoding="utf-8"))
