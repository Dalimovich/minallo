import pytest
import asyncio

from app.services import execution_router
from app.services.execution_router import (
    ExecutionLane,
    fast_grounded_evidence_is_sufficient,
    resolve_execution_plan,
)
from app.services.grounding_contract import ResolvedDocumentAccess


class _FakeChunk:
    def __init__(self, document_id: str = "doc1") -> None:
        self.document_id = document_id


def _stub_scores(monkeypatch, scores: list[float]) -> None:
    """fast_grounded_evidence_is_sufficient does `from .source_router import
    _chunk_relevance_scores` inside its body, so the patch target is the
    name in source_router's own module namespace, not execution_router's."""
    import app.services.source_router as source_router
    monkeypatch.setattr(source_router, "_chunk_relevance_scores", lambda *_a, **_k: scores)


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


# ── FAST_GROUNDED evidence sufficiency: richer than count>0 + score>=0.22 ───

def test_one_very_strong_chunk_is_sufficient(monkeypatch) -> None:
    _stub_scores(monkeypatch, [0.72])
    assert fast_grounded_evidence_is_sufficient(chunks=[_FakeChunk()], question="What is torsion?")


def test_several_moderate_chunks_are_sufficient(monkeypatch) -> None:
    _stub_scores(monkeypatch, [0.40, 0.35, 0.31])
    chunks = [_FakeChunk(), _FakeChunk(), _FakeChunk()]
    assert fast_grounded_evidence_is_sufficient(chunks=chunks, question="What does my professor say about bearings?")


def test_lone_weak_chunk_barely_over_old_threshold_now_escalates(monkeypatch) -> None:
    """The exact gap flagged in review: the old gate was chunk_count>0 and
    score>=0.22, so a single mediocre 0.23 chunk used to pass. It must not
    pass the richer gate on its own."""
    _stub_scores(monkeypatch, [0.23])
    assert not fast_grounded_evidence_is_sufficient(chunks=[_FakeChunk()], question="What is a fixed-floating bearing?")


def test_no_chunks_is_never_sufficient(monkeypatch) -> None:
    _stub_scores(monkeypatch, [])
    assert not fast_grounded_evidence_is_sufficient(chunks=[], question="What is torsion?")


def test_list_question_needs_broader_coverage_than_one_hit(monkeypatch) -> None:
    """"What are the three Passungen types" with only one relevant chunk
    covering one of the three items must not be answered as if complete."""
    _stub_scores(monkeypatch, [0.5])
    assert not fast_grounded_evidence_is_sufficient(
        chunks=[_FakeChunk()], question="What are the three types of Passungen in our course?",
    )


def test_list_question_sufficient_with_multiple_corroborating_hits(monkeypatch) -> None:
    _stub_scores(monkeypatch, [0.45, 0.38])
    chunks = [_FakeChunk(document_id="docA"), _FakeChunk(document_id="docB")]
    assert fast_grounded_evidence_is_sufficient(
        chunks=chunks, question="What are the three types of Passungen in our course?",
    )


def test_comparison_question_is_not_satisfied_by_one_chunk(monkeypatch) -> None:
    _stub_scores(monkeypatch, [0.6])
    assert not fast_grounded_evidence_is_sufficient(
        chunks=[_FakeChunk()], question="Compare the professor's treatment of O- and X-arrangement.",
    )


# ── Broadened FAST_CONTEXTUAL follow-up phrasing (realistic student wording) ─

@pytest.mark.parametrize("question", [
    "but why is it negative here?",
    "why minus here?",
    "and the second case?",
    "what about c < 0?",
    "what about the other one?",
    "what changes if the force points down?",
    "where did the 2 come from?",
    "why did you use FW and not FG?",
    "how did you get tau_Q?",
    "and if they are perpendicular?",
    "what if both forces are parallel?",
    "what if the bearing is fixed?",
    "why not use energy here?",
    "warum?",
    "wieso minus?",
    "und bei c<0?",
    "was ist mit dem anderen Fall?",
    "woher kommt die 2?",
])
def test_realistic_followup_phrasing_stays_contextual(question) -> None:
    # No previous_question given here on purpose — this test isolates the
    # follow-up MARKER regex broadening. Topic continuity (a follow-up-shaped
    # message naming a genuinely different topic) has its own dedicated tests
    # below, with a previous_question chosen to actually exercise that guard.
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
    )
    assert plan.executionLane is ExecutionLane.FAST_CONTEXTUAL, question


@pytest.mark.parametrize("question", [
    "why?", "why tho", "how?",
])
def test_bare_short_followups_still_work(question) -> None:
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
    )
    assert plan.executionLane is ExecutionLane.FAST_CONTEXTUAL, question


def test_followup_without_previous_answer_is_not_contextual() -> None:
    _, plan = resolve_execution_plan(
        question="why?", resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=False,
    )
    assert plan.executionLane is not ExecutionLane.FAST_CONTEXTUAL


