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


def test_numbered_section_resolution_and_id_filter_are_exact() -> None:
    resolved = extraction.resolve_document_section(
        "2. Kurzfragen",
        {
            3: "2. Kurzfragen - Grundlagen\n2.1 Welche Aussage ist korrekt?",
            4: "12. Kurzfragen\n12.21 Welche Aussage ist falsch?",
        },
        total_pages=43,
        visible_page=3,
    )
    assert resolved is not None
    assert resolved.start_page == 3
    assert resolved.end_page == 3
    assert extraction.item_belongs_to_requested_section("2.4", "2. Kurzfragen")
    assert not extraction.item_belongs_to_requested_section("12.21", "2. Kurzfragen")
    assert not extraction.item_belongs_to_requested_section("14.4", "2. Kurzfragen")


def test_unresolved_numbered_section_returns_no_unrelated_items(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 43}, [{
            "page_number": 24,
            "cleaned_text": "12. Kurzfragen\n12.21 Welche Aussage ist korrekt?",
            "raw_text": "",
        }]),
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="2. Kurzfragen",
    )
    assert result.status == "section_not_found"
    assert not result.section_resolved
    assert result.items == []
    assert 1 in result.unprocessed_pages
    assert result.unreadable_pages == []


def test_visible_page_anchors_section_questions_while_answers_search_all_pages(
    monkeypatch,
) -> None:
    pages = [{
        "page_number": page,
        "cleaned_text": (
            "unrelated indexed text " * 20 if page == 3
            else "Musterlösung 2.3: Die korrekte Antwort ist B. " * 8 if page == 40
            else "document content " * 20
        ),
        "raw_text": "",
        "extraction_quality": "good",
    } for page in range(1, 44)]
    pages[3]["cleaned_text"] = "3. Kurzfragen - Urformen\n3.1 Andere Frage? " * 10
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 43, "file_name": "exam.pdf"}, pages),
    )

    def fake_chat_json(*, system: str, user: str, **_):
        if "QUESTIONS ONLY" in system and "--- PAGE 3 ---" in user:
            data = {"questions": [{
                "item_id": "2.3", "question": "Welche Aussage ist korrekt?",
                "question_page": 3, "section": "2. Kurzfragen - Grundlagen",
                "confidence": 0.95,
            }]}
        elif "SOLUTION EVIDENCE ONLY" in system and "--- PAGE 40 ---" in user:
            data = {"solutions": [{
                "item_id": "2.3", "answer_text": "Die korrekte Antwort ist B.",
                "answer_page": 40, "confidence": 0.95,
            }]}
        else:
            data = {"questions": [], "solutions": []}
        return SimpleNamespace(
            data=data, model="test", prompt_tokens=1, completion_tokens=1,
        )

    monkeypatch.setattr(extraction, "chat_json", fake_chat_json)
    visible_images: list[tuple[int, bytes]] = []
    monkeypatch.setattr(
        extraction,
        "_extract_visual_image",
        lambda **kwargs: visible_images.append((
            kwargs["page_number"], kwargs["image_bytes"],
        )) or [],
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="2. Kurzfragen",
        visible_page=3,
        visible_page_text=(
            "2. Kurzfragen - Grundlagen\n"
            "2.3 Welche Aussage ist korrekt? " + "Kontext " * 20
        ),
        visible_page_image=b"browser-page-3-png",
        active_document_id="d",
        active_file_name="exam.pdf",
    )
    assert result.resolved_heading.startswith("2. Kurzfragen - Grundlagen")
    assert [item.item_id for item in result.items] == ["2.3"]
    assert result.items[0].question_page == 3
    assert result.items[0].answer_page == 40
    assert visible_images == [(3, b"browser-page-3-png")]


