"""Baseline defect probe: passing means truncated output is still accepted."""
from types import SimpleNamespace
from app.routers import notes_full
from app.services import full_document_processing as processing, usage_meter
from app.services.index_manifest import CanonicalPage


def test_truncated_full_document_is_reported_complete(monkeypatch):
    response = SimpleNamespace(choices=[SimpleNamespace(
        finish_reason='length', message=SimpleNamespace(content='Only the first part of the answer'))])
    monkeypatch.setattr(notes_full, 'get_openai_client', lambda: SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: response))))
    monkeypatch.setattr(usage_meter, 'record_usage', lambda **kwargs: None)
    monkeypatch.setattr(usage_meter, 'usage_from_response', lambda response: {})
    class Query:
        def select(self, *args): return self
        def eq(self, *args): return self
        def order(self, *args): return self
        def execute(self):
            return SimpleNamespace(data=[{'page_number': 1, 'cleaned_text': 'facts', 'index_revision': 'r1'}])
    monkeypatch.setattr(processing, 'get_supabase', lambda: SimpleNamespace(table=lambda name: Query()))
    result = processing.process_full_documents(user_id='u', course_id='c', question='Summarize every topic',
        pipeline='summarization', documents={'d': {'active_index_revision': 'r1'}},
        manifests={'d': [CanonicalPage(page_number=1, source_page_id='p1', required_for_processing=True, status='ready')]})
    assert result['coverageResult']['complete'] is True
    assert result['answer'] == 'Only the first part of the answer'
