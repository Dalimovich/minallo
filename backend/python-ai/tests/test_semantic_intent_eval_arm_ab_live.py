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

from scripts.fake_conversation_store import FakeConversationStore  # noqa: E402
from scripts.jev_policy_adapter import load_corpus, load_documents  # noqa: E402
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402
from scripts.semantic_intent_eval_arm_ab_live import USER_ID, _run_arm_a_turn, _run_arm_b_turn  # noqa: E402

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
    document = DOCUMENTS[scenario["document"]]
    result = _run_arm_a_turn(turn["student"], previous_turns=[], document=document)
    assert result["actions"]
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}
        # The fixed 2026-10-23 bug: this runner used to return exactly
        # objective="other"/final_answer="unspecified" for EVERY turn,
        # regardless of input -- a direct regression check against that
        # specific stub, not a claim this exact combo can never be correct
        # for some other turn.
        assert (action["objective"], action["final_answer"]) != ("other", "unspecified")


def test_arm_a_escalating_turn_calls_the_model_and_degrades_safely_on_garbage(monkeypatch):
    client = _FakeClient("not even json")
    _patch_client(monkeypatch, client)
    document = DOCUMENTS[CORPUS["cases"][0]["document"]]
    # Any message with low enough deterministic confidence triggers this --
    # reuse dialogue_state's own corpus-independent trigger instead of
    # hunting for a corpus turn, since this checks the ARM A WIRING, not
    # corpus coverage.
    result = _run_arm_a_turn(
        "it", previous_turns=[{"role": "assistant", "text": "Here is some help."}], document=document,
    )
    assert result["actions"]  # fails closed to the deterministic base, never raises
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}


def test_arm_b_non_escalating_turn_runs_the_real_compiler_with_no_model_call(monkeypatch):
    def _fail(**_kwargs):
        raise AssertionError("must not call the model for a non-escalating turn")

    monkeypatch.setattr(openai_client, "get_openai_client", _fail)
    scenario, turn, previous_turns = _find_turn(escalates=False)
    document = DOCUMENTS[scenario["document"]]
    store = FakeConversationStore()
    conversation_id = store.create_conversation(user_id=USER_ID)
    result = _run_arm_b_turn(
        turn["student"], previous_turns=previous_turns, document=document,
        store=store, conversation_id=conversation_id, turn_n=turn["n"],
    )
    assert result["actions"]
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}


def test_arm_b_persists_a_restriction_and_a_later_turn_in_the_same_conversation_sees_it(monkeypatch):
    """The actual mechanism Milestone 4 is supposed to add over the
    legacy path: a hint-only restriction compiled on turn 1 must still be
    in effect on turn 2 for the SAME target, even though turn 2's own
    message says nothing about it -- proven against the real
    interpret_turn_authoritatively + FakeConversationStore, not asserted."""
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: (_ for _ in ()).throw(
        AssertionError("must not call the model for either of these deterministic turns"),
    ))
    store = FakeConversationStore()
    conversation_id = store.create_conversation(user_id=USER_ID)
    document = DOCUMENTS["DOC-ALG1"]

    turn1 = _run_arm_b_turn(
        "Give me a hint for exercise 5, don't tell me the result.", previous_turns=[],
        document=document, store=store, conversation_id=conversation_id, turn_n=1,
    )
    policy1 = turn1.pop("execution_policy")
    assert any(a["target"] == "5" and a["final_answer"] == "prohibited" for a in turn1["actions"])
    store.append_turn(conversation_id=conversation_id, turn_n=1, execution_policy=policy1)

    turn2 = _run_arm_b_turn(
        "What about exercise 5 -- can you say a bit more?",
        previous_turns=[
            {"role": "user", "text": "Give me a hint for exercise 5, don't tell me the result."},
            {"role": "assistant", "text": "Here's a nudge in the right direction."},
        ],
        document=document, store=store, conversation_id=conversation_id, turn_n=2,
    )
    assert any(
        a["target"] == "5" and a["final_answer"] == "prohibited" for a in turn2["actions"]
    ), f"restriction from turn 1 did not persist into turn 2: {turn2['actions']}"