def test_section_result_mismatch_is_typed_and_never_rendered(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 1}, [{
            "page_number": 1,
            "cleaned_text": "2. Kurzfragen - Grundlagen\n2.1 Frage? " * 20,
            "raw_text": "", "extraction_quality": "good",
        }]),
    )
    monkeypatch.setattr(
        extraction,
        "chat_json",
        lambda **kwargs: SimpleNamespace(
            data=({"questions": [{
                "item_id": "12.21", "question": "Falsche Sektion?",
                "question_page": 1, "confidence": 0.9,
            }]} if "QUESTIONS ONLY" in kwargs.get("system", "") else {"solutions": []}),
            model="test", prompt_tokens=1, completion_tokens=1,
        ),
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="2. Kurzfragen",
    )
    assert result.status == "section_result_mismatch"
    assert result.invalid_item_ids_rejected == ["12.21"]
    assert result.items == []
    assert "12.21" not in extraction.format_document_extraction(result, "en")


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


def test_sixty_pages_run_as_six_batches_and_checkpoint_coverage(monkeypatch) -> None:
    pages = [
        {
            "page_number": page,
            "cleaned_text": f"Question or solution page {page} " + ("content " * 8),
            "raw_text": "",
            "extraction_quality": "good",
        }
        for page in range(1, 61)
    ]
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 60, "file_name": "exam.pdf"}, pages),
    )
    calls: list[list[int]] = []

    def fake_chat_json(*, user: str, **_):
        page_numbers = [
            int(line.split()[2])
            for line in user.splitlines()
            if line.startswith("--- PAGE ")
        ]
        calls.append(page_numbers)
        return SimpleNamespace(
            data={"questions": [], "solutions": []},
            model="test-model",
            prompt_tokens=1,
            completion_tokens=1,
        )

    monkeypatch.setattr(extraction, "chat_json", fake_chat_json)
    checkpoints: list[dict] = []
    result = extraction.extract_document_qa(
        user_id="user",
        course_id="course",
        document_id="document",
        target="questions",
        checkpoint=checkpoints.append,
    )

    # Each batch runs two independent map passes: questions and solutions.
    assert calls[::2] == [list(range(start, start + 10)) for start in range(1, 61, 10)]
    assert calls[1::2] == calls[::2]
    assert len(checkpoints) == 6
    assert checkpoints[-1]["scanned_pages"] == list(range(1, 61))
    assert result.scanned_pages == list(range(1, 61))


def test_document_extraction_visually_processes_every_missing_page_without_ocr_cap(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 43, "storage_path": "exam.pdf"}, []),
    )
    visual_pages: list[int] = []
    monkeypatch.setattr(
        extraction,
        "_extract_visual_page",
        lambda **kwargs: visual_pages.append(kwargs["page_number"]) or [],
    )
    monkeypatch.setattr(
        extraction,
        "chat_json",
        lambda **_: SimpleNamespace(
            data={"questions": [], "solutions": []},
            model="test",
            prompt_tokens=0,
            completion_tokens=0,
        ),
    )
    result = extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="questions",
    )
    assert visual_pages == list(range(1, 44))
    assert result.scanned_pages == list(range(1, 44))
    assert result.unprocessed_pages == []


def test_resume_only_processes_pages_after_last_checkpoint(monkeypatch) -> None:
    pages = [
        {
            "page_number": page,
            "cleaned_text": f"Question page {page} " + ("content " * 8),
            "raw_text": "",
            "extraction_quality": "good",
        }
        for page in range(31, 61)
    ]
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 60}, pages),
    )
    seen: list[list[int]] = []

    def fake_chat_json(*, user: str, **_):
        seen.append([
            int(line.split()[2])
            for line in user.splitlines()
            if line.startswith("--- PAGE ")
        ])
        return SimpleNamespace(
            data={"questions": [], "solutions": []},
            model="test",
            prompt_tokens=1,
            completion_tokens=1,
        )

    monkeypatch.setattr(extraction, "chat_json", fake_chat_json)
    context = extraction.DocumentExtractionContext(
        conversation_id="conversation",
        document_id="document",
        document_revision="revision",
        source_fingerprint="fingerprint",
        target_section="questions",
        requested_scope="complete_document",
        scanned_pages=list(range(1, 31)),
    )
    extraction.extract_document_qa(
        user_id="user",
        course_id="course",
        document_id="document",
        target="questions",
        pages_to_scan=list(range(31, 61)),
        previous_context=context,
    )

    assert {page for batch in seen for page in batch} == set(range(31, 61))
    assert not ({page for batch in seen for page in batch} & set(range(1, 31)))


