import asyncio
import json
from types import SimpleNamespace
import pytest
from app.services import dialogue_state, general_answer, openai_client
from test_conversational_evidence_resolution import _consume, _stream_router_common_mocks


@pytest.mark.parametrize('question', ['Can you explain that another way?', 'Explain that difference more simply.'])
@pytest.mark.parametrize('grounded', [False, True])
def test_known_task_family_still_resolves_contextual_referent_on_model_outage(monkeypatch, question, grounded):
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(openai_client, 'get_openai_client', lambda: (_ for _ in ()).throw(TimeoutError('injected timeout')))
    turns = [{'role': 'user', 'text': 'Explain static and kinetic friction'}, {'role': 'assistant',
        'text': 'Static friction resists starting motion; kinetic friction opposes sliding.',
        'groundingMode': 'relevance' if grounded else 'general',
        'sourceScope': 'course_files' if grounded else 'general_knowledge'}]
    captured = []
    def generate(*a, **kwargs):
        captured.extend(kwargs.get('previous_turns') or [])
        yield {'t': 'Let us restate the distinction.'}
        yield {'done': True}
    monkeypatch.setattr(general_answer, 'stream_general_answer', generate)
    monkeypatch.setattr(router, '_load_authorized_documents', lambda *a: (_ for _ in ()).throw(AssertionError('unexpected retrieval')))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='course-a', question=question, previousTurns=turns), 'semantic-gate-journey'))
    assert b'"executionLane": "fast_contextual"' in body
    assert captured and 'friction' in captured[-1]['text']
    assert b'Let us restate' in body


@pytest.mark.parametrize('question', ['Explain photosynthesis.', 'Compare steel and aluminium.'])
def test_explicit_new_subject_does_not_inherit_previous_goal(question):
    turns = [{'role': 'user', 'text': 'Explain friction'}, {'role': 'assistant', 'text': 'Friction opposes sliding.'}]
    base = dialogue_state.resolve_dialogue(question, previous_turns=turns)
    assert not dialogue_state.needs_semantic_resolution(question, base, turns)
    assert base.relation is dialogue_state.TurnRelation.NEW_TOPIC


@pytest.mark.parametrize('bad', ['', '{broken', '{"relation":"bogus"}', json.dumps({
    'relation': 'continuation', 'speechAct': 'answer', 'taskFamily': 'explain',
    'continuesPreviousGoal': 'false', 'resolvedRequest': ['bad'], 'confidence': 0.99,
})])
def test_malformed_semantic_output_uses_safe_conversation_fallback(monkeypatch, bad):
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **k: SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=bad))]))))
    monkeypatch.setattr(openai_client, 'get_openai_client', lambda: client)
    turns = [{'role': 'assistant', 'text': 'The prior explanation', 'groundingMode': 'general'}]
    base = dialogue_state.resolve_dialogue('Please explain that differently', previous_turns=turns)
    result = dialogue_state.resolve_dialogue_semantically('Please explain that differently', previous_turns=turns, base=base)
    assert result.confidence == 0.55
    assert result.evidence_requirement is dialogue_state.EvidenceRequirement.CONVERSATION_ONLY


@pytest.mark.parametrize('confidence', [float('nan'), float('inf'), True, 4.0])
def test_invalid_semantic_confidence_uses_safe_fallback(monkeypatch, confidence):
    data = dict(relation='continuation', speechAct='answer', taskFamily='explain',
                continuesPreviousGoal=True, resolvedRequest='Explain the prior answer', confidence=confidence)
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs:
        SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(data)))]))))
    monkeypatch.setattr(openai_client, 'get_openai_client', lambda: client)
    turns = [{'role': 'assistant', 'text': 'The prior answer', 'groundingMode': 'general'}]
    base = dialogue_state.resolve_dialogue('Explain that differently', previous_turns=turns)
    result = dialogue_state.resolve_dialogue_semantically('Explain that differently', previous_turns=turns, base=base)
    assert result.confidence == 0.55
