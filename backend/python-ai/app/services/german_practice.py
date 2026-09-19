"""General German practice generation (Wortschatz / Grammatik).

Deliberately independent of the German Exam Engine: no exam profile is needed,
so an A2 learner with no telc/TestDaF target still gets fresh AI practice.
Returns structured `german-practice-v1` items that the browser renders
directly — the browser never parses model text. Every item is validated here
(shape, blanks, answer keys) and invalid items are dropped, never shown.

Item field names intentionally mirror what the Wortschatz/Grammatik renderers
in frontend/views/practice/practice.js already consume (promptHtml, accepted,
options, answerIndex, note/rule, hints, ...).
"""

from __future__ import annotations

import html
import logging
import re
import uuid
from typing import Any

from ..supabase_client import get_supabase
from .llm_json import chat_json

log = logging.getLogger(__name__)

SCHEMA = "german-practice-v1"
# Learner target levels come from the profile catalog and include exam-specific
# values (TDN 4, DSH-2, DSD II (C1)) — accepted verbatim, not rejected.
MAX_LEVEL_LEN = 40
MODULES = ("vocabulary", "grammar")
_MAX_ATTEMPTS = 2
_MAX_SOURCE_CHARS = 12000
_MAX_SOURCE_CHUNKS = 60


class PracticeError(Exception):
    """Generation could not produce enough valid items."""


class SourceNotReadyError(PracticeError):
    """Selected documents have no indexed text yet."""


def _norm(s: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r'[.,!?;:"„“]', "", str(s if s is not None else "").lower())).strip()


def _str(v: Any, max_len: int = 400) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v[:max_len] if v else None


def _str_list(v: Any, max_items: int = 6) -> list[str]:
    if not isinstance(v, list):
        return []
    out = [s for s in (_str(x) for x in v) if s]
    return out[:max_items]


def _note(v: Any) -> dict[str, str] | None:
    if not isinstance(v, dict):
        return None
    out = {}
    for k in ("focus", "think", "why", "mainRule", "example"):
        s = _str(v.get(k), 600)
        if not s:
            return None
        out[k] = s
    return out


def _gap_prompt(v: Any) -> str | None:
    s = _str(v, 500)
    if not s or s.count("___") != 1:
        return None
    return s


def _accepted(v: Any) -> list[str]:
    seen: list[str] = []
    for a in _str_list(v, 8):
        n = _norm(a)
        if n and n not in seen:
            seen.append(n)
    return seen


def _options(v: Any, answer_index: Any) -> tuple[list[str], int] | None:
    opts = _str_list(v, 4)
    if len(opts) != 4 or len({_norm(o) for o in opts}) != 4:
        return None
    if not isinstance(answer_index, int) or isinstance(answer_index, bool) or not 0 <= answer_index < 4:
        return None
    return opts, answer_index


def _safe_strong(s: str) -> str:
    """Escape everything except <strong> tags (the renderer inserts this raw)."""
    return html.escape(s, quote=False).replace("&lt;strong&gt;", "<strong>").replace("&lt;/strong&gt;", "</strong>")


def _validate_vocab(raw: dict[str, Any]) -> dict[str, Any] | None:
    t = raw.get("type")
    note, hints = _note(raw.get("note")), _str_list(raw.get("hints"), 3)
    if not note or not hints:
        return None
    if t == "context":
        prompt, acc = _gap_prompt(raw.get("promptHtml")), _accepted(raw.get("accepted"))
        if not prompt or not acc:
            return None
        return {"type": t, "promptHtml": html.escape(prompt, quote=False), "accepted": acc, "note": note, "hints": hints}
    if t == "choice":
        prompt, oa = _gap_prompt(raw.get("promptHtml")), _options(raw.get("options"), raw.get("answerIndex"))
        if not prompt or not oa:
            return None
        return {"type": t, "promptHtml": html.escape(prompt, quote=False), "options": oa[0], "answerIndex": oa[1], "note": note, "hints": hints}
    if t == "use":
        word, meaning, prompt = _str(raw.get("word"), 80), _str(raw.get("meaning"), 120), _str(raw.get("promptHtml"), 300)
        if not (word and meaning and prompt):
            return None
        # 'use' prompts are rendered escaped by the client, so stay plain text.
        return {"type": t, "word": word, "meaning": meaning, "promptHtml": prompt, "note": note, "hints": hints}
    return None


