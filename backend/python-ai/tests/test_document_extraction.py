from __future__ import annotations

from types import SimpleNamespace

from app.services import document_extraction as extraction


def test_all_kurzfragen_classifies_as_document_wide_extraction() -> None:
    matched, correction, target = extraction.classify_document_extraction(
        "can you extract all the kurzfragen questions in this exam and their answers?"
    )
    assert matched
    assert not correction
    assert target.casefold() == "kurzfragen"


def test_numbered_kurzfragen_section_is_preserved() -> None:
    matched, correction, target = extraction.classify_document_extraction(
        "explain every question from 2. Kurzfragen with the correct answer"
    )
    assert matched
    assert not correction
    assert target == "2. Kurzfragen"


def test_missing_first_items_continuation_reuses_extraction_scope() -> None:
    matched, correction, target = extraction.classify_document_extraction(
        "you missed the first ones, keep extracting the questions",
        [
            {
                "role": "user",
                "text": "extract all Kurzfragen and their answers from this exam",
            },
            {"role": "assistant", "text": "### 9.2\n..."},
        ],
    )
    assert matched
    assert correction
    assert target.casefold() == "kurzfragen"


def test_full_scan_is_not_limited_by_displayed_source_count(monkeypatch) -> None:
    pages = [
        {
            "page_number": page,
            "cleaned_text": f"Kurzfragen Lösung page {page} " + ("content " * 20),
            "raw_text": "",
        }
        for page in range(1, 9)
    ]
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 8, "file_name": "exam.pdf"}, pages),
    )

    def fake_chat_json(*, user: str, **_):
        page_numbers = [
            int(line.split()[2])
            for line in user.splitlines()
            if line.startswith("--- PAGE ")
        ]
        items = []
        for page in page_numbers:
            # Fourteen unique items spread over eight pages.
            count = 2 if page <= 6 else 1
            items.extend(
                {
                    "item_id": f"{page}.{sub}",
                    "question": f"Deutsche Frage {page}.{sub}?",
                    "answer": f"Deutsche Antwort {page}.{sub}.",
                    "question_page": page,
                    "answer_page": page,
                    "confidence": 0.9,
                }
                for sub in range(1, count + 1)
            )
        return SimpleNamespace(
            data={"items": items},
            model="test-model",
            prompt_tokens=10,
            completion_tokens=10,
        )

    monkeypatch.setattr(extraction, "chat_json", fake_chat_json)
    result = extraction.extract_document_qa(
        user_id="user",
        course_id="course",
        document_id="document",
        target="Kurzfragen",
    )

    assert len(result.items) == 14
    assert result.scanned_pages == list(range(1, 9))
    assert result.complete
    # Citation display may later show five pages; it cannot truncate results.
    assert len(result.items) > 5


def test_english_framing_preserves_german_source_text() -> None:
    result = extraction.DocumentExtractionResult(
        document_id="doc",
        target="Kurzfragen",
        total_pages=1,
        scanned_pages=[1],
        complete=True,
        items=[
            extraction.ExtractedQAItem(
                item_id="9.2",
                question="Welche Verfahren polymerisieren die Schichten?",
                answer="Stereolithografie und Photopolymer Jetting.",
                question_page=1,
            )
        ],
    )
    rendered = extraction.format_document_extraction(result, "en")
    assert "**Question:** Welche Verfahren" in rendered
    assert "**Answer:** Stereolithografie" in rendered
    assert "I scanned all 1 pages" in rendered


def test_unreadable_pages_prevent_complete_claim(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: (
            {"page_count": 3},
            [{"page_number": 2, "cleaned_text": "Readable " * 20, "raw_text": ""}],
        ),
    )
    monkeypatch.setattr(
        extraction,
        "chat_json",
        lambda **_: SimpleNamespace(
            data={"items": []},
            model="test",
            prompt_tokens=1,
            completion_tokens=1,
        ),
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="Kurzfragen",
    )
    assert not result.complete
    assert result.unreadable_pages == [1, 3]


def test_suspicious_initial_gap_requires_review() -> None:
    assert extraction.identify_suspicious_numbering_gaps(
        ["9.2", "9.3", "10.1", "10.2", "11.1"]
    ) == ["9.1"]


def test_missing_first_items_requests_backward_rescan() -> None:
    assert extraction.infer_extraction_rescan_direction(
        "you missed the first ones"
    ) == "earlier"


def test_normalised_ids_pair_distant_question_and_solution() -> None:
    merged = extraction._merge_items([
        extraction.ExtractedQAItem(
            item_id="Aufgabe 9.2",
            question="Welche Verfahren polymerisieren die Schichten?",
            answer="",
            question_page=3,
        ),
        extraction.ExtractedQAItem(
            item_id="9.2",
            question="Welche Verfahren polymerisieren die Schichten?",
            answer="Stereolithografie und Photopolymer Jetting.",
            question_page=30,
            answer_page=30,
        ),
    ])
    assert len(merged) == 1
    assert merged[0].question_page == 3
    assert merged[0].answer_page == 30


def test_unanswered_item_prevents_complete_status(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: (
            {"page_count": 1},
            [{"page_number": 1, "cleaned_text": "Kurzfragen " * 20, "raw_text": ""}],
        ),
    )
    monkeypatch.setattr(
        extraction,
        "chat_json",
        lambda **_: SimpleNamespace(
            data={"items": [{
                "item_id": "1.1",
                "question": "Frage?",
                "answer": "",
                "question_page": 1,
            }]},
            model="test",
            prompt_tokens=1,
            completion_tokens=1,
        ),
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="Kurzfragen",
    )
    assert not result.complete
    assert result.unanswered_item_ids == ["1.1"]


def test_missing_solution_section_can_complete_gap_review() -> None:
    result = extraction.review_numbering_gap(
        "9.1",
        neighbouring_text="Kurzfragen 9.2 and 9.3",
        reviewed_pages=[1, 2, 3],
        review_result=extraction.GapReviewResult(
            exact_text_search_performed=True,
            question_section_status=extraction.SearchAvailability.SEARCHED,
            solution_section_status=extraction.SearchAvailability.NOT_AVAILABLE,
            reviewed_pages=[1, 2, 3],
            coverage=extraction.GapSearchCoverage(
                full_document_text_searched=True,
            ),
        ),
    )
    assert result.status is extraction.GapStatus.REVIEWED_NOT_FOUND


def test_existing_unsearched_solution_section_keeps_gap_unresolved() -> None:
    result = extraction.review_numbering_gap(
        "9.1",
        neighbouring_text="Kurzfragen 9.2 and 9.3",
        reviewed_pages=[1, 2],
        review_result=extraction.GapReviewResult(
            exact_text_search_performed=True,
            question_section_status=extraction.SearchAvailability.SEARCHED,
            solution_section_status=extraction.SearchAvailability.NOT_SEARCHED,
            reviewed_pages=[1, 2],
            coverage=extraction.GapSearchCoverage(
                full_document_text_searched=True,
                solution_section_detected=True,
            ),
        ),
    )
    assert result.status is extraction.GapStatus.UNRESOLVED
