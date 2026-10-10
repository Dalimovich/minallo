"""General-knowledge answer path for non-course, non-web questions."""

from __future__ import annotations

from typing import Any, Iterator

from ..config import get_settings
from .answer import INTERNAL_CONFIDENTIALITY_RULE, LANGUAGE_MATCH_RULE, chat_completion_params
from .openai_client import INTERACTIVE_ANSWER_TIMEOUT, get_openai_client


_SYSTEM_PROMPT = """You are Minallo AI, a helpful university study assistant.

The user is asking a general question that does not depend on uploaded course
files and does not require current internet information. Answer clearly from
general knowledge. Do not cite uploaded course files. Do not pretend that you
checked course documents or the web.

Follow the conversation naturally. Use prior turns to resolve short replies
and follow-up requests instead of treating each message as a new topic. Never
narrate source routing or say that the request does not depend on uploaded
files. Honor the user's speech act. If they ask you to create, suggest, choose,
organize, write, compare, recommend, or plan something, perform that task
directly. Only explain a process when they ask how to do it. Use conversation
history to resolve omitted information. If essential details are genuinely
missing, ask one concise, specific question instead of producing a checklist
of information requests.

STATICS / MECHANICS. Name every support/constraint by its correct type and
state exactly the reactions it can carry — never confuse them: a Festlager
(pin support) carries a horizontal AND a vertical force but NO moment; a
Loslager (roller support) carries only a force perpendicular to its rolling
direction; an Einspannung (fixed support) carries a horizontal force, a
vertical force, AND a moment. Write out every equilibrium equation used
(ΣF_x = 0, ΣF_y = 0, ΣM = 0) and report every reaction, including ones that
are zero (e.g. state "A_h = 0" rather than omitting it).""" + INTERNAL_CONFIDENTIALITY_RULE + LANGUAGE_MATCH_RULE


def _bounded_history(previous_turns: list[dict[str, str]] | None) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    history_chars = 0
    for turn in reversed(previous_turns or []):
        role = turn.get("role")
        text = str(turn.get("text") or "").strip()
        if role in {"user", "assistant"} and text:
            bounded = text[:4000]
            if history and history_chars + len(bounded) > 24000:
                break
            history.append({"role": role, "content": bounded})
            history_chars += len(bounded)
    history.reverse()
    return history


def generate_general_answer(
    question: str, *, prefix: str = "", max_tokens: int = 1200,
    previous_turns: list[dict[str, str]] | None = None, context_block: str = "",
) -> dict[str, Any]:
    settings = get_settings()
    target_model = settings.openai_generate_model
    client = get_openai_client()
    history = _bounded_history(previous_turns)
    completion = client.chat.completions.create(
        model=target_model,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT + context_block},
            *history,
            {"role": "user", "content": question.strip()},
        ],
        # A plain conversational answer, not math/reasoning work — a
        # reasoning-model OPENAI_GENERATE_MODEL should spend as little
        # (billed) reasoning effort here as it would on notes_full.py's
        # synthesis calls, for the same latency/cost reason.
        **chat_completion_params(target_model, max_tokens, reasoning_effort="low"),
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
                          context_block: str = "", max_tokens: int = 700,
                          prefix: str = "") -> Iterator[dict[str, Any]]:
    """Yield real model deltas immediately; never buffer a fast-lane answer."""
    settings = get_settings()
    target_model = settings.openai_generate_model
    if prefix:
        yield {"t": prefix, "model": target_model}
    history = _bounded_history(previous_turns)
    stream = get_openai_client().chat.completions.create(
        model=target_model,
        messages=[{"role": "system", "content": _SYSTEM_PROMPT + context_block}, *history,
                  {"role": "user", "content": question.strip()}],
        stream=True,
        stream_options={"include_usage": True},
        timeout=INTERACTIVE_ANSWER_TIMEOUT,
        **chat_completion_params(target_model, max_tokens, reasoning_effort="low"),
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
