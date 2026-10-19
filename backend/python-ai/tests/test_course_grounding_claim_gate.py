"""Regression tests for the course-grounding anchor gate (has_strong_course_anchor)
in /ask-stream and /ask.

Prior behavior: Course Files mode or an explicit document selection treated
ANY non-empty retrieved-chunk list as sufficient grounding, with no check on
relevance or evidence coverage. Because a course-wide vector search almost
always returns *something* from some document, this let the model answer
from priors while the UI still rendered "Answered using your course files".

Fixed behavior: that path now additionally requires evidence_report.sufficient
(authority-coverage) AND relevance_score >= COURSE_ANCHOR_RELEVANCE_THRESHOLD.
A bare non-empty openFileContext string is also no longer trusted on
presence alone -- it must clear the existing text-quality bar. When neither
holds and the grounding policy forbids a general-knowledge fallback, the
response is tagged sourceScope="unavailable" (not "course_files"), so the
frontend's setBubbleSubtitle never shows a false grounding claim next to an
honest "could not find enough evidence" refusal.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json

from app.services.retrieval import RetrievedChunk
from app.services.source_router import course_not_found_answer


def _patch_common(monkeypatch, *, user_id: str, conversation_id: str, document_id: str,
                   file_name: str, chunks: list[RetrievedChunk], chunk_count: int | None = None):
    from app.routers import stream
    from app.services import mastery, retrieval, tutor_state_store
    from app.services.tutor_state import TutorState

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda *_a, **_k: TutorState(conversation_id=conversation_id, user_id=user_id),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "claim_generation", lambda *_a, **_k: True)
    monkeypatch.setattr(tutor_state_store, "current_persisted_generation", lambda *_a, **_k: 1)
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            document_id: {
                "id": document_id,
                "user_id": user_id,
                "course_id": "course-1",
                "file_name": file_name,
                "storage_path": f"synthetic/{file_name}",
                "document_hash": "rev-1",
                "processing_status": "ready",
                "page_count": 2,
                # Deliberately independent of len(chunks): this is the
                # document's indexed-chunk count (the cheap readiness-check
                # metadata at stream.py's _selected_document_readiness_issue),
                # not how many chunks THIS question's retrieval returned. A
                # document genuinely indexed with content can still retrieve
                # zero chunks for an off-topic/unmatched question -- collapsing
                # the two made the zero-retrieved-chunks test accidentally hit
                # the unrelated "still being indexed" (missing_chunks) guard
                # instead of the grounding gate under test.
                "chunk_count": chunk_count if chunk_count is not None else max(len(chunks), 1),
                # Required alongside chunk_count>0 for the same readiness
                # check: a blank active_index_revision reads as
                # "missing_active_revision" (also a pre-grounding-gate guard).
                "active_index_revision": "rev-1",
                "structural_index_status": "ready",
            }
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    # stream.py imports these names directly (`from ..services.X import name`),
    # so each binds its own reference in stream's namespace at import time --
    # patching the defining module's attribute (e.g. cache.fetch_course_version_hash)
    # does NOT affect the name stream.py already resolved. Patch on `stream` itself.
    monkeypatch.setattr(stream, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(stream, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(stream, "save_answer", lambda **_: None)
    monkeypatch.setattr(stream, "get_german_learner_profile", lambda *_a, **_k: None)

    monkeypatch.setattr(stream, "retrieve_routed_chunks", lambda **_: list(chunks))
    monkeypatch.setattr(stream, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(stream, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(stream, "retrieve_numbered_section_chunks", lambda **_: [])
    # retrieve_visible_page_chunks is imported lazily inside the function body
    # (`from ..services.retrieval import ...` at call time), so patching the
    # defining module's attribute here does take effect.
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **_: type("R", (), {
            "chunks": list(chunks), "evidence": [], "to_dict": lambda self: {},
        })(),
    )
    monkeypatch.setattr(
        stream, "research_unresolved_items",
        lambda *_a, **_k: type("FR", (), {"sources": [], "prompt_overlay": lambda self: ""})(),
    )
    monkeypatch.setattr(stream, "fetch_account_snapshot", lambda *_a, **_k: None)
    # Lazily imported inside _selected_document_index_corrupt at call time, so
    # patching the defining module's attribute here takes effect. Without
    # this, the live second-layer document-health check hits Supabase for
    # real and fails the DNS/network sandboxing this test suite requires.
    from app.services import document_health
    monkeypatch.setattr(
        document_health, "validate_active_document_index",
        lambda *_a, **_k: {"health": document_health.DocumentIndexHealth.READY},
    )

    def fake_stream_answer(**_kwargs):
        done = {"done": True, "retrievalMode": "strong", "answerMode": "explain", "sources": []}
        yield 'data: {"meta": true}\n\n'.encode()
        yield b'data: {"t":"This is a real course-grounded answer."}\n\n'
        yield f"data: {json.dumps(done)}\n\n".encode()

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    def fake_stream_general_answer(*_a, **_k):
        yield {"t": "General-knowledge answer (not from course files)."}
        yield {"done": True}

    monkeypatch.setattr(stream, "stream_general_answer", fake_stream_general_answer)
    return stream


def _run(stream, payload, user_id: str) -> tuple[list[bytes], dict]:
    async def run():
        response = await stream.ask_stream_endpoint(payload, {"id": user_id})
        return [event async for event in response.body_iterator]

    events = asyncio.run(run())
    done_line = next(e for e in events if b'"done": true' in e or b'"done":true' in e)
    done_json = json.loads(done_line.decode().removeprefix("data: ").strip())
    return events, done_json


def test_course_files_mode_with_irrelevant_chunks_falls_back_honestly(monkeypatch):
    """The exact defect under fix: Course Files mode + chunks from an unrelated
    document must NOT be treated as sufficient grounding. With the default
    (non-"only") Course Files wording the policy allows a general-knowledge
    fallback, so this must land there -- never on sourceScope="course_files"."""

    user_id = "00000000-0000-4000-8000-000000000010"
    document_id = "00000000-0000-4000-8000-000000000011"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="irrelevant-chunks",
        document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="irrelevant-chunks",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done
    assert done.get("usedGeneralKnowledge") is True, done


def test_course_files_mode_with_relevant_sufficient_evidence_still_grounds(monkeypatch):
    """Regression guard: a genuinely on-topic, authority-matching chunk must
    still be accepted -- the fix must not make Course Files mode strictly
    *more* restrictive than warranted."""

    user_id = "00000000-0000-4000-8000-000000000012"
    document_id = "00000000-0000-4000-8000-000000000013"
    relevant_chunk = RetrievedChunk(
        chunk_id="c-relevant", document_id=document_id, page_start=12, page_end=12,
        text="Nachgiebigkeit is defined in the lecture as the inverse of stiffness.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="Lecture 3: Nachgiebigkeit",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="relevant-chunks",
        document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[relevant_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="relevant-chunks",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] == "course_files", done
    assert done.get("usedGeneralKnowledge") is not True, done


def test_course_files_mode_with_relevant_but_unauthoritative_chunk_falls_back_honestly(monkeypatch):
    """Regression guard for the committed-mode gate: a chunk can be highly
    relevant (word overlap + similarity) and still fail evidence_report.sufficient
    because its source document carries no authority matching what the question
    requires (e.g. a student's own notes, which can never supply "applicable
    formula"/"official solution method"). The bare relevance-only OR-term must
    not let that chunk through for Course Files mode -- only the combined
    evidence_report.sufficient AND relevance_score path may ground here."""

    user_id = "00000000-0000-4000-8000-000000000014"
    document_id = "00000000-0000-4000-8000-000000000015"
    question = "Calculate the force F using the formula from Aufgabe 5."
    notes_chunk = RetrievedChunk(
        chunk_id="c-notes", document_id=document_id, page_start=3, page_end=3,
        text="Calculate the force F using the formula from Aufgabe 5 -- my own notes.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="My notes",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="unauthoritative-but-relevant",
        document_id=document_id, file_name="Mitschrift_Thermodynamik.pdf",
        chunks=[notes_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question=question,
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="unauthoritative-but-relevant",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done
    assert done.get("usedGeneralKnowledge") is True, done


def test_sufficient_authority_evidence_but_low_relevance_does_not_ground(monkeypatch):
    """The mirror case of the unauthoritative-chunk test above:
    evidence_report.sufficient only measures document-AUTHORITY coverage (is
    there a professor-lecture chunk at all?), not whether that chunk is
    actually about this question. A lecture-authority chunk on a completely
    different topic satisfies evidence_report.sufficient trivially but must
    still fail relevance_score -- committed_retrieved_text_grounded requires
    BOTH, and the bare relevance-only OR-term is disabled in committed mode,
    so this must not ground either."""

    user_id = "00000000-0000-4000-8000-000000000030"
    document_id = "00000000-0000-4000-8000-000000000031"
    off_topic_lecture_chunk = RetrievedChunk(
        chunk_id="c-offtopic-lecture", document_id=document_id, page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="sufficient-evidence-low-relevance",
        document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[off_topic_lecture_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="sufficient-evidence-low-relevance",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done


def test_reused_prior_grounding_followup_to_a_different_exercise_requires_fresh_retrieval(monkeypatch):
    """Reviewer-flagged risk: stream.py forces has_strong_course_anchor=True
    whenever dialogue.requires_new_retrieval is False (a "reused prior
    grounding" follow-up), with no fresh evidence check. A bare exercise-
    number continuation ("5.3") after a course-grounded answer about exercise
    5.2 used to be classified as EvidenceRequirement.REUSE_PRIOR_GROUNDED
    (dialogue_state.py's CONTINUE_NEXT_QUESTION act inherited the generic
    "continuing previous goal" path meant for paraphrase/clarification), which
    skipped retrieval entirely for a DIFFERENT exercise nothing in the
    conversation has evidence for yet -- the model would answer 5.3 from
    priors while the force-true still claimed sourceScope="course_files".
    Fixed by requiring fresh evidence for CONTINUE_NEXT_QUESTION
    (dialogue_state._VERIFICATION_SENSITIVE_ACTS). With chunks genuinely
    empty for 5.3, this must now land on an honest non-course_files scope,
    not a false grounding claim."""

    user_id = "00000000-0000-4000-8000-000000000032"
    document_id = "00000000-0000-4000-8000-000000000033"
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="exercise-switch-followup",
        document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="5.3",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="exercise-switch-followup",
        conversationGeneration=1,
        previousTurns=[
            {"role": "user", "text": "Solve exercise 5.2."},
            {
                "role": "assistant", "text": "The verified result for 5.2 is x = 4.",
                "sourceScope": "course_files", "groundingMode": "relevance",
            },
        ],
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done


def test_explicit_file_selection_with_zero_chunks_returns_honest_unavailable(monkeypatch):
    """The original reported scenario: a specifically-selected, fully-indexed
    document whose retrieval genuinely returns zero chunks for this question
    must produce an honest "not found" refusal tagged sourceScope="unavailable"
    -- never "course_files". The SELECTED_FILES_ONLY policy this triggers
    forbids a general-knowledge fallback, so this is the path that used to
    silently answer from priors under a false grounding claim. chunk_count=5
    keeps the document's indexed-chunk metadata nonzero so this exercises the
    grounding gate itself, not the separate/unrelated "still being indexed"
    (missing_chunks) early-return guard."""

    user_id = "00000000-0000-4000-8000-000000000014"
    document_id = "00000000-0000-4000-8000-000000000015"
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="indexed-doc-no-matching-chunks",
        document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[], chunk_count=5,
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        documentIds=[document_id],
        question="Summarize chapter 4 of this document.",
        sourceMode="course_files",
        courseFileScope="specific_files",
        conversationId="indexed-doc-no-matching-chunks",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    # _stream_static_answer derives confidence/unsupported from answer_mode
    # ("strong" here, same as a genuinely-grounded answer) -- it reflects
    # confidence in the delivered refusal text, not whether grounding
    # succeeded. The claim that matters is sourceScope, asserted above and
    # below: never "course_files" alongside this refusal.
    assert done["sourceScope"] == "unavailable", done
    assert done["sourceScope"] != "course_files", done
    assert done.get("usedGeneralKnowledge") is not True, done


def test_garbled_open_file_context_does_not_alone_establish_grounding(monkeypatch):
    """A near-empty/garbled openFileContext (e.g. an image-only page's text
    layer) must not, by mere presence, prove usable document content reached
    the model. Same irrelevant-chunk setup as the first test, plus a
    single-character openFileContext -- outcome must be unchanged."""

    user_id = "00000000-0000-4000-8000-000000000016"
    document_id = "00000000-0000-4000-8000-000000000017"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant-2", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="garbled-open-file-context",
        document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        openFileContext="x",
        visiblePage=5,
        conversationId="garbled-open-file-context",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done


def test_valid_open_page_text_still_grounds_despite_weak_retrieval(monkeypatch):
    """Required case E: a genuinely substantive openFileContext (the open PDF
    page's real text, clearing assess_text_quality) must still ground the
    answer even when course-wide retrieval itself is weak/irrelevant for this
    question -- has_strong_course_anchor ORs open_file_text_grounded
    independently of relevance_score/evidence_report, so strong open-page
    evidence is never accidentally rejected because retrieval came back thin."""

    user_id = "00000000-0000-4000-8000-000000000018"
    document_id = "00000000-0000-4000-8000-000000000019"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant-3", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="valid-open-page-weak-retrieval",
        document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        openFileContext=(
            "Nachgiebigkeit (compliance) is defined in this lecture as the "
            "inverse of stiffness: a higher Nachgiebigkeit means the structure "
            "deforms more under the same load. See the worked example on this "
            "page for the governing equation and units."
        ),
        visiblePage=5,
        conversationId="valid-open-page-weak-retrieval",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] == "course_files", done
    assert done.get("usedGeneralKnowledge") is not True, done


def test_fast_grounded_sufficient_evidence_request_completes_with_terminal_done(monkeypatch):
    """Regression for the FAST_GROUNDED fallback_research crash: when
    fast_grounded_evidence_is_sufficient(...) is True, fallback_research was
    built as a bare SimpleNamespace(sources=[]) with no prompt_overlay()
    method, but gen() unconditionally calls fallback_research.prompt_overlay()
    while building the prompt for stream_answer() -- every such request
    silently degraded to a "could not be completed" SSE error (caught by
    _stream_live_answer's try/except, never a raised exception). Forces the
    FAST_GROUNDED lane the same way test_stream_route_multiturn.py's sibling
    regression does (wrap the real resolve_execution_plan, override only the
    lane via dataclasses.replace) but, unlike that test, lets real retrieval
    run on a genuinely relevant chunk and forces
    fast_grounded_evidence_is_sufficient to True so this test actually reaches
    the SimpleNamespace(sources=[]) branch the sibling regression does not."""
    from app.services.execution_router import ExecutionLane

    user_id = "00000000-0000-4000-8000-000000000020"
    document_id = "00000000-0000-4000-8000-000000000021"
    relevant_chunk = RetrievedChunk(
        chunk_id="c-relevant-fg", document_id=document_id, page_start=12, page_end=12,
        text="Nachgiebigkeit is defined in the lecture as the inverse of stiffness.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="Lecture 3: Nachgiebigkeit",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="fast-grounded-sufficient-evidence",
        document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[relevant_chunk],
    )

    _real_resolve_execution_plan = stream_mod.resolve_execution_plan

    def _forced_fast_grounded(*args, **kwargs):
        task_profile, plan = _real_resolve_execution_plan(*args, **kwargs)
        forced_plan = dataclasses.replace(
            plan, executionLane=ExecutionLane.FAST_GROUNDED, initialLane=ExecutionLane.FAST_GROUNDED,
        )
        return task_profile, forced_plan

    monkeypatch.setattr(stream_mod, "resolve_execution_plan", _forced_fast_grounded)
    monkeypatch.setattr(stream_mod, "fast_grounded_evidence_is_sufficient", lambda **_k: True)

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="fast-grounded-sufficient-evidence",
        conversationGeneration=1,
    )
    events, done = _run(stream_mod, payload, user_id)

    joined = b"".join(events)
    assert b"prompt_overlay" not in joined, joined
    assert b'"code": "live_generation_failed"' not in joined, joined
    assert b'"code": "stream_ended_without_terminal_event"' not in joined, joined
    assert done["done"] is True
    assert done["sourceScope"] == "course_files", done
    assert done.get("answerMode") == "explain"


def test_explain_formula_sheet_content_grounds_without_requiring_solution_method(monkeypatch):
    """Regression for the overly-restrictive side of the evidence-requirement
    fix: build_course_evidence_report used to require question statement +
    applicable formula + official solution method for ANY question matching
    a math-ish pattern, including a pure "explain this" request that names no
    exercise and wants no derivation. "Explain the formulas on this sheet"
    against an authorized formula chunk from an unauthoritative-by-name file
    (formelzettel.pdf doesn't match the OFFICIAL_FORMULA_SHEET authority
    regex either) was therefore marked insufficient and silently fell back to
    general knowledge -- this is the scenario
    test_visual_aids_and_learning_recommendations_do_not_block_generation in
    test_stream_route_multiturn.py independently caught (it asserts on the
    real course-grounded generation path, not sourceScope, so it couldn't
    hit general knowledge without crashing on the unmocked live OpenAI call).
    Fixed by routing EXPLANATION/FORMULA_LOOKUP intent (question_routing.
    detect_intents) to a requirement a formula/lecture chunk can actually
    satisfy, instead of demanding a second "official solution" document for
    a request that isn't asking to solve anything."""

    user_id = "00000000-0000-4000-8000-000000000034"
    document_id = "00000000-0000-4000-8000-000000000035"
    formula_chunk = RetrievedChunk(
        chunk_id="c-formula", document_id=document_id, page_start=1, page_end=1,
        text="Formula sheet contents.", score=1.0, similarity=1.0,
        chunk_type="formula", section_title="Formelzettel",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="explain-formula-sheet",
        document_id=document_id, file_name="formelzettel.pdf",
        chunks=[formula_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="Explain the formulas on this sheet.",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="explain-formula-sheet",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] == "course_files", done
    assert done.get("usedGeneralKnowledge") is not True, done


def test_official_solution_request_not_hijacked_by_lecture_definition_chunk(monkeypatch):
    """SSE-route counterpart of the precedence fix: question_routing.
    detect_intents returns a tuple of co-occurring intents, not one
    classification -- an explicit solution request can also match DEFINITION
    (e.g. "what is ..." wording). A plain PROFESSOR_LECTURE-authority chunk
    trivially satisfies the DEFINITION branch's requirement, so without an
    independent, higher-priority check for an explicit solution request,
    this would falsely ground as course_files from lecture content alone
    instead of requiring an actual OFFICIAL_SOLUTION-authority document."""
    user_id = "00000000-0000-4000-8000-000000000038"
    document_id = "00000000-0000-4000-8000-000000000039"
    lecture_chunk = RetrievedChunk(
        chunk_id="c-lecture", document_id=document_id, page_start=1, page_end=1,
        text="Lecture content defining the formula conceptually.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="Lecture",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="official-solution-not-hijacked",
        document_id=document_id, file_name="Professor Vorlesung.pdf",
        chunks=[lecture_chunk],
    )

    # "...for this formula" classifies as reliability.VisualTaskKind.
    # FORMULA_EXPLANATION, which is image_preferred and would 404 with
    # visible_page_capture_failed with no page image supplied -- a pre-
    # grounding gate unrelated to the authority bug this test targets, and
    # owned by reliability.py. "worked solution" with no formula mention
    # classifies as text_explanation/text_sufficient instead, reaching the
    # course-grounding evidence gate directly.
    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="Can you show the official worked solution?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="official-solution-not-hijacked",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done
    assert done.get("usedGeneralKnowledge") is True, done


def test_long_wellformed_but_unrelated_open_file_page_does_not_ground(monkeypatch):
    """assess_text_quality measures legibility (printable ratio, length, word
    count) ONLY -- it has no relevance component. A long, well-formed PDF
    page about a completely different topic must not ground an unrelated
    question just because it reads cleanly; readable text is not relevant
    text. No other evidence is supplied (chunks=[]), so this must fail
    honestly rather than silently answering from priors under a false
    course_files claim."""

    user_id = "00000000-0000-4000-8000-000000000036"
    document_id = "00000000-0000-4000-8000-000000000037"
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="long-unrelated-open-page",
        document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[],
    )

    unrelated_page = (
        "Chapter 9: Corporate Marketing Strategy. This chapter reviews how "
        "pricing tiers are structured across enterprise and consumer segments, "
        "the historical evolution of subscription bundling, and several case "
        "studies of regional sales campaigns that succeeded despite limited "
        "advertising budgets. Readers should note the distinction between "
        "customer acquisition cost and lifetime value when evaluating these "
        "campaigns, as later chapters build directly on this framework."
    )
    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        openFileContext=unrelated_page,
        visiblePage=9,
        conversationId="long-unrelated-open-page",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] != "course_files", done
    assert done["sourceScope"] == "general_knowledge", done


def test_short_relevant_formula_open_file_text_grounds_via_real_evidence(monkeypatch):
    """A short, genuinely relevant formula snippet (e.g. "F = m * a") can
    legitimately fail assess_text_quality's length/lexical bar on its own
    (it rewards long, word-dense pages, not terse formula notation) -- that
    bar must not be the ONLY path to grounding, or short valid mathematical
    evidence gets wrongly excluded. This is the realistic shape: the student
    isn't asking about their currently-open page at all (no openFileContext,
    so the unrelated visible-page-capture gate in reliability.py never
    triggers), they're asking about the formula as INDEXED document content,
    which retrieval surfaces as its own chunk (chunk_type "formula"). That
    chunk grounds the answer through the ordinary evidence path --
    the short-text quality bar is simply never in the way here."""

    user_id = "00000000-0000-4000-8000-000000000038"
    document_id = "00000000-0000-4000-8000-000000000039"
    short_formula_chunk = RetrievedChunk(
        chunk_id="c-short-formula", document_id=document_id, page_start=1, page_end=1,
        text="F = m * a", score=1.0, similarity=1.0,
        chunk_type="formula", section_title="Formelzettel",
    )
    stream_mod = _patch_common(
        monkeypatch, user_id=user_id, conversation_id="short-relevant-formula",
        document_id=document_id, file_name="formelzettel.pdf",
        chunks=[short_formula_chunk],
    )

    payload = stream_mod.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=document_id,
        question="Explain what F = m * a represents.",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        conversationId="short-relevant-formula",
        conversationGeneration=1,
    )
    _events, done = _run(stream_mod, payload, user_id)

    assert done["sourceScope"] == "course_files", done


def test_course_not_found_answer_text_is_unchanged_for_unavailable_claim():
    """Sanity: the refusal copy itself wasn't touched by this fix."""
    text = course_not_found_answer()
    assert "could not find enough" in text.lower()
