from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.routers import stream as stream_router
from app.services import document_extraction as extraction
from app.services import visual_repair as visual_repair_service
from app.services.document_extraction import (
    DocumentExtractionContext,
    ExtractedQuestion,
    ExtractedSolutionEvidence,
    ExtractionPageKind,
    GapReviewResult,
    GapSearchCoverage,
    GapIdVariant,
    GapStatus,
    extraction_pages_for_direction,
    extraction_context_from_api,
    extraction_context_to_api,
    pair_questions_and_solutions,
    review_numbering_gap,
    classify_extraction_page,
    classify_extraction_page_result,
)
from app.services.reliability import (
    CalculationContext,
    CheckboxGeometry,
    DraftTaskIdentity,
    GroundedTaskIdentity,
    GroundedTaskKind,
    GroundingMismatch,
    NumberRole,
    IdentityResolutionMethod,
    LayoutTextSpan,
    VisibleAnswerOption,
    VisualTaskKind,
    VisualIdentityBinding,
    assess_text_quality,
    classify_number_roles,
    classify_task_traits,
    compare_task_identities,
    build_retrieval_scope,
    derive_grounding_state,
    evidence_requirement,
    identity_is_sufficient,
    is_page_bound_request,
    identify_draft_task,
    identify_grounded_task,
    extract_text_visible_options,
    merge_grounded_task_identity,
    normalise_legacy_task_kind,
    parse_engineering_quantities,
    pair_coordinate_answer_options,
    selected_result_matches_visible_option,
    source_label_matches,
    build_allowed_mapping_labels,
    validate_repaired_answer,
)
from app.services.visual_repair import (
    VisualAnswerOptionResult,
    VisualTaskIdentityResult,
    build_visual_identity_prompt,
    generate_visual_task_identity,
    visual_identity_model_for_task,
    repair_false_visual_denial,
)


def test_visual_task_traits_separate_explanation_checkbox_and_calculation() -> None:
    paragraph = classify_task_traits("Explain this paragraph.")
    assert paragraph.visual_kind is VisualTaskKind.TEXT_EXPLANATION
    assert not paragraph.requires_numerical_validation
    assert not paragraph.requires_pre_display_verification

    checkbox = classify_task_traits("Which checkbox is marked?")
    assert checkbox.visual_kind is VisualTaskKind.CHECKBOX_EXTRACTION
    assert checkbox.requires_spatial_reasoning
    assert checkbox.requires_pre_display_verification

    calculation = classify_task_traits("Calculate Aufgabe 14.4.")
    assert calculation.visual_kind is VisualTaskKind.NUMERICAL_CALCULATION
    assert calculation.requires_numerical_validation


def test_text_only_calculation_does_not_require_an_image() -> None:
    traits = classify_task_traits("Solve x + 3 = 8.")
    assert traits.calculation_context is CalculationContext.TEXT_ONLY
    assert not traits.requires_visual_evidence
    assert evidence_requirement(
        traits=traits,
        current_page_text="",
        text_quality=0.0,
        image_count=0,
    ) == "text_sufficient"

    visible = classify_task_traits(
        "Solve Aufgabe 14.4.",
        visible_text="Aufgabe 14.4: Berechnen Sie V_Spritz = ?",
        active_document_id="document",
    )
    assert visible.calculation_context is CalculationContext.CURRENT_PAGE
    assert visible.requires_visual_evidence


def test_evidence_requirement_allows_formula_text_but_requires_checkbox_image() -> None:
    formula = classify_task_traits("Explain this formula.")
    text = "The visible formula is V = pi * r^2 * h. " * 12
    assert assess_text_quality(text) >= 0.8
    assert evidence_requirement(
        traits=formula,
        current_page_text=text,
        text_quality=assess_text_quality(text),
        image_count=0,
    ) == "text_sufficient"

    checkbox = classify_task_traits("Which checkbox is marked?")
    assert evidence_requirement(
        traits=checkbox,
        current_page_text=text,
        text_quality=1.0,
        image_count=0,
    ) == "image_required"


def test_number_roles_exclude_identifiers_and_keep_quantities() -> None:
    values = classify_number_roles(
        "Aufgabe 14.4\n1. First\n2. Second\nPage 39\nt = 3.73 mm\nV = 191 cm³"
    )
    roles = [(item.value, item.role) for item in values]
    assert ("14.4", NumberRole.EXERCISE_IDENTIFIER) in roles
    assert ("1", NumberRole.LIST_MARKER) in roles
    assert ("2", NumberRole.LIST_MARKER) in roles
    assert ("39", NumberRole.PAGE_IDENTIFIER) in roles
    assert ("3.73", NumberRole.QUANTITY) in roles
    assert ("191", NumberRole.QUANTITY) in roles


def test_semantic_identity_mismatches_domain_and_requested_quantity() -> None:
    source = GroundedTaskIdentity(
        exercise_reference="14.4",
        domain="injection_moulding",
        requested_quantities=["V_Spritz"],
        task_kind="checkbox_calculation",
    )
    draft = DraftTaskIdentity(
        exercise_reference="14.4",
        domain="machining",
        answered_quantities=["T_min"],
        answer_type="narrative",
    )
    mismatches = compare_task_identities(source, draft)
    assert GroundingMismatch.DOMAIN in mismatches
    assert GroundingMismatch.REQUESTED_QUANTITY in mismatches
    assert GroundingMismatch.ANSWER_TYPE in mismatches


