import pytest
import asyncio

from app.services.execution_router import (
    ExecutionLane,
    fast_grounded_evidence_is_sufficient,
    resolve_execution_plan,
)
from app.services.grounding_contract import ResolvedDocumentAccess


@pytest.mark.parametrize(("question", "access", "expected"), [
    ("What is torsion?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
    ("Explain torsion simply.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
    ("What does Eigenwert mean?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
    ("What does my lecture call torsion?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GROUNDED),
    ("Where in the script is torsion explained?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
    ("Explain this formula.", ResolvedDocumentAccess.VISIBLE_PAGE, ExecutionLane.VISIBLE_PAGE),
    ("What does sigma mean?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
    ("Calculate sigma for this welded joint.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.DEEP_REASONING),
    ("Derive the displacement equation.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.DEEP_REASONING),
    ("Find current jobs near Braunschweig.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.WEB),
    ("Find every torsion question in all exams.", ResolvedDocumentAccess.FULL_DOCUMENT, ExecutionLane.FULL_DOCUMENT),
    ("Summarize the entire PDF.", ResolvedDocumentAccess.FULL_DOCUMENT, ExecutionLane.FULL_DOCUMENT),
    ("I need all the details.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
])
def test_authoritative_route_matrix(question, access, expected) -> None:
    _, plan = resolve_execution_plan(
        question=question, resolved_access=access, processing_pipeline="relevance",
    )
    assert plan.executionLane is expected


def test_followup_reuses_context_but_location_request_does_not() -> None:
    _, contextual = resolve_execution_plan(
        question="Why?", resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
    )
    _, location = resolve_execution_plan(
        question="Where exactly does the lecture say that?",
        resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
    )
    assert contextual.executionLane is ExecutionLane.FAST_CONTEXTUAL
    assert location.executionLane is ExecutionLane.STANDARD_RAG


def test_full_document_is_never_downgraded() -> None:
    _, plan = resolve_execution_plan(
        question="What is torsion?", resolved_access=ResolvedDocumentAccess.FULL_DOCUMENT,
        processing_pipeline="synthesis",
    )
    assert plan.executionLane is ExecutionLane.FULL_DOCUMENT
    assert not plan.mayEscalate


def test_fast_grounded_evidence_requires_chunks_and_minimum_relevance() -> None:
    assert fast_grounded_evidence_is_sufficient(chunk_count=2, relevance_score=0.22)
    assert not fast_grounded_evidence_is_sufficient(chunk_count=0, relevance_score=1.0)
    assert not fast_grounded_evidence_is_sufficient(chunk_count=4, relevance_score=0.219)


def test_fast_general_uses_general_processing_pipeline() -> None:
    _, plan = resolve_execution_plan(
        question="What is torsion?",
        resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="synthesis",
    )
    assert plan.executionLane is ExecutionLane.FAST_GENERAL
    assert plan.processingPipeline == "general"


def test_fast_general_bypasses_document_and_retrieval_work(monkeypatch) -> None:
    from app.routers import stream as stream_router
    from app.services import general_answer

    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(stream_router, "_load_authorized_documents",
                        lambda *_: (_ for _ in ()).throw(AssertionError("document lookup ran")))
    monkeypatch.setattr(stream_router, "retrieve_routed_chunks",
                        lambda **_: (_ for _ in ()).throw(AssertionError("retrieval ran")))
    monkeypatch.setattr(general_answer, "stream_general_answer", lambda *_args, **_kwargs: iter([
        {"t": "Torsion is twisting."}, {"done": True, "model": "fast-test"},
    ]))
    monkeypatch.setattr(stream_router, "record_usage", lambda **_: None)

    async def consume():
        response = await stream_router.ask_stream_endpoint(
            stream_router.AskStreamRequest(courseId="course", question="What is torsion?"),
            {"id": "user"}, "fast-request-1234",
        )
        return b"".join([event async for event in response.body_iterator])

    body = asyncio.run(consume())
    assert b'"executionLane": "fast_general"' in body
    assert b"Torsion is twisting." in body
    assert b'"done": true' in body


def test_large_bilingual_routing_matrix() -> None:
    topics = ["torsion", "Eigenwert", "Wälzlager", "kinetic energy", "Passung",
              "Querkraft", "moment", "Schweißbarkeit", "preload", "lambda"]
    cases: list[tuple[str, ResolvedDocumentAccess, ExecutionLane]] = []
    for topic in topics:
        cases.extend([
            (f"What is {topic}?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
            (f"Explain {topic} simply.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
            (f"Was ist {topic}?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
            (f"Erkläre {topic} kurz.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GENERAL),
            (f"What does my lecture say about {topic}?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GROUNDED),
            (f"Was sagt meine Vorlesung über {topic}?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.FAST_GROUNDED),
            (f"Where in the script is {topic}?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
            (f"Wo genau steht {topic} im Skript?", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
            (f"Calculate {topic} for the given case.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.DEEP_REASONING),
            (f"Berechne {topic} für diese Aufgabe.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.DEEP_REASONING),
            (f"Explain this {topic} formula.", ResolvedDocumentAccess.VISIBLE_PAGE, ExecutionLane.VISIBLE_PAGE),
            (f"Erkläre diese {topic} Formel.", ResolvedDocumentAccess.VISIBLE_PAGE, ExecutionLane.VISIBLE_PAGE),
            (f"Find every {topic} question.", ResolvedDocumentAccess.FULL_DOCUMENT, ExecutionLane.FULL_DOCUMENT),
            (f"Finde alle Aufgaben zu {topic}.", ResolvedDocumentAccess.FULL_DOCUMENT, ExecutionLane.FULL_DOCUMENT),
            (f"Find current {topic} jobs near Braunschweig.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.WEB),
            (f"Suche aktuelle {topic} Stellenangebote.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.WEB),
            (f"Compare {topic} with the worked example.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
            (f"Vergleiche {topic} mit dem Beispiel.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
            (f"I need all details about {topic}.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
            (f"Ich brauche alle Details über {topic}.", ResolvedDocumentAccess.RELEVANCE, ExecutionLane.STANDARD_RAG),
        ])
    assert len(cases) == 200
    for question, access, expected in cases:
        _, plan = resolve_execution_plan(
            question=question, resolved_access=access, processing_pipeline="relevance",
        )
        assert plan.executionLane is expected, question
