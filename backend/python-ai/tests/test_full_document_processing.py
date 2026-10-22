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


# QA plan J2: "all definitions in chapter 2" on a German BWL-style deck —
# the exhaustive scan must bound itself to chapter 2's real pages (found
# from an explicit "Kapitel 2" heading), not scan the whole document.

def _fake_supabase_for_pages(pages_by_document: dict[str, list[dict]]):
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
                return type("R", (), {"data": pages_by_document.get(self._doc_id, [])})()

        return FakeQuery()

    return type("SB", (), {"table": staticmethod(fake_table)})()


def _bwl_deck_pages() -> list[dict]:
    return [
        {"page_number": 1, "cleaned_text": "Kapitel 1\nEinfuehrung in die BWL.", "index_revision": "rev-a"},
        {"page_number": 2, "cleaned_text": "Weiterer Text zu Kapitel 1.", "index_revision": "rev-a"},
        {"page_number": 3, "cleaned_text": "Kapitel 2\nUnternehmensumwelt: Definition Bezugsrahmen.", "index_revision": "rev-a"},
        {"page_number": 4, "cleaned_text": "Mehr zu Kapitel 2. Definition Marktsegmentierung.", "index_revision": "rev-a"},
        {"page_number": 5, "cleaned_text": "Kapitel 3\nStrategisches Management.", "index_revision": "rev-a"},
        {"page_number": 6, "cleaned_text": "Mehr zu Kapitel 3.", "index_revision": "rev-a"},
    ]


def test_chapter_scoped_extraction_bounds_the_scan_to_the_named_chapter(monkeypatch) -> None:
    from app.routers import notes_full
    from app.services import full_document_processing

    monkeypatch.setattr(full_document_processing, "_BATCH_CHARS", 1)
    monkeypatch.setattr(
        full_document_processing, "get_supabase",
        lambda: _fake_supabase_for_pages({"doc-a": _bwl_deck_pages()}),
    )
    captured_batches: list[str] = []

    def fake_call_openai(_system, user_prompt, **_kwargs):
        captured_batches.append(user_prompt)
        return "A definition was found here.", {"model": "test"}

    monkeypatch.setattr(notes_full, "_call_openai", fake_call_openai)

    result = full_document_processing.process_full_documents(
        user_id="user-1", course_id="course-1",
        question="Please list all definitions in chapter 2.",
        pipeline="extraction",
        documents={"doc-a": {"active_index_revision": "rev-a", "file_name": "BWL.pdf"}},
        manifests={"doc-a": _manifest([1, 2, 3, 4, 5, 6])},
    )

    assert result["coverageResult"]["complete"] is True
    # Only pages 3-4 (chapter 2) were ever sent to the model -- chapter 1
    # and chapter 3's text never appears in any batch prompt.
    batch_prompts = captured_batches[:-1]  # last call is the final synthesis prompt
    assert any("[Page 3]" in prompt for prompt in batch_prompts)
    assert any("[Page 4]" in prompt for prompt in batch_prompts)
    assert not any("[Page 1]" in prompt or "[Page 2]" in prompt for prompt in batch_prompts)
    assert not any("[Page 5]" in prompt or "[Page 6]" in prompt for prompt in batch_prompts)
    assert not any("Kapitel 1" in prompt or "Kapitel 3" in prompt for prompt in batch_prompts)
    doc_coverage = result["coverageResult"]["documents"][0]
    assert doc_coverage["expectedPages"] == 2  # chapter 2 only, not all 6 pages


def test_chapter_not_found_declines_honestly_instead_of_scanning_whole_document(monkeypatch) -> None:
    from app.routers import notes_full
    from app.services import full_document_processing

    # No "Kapitel"/"Chapter" heading anywhere -- e.g. a deck that numbers
    # slides but never names its chapters in extractable text.
    pages = [
        {"page_number": n, "cleaned_text": f"Folie {n}: irrelevanter Text.", "index_revision": "rev-a"}
        for n in range(1, 7)
    ]
    monkeypatch.setattr(
        full_document_processing, "get_supabase",
        lambda: _fake_supabase_for_pages({"doc-a": pages}),
    )
    call_count = {"n": 0}

    def fake_call_openai(*_a, **_k):
        call_count["n"] += 1
        return "should never be called", {"model": "test"}

    monkeypatch.setattr(notes_full, "_call_openai", fake_call_openai)

    result = full_document_processing.process_full_documents(
        user_id="user-1", course_id="course-1",
        question="Please list all definitions in chapter 2.",
        pipeline="extraction",
        documents={"doc-a": {"active_index_revision": "rev-a", "file_name": "BWL.pdf"}},
        manifests={"doc-a": _manifest([1, 2, 3, 4, 5, 6])},
    )

    assert call_count["n"] == 0  # never guessed at the whole document
    assert "chapter 2" in result["answer"]
    assert result["coverageResult"]["complete"] is False


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
