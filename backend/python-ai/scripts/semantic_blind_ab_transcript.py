"""Shared, gold-independent conversation-history builder for the
semantic_blind_ab_corpus.json evaluation harnesses (2026-10-23 fix).

Problem this closes: both existing harnesses built fake prior-assistant-turn
text FROM the gold ``expected`` answer:
``semantic_intent_deterministic_baseline.py``'s ``_placeholder_assistant_
text`` literally wrote ``f"[placeholder prior answer about {targets}]"``
using ``turn["expected"][*]["target"]`` -- so turn 2+ of 24 of the corpus's
35 scenarios handed the interpreter the correct exercise label for free,
before it ever had to resolve a reference itself. ``jev_corpus_
evaluation.py`` had the opposite, equally unfair problem: it never included
ANY assistant turn in the ``state`` string it sent Jev, only prior STUDENT
lines -- less information than a real multi-turn conversation would ever
have, and a DIFFERENT context shape than the deterministic arm got. Neither
harness's turn-2+ accuracy numbers are comparable to each other OR to what a
real multi-turn conversation would present.

Fix: every arm gets the IDENTICAL, real transcript, built once here. Each
assistant reply is looked up by this turn's own ``(form, release)`` pair
from a small, fixed, generic template table -- NEVER by reading
``expected``'s target label, NEVER by reading ``verifiedAnswer``. No
template below names an exercise/section/document label or a concrete
numeric value, by construction: this is not merely "the harness autho
happened not to leak this time", every row in GENERIC_ASSISTANT_REPLY was
hand-checked to contain no label and no number. A reviewer can verify this
mechanically (test_semantic_blind_ab_transcript.py does, via regex over
every template string) rather than trusting this docstring alone.

This means a turn like AB-24's "Frag mich die Lagerkraft R_A ab." (quiz,
target resolved from context, no number in the student's own words at all)
gets an assistant reply like "Alright, I'll ask you instead -- what do you
think the answer is?" -- never "...for exercise 1" -- so turn 2's "80 N?"
still has to be resolved by the interpreter under test, not handed the
answer by the fixture.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Keyed by (form, release) exactly as they appear in semantic_blind_ab_
# corpus.json's "expected" entries. Deliberately generic: no label, no
# number, no verifiedAnswer text, ever -- see module docstring.
GENERIC_ASSISTANT_REPLY: dict[tuple[str, str], str] = {
    ("hint", "prohibited"): (
        "Here's a nudge in the right direction -- I won't give away the "
        "final result, so try the next step yourself first."
    ),
    ("confirmation", "partial"): (
        "That step looks right so far, but I'll let you finish working "
        "through it rather than confirming the final result for you."
    ),
    ("confirmation", "prohibited"): (
        "Not quite -- let's revisit the underlying idea rather than me "
        "just correcting the number directly."
    ),
    ("method_explanation", "prohibited"): (
        "Here's how the underlying method works, in general terms -- "
        "I'm not plugging in the actual numbers for this one."
    ),
    ("method_explanation", "permitted"): (
        "Here's how that works, step by step, now that we've already "
        "been through the full numbers for it."
    ),
    ("full_solution", "permitted"): (
        "Here's the complete worked solution, all the way through to "
        "the final result."
    ),
    ("full_solution", "ambiguous_expect_clarify_or_both"): (
        "Could you clarify which part you mean, or would you like me "
        "to cover both?"
    ),
    ("hint", "ambiguous_expect_clarify_or_both"): (
        "Could you clarify which part you'd like a hint for, or would "
        "you like one for each?"
    ),
    ("quiz_start", "prohibited"): (
        "Alright, I'll ask you instead -- what do you think the answer is?"
    ),
    ("answer_check", "permitted"): "That's correct!",
    ("answer_check", "prohibited"): "Not quite right -- want to try again?",
    ("summary", "permitted"): "Here's a summary of what the document covers.",
}

_FALLBACK_REPLY = "Okay, here's some help with that."


def assistant_reply_for(form: str, release: str) -> str:
    """Looked up by this turn's own (form, release) -- the one thing a
    real assistant turn would actually reflect -- never by target label or
    numeric answer. The fallback only fires for a (form, release)
    combination not present in the corpus today; test_fixture_covers_
    every_required_category-style coverage means it should never actually
    be hit, but a harness must not crash if the corpus grows a new pair."""
    return GENERIC_ASSISTANT_REPLY.get((form, release), _FALLBACK_REPLY)


def build_history_turns(scenario: dict, upto_turn_index: int) -> list[dict]:
    """Real previous turns for ``scenario['turns'][upto_turn_index]`` --
    every student turn strictly before it, each followed by a gold-
    independent synthetic assistant reply keyed off THAT turn's own
    (form, release). ``upto_turn_index`` is 0-based into ``scenario['turns']``;
    for index 0 this returns ``[]`` (no prior turns at all)."""
    history: list[dict] = []
    for turn in scenario["turns"][:upto_turn_index]:
        history.append({"role": "user", "text": turn["student"]})
        # A turn's own expected list may have >1 entry (multi-target) --
        # the synthetic reply only needs to reflect ONE representative
        # (form, release) shape, not enumerate every target; the FIRST
        # entry is used deliberately (arbitrary but fixed, so the same
        # transcript is produced on every run).
        first = turn["expected"][0]
        history.append({
            "role": "assistant",
            "text": assistant_reply_for(first["form"], first["release"]),
        })
    return history


def load_corpus() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))


def load_documents() -> dict:
    return json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))