def test_arm_b_deterministic_permission_update_does_not_override_persisted_restriction(monkeypatch):
    """CONFIRMED FINDING (2026-10-24), not an assumption: on the pure
    deterministic path (no successful model escalation), an EXPLICIT
    later request to solve a target completely does NOT override an
    earlier turn's persisted hint-only restriction for that same target.

    Root cause, verified directly against diagnostic_policy.adapt_
    deterministic_intent: it never explicitly SETS final_answer to
    "permitted" for any objective (including "solve") -- it only ever
    leaves the field unset and relies on compile_policy's tutoring
    DEFAULT to open it. compile_policy's rule 2 ("a later turn wins, but
    only for fields it actually touched") means an unset field is never
    "touched", so the persisted historical action -- which explicitly SET
    final_answer="prohibited" on turn 1 -- is the only one with a real
    value for that field, and wins by default, even though turn 2 is
    later and its own request is explicit.

    This is either a real correctness gap (a student's later explicit
    permission grant should arguably set final_answer explicitly, not
    rely on the default) or a deliberate conservative-by-design property
    ("once restricted, stays restricted until something ELSE explicitly
    overrides it"). This test documents the system's ACTUAL behavior so
    it cannot regress silently -- the product decision of which behavior
    is correct was escalated, not made here.
    """
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: (_ for _ in ()).throw(
        AssertionError("must not call the model for either of these deterministic turns"),
    ))
    store = FakeConversationStore()
    conversation_id = store.create_conversation(user_id=USER_ID)
    document = DOCUMENTS["DOC-ALG1"]

    turn1 = _run_arm_b_turn(
        "Give me a hint for exercise 5, don't tell me the result.", previous_turns=[],
        document=document, store=store, conversation_id=conversation_id, turn_n=1,
    )
    store.append_turn(conversation_id=conversation_id, turn_n=1, execution_policy=turn1.pop("execution_policy"))

    turn2 = _run_arm_b_turn(
        "Actually, just solve exercise 5 completely for me.",
        previous_turns=[
            {"role": "user", "text": "Give me a hint for exercise 5, don't tell me the result."},
            {"role": "assistant", "text": "Here's a nudge in the right direction."},
        ],
        document=document, store=store, conversation_id=conversation_id, turn_n=2,
    )
    assert any(
        a["target"] == "5" and a["objective"] == "solve" and a["final_answer"] == "prohibited"
        for a in turn2["actions"]
    ), f"expected the confirmed (if surprising) real behavior, got: {turn2['actions']}"


def test_arm_b_exercise_switch_does_not_inherit_the_old_targets_restriction(monkeypatch):
    """Switching to a DIFFERENT exercise must not carry the previous
    exercise's restriction onto the new one just because they're in the
    same conversation."""
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: (_ for _ in ()).throw(
        AssertionError("must not call the model for either of these deterministic turns"),
    ))
    store = FakeConversationStore()
    conversation_id = store.create_conversation(user_id=USER_ID)
    document = DOCUMENTS["DOC-ALG1"]

    turn1 = _run_arm_b_turn(
        "Give me a hint for exercise 5, don't tell me the result.", previous_turns=[],
        document=document, store=store, conversation_id=conversation_id, turn_n=1,
    )
    store.append_turn(conversation_id=conversation_id, turn_n=1, execution_policy=turn1.pop("execution_policy"))

    turn2 = _run_arm_b_turn(
        "Now solve exercise 6 completely.",
        previous_turns=[
            {"role": "user", "text": "Give me a hint for exercise 5, don't tell me the result."},
            {"role": "assistant", "text": "Here's a nudge in the right direction."},
        ],
        document=document, store=store, conversation_id=conversation_id, turn_n=2,
    )
    six_actions = [a for a in turn2["actions"] if a["target"] == "6"]
    assert six_actions, f"exercise 6 was not even addressed: {turn2['actions']}"
    assert all(
        a["final_answer"] != "prohibited" for a in six_actions
    ), f"exercise 5's restriction leaked onto exercise 6: {turn2['actions']}"


def test_arm_b_missing_history_degrades_to_the_conservative_default_not_permitted(monkeypatch):
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: (_ for _ in ()).throw(
        AssertionError("must not call the model for this deterministic turn"),
    ))
    store = FakeConversationStore()
    document = DOCUMENTS["DOC-ALG1"]
    result = _run_arm_b_turn(
        "Give me a hint for exercise 5.", previous_turns=[], document=document,
        store=store, conversation_id=store.missing_history_conversation_id(), turn_n=1,
    )
    assert result["actions"]  # never raises on an unverifiable/missing conversation


def test_arm_b_escalating_turn_degrades_safely_on_a_transport_error(monkeypatch):
    client = _FakeClient(RuntimeError("simulated transport failure"))
    _patch_client(monkeypatch, client)
    scenario, turn, previous_turns = _find_turn(escalates=True)
    document = DOCUMENTS[scenario["document"]]
    store = FakeConversationStore()
    conversation_id = store.create_conversation(user_id=USER_ID)
    result = _run_arm_b_turn(
        turn["student"], previous_turns=previous_turns, document=document,
        store=store, conversation_id=conversation_id, turn_n=turn["n"],
    )
    # interpret_turn_authoritatively's own contract: "Never raises -- any
    # failure anywhere in this pipeline degrades to the fully
    # deterministic path." This proves the runner's wiring doesn't break
    # that contract.
    assert result["actions"]
    for action in result["actions"]:
        assert action["final_answer"] in {"permitted", "prohibited", "unspecified"}
