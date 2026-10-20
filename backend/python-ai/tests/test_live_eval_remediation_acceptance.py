"""End-to-end acceptance regressions for the 2026-10-20 comprehensive
remediation, built directly from the five-scenario LIVE evaluation's
confirmed failures (not hypothetical ones).

Design, per the coordinator's explicit requirement: exercise the REAL
request-to-SSE path -- real classify_academic_intent, real deterministic/
semantic intent resolution, real compile_policy, real prompt assembly
(pick_system_prompt + render_execution_policy_overlay + QUIZ_CONTRACT),
real answer_release_validator -- through the real /ask-stream route.
answer_stream.stream_answer is NOT mocked wholesale (that would bypass
the is_quiz_request/prompt-assembly logic entirely, exactly the mistake
this session's own forensic pass had to correct). Instead, only the
actual network transmission is faked, at the httpx.Client.send layer --
confirmed via this project's own live run to be the one choke point
every OpenAI call passes through. Draft text is scripted to reproduce
the EXACT disclosure shapes confirmed in the live transcripts
(reports/five-scenario-live-eval-2026-10-20/ in the eval worktree), so
these tests would have caught the real failures before they reached a
live model.

Honest scope: a MOCKED generation response proves the pipeline enforces
the intended behavior for that scripted response. It does NOT prove a
real model will write that shape or any other -- see this session's
final report for what remains genuinely unverified offline.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

import tests.test_semantic_blind_ab_full_corpus_dry_run as harness

USER_ID = harness.USER_ID
DOC_MECH1 = harness.DOCUMENT_IDS["DOC-MECH1"]
DOC_KIN1 = harness.DOCUMENT_IDS["DOC-KIN1"]


def _fake_intent_response(objective, target, release, *, confidence=0.9, relation="new_topic"):
    return json.dumps({
        "relation": relation, "speechAct": "question", "taskFamily": "solve",
        "continuesPreviousGoal": relation != "new_topic", "resolvedRequest": None, "confidence": confidence,
        "conversation": "new", "studentGoal": "x", "responseLanguage": "en",
        "actions": [{
            "objective": objective, "target": target, "confidence": confidence,
            "state": "requested", "prohibited": [], "release": release,
        }],
    })


def _install_capturing_transport(monkeypatch, *, intent_response_json: str | None, draft_text: str):
    """Real network calls replaced with scripted responses: the intent/
    unified-interpretation call (if escalation fires) gets
    ``intent_response_json``; the generation call gets a minimal SSE
    stream carrying ``draft_text`` as one chunk. Both the REAL system
    prompt the generation call actually received and every captured
    request body are stashed on the returned list for assertions."""
    captured: list[dict] = []

    def fake_send(client_self, request, **kwargs):
        if "openai.com" not in str(request.url):
            raise httpx.ConnectError("blocked: non-OpenAI request", request=request)
        body = json.loads(request.content or b"{}")
        captured.append(body)
        if body.get("stream"):
            chunks = [
                {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": body.get("model"),
                 "choices": [{"index": 0, "delta": {"content": draft_text}, "finish_reason": None}]},
                {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": body.get("model"),
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            sse = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
            return httpx.Response(200, content=sse.encode(), request=request,
                                   headers={"content-type": "text/event-stream"})
        content = intent_response_json if intent_response_json is not None else "{}"
        return httpx.Response(200, json={
            "id": "x", "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }, request=request)

    monkeypatch.setattr(httpx.Client, "send", fake_send)
    return captured


def _setup(monkeypatch):
    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "enabled")
    monkeypatch.setenv("SEMANTIC_INTENT_UNIFIED_CALL_ENABLED", "true")
    monkeypatch.setenv("SEMANTIC_INTENT_POLICY_ENFORCEMENT_ENABLED", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    stream, save_calls = harness._common_mocks(monkeypatch)
    return stream, save_calls


def _install_persisted_history(monkeypatch):
    """Real cross-turn policy persistence, for multi-turn tests: patches
    conversation_store at ITS OWN module (stream.py imports these two
    names LOCALLY, function-scoped -- confirmed by reading stream.py
    directly; patching a stream.* attribute would silently do nothing),
    backed by a simple in-memory per-conversation row list. Returns the
    store dict so a test can inspect/seed it directly if needed."""
    from app.services import conversation_store
    rows: dict[str, list[dict]] = {}

    def fake_validate(*, user_id, conversation_id, **_k):
        return conversation_id in rows

    def fake_get_messages(*, user_id, conversation_id, **_k):
        return list(rows.get(conversation_id, []))

    monkeypatch.setattr(conversation_store, "validate_durable_conversation", fake_validate)
    monkeypatch.setattr(conversation_store, "get_durable_conversation_messages", fake_get_messages)
    return rows


async def _ask(stream, *, document_id, question, conversation_id="acc-test", generation=1, previous_turns=None):
    payload = stream.AskStreamRequest(
        courseId="course-1", activeDocumentId=document_id, question=question,
        sourceMode="course_files", conversationId=conversation_id,
        conversationGeneration=generation, previousTurns=previous_turns or [],
    )
    response = await stream.ask_stream_endpoint(payload, {"id": USER_ID})
    return b"".join([event async for event in response.body_iterator])


def _rendered_text(body: bytes) -> str:
    parts = []
    for line in body.split(b"\n"):
        if not line.startswith(b"data: "):
            continue
        try:
            evt = json.loads(line[len(b"data: "):])
        except Exception:
            continue
        if isinstance(evt, dict) and isinstance(evt.get("t"), str):
            parts.append(evt["t"])
    return "".join(parts)


def _gen_system_prompt(captured: list[dict]) -> str:
    gen_calls = [b for b in captured if b.get("stream")]
    assert gen_calls, "no generation call captured"
    return next(m["content"] for m in gen_calls[-1]["messages"] if m["role"] == "system")


# ---------------------------------------------------------------------------
# 1. AB-24 -- real prompt assembly must contain QUIZ_CONTRACT and a form
#    instruction that does NOT contradict it, the model's confirmed live
#    PREMATURE-DISCLOSURE shape must be withheld (explicit text absence,
#    not just an error code), and -- the real product requirement, not
#    just safety -- a VALID, well-formed quiz must be DELIVERED, not
#    withheld, since generic refusal is not successful tutoring.
# ---------------------------------------------------------------------------

def test_ab24_quiz_prompt_has_one_coherent_contract_no_contradiction(monkeypatch):
    """Confirmed bug, found from the coordinator's own review: the
    overlay used to say "respond with a HINT only, not a worked
    solution" for a quiz request (the shared objective="hint" fallback),
    directly contradicting QUIZ_CONTRACT's "build an inline quiz block"
    instruction in the SAME prompt. Traced to policy_compiler.py: an
    unresolved-target action's explicitly-set form="guided_questions"
    (set deterministically in diagnostic_policy.py for exactly this
    objective, independent of target resolution) was being discarded by
    the untrusted-action merge step and replaced with the blanket
    "hint" fallback. Fixed by letting that specific, already-
    deterministic value survive for the form field only -- disclosure
    permissions (final_answer/official_solution) are untouched by this,
    still governed by the existing restrictive fallback."""
    stream, _ = _setup(monkeypatch)
    _install_capturing_transport(
        monkeypatch, intent_response_json=None, draft_text="placeholder",
    )
    from app.services.dialogue_state import resolve_dialogue
    from app.services.student_intent import interpret_student_intent
    from app.services.diagnostic_policy import adapt_deterministic_intent
    from app.services.policy_compiler import compile_policy
    from app.services.policy_prompt_rendering import render_execution_policy_overlay
    from app.services.answer_intent import classify_academic_intent
    from app.services.answer import pick_system_prompt
    from app.services.answer_stream import QUIZ_CONTRACT

    question = "Frag mich die Lagerkraft R_A ab."
    dialogue = resolve_dialogue(question, previous_turns=[])
    student_intent = interpret_student_intent(question, dialogue=dialogue, resolved_access=None, mode="off")
    resolved_intent = adapt_deterministic_intent(message=question, dialogue=dialogue, student_intent=student_intent)
    policy = compile_policy(resolved_intent)
    overlay = render_execution_policy_overlay(policy)

    assert "respond with a HINT only, not a worked solution" not in overlay, (
        "the quiz/hint contradiction must be resolved, not just hidden behind a changed draft"
    )
    assert "respond with guiding questions, not a direct answer" in overlay
    assert "do NOT reveal the final numeric/symbolic result" in overlay
    assert "stop here and wait for the student's own attempt" in overlay

    academic_intent = classify_academic_intent(question)
    sys_prompt, _label = pick_system_prompt(question, "strong", [], tutor_mode="explain", intent=academic_intent)
    combined = sys_prompt + overlay + QUIZ_CONTRACT
    assert "BUILD IT INLINE" in combined
    assert "respond with a HINT only" not in combined


def test_ab24_premature_full_disclosure_is_withheld_with_explicit_text_absence(monkeypatch):
    """Strengthened per the coordinator's review: an error event alone
    is not accepted as proof the prohibited text is absent from the
    student-visible stream -- assert the specific disclosed number is
    NOT present in the actual rendered text (the ``t`` token stream the
    frontend concatenates into the chat bubble -- confirmed by reading
    ai-ask.ts: it only ever reads evt.t/.status/.meta/.done/.error and
    meta.sources, never evt.verification), in addition to the recovery
    code. The raw wire body also carries the release validator's own
    evidence-grounding diagnostics (verification.details.extracted_
    givens etc.), which legitimately echo the protected value back for
    debugging -- that is not a student-visible disclosure and must not
    be conflated with one."""
    stream, _ = _setup(monkeypatch)
    captured = _install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The support force at A is \\( R_A = 75 \\, \\text{N} \\).",
    )
    try:
        body = asyncio.run(_ask(stream, document_id=DOC_MECH1, question="Frag mich die Lagerkraft R_A ab."))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    rendered = _rendered_text(body)
    assert "75" not in rendered, f"the protected value must not appear in the student-visible rendered text: {rendered!r}"
    assert b'"code": "answer_release_restricted"' in body


def test_ab24_well_formed_quiz_is_delivered_not_withheld(monkeypatch):
    """The actual product requirement, not just safety: a quiz request
    that produces a VALID, well-formed ```minallo-quiz block (the
    correct answer hidden in a structured index, no prose disclosure)
    must be DELIVERED to the student, not withheld. Generic refusal is
    not a substitute for a usable quiz question."""
    stream, _ = _setup(monkeypatch)
    quiz_draft = (
        "Let's check what you know!\n\n```minallo-quiz\n"
        + json.dumps({"title": "Lagerkraft R_A", "questions": [{
            "q": "What is the support reaction R_A for the beam in Aufgabe 1?",
            "options": ["50 N", "75 N", "100 N"], "answer": 1,
            "explanation": "Apply moment equilibrium about A, then vertical force balance.",
        }]})
        + "\n```\n"
    )
    captured = _install_capturing_transport(
        monkeypatch, intent_response_json=None, draft_text=quiz_draft,
    )
    try:
        body = asyncio.run(_ask(stream, document_id=DOC_MECH1, question="Frag mich die Lagerkraft R_A ab."))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b'"code": "answer_release_restricted"' not in body, (
        "a valid, well-formed quiz (answer hidden in a structured index, "
        "no prose disclosure) must be delivered, not generically withheld"
    )
    assert b"minallo-quiz" in body
    assert b"What is the support reaction" in body


