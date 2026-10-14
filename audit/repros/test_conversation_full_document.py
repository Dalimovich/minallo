"""Audit probes: assert observed failures; not permanent acceptance tests."""
import os
import sys
import json
import asyncio
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/python-ai'))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/python-ai/tests'))
import conftest
from test_conversational_evidence_resolution import _stream_router_common_mocks, _mock_tutor_state, _consume, _GROUNDED_PREVIOUS_TURNS

def test_grounded_reuse_emits_general_provenance(monkeypatch):
    from app.services import general_answer
    from app.services.dialogue_state import resolve_dialogue, EvidenceRequirement
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter([{'t': 'The same grounded explanation, simplified.'}, {'done': True}]))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='course-1', question='that went over my head', previousTurns=_GROUNDED_PREVIOUS_TURNS), 'audit-grounded-reuse'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminal = next(e for e in events if e.get('done'))
    assert terminal['groundingMode'] == 'general'
    assert terminal.get('sourceScope') is None
    history = [*_GROUNDED_PREVIOUS_TURNS, {'role': 'user', 'text': 'that went over my head'}, {'role': 'assistant', 'text': 'The same grounded explanation, simplified.', 'groundingMode': terminal['groundingMode'], 'answerMode': terminal['answerMode'], 'sourceScope': terminal.get('sourceScope')}]
    followup = resolve_dialogue('are you sure?', previous_turns=history)
    assert followup.evidence_requirement == EvidenceRequirement.GENERAL_KNOWLEDGE

def test_route1_explicit_internet_mode_no_longer_bypassed_by_fast_general(monkeypatch):
    # ROUTE-1 (audit/findings/evidence-routing.md) originally found explicit
    # Internet mode reaching FAST_GENERAL before web source resolution ran at
    # all — this probe used to assert exactly that bug (executionLane ==
    # "fast_general"). V11 recheck (2026-10-14): current routing already
    # selects the web lane for this request; this now asserts the FIX holds
    # instead of the defect. (Was also missing _mock_tutor_state, below —
    # without it claim_generation() hits the real Supabase client and fails on
    # local DNS before routing is even exercised.)
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    monkeypatch.setattr(router, 'stream_web_answer', lambda *a, **k: iter([
        {'t': 'Model knowledge only, from a real web search.'},
        {'done': True, 'webSources': [{'title': 'Example', 'url': 'https://example.invalid'}],
         'model': 'gpt-4o', 'promptTokens': 10, 'completionTokens': 20},
    ]))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='', question='What is torsion?', sourceMode='internet'), 'audit-explicit-web'))
    assert b'"executionLane": "fast_general"' not in body
    assert b'"executionLane": "web"' in body
    assert b'Model knowledge only, from a real web search.' in body
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminal = next(e for e in events if e.get('done'))
    assert terminal['sourceScope'] == 'internet'
    assert terminal['confidence'] == 'high'
    assert terminal['unsupported'] is False

def test_route1_internet_mode_web_failure_is_disclosed_not_badged_success(monkeypatch):
    # V11: the companion honesty gap this recheck surfaced — when explicit
    # Internet mode's web search genuinely fails, the final event must not
    # keep claiming successful internet grounding (see
    # app/routers/stream.py's _stream_live_answer webSearchFailed handling,
    # fixed 2026-10-14 alongside this recheck).
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    monkeypatch.setattr(router, 'stream_web_answer', lambda *a, **k: iter([
        {'t': 'Internet search is temporarily unavailable.'},
        {'done': True, 'webSources': [], 'model': None, 'promptTokens': None,
         'completionTokens': None, 'webSearchFailed': True},
    ]))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='', question='What is torsion?', sourceMode='internet'), 'audit-explicit-web-failed'))
    events = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
    terminal = next(e for e in events if e.get('done'))
    assert terminal['sourceScope'] == 'unavailable'
    assert terminal['sourceLabel'] is None
    assert terminal['confidence'] == 'low'
    assert terminal['unsupported'] is True

def test_full_document_empty_model_output_claims_complete(monkeypatch):
    from app.services import full_document_processing as processing
    from app.services.index_manifest import CanonicalPage
    from app.routers import notes_full
    class Query:
        def select(self, *a): return self
        def eq(self, *a): return self
        def order(self, *a): return self
        def execute(self): return type('Result', (), {'data': [{'page_number': 1, 'cleaned_text': 'Important exam content', 'index_revision': 'r1'}]})()
    monkeypatch.setattr(processing, 'get_supabase', lambda: type('SB', (), {'table': lambda self, name: Query()})())
    monkeypatch.setattr(notes_full, '_call_openai', lambda *a, **k: ('', False))
    result = processing.process_full_documents(user_id='u', course_id='c', question='Summarize the entire PDF', pipeline='summarization', documents={'doc': {'active_index_revision': 'r1'}}, manifests={'doc': [CanonicalPage(page_number=1, source_page_id='p1', required_for_processing=True, status='ready')]})
    assert result['coverageResult']['complete'] is True
    assert result['answer'] == ''