def test_string_weak_quality_triggers_visual_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 1}, [{
            "page_number": 1,
            "cleaned_text": "OCR text " * 20,
            "raw_text": "",
            "extraction_quality": "weak",
        }]),
    )
    visual_pages: list[int] = []
    monkeypatch.setattr(
        extraction,
        "_extract_visual_page",
        lambda **kwargs: visual_pages.append(kwargs["page_number"]) or [],
    )
    monkeypatch.setattr(
        extraction,
        "chat_json",
        lambda **_: SimpleNamespace(
            data={"questions": [], "solutions": []},
            model="test",
            prompt_tokens=1,
            completion_tokens=1,
        ),
    )

    extraction.extract_document_qa(
        user_id="u", course_id="c", document_id="d", target="questions",
    )
    assert visual_pages == [1]


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


def test_missing_index_rows_are_unprocessed_not_unreadable(monkeypatch) -> None:
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
    assert result.unreadable_pages == []
    assert result.unprocessed_pages == [1, 3]


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
def test_unanswered_question_triggers_visual_recovery_on_good_text(monkeypatch) -> None:
    from app.services import document_extraction as extraction

    question = extraction.ExtractedQuestion(
        item_id="2.1", normalized_item_id="2.1",
        question_text="Welche Aussage trifft auf eine Fertigungszelle zu?",
        question_page=2, question_fingerprint="fingerprint", confidence=0.95,
        answer_type="multiple_choice",
        options=[
            extraction.ExtractedQuestionOption("A", "Werkzeugwechsel werden nicht benötigt.", 0),
            extraction.ExtractedQuestionOption("B", "Automatischer Werkstückwechsel mit Werkstückspeicher", 1),
        ],
    )
    pairs = extraction.pair_questions_and_solutions([question], [])
    inspected: list[int] = []

    def visual_page(**kwargs):
        inspected.append(kwargs["page_number"])
        return [extraction.ExtractedQAItem(
            item_id="2.1", question=question.question_text,
            answer="Automatischer Werkstückwechsel mit Werkstückspeicher",
            question_page=2, answer_page=40, evidence_type="green_checkmark",
            confidence=0.96,
        )]

    monkeypatch.setattr(extraction, "_extract_visual_page", visual_page)
    statuses = {40: extraction.PageProcessingStatus.TEXT_PROCESSED}
    recovered = extraction.recover_unanswered_answers(
        document={"id": "doc"}, questions=[question], paired_items=pairs,
        text_by_page={40: (
            "Welche Aussage trifft auf eine Fertigungszelle zu? "
            "Werkzeugwechsel werden nicht benötigt. "
            "Automatischer Werkstückwechsel mit Werkstückspeicher"
        )},
        page_statuses=statuses,
    )

    assert inspected == [40]
    assert recovered.solution_evidence[0].evidence_type == "green_checkmark"
    assert statuses[40] == extraction.PageProcessingStatus.VISION_PROCESSED
    assert recovered.records["2.1"].status is extraction.AnswerResolutionStatus.PAIRED_VISUAL


