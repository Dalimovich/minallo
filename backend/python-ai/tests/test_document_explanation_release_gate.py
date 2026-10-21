"""Regression coverage for the confirmed production defect (2026-10-21):
``explain this to me`` on an ordinary, non-exercise document (a university
module-handbook PDF, no numbered exercise anywhere in it) was answered with
the answer-release gate's generic withholding text -- "I'm withholding the
final result here, since that's what you asked for this exercise." --
instead of an actual explanation.

Root cause, traced through the REAL pipeline (not asserted, traced): with
no numbered exercise label anywhere in the message or in dialogue_state's
carried-over active_question, ``diagnostic_policy.adapt_deterministic_
intent`` always marked the action ``state="unresolved"`` regardless of
OBJECTIVE -- including "explain"/"define"/"compare"/"summarize"/
"translate", which have no official-answer-key concept to protect at all.
``policy_compiler.compile_policy``'s unresolved_fallback then forced EVERY
release field to ``_MOST_RESTRICTIVE`` for that single action: final_answer/
official_solution prohibited, form="hint", explanation_depth="none",
max_steps=1, max_items=1, wait_for_student=True. That overlay by itself
instructs the model to "respond with a HINT only" and "do not explain the
method -- state only whether it is correct", which is already wrong
independent of the release gate; combined with the gate's scan-conditioned
single-target withholding (app/services/answer_release_validator.py), a
real generated explanation that happens to brush one of the finite leak-
pattern shapes (e.g. a "Therefore X = Y" style summary of credit totals)
gets silently replaced by the gate's generic text.

Fix: ``adapt_deterministic_intent`` now treats an action as "requested"
(trusted, no exercise-identity verification required) whenever its
objective has no exercise-answer-disclosure concept at all -- "explain",
"define", "compare", "summarize", "translate" -- regardless of whether a
numbered exercise label resolved. Every answer-bearing objective ("solve",
"hint", "official_solution", "exam_practice", "derive",
"answer_subquestion", "review_student_solution") is UNCHANGED: still
"unresolved", still maximally restricted, without a grounded exercise
label, exactly as before this fix.

Design, matching test_live_eval_remediation_acceptance.py's own house
style: exercises the REAL /ask-stream route, REAL dialogue resolution,
REAL deterministic/semantic intent resolution, REAL compile_policy, REAL
prompt assembly, REAL answer_release_validator -- only the actual network
transmission (OpenAI HTTP calls) is faked.
"""

from __future__ import annotations

import asyncio
import uuid

import tests.test_live_eval_remediation_acceptance as base
from app.services import retrieval

DOC_MECH1 = base.DOC_MECH1

CURRICULUM_TEXT = (
    "Pflichtmodule des Studiengangs Elektronische Systeme in Fahrzeugtechnik, "
    "Luft- und Raumfahrt. Der Studiengang gliedert sich in drei "
    "Vertiefungsrichtungen: Electronics Systems Engineering (ESE), Space & "
    "Avionics Systems Electronics (SAS) und Automotive Systems Engineering "
    "(ASE). Wahlpflichtmodule in den Vertiefungsrichtungen: ESE umfasst 30 "
    "ECTS-Punkte in Leistungselektronik und Embedded Systems. SAS umfasst 30 "
    "ECTS-Punkte in Avioniksystemen und Satellitenkommunikation. ASE umfasst "
    "30 ECTS-Punkte in Fahrzeugelektronik und Sensorik. Jede Vertiefung "
    "erfordert den erfolgreichen Abschluss von mindestens vier Modulen."
)


def _install_curriculum_document(monkeypatch):
    """Registers one synthetic, non-exercise document (a module handbook,
    no numbered exercises anywhere) with the real retrieval/authorization
    call sites, mirroring harness._common_mocks's pattern for its own 5
    frozen documents but for a document that is NOT in that frozen corpus.
    Returns the document id."""
    import app.routers.stream as stream_mod

    doc_id = str(uuid.uuid4())
    chunk = retrieval.RetrievedChunk(
        chunk_id="c-curriculum", document_id=doc_id, page_start=1, page_end=2,
        text=CURRICULUM_TEXT, score=1.0, similarity=1.0,
        chunk_type="notes", section_title="Modulhandbuch",
    )
    monkeypatch.setattr(stream_mod, "retrieve_routed_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(
        stream_mod, "retrieve_multi_item_course_evidence",
        lambda **kw: type("R", (), {
            "chunks": [chunk], "evidence": [], "to_dict": lambda self: {},
        })(),
    )
    monkeypatch.setattr(stream_mod, "_load_authorized_documents", lambda *_: {
        doc_id: {
            "id": doc_id, "user_id": base.USER_ID, "course_id": "course-1",
            "file_name": "modulhandbuch.pdf", "storage_path": "synthetic/modulhandbuch.pdf",
            "document_hash": "rev-1", "processing_status": "ready",
            "page_count": 5, "chunk_count": 5,
        },
    })
    monkeypatch.setattr(stream_mod, "_load_authorized_course_candidates", lambda *_a, **_k: [{
        "id": doc_id, "file_name": "modulhandbuch.pdf", "user_id": base.USER_ID,
        "course_id": "course-1", "active_index_revision": "rev-1",
    }])
    return doc_id