def test_missing_draft_fields_fail_high_confidence_identity() -> None:
    source = GroundedTaskIdentity(
        document_id="document",
        page=39,
        exercise_reference="14.4",
        domain="injection_moulding",
        requested_quantities=["V_Spritz"],
        task_kind="calculation",
        source_confidence=1.0,
    )
    traits = classify_task_traits(
        "Solve Aufgabe 14.4.",
        visible_text="Berechnen Sie V_Spritz = ?",
        active_document_id="document",
    )
    mismatches = compare_task_identities(
        source,
        DraftTaskIdentity(answer_type="narrative"),
        traits=traits,
    )
    assert GroundingMismatch.MISSING_DRAFT_DOMAIN in mismatches
    assert GroundingMismatch.MISSING_REQUESTED_QUANTITY in mismatches
    assert not identity_is_sufficient(
        GroundedTaskIdentity(
            document_id="document",
            page=39,
            exercise_reference="14.4",
            source_confidence=1.0,
        ),
        traits=traits,
    )


def test_active_exercise_scope_is_resolved_before_retrieval() -> None:
    traits = classify_task_traits(
        "Solve Aufgabe 14.4.",
        visible_text="Berechnen Sie V_Spritz = ?",
        active_document_id="active",
    )
    identity = GroundedTaskIdentity(
        document_id="active",
        page=39,
        exercise_reference="14.4",
        requested_quantities=["V_Spritz"],
        source_confidence=1.0,
    )
    scope = build_retrieval_scope(
        active_document_id="active",
        visible_page=39,
        identity=identity,
        traits=traits,
        fallback_document_ids=["active", "cutting-speed-document"],
    )
    assert scope.document_ids == ["active"]
    assert scope.preferred_pages == [38, 39, 40]
    assert not scope.allow_course_fallback


def test_open_pdf_is_preferred_but_does_not_hard_scope_course_question() -> None:
    traits = classify_task_traits("What loss functions did we study in this course?")
    scope = build_retrieval_scope(
        active_document_id="random-exam",
        visible_page=39,
        identity=GroundedTaskIdentity(document_id="random-exam", page=39),
        traits=traits,
        fallback_document_ids=["lecture-1", "lecture-4", "random-exam"],
        question="What loss functions did we study in this course?",
    )
    assert scope.document_ids == ["lecture-1", "lecture-4", "random-exam"]
    assert scope.preferred_pages == [38, 39, 40]
    assert scope.allow_course_fallback
    identity = identify_grounded_task(
        question="What loss functions did we study in this course?",
        current_page_text="Aufgabe 14.4 Spritzguss V_Spritz = ?",
        document_id="random-exam",
        filename="exam.pdf",
        page=39,
        traits=traits,
    )
    assert identity.exercise_reference is None


def test_identity_confidence_requires_visible_semantic_evidence() -> None:
    weak = identify_grounded_task(
        question="now 14.4",
        current_page_text="Unrelated readable lecture text",
        document_id="document",
        filename="exam.pdf",
        page=39,
    )
    assert weak.source_confidence < 0.72
    assert not identity_is_sufficient(weak, traits=classify_task_traits("now 14.4"))

    grounded = identify_grounded_task(
        question="Calculate Aufgabe 14.4",
        current_page_text="Aufgabe 14.4 Spritzguss: Gesucht: V_Spritz = ?\n191 cm³ [X]",
        document_id="document",
        filename="exam.pdf",
        page=39,
        traits=classify_task_traits("Calculate Aufgabe 14.4"),
    )
    assert grounded.source_confidence >= 0.9
    assert grounded.visible_answer_options == ["191 cm³"]
    assert identity_is_sufficient(
        grounded,
        traits=classify_task_traits(
            "Calculate Aufgabe 14.4",
            visible_text="Aufgabe 14.4 V_Spritz = ?",
            active_document_id="document",
        ),
    )


def test_checkbox_marks_are_detected_without_checkbox_word() -> None:
    assert identify_draft_task("[X] V_Spritz = 191 cm³").answer_type == "checkbox"
    assert identify_draft_task("✓ V_Spritz = 191 cm³").answer_type == "checkbox"


def test_route_resolves_identity_and_scope_before_primary_retrieval() -> None:
    stream_path = Path(__file__).resolve().parents[1] / "app" / "routers" / "stream.py"
    source = stream_path.read_text(encoding="utf-8")
    identity_position = source.index("grounded_identity = identify_grounded_task(")
    scope_position = source.index("final_grounding_state = derive_grounding_state(")
    started_position = source.index('"primary_retrieval_started"')
    retrieval_position = source.index("lambda: retrieve_routed_chunks(")
    completed_position = source.index('"primary_retrieval_completed"')
    assert identity_position < scope_position < started_position < retrieval_position
    assert retrieval_position < completed_position
    assert "extraction_context.document_revision != document_revision" in source
    route_body = source[source.index("async def _prepare_ask_stream_response"):]
    assert "load_extraction_context(" not in route_body


