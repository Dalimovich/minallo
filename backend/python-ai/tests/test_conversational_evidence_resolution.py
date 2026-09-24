"""Regression tests for separating conversational meaning from evidence
requirement (dialogue_state.EvidenceRequirement / resolve_evidence_requirement).

TaskFamily says WHAT the user wants (explain, compare, study-plan, ...);
EvidenceRequirement says WHERE the answer must come from (the conversation
itself, general knowledge, the previous grounded answer, fresh course
retrieval, ...). Before this, task_family alone decided whether retrieval
ran, and a chat's course binding could turn an ordinary follow-up into
course-grounded execution — so "But I don't understand it" after a plain
general-knowledge answer could fall into the RAG pipeline and, if anything
in it failed, surface as a fake "document" error. See stream.py's
_prepare_ask_stream_response, execution_router.classify_task_profile, and
dialogue_state.resolve_evidence_requirement.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.services.dialogue_state import (
    EvidenceRequirement,
    TurnRelation,
    resolve_dialogue,
    resolve_dialogue_semantically,
    resolve_evidence_requirement,
)
from app.services.execution_router import ExecutionLane, resolve_execution_plan
from app.services.grounding_contract import ResolvedDocumentAccess


# ── Shared plumbing for the real end-to-end tests ───────────────────────────

def _stream_router_common_mocks(monkeypatch):
    from app.routers import stream as stream_router
    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(stream_router, "record_usage", lambda **_: None)
    return stream_router


def _mock_tutor_state(monkeypatch):
    from app.services import tutor_state_store
    from app.services.tutor_state import TutorState
    monkeypatch.setattr(tutor_state_store, "claim_generation", lambda *_a, **_k: True)
    monkeypatch.setattr(tutor_state_store, "current_persisted_generation", lambda *_a, **_k: 0)
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda user_id, conversation_id: TutorState(conversation_id=conversation_id, user_id=user_id),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)


def _mock_empty_retrieval_and_cache(monkeypatch):
    from app.services import cache, retrieval
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **_: [])
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)


async def _consume(stream_router, payload, request_id):
    response = await stream_router.ask_stream_endpoint(
        payload, {"id": "00000000-0000-4000-8000-000000000099"}, request_id,
    )
    return b"".join([event async for event in response.body_iterator])


_TURN1_QUESTION = "Here is a general learning plan; is this actually a good plan?"
_TURN1_ANSWER = (
    "This is a solid general approach: define your goals, assess your current "
    "knowledge, gather resources, build a schedule, use active recall, and "
    "review regularly."
)


def _general_previous_turns() -> list[dict]:
    """A previous exchange whose answer was plain general knowledge, carrying
    the routing provenance a real assistant turn would (see PreviousTurn)."""
    return [
        {"role": "user", "text": _TURN1_QUESTION},
        {
            "role": "assistant", "text": _TURN1_ANSWER,
            "answerMode": "general", "groundingMode": "general",
            "sourceScope": "general_knowledge",
        },
    ]


# ── Real end-to-end regression: the reported bug ────────────────────────────

@pytest.mark.parametrize("course_id", ["", "auto-bound-course-1"], ids=["no_course", "course_bound_auto"])
def test_general_followup_stays_conversational(monkeypatch, course_id) -> None:
    """TURN 1: general answer. TURN 2: "But I don't understand it". Expected:
    FAST_CONTEXTUAL, no retrieval, a substantive answer, never internal_error
    — with AND without a course bound to the chat, since an available course
    must not turn a follow-up to a GENERAL answer into grounded execution."""
    stream_router = _stream_router_common_mocks(monkeypatch)
    from app.services import general_answer

    captured: dict[str, object] = {}

    def fake_general(question, **kwargs):
        captured["question"] = question
        captured["previous_turns"] = kwargs.get("previous_turns")
        yield {"t": "Sure. In simple terms: work out what you need to learn, "
                     "check what you already know, split the rest across your "
                     "available time, practise actively, and check yourself "
                     "regularly. You don't need to follow every step rigidly."}
        yield {"done": True, "model": "test"}

    monkeypatch.setattr(general_answer, "stream_general_answer", fake_general)
    monkeypatch.setattr(
        stream_router, "_load_authorized_documents",
        lambda *_: (_ for _ in ()).throw(AssertionError("document lookup ran")),
    )

    body = asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId=course_id,
        question="But I don't understand it",
        previousTurns=_general_previous_turns(),
    ), request_id=f"general-followup-{course_id or 'none'}"))

    assert b"internal_error" not in body
    assert b"grounded" not in body
    assert b'"executionLane": "fast_contextual"' in body
    assert captured.get("question")
    assert b"Sure. In simple terms" in body


# ── Paraphrase generalization: unseen wording must resolve the same way ────
# resolve_dialogue's lexical layer only recognizes a fixed few "I don't
# understand" constructions — the point of the semantic resolver is that it
# generalizes to wording no regex ever saw. This exercises the REAL model
# (skipped without network/API access) rather than adding these phrases to
# any pattern in source.

pytestmark_needs_llm = pytest.mark.skipif(
    True, reason="enable manually against a live OPENAI_API_KEY to verify semantic generalization",
)


@pytestmark_needs_llm
@pytest.mark.parametrize("phrase", [
    "that still isn't clicking for me",
    "you lost me there",
    "can you put that differently?",
    "that went over my head",
    "okay but what does that actually mean?",
    "I don't really get what you mean there",
])
def test_paraphrase_generalization_resolves_conversation_only(phrase) -> None:
    base = resolve_dialogue(phrase, previous_turns=_general_previous_turns())
    resolved = resolve_dialogue_semantically(
        phrase, previous_turns=_general_previous_turns(), base=base,
    )
    assert resolved.evidence_requirement in {
        EvidenceRequirement.CONVERSATION_ONLY, EvidenceRequirement.REUSE_PRIOR_GROUNDED,
    }, phrase
    assert not resolved.requires_new_retrieval, phrase


# ── Prior grounded answer: reuse vs. fresh retrieval driven by THIS turn ───

def test_prior_grounded_reuse_vs_explicit_location_request() -> None:
    """A simple clarification after a GROUNDED answer reuses it (no fresh
    retrieval needed); an explicit location/verification request in the same
    position always demands fresh evidence — proving evidence requirement is
    driven by what the CURRENT turn actually asks, not just by continuity."""
    grounded_turns = [
        {"role": "user", "text": "What does my professor say Hooke's law is?"},
        {
            "role": "assistant", "text": "Your lecture defines Hooke's law as F = -kx.",
            "answerMode": "course", "groundingMode": "relevance", "sourceScope": "course_files",
        },
    ]
    reuse_resolution = resolve_evidence_requirement(
        "that went over my head", relation=TurnRelation.CLARIFICATION,
        continues_previous_goal=True, previous_turns=grounded_turns,
    )
    assert reuse_resolution is EvidenceRequirement.REUSE_PRIOR_GROUNDED

    location_resolution = resolve_evidence_requirement(
        "show me the exact page where it says that", relation=TurnRelation.CLARIFICATION,
        continues_previous_goal=True, previous_turns=grounded_turns,
    )
    assert location_resolution is EvidenceRequirement.COURSE_RETRIEVAL


_GROUNDED_PREVIOUS_TURNS = [
    {"role": "user", "text": "What does my professor say Hooke's law is?"},
    {
        "role": "assistant", "text": "Your lecture defines Hooke's law as F = -kx.",
        "answerMode": "course", "groundingMode": "relevance", "sourceScope": "course_files",
    },
]


def test_reuse_prior_grounded_routes_fast_contextual_no_fresh_retrieval(monkeypatch) -> None:
    """REUSE_PRIOR_GROUNDED must reach FAST_CONTEXTUAL (paraphrase from
    conversation history) end-to-end through the real orchestration, not
    just from resolve_evidence_requirement in isolation — this is exactly
    the gap the unit test above could not catch: execution_router used to
    route REUSE_PRIOR_GROUNDED to FAST_GROUNDED, which then saw zero chunks
    (requires_new_retrieval=False), failed the evidence-sufficiency check,
    and escalated to STANDARD_RAG — running the fresh retrieval this
    evidence requirement exists specifically to avoid."""
    stream_router = _stream_router_common_mocks(monkeypatch)
    from app.services import general_answer

    captured: dict[str, object] = {}

    def fake_general(question, **kwargs):
        captured["question"] = question
        captured["previous_turns"] = kwargs.get("previous_turns")
        yield {"t": "In simple terms: F = -kx means the restoring force is "
                     "proportional to displacement, in the opposite direction."}
        yield {"done": True, "model": "test"}

    monkeypatch.setattr(general_answer, "stream_general_answer", fake_general)
    monkeypatch.setattr(
        stream_router, "_load_authorized_documents",
        lambda *_: (_ for _ in ()).throw(AssertionError("document lookup ran")),
    )
    from app.services import retrieval
    monkeypatch.setattr(
        retrieval, "retrieve_chunks",
        lambda **_: (_ for _ in ()).throw(AssertionError("fresh retrieval ran for a reuse turn")),
    )

    body = asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId="course-1",
        question="that went over my head",
        previousTurns=_GROUNDED_PREVIOUS_TURNS,
    ), request_id="reuse-prior-grounded-1"))

    assert b"internal_error" not in body
    assert b'"executionLane": "fast_contextual"' in body
    assert captured.get("question")
    prior_texts = [t.get("text", "") for t in (captured.get("previous_turns") or [])]
    assert any("F = -kx" in t for t in prior_texts)
    assert b"In simple terms" in body


def test_explicit_location_after_grounded_answer_runs_fresh_course_retrieval(monkeypatch) -> None:
    """The same grounded exchange, but the follow-up explicitly asks for a
    citation — this must run fresh course retrieval, proving evidence
    requirement is driven by what THIS turn asks, not just continuity."""
    stream_router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    from app.services import cache, retrieval

    retrieval_called = {"value": False}

    def spy_retrieve_chunks(**_kwargs):
        retrieval_called["value"] = True
        return []

    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", spy_retrieve_chunks)
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)

    asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId="course-1",
        question="show me the exact page where it says that",
        previousTurns=_GROUNDED_PREVIOUS_TURNS,
    ), request_id="explicit-location-after-grounded-1"))

    assert retrieval_called["value"], "explicit location request must run fresh course retrieval"


# ── Evidence SOURCE vs FRESHNESS: generic verification/correction inherits
# ── the previous answer's source, it does not name one of its own ─────────

def test_verification_after_general_answer_stays_general_no_course() -> None:
    """'Are you sure?' after a plain general-knowledge answer must re-check
    general knowledge, never search course material that was never involved."""
    general_turns = [
        {"role": "user", "text": "What's the capital of Australia?"},
        {
            "role": "assistant", "text": "Canberra.",
            "answerMode": "general", "groundingMode": "general", "sourceScope": "general_knowledge",
        },
    ]
    resolved = resolve_dialogue("Are you sure?", previous_turns=general_turns)
    assert resolved.evidence_requirement is EvidenceRequirement.GENERAL_KNOWLEDGE
    assert not resolved.requires_new_retrieval


def test_verification_after_grounded_answer_runs_fresh_course_check() -> None:
    """The same wording after a COURSE-grounded answer must re-verify
    against the course, not silently reuse the previous chunks."""
    resolved = resolve_dialogue("Are you sure?", previous_turns=_GROUNDED_PREVIOUS_TURNS)
    assert resolved.evidence_requirement is EvidenceRequirement.COURSE_RETRIEVAL
    assert resolved.requires_new_retrieval


def test_explicit_course_wording_overrides_general_provenance_on_verification() -> None:
    """Even after a general answer, naming the course explicitly in the
    verification itself must still search the course — explicit current-
    message wording always outranks inherited provenance."""
    general_turns = [
        {"role": "user", "text": "What's a reasonable study schedule?"},
        {
            "role": "assistant", "text": "Something like two hours a day, spread across the week.",
            "answerMode": "general", "groundingMode": "general", "sourceScope": "general_knowledge",
        },
    ]
    resolved = resolve_evidence_requirement(
        "verify it against my lecture", relation=TurnRelation.CLARIFICATION,
        continues_previous_goal=True, previous_turns=general_turns,
    )
    assert resolved is EvidenceRequirement.COURSE_RETRIEVAL


def test_verification_after_web_answer_stays_web() -> None:
    """'Are you sure this is still current?' after a web-sourced answer
    should re-check the web, not the course."""
    web_turns = [
        {"role": "user", "text": "Who is the current chancellor of Germany?"},
        {
            "role": "assistant", "text": "As of the latest search results, ...",
            "answerMode": "internet", "groundingMode": "web", "sourceScope": "internet",
        },
    ]
    resolved = resolve_evidence_requirement(
        "are you sure this is still current?", relation=TurnRelation.CLARIFICATION,
        continues_previous_goal=True, previous_turns=web_turns,
    )
    assert resolved is EvidenceRequirement.WEB


def test_correction_after_general_recommendation_stays_general() -> None:
    """A rejection ("no, I don't think so") after a general recommendation
    must reconsider the general answer, not jump to course retrieval —
    correction/rejection relations demand freshness, not a source."""
    general_turns = [
        {"role": "user", "text": "Which elective should I pick?"},
        {
            "role": "assistant", "text": "I think option B would suit you better.",
            "answerMode": "general", "groundingMode": "general", "sourceScope": "general_knowledge",
        },
    ]
    resolved = resolve_evidence_requirement(
        "No, I don't think that's right.", relation=TurnRelation.REJECTION,
        continues_previous_goal=True, previous_turns=general_turns,
    )
    assert resolved is EvidenceRequirement.GENERAL_KNOWLEDGE


# ── New topic: an available course must not be searched for an unrelated
# ── question just because the chat happens to be bound to it ───────────────

def test_new_topic_in_course_chat_does_not_force_course_evidence() -> None:
    grounded_turns = [
        {"role": "user", "text": "Explain torsion from my lecture."},
        {
            "role": "assistant", "text": "The course formula is tau = Tr/J.",
            "answerMode": "course", "groundingMode": "relevance", "sourceScope": "course_files",
        },
    ]
    resolved = resolve_dialogue("What's the capital of Italy?", previous_turns=grounded_turns)
    assert resolved.relation is TurnRelation.NEW_TOPIC
    assert resolved.continues_previous_goal is False
    _, plan = resolve_execution_plan(
        question=resolved.resolved_request, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
        resolved_turn=resolved, has_course_context=True,
    )
    # A one-off factual question stays in the cheap general lane — it must
    # not be pulled toward course grounding merely because a course/PDF is
    # open behind the chat.
    assert plan.executionLane is not ExecutionLane.FAST_GROUNDED
    assert plan.executionLane is not ExecutionLane.STANDARD_RAG


# ── Medium-complexity new topics: evidence resolution is NOT yet
# ── authoritative for these (KNOWN GAP, see resolve_evidence_requirement's
# ── new-topic branch) — classify_task_profile's own `course` signal stays
# ── False, but the preliminary lane still ends up STANDARD_RAG rather than
# ── FAST_GENERAL. These tests prove the two things that keep that a
# ── latency/purity issue rather than a correctness one: the post-retrieval
# ── downgrade still answers correctly, and a failure in that path still
# ── recovers as a plain conversational answer instead of a misleading
# ── "grounded" failure. Root-causing the lane choice itself is left open
# ── (a real pipeline-ordering change, not a phrase list).

_MEDIUM_COMPLEXITY_GENERAL_QUESTIONS = [
    "Can you help me decide whether studying in the morning or evening would suit me better?",
    "What do you think is the best way to stay motivated?",
    # NOT included: "Explain the difference between discipline and
    # motivation." — it matches _DEFINITION_RE ("explain ...") AND
    # _COMPARE_RE ("difference between"), so it's already correctly
    # classified "low" complexity and reaches FAST_GENERAL. That's a real,
    # separate example of the router working — it just isn't this gap.
]


@pytest.mark.parametrize("question", _MEDIUM_COMPLEXITY_GENERAL_QUESTIONS)
def test_medium_complexity_general_question_preliminary_lane_is_standard_rag(question) -> None:
    """Documents the known gap precisely, so a future fix has a failing test
    to turn green instead of a comment to trust: classify_task_profile
    already gets `course` right (False — no course wording, no course-bound
    provenance to inherit), but the preliminary lane is still the heavy one."""
    resolved = resolve_dialogue(question, previous_turns=[])
    assert resolved.relation is TurnRelation.NEW_TOPIC
    _, plan = resolve_execution_plan(
        question=question, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=False,
        resolved_turn=resolved, has_course_context=True,
    )
    assert plan.executionLane is ExecutionLane.STANDARD_RAG, (
        f"{question!r} — if this now fails, evidence resolution has become "
        "authoritative for new topics too; delete this test and the KNOWN "
        "GAP comments in dialogue_state.resolve_evidence_requirement and "
        "execution_router's conservative_standard_fallback branch."
    )


def test_medium_complexity_general_question_in_course_chat_still_answers_correctly(monkeypatch) -> None:
    """Even on the heavy STANDARD_RAG lane, an empty course search must
    still downgrade to a normal general-knowledge answer — proving the
    known gap above doesn't produce a WRONG answer, only a wasted retrieval
    attempt."""
    stream_router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    _mock_empty_retrieval_and_cache(monkeypatch)

    def fake_stream_answer(**_kwargs):
        meta = {"meta": True, "retrievalMode": "general_knowledge", "answerMode": "general"}
        done = {
            "done": True, "retrievalMode": "general_knowledge", "answerMode": "general",
            "verification": {"status": "verified", "details": {}}, "sources": [],
        }
        yield f"data: {json.dumps(meta)}\n\n".encode()
        yield b'data: {"t":"Morning study sessions often work well if you are more alert early."}\n\n'
        yield f"data: {json.dumps(done)}\n\n".encode()

    monkeypatch.setattr(stream_router, "stream_answer", fake_stream_answer)
    # An empty, self-contained course-scoped search can also resolve via an
    # earlier "nothing to ground this in" bail-out that calls
    # generate_general_answer directly rather than reaching stream_answer —
    # mock both so the test exercises whichever branch this request shape
    # actually takes rather than assuming one.
    monkeypatch.setattr(
        stream_router, "generate_general_answer",
        lambda *_a, **_k: {
            "answer": "Morning study sessions often work well if you are more alert early.",
            "model": "test",
        },
    )

    body = asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId="course-1",
        question=_MEDIUM_COMPLEXITY_GENERAL_QUESTIONS[0],
    ), request_id="medium-complexity-general-1"))

    assert b"internal_error" not in body
    assert b"Morning study sessions" in body


def test_medium_complexity_general_question_failure_recovers_gracefully(monkeypatch) -> None:
    """If something fails on that heavy lane before any token streams, the
    bounded auto-retry (stream.py's deferred-pipeline except handler) must
    still produce a plain conversational answer instead of a misleading
    "grounded_generation_failed" error — this is the specific risk the gap
    above creates, and it is what actually keeps students from seeing it."""
    stream_router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    from app.services import cache, retrieval
    from app.services import general_answer

    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])

    def failing_retrieve_chunks(**_kwargs):
        raise RuntimeError("retrieval backend unavailable")

    monkeypatch.setattr(retrieval, "retrieve_chunks", failing_retrieve_chunks)
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)

    def fake_general(question, **kwargs):
        yield {"t": "Morning study sessions often work well if you are more alert early."}
        yield {"done": True, "model": "test"}

    monkeypatch.setattr(general_answer, "stream_general_answer", fake_general)

    body = asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId="course-1",
        question=_MEDIUM_COMPLEXITY_GENERAL_QUESTIONS[0],
    ), request_id="medium-complexity-general-failure-1"))

    text = body.decode("utf-8", "replace")
    assert '"code": "grounded_generation_failed"' not in text
    assert '"code": "internal_error"' not in text
    assert "Morning study sessions" in text
    assert '"recoveredFromRoutingFailure": true' in text


# ── Semantic service failure: must fall back to conversation, not RAG ──────

def test_semantic_resolver_exception_falls_back_to_conversational_not_rag(monkeypatch) -> None:
    """When the underlying classification call itself fails, the except
    branch of resolve_dialogue_semantically must not erase conversational
    continuity — a short referential follow-up stays conversation-only
    evidence rather than defaulting toward RAG just because the classifier
    couldn't run."""
    import app.services.openai_client as openai_client

    class _FailingCompletions:
        @staticmethod
        def create(*_a, **_k):
            raise RuntimeError("openai unavailable")

    class _FailingChat:
        completions = _FailingCompletions()

    class _FailingClient:
        chat = _FailingChat()

    monkeypatch.setattr(openai_client, "get_openai_client", lambda: _FailingClient())

    base = resolve_dialogue("But I don't understand it", previous_turns=_general_previous_turns())
    resolved = resolve_dialogue_semantically(
        "But I don't understand it", previous_turns=_general_previous_turns(), base=base,
    )
    assert resolved.relation in {TurnRelation.CONTINUATION, TurnRelation.ANSWER_TO_ASSISTANT}
    assert resolved.evidence_requirement is EvidenceRequirement.CONVERSATION_ONLY
    assert not resolved.requires_new_retrieval

    _, plan = resolve_execution_plan(
        question=resolved.resolved_request, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        processing_pipeline="relevance", has_previous_answer=True,
        resolved_turn=resolved, has_course_context=True,
    )
    assert plan.executionLane is not ExecutionLane.STANDARD_RAG


# ── Explicit grounding request: a real retrieval failure must stay typed as
# ── a document/retrieval failure, never silently answered from general
# ── knowledge — the bounded auto-retry must not apply here ─────────────────

def test_explicit_grounded_request_failure_stays_typed_not_silently_general(monkeypatch) -> None:
    stream_router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    from app.services import cache, retrieval

    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])

    def failing_retrieve_chunks(**_kwargs):
        raise RuntimeError("retrieval backend unavailable")

    monkeypatch.setattr(retrieval, "retrieve_chunks", failing_retrieve_chunks)
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)
    monkeypatch.setattr(
        stream_router, "generate_general_answer",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("explicit grounded request silently fell back to general knowledge")
        ),
    )

    body = asyncio.run(_consume(stream_router, stream_router.AskStreamRequest(
        courseId="course-1",
        documentIds=["11111111-1111-4111-8111-111111111111"],
        question="According to my PDF, where exactly is this formula?",
    ), request_id="explicit-grounded-failure-1"))

    assert b'"answerMode": "general"' not in body
    text = body.decode("utf-8", "replace")
    assert '"error": true' in text
    # Whatever the exact stage that tripped (retrieval itself, or an
    # upstream evidence check demanding a captured page) the failure must
    # stay a typed document/retrieval-class error — never silently answered
    # from general knowledge, and never generic "internal_error" noise for
    # a request that explicitly named its evidence source.
    assert '"code": "general_generation_failed"' not in text
    assert '"code": "contextual_generation_failed"' not in text
