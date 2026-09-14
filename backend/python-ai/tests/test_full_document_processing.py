"""Real execution tests for process_full_documents's per-batch progress
callback — the mechanism that makes full-document commentary genuinely
live (page ranges reported as each batch actually finishes) instead of
sitting at 0/N for the whole run and then jumping straight to N/N."""
from __future__ import annotations

from app.services.index_manifest import CanonicalPage


def _manifest(pages: list[int]) -> list[CanonicalPage]:
    return [
        CanonicalPage(
            page_number=page, source_page_id=f"p{page}",
            required_for_processing=True, status="ready",
        )
        for page in pages
    ]


def test_progress_callback_fires_once_per_batch_with_correct_cumulative_counts(monkeypatch) -> None:
    from app.routers import notes_full
    from app.services import full_document_processing

    # Force one page per batch so multi-batch progress is actually exercised
    # without needing kilobytes of fake page text.
    monkeypatch.setattr(full_document_processing, "_BATCH_CHARS", 1)

    doc_a_pages = [{"page_number": n, "cleaned_text": f"A page {n} text", "index_revision": "rev-a"} for n in (1, 2, 3)]
    doc_b_pages = [{"page_number": n, "cleaned_text": f"B page {n} text", "index_revision": "rev-b"} for n in (1, 2)]

    def fake_table(name):
        if name != "document_pages":
            raise AssertionError(f"unexpected table {name}")

        class FakeQuery:
            def __init__(self):
                self._doc_id = None

            def select(self, *_a, **_k):
                return self

            def eq(self, field, value):
                if field == "document_id":
                    self._doc_id = value
                return self

            def order(self, *_a, **_k):
                return self

            def execute(self):
                rows = doc_a_pages if self._doc_id == "doc-a" else doc_b_pages
                return type("R", (), {"data": rows})()

        return FakeQuery()

    monkeypatch.setattr(
        full_document_processing, "get_supabase",
        lambda: type("SB", (), {"table": staticmethod(fake_table)})(),
    )
    monkeypatch.setattr(
        notes_full, "_call_openai",
        lambda *_a, **_k: ("processed batch text", {"model": "test"}),
    )

    progress_events: list[dict] = []
    result = full_document_processing.process_full_documents(
        user_id="user-1", course_id="course-1", question="Summarize everything",
        pipeline="summarization",
        documents={
            "doc-a": {"active_index_revision": "rev-a", "file_name": "Lecture A.pdf"},
            "doc-b": {"active_index_revision": "rev-b", "file_name": "Lecture B.pdf"},
        },
        manifests={"doc-a": _manifest([1, 2, 3]), "doc-b": _manifest([1, 2])},
        on_batch_progress=progress_events.append,
    )

    # 5 total required pages, one page per batch (forced by _BATCH_CHARS=1) —
    # the callback must fire once per batch, not once at the very end.
    assert len(progress_events) == 5
    # Cumulative, monotonically increasing, and every event knows the same
    # fixed total — this is what lets the frontend replace one row in place
    # ("Processing pages 2 of 5", then "3 of 5", ...) instead of jumping.
    assert [event["current"] for event in progress_events] == [1, 2, 3, 4, 5]
    assert all(event["total"] == 5 for event in progress_events)
    # Document A's three single-page batches report page numbers 1, 2, 3;
    # document B's continue from 1, 2 — never invented, always the real page
    # actually just processed.
    assert [event["batch_start_page"] for event in progress_events[:3]] == [1, 2, 3]
    assert [event["batch_start_page"] for event in progress_events[3:]] == [1, 2]
    assert progress_events[0]["document_name"] == "Lecture A.pdf"
    assert progress_events[3]["document_name"] == "Lecture B.pdf"
    assert result["coverageResult"]["complete"] is True


def test_no_progress_callback_is_still_optional_and_safe(monkeypatch) -> None:
    """process_full_documents must not require a callback — every existing
    caller that doesn't pass one keeps working unchanged."""
    from app.routers import notes_full
    from app.services import full_document_processing

    monkeypatch.setattr(
        full_document_processing, "get_supabase",
        lambda: type("SB", (), {"table": staticmethod(lambda _n: type("Q", (), {
            "select": lambda self, *_a, **_k: self,
            "eq": lambda self, *_a, **_k: self,
            "order": lambda self, *_a, **_k: self,
            "execute": lambda self: type("R", (), {
                "data": [{"page_number": 1, "cleaned_text": "hello", "index_revision": "rev-a"}],
            })(),
        })())})(),
    )
    monkeypatch.setattr(notes_full, "_call_openai", lambda *_a, **_k: ("ok", {}))

    result = full_document_processing.process_full_documents(
        user_id="user-1", course_id="course-1", question="Summarize",
        pipeline="summarization",
        documents={"doc-a": {"active_index_revision": "rev-a", "file_name": "Lecture A.pdf"}},
        manifests={"doc-a": _manifest([1])},
    )
    assert result["coverageResult"]["complete"] is True
