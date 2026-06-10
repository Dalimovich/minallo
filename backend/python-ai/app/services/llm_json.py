"""Shared JSON-mode chat completion helper used by quiz / flashcards / notes.

Wraps the OpenAI client with:
  - response_format = json_object so the model is forced to return JSON.
  - Robust parse: strips fenced markdown if the model still wraps the JSON.
  - Returns (parsed_dict, prompt_tokens, completion_tokens, model_used).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ..config import get_settings
from .concurrency import llm_fanout_slot
from .openai_client import get_openai_client


_FENCE_OPEN = re.compile(r"^\s*```(?:json)?\s*", re.IGNORECASE)
_FENCE_CLOSE = re.compile(r"\s*```\s*$")

# Backslashes that, after a backslash, form a JSON escape we must never touch.
_JSON_KEEP_AFTER_BS = set('"\\/u')


def _repair_json_backslashes(s: str) -> str:
    r"""Re-escape under-escaped LaTeX backslashes so json.loads keeps them.

    Models asked for JSON routinely emit LaTeX with single backslashes
    (``\frac``, ``\triangle``, ``\rho``) instead of the doubled ``\\frac`` valid
    JSON requires. ``json.loads`` then silently decodes the collisions —
    ``\f``→form-feed, ``\t``→tab, ``\b``→backspace — so ``\frac`` becomes
    ``rac`` and the math renders as garbage.

    This walks the raw model text and doubles any backslash that is clearly the
    start of a LaTeX command, while preserving genuine JSON escapes:

      * ``\" \\ \/ \uXXXX``                  → always kept (unambiguous escapes)
      * ``\f \t \r \b`` + a letter            → LaTeX (``\frac``…) → doubled
      * ``\n`` + a lowercase letter           → LaTeX (``\nabla``, ``\nu``) → doubled
      * ``\n \t \r \b \f`` + non-letter       → real whitespace escape → kept
      * ``\`` + anything else (``\D \alpha``) → invalid escape → doubled

    Real form-feed/tab/backspace never legitimately appear in this generated
    content, and real newlines (``\n``) before markdown/sentence text run into a
    non-lowercase character, so the heuristic preserves them.
    """
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        nxt = s[i + 1] if i + 1 < n else ""
        nxt2 = s[i + 2] if i + 2 < n else ""
        if nxt in _JSON_KEEP_AFTER_BS:
            out.append(ch + nxt)
            i += 2
            continue
        if nxt in "ntrbf":
            is_latex = nxt2.islower() if nxt == "n" else nxt2.isalpha()
            out.append(("\\\\" + nxt) if is_latex else (ch + nxt))
            i += 2
            continue
        # Any other char: an invalid JSON escape — the model meant a literal
        # backslash (start of a LaTeX command). Double it; re-read nxt normally.
        out.append("\\\\")
        i += 1
    return "".join(out)


# Control chars that only appear in a parsed value when JSON decoded an
# under-escaped LaTeX command (\frac→form-feed, \beta→backspace, \rho→CR).
# They never legitimately occur in this generated content. Newline (\n) stays
# excluded — a real line break before a word is common prose — but a TAB GLUED
# TO A LOWERCASE LETTER is caught below: that is almost always an eaten command
# (\theta→TAB+heta, \times→TAB+imes, \tau→TAB+au), not a real tab.
_EATEN_LATEX_CHARS = ("\x0c", "\x08", "\x0b", "\x0d")
_EATEN_TAB_LATEX_RE = re.compile(r"\t[a-z]")


def _has_eaten_latex(obj: Any) -> bool:
    if isinstance(obj, str):
        return any(c in obj for c in _EATEN_LATEX_CHARS) or bool(_EATEN_TAB_LATEX_RE.search(obj))
    if isinstance(obj, dict):
        return any(_has_eaten_latex(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_eaten_latex(v) for v in obj)
    return False


def _parse_json_lenient(text: str) -> Any:
    s = (text or "").strip()
    s = _FENCE_OPEN.sub("", s)
    s = _FENCE_CLOSE.sub("", s)

    # Strict parse first. If it succeeds cleanly (no LaTeX backslashes eaten by
    # JSON escaping), the model escaped correctly — return it untouched so valid
    # output is never altered.
    strict: Any = None
    strict_ok = False
    try:
        strict = json.loads(s)
        strict_ok = True
        if not _has_eaten_latex(strict):
            return strict
    except Exception:  # noqa: BLE001
        pass

    # Parse failed, or LaTeX was eaten — re-escape under-escaped backslashes.
    repaired = _repair_json_backslashes(s)
    for cand in (repaired, s):
        try:
            return json.loads(cand)
        except Exception:  # noqa: BLE001
            m = re.search(r"\{[\s\S]*\}", cand)
            if m:
                try:
                    return json.loads(m.group(0))
                except Exception:  # noqa: BLE001
                    continue
    if strict_ok:
        return strict  # fall back to the strict parse (LaTeX imperfect but usable)
    raise ValueError("could not parse model JSON")


def _salvage_string_value(raw: str, key: str) -> str | None:
    r"""Best-effort extraction of one top-level JSON string value, tolerant of
    TRUNCATION (no closing quote/brace) — used when a long single-field response
    (e.g. a whole cheatsheet in ``{"text": "..."}``) is cut off at the token cap
    and ``json.loads`` can't parse it. A truncated markdown body still renders.

    Decodes JSON escapes manually so LaTeX backslashes survive: ``\n``→newline,
    ``\"``→quote, ``\\``→backslash, but ``\frac``/``\mu`` (no JSON meaning) are
    kept verbatim instead of being eaten.
    """
    m = re.search(r'"' + re.escape(key) + r'"\s*:\s*"', raw)
    if not m:
        return None
    body = raw[m.end():]
    out: list[str] = []
    i = 0
    decode = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            out.append(decode.get(nxt, "\\" + nxt))  # keep \frac etc. verbatim
            i += 2
            continue
        if ch == '"':  # unescaped closing quote → end of value
            break
        out.append(ch)
        i += 1
    salvaged = "".join(out).strip()
    return salvaged or None


_MAX_COMPLETION_TOKENS_PREFIXES = ("o1", "o3", "o4", "gpt-4.1", "gpt-4.5")


def _token_limit_param(model: str, limit: int) -> dict:
    """Return the correct token-limit kwarg for the given model."""
    if any(model.startswith(p) for p in _MAX_COMPLETION_TOKENS_PREFIXES):
        return {"max_completion_tokens": limit}
    return {"max_tokens": limit}


@dataclass
class LlmResult:
    data: Any
    model: str
    prompt_tokens: int | None
    completion_tokens: int | None


def chat_json(
    *,
    system: str,
    user: str,
    model: str | None = None,
    max_tokens: int = 2000,
    salvage_key: str | None = None,
) -> LlmResult:
    settings = get_settings()
    chosen = model or settings.openai_generate_model
    client = get_openai_client()
    token_param = _token_limit_param(chosen, max_tokens)
    # Bound total concurrent generation LLM calls per worker so fan-out shards
    # (cheatsheet/quiz/flashcards/…) can't saturate the OpenAI quota or the box.
    # The interactive stream path doesn't use chat_json, so it's never blocked.
    with llm_fanout_slot():
        resp = client.chat.completions.create(
            model=chosen,
            **token_param,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
        )
    choice = resp.choices[0] if resp.choices else None
    text = (choice.message.content if choice and choice.message else "") or ""
    try:
        parsed = _parse_json_lenient(text)
    except ValueError:
        # Likely truncated at max_tokens. If the caller named a salvage key,
        # recover its (possibly partial) string value instead of failing.
        if salvage_key:
            salvaged = _salvage_string_value(text, salvage_key)
            if salvaged:
                parsed = {salvage_key: salvaged}
            else:
                raise
        else:
            raise
    return LlmResult(
        data=parsed,
        model=chosen,
        prompt_tokens=resp.usage.prompt_tokens if resp.usage else None,
        completion_tokens=resp.usage.completion_tokens if resp.usage else None,
    )