def test_recovery_budget_scales_for_twenty_five_questions(monkeypatch) -> None:
    from app.services import document_extraction as extraction

    questions = [
        extraction.ExtractedQuestion(
            item_id=f"5.{number}", normalized_item_id=f"5.{number}",
            question_text=f"Question {number} distinctive wording", question_page=5,
            confidence=0.9,
        )
        for number in range(1, 26)
    ]
    calls: list[int] = []

    def visual_page(**kwargs):
        calls.append(kwargs["page_number"])
        item_id = f"5.{len(calls)}"
        return [extraction.ExtractedQAItem(
            item_id=item_id, question=f"Question {len(calls)} distinctive wording",
            answer=f"Answer {len(calls)}", question_page=5,
            answer_page=kwargs["page_number"], confidence=0.95,
        )]

    monkeypatch.setattr(extraction, "_extract_visual_page", visual_page)
    result = extraction.recover_unanswered_answers(
        document={"id": "doc"}, questions=questions,
        paired_items=extraction.pair_questions_and_solutions(questions, []),
        text_by_page={number: f"Question {number} distinctive wording" for number in range(1, 26)},
        page_statuses={},
    )
    assert len(calls) == 25
    assert len(result.solution_evidence) == 25
    assert not result.incomplete


def test_conflicting_visual_marks_are_ambiguous(monkeypatch) -> None:
    from app.services import document_extraction as extraction

    question = extraction.ExtractedQuestion(
        item_id="2.1", normalized_item_id="2.1", question_text="Choose one",
        question_page=2, confidence=0.9,
        options=[
            extraction.ExtractedQuestionOption("A", "First option", 0),
            extraction.ExtractedQuestionOption("B", "Second option", 1),
        ],
    )
    monkeypatch.setattr(extraction, "_extract_visual_page", lambda **_: [
        extraction.ExtractedQAItem("2.1", "Choose one", "First option", 2, 10, 0.9),
        extraction.ExtractedQAItem("2.1", "Choose one", "Second option", 2, 10, 0.9),
    ])
    result = extraction.recover_unanswered_answers(
        document={"id": "doc"}, questions=[question],
        paired_items=extraction.pair_questions_and_solutions([question], []),
        text_by_page={10: "2.1 Choose one First option Second option"}, page_statuses={},
    )
    assert not result.solution_evidence
    assert result.records["2.1"].status is extraction.AnswerResolutionStatus.AMBIGUOUS_EVIDENCE


def test_solution_without_id_pairs_by_option_text() -> None:
    from app.services import document_extraction as extraction

    question = extraction.ExtractedQuestion(
        item_id="2.4", normalized_item_id="2.4", question_text="Welches Verfahren?",
        question_page=2, confidence=0.9,
        options=[extraction.ExtractedQuestionOption("C", "Laser-Druckguss", 0)],
    )
    solution = extraction.ExtractedSolutionEvidence(
        item_id=None, normalized_item_id=None, answer_text="Laser-Druckguss",
        answer_page=41, evidence_type="checked_option", confidence=0.95,
    )
    paired = extraction.pair_questions_and_solutions([question], [solution])
    assert paired[0].pairing_method == "option_text_match"
    assert paired[0].answer_text == "Laser-Druckguss"


def test_kurzfragen_family_resolves_sections_and_excludes_later_tasks() -> None:
    from app.services.document_extraction import resolve_section_family

    pages = {
        2: "2. Kurzfragen - Grundlagen\n2.1 Frage",
        3: "3. Kurzfragen - Urformen\n3.1 Frage",
        4: "4. Kurzfragen - Umformen\n4.1 Frage",
        5: "5. Kurzfragen - Trennen\n5.1 Frage",
        6: "6. Kurzfragen - Fügen\n6.1 Frage",
        7: "7. Kurzfragen - Beschichten\n7.1 Frage",
        8: "8. Kurzfragen - Stoffeigenschaften ändern\n8.1 Frage",
        9: "9. Kurzfragen - Generative Fertigung\n9.1 Frage",
        10: "10. Kurzfragen - Hybrider Leichtbau\n10.1 Frage",
        11: "11. Kurzfragen - Messtechnik\n11.1 Frage",
        12: "12. Rechenaufgabe\n12.1 Rechnung",
        13: "13. Rechenaufgabe\n13.10 Rechnung",
        14: "14. Spritzgießen\n14.5 Rechnung",
    }
    family = resolve_section_family("all Kurzfragen", pages, total_pages=14)
    assert family is not None
    assert family.section_numbers == [str(number) for number in range(2, 12)]
    assert "13" in family.excluded_sections
    assert "14" in family.excluded_sections
    assert family.matched_sections[0].end_page == 2


