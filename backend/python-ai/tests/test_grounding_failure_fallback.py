"""Endpoint failure injection: required evidence cannot be substituted on outage."""
import asyncio
import json

import pytest

from test_conversational_evidence_resolution import _consume, _mock_tutor_state, _stream_router_common_mocks
from app.services import general_answer


@pytest.mark.parametrize('scenario', ['explicit-course', 'grounded-verification', 'explicit-course-wording'])
def test_grounding_outage_does_not_substitute_general_answer(monkeypatch, scenario):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    monkeypatch.setattr(router, '_load_authorized_documents', lambda *_: {})
    calls = []

    async def prepare(*args, **kwargs):
        raise RuntimeError('injected retrieval outage')

    def general(*args, **kwargs):
        calls.append(True)
        yield {'t': 'UNAPPROVED GENERAL SUBSTITUTE'}
        yield {'done': True}

    monkeypatch.setattr(router, '_prepare_ask_stream_response', prepare)
    monkeypatch.setattr(general_answer, 'stream_general_answer', general)
    question = 'Are you sure?' if scenario == 'grounded-verification' else (
        'What do my course files say about torsion?' if scenario == 'explicit-course-wording' else 'What is torsion?')
    turns = [{'role': 'user', 'text': 'Explain torsion'}, {'role': 'assistant', 'text': 'Torsion twists a shaft.',
        'answerMode': 'course', 'groundingMode': 'relevance', 'sourceScope': 'course_files'}] if scenario == 'grounded-verification' else []
    body = asyncio.run(_consume(router, router.AskStreamRequest(
        courseId='course-a', question=question, sourceMode='course_files' if scenario == 'explicit-course' else 'auto',
        previousTurns=turns,
    ), 'audit-grounding-failure'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    assert not calls, events
    terminals = [event for event in events if event.get('done') or event.get('error')]
    assert len(terminals) == 1 and terminals[0].get('error') is True, events


def test_deferred_error_terminal_survives_state_write_outage(monkeypatch):
    from app.services import conversation_store
    from app.routers.stream import TutorPipelineError
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    failures = []

    def persist(**kwargs):
        if kwargs.get('stage') == 'request_preflight':
            return None
        failures.append(kwargs)
        raise OSError('injected state storage outage')

    async def prepare(*args, **kwargs):
        raise TutorPipelineError(code='injected_generation_failure', stage='model_generation',
                                 message='Injected model failure', retryable=True, recoverable=True)

    monkeypatch.setattr(conversation_store, 'update_tutor_request', persist)
    monkeypatch.setattr(conversation_store, 'append_tutor_commentary', lambda **kwargs: None)
    monkeypatch.setattr(router, '_prepare_ask_stream_response', prepare)
    body = asyncio.run(_consume(router, router.AskStreamRequest(
        courseId='', question='What is torsion?', sourceMode='internet',
        durableConversation=True, conversationId='00000000-0000-4000-8000-000000000088',
        clientMessageId='audit-user-message', assistantMessageId='audit-assistant-message',
    ), 'audit-error-persistence'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminals = [event for event in events if event.get('done') or event.get('error')]
    assert failures
    assert len(terminals) == 1 and terminals[0].get('code') == 'injected_generation_failure', events
