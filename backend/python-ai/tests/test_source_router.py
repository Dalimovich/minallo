"""Source routing policy checks."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class _Chunk:
    text: str
    similarity: float = 0.0
    chunk_type: str = "paragraph"


def test_course_files_specific_without_file_needs_clarification() -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="Explain this",
        source_mode="course_files",
        course_file_scope="specific_files",
    )

    assert decision.source_scope == SourceScope.NEEDS_CLARIFICATION
    assert "Which file should I use?" in (decision.needs_clarification_message or "")


def test_specific_files_uses_document_ids_before_active_document() -> None:
    from app.services.source_router import CourseFileScope, effective_document_ids

    assert effective_document_ids(
        document_ids=["doc_a", "doc_b"],
        active_document_id="doc_active",
        course_file_scope=CourseFileScope.SPECIFIC_FILES,
    ) == ["doc_a", "doc_b"]


def test_specific_files_falls_back_to_active_document_only() -> None:
    from app.services.source_router import CourseFileScope, effective_document_ids

    assert effective_document_ids(
        document_ids=None,
        active_document_id="doc_active",
        course_file_scope=CourseFileScope.SPECIFIC_FILES,
    ) == ["doc_active"]


def test_internet_mode_is_locked_to_internet_scope() -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="Explain this PDF paragraph",
        source_mode="internet",
        course_file_scope="specific_files",
        document_ids=["private_doc"],
        open_file_context="Private course excerpt that must not be searched.",
    )

    assert decision.source_scope == SourceScope.INTERNET
    assert decision.sanitized_web_query == "Explain this PDF paragraph"


def test_auto_with_selected_file_prefers_course_files() -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="What is Newton's second law?",
        source_mode="auto",
        document_ids=["doc_a"],
    )

    assert decision.source_scope == SourceScope.COURSE_FILES


def test_auto_without_file_defaults_to_course_files() -> None:
    # Auto mode now retrieves from course files FIRST and only falls back to
    # general knowledge downstream — in ask.py, when retrieval finds no strong
    # course anchor (see commit "Auto mode: retrieve from course files before
    # falling back to general knowledge"). So classify_source_scope itself
    # returns COURSE_FILES here; the general-knowledge decision is made later
    # from retrieval relevance, not at classification time.
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="What is warm audience vs hot audience?",
        source_mode="auto",
    )

    assert decision.source_scope == SourceScope.COURSE_FILES


def test_course_relevance_scores_semantic_overlap() -> None:
    from app.services.source_router import course_relevance_score

    strong = course_relevance_score(
        "Explain market segmentation",
        [_Chunk("Market segmentation divides customers into useful groups.", similarity=0.6)],
    )
    weak = course_relevance_score(
        "Explain market segmentation",
        [_Chunk("The mitochondria produces cellular energy.", similarity=0.02)],
    )

    assert strong > weak


def test_sanitize_web_query_never_appends_private_selected_text() -> None:
    from app.services.source_router import sanitize_web_query

    query = sanitize_web_query(
        "Search the internet for this selected text",
        selected_text="Confidential lecture paragraph with private details.",
    )

    assert "Confidential" not in query
    assert query == "Search the internet for this selected text"
