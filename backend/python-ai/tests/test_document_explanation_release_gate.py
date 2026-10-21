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
(trusted, no exercise-identity verification required) whenever EITHER (a)
its objective has no exercise-answer-disclosure concept at all --
"explain", "define", "compare", "summarize", "translate" -- or (b) the
student has real, visible page/document context open (the same signal
``student_intent.py``'s own ``references_unresolved`` and
``reference_resolution.decide_evidence`` already require, upstream,
before this function ever runs) -- regardless of whether a numbered
exercise label resolved.

Follow-up correction (2026-10-21, same day): a missing numbered label
does not mean "nobody knows what this request is about" when the
student is actually looking at a specific, real, singular exercise --
only when there is no numbered label AND no real context either. So an
answer-BEARING objective ("solve"/"hint"/etc.) on a genuine, unnumbered
exercise with real page context open is ALSO now "requested" -- an
explicit restriction in the same turn ("don't reveal the final result")
still wins regardless (an explicit release value always survives
compile_policy's fallback, with or without this fix), and so does an
explicit permission ("give me the full solution") now that state isn't
forced to "unresolved" just because there is no number. A merely CLAIMED
target string from an unverified model (the semantic/escalated path) and
a stale cross-turn active_question on a genuinely new, unrelated topic
are both UNCHANGED -- neither gets any new trust from this.

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
    document_ids=None, durable=False, client_message_id=None, assistant_message_id=None,
    request_id=None,
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
    suite targets).

    ``durable=True`` sets ``durableConversation`` -- the ONLY way stream.py
    actually threads ``conversation_id`` into ``interpret_turn_
    authoritatively`` (see its own ``payload.conversationId if payload.
    durableConversation else None``), i.e. the only way to exercise the
    REAL cross-turn persisted-policy merge this suite's generic-target-
    placeholder test needs -- the shape the production chatbot actually
    sends (frontend/js/features/chatbot-new/shell.ts passes durableConversation
    = true on its one real streamFromAskStream call site). Requires
    _install_persisted_history's conversation_store mocks AND conversation_
    store.update_tutor_request mocked (see test below) -- otherwise this
    hits a real, unmocked DB call."""
    payload = stream.AskStreamRequest(
        courseId="course-1", activeDocumentId=document_id, documentIds=document_ids,
        question=question, sourceMode="course_files", conversationId=conversation_id,
        conversationGeneration=generation, previousTurns=previous_turns or [],
        visiblePage=1, openFileContext=visible_page_text,
        durableConversation=durable, clientMessageId=client_message_id,
        assistantMessageId=assistant_message_id, requestId=request_id,
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


# ---------------------------------------------------------------------------
# Test 9 -- generic target-identity collision (2026-10-21, same-day
# follow-up verification): Test 8 above proves restriction isolation
# across turns with DISTINCT real target labels ("1" vs "current_request"
# -- never the same key, so never at risk of this). It does NOT exercise
# cross-turn PERSISTENCE at all, since it never sets durableConversation
# (confirmed by reading app/routers/stream.py directly: conversation_id is
# only ever threaded into interpret_turn_authoritatively "if payload.
# durableConversation", the default being False -- the actual, real
# production chatbot always sends True, per frontend/js/features/
# chatbot-new/shell.ts's one streamFromAskStream call site).
#
# With durableConversation genuinely enabled, a SECOND, distinct risk
# exists that Test 8 cannot see: TWO DIFFERENT, UNRELATED unnumbered
# requests in the SAME durable conversation both resolve to the exact
# same generic placeholder target string ("current_request" --
# diagnostic_policy.adapt_deterministic_intent's own explicit fallback
# when no label resolves) -- found and confirmed by direct reproduction
# against the real orchestrator before this test existed. semantic_
# intent_orchestrator._merge_persisted_history looked up/replayed
# persisted history BY THAT LITERAL STRING, so an earlier turn's
# restriction (for an unrelated unnumbered exercise) was replayed into a
# later, unrelated turn purely because both share the placeholder --
# never a real target identity collision, since the placeholder means
# "no identity resolved" by definition. Fixed by excluding
# GENERIC_TARGET_PLACEHOLDERS from both sides of that lookup.
# ---------------------------------------------------------------------------

def test_generic_current_request_placeholder_does_not_carry_restrictions_across_turns(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    rows = base._install_persisted_history(monkeypatch)
    from app.services import conversation_store, semantic_intent_orchestrator
    monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_k: None)
    real_interpret = semantic_intent_orchestrator.interpret_turn_authoritatively
    captured_policies: list[dict] = []
    captured_actions: list[tuple] = []

    def spy_interpret(**kwargs):
        result = real_interpret(**kwargs)
        captured_policies.append(result.compiled_policy_by_target)
        captured_actions.append(result.execution_policy.actions)
        return result
    monkeypatch.setattr(semantic_intent_orchestrator, "interpret_turn_authoritatively", spy_interpret)

    conv = "doc-explain-generic-target-collision"

    # Turn 1: a genuinely restricted, UNNUMBERED exercise (no label to
    # resolve -> target lands on the generic "current_request" placeholder,
    # same as turn 2 below) with durableConversation genuinely enabled.
    exercise_doc_id = _install_unnumbered_exercise_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="Think about taking moments about support A first.",
    )
    try:
        body1 = asyncio.run(_ask_with_page(
            stream, document_id=exercise_doc_id,
            question="Give me a hint for this, but don't reveal the final result.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id=conv, generation=1, durable=True,
            client_message_id="gc-t1-user", assistant_message_id="gc-t1-assistant",
            request_id="gc-t1-request-0001",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rows[conv] = [{
        "client_message_id": "gc-t1-assistant",
        "request_snapshot": {"policyByTarget": captured_policies[-1]},
    }]
    assert "current_request" in captured_policies[-1], (
        f"turn 1 must have persisted its restriction under the generic placeholder "
        f"for this test to actually exercise the collision it targets: {captured_policies[-1]!r}"
    )
    previous = [
        {"role": "user", "text": "Give me a hint for this, but don't reveal the final result."},
        {"role": "assistant", "text": base._rendered_text(body1)},
    ]

    # Turn 2: a COMPLETELY UNRELATED, ordinary, unnumbered document
    # explanation -- same conversation, still durableConversation=True,
    # also lands on target="current_request" (no label here either). Must
    # NOT inherit turn 1's restriction just because the placeholder matches.
    # Draft is deliberately the same "Therefore X = Y" leak shape Test 1
    # uses: a scan-conditioned single-target gate only visibly withholds
    # when the draft ALSO happens to match a leak pattern, so a leak-free
    # draft would pass even with a silently contaminated policy
    # (final_answer wrongly "prohibited") -- confirmed directly: this
    # exact test, with a leak-free draft and the fix reverted, still
    # "passed" while the captured policy was already contaminated. The
    # explicit policy-level assertion right after this call is the one
    # that actually proves the root cause is fixed; this SSE-level
    # assertion proves the realistic user-visible consequence is too.
    doc_id = _install_curriculum_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text=(
            "This handbook describes three specializations: ESE, SAS, and ASE. "
            "Therefore ESE = 30 ECTS, SAS = 30 ECTS, and ASE = 30 ECTS, each "
            "requiring at least four modules."
        ),
    )
    try:
        body2 = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="explain this to me",
            conversation_id=conv, generation=2, previous_turns=previous, durable=True,
            client_message_id="gc-t2-user", assistant_message_id="gc-t2-assistant",
            request_id="gc-t2-request-0002",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    turn2_actions = {a.target: a for a in captured_actions[-1]}
    assert turn2_actions["current_request"].release.final_answer != "prohibited", (
        "turn 2's compiled policy must not inherit turn 1's unrelated restriction "
        "just because both share the generic current_request placeholder target"
    )
    rendered2 = base._rendered_text(body2)
    assert b'"code": "answer_release_restricted"' not in body2, (
        "an earlier, unrelated unnumbered exercise's restriction must not leak into a "
        "later, unrelated document explanation just because both share the generic "
        "current_request placeholder"
    )
    assert "ESE" in rendered2


# ---------------------------------------------------------------------------
# Boundary case (2026-10-21, same-day follow-up): an unnumbered exercise is
# still an exercise. The explain/define/... exemption above must not become
# a general "no number means no restriction" loophole for answer-bearing
# objectives too.
# ---------------------------------------------------------------------------

UNNUMBERED_EXERCISE_TEXT = (
    "A beam is loaded with a point force at its midpoint. The beam is "
    "supported at both ends. Find the reaction force at support A. "
    "Lösung: R_A = 75 N."
)


def _install_unnumbered_exercise_document(monkeypatch):
    """A genuine exercise with no exercise NUMBER printed anywhere in it
    (unlike DOC_MECH1's "Aufgabe 1" style labels) -- the shape that must
    stay fully protected despite this suite's fix, since it IS an actual
    exercise with a protected result, just an unnumbered one."""
    import app.routers.stream as stream_mod

    doc_id = str(uuid.uuid4())
    chunk = retrieval.RetrievedChunk(
        chunk_id="c-unnumbered", document_id=doc_id, page_start=1, page_end=1,
        text=UNNUMBERED_EXERCISE_TEXT, score=1.0, similarity=1.0,
        chunk_type="exercise", section_title="Statics problem",
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
            "file_name": "unnumbered_exercise.pdf", "storage_path": "synthetic/unnumbered_exercise.pdf",
            "document_hash": "rev-1", "processing_status": "ready",
            "page_count": 1, "chunk_count": 1,
        },
    })
    return doc_id


def test_plain_explain_on_an_unnumbered_exercise_gets_a_real_explanation(monkeypatch):
    """"Explain this to me." (no "don't", no restriction at all) on a
    genuine but UNNUMBERED exercise must get a real, useful teaching
    response -- never withheld, never a generic refusal -- exactly like
    the equivalent request on an ordinary document."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_unnumbered_exercise_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text=(
            "Start by isolating the beam and identifying the two support reactions. "
            "Since the load is applied at the midpoint and both supports are simple "
            "pin/roller supports, take moments about one support to solve for the other."
        ),
    )
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="Explain this to me.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id="doc-explain-unnumbered-plain",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rendered = base._rendered_text(body)
    assert b'"code": "answer_release_restricted"' not in body
    assert "withholding the final result" not in rendered
    assert "moments" in rendered