def test_final_derived_state_rebuilds_scope_obligations_and_fingerprint() -> None:
    traits = classify_task_traits(
        "Calculate Aufgabe 14.4 and select the option",
        visible_text="Aufgabe 14.4 V_Spritz",
        has_visible_image=True,
        active_document_id="doc",
    )
    initial = GroundedTaskIdentity(
        document_id="doc", visible_page=39, resolved_task_page=39,
        exercise_reference="14.4", domain="injection_moulding",
        source_confidence=0.75, identity_evidence_pages=[39],
    )
    refined = GroundedTaskIdentity(
        document_id="doc", visible_page=39, resolved_task_page=42,
        exercise_reference="14.4", domain="injection_moulding",
        requested_quantities=["V_Spritz"],
        task_kind=GroundedTaskKind.CHECKBOX_CALCULATION,
        visible_answer_options=["191 cm³"], source_confidence=0.98,
        identity_evidence_pages=[42],
        exercise_visible_on_visible_page=False,
        exercise_found_on_resolved_page=True,
    )
    common = dict(
        traits=traits, active_document_id="doc", visible_page=39,
        fallback_document_ids=["other"], question="Find and solve 14.4",
        has_valid_selected_region=False, document_revision="rev",
        visible_page_text="page text", image_hashes=["image"],
    )
    initial_state = derive_grounding_state(identity=initial, **common)
    final_state = derive_grounding_state(identity=refined, **common)
    assert final_state.retrieval_scope.preferred_pages == [41, 42, 43]
    assert final_state.retrieval_document_ids == ["doc"]
    assert final_state.reliability_fingerprint != initial_state.reliability_fingerprint
    obligation_types = {item.obligation_type for item in final_state.answer_obligations}
    assert {
        "include_requested_quantity", "include_final_numeric_value",
        "include_compatible_unit", "select_visible_option",
    }.issubset(
        obligation_types
    )


def test_resolved_page_provenance_does_not_claim_visible_page_match() -> None:
    user = GroundedTaskIdentity(document_id="doc", visible_page=39, exercise_reference="14.4")
    text = GroundedTaskIdentity(
        document_id="doc", page=39, visible_page=39, exercise_reference="14.4",
        source_confidence=0.5,
    )
    merged = merge_grounded_task_identity(
        user_identity=user,
        text_identity=text,
        visual_identity=VisualTaskIdentityResult(
            exercise_reference="14.4", detected_task_references=["14.4"],
            detected_task_count=1, domain="injection_moulding",
            requested_quantities=["V_Spritz"], evidence_page=42, confidence=0.98,
        ),
        detected_task_count=1,
    )
    assert merged.visible_page == 39
    assert merged.resolved_task_page == 42
    assert not merged.exercise_visible_on_visible_page
    assert merged.exercise_found_on_resolved_page


def test_visual_identity_prompt_is_anchored_to_requested_exercise() -> None:
    prompt = build_visual_identity_prompt(
        user_question="Solve Aufgabe 14.4",
        requested_exercise="14.4",
        visible_page=39,
        active_filename="exam.pdf",
        selected_region_present=False,
    )
    assert "Requested exercise: 14.4" in prompt
    assert "Visible page: 39" in prompt
    assert "Do not return\nanother exercise" in prompt
    assert "detected_task_references" in prompt


def test_unresolved_specific_files_never_expand_to_whole_course() -> None:
    stream_path = Path(__file__).resolve().parents[1] / "app" / "routers" / "stream.py"
    source = stream_path.read_text(encoding="utf-8")
    assert 'effective_scope = "all_course_files"' not in source
    assert '"requested_documents_not_resolved"' in source
    assert '"requested_documents_ambiguous"' in source
    assert '"documentCandidates": candidates' in source


class _DocumentResolutionQuery:
    def __init__(self, rows: list[dict[str, str]]) -> None:
        self.rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class _DocumentResolutionClient:
    def __init__(self, rows: list[dict[str, str]]) -> None:
        self.rows = rows

    def table(self, name: str):
        assert name == "documents"
        return _DocumentResolutionQuery(self.rows)


def test_document_name_resolution_rejects_partial_multi_file_match(monkeypatch) -> None:
    monkeypatch.setattr(
        stream_router,
        "get_supabase",
        lambda: _DocumentResolutionClient([
            {"id": "doc-a", "file_name": "Lecture A.pdf"},
        ]),
    )
    result = stream_router._resolve_document_names(
        "user", "course", ["Lecture A.pdf", "Lecture 66.pdf"]
    )
    assert result["resolved_ids"] == ["doc-a"]
    assert result["unresolved_names"] == ["Lecture 66.pdf"]
    assert result["ambiguous_candidates"] == []


def test_document_name_resolution_normalizes_paths_encoding_and_extension(monkeypatch) -> None:
    monkeypatch.setattr(
        stream_router,
        "get_supabase",
        lambda: _DocumentResolutionClient([
            {"id": "doc-a", "file_name": "Lecture Notes.docx"},
        ]),
    )
    result = stream_router._resolve_document_names(
        "user", "course",
        # A URL-encoded name with a Windows-style path prefix and a
        # different (but equivalent, case-insensitive) supported extension.
        ["folder%5CLecture%20Notes.DOCX"],
    )
    assert result["resolved_ids"] == ["doc-a"]
    assert result["unresolved_names"] == []
    assert result["ambiguous_candidates"] == []