async def _ask_with_page(
    stream, *, document_id, question, conversation_id="doc-explain-test",
    generation=1, previous_turns=None, visible_page_text=CURRICULUM_TEXT,
    document_ids=None,
):
    """Like test_live_eval_remediation_acceptance._ask, but also sets
    visiblePage/openFileContext -- the shape the frontend actually sends
    for an open PDF page (confirmed via app/services/reference_resolution.
    py's decide_evidence: without these, an "explain this"-shaped message
    hits the UNRELATED, pre-existing "needs page evidence" clarify gate
    before ever reaching the policy this suite is testing).

    ``document_ids``, when given, sets ``documentIds`` -- the explicit
    scope selection a real "explain this whole document" request routes
    through (app/routers/stream.py's own, pre-existing full_document
    pipeline, confirmed separately: it requires an explicit document
    selection and is otherwise unrelated to the intent-layer bug this
    suite targets)."""
    payload = stream.AskStreamRequest(
        courseId="course-1", activeDocumentId=document_id, documentIds=document_ids,
        question=question, sourceMode="course_files", conversationId=conversation_id,
        conversationGeneration=generation, previousTurns=previous_turns or [],
        visiblePage=1, openFileContext=visible_page_text,
    )
    response = await stream.ask_stream_endpoint(payload, {"id": base.USER_ID})
    return b"".join([event async for event in response.body_iterator])


# ---------------------------------------------------------------------------
# Test 1 -- exact production regression.
# ---------------------------------------------------------------------------

def test_explain_this_to_me_on_a_non_exercise_document_is_not_withheld(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_curriculum_document(monkeypatch)
    # The real generated draft is never available from the production
    # incident -- this is a CONTROLLED, equivalent input reproducing the
    # confirmed failure shape, not a claim of having recovered the actual
    # trace (none exists; see this module's docstring). Phrased the way a
    # model given the OLD, broken overlay ("respond with a HINT only";
    # "do not explain the method") might plausibly summarize credit
    # totals, including the exact "Therefore X = Y" leak shape
    # (_LEAK_PATTERNS' concluding_symbol_equals_number) this suite must
    # prove no longer matters because the overlay itself is fixed.
    draft = (
        "This handbook describes three specializations: ESE, SAS, and ASE. "
        "Therefore ESE = 30 ECTS, SAS = 30 ECTS, and ASE = 30 ECTS, each "
        "requiring at least four modules."
    )
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text=draft)
    try:
        body = asyncio.run(_ask_with_page(stream, document_id=doc_id, question="explain this to me"))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    rendered = base._rendered_text(body)
    assert b'"code": "answer_release_restricted"' not in body, (
        f"an ordinary document explanation must not be treated as a withheld exercise answer: {body!r}"
    )
    assert "ESE" in rendered and "ASE" in rendered, "the actual explanation must reach the student"
    assert "withholding the final result" not in rendered


# ---------------------------------------------------------------------------
# Test 2 -- multiple document sections in one explanation request.
# ---------------------------------------------------------------------------

def test_explain_multiple_specializations_is_not_treated_as_restricted_exercises(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_curriculum_document(monkeypatch)
    draft = (
        "There are three specialization tracks: Electronics Systems Engineering (ESE), "
        "focused on power electronics and embedded systems; Space & Avionics Systems "
        "Electronics (SAS), focused on avionics and satellite communication; and "
        "Automotive Systems Engineering (ASE), focused on vehicle electronics and sensing."
    )
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text=draft)
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="explain the specialization options in this document",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rendered = base._rendered_text(body)
    assert b'"code": "answer_release_restricted"' not in body
    assert "ESE" in rendered and "SAS" in rendered and "ASE" in rendered


# ---------------------------------------------------------------------------
# Test 3 -- whole-document explanation.
# ---------------------------------------------------------------------------