def test_plain_explain_on_an_unnumbered_exercise_does_not_volunteer_the_result(monkeypatch):
    """Companion to the test above: the SAME request ("explain this to
    me", no restriction, no permission) on the SAME unnumbered exercise,
    but the model's draft volunteers the protected final value anyway,
    unprompted. Must still be withheld.

    Root cause (2026-10-21, same-day follow-up): compile_policy's
    explain_objective_fallback (closes final_answer for an "explain"
    request, added for the AB-02/AB-03 live-eval leak) only applies when
    the target identifies a RESOLVED exercise label -- by design, so a
    merely unnumbered exercise's target (the same generic "current_
    request" placeholder an ORDINARY document explanation also resolves
    to) compiles final_answer="permitted" by the ordinary tutoring
    default, and the value-grounded release-gate backstop was, in turn,
    gated on final_answer already being restricted -- so this exact
    shape had NO protection of any kind.

    Fixed in answer_release_validator.py (not policy_compiler.py):
    final_answer itself is deliberately left "permitted" here (changing
    the compiled policy would risk re-closing it for ordinary document
    explanations too, since both share the same placeholder target --
    exactly the 2026-10-20 bug this module exists to fix). Instead, the
    value-grounded backstop's own gate (scan_generated_answer_for_
    prohibited_release -> _has_unverified_explain_disclosure) now also
    runs for this exact combination (objective="explain", target is the
    generic placeholder, final_answer not explicitly prohibited) --
    content-grounded, not label-grounded: it only ever matches evidence
    that already contains a labeled "Lösung:"/"Solution:" value, so an
    ordinary document (no such label anywhere) is never affected
    (test_plain_explain_on_an_unnumbered_exercise_gets_a_real_
    explanation above and test_explain_this_to_me_on_a_non_exercise_
    document_is_not_withheld both still pass unchanged)."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_unnumbered_exercise_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text=(
            "Take moments about support A: the reaction force works out to R_A = 75 N."
        ),
    )
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id, question="Explain this to me.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id="doc-explain-unnumbered-plain-leak",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' in body, (
        f"a voluntary, unprompted disclosure of the protected value must still be "
        f"caught even though final_answer defaults to permitted for this shape: {body!r}"
    )
    assert "75 N" not in base._rendered_text(body)


def test_explicit_hint_protection_survives_without_a_numbered_label(monkeypatch):
    """"Explain this to me, but don't reveal the final result." on a real,
    unnumbered exercise must still withhold the protected value -- the
    explicit restriction wins regardless of whether escalation's model
    call succeeds or fails; this covers the failure/deterministic-
    fallback path (intent_response_json=None -> invalid escalation
    response -> AB-02 fallback-weakness fix's own existing most-
    restrictive degrade). The draft is deliberately answer-bearing (the
    guard's whole job is to catch exactly this) so the assertion proves
    the withholding guard actually intercepted it, not merely that a
    leak-free draft happened not to contain the number."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_unnumbered_exercise_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The approach is to take moments about support A. The reaction force is R_A = 75 N.",
    )
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id,
            question="Explain this to me, but don't reveal the final result.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id="doc-explain-hint-fallback",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' in body, (
        f"an answer-bearing draft must be caught and withheld by the release gate: {body!r}"
    )
    assert "75 N" not in base._rendered_text(body)


