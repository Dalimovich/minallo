"""Regression tests for the course-grounding anchor gate (has_strong_course_anchor)
in /ask, mirroring tests/test_course_grounding_claim_gate.py's /ask-stream coverage.

/ask is synchronous and has no ExecutionLane/FAST_GROUNDED concept (ask.py imports
no execution_router symbol), so these tests call ask_endpoint directly and inspect
the returned AskResponse -- no SSE decoding needed. Mock targets mirror the same
direct-import pitfall documented in test_course_grounding_claim_gate.py: ask.py
does `from ..services.X import name` for cache/retrieval/health functions, so
patches must target the `ask` module, not the defining service module.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.services.retrieval import RetrievedChunk
from app.services.source_router import course_not_found_answer


def _patch_common(monkeypatch, *, document_id: str, file_name: str,
                   chunks: list[RetrievedChunk]):
    from app.routers import ask
    from app.services import document_health, mastery

    doc_name_map = {document_id: file_name}
    monkeypatch.setattr(ask, "_verify_user_owns_documents", lambda *_a, **_k: dict(doc_name_map))
    monkeypatch.setattr(
        ask, "validate_active_document_index",
        lambda *_a, **_k: {"health": document_health.DocumentIndexHealth.READY},
    )
    # Empty version_hash short-circuits both the cache lookup (`if version_hash:`)
    # and the cache save (`if version_hash and ...`) without needing separate
    # lookup_answer/save_answer mocks.
    monkeypatch.setattr(ask, "fetch_course_version_hash", lambda *_a, **_k: "")
    monkeypatch.setattr(ask, "retrieve_exercise_block", lambda **_k: None)
    monkeypatch.setattr(ask, "retrieve_chunks", lambda **_k: list(chunks))
    monkeypatch.setattr(ask, "retrieve_formula_block", lambda **_k: [])
    monkeypatch.setattr(
        ask, "retrieve_multi_item_course_evidence",
        lambda **_k: type("R", (), {
            "chunks": list(chunks), "evidence": [], "to_dict": lambda self: {},
        })(),
    )
    monkeypatch.setattr(
        ask, "research_unresolved_items",
        lambda *_a, **_k: type("FR", (), {"sources": [], "prompt_overlay": lambda self: ""})(),
    )
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_a, **_k: [])
    monkeypatch.setattr(ask, "record_retrieval_debug", lambda *_a, **_k: None)

    def fake_generate_answer(**_kwargs):
        return {"answer": "This is a real course-grounded answer.", "retrievalMode": "strong"}

    monkeypatch.setattr(ask, "generate_answer", fake_generate_answer)

    def fake_generate_general_answer(*_a, **_k):
        return {
            "answer": "General-knowledge answer (not from course files).",
            "retrievalMode": "weak",
        }

    monkeypatch.setattr(ask, "generate_general_answer", fake_generate_general_answer)
    return ask


def test_course_files_mode_with_irrelevant_chunks_falls_back_honestly(monkeypatch):
    """The exact defect under fix: Course Files mode + chunks from an unrelated
    document must NOT be treated as sufficient grounding."""
    document_id = "00000000-0000-4000-8000-000000000021"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000001",
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope != "course_files", response
    assert response.sourceScope == "general_knowledge", response


def test_course_files_mode_with_relevant_sufficient_evidence_still_grounds(monkeypatch):
    """Strong, relevant course evidence must still be accepted -- the fix must
    not make Course Files mode strictly *more* restrictive than warranted."""
    document_id = "00000000-0000-4000-8000-000000000022"
    relevant_chunk = RetrievedChunk(
        chunk_id="c-relevant", document_id=document_id, page_start=12, page_end=12,
        text="Nachgiebigkeit is defined in the lecture as the inverse of stiffness.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="Lecture 3: Nachgiebigkeit",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[relevant_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000002",
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope == "course_files", response
    assert response.answer == "This is a real course-grounded answer."


def test_course_files_mode_with_relevant_but_unauthoritative_chunk_falls_back_honestly(monkeypatch):
    """Mirrors test_course_grounding_claim_gate.py's /ask-stream coverage of the
    same committed-mode gate: a chunk can be highly relevant (word overlap +
    similarity) and still fail evidence_report.sufficient because its source
    document carries no authority matching what the question requires (e.g. a
    student's own notes, which can never supply "applicable formula"/"official
    solution method"). The bare relevance-only OR-term must not let that chunk
    through for Course Files mode -- only the combined evidence_report.sufficient
    AND relevance_score path may ground here."""
    document_id = "00000000-0000-4000-8000-000000000030"
    question = "Calculate the force F using the formula from Aufgabe 5."
    notes_chunk = RetrievedChunk(
        chunk_id="c-notes", document_id=document_id, page_start=3, page_end=3,
        text="Calculate the force F using the formula from Aufgabe 5 -- my own notes.",
        score=1.0, similarity=1.0, chunk_type="text", section_title="My notes",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="Mitschrift_Thermodynamik.pdf",
        chunks=[notes_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000007",
        courseId="course-1",
        activeDocumentId=document_id,
        question=question,
        sourceMode="course_files",
        courseFileScope="all_course_files",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope != "course_files", response
    assert response.sourceScope == "general_knowledge", response


def test_sufficient_authority_evidence_but_low_relevance_does_not_ground(monkeypatch):
    """The mirror case: evidence_report.sufficient only measures document-
    AUTHORITY coverage (is there a professor-lecture chunk at all?), not
    whether that chunk is actually about this question. A lecture-authority
    chunk on a completely different topic satisfies evidence_report.sufficient
    trivially but must still fail relevance_score -- committed_retrieved_text_
    grounded requires BOTH, and the bare relevance-only OR-term is disabled in
    committed mode, so this must not ground either."""
    document_id = "00000000-0000-4000-8000-000000000031"
    off_topic_lecture_chunk = RetrievedChunk(
        chunk_id="c-offtopic-lecture", document_id=document_id, page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="Lecture 3.pdf",
        chunks=[off_topic_lecture_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000008",
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope != "course_files", response
    assert response.sourceScope == "general_knowledge", response


def test_explicit_file_selection_with_zero_matching_chunks_returns_honest_unavailable(monkeypatch):
    """A specifically-selected, fully-indexed document whose retrieval genuinely
    returns zero chunks for this question must produce an honest refusal tagged
    sourceScope="unavailable" -- never "course_files". The SELECTED_FILES_ONLY
    policy this triggers forbids a general-knowledge fallback, so this is the
    path that used to silently answer from priors under a false grounding claim."""
    document_id = "00000000-0000-4000-8000-000000000023"
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000003",
        courseId="course-1",
        activeDocumentId=document_id,
        documentIds=[document_id],
        question="Summarize chapter 4 of this document.",
        sourceMode="course_files",
        courseFileScope="specific_files",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope == "unavailable", response
    assert response.sourceScope != "course_files", response


def test_garbled_open_file_context_does_not_alone_establish_grounding(monkeypatch):
    """A near-empty/garbled openFileContext (e.g. an image-only page's text
    layer) must not, by mere presence, prove usable document content reached
    the model."""
    document_id = "00000000-0000-4000-8000-000000000024"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant-2", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000004",
        courseId="course-1",
        activeDocumentId=document_id,
        question="What is the definition of Nachgiebigkeit in the lecture?",
        sourceMode="course_files",
        courseFileScope="all_course_files",
        openFileContext="x",
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope != "course_files", response
    assert response.sourceScope == "general_knowledge", response


def test_valid_open_page_text_still_grounds_despite_weak_retrieval(monkeypatch):
    """Required case: a genuinely substantive openFileContext must still ground
    the answer even when course-wide retrieval itself is weak/irrelevant."""
    document_id = "00000000-0000-4000-8000-000000000025"
    irrelevant_chunk = RetrievedChunk(
        chunk_id="c-irrelevant-3", document_id="other-doc-id", page_start=5, page_end=5,
        text="Completely unrelated marketing strategy notes about pricing tiers.",
        score=0.2, similarity=0.05, chunk_type="text", section_title="Random notes",
    )
    ask = _patch_common(
        monkeypatch, document_id=document_id, file_name="skript_et_23.04.pdf",
        chunks=[irrelevant_chunk],
    )
    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000005",
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
    )
    response = ask.ask_endpoint(payload)

    assert response.sourceScope == "course_files", response


def test_authorization_rejects_document_not_owned_by_caller(monkeypatch):
    """Authorization must stay intact through the grounding-gate change:
    _verify_user_owns_documents' real logic (not mocked away here) must still
    reject a document belonging to a different user/course with 404, before
    ever reaching retrieval or generation."""
    from app.routers import ask

    other_users_document_id = "00000000-0000-4000-8000-000000000026"

    class _FakeResp:
        data = [{
            "id": other_users_document_id,
            "user_id": "00000000-0000-4000-8000-000000000999",  # not the caller
            "course_id": "course-1",
            "file_name": "not-yours.pdf",
        }]

    class _FakeTable:
        def select(self, *_a, **_k):
            return self

        def in_(self, *_a, **_k):
            return self

        def execute(self):
            return _FakeResp()

    class _FakeSupabase:
        def table(self, *_a, **_k):
            return _FakeTable()

    monkeypatch.setattr(ask, "get_supabase", lambda: _FakeSupabase())

    def fail_if_reached(**_kwargs):
        raise AssertionError("retrieval must not run past the ownership check")

    monkeypatch.setattr(ask, "retrieve_chunks", fail_if_reached)

    from app.routers.ask import AskRequest

    payload = AskRequest(
        userId="00000000-0000-4000-8000-000000000006",  # the actual caller
        courseId="course-1",
        documentIds=[other_users_document_id],
        question="Summarize this document.",
        sourceMode="course_files",
        courseFileScope="specific_files",
    )

    try:
        ask.ask_endpoint(payload)
        raise AssertionError("expected HTTPException(404)")
    except HTTPException as exc:
        assert exc.status_code == 404


def test_course_not_found_answer_text_is_unchanged_for_unavailable_claim():
    """Sanity: the refusal copy itself wasn't touched by this fix."""
    text = course_not_found_answer()
    assert "could not find enough" in text.lower()
