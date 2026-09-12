import asyncio
import pytest
from test_conversational_evidence_resolution import _consume, _stream_router_common_mocks


@pytest.mark.parametrize('question,expected', [
    ('What is the quadratic formula?', 'general'),
    ('Which checkbox is marked on this page?', 'visible_page_capture_failed'),
])
def test_unavailable_optional_image_is_resolved_by_actual_evidence_requirement(monkeypatch, question, expected):
    from app.services import general_answer
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter([
        {'t': 'General answer'}, {'done': True},
    ]))
    monkeypatch.setattr(router, '_load_authorized_documents', lambda *a: (_ for _ in ()).throw(AssertionError('unexpected lookup')))
    body = asyncio.run(_consume(router, router.AskStreamRequest(
        question=question, courseId='course-a', activeDocumentId='00000000-0000-4000-8000-000000000002',
        visiblePage=7, activePdfVisible=True, visualEvidenceExpected=True, openFileImages=[],
    ), 'optional-viewer-evidence'))
    if expected == 'general':
        assert b'General answer' in body
        assert b'"executionLane": "fast_general"' in body
    else:
        assert expected.encode() in body
        assert b'General answer' not in body
