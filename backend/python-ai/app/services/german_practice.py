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


class _Reject(Exception):
    """An item failed validation; ``code`` is a safe, content-free reason."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


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


def _note(v: Any, label: str = "note") -> dict[str, str]:
    if not isinstance(v, dict):
        raise _Reject(f"missing_{label}")
    out = {}
    for k in ("focus", "think", "why", "mainRule", "example"):
        s = _str(v.get(k), 600)
        if not s:
            raise _Reject(f"missing_{label}_{k}")
        out[k] = s
    return out


def _gap_prompt(v: Any) -> str:
    s = _str(v, 500)
    if not s:
        raise _Reject("missing_prompt")
    if s.count("___") != 1:
        raise _Reject("invalid_gap_count")
    return s


def _accepted(v: Any) -> list[str]:
    seen: list[str] = []
    for a in _str_list(v, 8):
        n = _norm(a)
        if n and n not in seen:
            seen.append(n)
    if not seen:
        raise _Reject("missing_accepted")
    return seen


def _options(v: Any, answer_index: Any) -> tuple[list[str], int]:
    opts = _str_list(v, 4)
    if len(opts) != 4:
        raise _Reject("invalid_options_count")
    if len({_norm(o) for o in opts}) != 4:
        raise _Reject("duplicate_options")
    if not isinstance(answer_index, int) or isinstance(answer_index, bool) or not 0 <= answer_index < 4:
        raise _Reject("invalid_answer_index")
    return opts, answer_index


def _safe_strong(s: str) -> str:
    """Escape everything except <strong> tags (the renderer inserts this raw)."""
    return html.escape(s, quote=False).replace("&lt;strong&gt;", "<strong>").replace("&lt;/strong&gt;", "</strong>")


def _check_vocab(raw: dict[str, Any]) -> dict[str, Any]:
    t = raw.get("type")
    if t not in ("context", "choice", "use"):
        raise _Reject("unknown_type")
    note = _note(raw.get("note"), "note")
    hints = _str_list(raw.get("hints"), 3)
    if not hints:
        raise _Reject("missing_hints")
    if t == "context":
        prompt, acc = _gap_prompt(raw.get("promptHtml")), _accepted(raw.get("accepted"))
        return {"type": t, "promptHtml": html.escape(prompt, quote=False), "accepted": acc, "note": note, "hints": hints}
    if t == "choice":
        prompt, oa = _gap_prompt(raw.get("promptHtml")), _options(raw.get("options"), raw.get("answerIndex"))
        return {"type": t, "promptHtml": html.escape(prompt, quote=False), "options": oa[0], "answerIndex": oa[1], "note": note, "hints": hints}
    word, meaning, prompt = _str(raw.get("word"), 80), _str(raw.get("meaning"), 120), _str(raw.get("promptHtml"), 300)
    if not (word and meaning and prompt):
        raise _Reject("missing_type_field")
    # 'use' prompts are rendered escaped by the client, so stay plain text.
    return {"type": t, "word": word, "meaning": meaning, "promptHtml": prompt, "note": note, "hints": hints}


def _validate_vocab(raw: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return _check_vocab(raw)
    except _Reject:
        return None


def _check_grammar(raw: dict[str, Any]) -> dict[str, Any]:
    t = raw.get("type")
    if t not in ("order", "choice", "gap", "transform", "combine", "correct"):
        raise _Reject("unknown_type")
    rule = _note(raw.get("rule"), "rule")
    hints = _str_list(raw.get("hints"), 3)
    if not hints:
        raise _Reject("missing_hints")
    base: dict[str, Any] = {"type": t, "rule": rule, "hints": hints}
    if t == "order":
        words, answer = _str_list(raw.get("words"), 16), _str(raw.get("answer"), 300)
        if len(words) < 3:
            raise _Reject("invalid_order_words")
        if not answer:
            raise _Reject("missing_type_field")
        if sorted(_norm(" ".join(words)).split()) != sorted(_norm(answer).split()):
            raise _Reject("order_answer_mismatch")
        return {**base, "words": words, "answer": _norm(answer)}
    if t == "choice":
        prompt, oa = _gap_prompt(raw.get("promptHtml")), _options(raw.get("options"), raw.get("answerIndex"))
        return {**base, "promptHtml": html.escape(prompt, quote=False), "options": oa[0], "answerIndex": oa[1]}
    if t == "gap":
        prompt, acc = _gap_prompt(raw.get("promptHtml")), _accepted(raw.get("accepted"))
        return {**base, "promptHtml": html.escape(prompt, quote=False), "accepted": acc}
    if t == "transform":
        lines, prefix = _str_list(raw.get("originalLines"), 2), _str(raw.get("promptPrefix"), 200)
        acc, better = _accepted(raw.get("accepted")), _str(raw.get("betterAnswer"), 300)
        if not (lines and prefix and better):
            raise _Reject("missing_type_field")
        return {**base, "originalLines": lines, "promptPrefix": prefix, "accepted": acc, "betterAnswer": better}
    if t == "combine":
        a, b, conn = _str(raw.get("sentenceA"), 300), _str(raw.get("sentenceB"), 300), _str(raw.get("connector"), 60)
        acc, display = _accepted(raw.get("accepted")), _str(raw.get("display"), 400)
        if not (a and b and conn and display):
            raise _Reject("missing_type_field")
        return {**base, "sentenceA": a, "sentenceB": b, "connector": conn, "accepted": acc, "display": display}
    wrong, hc = _str(raw.get("sentenceWrong"), 300), _str(raw.get("highlightCorrect"), 500)
    acc = _accepted(raw.get("accepted"))
    if not (wrong and hc):
        raise _Reject("missing_type_field")
    return {**base, "sentenceWrong": wrong, "accepted": acc, "highlightCorrect": _safe_strong(hc)}


def _validate_grammar(raw: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return _check_grammar(raw)
    except _Reject:
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


# ── Strict output schemas ────────────────────────────────────────────────────
# Shape enforcement lives HERE (OpenAI strict structured output); the
# _check_* validators remain the semantic/safety layer. A production failure
# (every item rejected as unknown_type) came from the prompt only saying
# {"type", ...} without the literal type names, so the model invented its own.
# tests/test_german_practice.py keeps schema and validators in agreement.
_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": {"type": "string"}}
_NOTE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["focus", "think", "why", "mainRule", "example"],
    "properties": {k: {"type": "string"} for k in ("focus", "think", "why", "mainRule", "example")},
}


def _variant(type_name: str, fields: dict[str, Any]) -> dict[str, Any]:
    props: dict[str, Any] = {"type": {"type": "string", "enum": [type_name]}}
    props.update(fields)
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def _items_schema(name: str, variants: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False, "required": ["items"],
        "properties": {"items": {"type": "array", "items": {"anyOf": variants}}},
        "title": name,
    }


_INT = {"type": "integer"}
_VOCAB_TAIL = {"note": _NOTE_SCHEMA, "hints": _STR_LIST}
_GRAMMAR_TAIL = {"rule": _NOTE_SCHEMA, "hints": _STR_LIST}
VOCAB_SCHEMA = _items_schema("vocabulary_items", [
    _variant("context", {"promptHtml": _STR, "accepted": _STR_LIST, **_VOCAB_TAIL}),
    _variant("choice", {"promptHtml": _STR, "options": _STR_LIST, "answerIndex": _INT, **_VOCAB_TAIL}),
    _variant("use", {"word": _STR, "meaning": _STR, "promptHtml": _STR, **_VOCAB_TAIL}),
])
GRAMMAR_SCHEMA = _items_schema("grammar_items", [
    _variant("order", {"words": _STR_LIST, "answer": _STR, **_GRAMMAR_TAIL}),
    _variant("choice", {"promptHtml": _STR, "options": _STR_LIST, "answerIndex": _INT, **_GRAMMAR_TAIL}),
    _variant("gap", {"promptHtml": _STR, "accepted": _STR_LIST, **_GRAMMAR_TAIL}),
    _variant("transform", {"originalLines": _STR_LIST, "promptPrefix": _STR, "accepted": _STR_LIST,
                           "betterAnswer": _STR, **_GRAMMAR_TAIL}),
    _variant("combine", {"sentenceA": _STR, "sentenceB": _STR, "connector": _STR, "accepted": _STR_LIST,
                         "display": _STR, **_GRAMMAR_TAIL}),
    _variant("correct", {"sentenceWrong": _STR, "accepted": _STR_LIST, "highlightCorrect": _STR, **_GRAMMAR_TAIL}),
])

_VOCAB_SPEC = (
    'Item types (use a varied mix):\n'
    '- "context": {"type":"context","promptHtml" (German sentence with exactly one ___),"accepted" (array of lowercase answers),"note","hints"}\n'
    '- "choice": {"type":"choice","promptHtml" (exactly one ___),"options" (4 distinct German words),"answerIndex" (0-3),"note","hints"}\n'
    '- "use": {"type":"use","word" (target German word),"meaning" (short English gloss),"promptHtml" (English instruction to write a sentence with it),"note","hints"}\n'
    '"note" = {"focus","think","why","mainRule","example"} (all short strings, explanations in English, example in German). '
    '"hints" = 2 short English strings.'
)
_GRAMMAR_SPEC = (
    'Item types (use a varied mix):\n'
    '- "order": {"type":"order","words" (the sentence words, shuffled),"answer" (correct word order, space-joined),"rule","hints"}\n'
    '- "choice": {"type":"choice","promptHtml" (exactly one ___),"options" (4 distinct),"answerIndex" (0-3),"rule","hints"}\n'
    '- "gap": {"type":"gap","promptHtml" (exactly one ___),"accepted" (array, lowercase),"rule","hints"}\n'
    '- "transform": {"type":"transform","originalLines" (1-2 sentences),"promptPrefix" (start of the new sentence),"accepted" (lowercase full sentences),"betterAnswer","rule","hints"}\n'
    '- "combine": {"type":"combine","sentenceA","sentenceB","connector","accepted" (lowercase),"display","rule","hints"}\n'
    '- "correct": {"type":"correct","sentenceWrong" (one error),"accepted" (lowercase corrected sentence),"highlightCorrect" (corrected sentence, changed word in <strong>),"rule","hints"}\n'
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


def _record_validation(module: str, attempt: int, raw_items: int, valid: int, rejected: dict[str, int]) -> None:
    """Aggregated, content-free validation outcome for one attempt."""
    from . import gen_timing  # noqa: WPS433
    entry = {"module": module, "attempt": attempt + 1, "rawItems": raw_items,
             "validItems": valid, "rejected": dict(sorted(rejected.items()))}
    log.info("german_practice_validation %s", entry)
    timer = gen_timing.current()
    if timer is not None:
        timer.add_validation(entry)


def generate_practice(
    *, user_id: str, module: str, level: str, topic: str, count: int,
    source_document_ids: list[str] | None = None,
    avoid_prompts: list[str] | None = None, weak_areas: list[str] | None = None,
) -> dict[str, Any]:
    if module not in MODULES:
        raise PracticeError("unsupported module")
    count = max(3, min(int(count), 15))
    source = _load_source_text(user_id, source_document_ids) if source_document_ids else None
    check = _check_vocab if module == "vocabulary" else _check_grammar
    avoid = [a for a in (avoid_prompts or []) if isinstance(a, str)]
    avoid_norm = {_norm(a) for a in avoid}
    kept: list[dict[str, Any]] = []
    seen: set[str] = set(avoid_norm)
    for attempt in range(_MAX_ATTEMPTS):
        need = count - len(kept)
        system, user = _build_prompts(module, level, topic, need + 2, source, avoid + [_prompt_key(k) for k in kept], weak_areas or [])
        result = chat_json(
            system=system, user=user, max_tokens=6000,
            json_schema=VOCAB_SCHEMA if module == "vocabulary" else GRAMMAR_SCHEMA,
        )
        raw_items = result.data.get("items") if isinstance(result.data, dict) else None
        rejected: dict[str, int] = {}
        if not isinstance(raw_items, list):
            _record_validation(module, attempt, 0, 0, {"items_not_a_list": 1})
            continue
        valid_this_attempt = 0
        for raw in raw_items:
            try:
                if not isinstance(raw, dict):
                    raise _Reject("item_not_object")
                item = check(raw)
            except _Reject as rej:
                rejected[rej.code] = rejected.get(rej.code, 0) + 1
                continue
            key = _norm(_prompt_key(item))
            if key in seen:
                rejected["duplicate_prompt"] = rejected.get("duplicate_prompt", 0) + 1
                continue
            valid_this_attempt += 1
            seen.add(key)
            item["id"] = uuid.uuid4().hex[:12]
            kept.append(item)
            if len(kept) >= count:
                break
        _record_validation(module, attempt, len(raw_items), valid_this_attempt, rejected)
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
