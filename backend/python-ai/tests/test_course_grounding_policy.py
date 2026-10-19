from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.services.cache import question_hash
from app.services.answer import (
    build_course_plus_general_prompt,
    build_strict_course_prompt,
)
from app.services.course_grounding import (
    DocumentAuthority,
    assert_authorised_course_chunks,
    build_course_evidence_report,
    infer_document_authority,
    rank_course_chunks,
)
from app.services.source_router import (
    GroundingPolicy,
    SourceScope,
    classify_source_scope,
    effective_document_ids,
)


@dataclass
class Chunk:
    chunk_id: str
    document_id: str
    text: str = ""
    score: float = 0.5
    similarity: float = 0.5
    chunk_type: str = "paragraph"


def test_auto_in_active_course_is_course_first() -> None:
    decision = classify_source_scope(
        question="Explain the professor's convention",
        source_mode="auto",
        selected_course_id="course-a",
    )
    assert decision.grounding_policy == GroundingPolicy.COURSE_FIRST
    assert decision.source_scope == SourceScope.COURSE_FILES


def test_current_academic_question_does_not_silently_become_internet() -> None:
    decision = classify_source_scope(
        question="What is the current formula used in this lecture?",
        source_mode="auto",
        selected_course_id="course-a",
    )
    assert decision.grounding_policy == GroundingPolicy.COURSE_FIRST
    assert decision.source_scope == SourceScope.COURSE_FILES


def test_unambiguous_web_request_may_use_internet() -> None:
    decision = classify_source_scope(
        question="Search the web for the latest official standard",
        source_mode="auto",
        selected_course_id="course-a",
    )
    assert decision.grounding_policy == GroundingPolicy.INTERNET
    assert decision.source_scope == SourceScope.INTERNET


def test_selected_files_only_is_a_hard_document_filter() -> None:
    decision = classify_source_scope(
        question="Use only this PDF",
        source_mode="course_files",
        course_file_scope="specific_files",
        selected_course_id="course-a",
        document_ids=["exercise"],
        active_document_id="lecture",
    )
    assert decision.grounding_policy == GroundingPolicy.SELECTED_FILES_ONLY
    assert effective_document_ids(
        document_ids=["exercise"], active_document_id="lecture",
        course_file_scope=decision.course_file_scope,
    ) == ["exercise"]


def test_all_course_files_keeps_open_pdf_as_hint_not_filter() -> None:
    decision = classify_source_scope(
        question="Solve this exercise",
        source_mode="course_files",
        course_file_scope="all_course_files",
        selected_course_id="course-a",
        active_document_id="exercise",
    )
    assert decision.grounding_policy == GroundingPolicy.COURSE_FIRST
    assert effective_document_ids(
        document_ids=["exercise"], active_document_id="exercise",
        course_file_scope=decision.course_file_scope,
    ) is None


def test_strict_course_requires_explicit_only_wording() -> None:
    decision = classify_source_scope(
        question="Use course files only for this answer",
        source_mode="course_files",
        course_file_scope="all_course_files",
        selected_course_id="course-a",
    )
    assert decision.grounding_policy == GroundingPolicy.STRICT_COURSE


def test_general_supplement_requires_explicit_policy() -> None:
    strict = classify_source_scope(question="Define X", source_mode="auto", selected_course_id="course-a")
    mixed = classify_source_scope(question="Define X", source_mode="course_plus_general", selected_course_id="course-a")
    assert strict.grounding_policy == GroundingPolicy.COURSE_FIRST
    assert mixed.grounding_policy == GroundingPolicy.COURSE_PLUS_GENERAL


def test_professor_and_official_sources_outrank_generated_content() -> None:
    chunks = [Chunk("generated", "g", score=0.99), Chunk("lecture", "l", score=0.4)]
    ranked = rank_course_chunks(chunks, {"g": "Generated summary.pdf", "l": "Professor Vorlesung.pdf"}, "Define X")
    assert ranked[0].document_id == "l"
    assert infer_document_authority("Professor Vorlesung.pdf") == DocumentAuthority.PROFESSOR_LECTURE


def test_numerical_evidence_report_requires_statement_formula_and_solution() -> None:
    chunks = [
        Chunk("q", "exercise"), Chunk("f", "formula", chunk_type="formula"), Chunk("s", "solution"),
    ]
    report = build_course_evidence_report(
        course_id="course-a", searched_document_ids=["exercise", "formula", "solution"],
        chunks=chunks,
        doc_names={"exercise": "Übung.pdf", "formula": "Formelsammlung.pdf", "solution": "Musterlösung.pdf"},
        question="Berechne Aufgabe 2",
    )
    assert report.sufficient
    assert set(report.supporting_document_ids) == {"exercise", "formula", "solution"}


