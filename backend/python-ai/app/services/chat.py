"""Generic vision-capable chatbot — port of backend/functions/ai.js.

Accepts the Anthropic-shaped payload the frontend already sends
({system, messages: [{role, content: text | [{type:'text'|'image', ...}]}]})
and converts it into the OpenAI chat-completions shape so we can call
gpt-4o with images. Returns the Anthropic-shaped reply
({content: [{type: 'text', text: '...'}]}) so the existing chatbot.js
keeps working unchanged.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from openai import OpenAI

from ..config import get_settings

log = logging.getLogger(__name__)

_MAX_MESSAGES = 200
_MAX_SYSTEM_CHARS = 120_000
_MAX_TEXT_CHARS = 120_000
_MAX_IMAGE_BLOCKS = 5
_MAX_IMAGE_BASE64_CHARS = 5_000_000
_MAX_COMPLETION_TOKENS = 2048

_ALLOWED_ROLES = {"user", "assistant", "system"}
_ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/=]+$")


class ChatValidationError(ValueError):
    """Raised when the incoming chat payload is malformed."""


def _normalise_max_tokens(value: Any) -> int:
    try:
        n = int(value or 1024)
    except (TypeError, ValueError):
        n = 1024
    if n <= 0:
        n = 1024
    return min(n, _MAX_COMPLETION_TOKENS)


def _convert_content(content: Any, counters: dict[str, int]) -> Any:
    if isinstance(content, str):
        counters["text_chars"] += len(content)
        if counters["text_chars"] > _MAX_TEXT_CHARS:
            raise ChatValidationError("AI request text is too large")
        return content
    if not isinstance(content, list):
        raise ChatValidationError("Message content must be text or an array of content blocks")
    parts: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            raise ChatValidationError("Invalid message content block")
        btype = block.get("type")
        if btype == "text":
            text = str(block.get("text", "") or "")
            counters["text_chars"] += len(text)
            if counters["text_chars"] > _MAX_TEXT_CHARS:
                raise ChatValidationError("AI request text is too large")
            parts.append({"type": "text", "text": text})
        elif btype == "image":
            source = block.get("source") or {}
            if source.get("type") != "base64":
                raise ChatValidationError("Unsupported image source")
            media_type = str(source.get("media_type") or "")
            data = str(source.get("data") or "")
            counters["images"] += 1
            if media_type not in _ALLOWED_IMAGE_TYPES:
                raise ChatValidationError("Unsupported image type")
            if counters["images"] > _MAX_IMAGE_BLOCKS:
                raise ChatValidationError("Too many images in one AI request")
            if not data or len(data) > _MAX_IMAGE_BASE64_CHARS:
                raise ChatValidationError("Attached image is too large")
            if not _BASE64_RE.match(data):
                raise ChatValidationError("Attached image is not valid base64")
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}"},
            })
        else:
            raise ChatValidationError("Unsupported message content block")
    if not parts:
        return ""
    if all(p["type"] == "text" for p in parts):
        return "\n".join(p["text"] for p in parts)
    return parts


def _build_openai_messages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    counters = {"text_chars": 0, "images": 0}
    msgs = payload.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise ChatValidationError("Missing messages")
    if len(msgs) > _MAX_MESSAGES:
        raise ChatValidationError("Too many messages in one AI request")
    out: list[dict[str, Any]] = []
    for m in msgs:
        if not isinstance(m, dict):
            raise ChatValidationError("Invalid message")
        if m.get("role") not in _ALLOWED_ROLES:
            raise ChatValidationError("Invalid message role")
        out.append({"role": m["role"], "content": _convert_content(m.get("content"), counters)})
    system = payload.get("system")
    if system:
        system_str = str(system)
        if len(system_str) > _MAX_SYSTEM_CHARS:
            raise ChatValidationError("System prompt is too large")
        return [{"role": "system", "content": system_str}] + out
    return out


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    """Extract the last user message's text for diagram-intent detection.
    Generic /chat uses Anthropic-shaped content blocks; we concat all text
    parts from the last user turn."""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    txt = block.get("text")
                    if isinstance(txt, str):
                        parts.append(txt)
            return " ".join(parts)
        return ""
    return ""


def run_chat(payload: dict[str, Any]) -> dict[str, Any]:
    """Run the chat completion and return an Anthropic-shaped response."""
    settings = get_settings()
    messages = _build_openai_messages(payload)
    max_tokens = _normalise_max_tokens(payload.get("max_tokens"))
    client = OpenAI(api_key=settings.openai_api_key)

    # Diagram-intent detection on the last user turn. When the student
    # asks for a diagram on the generic /chat path (no course selected),
    # append the rendering overlay to the system message so the first
    # call has a chance to emit the fence. If it refuses anyway, the
    # structured-output fallback below produces it deterministically.
    from .diagram_overlay import diagram_overlay, wants_diagram, wants_plot  # noqa: WPS433
    user_text = _last_user_text(messages)
    plot_wanted = wants_plot(user_text)
    diagram_wanted = wants_diagram(user_text) or plot_wanted
    if diagram_wanted:
        overlay = diagram_overlay(has_context=False)
        if messages and messages[0].get("role") == "system":
            messages[0] = {
                "role": "system",
                "content": (messages[0].get("content") or "") + overlay,
            }
        else:
            messages = [{"role": "system", "content": overlay}] + messages

    resp = client.chat.completions.create(
        model="gpt-4o",
        max_completion_tokens=max_tokens,
        messages=messages,
    )
    choice = resp.choices[0] if resp.choices else None
    text = (choice.message.content if choice and choice.message else "") or ""

    # Same refusal-recovery as answer_stream.py: model often refuses with
    # "Ich kann keine Bilder zeichnen" — structured outputs can't refuse.
    print(
        f"[DIAGRAM_DEBUG /chat] wants_diagram={diagram_wanted} wants_plot={plot_wanted} "
        f"has_diag_fence={'```minallo-diagram' in text} "
        f"has_plot_fence={'```minallo-plot' in text} text_len={len(text)}",
        flush=True,
    )
    # Plot-shape requests: fire the plot fallback whenever no plot fence is
    # present — even if a diagram fence slipped through (wrong shape for a
    # curve). The diagram fence in that case is the model copying the wrong
    # template; the plot fence is the canonically correct render.
    if plot_wanted and "```minallo-plot" not in text:
        from .answer_stream import _force_render_plot  # noqa: WPS433
        fence = _force_render_plot(client, "gpt-4o", user_text, [], None)
        if fence:
            text += fence
    elif diagram_wanted and "```minallo-diagram" not in text:
        from .answer_stream import _force_render_diagram  # noqa: WPS433
        fence = _force_render_diagram(client, "gpt-4o", user_text, [], None)
        if fence:
            text += fence

    return {"content": [{"type": "text", "text": text}]}
