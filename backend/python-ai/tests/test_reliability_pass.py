from __future__ import annotations

import asyncio
from pathlib import Path

from app.services.document_extraction import (
    DocumentExtractionContext,
    ExtractedQuestion,
    ExtractedSolutionEvidence,
    GapStatus,
    extraction_pages_for_direction,
    pair_questions_and_solutions,
    review_numbering_gap,
)
from app.services.reliability import (
    DraftTaskIdentity,
    GroundedTaskIdentity,
    GroundingMismatch,
    NumberRole,
    VisualTaskKind,
    assess_text_quality,
    classify_number_roles,
    classify_task_traits,
    compare_task_identities,
    evidence_requirement,
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
