"""Explicit evidence must survive early execution shortcuts (real route)."""
import asyncio
import json

import pytest

from app.services.execution_router import ExecutionLane, resolve_execution_plan
from app.services.grounding_contract import ResolvedDocumentAccess
from test_conversational_evidence_resolution import (
    _consume, _mock_tutor_state, _stream_router_common_mocks,
)


@pytest.mark.parametrize('question', [
    'What is torsion?', 'Calculate 8 times 9.', 'Compare steel and aluminium.',
    'Explain that more simply.',
])
def test_explicit_web_mode_controls_execution_independently_of_task(question):
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline='relevance', source_mode='internet', has_previous_answer=True,
    )
    assert plan.executionLane is ExecutionLane.WEB


@pytest.mark.parametrize('selected', [False, True], ids=['explicit-web', 'selected-documents'])
def test_explicit_scope_cannot_exit_through_general_shortcut(monkeypatch, selected):
    from app.services import general_answer
    from starlette.responses import StreamingResponse
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    document_id = '00000000-0000-4000-8000-000000000002'
    monkeypatch.setattr(router, '_load_authorized_documents', lambda *_: {})
    calls = []
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter([
        {'t': 'Unapproved general answer'}, {'done': True},
    ]))

    async def prepare(payload, user, status_sink=None, request_id=None, preflight=None):
        calls.append(payload)
        return StreamingResponse(iter([b'data: {"t":"Scoped provider answer"}\n\ndata: {"done":true}\n\n']), media_type='text/event-stream')

    monkeypatch.setattr(router, '_prepare_ask_stream_response', prepare)
    payload = router.AskStreamRequest(
        courseId='course-a' if selected else '', question='What is torsion?',
        sourceMode='auto' if selected else 'internet',
        groundingRequest={'retrievalScope': {'type': 'documents', 'documentIds': [document_id]}} if selected else None,
    )
    body = asyncio.run(_consume(router, payload, 'explicit-scope-request'))
    assert calls, body.decode()
    assert b'Unapproved general answer' not in body
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    assert sum(bool(e.get('done') or e.get('error')) for e in events) == 1
    if selected:
        assert calls[0].documentIds == [document_id]
        assert calls[0].courseFileScope == 'specific_files'
