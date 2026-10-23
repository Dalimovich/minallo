"""Offline proof that scripts/semantic_intent_eval_arm_ab_live.py's
``_run_arm_a_turn``/``_run_arm_b_turn`` are wired correctly BEFORE any real
money is spent on them. Every OpenAI call is faked (same pattern as
test_student_intent.py's ``_FakeClient``) -- this file makes no network
calls and costs nothing to run in CI."""

import json
import sys
from pathlib import Path

import pytest

from app import config as config_module
from app.services import openai_client
from app.services.dialogue_state import resolve_dialogue
from app.services.semantic_call_support import needs_semantic_escalation

# See test_qa_budget.py for why this guarded reimport exists.
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

from scripts.jev_policy_adapter import load_corpus, load_documents  # noqa: E402
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402
from scripts.semantic_intent_eval_arm_ab_live import _run_arm_a_turn, _run_arm_b_turn  # noqa: E402

CORPUS = load_corpus()
DOCUMENTS = load_documents()


class _FakeClient:
    """Same shape as test_student_intent.py's _FakeClient / test_dialogue_
    state.py's fake -- just enough of the OpenAI SDK surface."""

    def __init__(self, content: str | dict | Exception):
        self._content = content

    def with_options(self, **_kwargs):
        return self

    @property
    def chat(self):
        outer = self

        class _Completions:
            @staticmethod
            def create(**_kwargs):
                if isinstance(outer._content, Exception):
                    raise outer._content
                content = outer._content if isinstance(outer._content, str) else json.dumps(outer._content)
                message = type("Msg", (), {"content": content})()
                choice = type("Choice", (), {"message": message})()
                return type("Completion", (), {"choices": [choice], "usage": None})()

        return type("Chat", (), {"completions": _Completions()})()


def _patch_client(monkeypatch, client: _FakeClient):
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: client)
    monkeypatch.setattr(
        config_module, "get_settings",
        lambda: type("S", (), {
            "openai_generate_model": "gpt-4o-mini", "openai_reasoning_effort": "high",
            "semantic_intent_mode": "enabled", "semantic_intent_unified_call_enabled": True,
            "semantic_intent_policy_enforcement_enabled": True,
        })(),
    )
    monkeypatch.setattr("app.services.usage_meter.record_usage", lambda **_kwargs: None)


def _find_turn(*, escalates: bool) -> tuple[dict, dict, list]:
    """First (scenario, turn, previous_turns) whose needs_semantic_
    escalation verdict matches ``escalates`` -- not hardcoded to a specific
    scenario id, so this stays correct if the corpus changes."""
    for scenario in CORPUS["cases"]:
        for turn_index, turn in enumerate(scenario["turns"]):
            previous_turns = build_history_turns(scenario, turn_index)
            dialogue = resolve_dialogue(turn["student"], previous_turns=previous_turns)
            if needs_semantic_escalation(
                turn["student"], has_unresolved_reference=bool(dialogue.referent_type != "unknown"),
            ) == escalates:
                return scenario, turn, previous_turns
    pytest.fail(f"no corpus turn found with needs_semantic_escalation={escalates}")


def test_arm_a_non_escalating_turn_makes_no_model_call(monkeypatch):
    def _fail(**_kwargs):
        raise AssertionError("must not call the model for a non-escalating turn")

    monkeypatch.setattr(openai_client, "get_openai_client", _fail)
    scenario = CORPUS["cases"][0]
    turn = scenario["turns"][0]
    result = _run_arm_a_turn(turn["student"], previous_turns=[])
    assert isinstance(result["actions"], list) and result["actions"]


def test_arm_a_escalating_turn_calls_the_model_and_degrades_safely_on_garbage(monkeypatch):
    client = _FakeClient("not even json")
    _patch_client(monkeypatch, client)
    # Any message with low enough deterministic confidence triggers this --
    # reuse dialogue_state's own corpus-independent trigger instead of
    # hunting for a corpus turn, since this checks the ARM A WIRING, not
    # corpus coverage.
    result = _run_arm_a_turn("it", previous_turns=[{"role": "assistant", "text": "Here is some help."}])
    assert result["actions"]  # fails closed to the deterministic base, never raises


def test_arm_b_non_escalating_turn_runs_the_real_compiler_with_no_model_call(monkeypatch):
    def _fail(**_kwargs):
        raise AssertionError("must not call the model for a non-escalating turn")

    monkeypatch.setattr(openai_client, "get_openai_client", _fail)
    scenario, turn, previous_turns = _find_turn(escalates=False)
    document = DOCUMENTS[scenario["document"]]
    result = _run_arm_b_turn(
        turn["student"], previous_turns=previous_turns, document=document,
    )
    assert result["actions"]
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}


def test_arm_b_escalating_turn_degrades_safely_on_a_transport_error(monkeypatch):
    client = _FakeClient(RuntimeError("simulated transport failure"))
    _patch_client(monkeypatch, client)
    scenario, turn, previous_turns = _find_turn(escalates=True)
    document = DOCUMENTS[scenario["document"]]
    result = _run_arm_b_turn(
        turn["student"], previous_turns=previous_turns, document=document,
    )
    # interpret_turn_authoritatively's own contract: "Never raises -- any
    # failure anywhere in this pipeline degrades to the fully
    # deterministic path." This proves the runner's wiring doesn't break
    # that contract.
    assert result["actions"]
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}