def _validate_grammar(raw: dict[str, Any]) -> dict[str, Any] | None:
    t = raw.get("type")
    rule, hints = _note(raw.get("rule")), _str_list(raw.get("hints"), 3)
    if not rule or not hints:
        return None
    base: dict[str, Any] = {"type": t, "rule": rule, "hints": hints}
    if t == "order":
        words, answer = _str_list(raw.get("words"), 16), _str(raw.get("answer"), 300)
        if len(words) < 3 or not answer:
            return None
        if sorted(_norm(" ".join(words)).split()) != sorted(_norm(answer).split()):
            return None
        return {**base, "words": words, "answer": _norm(answer)}
    if t == "choice":
        prompt, oa = _gap_prompt(raw.get("promptHtml")), _options(raw.get("options"), raw.get("answerIndex"))
        if not prompt or not oa:
            return None
        return {**base, "promptHtml": html.escape(prompt, quote=False), "options": oa[0], "answerIndex": oa[1]}
    if t == "gap":
        prompt, acc = _gap_prompt(raw.get("promptHtml")), _accepted(raw.get("accepted"))
        if not prompt or not acc:
            return None
        return {**base, "promptHtml": html.escape(prompt, quote=False), "accepted": acc}
    if t == "transform":
        lines, prefix = _str_list(raw.get("originalLines"), 2), _str(raw.get("promptPrefix"), 200)
        acc, better = _accepted(raw.get("accepted")), _str(raw.get("betterAnswer"), 300)
        if not (lines and prefix and acc and better):
            return None
        return {**base, "originalLines": lines, "promptPrefix": prefix, "accepted": acc, "betterAnswer": better}
    if t == "combine":
        a, b, conn = _str(raw.get("sentenceA"), 300), _str(raw.get("sentenceB"), 300), _str(raw.get("connector"), 60)
        acc, display = _accepted(raw.get("accepted")), _str(raw.get("display"), 400)
        if not (a and b and conn and acc and display):
            return None
        return {**base, "sentenceA": a, "sentenceB": b, "connector": conn, "accepted": acc, "display": display}
    if t == "correct":
        wrong, acc, hc = _str(raw.get("sentenceWrong"), 300), _accepted(raw.get("accepted")), _str(raw.get("highlightCorrect"), 500)
        if not (wrong and acc and hc):
            return None
        return {**base, "sentenceWrong": wrong, "accepted": acc, "highlightCorrect": _safe_strong(hc)}
    return None


def _load_source_text(user_id: str, document_ids: list[str]) -> str:
    ids = list(dict.fromkeys(document_ids))[:5]
    sb = get_supabase()
    # Ownership is enforced here: only this user's documents are readable.
    docs = (
        sb.table("documents").select("id,active_index_revision")
        .eq("user_id", user_id).in_("id", ids).execute()
    ).data or []
    texts: list[str] = []
    for doc in docs:
        rows = (
            sb.table("document_chunks").select("chunk_text,chunk_index")
            .eq("document_id", doc["id"])
            .eq("index_revision", str(doc.get("active_index_revision") or ""))
            .order("chunk_index").range(0, _MAX_SOURCE_CHUNKS * 4).execute()
        ).data or []
        chunks = [str(r.get("chunk_text") or "").strip() for r in rows]
        chunks = [c for c in chunks if c]
        if len(chunks) > _MAX_SOURCE_CHUNKS:
            step = len(chunks) / _MAX_SOURCE_CHUNKS
            chunks = [chunks[int(i * step)] for i in range(_MAX_SOURCE_CHUNKS)]
        texts.extend(chunks)
    text = "\n\n".join(texts)
    if len(text.strip()) < 200:
        raise SourceNotReadyError("The selected file has no indexed text yet. Open Files to finish indexing it.")
    return text[:_MAX_SOURCE_CHARS]


_VOCAB_SPEC = (
    'Item types (use a varied mix):\n'
    '- "context": {"type","promptHtml" (German sentence with exactly one ___),"accepted" (array of lowercase answers),"note","hints"}\n'
    '- "choice": {"type","promptHtml" (exactly one ___),"options" (4 distinct German words),"answerIndex" (0-3),"note","hints"}\n'
    '- "use": {"type","word" (target German word),"meaning" (short English gloss),"promptHtml" (English instruction to write a sentence with it),"note","hints"}\n'
    '"note" = {"focus","think","why","mainRule","example"} (all short strings, explanations in English, example in German). '
    '"hints" = 2 short English strings.'
)
_GRAMMAR_SPEC = (
    'Item types (use a varied mix):\n'
    '- "order": {"type","words" (the sentence words, shuffled),"answer" (correct word order, space-joined),"rule","hints"}\n'
    '- "choice": {"type","promptHtml" (exactly one ___),"options" (4 distinct),"answerIndex" (0-3),"rule","hints"}\n'
    '- "gap": {"type","promptHtml" (exactly one ___),"accepted" (array, lowercase),"rule","hints"}\n'
    '- "transform": {"type","originalLines" (1-2 sentences),"promptPrefix" (start of the new sentence),"accepted" (lowercase full sentences),"betterAnswer","rule","hints"}\n'
    '- "combine": {"type","sentenceA","sentenceB","connector","accepted" (lowercase),"display","rule","hints"}\n'
    '- "correct": {"type","sentenceWrong" (one error),"accepted" (lowercase corrected sentence),"highlightCorrect" (corrected sentence, changed word in <strong>),"rule","hints"}\n'
    '"rule" = {"focus","think","why","mainRule","example"} (short; explanations in English, example in German). '
    '"hints" = 2 short English strings. "accepted" entries must have no punctuation.'
)