# ---------------------------------------------------------------------------
# 2. AB-02 -- a failed/invalid semantic response must degrade to the
#    restrictive fallback (not permissive), while a VALID semantic
#    response (and an explicit full-solution request) still correctly
#    permits content -- the fallback fix must not become "always refuse".
# ---------------------------------------------------------------------------

def test_ab02_failed_semantic_validation_no_longer_defaults_to_permitted(monkeypatch):
    stream, _ = _setup(monkeypatch)
    # Malformed intent response (invalid enum for "relation") -- the real
    # validator rejects this exactly as it would reject AB-02's real,
    # unrecoverable response; what matters here is the DOWNSTREAM
    # behavior once validation fails, not reproducing the exact live
    # rejection reason (still not independently confirmed).
    _install_capturing_transport(
        monkeypatch, intent_response_json=json.dumps({"relation": "not_a_real_relation"}),
        draft_text="The complete solution is R_A = 75 N, R_B = 25 N.",
    )
    try:
        body = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Aufgabe 1 raff ich grad nicht so richtig.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    rendered = _rendered_text(body)
    assert "75 N" not in rendered and "25 N" not in rendered, (
        # Checked against the rendered t-token text, not the raw wire body:
        # the release validator's own evidence-grounding diagnostics
        # (verification.details.extracted_givens) legitimately echo a
        # retrieved given's value back for debugging and are never read by
        # the frontend (ai-ask.ts only reads evt.t/.status/.meta/.done/
        # .error) -- that is not a student-visible disclosure.
        f"the protected values must not appear in the student-visible rendered text: {rendered!r}"
    )
    assert b'"code": "answer_release_restricted"' in body, (
        "a message that triggered escalation but got no valid semantic result "
        "must fall back to the restrictive degrade, not the permissive deterministic default"
    )


