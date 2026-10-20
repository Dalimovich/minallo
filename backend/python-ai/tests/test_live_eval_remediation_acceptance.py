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


def _fake_intent_response(objective, target, release, *, confidence=0.9):
    return json.dumps({
        "relation": "new_topic", "speechAct": "question", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": None, "confidence": confidence,
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
# 1. AB-24 -- real prompt assembly must contain QUIZ_CONTRACT and the
#    overlay, with no contradiction, and the model's actual confirmed
#    live disclosure shape must now be withheld by the value-grounded gate.
# ---------------------------------------------------------------------------

def test_ab24_quiz_prompt_contains_quiz_contract_and_no_contradicting_hint_text(monkeypatch):
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

    sys_prompt = _gen_system_prompt(captured)
    assert "BUILD IT INLINE" in sys_prompt, "QUIZ_CONTRACT must reach the model regardless of workspace stats"
    assert "respond with a HINT only, not a worked solution" in sys_prompt, (
        "the hint-objective overlay must still be present"
    )
    # The confirmed live disclosure shape must now be caught via the
    # value-grounded gate (this harness's DOC-MECH1 fixture chunk text
    # already contains "Lösung: R_A = 75 N, ..." for exercise "1").
    assert b"75" not in body or b'"code": "answer_release_restricted"' in body
    assert b'"code": "answer_release_restricted"' in body


# ---------------------------------------------------------------------------
# 2. AB-02 -- a failed/invalid semantic response must degrade to the
#    restrictive fallback, not the permissive deterministic default.
# ---------------------------------------------------------------------------

def test_ab02_failed_semantic_validation_no_longer_defaults_to_permitted(monkeypatch):
    stream, _ = _setup(monkeypatch)
    # Malformed intent response (invalid enum for "relation") -- the real
    # validator rejects this exactly as it would reject AB-02's real,
    # unrecoverable response; what matters here is the DOWNSTREAM
    # behavior once validation fails, not reproducing the exact live
    # rejection reason (still not independently confirmed).
    captured = _install_capturing_transport(
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
    assert b'"code": "answer_release_restricted"' in body, (
        "a message that triggered escalation but got no valid semantic result "
        "must fall back to the restrictive degrade, not the permissive deterministic default"
    )


# ---------------------------------------------------------------------------
# 3. AB-03 -- conceptual explanation: positive depth/form guidance must be
#    present, and the confirmed live \\approx disclosure shape withheld.
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
    assert b'"code": "answer_release_restricted"' in body, (
        "the confirmed live \\approx disclosure shape must now be caught via the value-grounded gate"
    )


# ---------------------------------------------------------------------------
# 4. Explicit full-solution control -- must remain fully permitted.
# ---------------------------------------------------------------------------

def test_explicit_full_solution_control_still_streams_through(monkeypatch):
    stream, _ = _setup(monkeypatch)
    captured = _install_capturing_transport(
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