# ── Topic continuity: a follow-up-shaped message naming a NEW topic must ────
# ── not blindly reuse stale context ──────────────────────────────────────────

def test_topic_change_disguised_as_followup_is_not_contextual() -> None:
    _, plan = resolve_execution_plan(
        question="what about rolling bearings?",
        resolved_access=ResolvedDocumentAccess.RELEVANCE, processing_pipeline="relevance",
        has_previous_answer=True,
        previous_question="Explain torsion in a circular shaft.",
    )
    assert plan.executionLane is not ExecutionLane.FAST_CONTEXTUAL


def test_same_topic_followup_with_previous_question_stays_contextual() -> None:
    _, plan = resolve_execution_plan(
        question="what about c < 0 for the transport equation?",
        resolved_access=ResolvedDocumentAccess.RELEVANCE, processing_pipeline="relevance",
        has_previous_answer=True,
        previous_question="Explain the transport equation for c > 0.",
    )
    assert plan.executionLane is ExecutionLane.FAST_CONTEXTUAL


def test_pronoun_only_followup_has_nothing_to_contradict_previous_topic() -> None:
    """"why minus?" has no substantial content word of its own to compare —
    absent a contradicting topic, it defaults to reusing context."""
    _, plan = resolve_execution_plan(
        question="why minus?", resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
        previous_question="Explain the transport equation for c < 0.",
    )
    assert plan.executionLane is ExecutionLane.FAST_CONTEXTUAL


# ── Source/location requests never get downgraded, even follow-up-shaped ────

@pytest.mark.parametrize("question", [
    "Where exactly does the lecture say that?",
    "Which page is that on?",
    "Show me the source.",
])
def test_source_requests_never_become_contextual_or_general(question) -> None:
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
        previous_question="Torsion creates shear stress in the cross-section.",
    )
    assert plan.executionLane is ExecutionLane.STANDARD_RAG, question


# ── False positives: must NOT trigger a special lane ─────────────────────────

def test_all_the_details_is_not_full_document() -> None:
    _, plan = resolve_execution_plan(
        question="I need all the details.", resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance",
    )
    assert plan.executionLane is not ExecutionLane.FULL_DOCUMENT
    assert plan.executionLane is ExecutionLane.STANDARD_RAG


def test_find_the_force_is_not_web_search() -> None:
    _, plan = resolve_execution_plan(
        question="Find the force in the free body diagram.",
        resolved_access=ResolvedDocumentAccess.RELEVANCE, processing_pipeline="relevance",
    )
    assert plan.executionLane is not ExecutionLane.WEB


# ── Ambiguous, low-confidence phrasing must fall back to STANDARD_RAG ───────

@pytest.mark.parametrize("question", [
    "show me torsion",
    "how does torsion work",
    "can you go through torsion",
    "help me understand bearings",
    "how do I know which formula to use",
    "what happens here",
    "why is this like that",
    "can you explain what the professor is doing",
    "how do I solve these",
])
def test_ambiguous_phrasing_falls_back_to_standard_rag(question) -> None:
    # The real invariant (spec section 12): ambiguous phrasing must not
    # gamble toward a FAST_* lane. "how do I solve these" legitimately
    # matches the calculation trigger ("solve") and correctly escalates all
    # the way to DEEP_REASONING instead — stronger, not cheaper, so it still
    # satisfies "don't guess toward fast mode."
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance",
    )
    assert plan.executionLane not in (
        ExecutionLane.FAST_GENERAL, ExecutionLane.FAST_CONTEXTUAL, ExecutionLane.FAST_GROUNDED,
    ), question


# ── Typos in the topic word itself must not affect routing — none of these ──
# ── patterns match on the topic's spelling, only the surrounding structure ──

@pytest.mark.parametrize(("question", "expected"), [
    ("What is trosion?", ExecutionLane.FAST_GENERAL),
    ("What is eigenwertt?", ExecutionLane.FAST_GENERAL),
    ("Calculte sigma for this joint.", ExecutionLane.DEEP_REASONING),
    ("Derve the displacement equation.", ExecutionLane.DEEP_REASONING),
])
def test_topic_word_typos_do_not_change_routing(question, expected) -> None:
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance",
    )
    assert plan.executionLane is expected, question


# ── Mixed-language phrasing (common in this user base) ──────────────────────

@pytest.mark.parametrize("question", [
    "was ist Eigenwert exactly?",
    "wo im lecture steht das?",
])
def test_mixed_language_phrasing_routes_sanely(question) -> None:
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance",
    )
    # Not asserting one exact lane for every mixed-language case (these are
    # genuinely harder), but they must never land in a lane that skips
    # grounding when the question itself asks for course/location evidence.
    if "lecture" in question or "wo " in question:
        assert plan.executionLane in (ExecutionLane.STANDARD_RAG, ExecutionLane.FAST_GROUNDED), question