def _build_prompts(module: str, level: str, topic: str, count: int, source: str | None,
                   avoid: list[str], weak: list[str]) -> tuple[str, str]:
    what = "vocabulary-in-context" if module == "vocabulary" else "grammar"
    spec = _VOCAB_SPEC if module == "vocabulary" else _GRAMMAR_SPEC
    system = (
        f"You write fresh, correct German {what} exercises for language learners. "
        "German must be natural and every answer key must be unambiguous and verifiably correct. "
        'Reply with ONLY a JSON object: {"items":[...]}.'
    )
    parts = [
        f"Learner target level: {level}. Topic: {topic}. Write {count} exercises.",
        "Difficulty and vocabulary must match the level (TDN/DSH/DSD levels are exam levels — "
        "treat TDN 3 / DSH-1 as roughly B2 and TDN 4-5 / DSH-2-3 as C1 and above). "
        "Never write translation flashcards.",
        spec,
        f"Variation seed: {uuid.uuid4().hex[:8]} — do not reuse stock textbook sentences.",
    ]
    if weak:
        parts.append("The learner is weak in: " + ", ".join(weak[:5]) + ". Weight some exercises toward these.")
    if avoid:
        parts.append("Do NOT repeat these earlier prompts:\n- " + "\n- ".join(avoid[:30]))
    if source:
        parts.append("Base every exercise on words/structures actually found in this learner's document:\n" + source)
    return system, "\n\n".join(parts)


def generate_practice(
    *, user_id: str, module: str, level: str, topic: str, count: int,
    source_document_ids: list[str] | None = None,
    avoid_prompts: list[str] | None = None, weak_areas: list[str] | None = None,
) -> dict[str, Any]:
    if module not in MODULES:
        raise PracticeError("unsupported module")
    count = max(3, min(int(count), 15))
    source = _load_source_text(user_id, source_document_ids) if source_document_ids else None
    validate = _validate_vocab if module == "vocabulary" else _validate_grammar
    avoid = [a for a in (avoid_prompts or []) if isinstance(a, str)]
    avoid_norm = {_norm(a) for a in avoid}
    kept: list[dict[str, Any]] = []
    seen: set[str] = set(avoid_norm)
    for attempt in range(_MAX_ATTEMPTS):
        need = count - len(kept)
        system, user = _build_prompts(module, level, topic, need + 2, source, avoid + [_prompt_key(k) for k in kept], weak_areas or [])
        result = chat_json(system=system, user=user, max_tokens=6000)
        raw_items = result.data.get("items") if isinstance(result.data, dict) else None
        if not isinstance(raw_items, list):
            continue
        for raw in raw_items:
            item = validate(raw) if isinstance(raw, dict) else None
            if not item:
                continue
            key = _norm(_prompt_key(item))
            if key in seen:
                continue
            seen.add(key)
            item["id"] = uuid.uuid4().hex[:12]
            kept.append(item)
            if len(kept) >= count:
                break
        if len(kept) >= count:
            break
    if len(kept) < max(3, count // 2):
        log.warning("german_practice too few valid items module=%s kept=%s", module, len(kept))
        raise PracticeError("Could not create enough valid exercises.")
    return {
        "schema": SCHEMA, "module": module, "level": level, "topic": topic,
        "generationId": uuid.uuid4().hex, "source": "ai",
        "fromDocuments": bool(source), "items": kept[:count],
    }


def _prompt_key(item: dict[str, Any]) -> str:
    return str(item.get("promptHtml") or item.get("answer") or item.get("sentenceWrong")
               or item.get("sentenceA") or " ".join(item.get("originalLines") or []) or item.get("word") or "")
