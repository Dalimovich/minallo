"""Exhaustive coverage must count successful processing, not just fetched rows."""
from types import SimpleNamespace
import pytest
from app.services.index_manifest import CanonicalPage
from app.services import full_document_processing as processing
from app.routers import notes_full


def run_document(monkeypatch, pages, outputs, missing=()):
    rows = [{'page_number': n, 'cleaned_text': f'Page {n} source facts', 'index_revision': 'r1'}
            for n in range(1, pages + 1) if n not in missing]
    class Query:
        def select(self, *a): return self
        def eq(self, *a): return self
        def order(self, *a): return self
        def execute(self): return SimpleNamespace(data=rows)
    monkeypatch.setattr(processing, 'get_supabase', lambda: SimpleNamespace(table=lambda _: Query()))
    monkeypatch.setattr(processing, '_BATCH_CHARS', 1)
    calls = []
    def generate(*args, **kwargs):
        calls.append(args)
        output = next(outputs)
        if isinstance(output, Exception): raise output
        return output, False
    monkeypatch.setattr(notes_full, '_call_openai', generate)
    progress = []
    result = processing.process_full_documents(user_id='user', course_id='course', question='Summarize the entire PDF',
        pipeline='summarization', documents={'doc': {'active_index_revision': 'r1'}},
        manifests={'doc': [CanonicalPage(page_number=n, source_page_id=f'p{n}', required_for_processing=True, status='ready')
                           for n in range(1, pages + 1)]}, on_batch_progress=progress.append)
    return result, progress, calls


@pytest.mark.parametrize('bad', ['', '  \n '])
def test_empty_page_model_output_is_not_processed_coverage(monkeypatch, bad):
    result, progress, calls = run_document(monkeypatch, 1, iter([bad, 'Invented final']))
    assert not result['coverageResult']['complete']
    assert result['coverageResult']['documents'][0]['processedPages'] == 0
    assert result['coverageResult']['documents'][0]['failedPages'] == [1]
    assert not progress
    assert len(calls) == 1


def test_empty_synthesis_is_a_failure_even_when_all_page_maps_succeeded(monkeypatch):
    result, _, _ = run_document(monkeypatch, 1, iter(['Valid page facts', '']))
    assert not result['coverageResult']['complete']
    assert result['coverageResult']['documents'][0]['processedPages'] == 1
    assert not result['answer']


def test_page_40_missing_from_100_page_pdf_never_falls_back_to_available_subset(monkeypatch):
    result, progress, calls = run_document(monkeypatch, 100, iter([]), missing=[40])
    assert not result['coverageResult']['complete']
    assert 40 in result['coverageResult']['documents'][0]['failedPages']
    assert not progress and not calls


def test_hundred_page_document_reports_genuine_progress_and_complete_final_answer(monkeypatch):
    result, progress, calls = run_document(monkeypatch, 100, iter(['Valid page facts'] * 100 + ['Complete synthesis']))
    assert result['coverageResult']['complete']
    assert result['answer'] == 'Complete synthesis'
    assert [event['current'] for event in progress] == list(range(1, 101))
    assert len(calls) == 101