def test_formula_explanation_is_sufficient_with_only_a_formula_sheet_chunk() -> None:
    """Explaining/defining formulas is a different learning objective from
    solving a numbered exercise: it only ever needs the formula itself, not
    an exercise statement or an official solution a formula sheet was never
    going to supply."""
    chunks = [Chunk("f", "sheet", chunk_type="formula")]
    report = build_course_evidence_report(
        course_id="course-a", searched_document_ids=["sheet"], chunks=chunks,
        doc_names={"sheet": "Formelzettel.pdf"},
        question="Explain the formulas on this sheet.",
    )
    assert report.sufficient, report.missing_evidence


def test_formula_explanation_german_paraphrases_are_sufficient() -> None:
    chunks = [Chunk("f", "sheet", chunk_type="formula")]
    for question in ("Erkläre die Formeln auf diesem Blatt.", "Was bedeuten diese Gleichungen?"):
        report = build_course_evidence_report(
            course_id="course-a", searched_document_ids=["sheet"], chunks=chunks,
            doc_names={"sheet": "Formelzettel.pdf"}, question=question,
        )
        assert report.sufficient, (question, report.missing_evidence)


def test_formula_sheet_alone_cannot_satisfy_a_numerical_exercise() -> None:
    """A formula sheet is complete evidence for "explain the formula" but
    incomplete evidence for "calculate this exercise": solving a specific
    numbered problem needs its own statement and an official worked
    solution, neither of which a formula sheet supplies."""
    chunks = [Chunk("f", "sheet", chunk_type="formula")]
    report = build_course_evidence_report(
        course_id="course-a", searched_document_ids=["sheet"], chunks=chunks,
        doc_names={"sheet": "Formelzettel.pdf"},
        question="Calculate the force F using the formula from Aufgabe 5.",
    )
    assert not report.sufficient
    assert "question statement" in report.missing_evidence
    assert "official solution method" in report.missing_evidence


def test_official_solution_request_rejects_unrelated_student_notes() -> None:
    """An explicit ask for the official solution/Musterlösung must be backed
    by an OFFICIAL_SOLUTION-authority document -- a topically relevant
    student-notes chunk is not a substitute, however relevant its text."""
    chunks = [Chunk("n", "notes", chunk_type="text")]
    for question in (
        "What is the official solution for this problem?",
        "Was ist die Musterlösung dafür?",
    ):
        report = build_course_evidence_report(
            course_id="course-a", searched_document_ids=["notes"], chunks=chunks,
            doc_names={"notes": "Mitschrift_Thermodynamik.pdf"}, question=question,
        )
        assert not report.sufficient, question
        assert "official solution method" in report.missing_evidence, question


def test_official_solution_request_is_satisfied_by_a_solution_document() -> None:
    chunks = [Chunk("s", "sol", chunk_type="text")]
    report = build_course_evidence_report(
        course_id="course-a", searched_document_ids=["sol"], chunks=chunks,
        doc_names={"sol": "Musterloesung.pdf"},
        question="What is the official solution for this problem?",
    )
    assert report.sufficient, report.missing_evidence


def test_official_solution_request_is_not_hijacked_by_definition_wording() -> None:
    """The precedence bug this guards: "what is the official solution for
    this formula" matches BOTH question_routing's FORMULA_LOOKUP and
    DEFINITION intents (via its "what is" wording) -- a plain
    PROFESSOR_LECTURE chunk must not satisfy that just because the
    DEFINITION branch would otherwise be checked first."""
    chunks = [Chunk("lec", "lecture", chunk_type="text")]
    report = build_course_evidence_report(
        course_id="course-a", searched_document_ids=["lec"], chunks=chunks,
        doc_names={"lec": "Professor Vorlesung.pdf"},
        question="What is the official solution for this formula?",
    )
    assert not report.sufficient
    assert report.required_evidence == ["official solution method"]


def test_cross_course_chunk_is_rejected_before_generation() -> None:
    with pytest.raises(ValueError, match="outside the authorised course"):
        assert_authorised_course_chunks([Chunk("bad", "course-b-doc")], {"course-a-doc"})


def test_cache_isolated_by_grounding_policy_and_file_scope() -> None:
    common = dict(q="What is X?", source_mode="auto", source_scope="course_files")
    strict = question_hash(**common, grounding_mode="strict_course", course_file_scope="all_course_files")
    general = question_hash(**common, grounding_mode="general", course_file_scope="all_course_files")
    selected = question_hash(
        **common, grounding_mode="selected_files_only", course_file_scope="specific_files",
        selected_document_ids=["doc-a"],
    )
    assert len({strict, general, selected}) == 3


def test_explicit_general_supplement_is_labelled_without_fake_course_citation() -> None:
    prompt = build_course_plus_general_prompt("COURSE FIRST")
    assert "General knowledge supplement (not from course files)" in prompt
    assert "Never attach course citations to that section" in prompt
    assert "STRICT COURSE" in build_strict_course_prompt("COURSE FIRST")


def test_stream_and_non_stream_share_the_same_grounding_prompt_service() -> None:
    from inspect import signature
    from app.services.answer import generate_answer
    from app.services.answer_stream import stream_answer

    assert signature(generate_answer).parameters["grounding_policy"].default == "strict_course"
    assert signature(stream_answer).parameters["grounding_policy"].default == "strict_course"
