"""scripts/semantic_blind_ab_transcript.py: the shared, gold-independent
transcript builder every semantic-intent eval arm must use. These checks
exist specifically so "no template leaks a label or a number" is a provable
fact a reviewer can run, not just a docstring claim -- see that module's
docstring for the full rationale (the bug it closes)."""

import re
import sys
from pathlib import Path

import pytest

# See test_qa_budget.py for why this guarded reimport exists (tests/scripts/
# vs backend/python-ai/scripts/ package-name collision under pytest's own
# sys.path ordering).
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])
_scripts_pkg = sys.modules.get("scripts")
_scripts_already_correct = _scripts_pkg is not None and any(
    Path(p).resolve() == Path(_BACKEND_ROOT, "scripts") for p in getattr(_scripts_pkg, "__path__", [])
)
if not _scripts_already_correct:
    if _BACKEND_ROOT in sys.path:
        sys.path.remove(_BACKEND_ROOT)
    sys.path.insert(0, _BACKEND_ROOT)
    for _name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
        del sys.modules[_name]

from scripts.semantic_blind_ab_transcript import (  # noqa: E402
    GENERIC_ASSISTANT_REPLY, assistant_reply_for, build_history_turns, load_corpus,
)

_DIGIT_RE = re.compile(r"\d")
# Exercise/section label shapes the corpus actually uses (see
# policy_compiler._EXERCISE_LABEL_RE / "section:<name>" / "document").
_LABEL_WORD_RE = re.compile(r"\bsection:|exercise\s*\d|aufgabe\s*\d", re.IGNORECASE)


@pytest.mark.parametrize("key_reply", list(GENERIC_ASSISTANT_REPLY.items()))
def test_no_template_contains_a_digit_or_a_label(key_reply):
    _key, reply = key_reply
    assert not _DIGIT_RE.search(reply), f"template leaks a number: {reply!r}"
    assert not _LABEL_WORD_RE.search(reply), f"template leaks a label: {reply!r}"


def test_fallback_reply_is_also_label_and_number_free():
    fallback = assistant_reply_for("some_future_form", "some_future_release")
    assert not _DIGIT_RE.search(fallback)
    assert not _LABEL_WORD_RE.search(fallback)


def test_every_corpus_form_release_pair_has_a_real_template():
    """The fallback should never actually fire against today's real
    corpus -- if it would, that pair is missing from the table above and
    needs a real, considered template, not a generic catch-all."""
    corpus = load_corpus()
    missing = set()
    for scenario in corpus["cases"]:
        for turn in scenario["turns"]:
            for entry in turn["expected"]:
                key = (entry["form"], entry["release"])
                if key not in GENERIC_ASSISTANT_REPLY:
                    missing.add(key)
    assert not missing, f"corpus uses (form, release) pairs with no real template: {sorted(missing)}"


def test_build_history_turns_never_includes_the_current_or_later_turn():
    corpus = load_corpus()
    scenario = next(c for c in corpus["cases"] if c["id"] == "AB-24")  # 3-turn scenario
    history = build_history_turns(scenario, upto_turn_index=2)
    assert len(history) == 4  # two (user, assistant) pairs for turns 0 and 1
    assert history[0] == {"role": "user", "text": scenario["turns"][0]["student"]}
    assert history[2] == {"role": "user", "text": scenario["turns"][1]["student"]}
    # Must not contain turn index 2's own student text (the turn under test).
    assert scenario["turns"][2]["student"] not in [h["text"] for h in history]


def test_build_history_turns_empty_for_first_turn():
    corpus = load_corpus()
    scenario = corpus["cases"][0]
    assert build_history_turns(scenario, upto_turn_index=0) == []
