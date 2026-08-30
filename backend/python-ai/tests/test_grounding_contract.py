from app.services.document_extraction import classify_document_extraction
from app.services.grounding_contract import (
    AccessResolutionReason,
    GroundingRequest,
    GroundingResolution,
    RequestedDocumentAccess,
    ResolvedDocumentAccess,
    ViewerContext,
    grounding_cache_payload,
    resolve_document_access,
    select_processing_pipeline,
)


def test_viewer_context_does_not_mutate_course_scope() -> None:
    request = GroundingRequest.model_validate({
        "retrievalScope": {"type": "course"},
        "viewerContext": {"documentId": "C", "revision": "r3", "visiblePage": 12},
    })
    assert request.retrievalScope.type == "course"
    assert request.retrievalScope.documentIds == []
    assert request.viewerContext.documentId == "C"


def test_full_document_access_is_backend_owned_and_pipeline_specific() -> None:
    access, reason = resolve_document_access(
        question="Summarize the whole lecture document.", requested=None,
        viewer_context=ViewerContext(documentId="A", revision="r1", visiblePage=4),
    )
    assert access is ResolvedDocumentAccess.FULL_DOCUMENT
    assert reason is AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT
    assert select_processing_pipeline("Summarize the whole lecture document.", access) == "summarization"


def test_browser_cannot_request_relevance() -> None:
    try:
        GroundingRequest.model_validate({
            "retrievalScope": {"type": "course"},
            "documentAccess": {"requested": "relevance"},
        })
    except ValueError:
        pass
    else:
        raise AssertionError("relevance must not be an accepted browser hint")


def test_resolution_reason_does_not_change_cache_identity() -> None:
    request = GroundingRequest.model_validate({
        "retrievalScope": {"type": "documents", "documentIds": ["B", "A"]},
        "documentAccess": {"requested": RequestedDocumentAccess.FULL_DOCUMENT},
    })
    common = dict(
        documentIds=["A", "B"], documentRevisions={"A": "r17", "B": "r5"},
        documentAccess=ResolvedDocumentAccess.FULL_DOCUMENT,
        processingPipeline="summarization",
    )
    one = GroundingResolution(
        **common, resolutionReason=AccessResolutionReason.EXPLICIT_UI_HINT,
    )
    two = GroundingResolution(
        **common, resolutionReason=AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT,
    )
    kwargs = dict(user_id="u", course_id="c", request=request, question="Summarize all", conversation_grounding_state="s")
    assert grounding_cache_payload(resolution=one, **kwargs) == grounding_cache_payload(resolution=two, **kwargs)


# ── canonical resolution agrees with the legacy per-conversation classifier ─
#
# resolve_document_access()/select_processing_pipeline() (this module) and
# classify_document_extraction() (document_extraction.py) run independently
# — different functions, different files — but now share the same
# exhaustive-quantifier and extraction-target vocabulary (scoped_
# extraction.py's EXHAUSTIVE_COVERAGE_RE / EXTRACTION_TARGET_RE). Both must
# agree that these are exhaustive-extraction requests, in both English and
# German, including the phrasings that used to only match one module's
# regex and not the other's.
_EXTRACTION_SHAPED_REQUESTS = [
    "Please don't leave any exercises out",
    "List the remaining questions",
    "Give me the whole set of Kurzfragen",
    "I need every exercise, please don't leave one out",
    "Alle restlichen Aufgaben vollständig erfassen.",
    "Die gesamten Kurzfragen auflisten.",
    "Find every question in this document",
]


def test_extraction_shaped_requests_resolve_to_full_document_extraction() -> None:
    for question in _EXTRACTION_SHAPED_REQUESTS:
        access, _reason = resolve_document_access(question=question, requested=None, viewer_context=None)
        pipeline = select_processing_pipeline(question, access)
        document_extraction, _correction, _target = classify_document_extraction(question)
        assert access is ResolvedDocumentAccess.FULL_DOCUMENT, question
        assert pipeline == "extraction", question
        assert document_extraction is True, question


def test_summarize_whole_document_resolves_to_full_document_summarization() -> None:
    """A real map-reduce summarization pipeline exists (full_document_
    processing.py) — this is not a placeholder, so unlike the extraction
    cases above it correctly does NOT also match classify_document_
    extraction() (that classifier only finds/lists items; summarizing
    isn't its job)."""
    question = "Summarize the entire PDF"
    access, _reason = resolve_document_access(question=question, requested=None, viewer_context=None)
    pipeline = select_processing_pipeline(question, access)
    document_extraction, _correction, _target = classify_document_extraction(question)
    assert access is ResolvedDocumentAccess.FULL_DOCUMENT
    assert pipeline == "summarization"
    assert document_extraction is False


def test_full_document_regex_does_not_false_positive_on_bare_all() -> None:
    """"all" alone, with no document/item noun nearby, must not trigger
    full-document processing — that's the whole reason _FULL_DOCUMENT_RE
    keeps its own noun-adjacency requirement instead of just reusing
    EXHAUSTIVE_COVERAGE_RE wholesale."""
    access, reason = resolve_document_access(
        question="I need all the details on this topic", requested=None, viewer_context=None,
    )
    assert access is ResolvedDocumentAccess.RELEVANCE
    assert reason is AccessResolutionReason.RELEVANCE_DEFAULT