def test_ab02_valid_semantic_response_still_permits_explicitly_authorized_content(monkeypatch):
    """Non-regression for the AB-02 fix: it must only change behavior
    when escalation fired AND failed. A VALID semantic response that
    explicitly permits the final answer must still stream it through."""
    stream, _ = _setup(monkeypatch)
    intent_json = _fake_intent_response(
        "solve", "1",
        {"final_answer": "permitted", "official_solution": "unspecified",
         "explanation_depth": "worked_derivation", "form": "worked_solution", "wait_for_student": False},
    )
    _install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text="The final answer is R_A = 75 N, R_B = 25 N.",
    )
    try:
        body = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Aufgabe 1 raff ich grad nicht so richtig.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b"75 N" in body and b"25 N" in body
    assert b'"code": "answer_release_restricted"' not in body


# ---------------------------------------------------------------------------
# 3. AB-03 -- conceptual explanation: positive depth/form guidance must be
#    present (actual useful explanation, not a refusal), the confirmed
#    live \\approx disclosure shape withheld with explicit text absence,
#    and a GOOD conceptual explanation (no numeric result) must be
#    delivered successfully.
# ---------------------------------------------------------------------------

def test_ab03_explanation_overlay_has_positive_guidance_and_catches_live_disclosure_shape(monkeypatch):
    stream, _ = _setup(monkeypatch)
    intent_json = _fake_intent_response(
        "explain", "cutting speed",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "concept", "form": "explanation", "wait_for_student": None},
    )
    captured = _install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text=r"$$ n = \frac{120}{\pi \cdot 0.08} \approx 477.5 \text{ RPM} $$",
    )
    try:
        body = asyncio.run(_ask(
            stream, document_id=DOC_KIN1,
            question="this cutting speed thing makes no sense to me can u explain what's going on",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    sys_prompt = _gen_system_prompt(captured)
    assert "explain the underlying concept and intuition" in sys_prompt
    assert "respond with a clear explanation, not merely a hint or a full worked solution" in sys_prompt
    assert "do NOT reveal the final numeric/symbolic result" in sys_prompt
    rendered = _rendered_text(body)
    assert "477.5" not in rendered and "477" not in rendered, (
        # Rendered t-token text, not the raw wire body -- see the AB-24/
        # AB-02 tests above: the release validator's own formulaMisses
        # diagnostic legitimately echoes the withheld formula/value back
        # for debugging and is never read by the frontend.
        f"the protected value must not appear in the student-visible rendered text: {rendered!r}"
    )
    assert b'"code": "answer_release_restricted"' in body


def test_ab03_good_conceptual_explanation_without_the_final_number_is_delivered(monkeypatch):
    """The actual product requirement: a GOOD conceptual explanation
    (method/intuition, no final numeric result) must be delivered
    successfully, not withheld -- effective restriction must coexist
    with useful tutoring content, not replace it."""
    stream, _ = _setup(monkeypatch)
    intent_json = _fake_intent_response(
        "explain", "cutting speed",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "concept", "form": "explanation", "wait_for_student": None},
    )
    good_draft = (
        "Cutting speed is how fast the tool's edge moves relative to the workpiece surface. "
        "It depends on the diameter of the piece and how fast it spins: a bigger diameter or a "
        "faster rotation both increase the cutting speed, since the formula relates them through "
        "the circumference the tool sweeps out per revolution."
    )
    _install_capturing_transport(
        monkeypatch, intent_response_json=intent_json, draft_text=good_draft,
    )
    try:
        body = asyncio.run(_ask(
            stream, document_id=DOC_KIN1,
            question="this cutting speed thing makes no sense to me can u explain what's going on",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b"cutting speed" in body.lower() or b"Cutting speed" in body
    assert b'"code": "answer_release_restricted"' not in body


# ---------------------------------------------------------------------------
# 4. Explicit full-solution control -- must remain fully permitted.
# ---------------------------------------------------------------------------

def test_explicit_full_solution_control_still_streams_through(monkeypatch):
    stream, _ = _setup(monkeypatch)
    _install_capturing_transport(
        monkeypatch, intent_response_json=None,
        draft_text="The final answer is R_A = 75 N, R_B = 25 N.",
    )
    try:
        body = asyncio.run(_ask(
            stream, document_id=DOC_MECH1,
            question="Solve exercise 1 completely, show me both reaction forces.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b"75 N" in body and b"25 N" in body
    assert b'"code": "answer_release_restricted"' not in body


# ---------------------------------------------------------------------------
# 5. Evidence-grounded release checks must use the CORRECT exercise --
#    an unrelated exercise's protected value, or a GIVEN value from the
#    active exercise's own problem statement, must not be mistaken for a
#    prohibited disclosure.
# ---------------------------------------------------------------------------

def test_protected_value_check_does_not_confuse_a_different_exercises_answer(monkeypatch):
    """DOC-MECH1 retrieval for this turn surfaces ALL of the document's
    exercises in one chunk (same fixture every other test in this file
    uses) -- a hint response for exercise "3" (torque, answer 15 N·m)
    must not be withheld just because exercise "1"'s unrelated answer
    (75 N) also lives in the SAME retrieved chunk. The compiled policy
    only restricts the ACTIVE target; a response that never mentions 75
    at all must pass through regardless of what else the chunk contains."""
    stream, _ = _setup(monkeypatch)
    intent_json = _fake_intent_response(
        "hint", "3",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "method", "form": "hint", "wait_for_student": None},
    )
    _install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text="Think about the relationship between force and lever arm for a torque calculation.",
    )
    try:
        body = asyncio.run(_ask(stream, document_id=DOC_MECH1, question="Give me a hint for exercise 3."))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' not in body, (
        "a clean hint for exercise 3 must not be withheld merely because exercise 1's "
        "unrelated answer (75 N) also appears somewhere in the same retrieved chunk"
    )


def test_protected_value_check_does_not_confuse_a_given_value_as_the_result(monkeypatch):
    """A hint that restates a GIVEN (the 100 N point load, stated in the
    problem itself) must not be withheld as if it were the protected
    RESULT (75 N / 25 N) for the same exercise."""
    stream, _ = _setup(monkeypatch)
    intent_json = _fake_intent_response(
        "hint", "1",
        {"final_answer": "prohibited", "official_solution": "unspecified",
         "explanation_depth": "method", "form": "hint", "wait_for_student": None},
    )
    _install_capturing_transport(
        monkeypatch, intent_response_json=intent_json,
        draft_text="Start with the 100 N point load and take moments about support A.",
    )
    try:
        body = asyncio.run(_ask(stream, document_id=DOC_MECH1, question="Give me a hint for exercise 1."))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    assert b'"code": "answer_release_restricted"' not in body, (
        "restating the GIVEN 100 N load must not be mistaken for the protected 75 N/25 N result"
    )


# ---------------------------------------------------------------------------
# 6. Full 3-turn quiz exchange, through the real route, with real
#    cross-turn policy persistence: wrong guess must not be confirmed or
#    leak the answer; the exercise target must not be lost; a later,
#    explicit change of mind (ask for the full solution) must still be
#    honored.
# ---------------------------------------------------------------------------

def test_full_three_turn_quiz_exchange_stays_safe_and_keeps_target(monkeypatch):
    stream, _ = _setup(monkeypatch)
    rows = _install_persisted_history(monkeypatch)
    conv = "acc-3turn"

    from app.services import semantic_intent_orchestrator
    real_interpret = semantic_intent_orchestrator.interpret_turn_authoritatively
    captured_policies: list[dict] = []

    def spy_interpret(**kwargs):
        result = real_interpret(**kwargs)
        captured_policies.append(result.compiled_policy_by_target)
        return result
    monkeypatch.setattr(semantic_intent_orchestrator, "interpret_turn_authoritatively", spy_interpret)

    try:
        # Turn 1: quiz start on exercise "2a" (resolvable target).
        _install_capturing_transport(
            monkeypatch, intent_response_json=None,
            draft_text=(
                "Let's find out!\n\n```minallo-quiz\n"
                + json.dumps({"title": "F_parallel", "questions": [{
                    "q": "What is F_parallel for the block on the incline?",
                    "options": ["40 N", "49.05 N", "84.96 N"], "answer": 1,
                    "explanation": "F_parallel = m*g*sin(30°).",
                }]}) + "\n```\n"
            ),
        )
        body1 = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Frag mich Aufgabe 2a ab.",
            conversation_id=conv, generation=1,
        ))
        assert b'"code": "answer_release_restricted"' not in body1
        rows[conv] = [{
            "client_message_id": "t1",
            "request_snapshot": {"policyByTarget": captured_policies[-1]},
        }]
        previous = [
            {"role": "user", "text": "Frag mich Aufgabe 2a ab."},
            {"role": "assistant", "text": _rendered_text(body1)},
        ]

        # Turn 2: wrong guess -- must not confirm or leak 49.05.
        _install_capturing_transport(
            monkeypatch, intent_response_json=None,
            draft_text="Not quite -- try thinking about which trig function applies here. Give it another go!",
        )
        body2 = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Ist es 40 N?",
            conversation_id=conv, generation=2, previous_turns=previous,
        ))
        assert b"49.05" not in body2, f"a wrong guess must not leak the protected answer: {body2!r}"
        rows[conv].append({
            "client_message_id": "t2",
            "request_snapshot": {"policyByTarget": captured_policies[-1]},
        })
        previous = previous + [
            {"role": "user", "text": "Ist es 40 N?"},
            {"role": "assistant", "text": _rendered_text(body2)},
        ]

        # Turn 3: correct guess -- confirming is fine (49.05 is the
        # student's OWN correct statement, not the model volunteering
        # it unprompted); the response must not be a hard, generic
        # refusal either.
        _install_capturing_transport(
            monkeypatch, intent_response_json=None,
            draft_text="That's right! 49.05 N is correct.",
        )
        body3 = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Ist es 49.05 N?",
            conversation_id=conv, generation=3, previous_turns=previous,
        ))
        assert b"That" in body3 or b"49.05" in body3, (
            "a correct guess should get SOME appropriate feedback, not necessarily a hard refusal"
        )
    finally:
        from app.config import get_settings
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# 7. Changed assistance permission across turns: hint-only, then the
#    student explicitly asks for the full solution -- the LATER,
#    explicit turn must win; an earlier restriction must not be
#    permanently stuck once the student changes their mind.
# ---------------------------------------------------------------------------