def test_document_name_resolution_returns_verified_ambiguous_candidates(monkeypatch) -> None:
    monkeypatch.setattr(
        stream_router,
        "get_supabase",
        lambda: _DocumentResolutionClient([
            {"id": "doc-a", "file_name": "Exam.pdf"},
            {"id": "doc-b", "file_name": "Exam.PDF"},
        ]),
    )
    result = stream_router._resolve_document_names(
        "user", "course", ["exam"]
    )
    assert result["resolved_ids"] == []
    assert result["unresolved_names"] == []
    assert result["ambiguous_candidates"] == [
        {"id": "doc-a", "name": "Exam.pdf", "requestedName": "exam"},
        {"id": "doc-b", "name": "Exam.PDF", "requestedName": "exam"},
    ]


def test_visual_denial_repair_is_bounded_and_returns_repaired_answer() -> None:
    calls = 0

    def generator(**_) -> str:
        nonlocal calls
        calls += 1
        return "The formula shows V = 191 cm³."

    result = asyncio.run(repair_false_visual_denial(
        request_id="request",
        question="Explain it",
        draft="I cannot see the formula. Please open the PDF.",
        visible_page=39,
        open_context="V_Spritz",
        image_parts=[{"mediaType": "image/png", "data": "abc"}],
        model="test",
        generator=generator,
    ))
    assert calls == 1
    assert result == "The formula shows V = 191 cm³."


def test_visual_repair_must_satisfy_identity_and_mapping_obligations() -> None:
    traits = classify_task_traits("Which labels 1 to 9 are correct?")
    validation = validate_repaired_answer(
        answer="The diagram contains several machine components.",
        identity=GroundedTaskIdentity(
            document_id="document",
            page=39,
            exercise_reference="14.1",
            task_kind="matching",
            source_confidence=1.0,
        ),
        traits=traits,
        required_identifiers=[str(value) for value in range(1, 10)],
    )
    assert not validation.accepted
    assert any(
        item.obligation_type == "complete_mapping" and not item.satisfied
        for item in validation.obligations
    )

    invented = validate_repaired_answer(
        answer="\n".join(f"{number}. Invented Label {number}" for number in range(1, 10)),
        identity=GroundedTaskIdentity(
            document_id="document",
            page=39,
            exercise_reference="14.1",
            visible_answer_options=[f"Source Label {number}" for number in range(1, 10)],
            task_kind="matching",
            source_confidence=1.0,
        ),
        traits=traits,
        required_identifiers=[str(value) for value in range(1, 10)],
        allowed_source_labels=[f"Source Label {number}" for number in range(1, 10)],
    )
    assert not invented.accepted
    assert any(item.obligation_type == "allowed_mapping_labels" and not item.satisfied
               for item in invented.obligations)


def test_distant_solution_pairing_gap_review_and_direction() -> None:
    question = ExtractedQuestion(
        "9.2", "9.2", "Welche Verfahren?", 3, question_fingerprint="fingerprint", confidence=0.9,
    )
    solution = ExtractedSolutionEvidence(
        "9.2", "9.2", "Stereolithografie.", 30, "checked_option",
        question_fingerprint="fingerprint", confidence=0.9,
    )
    paired = pair_questions_and_solutions([question], [solution])
    assert paired[0].answer_page == 30
    assert paired[0].pairing_method == "normalized_item_id"

    gap = review_numbering_gap(
        "9.1",
        neighbouring_text="Aufgabe 9.1 entfällt in dieser Variante.",
        reviewed_pages=[2, 3],
    )
    assert gap.status is GapStatus.INTENTIONAL
    assert gap.search_performed
    found_gap = review_numbering_gap(
        "9.1",
        neighbouring_text="Aufgabe 9.1 Welche Aussage ist richtig?",
        reviewed_pages=[2],
    )
    assert found_gap.status is GapStatus.CONFIRMED_MISSING
    assert found_gap.evidence_pages == [2]

    incomplete_review = review_numbering_gap(
        "9.1",
        neighbouring_text="No match here",
        reviewed_pages=[2],
        review_result=GapReviewResult(
            exact_text_search_performed=True,
            full_section_search_performed=False,
            solution_section_search_performed=False,
            reviewed_pages=[2],
        ),
    )
    assert incomplete_review.status is GapStatus.UNRESOLVED

    context = DocumentExtractionContext(
        conversation_id="conversation",
        document_id="document",
        document_revision="1",
        source_fingerprint="hash",
        target_section="Kurzfragen",
        requested_scope="all",
        earliest_source_page=9,
        latest_source_page=20,
    )
    assert extraction_pages_for_direction(
        "earlier", context=context, section_start_page=1, section_end_page=30,
    ) == list(range(1, 9))
    assert extraction_pages_for_direction(
        "later", context=context, section_start_page=1, section_end_page=30,
    ) == list(range(21, 31))
    context.unresolved_pages = [17]
    assert extraction.infer_extraction_rescan_direction(
        "This is not all of them; check the whole document",
    ) == "full_scope_rebuild"
    assert extraction_pages_for_direction(
        "full_scope_rebuild", context=context, section_start_page=1, section_end_page=30,
    ) == list(range(1, 31))
    restored = extraction_context_from_api(extraction_context_to_api(context))
    assert restored is not None
    assert restored.source_fingerprint == "hash"
    assert restored.earliest_source_page == 9


