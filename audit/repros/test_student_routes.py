"""Real stream orchestration, model/retrieval boundaries mocked; not browser E2E."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/python-ai/tests'))
from test_conversational_evidence_resolution import (
    _consume, _stream_router_common_mocks, _mock_tutor_state, _mock_empty_retrieval_and_cache,
)

PRIOR = [
    {'role':'user','text':'Explain this diagram'},
    {'role':'assistant','text':'The previous page shows a beam.', 'groundingMode':'relevance','sourceScope':'course_files'},
]

def test_deictic_viewer_should_not_answer_only_from_previous_page(monkeypatch):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    _mock_empty_retrieval_and_cache(monkeypatch)
    from app.services import general_answer, openai_client
    monkeypatch.setattr(openai_client, 'get_openai_client', lambda: (_ for _ in ()).throw(TimeoutError('semantic unavailable')))
    captured = []
    def general(question, **kwargs):
        captured.append({'question':question, **kwargs})
        yield {'t':'Answer based on previous conversation.'}
        yield {'done':True,'model':'fixture'}
    monkeypatch.setattr(general_answer, 'stream_general_answer', general)
    payload = router.AskStreamRequest(
        courseId='course-1', question='What does this mean?', previousTurns=PRIOR,
        groundingRequest={'retrievalScope':{'type':'course'},'viewerContext':{'documentId':'11111111-1111-4111-8111-111111111111','visiblePage':8}},
        visiblePageContext='Current page eight: a completely different electrical circuit.',
    )
    body = asyncio.run(_consume(router,payload,'audit-deictic-page'))
    print(body.decode())
    assert not captured, 'Visible deictic request incorrectly entered conversation-only model'

def test_professor_location_should_request_fresh_evidence(monkeypatch):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    _mock_empty_retrieval_and_cache(monkeypatch)
    from app.services import retrieval, openai_client
    monkeypatch.setattr(openai_client, 'get_openai_client', lambda: (_ for _ in ()).throw(TimeoutError('semantic unavailable')))
    calls = []
    monkeypatch.setattr(retrieval, 'retrieve_chunks', lambda **kwargs: calls.append(kwargs) or [])
    monkeypatch.setattr(router, '_load_authorized_documents', lambda *_args, **_kwargs: {})
    payload = router.AskStreamRequest(courseId='course-1',question='Where exactly does the professor say that?',previousTurns=PRIOR)
    body = asyncio.run(_consume(router,payload,'audit-professor-location'))
    print(body.decode())
    assert calls, 'Exact professor location did not attempt fresh retrieval'
