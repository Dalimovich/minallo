"""Internet-source answer path using OpenAI hosted web search."""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from .openai_client import get_openai_client

log = logging.getLogger(__name__)

INTERNET_UNAVAILABLE_MESSAGE = "Internet search is temporarily unavailable."


_SYSTEM_PROMPT = """You are Minallo AI answering in Internet mode.

You must base the answer on live web search results and include web sources.
Do not use uploaded course files. Do not claim that private course files were
checked. If web search cannot run, return the unavailable message instead of
answering from memory."""


def _extract_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    parts: list[str] = []
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            value = getattr(content, "text", None)
            if value:
                parts.append(str(value))
    return "\n".join(parts).strip()


def _extract_sources(response: Any) -> list[dict[str, str]]:
    seen: set[str] = set()
    sources: list[dict[str, str]] = []

    def add(url: str | None, title: str | None = None, snippet: str | None = None) -> None:
        if not url or url in seen:
            return
        seen.add(url)
        sources.append({
            "title": title or url,
            "url": url,
            "snippet": snippet or "",
        })

    for item in getattr(response, "output", []) or []:
        action = getattr(getattr(item, "web_search_call", None), "action", None)
        for src in getattr(action, "sources", []) or []:
            add(getattr(src, "url", None), getattr(src, "title", None), getattr(src, "snippet", None))
        for content in getattr(item, "content", []) or []:
            for ann in getattr(content, "annotations", []) or []:
                ann_type = getattr(ann, "type", "")
                if ann_type == "url_citation":
                    add(getattr(ann, "url", None), getattr(ann, "title", None))
    return sources


def generate_web_answer(question: str, *, query: str, max_tokens: int = 1400) -> dict[str, Any]:
    settings = get_settings()
    if not settings.web_search_enabled:
        return _unavailable()
    client = get_openai_client()
    try:
        response = client.responses.create(
            model=settings.web_search_model,
            input=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": query or question},
            ],
            tools=[{"type": "web_search"}],
            tool_choice={"type": "web_search"},
            max_output_tokens=max_tokens,
        )
    except Exception:  # noqa: BLE001
        log.exception("OpenAI web search failed")
        return _unavailable()

    text = _extract_text(response)
    sources = _extract_sources(response)
    # Only a missing answer means search truly failed. A valid answer whose
    # citation annotations didn't parse is still a real web answer — return it
    # with an empty source list rather than discarding it as "unavailable".
    if not text:
        return _unavailable()
    usage = getattr(response, "usage", None)
    return {
        "answer": text,
        "retrievalMode": "internet",
        "answerMode": "internet",
        "verification": None,
        "groundedSources": [],
        "webSources": sources,
        "model": settings.web_search_model,
        "promptTokens": getattr(usage, "input_tokens", None) if usage else None,
        "completionTokens": getattr(usage, "output_tokens", None) if usage else None,
    }


def _unavailable() -> dict[str, Any]:
    return {
        "answer": INTERNET_UNAVAILABLE_MESSAGE,
        "retrievalMode": "internet",
        "answerMode": "internet",
        "verification": None,
        "groundedSources": [],
        "webSources": [],
        "model": None,
        "promptTokens": None,
        "completionTokens": None,
    }


__all__ = ("INTERNET_UNAVAILABLE_MESSAGE", "generate_web_answer")