def test_item_boundaries_and_empty_target_ranges_are_distinct(monkeypatch) -> None:
    context = DocumentExtractionContext(
        conversation_id="conversation",
        document_id="document",
        document_revision="1",
        source_fingerprint="hash",
        target_section="Kurzfragen",
        requested_scope="all",
        scanned_pages=list(range(1, 44)),
        earliest_scanned_page=1,
        latest_scanned_page=43,
        earliest_item_page=9,
        latest_item_page=30,
    )
    assert extraction_pages_for_direction(
        "earlier", context=context, section_start_page=1, section_end_page=43,
    ) == list(range(1, 9))

    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: ({"page_count": 43}, []),
    )
    result = extraction.extract_document_qa(
        user_id="u",
        course_id="c",
        document_id="d",
        target="Kurzfragen",
        pages_to_scan=[],
    )
    assert result.status == "no_pages_in_requested_direction"
    assert result.scanned_pages == []
    assert result.unreadable_pages == []


def test_question_and_solution_model_passes_are_independent(monkeypatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_document_pages",
        lambda **_: (
            {"page_count": 1},
            [{"page_number": 1, "cleaned_text": "1. Kurzfragen - Grundlagen\n" + "Kurzfragen Lösung " * 30}],
        ),
    )
    systems: list[str] = []

    def fake_chat_json(*, system: str, **_):
        systems.append(system)
        data = (
            {"questions": [{
                "item_id": "1.1",
                "question": "Frage?",
                "question_page": 1,
                "confidence": 0.9,
            }]}
            if "QUESTIONS ONLY" in system
            else {"solutions": [{
                "item_id": "1.1",
                "answer_text": "Antwort.",
                "answer_page": 1,
                "evidence_type": "printed_answer",
                "confidence": 0.9,
            }]}
        )
        return SimpleNamespace(
            data=data,
            model="test",
            prompt_tokens=1,
            completion_tokens=1,
        )

    monkeypatch.setattr(extraction, "chat_json", fake_chat_json)
    result = extraction.extract_document_qa(
        user_id="u",
        course_id="c",
        document_id="d",
        target="Kurzfragen",
    )
    assert len(systems) == 2
    assert "QUESTIONS ONLY" in systems[0]
    assert "SOLUTION EVIDENCE ONLY" in systems[1]
    assert result.paired_items[0].answer_text == "Antwort."


def test_selected_document_readiness_accepts_usable_legacy_index() -> None:
    from app.routers.stream import _selected_document_readiness_issue

    base = {
        "processing_status": "ready",
        "page_count": 43,
        "chunk_count": 120,
        "active_index_revision": "revision-2",
    }
    assert _selected_document_readiness_issue(base) is None
    assert _selected_document_readiness_issue({**base, "processing_status": "indexing"}) == "indexing"
    assert _selected_document_readiness_issue({**base, "processing_status": "failed"}) == "failed"
    assert _selected_document_readiness_issue({**base, "page_count": 0}) == "missing_pages"
    assert _selected_document_readiness_issue({**base, "chunk_count": 0}) == "missing_chunks"
    assert _selected_document_readiness_issue({**base, "active_index_revision": None}) == "missing_active_revision"
    assert _selected_document_readiness_issue({
        **base,
        "active_index_revision": None,
        "index_revision_status": "legacy",
    }) is None
    assert _selected_document_readiness_issue({
        **base,
        "active_index_revision": "",
        "index_revision_status": "structural_reindex_required",
    }) is None
    # This is the projected row shape used by _load_authorized_documents in
    # production; it exposes structural_index_status, not index_revision_status.
    assert _selected_document_readiness_issue({
        **base,
        "active_index_revision": "",
        "structural_index_status": "structural_reindex_required",
    }) is None


def test_page_classifier_skips_irrelevant_and_routes_specialised_pages() -> None:
    assert classify_extraction_page("", "Kurzfragen") is ExtractionPageKind.IRRELEVANT
    assert classify_extraction_page(
        "Kurzfragen 9.1 Welche Aussage stimmt?", "Kurzfragen",
    ) is ExtractionPageKind.QUESTION
    assert classify_extraction_page(
        "Musterlösung 9.1: Antwort B ist richtig.", "Kurzfragen",
    ) is ExtractionPageKind.SOLUTION
    assert classify_extraction_page(
        "Kurzfragen 9.1? Lösung: B ist richtig.", "Kurzfragen",
    ) is ExtractionPageKind.MIXED


def test_obsolete_wrong_language_refusal_is_absent_from_production_paths() -> None:
    root = Path(__file__).resolve().parents[3]
    needle = "The answer was generated in the wrong language and was not shown."
    paths = [
        root / "backend" / "python-ai" / "app",
        root / "frontend",
        root / "functions",
        root / "dist",
    ]
    matches = []
    for path in paths:
        if not path.exists():
            continue
        for file in path.rglob("*"):
            if file.is_file() and file.suffix in {".py", ".ts", ".js", ".html"}:
                if needle in file.read_text(encoding="utf-8", errors="ignore"):
                    matches.append(file)
    assert matches == []


