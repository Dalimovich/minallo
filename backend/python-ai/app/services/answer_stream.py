"""Streaming variant of generate_answer.

Yields Server-Sent Event payloads as OpenAI returns tokens, then a
terminal `done` event with the full source list + token diagnostics.
The browser fetches this endpoint directly with the user's Supabase
JWT — no Netlify hop, so the connection stays open for the streaming
duration without hitting Netlify's 30s function timeout.

Event schema (newline-delimited JSON inside an SSE `data:` field):
  {"t": "Newton"}                          — token to append
  {"done": true, "sources": [...], ...}    — final metadata
  {"error": "..."}                         — fatal error
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Generator

from openai import OpenAI

from ..config import get_settings
from .answer import (
    DEFAULT_TUTOR_MODE,
    _build_context_block,
    _cited_indices,
    _context_strength,
    normalise_tutor_mode,
    pick_system_prompt,
)
from .retrieval import RetrievedChunk

log = logging.getLogger(__name__)

# Questions that legitimately need the open-PDF text override. Deictic refs
# ("this", "here", "above") and explicit-locality phrasing ("explain this
# section", "summarise this page") mean the user is asking ABOUT what they
# can see — and visible text is the right grounding.
#
# Broad questions ("Solve Aufgabe 4", "Find the formula for shear stress in
# the whole chapter") would be UNDER-grounded by a 3.5k-char visible slice
# — they need real retrieval. Promoting "weak retrieval" to "strong" via
# Source 0 for those questions would let the model invent the rest.
_DEICTIC_QUESTION_RE = re.compile(
    r"\b("
    r"this|that|these|those|here|above|below|"
    r"the (section|page|formula|equation|paragraph|exercise above|exercise below)|"
    r"explain this|what does this|what is this|summari[sz]e (this|the section|the page)|"
    r"dies(e[rs]?|es)?|jene[rs]?|hier|oben|unten|"
    r"diese (formel|seite|aufgabe|stelle|gleichung|abschnitt)|"
    r"was bedeutet (das|dies|diese)|was steht (hier|oben|unten|dort)|"
    r"erklär(e|ung)? (mir )?(dies|das|diese|hier|oben)|"
    r"zusammenfass"
    r")\b",
    re.IGNORECASE,
)


def _is_deictic_question(q: str) -> bool:
    return bool(_DEICTIC_QUESTION_RE.search(q or ""))


# Conversation-continuity tuning. A chat session can grow arbitrarily, but
# we only need a few recent turns for the model to resolve follow-up
# references — the rest is irrelevant and just inflates prompt cost.
_MAX_HISTORY_MESSAGES = 6        # 3 Q/A pairs
_MAX_HISTORY_CHARS    = 2000     # safety cap on total prior text
_MAX_TURN_CHARS       = 800      # any one turn is truncated to this


def _trim_previous_turns(
    turns: list[dict[str, str]] | None,
) -> list[dict[str, str]]:
    """Server-side trim of the chat history before it goes into the
    OpenAI messages array.

    Rules:
      * keep only role == "user" or "assistant"; drop anything else
      * keep at most the last _MAX_HISTORY_MESSAGES entries
      * truncate each turn's text to _MAX_TURN_CHARS chars
      * if the running total exceeds _MAX_HISTORY_CHARS, drop oldest
        turns until it fits
    The current question is appended SEPARATELY by the caller, so this
    function only deals with PAST turns.
    """
    if not turns:
        return []
    cleaned: list[dict[str, str]] = []
    for t in turns:
        role = (t.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        text = (t.get("text") or "").strip()
        if not text:
            continue
        if len(text) > _MAX_TURN_CHARS:
            text = text[:_MAX_TURN_CHARS] + " …"
        cleaned.append({"role": role, "content": text})
    # Trim to the most recent N messages.
    if len(cleaned) > _MAX_HISTORY_MESSAGES:
        cleaned = cleaned[-_MAX_HISTORY_MESSAGES:]
    # Drop oldest while total chars exceed the budget. Keeps the most
    # recent turns intact — those are the ones the follow-up question
    # most likely references.
    total = sum(len(m["content"]) for m in cleaned)
    while cleaned and total > _MAX_HISTORY_CHARS:
        dropped = cleaned.pop(0)
        total -= len(dropped["content"])
    return cleaned


def _sse(event: dict[str, Any]) -> bytes:
    return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8")


def stream_answer(
    *,
    question: str,
    chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
    model: str | None = None,
    max_tokens: int = 2500,
    active_file_name: str | None = None,
    open_file_context: str | None = None,
    tutor_mode: str = DEFAULT_TUTOR_MODE,
    weak_topics: list[str] | None = None,
    previous_turns: list[dict[str, str]] | None = None,
) -> Generator[bytes, None, None]:
    """Generator that yields SSE byte chunks. Pluggable into FastAPI's
    StreamingResponse with media_type='text/event-stream'.

    ``active_file_name`` + ``open_file_context`` carry the file the user is
    currently reading and a slice of its text. They are surfaced into the
    prompt so deictic questions like "what does this say?" or "explain this
    exercise" stay grounded in the section the user is actually looking at,
    even when retrieval doesn't pull the right chunk.

    ``previous_turns`` is a list of ``{"role": "user"|"assistant", "text":
    "..."}`` dicts representing the most recent Q&A in this chat session.
    Trimmed server-side (last 3 turns, ~2000 chars total) before being
    woven into the LLM messages array so the model can resolve follow-up
    references ("the formula above", "explain that in simpler terms")
    without paying for a 50-message-long context.
    """
    settings = get_settings()
    strength = _context_strength(chunks)
    # Review fix #3 — partial retrieval mode. Mirrors answer.py's logic:
    #   strong → all chunks    weak → top 3 (with PARTIAL prompt)    none → []
    if strength == "strong":
        used_chunks = chunks
    elif strength == "weak":
        used_chunks = chunks[:3]
    else:
        used_chunks = []

    open_ctx = (open_file_context or "").strip()[:3500]
    has_open = bool(open_ctx)
    # Promote to "strong" when the user has a file open with visible text AND
    # the question is deictic ("explain this", "what does this section mean?").
    # For broad questions ("Solve Aufgabe 4", "Find the formula for X") a
    # 3.5k-char visible slice is NOT enough grounding — those still need
    # actual retrieval, otherwise the model would treat whatever happens to
    # be on the visible page as the answer.
    deictic = _is_deictic_question(question)
    effective_strength = (
        "strong"
        if (strength == "strong" or (has_open and deictic))
        else strength
    )
    tutor_mode_norm = normalise_tutor_mode(tutor_mode)
    system_prompt, answer_mode = pick_system_prompt(
        question, effective_strength, used_chunks, tutor_mode=tutor_mode_norm,
        weak_topics=weak_topics,
    )
    # Route by answer mode: math/exercise questions hit the strong model,
    # everything else stays on the cheaper mini model. Must compute AFTER
    # pick_system_prompt because we need its returned label. Math reasoning
    # is where mini gets variable distinctions wrong (d vs d_3) and
    # silently drops sum terms it can't compute — gpt-4o handles both.
    # The math gate is tight (strong retrieval + is_math_question +
    # exercise anchor + formula chunk presence ALL agree), so cost stays
    # predictable.
    if model:
        target_model = model
    elif answer_mode == "math":
        target_model = settings.openai_generate_model_strong
    else:
        target_model = settings.openai_generate_model

    # Compose the context block. Open-file text goes first as [Source 0] so
    # the model cites it preferentially for deictic ("this question /
    # this section / the exercise above") queries. RAG-retrieved chunks
    # follow as [Source 1..N].
    # Source 0 is only included when the question is deictic OR retrieval
    # was already strong on its own. Otherwise a 3.5k slice of whatever the
    # student happens to have on screen would over-anchor a broad question.
    include_open_source = has_open and (deictic or strength == "strong")
    parts: list[str] = []
    if include_open_source:
        open_name = active_file_name or "open file"
        parts.append(
            f"[Source 0] {open_name} — CURRENTLY VISIBLE IN PDF VIEWER\n{open_ctx}"
        )
    if used_chunks:
        parts.append(_build_context_block(used_chunks, doc_names))
    context_block = "\n\n---\n\n".join(parts)

    if active_file_name:
        system_prompt += (
            f"\n\nThe student is currently reading the file \"{active_file_name}\""
            " in the PDF viewer. When their question contains deictic references"
            " (\"this\", \"this question\", \"this section\", \"the exercise above\","
            " \"explain this\"), anchor your answer in [Source 0] (CURRENTLY VISIBLE)"
            " before consulting other sources."
        )

    user_message = "QUESTION:\n" + question.strip()
    if context_block:
        user_message += "\n\nCOURSE CONTEXT:\n\n" + context_block

    def _source_payload(c):
        return {
            "file_name": doc_names.get(c.document_id, "Unknown"),
            "pages": (
                str(c.page_start)
                if c.page_start and c.page_start == c.page_end
                else (f"{c.page_start}-{c.page_end}" if c.page_start and c.page_end else None)
            ),
            "section": c.section_title,
        }

    # Buffer the streamed answer so we can filter sources by the [Source N]
    # citations the model actually used. The full text isn't known until the
    # stream completes, so the filtering happens just before the 'done' event.
    answer_buf: list[str] = []

    # Send an opening "meta" event so the client can render the bubble
    # immediately, even before the first content token arrives.
    yield _sse({
        "meta": True,
        "retrievalMode": effective_strength,
        "answerMode": answer_mode,
        "tutorMode": tutor_mode_norm,
        "confidence": "high" if effective_strength == "strong" else "low",
        "unsupported": effective_strength != "strong",
    })

    # Weave in recent Q&A turns so the model can resolve follow-up
    # references ("the formula above", "explain that"). Server-side cap:
    # at most 6 messages (3 turns) and ~2000 chars total — enough to give
    # the model anaphora context without blowing prompt size on a long
    # session.
    history_messages = _trim_previous_turns(previous_turns)

    client = OpenAI(api_key=settings.openai_api_key)
    prompt_tokens = None
    completion_tokens = None
    try:
        stream = client.chat.completions.create(
            model=target_model,
            max_tokens=max_tokens,
            stream=True,
            stream_options={"include_usage": True},
            messages=[
                {"role": "system", "content": system_prompt},
                *history_messages,
                {"role": "user",   "content": user_message},
            ],
        )
        for chunk in stream:
            # Usage chunk arrives at the end when include_usage=True.
            if getattr(chunk, "usage", None):
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens
                continue
            choices = chunk.choices or []
            if not choices:
                continue
            delta = choices[0].delta
            token = getattr(delta, "content", None) if delta else None
            if token:
                answer_buf.append(token)
                yield _sse({"t": token})
    except Exception as e:  # noqa: BLE001
        log.exception("stream_answer failed")
        yield _sse({"error": f"{type(e).__name__}: {e}"})
        return

    full_answer = "".join(answer_buf)
    cited = _cited_indices(full_answer, len(used_chunks))
    filtered_sources = [_source_payload(c) for i, c in enumerate(used_chunks, start=1) if i in cited]

    # [Source 0] = the visible PDF text snippet the model received when the
    # question was deictic ("explain this"). _cited_indices only handles
    # 1..N (the retrieved chunks); [Source 0] needs an explicit pass.
    # Without this, the answer would show "grounded in [Source 0]" inline
    # but the final Sources block would be missing that source entirely —
    # a misleading UX gap the user can't tell from a fabricated citation.
    if include_open_source and active_file_name and re.search(r"\[Source\s+0\]", full_answer, re.IGNORECASE):
        filtered_sources.insert(0, {
            "file_name": active_file_name,
            "pages": "currently visible",
            "section": "Open PDF (visible page)",
        })

    # Phase 10 — deterministic verification on the streamed answer.
    # Include the open-file text in the haystack so formulas / numbers the
    # model lifted from [Source 0] aren't flagged as ungrounded.
    verification_haystack = [c.text for c in used_chunks]
    if include_open_source:
        verification_haystack.append(open_ctx)
    # The whitelist of filenames the model could legitimately cite. Anything
    # else in a `(filename.pdf, p.N)` ref is fabricated — see verification.py.
    # When [Source 0] was suppressed the active file isn't a valid citation
    # target either; whitelisting it would let the model "cite" a slice we
    # never sent.
    allowed_filenames = [doc_names.get(c.document_id) for c in used_chunks]
    allowed_filenames = [f for f in allowed_filenames if f]
    if include_open_source and active_file_name:
        allowed_filenames.append(active_file_name)

    verification: dict[str, Any] = {"status": "missing_context", "reasons": [], "details": {}}
    try:
        from .verification import verify_answer  # noqa: WPS433
        verification = verify_answer(
            answer_text=full_answer,
            chunk_texts=verification_haystack,
            question=question,
            answer_mode=answer_mode,
            allowed_filenames=allowed_filenames,
        ).to_api()
    except Exception:  # noqa: BLE001
        log.exception("verify_answer (stream) failed — emitting default missing_context")

    # Confidence shown to the user is now derived from verification status —
    # NOT from retrieval strength. The old "strong retrieval ⇒ confidence: high"
    # mapping let the UI show a green badge on answers the model had self-tagged
    # as "Missing context" and on answers with fabricated citations.
    v_status = verification.get("status") if isinstance(verification, dict) else None
    if v_status == "verified":
        confidence_label = "high"
    elif v_status == "partially_verified":
        confidence_label = "medium"
    else:
        confidence_label = "low"

    yield _sse({
        "done": True,
        "retrievalMode": effective_strength,
        "answerMode": answer_mode,
        "tutorMode": tutor_mode_norm,
        "verification": verification,
        "confidence": confidence_label,
        "unsupported": effective_strength != "strong",
        "sources": filtered_sources,
        "model": target_model,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
    })
