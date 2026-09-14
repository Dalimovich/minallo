"""Audit probes: assert observed failures; not permanent acceptance tests."""
import os
import sys
import json
import asyncio
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/python-ai'))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/python-ai/tests'))
import conftest
from test_conversational_evidence_resolution import _stream_router_common_mocks, _consume, _GROUNDED_PREVIOUS_TURNS

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

def test_explicit_internet_mode_bypassed_by_fast_general(monkeypatch):
    from app.services import general_answer
    router = _stream_router_common_mocks(monkeypatch)
    monkeypatch.setattr(general_answer, 'stream_general_answer', lambda *a, **k: iter([{'t': 'Model knowledge only'}, {'done': True}]))
    body = asyncio.run(_consume(router, router.AskStreamRequest(courseId='', question='What is torsion?', sourceMode='internet'), 'audit-explicit-web'))
    assert b'"executionLane": "fast_general"' in body
    assert b'Model knowledge only' in body

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
