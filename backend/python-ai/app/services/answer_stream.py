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
from typing import Any, Generator

from openai import OpenAI

from ..config import get_settings
from .answer import (
    _build_context_block,
    _cited_indices,
    _context_strength,
    pick_system_prompt,
)
from .retrieval import RetrievedChunk

log = logging.getLogger(__name__)


def _sse(event: dict[str, Any]) -> bytes:
    return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8")


def stream_answer(
    *,
    question: str,
    chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
    model: str | None = None,
    max_tokens: int = 1200,
) -> Generator[bytes, None, None]:
    """Generator that yields SSE byte chunks. Pluggable into FastAPI's
    StreamingResponse with media_type='text/event-stream'."""
    settings = get_settings()
    target_model = model or settings.openai_generate_model
    strength = _context_strength(chunks)
    used_chunks = chunks if strength == "strong" else []
    system_prompt, answer_mode = pick_system_prompt(question, strength)
    context_block = _build_context_block(used_chunks, doc_names) if used_chunks else ""

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
        "retrievalMode": strength,
        "answerMode": answer_mode,
        "confidence": "high" if strength == "strong" else "low",
        "unsupported": strength != "strong",
    })

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

    # Phase 10 — deterministic verification on the streamed answer.
    verification: dict[str, Any] = {"status": "missing_context", "reasons": [], "details": {}}
    try:
        from .verification import verify_answer  # noqa: WPS433
        verification = verify_answer(
            answer_text=full_answer,
            chunk_texts=[c.text for c in used_chunks],
            question=question,
            answer_mode=answer_mode,
        ).to_api()
    except Exception:  # noqa: BLE001
        log.exception("verify_answer (stream) failed — emitting default missing_context")

    yield _sse({
        "done": True,
        "retrievalMode": strength,
        "answerMode": answer_mode,
        "verification": verification,
        "confidence": "high" if strength == "strong" else "low",
        "unsupported": strength != "strong",
        "sources": filtered_sources,
        "model": target_model,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
    })
