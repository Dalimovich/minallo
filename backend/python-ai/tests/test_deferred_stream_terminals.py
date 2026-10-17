"""Adversarial audit probes: assertions describe required behavior, not the defect."""
import asyncio
import json

import pytest
from starlette.responses import StreamingResponse

from test_conversational_evidence_resolution import _consume, _mock_tutor_state, _stream_router_common_mocks


@pytest.mark.parametrize('first_terminal,late', [
    ('done', 'token'), ('done', 'error'), ('done', 'timeout'), ('error', 'done'),
])
def test_deferred_provider_not_consumed_after_terminal(monkeypatch, first_terminal, late):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    advanced = []

    async def provider():
        yield b'data: {"t":"Useful scoped answer."}\n\n'
        yield ('data: ' + json.dumps({first_terminal: True}) + '\n\n').encode()
        advanced.append(True)
        if late == 'timeout':
            raise TimeoutError('injected post-completion timeout')
        data = {'t': 'LATE TOKEN'} if late == 'token' else {late: True}
        yield ('data: ' + json.dumps(data) + '\n\n').encode()

    async def prepare(*args, **kwargs):
        return StreamingResponse(provider(), media_type='text/event-stream')

    monkeypatch.setattr(router, '_prepare_ask_stream_response', prepare)
    body = asyncio.run(_consume(router, router.AskStreamRequest(
        courseId='', question='What is torsion?', sourceMode='internet',
    ), 'audit-deferred-terminal'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminals = [event for event in events if event.get('done') or event.get('error')]
    assert len(terminals) == 1, events
    assert not advanced, 'Provider was consumed beyond its terminal event'
    assert b'LATE TOKEN' not in body


def test_deferred_empty_completion_is_error(monkeypatch):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)

    async def prepare(*args, **kwargs):
        return StreamingResponse(iter([b'data: {"done":true}\n\n']), media_type='text/event-stream')

    monkeypatch.setattr(router, '_prepare_ask_stream_response', prepare)
    body = asyncio.run(_consume(router, router.AskStreamRequest(
        courseId='', question='What is torsion?', sourceMode='internet',
    ), 'audit-deferred-empty'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminals = [event for event in events if event.get('done') or event.get('error')]
    assert len(terminals) == 1
    assert terminals[0].get('error') is True
    assert terminals[0].get('code') == 'empty_completed_response'