def test_structured_visual_identity_merges_without_prose_reparse() -> None:
    user = GroundedTaskIdentity(document_id="doc", page=39, exercise_reference="14.4")
    text = identify_grounded_task(
        question="Solve Aufgabe 14.4 on this page",
        current_page_text="Aufgabe 14.4 Spritzguss",
        document_id="doc", filename="exam.pdf", page=39,
    )
    visual = VisualTaskIdentityResult(
        exercise_reference="14.4",
        domain="injection_moulding",
        requested_quantities=["V_Spritz"],
        visible_values=["t = 3.73 mm", "V_Spritz = 191 cm³"],
        visible_answer_options=[VisualAnswerOptionResult(
            text="V_Spritz = 191 cm³", selected=True, page=39,
            confidence=0.98,
        )],
        visible_formula_symbols=["V_Spritz", "t"],
        task_kind="checkbox_calculation",
        evidence_page=39,
        confidence=0.97,
    )
    merged = merge_grounded_task_identity(
        user_identity=user, text_identity=text, visual_identity=visual,
    )
    assert merged.requested_quantities == ["V_Spritz"]
    assert merged.option_texts() == ["V_Spritz = 191 cm³"]
    assert merged.visible_answer_options[0].selected is True
    assert merged.identity_resolution_method is IdentityResolutionMethod.CURRENT_PAGE_VISION
    assert merged.identity_evidence_pages == [39]
    assert merged.exercise_visible_on_page


def test_page_bound_exercise_requires_exact_page_evidence() -> None:
    traits = classify_task_traits("Solve Aufgabe 14.4 on this page")
    user_only = GroundedTaskIdentity(
        document_id="doc", page=39, exercise_reference="14.4",
        domain="injection_moulding", requested_quantities=["V_Spritz"],
        source_confidence=1.0,
    )
    assert not identity_is_sufficient(
        user_only, traits=traits, page_bound_request=True,
    )
    user_only.exercise_visible_on_page = True
    user_only.identity_evidence_pages = [39]
    assert identity_is_sufficient(
        user_only, traits=traits, page_bound_request=True,
    )


def test_numbered_exercise_is_document_bound_unless_user_points_to_visible_page() -> None:
    assert not is_page_bound_request(
        "Solve Aufgabe 14.4", active_document_id="doc",
    )
    assert not is_page_bound_request(
        "Explain 12.1 to 12.6 and 12.16 to 12.21",
        active_document_id="doc",
    )
    assert is_page_bound_request(
        "Solve Aufgabe 14.4 on this page", active_document_id="doc",
    )
    traits = classify_task_traits("Solve Aufgabe 14.4", active_document_id="doc")
    assert traits.calculation_context is CalculationContext.TEXT_ONLY


def test_document_section_request_has_no_fake_current_page_preference() -> None:
    traits = classify_task_traits("Solve Aufgabe 12.1")
    identity = GroundedTaskIdentity(
        document_id="doc", page=2, visible_page=2,
        exercise_reference="12.1", source_confidence=0.4,
    )
    scope = build_retrieval_scope(
        active_document_id="doc", visible_page=2, identity=identity,
        traits=traits, fallback_document_ids=["doc"],
        question="Solve Aufgabe 12.1", has_valid_selected_region=False,
    )
    assert scope.document_ids == ["doc"]
    assert scope.preferred_pages == []


def test_selected_region_has_identity_priority_and_provenance() -> None:
    identity = identify_grounded_task(
        question="Solve Aufgabe 14.4 here",
        selected_region_text="Aufgabe 14.4: Gesucht V_Spritz = ?\n[X] 191 cm³",
        current_page_text="Lecture footer and unrelated page text",
        document_id="doc", filename="exam.pdf", page=39,
    )
    assert identity.exercise_visible_on_page
    assert identity.identity_resolution_method is IdentityResolutionMethod.SELECTED_REGION
    assert identity.identity_evidence_pages == [39]
    assert identity.option_texts() == ["191 cm³"]


def test_mapping_aliases_are_tolerant_but_not_semantic_guessing() -> None:
    allowed = build_allowed_mapping_labels(["Anguss/Angusskanal", "Granulat-Zufuhr"])
    assert source_label_matches("Angusskanal", allowed[0])
    assert source_label_matches("Anguss", allowed[0])
    assert source_label_matches("der Angusskanal", allowed[0])
    assert source_label_matches(
        "Angusskanal, through which the melt enters", allowed[0],
    )
    assert source_label_matches("Granulatzufuhr", allowed[1])
    assert not source_label_matches("generic machine component", allowed[0])


def test_calculation_obligations_require_value_unit_and_visible_option() -> None:
    traits = classify_task_traits("Calculate and select the correct checkbox")
    identity = GroundedTaskIdentity(
        requested_quantities=["V_Spritz"],
        task_kind="checkbox_calculation",
        visible_values=["V_Spritz = 191 cm³"],
        visible_answer_options=[VisibleAnswerOption(text="191 cm³", selected=True, page=39)],
    )
    assert not validate_repaired_answer(
        answer="The requested quantity is V_Spritz.", identity=identity, traits=traits,
    ).accepted
    assert not validate_repaired_answer(
        answer="For V_Spritz, the given thickness is t = 3.73 mm.",
        identity=identity, traits=traits,
    ).accepted
    valid = validate_repaired_answer(
        answer="[X] V_Spritz ≈ 191 cm3", identity=identity, traits=traits,
    )
    assert valid.accepted
    assert selected_result_matches_visible_option(
        answer="V_Spritz = 191 cm3", options=identity.visible_answer_options,
    )
    assert not selected_result_matches_visible_option(
        answer="V_Spritz = 177 cm³", options=identity.visible_answer_options,
    )


