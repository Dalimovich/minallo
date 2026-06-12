"""General-knowledge answer path for non-course, non-web questions."""

from __future__ import annotations

from typing import Any

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


__all__ = ("generate_general_answer",)