def test_explain_this_entire_document_in_detail_is_not_withheld(monkeypatch):
    """"explain this entire document in detail" resolves (confirmed via
    direct tracing) to app/routers/stream.py's SEPARATE, pre-existing
    full_document/synthesis pipeline -- an orthogonal mechanism (needs an
    explicit, confirmed document-scope selection before it will actually
    process pages; FULL_DOCUMENT_SCOPE_REQUIRED is its own legitimate,
    pre-existing clarification, matching this very task's own instruction
    not to force every request into whole-document summarization) that
    this fix does not touch and does not need to fully exercise end-to-end.
    What belongs in THIS suite is only the one thing that pipeline shares
    with the bug being fixed: it must never be misrouted into the
    exercise-answer-withholding gate."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_curriculum_document(monkeypatch)
    draft = (
        "This is the module handbook for the Electronic Systems program. It defines the "
        "compulsory modules and three elective specializations (ESE, SAS, ASE), each "
        "requiring a minimum of four modules and 30 ECTS credits."
    )
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text=draft)
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="explain this entire document in detail",
            document_ids=[doc_id],
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' not in body
    assert b"withholding the final result" not in body


# ---------------------------------------------------------------------------
# Test 4 -- follow-up question, same document context.
# ---------------------------------------------------------------------------

def test_document_followup_question_preserves_context_without_exercise_restriction(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_curriculum_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="This handbook covers ESE, SAS, and ASE, each a 30-ECTS specialization.",
    )
    try:
        body1 = asyncio.run(_ask_with_page(stream, document_id=doc_id, question="explain this to me"))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    previous = [
        {"role": "user", "text": "explain this to me"},
        {"role": "assistant", "text": base._rendered_text(body1)},
    ]

    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The ESE track focuses on power electronics and embedded systems, 30 ECTS total.",
    )
    try:
        body2 = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="what about the ESE modules?",
            generation=2, previous_turns=previous,
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rendered2 = base._rendered_text(body2)
    assert b'"code": "answer_release_restricted"' not in body2
    assert "ESE" in rendered2


# ---------------------------------------------------------------------------
# Test 5/6 -- non-regression: genuine exercise hint/full-solution protection
# on a REAL exercise document must be completely unaffected by this fix
# (objective="hint"/"solve" are not in _OBJECTIVES_WITHOUT_EXERCISE_IDENTITY).
# ---------------------------------------------------------------------------

def test_genuine_hint_protection_on_a_real_exercise_is_unaffected(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    intent_json = base._fake_intent_response(
        "hint", "1",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "method", "form": "hint", "wait_for_student": None},
    )
    base._install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text="Think about taking moments about support A first.",
    )
    try:
        body = asyncio.run(base._ask(
            stream, document_id=DOC_MECH1, question="give me a hint but don't reveal the final answer",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert "75 N" not in base._rendered_text(body)


def test_genuine_full_solution_on_a_real_exercise_is_unaffected(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The final answer is R_A = 75 N, R_B = 25 N.",
    )
    try:
        body = asyncio.run(base._ask(
            stream, document_id=DOC_MECH1,
            question="Solve exercise 1 completely, show me both reaction forces.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b"75 N" in body and b"25 N" in body
    assert b'"code": "answer_release_restricted"' not in body


# ---------------------------------------------------------------------------
# Test 8 -- conversation-topic transition: a restriction from an earlier,
# unrelated exercise must not contaminate a later document-explanation
# request in the SAME conversation.
# ---------------------------------------------------------------------------

def test_switching_from_a_restricted_exercise_to_an_unrelated_document_drops_the_old_restriction(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    rows = base._install_persisted_history(monkeypatch)
    conv = "doc-explain-topic-switch"

    from app.services import semantic_intent_orchestrator
    real_interpret = semantic_intent_orchestrator.interpret_turn_authoritatively
    captured_policies: list[dict] = []

    def spy_interpret(**kwargs):
        result = real_interpret(**kwargs)
        captured_policies.append(result.compiled_policy_by_target)
        return result
    monkeypatch.setattr(semantic_intent_orchestrator, "interpret_turn_authoritatively", spy_interpret)

    # Turn 1: a genuinely restricted exercise hint.
    intent_t1 = base._fake_intent_response(
        "hint", "1",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "method", "form": "hint", "wait_for_student": None},
    )
    base._install_capturing_transport(
        monkeypatch, intent_response_json=intent_t1,
        draft_text="Think about taking moments about support A first.",
    )
    try:
        body1 = asyncio.run(base._ask(
            stream, document_id=DOC_MECH1, question="give me a hint for exercise 1",
            conversation_id=conv, generation=1,
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rows[conv] = [{
        "client_message_id": "t1",
        "request_snapshot": {"policyByTarget": captured_policies[-1]},
    }]
    previous = [
        {"role": "user", "text": "give me a hint for exercise 1"},
        {"role": "assistant", "text": base._rendered_text(body1)},
    ]

    # Turn 2: unrelated topic switch to the curriculum document.
    doc_id = _install_curriculum_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="This handbook covers ESE, SAS, and ASE, each a 30-ECTS specialization.",
    )
    try:
        body2 = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="explain this to me",
            conversation_id=conv, generation=2, previous_turns=previous,
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rendered2 = base._rendered_text(body2)
    assert b'"code": "answer_release_restricted"' not in body2, (
        "an earlier, unrelated exercise's hint-only restriction must not contaminate "
        "a later, unrelated document-explanation request in the same conversation"
    )
    assert "ESE" in rendered2
