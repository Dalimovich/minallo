"""Route-level production-pipeline regression for a long tutoring conversation."""

from __future__ import annotations

import asyncio
import json

from app.services.retrieval import RetrievedChunk
from app.services.tutor_state import TutorState


def test_twenty_turn_route_persists_state_and_rejects_stale_work(monkeypatch):
    from app.routers import stream
    from app.services import (
        cache,
        mastery,
        pdf_region_evidence,
        retrieval,
        tutor_state_store,
    )

    user_id = "00000000-0000-4000-8000-000000000001"
    document_id = "00000000-0000-4000-8000-000000000002"
    conversation_id = "route-level-20-turn"
    persisted = TutorState(conversation_id=conversation_id, user_id=user_id)
    latest_generation = -1
    generated_source_zero: list[str] = []

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            document_id: {
                "id": document_id,
                "user_id": user_id,
                "course_id": "course-1",
                "file_name": "Exam A.pdf",
                "storage_path": "synthetic/exam.pdf",
                "document_hash": "rev-2",
            }
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)

    selected_chunk = RetrievedChunk(
        chunk_id="selected-source",
        document_id=document_id,
        page_start=33,
        page_end=33,
        text="Aufgabe 13.11 vc = 560 m/min. Correct marked answer: 11.",
        score=1.0,
        similarity=1.0,
        chunk_type="exercise",
        section_title="Aufgabe 13.11",
    )
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [selected_chunk])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **_: [selected_chunk])
    monkeypatch.setattr(
        pdf_region_evidence,
        "verify_pdf_region",
        lambda **kwargs: pdf_region_evidence.PdfRegionEvidence(
            document_id=document_id,
            document_revision="rev-2",
            page=33,
            bbox=kwargs["bbox"],
            text="Aufgabe 13.11\nvc = 560 m/min\nCorrect answer: 11",
            critical_tokens=("13.11", "vc", "560", "m/min", "11"),
            exercise_id="13.11",
            crop_sha256="server-crop",
            evidence_sha256=f"server-evidence-{latest_generation}",
            text_confidence=0.98,
            region_confidence=0.98,
            client_text_agreement=1.0,
            vision_text="Aufgabe 13.11 vc = 560 m/min Correct answer: 11",
            vision_confidence=0.98,
            vision_model="deterministic-eval",
            vision_cache_hit=False,
        ),
    )

    def claim(_uid, _conversation, _course, generation):
        nonlocal latest_generation
        if generation < latest_generation:
            return False
        latest_generation = generation
        persisted.generation = generation
        return True

    def load(_uid, _conversation):
        return TutorState.from_api(persisted.to_api(), conversation_id=conversation_id)

    def save(_uid, _course, state):
        nonlocal persisted
        assert state.generation == latest_generation
        persisted = TutorState.from_api(state.to_api(), conversation_id=conversation_id)

    monkeypatch.setattr(tutor_state_store, "claim_generation", claim)
    monkeypatch.setattr(tutor_state_store, "load_tutor_state", load)
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", save)
    monkeypatch.setattr(
        tutor_state_store,
        "current_persisted_generation",
        lambda *_: latest_generation,
    )

    def fake_stream_answer(**kwargs):
        generated_source_zero.append(kwargs.get("open_file_context") or "")
        meta = {
            "meta": True,
            "retrievalMode": "strong",
            "answerMode": "math",
        }
        done = {
            "done": True,
            "retrievalMode": "strong",
            "answerMode": "math",
            "verification": {
                "status": "verified",
                "details": {
                    "criticalNumericalMismatch": False,
                    "numberMisses": [],
                    "fabricatedFilenames": [],
                    "invalidSourceIndices": [],
                    "fakeSolutionPhrases": [],
                },
            },
            "sources": [{
                "file_name": "Exam A.pdf",
                "documentId": document_id,
                "pageStart": 33,
            }],
        }
        yield f"data: {json.dumps(meta)}\n\n".encode()
        yield b'data: {"t":"11"}\n\n'
        yield f"data: {json.dumps(done)}\n\n".encode()

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    turns = [
        "Solve Aufgabe 13.11.", "And b?", "Use 580 instead.",
        "No, use 560 instead.", "That answer is wrong.", "Answer in German.",
        "Explain in detail.", "Again", "Are you sure?", "All",
        "Use the previous verified result.", "Only the result.",
        "Show the first step.", "Continue.", "Check my answer: 11.",
        "Give a hint.", "Explain it simply.", "Aufgabe 13.11.",
        "Use the verified value.", "Final answer.",
    ]

    async def run_turn(generation: int, question: str, revision: str = "rev-2"):
        payload = stream.AskStreamRequest(
            courseId="course-1",
            activeDocumentId=document_id,
            question=question,
            selectedText="Aufgabe 13.11\nvc = 560 m/min\nCorrect answer: 11",
            selectedRegion=stream.SelectedRegionPayload(
                page=33, x=0.1, y=0.1, width=0.5, height=0.2,
                    id=f"region-{generation}",
                    documentRevision=revision,
                    cropHash=f"crop-{generation}",
                    coordinateSpace="normalized_pdf_page",
                ),
            viewerRevision=revision,
            visiblePage=33,
            conversationId=conversation_id,
            conversationGeneration=generation,
            sourceMode="course_files",
            openFileContext="Visible page 33",
            previousTurns=[],
        )
        response = await stream.ask_stream_endpoint(payload, {"id": user_id})
        events = [event async for event in response.body_iterator]
        assert not any(b"STALE_GENERATION" in event for event in events)

    for generation, question in enumerate(turns, start=1):
        asyncio.run(run_turn(generation, question))
        assert persisted.generation == generation
        assert persisted.document_id == document_id
        assert persisted.document_revision == "rev-2"
        assert persisted.active_page == 33
        assert persisted.active_region_id.startswith("pdf-region:")
        assert persisted.active_question == "13.11"
        assert persisted.response_language in {"en", "de"}
        assert all(
            result.document_revision == "rev-2"
            for result in persisted.reusable_results()
        )

    assert any(item.status == "rejected" for item in persisted.results.values()) or persisted.corrections
    assert persisted.corrections
    assert all(
        context.startswith("SERVER-VERIFIED SELECTED PDF EVIDENCE (Source 0):")
        for context in generated_source_zero
    )

    # A delayed request from generation 10 is rejected by the real route before
    # retrieval/generation and cannot overwrite generation 20.
    async def stale_turn():
        payload = stream.AskStreamRequest(
            courseId="course-1",
            question="Use 580 again.",
            conversationId=conversation_id,
            conversationGeneration=10,
        )
        response = await stream.ask_stream_endpoint(payload, {"id": user_id})
        return b"".join([event async for event in response.body_iterator])

    stale_events = asyncio.run(stale_turn())
    assert b"STALE_GENERATION" in stale_events
    assert persisted.generation == 20