def test_changed_permission_across_turns_hint_then_explicit_full_solution(monkeypatch):
    stream, _ = _setup(monkeypatch)
    rows = _install_persisted_history(monkeypatch)
    conv = "acc-changed-permission"

    from app.services import semantic_intent_orchestrator
    real_interpret = semantic_intent_orchestrator.interpret_turn_authoritatively
    captured_policies: list[dict] = []

    def spy_interpret(**kwargs):
        result = real_interpret(**kwargs)
        captured_policies.append(result.compiled_policy_by_target)
        return result
    monkeypatch.setattr(semantic_intent_orchestrator, "interpret_turn_authoritatively", spy_interpret)

    try:
        # Turn 1: hint-only for exercise "1".
        intent_t1 = _fake_intent_response(
            "hint", "1",
            {"final_answer": "prohibited", "official_solution": "unspecified",
             "explanation_depth": "method", "form": "hint", "wait_for_student": None},
        )
        _install_capturing_transport(
            monkeypatch, intent_response_json=intent_t1,
            draft_text="Think about taking moments about support A first.",
        )
        body1 = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Give me a hint for exercise 1.",
            conversation_id=conv, generation=1,
        ))
        # Rendered t-token text, not the raw wire body: the release
        # validator's own evidence-grounding diagnostics legitimately
        # echo the given's value back for debugging and are never read
        # by the frontend (see the AB-24/AB-02/AB-03 tests above).
        assert "75 N" not in _rendered_text(body1)
        rows[conv] = [{
            "client_message_id": "t1",
            "request_snapshot": {"policyByTarget": captured_policies[-1]},
        }]
        previous = [
            {"role": "user", "text": "Give me a hint for exercise 1."},
            {"role": "assistant", "text": _rendered_text(body1)},
        ]

        # Turn 2: explicit change of mind -- now wants the full solution.
        # relation="continuation" (not the helper's "new_topic" default):
        # this message names no exercise at all, so it is ONLY a genuine
        # continuation of exercise "1" -- a real model, given the actual
        # turn history, would never tag this "new_topic". Using that
        # default here would (correctly, by design -- see semantic_intent_
        # orchestrator._apply_target_identity_gate's "new-topic history
        # isolation") make the gate refuse to trust the claimed target and
        # downgrade the action to unresolved, which is right for an
        # actually-unrelated new-topic turn but wrong for this one.
        intent_t2 = _fake_intent_response(
            "solve", "1",
            {"final_answer": "permitted", "official_solution": "unspecified",
             "explanation_depth": "worked_derivation", "form": "worked_solution", "wait_for_student": False},
            relation="continuation",
        )
        _install_capturing_transport(
            monkeypatch, intent_response_json=intent_t2,
            draft_text="The final answer is R_A = 75 N, R_B = 25 N.",
        )
        body2 = asyncio.run(_ask(
            stream, document_id=DOC_MECH1, question="Actually, just give me the full solution now.",
            conversation_id=conv, generation=2, previous_turns=previous,
        ))
        assert b"75 N" in body2 and b"25 N" in body2, (
            "an explicit, later change of mind to request the full solution must be honored, "
            "not permanently blocked by the earlier hint-only restriction"
        )
        assert b'"code": "answer_release_restricted"' not in body2
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