def test_explicit_hint_protection_survives_via_successful_escalation(monkeypatch):
    """Same restriction, but through a VALID, successful semantic-
    escalation response (the realistic production path for a message
    containing "don't", which does trigger escalation) -- an explicit
    final_answer="prohibited" the model itself returns must survive
    regardless of this suite's has_visible_context trust extension,
    exactly as it already did before this fix (compile_policy only ever
    fills UNSET fields from a fallback; an explicitly-set one is never
    touched). Answer-bearing draft, same reason as the fallback-path
    sibling test above: proves the guard actually intercepts a leak,
    not just that a leak-free draft happened not to contain the number."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_unnumbered_exercise_document(monkeypatch)
    intent_json = base._fake_intent_response(
        "explain", "current_request",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "method", "form": "explanation", "wait_for_student": None},
    )
    base._install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text="The approach is to take moments about support A. The reaction force is R_A = 75 N.",
    )
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id,
            question="Explain this to me, but don't reveal the final result.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id="doc-explain-hint-escalation",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' in body, (
        f"an answer-bearing draft must be caught and withheld by the release gate: {body!r}"
    )
    assert "75 N" not in base._rendered_text(body)


def test_explicit_full_solution_permitted_without_a_numbered_label(monkeypatch):
    """The complementary case: an explicit full-solution request on the
    SAME unnumbered exercise must be honored, not blocked just because
    there is no exercise number -- confirmed regression before this
    follow-up fix (has_visible_context now also grants "requested" for
    answer-bearing objectives, not only explain/define/compare/
    summarize/translate)."""
    stream, _ = base._setup(monkeypatch)
    doc_id = _install_unnumbered_exercise_document(monkeypatch)
    base._install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The final answer is R_A = 75 N.",
    )
    try:
        body = asyncio.run(_ask_with_page(
            stream, document_id=doc_id,
            question="Please solve this completely and show me the final answer.",
            visible_page_text=UNNUMBERED_EXERCISE_TEXT,
            conversation_id="doc-explain-full-solution",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b"75 N" in body
    assert b'"code": "answer_release_restricted"' not in body
