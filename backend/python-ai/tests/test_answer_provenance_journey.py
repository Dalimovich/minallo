import asyncio
import json
from app.services.dialogue_state import EvidenceRequirement, resolve_dialogue
from test_conversational_evidence_resolution import _consume, _stream_router_common_mocks, _GROUNDED_PREVIOUS_TURNS
from test_conversation_store import FakeSupabase


def test_grounded_answer_clarification_then_verification_retains_evidence(monkeypatch):
    from app.services import general_answer
    monkeypatch.setattr('app.services.openai_client.get_openai_client', lambda: (_ for _ in ()).throw(TimeoutError('injected semantic timeout')))
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter([
        {'t': 'Same lecture result, explained simply.'}, {'done': True},
    ]))
    turns = list(_GROUNDED_PREVIOUS_TURNS)
    for index in range(2):
        question = 'that went over my head'
        body = asyncio.run(_consume(router, router.AskStreamRequest(
            courseId='course-a', question=question, previousTurns=turns,
        ), f'provenance-journey-{index}'))
        events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
        done = next(e for e in events if e.get('done'))
        assert done['sourceScope'] == 'course_files'
        assert done['groundingMode'] != 'general'
        assert done['executionLane'] == 'fast_contextual'
        turns += [{'role': 'user', 'text': question}, {'role': 'assistant', 'text': 'Same lecture result.',
            **{key: done[key] for key in ('sourceScope', 'groundingMode', 'answerMode')}}]
    verification = resolve_dialogue('are you sure?', previous_turns=turns)
    assert verification.evidence_requirement is EvidenceRequirement.COURSE_RETRIEVAL


def test_grounding_mode_alone_is_not_downgraded_by_absent_optional_source_scope():
    result = resolve_dialogue('are you sure?', previous_turns=[
        {'role': 'user', 'text': 'Explain my lecture'},
        {'role': 'assistant', 'text': 'Lecture explanation', 'groundingMode': 'relevance'},
    ])
    assert result.evidence_requirement is EvidenceRequirement.COURSE_RETRIEVAL


def test_durable_transcript_retains_original_request_and_answer_provenance(monkeypatch):
    from app.services import conversation_store
    db = FakeSupabase()
    db.rows['ai_chat_conversations'].append({'id': 'conversation', 'user_id': 'user'})
    db.rows['ai_tutor_requests'].append({'request_id': 'request', 'user_id': 'user',
        'conversation_id': 'conversation', 'assistant_client_message_id': 'answer',
        'user_client_message_id': 'question', 'request_snapshot': {'sourceMode': 'course_files'}})
    db.rows['ai_chat_messages'].append({'conversation_id': 'conversation', 'user_id': 'user',
        'client_message_id': 'answer', 'role': 'assistant', 'content': 'Answer'})
    monkeypatch.setattr(conversation_store, 'get_supabase', lambda: db)
    provenance = {'answerMode': 'course', 'groundingMode': 'relevance', 'sourceScope': 'course_files'}
    conversation_store.update_tutor_request(user_id='user', request_id='request', status='completed',
        stage='completed', final_answer='Answer', answer_provenance=provenance)
    restored = conversation_store.get_durable_conversation_messages(user_id='user', conversation_id='conversation')[0]
    assert restored['answer_provenance'] == provenance
    assert restored['request_snapshot']['sourceMode'] == 'course_files'
