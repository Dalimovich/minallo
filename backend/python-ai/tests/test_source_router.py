"""Source routing policy checks."""

from __future__ import annotations

from dataclasses import dataclass

import pytest


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


@pytest.mark.parametrize(
    "question",
    [
        "haha",
        "hhh",
        "thanks",
        "never mind",
        "nothing that concerns you",
        "I was joking",
    ],
)
def test_auto_active_pdf_does_not_hijack_conversational_turns(question: str) -> None:
    from app.services.source_router import GroundingPolicy, SourceScope, classify_source_scope

    decision = classify_source_scope(
        question=question,
        source_mode="auto",
        selected_course_id="course",
        active_document_id="document",
        open_file_context="Visible academic material from page 4.",
        inside_pdf_side_rail=True,
    )

    assert decision.source_scope == SourceScope.GENERAL_KNOWLEDGE
    assert decision.grounding_policy == GroundingPolicy.GENERAL
    assert decision.used_document_ids == []
    assert decision.source_label == "Using: General knowledge"


@pytest.mark.parametrize(
    "question",
    [
        "solve this",
        "explain this",
        "what is that symbol?",
        "why is this 0.9?",
        "what does this formula mean?",
        "is that equation correct?",
    ],
)
def test_auto_active_pdf_preserves_academic_deictic_requests(question: str) -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question=question,
        source_mode="auto",
        selected_course_id="course",
        active_document_id="document",
        open_file_context="Visible academic material from page 4.",
        inside_pdf_side_rail=True,
    )

    assert decision.source_scope == SourceScope.COURSE_FILES


def test_explicit_course_mode_still_honours_user_source_choice_for_short_turn() -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="thanks",
        source_mode="course_files",
        active_document_id="document",
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


def test_url_with_course_signal_keeps_course_signal_in_metadata() -> None:
    """A pasted link still wins the primary scope in Auto mode (see the
    _URL_RE comment), but a compound message that ALSO carries a strong
    course signal ("page 4", "this PDF") must not silently vanish from the
    decision — downstream code needs to know the course half was dropped so
    it can still surface it (e.g. answer both parts, or disclose the gap)."""
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question=(
            "check this https://youtu.be/xyz video and also explain the "
            "formula on page 4 of the PDF"
        ),
        source_mode="auto",
    )

    assert decision.source_scope == SourceScope.INTERNET
    assert decision.course_signal_detected is True
    assert decision.metadata()["courseSignalDetected"] is True


def test_url_without_course_signal_reports_no_course_signal() -> None:
    from app.services.source_router import SourceScope, classify_source_scope

    decision = classify_source_scope(
        question="https://youtu.be/xyz what's it about",
        source_mode="auto",
    )

    assert decision.source_scope == SourceScope.INTERNET
    assert decision.course_signal_detected is False


def test_sanitize_web_query_never_appends_private_selected_text() -> None:
    from app.services.source_router import sanitize_web_query

    query = sanitize_web_query(
        "Search the internet for this selected text",
        selected_text="Confidential lecture paragraph with private details.",
    )

    assert "Confidential" not in query
    assert query == "Search the internet for this selected text"