def test_kurzfragen_family_supports_two_headings_on_the_same_page() -> None:
    from app.services.document_extraction import resolve_section_family

    family = resolve_section_family(
        "all Kurzfragen",
        {
            2: "2. Kurzfragen - Grundlagen\n2.1 Frage\n3. Kurzfragen - Urformen\n3.1 Frage",
            3: "4. Rechenaufgabe\n4.1 Rechnung",
        },
        total_pages=3,
    )
    assert family is not None
    assert family.section_numbers == ["2", "3"]
    assert family.matched_sections[0].start_page == 2
    assert family.matched_sections[0].end_page == 2
    assert family.matched_sections[0].end_position is not None
    assert family.matched_sections[1].end_page == 2


def test_kurzfragen_family_uses_ordered_visual_heading_fallback() -> None:
    from app.services.document_extraction import resolve_section_family

    family = resolve_section_family(
        "all Kurzfragen",
        {2: "2.1 Frage", 3: "3.1 Frage"},
        total_pages=4,
        visual_headings=[
            {"page": 2, "number": 2, "heading": "2. Kurzfragen - Grundlagen", "title": "Grundlagen", "position": 0, "confidence": 0.91},
            {"page": 3, "number": 3, "heading": "3. Kurzfragen - Urformen", "title": "Urformen", "position": 0, "confidence": 0.89},
            {"page": 4, "number": 4, "heading": "4. Rechenaufgabe", "title": "Rechenaufgabe", "position": 0, "confidence": 0.95},
        ],
    )
    assert family is not None
    assert family.section_numbers == ["2", "3"]
    assert family.matched_sections[0].discovery_method == "visual_ocr"
    assert family.matched_sections[1].end_page == 3
    assert family.excluded_sections == ["4"]


def test_learning_journey_marks_resolved_empty_section_as_failed() -> None:
    from app.services import document_extraction as extraction

    family = extraction.ResolvedSectionFamily(
        "Kurzfragen",
        [extraction.ResolvedDocumentSection("2", "Grundlagen", "2. Kurzfragen", 2, 2, "2.", 0.9)],
        [], 0.9,
    )
    result = extraction.DocumentExtractionResult("doc", "Kurzfragen", 2, resolved_family=family)
    journey = extraction.build_learning_journey(result)
    assert journey is not None
    assert journey["sections"][0]["status"] == "failed"
    assert journey["sections"][0]["error"]["code"] == "section_questions_not_found"


def test_structured_journey_uses_natural_order_and_unresolved_status() -> None:
    from app.services import document_extraction as extraction

    family = extraction.ResolvedSectionFamily(
        "Kurzfragen",
        [extraction.ResolvedDocumentSection("5", "Trennen", "5. Kurzfragen - Trennen", 5, 5, "5.", 0.96)],
        ["13", "14"], 0.96,
    )
    result = extraction.DocumentExtractionResult("doc", "Kurzfragen", 43, resolved_family=family)
    result.paired_items = [
        extraction.PairedQAItem("5.10", "Ten", None, 5, None, None, 0, None),
        extraction.PairedQAItem("5.9", "Nine", "Verified", 5, 20, "normalized_item_id", 0.9, "printed_answer"),
    ]
    journey = extraction.build_learning_journey(result)
    questions = journey["sections"][0]["questions"]
    assert [question["number"] for question in questions] == ["5.9", "5.10"]
    assert questions[1]["answerStatus"] == "unresolved"
    assert journey["coverage"]["scopeExtractionComplete"] is False
    assert journey["coverage"]["answerVerificationComplete"] is False
    assert journey["coverage"]["questionPagesTotal"] == 1
