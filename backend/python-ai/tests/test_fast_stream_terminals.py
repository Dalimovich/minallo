"""Provider failure injection through the actual fast stream endpoint."""
import asyncio
import json
import pytest
from test_conversational_evidence_resolution import _consume, _stream_router_common_mocks


@pytest.mark.parametrize('events,expected', [
    ([{'done': True}], 'empty_completed_response'),
    ([{'t': 'Useful partial answer'}], 'stream_ended_without_terminal_event'),
])
def test_fast_provider_requires_nonempty_answer_and_terminal_confirmation(monkeypatch, events, expected):
    from app.services import general_answer
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter(events))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='', question='What is torque?'), 'fast-terminal-test'))
    decoded = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminals = [e for e in decoded if e.get('done') or e.get('error')]
    assert len(terminals) == 1
    assert terminals[0].get('code') == expected
    assert terminals[0]['error'] is True


def test_fast_provider_discards_events_after_completion(monkeypatch):
    from app.services import general_answer
    router = _stream_router_common_mocks(monkeypatch)
    def provider(*a, **k):
        yield {'t': 'The completed answer.'}
        yield {'done': True}
        raise RuntimeError('late provider failure after completion')
    monkeypatch.setattr(general_answer, 'stream_general_answer', provider)
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='', question='What is torque?'), 'fast-terminal-test'))
    assert b'"error": true' not in body
    assert body.count(b'"done": true') == 1
