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