def test_coordinate_separated_checkbox_and_text_are_paired() -> None:
    paired = pair_coordinate_answer_options(
        checkboxes=[CheckboxGeometry(10, 100, 20, 110, True)],
        text_spans=[LayoutTextSpan("V_Spritz = 191 cm³", 28, 99, 150, 112)],
        page=39,
    )
    assert len(paired) == 1
    assert paired[0].selected is True
    assert paired[0].text == "V_Spritz = 191 cm³"
    assert paired[0].source == "coordinate_pairing"


def test_leading_and_trailing_checkbox_options_keep_selection_state() -> None:
    options = extract_text_visible_options(
        "[ ] 177 cm³\n[X] 191 cm³\n205 cm³ ☐\n222 cm³ ✓", 39,
    )
    by_text = {option.text: option for option in options}
    assert by_text["177 cm³"].selected is False
    assert by_text["191 cm³"].selected is True
    assert by_text["205 cm³"].selected is False
    assert by_text["222 cm³"].selected is True


def test_gap_review_requires_full_document_coverage() -> None:
    incomplete = review_numbering_gap(
        "9.1", neighbouring_text="", reviewed_pages=[3],
        review_result=GapReviewResult(
            exact_text_search_performed=True,
            full_section_search_performed=True,
            solution_section_search_performed=True,
            coverage=GapSearchCoverage(full_document_text_searched=False),
        ),
    )
    assert incomplete.status is GapStatus.UNRESOLVED
    complete = review_numbering_gap(
        "9.1", neighbouring_text="", reviewed_pages=list(range(1, 31)),
        review_result=GapReviewResult(
            exact_text_search_performed=True,
            full_section_search_performed=True,
            solution_section_search_performed=True,
            coverage=GapSearchCoverage(
                full_document_text_searched=True,
                existing_visual_results_reviewed=True,
            ),
        ),
    )
    assert complete.status is GapStatus.REVIEWED_NOT_FOUND


def test_page_classification_weak_solution_word_is_uncertain() -> None:
    result = classify_extraction_page_result(
        "This formula sheet discusses the correct unit and the right method in a long lecture paragraph.",
        "Kurzfragen",
    )
    assert result.kind is ExtractionPageKind.UNCERTAIN
    assert result.confidence < 0.8


def test_visual_identity_schema_retries_invalid_json_once(monkeypatch) -> None:
    calls = 0
    strict_modes = []

    class Completions:
        def create(self, **kwargs):
            nonlocal calls
            calls += 1
            strict_modes.append(kwargs["response_format"]["json_schema"]["strict"])
            content = "not-json" if calls == 1 else (
                '{"exercise_reference":"14.1","domain":"injection_moulding",'
                '"requested_quantities":[],"visible_values":[],"visible_answer_options":[],'
                '"visible_mapping_labels":["Anguss/Angusskanal"],'
                '"visible_formula_symbols":[],"task_kind":"diagram_labelling",'
                '"task_summary":"Map labels","evidence_page":38,"confidence":0.98}'
            )
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=content),
            )])

    client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    monkeypatch.setattr(visual_repair_service, "get_openai_client", lambda: client)
    result = generate_visual_task_identity(
        prompt="identify", images=[{"mediaType": "image/png", "data": "abc"}],
        model="test",
    )
    assert calls == 2
    assert strict_modes == [True, False]
    assert result.exercise_reference == "14.1"
    assert result.visible_mapping_labels == ["Anguss/Angusskanal"]


def test_unbound_visual_identity_cannot_inflate_or_supply_exact_fields() -> None:
    text = GroundedTaskIdentity(
        document_id="doc", page=39, visible_page=39,
        exercise_reference="14.4", source_confidence=0.45,
    )
    visual = VisualTaskIdentityResult(
        exercise_reference=None, domain="machining",
        requested_quantities=["T_min"], task_kind=GroundedTaskKind.CHECKBOX_CALCULATION,
        evidence_page=39, confidence=0.99,
    )
    merged = merge_grounded_task_identity(
        user_identity=text, text_identity=text, visual_identity=visual,
        detected_task_count=2,
    )
    assert merged.visual_identity_binding is VisualIdentityBinding.AMBIGUOUS
    assert merged.domain is None
    assert merged.requested_quantities == []
    assert merged.source_confidence < 0.72


def test_visual_binding_conflict_and_resolved_page_provenance() -> None:
    user = GroundedTaskIdentity(document_id="doc", page=39, exercise_reference="14.4")
    text = GroundedTaskIdentity(
        document_id="doc", page=39, visible_page=39, exercise_reference="14.4",
        domain="injection_moulding", source_confidence=0.7,
    )
    conflicting = merge_grounded_task_identity(
        user_identity=user, text_identity=text,
        visual_identity=VisualTaskIdentityResult(
            exercise_reference="14.1", domain="injection_moulding",
            evidence_page=42, confidence=0.98,
        ),
    )
    assert conflicting.visual_identity_binding is VisualIdentityBinding.CONFLICTING_EXERCISE
    assert conflicting.regrounding_required
    resolved = merge_grounded_task_identity(
        user_identity=user, text_identity=text,
        visual_identity=VisualTaskIdentityResult(
            exercise_reference="14.4", domain="injection_moulding",
            requested_quantities=["V_Spritz"], evidence_page=42, confidence=0.98,
        ),
    )
    assert resolved.visual_identity_binding is VisualIdentityBinding.EXACT_EXERCISE_MATCH
    assert resolved.visible_page == 39
    assert resolved.resolved_task_page == 42
    assert resolved.page == 42
    assert resolved.identity_evidence_pages == [42]


