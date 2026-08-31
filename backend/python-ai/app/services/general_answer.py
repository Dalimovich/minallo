"""General-knowledge answer path for non-course, non-web questions."""

from __future__ import annotations

from typing import Any, Iterator

from ..config import get_settings
from .answer import INTERNAL_CONFIDENTIALITY_RULE, chat_completion_params
from .openai_client import get_openai_client


_SYSTEM_PROMPT = """You are Minallo AI, a helpful university study assistant.

The user is asking a general question that does not depend on uploaded course
files and does not require current internet information. Answer clearly from
general knowledge. Do not cite uploaded course files. Do not pretend that you
checked course documents or the web.""" + INTERNAL_CONFIDENTIALITY_RULE


def generate_general_answer(question: str, *, prefix: str = "", max_tokens: int = 1200) -> dict[str, Any]:
    settings = get_settings()
    target_model = settings.openai_generate_model
    client = get_openai_client()
    completion = client.chat.completions.create(
        model=target_model,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": question.strip()},
        ],
        **chat_completion_params(target_model, max_tokens),
    )
    msg = completion.choices[0].message if completion.choices else None
    answer_text = prefix + ((msg.content if msg else "") or "")
    return {
        "answer": answer_text,
        "retrievalMode": "none",
        "answerMode": "general",
        "verification": None,
        "groundedSources": [],
        "model": target_model,
        "promptTokens": completion.usage.prompt_tokens if completion.usage else None,
        "completionTokens": completion.usage.completion_tokens if completion.usage else None,
    }


def stream_general_answer(question: str, *, previous_turns: list[dict[str, str]] | None = None,
                          max_tokens: int = 700) -> Iterator[dict[str, Any]]:
    """Yield real model deltas immediately; never buffer a fast-lane answer."""
    settings = get_settings()
    target_model = settings.openai_generate_model
    history = []
    for turn in (previous_turns or [])[-2:]:
        role = turn.get("role")
        text = str(turn.get("text") or "").strip()
        if role in {"user", "assistant"} and text:
            history.append({"role": role, "content": text[:4000]})
    stream = get_openai_client().chat.completions.create(
        model=target_model,
        messages=[{"role": "system", "content": _SYSTEM_PROMPT}, *history,
                  {"role": "user", "content": question.strip()}],
        stream=True,
        **chat_completion_params(target_model, max_tokens),
    )
    prompt_tokens = completion_tokens = None
    for chunk in stream:
        if getattr(chunk, "usage", None):
            prompt_tokens = getattr(chunk.usage, "prompt_tokens", None)
            completion_tokens = getattr(chunk.usage, "completion_tokens", None)
        choice = chunk.choices[0] if chunk.choices else None
        text = getattr(getattr(choice, "delta", None), "content", None) if choice else None
        if text:
            yield {"t": text, "model": target_model}
    yield {"done": True, "model": target_model, "promptTokens": prompt_tokens,
           "completionTokens": completion_tokens}


__all__ = ("generate_general_answer", "stream_general_answer")
