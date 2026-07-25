from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.services import document_extraction as extraction
from app.services.document_extraction import (
    DocumentExtractionContext,
    ExtractedQuestion,
    ExtractedSolutionEvidence,
    GapStatus,
    extraction_pages_for_direction,
    extraction_context_from_api,
    extraction_context_to_api,
    pair_questions_and_solutions,
    review_numbering_gap,
)
from app.services.reliability import (
    CalculationContext,
    DraftTaskIdentity,
    GroundedTaskIdentity,
    GroundingMismatch,
    NumberRole,
    VisualTaskKind,
    assess_text_quality,
    classify_number_roles,
    classify_task_traits,
    compare_task_identities,
    build_retrieval_scope,
    evidence_requirement,
    identity_is_sufficient,
    validate_repaired_answer,
)
from app.services.visual_repair import repair_false_visual_denial


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


def test_route_resolves_identity_and_scope_before_primary_retrieval() -> None:
    stream_path = Path(__file__).resolve().parents[1] / "app" / "routers" / "stream.py"
    source = stream_path.read_text(encoding="utf-8")
    identity_position = source.index("grounded_identity = identify_grounded_task(")
    scope_position = source.index("retrieval_scope = build_retrieval_scope(")
    started_position = source.index('"primary_retrieval_started"')
    retrieval_position = source.index("lambda: retrieve_chunks(")
    completed_position = source.index('"primary_retrieval_completed"')
    assert identity_position < scope_position < started_position < retrieval_position
    assert retrieval_position < completed_position


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
            [{"page_number": 1, "cleaned_text": "Kurzfragen " * 30}],
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