def test_selected_region_can_bind_visual_identity_without_number() -> None:
    text = GroundedTaskIdentity(document_id="doc", page=8, visible_page=8)
    merged = merge_grounded_task_identity(
        user_identity=text, text_identity=text,
        visual_identity=VisualTaskIdentityResult(
            domain="thermodynamics", evidence_page=8, confidence=0.9,
        ),
        has_selected_region=True,
    )
    assert merged.visual_identity_binding is VisualIdentityBinding.SELECTED_REGION_BOUND
    assert merged.domain == "thermodynamics"


def test_task_kind_enum_and_legacy_normalisation() -> None:
    assert normalise_legacy_task_kind("calculation checkbox") is GroundedTaskKind.CHECKBOX_CALCULATION
    assert normalise_legacy_task_kind("multiple_choice_calculation") is GroundedTaskKind.CHECKBOX_CALCULATION
    assert normalise_legacy_task_kind("invented_kind") is None
    try:
        VisualTaskIdentityResult(task_kind="invented_kind")
    except ValueError:
        pass
    else:
        raise AssertionError("unsupported visual task kind was accepted")


def test_gap_variants_require_structural_context_for_compact_ids() -> None:
    variants = extraction.gap_id_variants("9.1")
    assert all(isinstance(item, GapIdVariant) for item in variants)
    compact = next(item for item in variants if item.value == "91")
    assert compact.requires_question_context
    assert not extraction._gap_variant_matches_text(compact, "The result is 91 mm.")
    assert not extraction._gap_variant_matches_text(compact, "See page 91.")
    assert extraction._gap_variant_matches_text(compact, "Kurzfrage 91: Was gilt?")
    review = review_numbering_gap(
        "9.1", neighbouring_text="Kurzfrage 91: Was gilt?", reviewed_pages=[4],
    )
    assert review.status is GapStatus.UNRESOLVED


def test_gap_budget_exhaustion_is_never_reported_as_complete() -> None:
    coverage = GapSearchCoverage(
        full_document_text_searched=True,
        existing_visual_results_reviewed=True,
        targeted_visual_pages_required=[4, 5, 6],
        targeted_visual_pages_searched=[4],
        visual_search_budget_exhausted=True,
        unsearched_candidate_pages=[5, 6],
        targeted_visual_calls_used=12,
    )
    gap = review_numbering_gap(
        "9.1", neighbouring_text="", reviewed_pages=list(range(1, 20)),
        review_result=GapReviewResult(
            exact_text_search_performed=True,
            full_section_search_performed=True,
            solution_section_search_performed=True,
            visual_search_performed=True,
            coverage=coverage,
        ),
    )
    assert gap.status is GapStatus.UNRESOLVED
    assert gap.coverage.visual_search_budget_exhausted


def test_engineering_quantity_parser_covers_units_and_conversions() -> None:
    parsed = parse_engineering_quantities(
        "191 cm³; 191000 mm³; 250 N/mm²; 3000 rpm; 20 °C; 15%; 5 kW"
    )
    by_unit = {item.unit_canonical: item for item in parsed}
    assert by_unit["cm3"].unit_family == "volume"
    assert by_unit["cm3"].base_value == by_unit["mm3"].base_value
    assert by_unit["n_per_mm2"].unit_family == "pressure"
    assert by_unit["per_minute"].value == 3000
    assert by_unit["celsius"].value == 20
    assert by_unit["percent"].value == 15
    assert by_unit["kw"].unit_family == "power"


def test_option_matching_is_precision_aware_convertible_and_ambiguity_safe() -> None:
    assert selected_result_matches_visible_option(
        answer="V_Spritz = 191.04 cm³", options=["191 cm³", "205 cm³"],
    )
    assert selected_result_matches_visible_option(
        answer="V_Spritz = 191000 mm³", options=["191 cm³", "205 cm³"],
    )
    assert not selected_result_matches_visible_option(
        answer="V = 191.04 cm³", options=["191 cm³", "191.0 cm³"],
    )


def test_visual_identity_model_routes_only_demanding_tasks_to_strong(monkeypatch) -> None:
    settings = SimpleNamespace(
        openai_generate_model="standard", openai_generate_model_strong="strong",
    )
    monkeypatch.setattr(visual_repair_service, "get_settings", lambda: settings)
    assert visual_identity_model_for_task(
        classify_task_traits("Map numbers 1 to 9 on this technical drawing"),
        image_count=1, has_mapping_labels=True,
    ) == "strong"
    assert visual_identity_model_for_task(
        classify_task_traits("Explain this paragraph"),
        image_count=1, has_mapping_labels=False,
    ) == "standard"
