"""scripts/semantic_blind_ab_transcript.py: the shared transcript builder
every semantic-intent eval arm must use. These checks exist so "never
reads turn['expected'] for any turn" is a provable fact a reviewer can
run, not just a docstring claim -- see that module's docstring, including
the 2026-10-24 correction (an earlier version picked its reply TEMPLATE by
gold form/release, which is itself a leak even with no label/number in
the text)."""

import copy
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
    _REPLIES_DE, _REPLIES_EN, assistant_reply_for, build_history_turns, load_corpus, load_holdout,
)

_DIGIT_RE = re.compile(r"\d")
_LABEL_WORD_RE = re.compile(r"\bsection:|exercise\s*\d|aufgabe\s*\d", re.IGNORECASE)


@pytest.mark.parametrize("reply", list(_REPLIES_EN) + list(_REPLIES_DE))
def test_no_reply_contains_a_digit_or_a_label(reply):
    assert not _DIGIT_RE.search(reply), f"reply leaks a number: {reply!r}"
    assert not _LABEL_WORD_RE.search(reply), f"reply leaks a label: {reply!r}"


def test_assistant_reply_for_takes_no_gold_derived_argument():
    """Static contract check: the function's only parameters are
    language/turn_index. If a future edit adds a form/release/target
    parameter back, this signature check fails loudly instead of silently
    reintroducing the 2026-10-24 leak."""
    import inspect

    params = set(inspect.signature(assistant_reply_for).parameters)
    assert params == {"language", "turn_index"}, (
        f"assistant_reply_for must take ONLY language/turn_index, got {params} -- "
        "adding a gold-derived parameter reintroduces the 2026-10-24 leak"
    )


@pytest.mark.parametrize("corpus_loader", [load_corpus, load_holdout])
def test_mutating_expected_labels_never_changes_the_built_history(corpus_loader):
    """The mechanical proof the module docstring promises: rewrite every
    turn's entire `expected` list (and verifiedAnswer/waitForStudent, for
    good measure) to deliberately wrong/nonsense values, across BOTH the
    main corpus and the holdout, and assert the built history is
    byte-identical to what the untouched corpus produces."""
    corpus = corpus_loader()
    mutated = copy.deepcopy(corpus)
    for scenario in mutated["cases"]:
        for turn in scenario["turns"]:
            turn["expected"] = [{"target": "NONSENSE-999", "form": "nonsense_form", "release": "nonsense_release"}]
            turn["waitForStudent"] = not turn.get("waitForStudent", False)
            turn["verifiedAnswer"] = "NONSENSE-ANSWER"

    for original_scenario, mutated_scenario in zip(corpus["cases"], mutated["cases"]):
        for turn_index in range(len(original_scenario["turns"])):
            original_history = build_history_turns(original_scenario, turn_index)
            mutated_history = build_history_turns(mutated_scenario, turn_index)
            assert original_history == mutated_history, (
                f"{original_scenario['id']} turn_index={turn_index}: mutating expected "
                "labels changed the built history -- gold leakage reintroduced"
            )


def test_build_history_turns_never_includes_the_current_or_later_turn():
    corpus = load_corpus()
    scenario = next(c for c in corpus["cases"] if c["id"] == "AB-24")  # 3-turn scenario
    history = build_history_turns(scenario, upto_turn_index=2)
    assert len(history) == 4  # two (user, assistant) pairs for turns 0 and 1
    assert history[0] == {"role": "user", "text": scenario["turns"][0]["student"]}
    assert history[2] == {"role": "user", "text": scenario["turns"][1]["student"]}
    assert scenario["turns"][2]["student"] not in [h["text"] for h in history]


def test_build_history_turns_empty_for_first_turn():
    corpus = load_corpus()
    scenario = corpus["cases"][0]
    assert build_history_turns(scenario, upto_turn_index=0) == []


def test_build_history_turns_uses_the_scenario_language():
    corpus = load_corpus()
    de_scenario = next(c for c in corpus["cases"] if c["language"] == "de" and len(c["turns"]) > 1)
    history = build_history_turns(de_scenario, upto_turn_index=1)
    assert history[1]["text"] in _REPLIES_DE
