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

import base64
import json
import logging
import os
import re
from typing import Any, Generator

from .openai_client import get_openai_client

from ..config import get_settings
from ..supabase_client import get_supabase
from .access_control import heavy_model_cap_reached
from .answer_intent import (
    AcademicIntent,
    classify_academic_intent,
    wants_per_source_coverage,
)
from .answer import (
    DEFAULT_TUTOR_MODE,
    EQUATION_READABILITY_RULE,
    FIGURE_CHUNK_TYPES,
    MAX_PROMPT_CHUNKS,
    MINALLO_APP_CONTEXT,
    _APP_ONLY_SYSTEM_PROMPT,
    _build_context_block,
    detect_exam_style,
    exam_lint_blocking,
    exam_style_overlay,
    build_source_coverage_overlay,
    lint_exam_output,
    repair_exam_output,
    _cited_indices,
    strip_answer_intro,
    _context_strength,
    chat_completion_params,
    is_reasoning_model,
    is_app_question,
    normalise_tutor_mode,
    pick_system_prompt,
)
from .document_context import understanding_block_for_ids
from .retrieval import RetrievedChunk
from .storage import download_document_bytes
from .usage_meter import record_usage, usage_from_response
from .workspace_context import (
    ACTIONS_CONTRACT,
    EXAM_COACH_OVERLAY,
    QUIZ_CONTRACT,
    TUTOR_STRUCTURE_OVERLAY,
)

log = logging.getLogger(__name__)

FINAL_RESPONSE_LANGUAGE_RULE = """

FINAL RESPONSE-LANGUAGE RULE (highest priority): Answer entirely in the language
of the student's latest QUESTION below. Determine that language from the request
words and sentence structure. Ignore document text, earlier turns, interface
language, and quoted or referenced titles/labels such as "Aufgabe 13.1" when
choosing the response language. A question written in English must receive an
English answer even when the course material and technical terms are German.
"""


# Coverage-intent requests ("a question per file", exams) must let EVERY
# selected document reach the prompt. The default MAX_PROMPT_CHUNKS top-N
# clusters on a few high-score files, so the per-file coverage contract would
# only ever see those few. This ceiling bounds the coverage-aware selection so a
# very large selection still can't blow up the prompt token budget.
_COVERAGE_CHUNK_CEILING = 40

# Slides that look like title/agenda/info/QR/literature pages — not exam
# material. Used to push such chunks BEHIND a file's technical chunks so a file
# is represented by real content, and never judged (and skipped) from one info
# slide. Conservative: a chunk matching this is only DEPRIORITISED, never
# dropped, so a file whose only chunks are like this is still represented.
_NON_TECHNICAL_CHUNK_RE = re.compile(
    r"literaturverzeichnis|quellenverzeichnis|\bliteratur\b|\bquellen\b"
    r"|inhaltsverzeichnis|\bagenda\b|organisatorisch|qr[-\s]?code|studing"
    r"|infoabend|info-?veranstaltung|anmeldung|herzlich\s+willkommen"
    r"|viel\s+erfolg|gliederung\s+der\s+vorlesung|vorstellung\s+der",
    re.IGNORECASE,
)


def _looks_non_technical(text: str) -> bool:
    return bool(_NON_TECHNICAL_CHUNK_RE.search(text or ""))


def _coverage_chunk_selection(chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
    """Feed the prompt MULTIPLE, technical-first chunks per selected document.

    One chunk per file is dangerous for exam coverage: if the single chunk a
    file contributes happens to be its title/info/QR/literature slide, the model
    judges the whole file as non-technical and skips it ("entfällt"). So group
    by document, order each file's chunks technical-first (info/literature slides
    last but NOT dropped — a file with only such chunks is still represented),
    and take a few per file via round-robin so every selected file is
    represented by REAL content before any file gets a second chunk. Bounded by
    ``_COVERAGE_CHUNK_CEILING`` to keep the prompt token-safe.
    """
    by_doc: dict[str, list[RetrievedChunk]] = {}
    order: list[str] = []
    for c in chunks:
        doc_id = c.document_id or ""
        if doc_id not in by_doc:
            by_doc[doc_id] = []
            order.append(doc_id)
        by_doc[doc_id].append(c)
    # Stable sort (0 = technical, 1 = non-technical) keeps score order within
    # each group, so a file's best technical chunk leads.
    for doc_id in by_doc:
        by_doc[doc_id].sort(key=lambda c: 1 if _looks_non_technical(c.text) else 0)

    n_docs = max(1, len(by_doc))
    # Ceil division: richer per-file context when few files are selected, ~3
    # when many. Three slides per file is enough for the model to see real
    # content even if one of them is an info/title slide.
    per_doc = max(3, -(-MAX_PROMPT_CHUNKS // n_docs))
    selected: list[RetrievedChunk] = []
    seen: set[int] = set()
    for rank in range(per_doc):
        for doc_id in order:
            if len(selected) >= _COVERAGE_CHUNK_CEILING:
                break
            cs = by_doc[doc_id]
            if rank < len(cs) and id(cs[rank]) not in seen:
                selected.append(cs[rank])
                seen.add(id(cs[rank]))
    return selected


# ── Figure vision: let the tutor SEE the exercise drawing ─────────────────────
#
# Engineering exercises put most of their data — lengths, diameters, the shape
# of the part, which dimension is l_K vs l_i — in a FIGURE. OCR flattens that
# badly (labels survive, spatial layout and dimension lines do not). When the
# pipeline is solving a math/exercise question we therefore render the actual
# page bitmap of the retrieved exercise/figure pages and attach it to the
# (vision-capable) strong model alongside the OCR text chunks, so it can read
# values straight off the drawing. Best-effort: any failure attaches no image.
# Imported from .answer so the math-mode gate and the figure-attach gate
# agree on what counts as a figure-bearing chunk.
_FIGURE_CHUNK_TYPES = FIGURE_CHUNK_TYPES
# Engineering drawings pack the answer into small dimension-line numerals
# (l_K, plate thicknesses, ⌀ values). 150 DPI rendered them too small for the
# vision model to read reliably — it would "see" the figure but still report
# l_K as not visible. 220 DPI keeps an A4 page well under gpt-4o's pixel limit
# while making those numerals legible.
_FIGURE_RENDER_DPI = 220
_MAX_ATTACHED_IMAGES = 2  # hard cap on open-file + figure images per request

# Instruction appended to the user turn when an exercise/figure page image is
# attached. Deliberately exhaustive: engineering figures pack the bulk of the
# problem data (every diameter, length, wall thickness, thread, hole size,
# section view) and the model otherwise reads only the one or two values the
# question names. Force a full inventory of the drawing BEFORE solving.
_FIGURE_READ_INSTRUCTION = (
    "\n\nEXERCISE FIGURE — READ IT EXHAUSTIVELY. The attached page image(s) are"
    " from the exercise itself, and most of the data lives in the drawing, not in"
    " the surrounding text. BEFORE you solve, inventory the figure completely:\n"
    "- List EVERY labelled value you can see: every diameter (⌀ / Ø), every length"
    " and wall thickness, every thread designation (e.g. M24), every bore/hole"
    " diameter, every angle, and every symbol (l_K, l_i, d, D_A, …). Read small"
    " dimension-line numbers carefully; do not skip any.\n"
    "- Use the section views and hatching to tell clamped parts apart: stacked"
    " thicknesses are the individual clamped-plate lengths (their sum is the"
    " clamping length l_K); concentric circles are different diameters (outer"
    " diameter, bolt-circle, bore, through-hole).\n"
    "- Map each figure value to the correct symbol in your formula, then treat it"
    " as a given and cite the source page. Only declare a value missing if it is"
    " genuinely absent from BOTH the text and the figure.\n"
    "Then proceed with the normal Given/Required/Formula/Substitution/Calculation"
    " structure, substituting the figure values."
)


def _figure_vision_enabled() -> bool:
    return os.getenv("MINALLO_FIGURE_VISION", "1").strip().lower() not in ("0", "false", "no", "off")


def _figure_page_image_parts(
    used_chunks: list[RetrievedChunk],
    *,
    max_images: int,
) -> list[dict[str, Any]]:
    """Render page image(s) for the retrieved exercise/figure pages.

    Returns OpenAI ``image_url`` content blocks (same shape as
    ``_open_file_image_parts``). Exercise/figure-typed chunks are preferred;
    deduped by (document, page). Never raises — a missing storage path,
    absent render deps, or a download error just yields fewer/no images.
    """
    if max_images <= 0 or not _figure_vision_enabled():
        return []
    # Figure/exercise chunks first, then the rest in retrieval rank order.
    figure_first = [c for c in used_chunks if (c.chunk_type or "") in _FIGURE_CHUNK_TYPES]
    rest = [c for c in used_chunks if c not in figure_first]
    candidates: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for c in figure_first + rest:
        if getattr(c, "is_synthetic", False):
            continue
        doc_id = c.document_id
        if not doc_id or doc_id.startswith("__"):
            continue
        # Consider both ends of the chunk's page span: a "pp.1-3" exercise
        # chunk often has its statement on the first page and the figure on
        # the last, so rendering only page_start would miss the drawing.
        pages = [p for p in (c.page_start, c.page_end) if p]
        for page in pages:
            key = (doc_id, int(page))
            if key in seen:
                continue
            seen.add(key)
            candidates.append(key)
            if len(candidates) >= max_images:
                break
        if len(candidates) >= max_images:
            break
    if not candidates:
        log.info("figure-vision: no renderable candidates among %d chunk(s)", len(used_chunks))
        return []

    try:
        from .vision_ocr import _render_page_to_png, _try_import_pypdfium2  # noqa: WPS433
    except Exception:  # noqa: BLE001
        log.warning("figure-vision: could not import render helpers", exc_info=True)
        return []
    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        log.warning("figure-vision: pypdfium2 not importable — no figure will be attached")
        return []

    try:
        resp = (
            get_supabase().table("documents")
            .select("id, storage_path")
            .in_("id", list({d for d, _ in candidates}))
            .execute()
        )
        paths = {r["id"]: r.get("storage_path") for r in (resp.data or []) if r.get("storage_path")}
    except Exception:  # noqa: BLE001
        log.exception("figure-vision: storage_path lookup failed")
        return []

    parts: list[dict[str, Any]] = []
    pdf_cache: dict[str, bytes | None] = {}
    for doc_id, page in candidates:
        sp = paths.get(doc_id)
        if not sp:
            continue
        if doc_id not in pdf_cache:
            try:
                pdf_cache[doc_id] = download_document_bytes(sp)
            except Exception:  # noqa: BLE001
                log.exception("figure-vision: download failed doc=%s", doc_id)
                pdf_cache[doc_id] = None
        pdf_bytes = pdf_cache[doc_id]
        if not pdf_bytes:
            continue
        png = _render_page_to_png(pdfium, pdf_bytes, page - 1, _FIGURE_RENDER_DPI)
        if not png:
            continue
        b64 = base64.b64encode(png).decode("ascii")
        parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
        if len(parts) >= max_images:
            break
    log.info(
        "figure-vision: attached %d/%d candidate page image(s) at %d DPI",
        len(parts), len(candidates), _FIGURE_RENDER_DPI,
    )
    return parts

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
    r"(first|second|third|next|previous|current|last)\s+(problem|exercise|task|question|aufgabe|uebung)|"
    r"(answer|solve|do|calculate|compute)\s+(it|this|that)|"
    r"explain this|what does this|what is this|summari[sz]e (this|the section|the page)|"
    r"dies(e[rs]?|es)?|jene[rs]?|hier|oben|unten|"
    r"diese (formel|seite|aufgabe|stelle|gleichung|abschnitt)|"
    r"(erste|zweite|dritte|naechste|vorherige|aktuelle|letzte)\s+(aufgabe|uebung|frage)|"
    r"(loese|beantworte|mach|berechne)\s+(es|das|dies|diese|sie)|"
    r"was bedeutet (das|dies|diese)|was steht (hier|oben|unten|dort)|"
    r"erklär(e|ung)? (mir )?(dies|das|diese|hier|oben)|"
    r"zusammenfass"
    r")\b",
    re.IGNORECASE,
)


def _is_deictic_question(q: str) -> bool:
    return bool(_DEICTIC_QUESTION_RE.search(q or ""))


def _intent_resolution_runtime_overlay(
    question: str,
    *,
    has_visible_context: bool,
    has_history: bool,
    active_file_name: str | None,
) -> str:
    """Dynamic guardrail for context-dependent requests.

    Static prompt rules say "do not guess"; this runtime note tells the
    model whether "this/it/first problem" can actually be resolved in the
    current request.
    """
    if (question or "").lstrip().lower().startswith(
        "continue the previous calculation using this user-provided missing information:"
    ):
        return (
            "\n\nInteractive-input continuation note: the current user message is the "
            "student's direct response to the missing-context popup. Treat every supplied "
            "field as newly available context for the calculation. Resume from the previous "
            "assistant setup in chat history and finish the requested solution now. Do not "
            "repeat the missing-context refusal or emit another popup for an item the student "
            "just supplied. Ask again only if a different, genuinely required item is still "
            "missing, and name that item exactly."
        )
    if not _is_deictic_question(question):
        return (
            "\n\nIntent-resolution note: answer the student's exact request. "
            "Do not substitute a different exercise, file, or topic just "
            "because retrieved chunks mention it."
        )
    visible_name = active_file_name or "the currently visible PDF"
    if has_visible_context:
        return (
            "\n\nIntent-resolution note: the student's wording is context-dependent "
            "('this', 'it', 'first problem', or similar). Resolve it to [Source 0], "
            f"the visible content from {visible_name}. If the student asks for the "
            "first/second/next problem, use the order in [Source 0] / the current "
            "page. Retrieved chunks are only supporting material; they must not "
            "replace the visible problem."
        )
    if has_history:
        return (
            "\n\nIntent-resolution note: the student's wording is context-dependent "
            "and no visible PDF source was attached. Resolve 'it/this/that' from "
            "the recent chat history first. If history is still insufficient, ask "
            "one concrete clarification instead of guessing."
        )
    return (
        "\n\nIntent-resolution note: the student's wording is context-dependent, "
        "but no visible PDF context or usable chat history was attached. Do not "
        "guess which file/problem they mean. Ask one concrete clarification such "
        "as: 'Which file/page or exercise number should I solve?'"
    )


def _effective_strength_with_open_context(strength: str, should_promote: bool) -> str:
    """Promote a request with visible PDF text to answerable context.

    RAG can miss an exercise even when the user has it open in the PDF. If the
    frontend sends a focused visible-page excerpt, treat that excerpt as
    grounding and use retrieved chunks as supporting material.
    """
    return "strong" if should_promote else strength


def _open_file_image_parts(open_file_images: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Convert validated visible-PDF images into OpenAI chat content blocks."""
    parts: list[dict[str, Any]] = []
    for img in (open_file_images or [])[:2]:
        media_type = str(img.get("mediaType") or "image/jpeg").strip() or "image/jpeg"
        data = str(img.get("data") or "").strip()
        if not data:
            continue
        parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:{media_type};base64,{data}"},
        })
    return parts


# Conversation-continuity tuning. Earlier values (6 messages / 2k chars)
# were too tight — students hit cases where the AI forgot the answer it
# gave 5–10 turns ago and gave "some bullshit" follow-up instead. Raised
# to 30 messages / 12k chars to cover ~15 Q/A pairs comfortably. Per-turn
# cap kept at 1200 so a single rambling AI reply can't eat the budget.
_MAX_HISTORY_MESSAGES = 30       # ~15 Q/A pairs
_MAX_HISTORY_CHARS    = 12000    # safety cap on total prior text
_MAX_TURN_CHARS       = 1200     # any one turn is truncated to this


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


def _meter_text_len(content: Any) -> int:
    """Char count of the TEXT in an OpenAI message content (str or parts list).

    Image parts are excluded on purpose: they are billed per tile, and counting
    their base64 payload would inflate an abort-metering estimate by orders of
    magnitude.
    """
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(p.get("text") or "")
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return 0


from .diagram_overlay import diagram_overlay as _diagram_overlay
from .diagram_overlay import wants_diagram as _wants_diagram
from .diagram_overlay import wants_plot as _wants_plot


# JSON schema for the structured-output fallback call that recovers from a
# diagram-refusal. Mirrors the fenced ``minallo-diagram`` shape consumed by
# ai-markdown.ts so the fallback fence is renderer-compatible without any
# frontend changes.
_DIAGRAM_JSON_SCHEMA = {
    "name": "minallo_diagram",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "caption", "nodes", "edges", "labels"],
        "properties": {
            "title": {"type": "string"},
            "caption": {"type": "string"},
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "label", "shape"],
                    "properties": {
                        "id": {"type": "string"},
                        "label": {"type": "string"},
                        "shape": {
                            "type": "string",
                            "enum": ["rect", "circle", "triangle", "ground", "arrow"],
                        },
                    },
                },
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["from", "to", "label"],
                    "properties": {
                        "from": {"type": "string"},
                        "to": {"type": "string"},
                        "label": {"type": "string"},
                    },
                },
            },
            "labels": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["text"],
                    "properties": {"text": {"type": "string"}},
                },
            },
        },
    },
}


def _force_render_diagram(
    client: Any,
    model: str,
    question: str,
    used_chunks: list[Any],
    open_ctx: str | None,
) -> str | None:
    """Refusal-recovery for diagram requests.

    When the streamed answer didn't contain a ``minallo-diagram`` fence
    (typically because gpt-4o's RLHF refused with "I can't draw images")
    we re-ask the same model with response_format=json_schema. Structured
    outputs constrain the response shape so the refusal path is closed
    off — the model has no choice but to produce the diagram JSON.

    Returns the fenced markdown to append (with leading newlines), or
    None if the fallback itself errored.
    """
    log.debug("[DIAGRAM_DEBUG] _force_render_diagram entered model=%s", model)
    try:
        ctx_lines: list[str] = []
        if open_ctx:
            ctx_lines.append("CURRENTLY VISIBLE PDF TEXT:\n" + open_ctx[:1500])
        for i, c in enumerate(used_chunks[:4], start=1):
            text = getattr(c, "text", "") or ""
            ctx_lines.append(f"[Source {i}]\n{text[:600]}")
        context_blob = "\n\n".join(ctx_lines) if ctx_lines else "(no course context available)"

        sys = (
            "You are a diagram data generator. The student asked for a diagram. "
            "Produce a single diagram object matching the schema. Use simple labels "
            "(<= 40 chars). Match the language of the question. If course context "
            "is provided, ground the diagram in it; otherwise produce a standard "
            "conceptual diagram and label the caption as 'Conceptual diagram "
            "(general knowledge).'"
        )
        user = (
            f"Question: {question}\n\n"
            f"Context:\n{context_blob}\n\n"
            "Return the diagram object only."
        )
        completion = client.chat.completions.create(
            model=model,
            response_format={"type": "json_schema", "json_schema": _DIAGRAM_JSON_SCHEMA},
            messages=[
                {"role": "system", "content": sys},
                {"role": "user", "content": user},
            ],
        )
        record_usage(feature="ask_stream_diagram", model=model, **usage_from_response(completion))
        raw = (completion.choices[0].message.content or "").strip()
        log.debug("[DIAGRAM_DEBUG] structured call returned raw_len=%d", len(raw))
        if not raw:
            log.debug("[DIAGRAM_DEBUG] empty content -> None")
            return None
        parsed = json.loads(raw)
        node_count = len(parsed.get("nodes", [])) if isinstance(parsed, dict) else 0
        log.debug("[DIAGRAM_DEBUG] parsed nodes=%d", node_count)
        if not isinstance(parsed, dict) or not parsed.get("nodes"):
            return None
        return "\n\n```minallo-diagram\n" + raw + "\n```\n"
    except Exception as e:  # noqa: BLE001
        log.exception("force_render_diagram fallback failed")
        return None


_PROBLEM_SOLVER_MODES = {"hint", "setup", "check", "solve", "practice"}


# JSON schema for the structured-output fallback that produces continuous
# 2D plots (stress-strain curves, characteristic curves, etc.). Mirrors
# the shape consumed by ai-markdown.ts:renderPlot. Distinct from the
# graph schema in _DIAGRAM_JSON_SCHEMA — the model picks per request.
_PLOT_JSON_SCHEMA = {
    "name": "minallo_plot",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "caption", "xAxis", "yAxis", "series", "markers"],
        "properties": {
            "title": {"type": "string"},
            "caption": {"type": "string"},
            "xAxis": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "unit"],
                "properties": {
                    "label": {"type": "string"},
                    "unit": {"type": "string"},
                },
            },
            "yAxis": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "unit"],
                "properties": {
                    "label": {"type": "string"},
                    "unit": {"type": "string"},
                },
            },
            "series": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["label", "points"],
                    "properties": {
                        "label": {"type": "string"},
                        "points": {
                            "type": "array",
                            "items": {
                                "type": "array",
                                "items": {"type": "number"},
                            },
                        },
                    },
                },
            },
            "markers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["x", "y", "label"],
                    "properties": {
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "label": {"type": "string"},
                    },
                },
            },
        },
    },
}


def _force_render_plot(
    client: Any,
    model: str,
    question: str,
    used_chunks: list[Any],
    open_ctx: str | None,
) -> str | None:
    """Refusal-recovery for plot-style requests. Same idea as
    ``_force_render_diagram`` but targeting continuous curves. The
    structured-output schema forces the model to produce series of
    (x, y) points it can sample from the canonical curve shape."""
    log.debug("[PLOT_DEBUG] _force_render_plot entered model=%s", model)
    try:
        ctx_lines: list[str] = []
        if open_ctx:
            ctx_lines.append("CURRENTLY VISIBLE PDF TEXT:\n" + open_ctx[:1500])
        for i, c in enumerate(used_chunks[:4], start=1):
            text = getattr(c, "text", "") or ""
            ctx_lines.append(f"[Source {i}]\n{text[:600]}")
        context_blob = "\n\n".join(ctx_lines) if ctx_lines else "(no course context available)"

        sys = (
            "You are a plot data generator. The student asked for a 2D function "
            "plot (a curve, not a flow diagram). Produce a single plot object "
            "matching the schema. Sample 8-20 points per series along the "
            "canonical curve shape so the polyline looks smooth. Include "
            "markers for any named feature points (yield point, peak, "
            "inflection, etc.). Match the language of the question. If course "
            "context is provided, ground numeric ranges in it; otherwise use "
            "standard textbook values and label the caption 'Conceptual plot "
            "(general knowledge).'"
        )
        user = (
            f"Question: {question}\n\n"
            f"Context:\n{context_blob}\n\n"
            "Return the plot object only."
        )
        completion = client.chat.completions.create(
            model=model,
            response_format={"type": "json_schema", "json_schema": _PLOT_JSON_SCHEMA},
            messages=[
                {"role": "system", "content": sys},
                {"role": "user", "content": user},
            ],
        )
        record_usage(feature="ask_stream_plot", model=model, **usage_from_response(completion))
        raw = (completion.choices[0].message.content or "").strip()
        log.debug("[PLOT_DEBUG] structured call returned raw_len=%d", len(raw))
        if not raw:
            return None
        parsed = json.loads(raw)
        series = parsed.get("series", []) if isinstance(parsed, dict) else []
        valid_series = sum(1 for s in series if isinstance(s, dict) and len(s.get("points", [])) >= 2)
        log.debug("[PLOT_DEBUG] series_count=%d valid=%d", len(series), valid_series)
        if valid_series == 0:
            return None
        return "\n\n```minallo-plot\n" + raw + "\n```\n"
    except Exception as e:  # noqa: BLE001
        log.exception("force_render_plot fallback failed")
        return None


def _normalise_problem_solver_mode(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    mode = value.strip().lower()
    return mode if mode in _PROBLEM_SOLVER_MODES else None


def _problem_solver_user_block(problem_solver: dict[str, Any]) -> str:
    problem = str(problem_solver.get("problem") or "").strip()
    student_work = str(problem_solver.get("studentWork") or "").strip()
    parts = [
        "\n\nPROBLEM SOLVER INPUT:",
        "Problem statement:",
        problem,
    ]
    if student_work:
        parts.extend(["", "Student work to check:", student_work])
    return "\n".join(parts)


def _problem_solver_source(problem_solver: dict[str, Any] | None) -> str:
    """Return the pasted/typed problem statement as primary grounding text."""
    if not problem_solver:
        return ""
    return str(problem_solver.get("problem") or "").strip()[:12000]


def _problem_solver_overlay(mode: str, problem_solver: dict[str, Any]) -> str:
    has_work = bool(str(problem_solver.get("studentWork") or "").strip())
    common = """

PROBLEM SOLVER MODE.
You are helping a university student work through a problem. Treat the
PROBLEM SOLVER INPUT as the task to answer. Use COURSE CONTEXT as ground truth
for formulas, notation, assumptions, code conventions, and source citations.
If [Source 0] contains a Problem Solver problem statement, that statement is
the primary source of truth. Cite it for the givens/required quantities and do
not replace it with a different retrieved exercise, even if the retrieved
exercise looks similar.
Equation-copying is strict: preserve every symbol, subscript, denominator,
constant, final condition, and domain exactly from [Source 0]. Do not turn
`\\pi` / `π` into a new variable `p`; do not change `r(\\phi)=R\\phi/\\pi`
into `R\\theta/p`; do not introduce a symbol and then claim it is missing
unless it actually appears in the problem statement or cited course source.
You MUST still use uploaded course sources when they are present in COURSE
CONTEXT. Cite at least one uploaded course source (`[Source 1]` or higher) for
the formula, method, or matching course convention. If no uploaded course source
was retrieved, say that explicitly and mark the answer as only generally
derived from the problem statement rather than verified by course material.

FIRST decide the problem TYPE from the PROBLEM SOLVER INPUT text:
  * ENGINEERING / MATH (formulas, numeric values, units, derivations, proofs)
    → use the 7-step ENGINEERING structure below.
  * CODE / CS (asks to implement, debug, trace, analyse, or explain code;
    contains code blocks; mentions algorithms, data structures, syntax,
    complexity, "function", "class", "compile", "runtime")
    → use the 5-step CODE structure below instead.
When the problem mixes both (e.g. "implement Newton's method"), prefer the
CODE structure and embed any math inside it.

ENGINEERING / MATH structure:
1. Given
2. Find
3. Relevant concepts
4. Formula choice
5. Work
6. Unit check
7. Common mistake

CODE / CS structure:
1. Problem (one-line restatement)
2. Approach (1-3 sentences of strategy — pick the data structures / algorithms)
3. Code (one or more triple-backtick fenced blocks with language tag)
4. Trace (walk through a small example input → output)
5. Complexity (time and space; say "not applicable" if it doesn't fit)

Rules:
- For math problems: extract all numeric values and units before solving. State missing data explicitly before making assumptions.
- For setup/check/solve modes on math or engineering problems, follow the equation readability rule below.
- For code problems: write code in triple-backtick fences with a language tag (```python, ```java, ```c, ```sql, ...). Inline identifiers, function names, paths in `single backticks`. Preserve indentation exactly. NEVER wrap code in `$...$` math delimiters.
- Cite source material with [Source N] tags exactly as the base prompt requires.
- Do not invent course-specific formulas, APIs, or library functions. If the needed material is absent, say what is missing.
- LANGUAGE OVERRIDE (highest priority): Reply in the language used in the student's latest question. Source documents, pasted text, earlier turns, and interface language must not determine the response language. Support any language and writing system, including Arabic and other right-to-left scripts. Translate section headings into the latest-question language too.
""" + EQUATION_READABILITY_RULE
    mode_rules = {
        "hint": """

Selected mode: HINT.
Skip both the 7-step and the 5-step structures for this mode — use the hint
ladder below instead. Do not reveal the final answer, full derivation, or
working code. Give a hint ladder with:
- Hint 1: what to identify first (key variable / data structure / formula family)
- Hint 2: which principle / algorithm / formula family applies
- Hint 3: how to start the setup (engineering) or the first 1-2 lines of code (CS)
End with one focused question for the student. No final numeric result and no complete function body.

CONTINUING THE HINT LADDER ACROSS TURNS.
When the previous assistant turn already contains "Hint 1 / Hint 2 / Hint 3 /
Focused Question" and the student's new message is a reply to that focused
question (typical replies: "I don't know", "idk", "stuck", "yes", "no",
"weiter", "why?", their attempt, a partial answer, or a clarifying question),
DO NOT collapse the dialogue into a flat textbook explanation or a full
worked solution. Continue the Socratic ladder:

  * Briefly acknowledge their reply (one sentence — e.g. "No problem, let's
    take a smaller step." / "Good — and then?" / "Almost — see below.").
  * Give the NEXT level of hints, numbered as Hint 4, Hint 5, Hint 6
    (continuing the count from the previous turn, not resetting). Each new
    hint should be SMALLER / MORE CONCRETE than the previous ones — narrow
    the gap a little, don't jump straight to the answer.
  * If the student said "I don't know" / "stuck": go finer-grained — name
    the specific substitution or transform they should apply, but still
    leave the final arithmetic / final line of code for them.
  * If the student attempted something: point out the FIRST place it goes
    off track, ask them to fix that one thing, do NOT rewrite the rest.
  * End with another single focused question that targets the very next
    micro-step.
  * Still no final numeric answer and no complete code body — that's the
    SOLVE mode, not HINT.

The hint ladder ends ONLY when the student has demonstrably solved it
themselves OR they explicitly ask for the full solution.
""",
        "setup": """

Selected mode: SETUP.
Stop after the SETUP. For math: Given / Find / assumptions, formula choice with
defined symbols, equations to solve, no arithmetic. For code: Problem
restatement / Approach / function signature(s) and skeleton with `# TODO`
markers where the real logic goes. Do not complete the implementation.
""",
        "check": """

Selected mode: CHECK MY WORK.
First inspect the student's submitted work. If no student work was provided,
ask them to paste their attempt and give only a starting checklist. If work was
provided, identify the FIRST incorrect or risky step (math: wrong formula /
unit / sign; code: off-by-one, wrong type, missing edge case, broken loop
invariant), explain why, and provide the corrected next step. Do not replace
the whole attempt with a full solution unless the work is already essentially
complete.
""",
        "solve": """

Selected mode: FULL SOLUTION.
Give a complete worked solution. For math: symbolic formula → numeric
substitution → intermediate result → final answer with units → short
plausibility check. For code: complete working implementation in a fenced
block, a Trace through one example, and a Complexity line.
FULL SOLUTION means finish the computation, not merely describe the method.
Never end a Full Solution with "this provides the basis", "solve v(t)", "can
be determined", or other method-only placeholders. If the statement gives a
complete symbolic problem, finish symbolically even when no decimal numbers are
given.
For engineering/math tasks:
- If all required numeric inputs are present in the PROBLEM SOLVER INPUT or
  COURSE CONTEXT, you MUST carry out the arithmetic and end with a visibly
  boxed final answer, e.g. `$$\\boxed{...}$$`.
- Do not end with "insert the values", "use the formulas", "if the values are
  known", "please provide the lengths", or similar placeholders when the
  required values are available in the visible problem/context.
- If a final numeric answer is impossible because a required INPUT value the
  STUDENT could supply is missing (not derivable, not in the problem text, not
  visible in an attached figure), do NOT just list it as a placeholder — show
  the minimal setup that identifies it, then emit a `minallo-input` block to
  ask the student for it and STOP (see the "Interactive missing input" rule in
  the base prompt). Set confidence to "Partially verified — awaiting user
  input"; on the follow-up turn, continue and finish numerically.
- If a final numeric answer is impossible for any OTHER reason, write a short
  "Cannot finish numerically" section and list the exact missing quantities by
  symbol/name (for example `l_i`, `A_i`, `A_ers`, `d_h`) and where they should
  come from. Do not present this as a full solution and do not label confidence high.
- When the student explicitly says "mach weiter", "finale Loesung",
  "rechnerisch", "calculate it", or "give the final answer", treat that as a
  demand for the completed arithmetic. Continue from the previous turn's setup
  and produce the final result if the missing values are already available in
  the conversation or sources.
""",
        "practice": """

Selected mode: PRACTICE.
Generate three similar practice problems based on the same concept: 1 easier,
1 similar, 1 harder. For math: include brief solution outlines + final answers
only when the COURSE CONTEXT supports the required formulas. For code: include
a one-line problem statement plus a small example input/output for each, and
optional starter signatures — do not provide full solution code (the student
should attempt them).
""",
    }
    if mode == "check" and not has_work:
        return common + mode_rules[mode] + "\nThe request has no student work attached."
    return common + mode_rules.get(mode, "")


def stream_answer(
    *,
    question: str,
    chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
    model: str | None = None,
    max_tokens: int = 2500,
    active_file_name: str | None = None,
    open_file_context: str | None = None,
    open_file_images: list[dict[str, Any]] | None = None,
    tutor_mode: str = DEFAULT_TUTOR_MODE,
    weak_topics: list[str] | None = None,
    previous_turns: list[dict[str, str]] | None = None,
    problem_solver: dict[str, str] | None = None,
    workspace_block: str | None = None,
    assistant_mode: str | None = None,
    workspace_question: bool = False,
    user_id: str | None = None,
    selected_file_names: list[str] | None = None,
    selected_document_ids: list[str] | None = None,
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

    # App-question fast path: skip retrieved context entirely, swap to an
    # app-only system prompt + MINALLO_APP_CONTEXT, return without [Source N]
    # citations. Routes "where is settings", "what features does Minallo
    # have", "is there a game room" away from the RAG pipeline so the model
    # can't pattern-match course chunks into a generic-study-app reply.
    app_question = is_app_question(question)
    # Workspace questions ("where are my flashcards", "what can I do in this
    # course") are answered from the LIVE WORKSPACE block, not lecture chunks —
    # same fast path as app questions.
    if workspace_question:
        app_question = True

    strength = _context_strength(chunks)
    # Coverage-intent requests ("a question per file", exams) must keep one
    # chunk per selected document, NOT the top-MAX_PROMPT_CHUNKS by score — the
    # latter clusters on a few high-relevance files and the per-file coverage
    # overlay (build_source_coverage_overlay) would then require only as many
    # sections as those few files. Exam/coverage detection is keyword-based and
    # chunk-independent, so it's safe to classify here before academic_intent.
    wants_full_coverage = not app_question and (
        wants_per_source_coverage(question)
        or classify_academic_intent(question) == AcademicIntent.EXAM_GENERATION
    )
    # Review fix #3 — partial retrieval mode. Mirrors answer.py's logic:
    #   strong → top MAX_PROMPT_CHUNKS    weak → top 3 (PARTIAL prompt)    none → []
    if app_question:
        used_chunks = []
    elif wants_full_coverage and chunks:
        used_chunks = _coverage_chunk_selection(chunks)
    elif strength == "strong":
        used_chunks = chunks[:MAX_PROMPT_CHUNKS]
    elif strength == "weak":
        used_chunks = chunks[:3]
    else:
        used_chunks = []

    # For app/product questions, also drop the open-file context and any
    # page images. Otherwise the model still sees the open PDF as
    # [Source 0] and tries to reconcile "answer from app map" with
    # "course context attached" — that contradiction is what produced
    # the generic-study-app feature lists in earlier reports.
    if app_question:
        open_ctx = ""
        open_image_parts: list[dict[str, Any]] = []
    else:
        open_ctx = (open_file_context or "").strip()[:20000]
        open_image_parts = _open_file_image_parts(open_file_images)
    tutor_mode_norm = normalise_tutor_mode(tutor_mode)
    problem_mode = _normalise_problem_solver_mode(
        problem_solver.get("mode") if problem_solver else None
    )
    problem_source_text = _problem_solver_source(problem_solver) if problem_mode else ""
    has_problem_source = bool(problem_source_text)
    if problem_mode:
        # Problem Solver modes carry their own behavior contract. In
        # particular, FULL SOLUTION must not inherit the base Socratic
        # "do not reveal the answer" overlay from tutorMode="solve".
        tutor_mode_norm = "explain"
    has_open = bool(open_ctx)
    has_open_image = bool(open_image_parts)
    # Promote to "strong" only when visible PDF content is actually the
    # user's target: deictic questions ("explain this") or Problem Solver
    # requests whose structured problem text is the task. Broad questions
    # still need retrieval strength to earn a confident answer.
    deictic = _is_deictic_question(question)
    # A non-deictic question with no Problem Solver isn't ABOUT the visible
    # page. When the open-PDF slice still rides along (strong retrieval
    # includes it as Source 0), 20k chars of whatever happens to be on screen
    # is mostly dead weight — keep a slim slice for incidental grounding.
    if open_ctx and not deictic and problem_mode is None:
        open_ctx = open_ctx[:6000]
    effective_strength = _effective_strength_with_open_context(
        strength,
        (has_problem_source and bool(used_chunks))
        or ((has_open or has_open_image) and (deictic or problem_mode is not None)),
    )
    if app_question:
        # App-only path: skip the tutor base prompt entirely so the model
        # doesn't get conflicting "ALWAYS base on document content"
        # instructions. The app context map is the only authority.
        system_prompt = _APP_ONLY_SYSTEM_PROMPT + MINALLO_APP_CONTEXT
        answer_mode = "app"
    else:
        routing_question = question
        open_context_targets_visible_problem = open_ctx and (deictic or problem_mode is not None)
        routing_chunks = used_chunks
        synthetic_routing_chunks: list[RetrievedChunk] = []
        routing_context_parts: list[str] = []
        if has_problem_source:
            routing_context_parts.append(problem_source_text[:3000])
            synthetic_routing_chunks.append(
                RetrievedChunk(
                    chunk_id="problem-solver-input",
                    document_id="__problem_solver__",
                    page_start=None,
                    page_end=None,
                    text=problem_source_text,
                    score=100.0,
                    similarity=1.0,
                    chunk_type="exercise",
                    section_title="Problem Solver input",
                    is_synthetic=True,
                )
            )
        if open_context_targets_visible_problem:
            routing_context_parts.append(open_ctx[:2000])
            synthetic_routing_chunks.append(
                RetrievedChunk(
                    chunk_id="open-visible",
                    document_id="__open__",
                    page_start=None,
                    page_end=None,
                    text=open_ctx,
                    score=99.0,
                    similarity=1.0,
                    chunk_type="exercise",
                    section_title="Open PDF visible context",
                    is_synthetic=True,
                )
            )
        if routing_context_parts:
            routing_question = (question.strip() + "\n\n" + "\n\n".join(routing_context_parts)).strip()
            routing_chunks = [*synthetic_routing_chunks, *used_chunks]
        academic_intent = classify_academic_intent(
            routing_question,
            routing_chunks,
            {
                "app_question": app_question,
                "tutor_mode": tutor_mode_norm,
                "problem_solver": bool(problem_solver),
            },
        )
        system_prompt, answer_mode = pick_system_prompt(
            routing_question, effective_strength, routing_chunks, tutor_mode=tutor_mode_norm,
            weak_topics=weak_topics, intent=academic_intent,
        )
        if problem_mode:
            system_prompt += _problem_solver_overlay(problem_mode, problem_solver or {})
    wants_diagram = _wants_diagram(question, problem_solver) and not app_question
    if wants_diagram:
        system_prompt += _diagram_overlay(bool(used_chunks or (has_open and deictic)))
    # Exam generation / "a question for every selected file": append the
    # authoritative file list so the model covers each selected source exactly
    # once and never invents a file (e.g. a chapter the student didn't select).
    is_exam_request = academic_intent == AcademicIntent.EXAM_GENERATION
    wants_full_coverage = is_exam_request or wants_per_source_coverage(question)
    if wants_full_coverage and used_chunks:
        system_prompt += build_source_coverage_overlay(
            used_chunks, doc_names, exam=is_exam_request,
            selected_file_names=selected_file_names,
        )
    # Subject-aware exam style: exercise/solution sheets for a calculation
    # subject (Technische Mechanik, Mathe, Physik) get a calculation-heavy exam
    # (Rechenaufgaben + Kurzfragen, full worked Kurzlösung, unit checks) instead
    # of the lecture-slide theory exam. No-op (theory) for lecture material.
    exam_style = "theory"
    if is_exam_request and used_chunks:
        # Use the AUTHORITATIVE selection (resolved doc ids + file names) for the
        # style decision, not just the retrieved-chunk ids — a retrieval that
        # surfaces recap chunks must not flip a calc subject to a theory exam.
        style_doc_ids = selected_document_ids or [
            c.document_id for c in used_chunks if getattr(c, "document_id", None)
        ]
        exam_style = detect_exam_style(
            question, used_chunks,
            doc_ids=style_doc_ids, file_names=selected_file_names, user_id=user_id,
        )
        system_prompt += exam_style_overlay(exam_style)
        log.info("exam style resolved: %s", exam_style)
    # An exercise/figure page bitmap will be attached below whenever retrieval
    # surfaced a figure-bearing chunk on a math/exercise question — even if the
    # rigid math worksheet template wasn't picked (e.g. the formula sheet wasn't
    # retrieved, so answer_mode stayed "strong"). Compute the flag here so it can
    # also route the request to the vision-capable strong model.
    will_attach_figure = (
        not app_question
        and answer_mode in ("math", "strong")
        and bool(used_chunks)
        and any((getattr(c, "chunk_type", None) or "") in _FIGURE_CHUNK_TYPES for c in used_chunks)
    )
    # Route by answer mode: math/exercise questions hit the strong model,
    # everything else stays on the cheaper mini model. Must compute AFTER
    # pick_system_prompt because we need its returned label. Math reasoning
    # is where mini gets variable distinctions wrong (d vs d_3) and
    # silently drops sum terms it can't compute — gpt-4o handles both.
    # The math gate is tight (strong retrieval + is_math_question +
    # exercise anchor + formula chunk presence ALL agree), so cost stays
    # predictable.
    heavy_capped = False
    if model:
        target_model = model
    elif (
        answer_mode == "math"
        or problem_mode in {"setup", "check", "solve"}
        or wants_diagram
        or has_open_image
        or will_attach_figure
        # A multi-section mock exam (one Aufgabe per selected file, with calc
        # tasks + Kurzlösung) needs strong instruction-following: the mini model
        # silently drops most sections and covers only a few files. Route exams
        # to the strong model so the full per-file coverage is honoured.
        or is_exam_request
    ):
        target_model = settings.openai_generate_model_strong
        # Monthly strong-model allowance: bounds worst-case OpenAI cost per
        # subscriber. Past the cap the question still gets answered — on the
        # standard model, with a notice appended — instead of a 429.
        if user_id and target_model != settings.openai_generate_model and heavy_model_cap_reached(
            user_id, target_model, settings.heavy_monthly_cap
        ):
            target_model = settings.openai_generate_model
            heavy_capped = True
    else:
        target_model = settings.openai_generate_model

    # Worked engineering solutions (multi-term formulas rendered in KaTeX,
    # which is token-heavy) routinely overran the default ceiling and got cut
    # off mid-calculation. Give the solving paths a larger budget so the
    # Given/Formula/Substitution/Calculation/Final answer structure completes.
    effective_max_tokens = max_tokens
    if (
        answer_mode == "math"
        or problem_mode in {"setup", "check", "solve"}
        or wants_diagram
        or will_attach_figure
    ):
        effective_max_tokens = max(max_tokens, 4500)
    # A full practice exam (one Aufgabe per file + sub-questions + Kurzlösung)
    # scales with the number of covered files. Reasoning models (o4-mini, the
    # strong model exams now run on) also spend tokens on hidden reasoning that
    # counts against max_completion_tokens, so give them more headroom per file
    # to avoid truncating before all sections finish.
    if is_exam_request:
        exam_file_count = len({c.document_id for c in used_chunks if c.document_id})
        per_file = 1000 if is_reasoning_model(target_model) else 700
        effective_max_tokens = max(effective_max_tokens, 6000, min(16000, exam_file_count * per_file))

    # Reasoning effort: the global default (medium) is tuned for the deep
    # multi-phase reasoning that actual exercise-SOLVING and diagram/figure
    # reasoning need. Conceptual / formula / definition questions reach the
    # strong model too (answer_mode == "math") but don't use that reasoning —
    # they give the same answer at "low" effort for far fewer (billed) reasoning
    # tokens. So only the genuine solving/figure paths keep the higher default.
    reasoning_effort_override = None
    if is_reasoning_model(target_model) and not (
        problem_mode in {"setup", "check", "solve"}
        or wants_diagram
        or has_open_image
        or will_attach_figure
    ):
        reasoning_effort_override = "low"

    # Compose the context block. Open-file text goes first as [Source 0] so
    # the model cites it preferentially for deictic ("this question /
    # this section / the exercise above") queries. RAG-retrieved chunks
    # follow as [Source 1..N].
    # Source 0 is only included when the question is deictic OR retrieval
    # was already strong on its own. Otherwise a 3.5k slice of whatever the
    # student happens to have on screen would over-anchor a broad question.
    include_open_source = has_open and (deictic or problem_mode is not None or strength == "strong")
    include_source_zero = has_problem_source or include_open_source or has_open_image
    parts: list[str] = []
    if include_source_zero:
        source_zero_name = "Problem Solver input"
        source_zero_sections: list[str] = []
        if has_problem_source:
            source_zero_sections.append("PROBLEM STATEMENT FROM PROBLEM SOLVER:\n" + problem_source_text)
        if include_open_source:
            source_zero_name = active_file_name or source_zero_name
            source_zero_sections.append("CURRENTLY VISIBLE IN PDF VIEWER:\n" + open_ctx)
        elif has_open_image and active_file_name:
            source_zero_name = active_file_name
        parts.append(f"[Source 0] {source_zero_name}\n" + "\n\n".join(source_zero_sections))
    if used_chunks:
        parts.append(_build_context_block(used_chunks, doc_names))
    context_block = "\n\n---\n\n".join(parts)

    if active_file_name:
        system_prompt += (
            f"\n\nThe student is currently reading the file \"{active_file_name}\""
            " in the PDF viewer. Treat [Source 0] (CURRENTLY VISIBLE) as the"
            " primary source for what the student is looking at, then consult"
            " retrieved course sources for supporting formulas, definitions,"
            " and worked methods."
        )
    if has_problem_source:
        system_prompt += (
            "\n\nProblem Solver source rule: [Source 0] contains the exact problem "
            "statement submitted by the student. Solve that problem as written. "
            "Retrieved chunks may support formulas or methods, but they must not "
            "change the requested quantities, variables, geometry, or final condition."
        )
    if "SPLIT VIEW:" in open_ctx and "DOCUMENT 2" in open_ctx:
        system_prompt += (
            "\n\nSplit-view rule: [Source 0] contains two currently visible PDFs,"
            " labelled DOCUMENT 1 and DOCUMENT 2. When the student asks what"
            " both PDFs contain, compares them, or asks about both, you MUST"
            " address DOCUMENT 1 and DOCUMENT 2 separately. Do NOT say the"
            " second PDF is not visible or not specified. If DOCUMENT 2 text"
            " is marked as not extracted, say the right PDF text is not ready"
            " yet and ask the student to wait/retry, instead of guessing."
        )
    if has_open_image:
        system_prompt += (
            "\n\nVisible PDF page image(s) are attached to the current user"
            " message. Read printed text, handwritten text, formulas, diagrams,"
            " tables, labels, and numeric values from the image when extracted"
            " text is incomplete. Treat the image as part of [Source 0]."
        )
    # ── Workspace awareness (layer 2 of the three knowledge layers) ──────────
    # The live workspace block carries the student's real course data (file/
    # quiz/deck/exam counts, weak topics, current tab). It rides EVERY course
    # request: app questions answer with real numbers, content questions can
    # point at the right tab, and the actions contract lets the model offer
    # clickable next steps.
    if workspace_block:
        system_prompt += "\n" + workspace_block
        if not problem_solver:
            system_prompt += ACTIONS_CONTRACT
            system_prompt += QUIZ_CONTRACT
    if assistant_mode == "exam_coach":
        system_prompt += EXAM_COACH_OVERLAY
    elif assistant_mode == "tutor" and not app_question:
        system_prompt += TUTOR_STRUCTURE_OVERLAY

    # ── Cache-friendly ordering ──────────────────────────────────────────────
    # The intent-resolution overlay embeds the literal question, so it is the
    # one part of the system prompt that changes on EVERY request. Appending it
    # last keeps it out of the cacheable prefix (OpenAI prompt caching matches
    # the longest identical leading span of the request). Everything above is
    # stable across a user's same-type questions, so it now stays cached on
    # follow-ups instead of being invalidated by this overlay sitting mid-prompt.
    # Only this block's POSITION moved — its content, and every other block, is
    # unchanged, so the model receives exactly the same instructions and the
    # answer is identical.
    if not app_question:
        system_prompt += _intent_resolution_runtime_overlay(
            question,
            has_visible_context=include_source_zero,
            has_history=bool(previous_turns),
            active_file_name=("Problem Solver input" if has_problem_source else active_file_name),
        )

    # Keep this request-specific instruction last so a German document, course
    # title, or exercise label cannot outweigh the language of the student's
    # actual request (for example: "I don't understand Aufgabe 13.1").
    system_prompt += FINAL_RESPONSE_LANGUAGE_RULE

    user_message = "QUESTION:\n" + question.strip()
    if problem_mode and problem_solver:
        user_message += _problem_solver_user_block(problem_solver)
    if context_block:
        # Document Understanding Layer: name the retrieved source types so the
        # tutor reasons about them correctly (exam vs lecture vs solution sheet).
        doc_ids = {
            c.document_id for c in used_chunks if getattr(c, "document_id", None)
        }
        understanding = understanding_block_for_ids(doc_ids) if doc_ids else ""
        if understanding:
            user_message += "\n\n" + understanding
        user_message += "\n\nCOURSE CONTEXT:\n\n" + context_block

    # Auto-attach the exercise/figure page bitmap on math/exercise questions so
    # the vision model can read dimensions and geometry off the drawing — most
    # of an engineering exercise's data lives in the figure, which OCR loses.
    # Fires whenever retrieval surfaced a figure-bearing chunk on a math/strong
    # answer (will_attach_figure), not only when the rigid math worksheet was
    # picked — an AG-9.1-style exercise whose givens live in the drawing may
    # land in "strong" mode if the formula sheet wasn't retrieved, and it's
    # exactly those that need the figure most. Capped at the image budget and
    # skipped when the student already supplied that visible page.
    figure_image_parts: list[dict[str, Any]] = []
    if will_attach_figure:
        # Guarantee the exercise figure at least one slot. The open visible
        # page (open_image_parts) may not be the page the drawing is on, and
        # for a figure-exercise the drawing is the most valuable image — don't
        # let the visible page starve it. Absolute ceiling stays at 3 images.
        remaining = max(_MAX_ATTACHED_IMAGES - len(open_image_parts), 1)
        figure_image_parts = _figure_page_image_parts(used_chunks, max_images=remaining)
        if figure_image_parts:
            user_message += _FIGURE_READ_INSTRUCTION
        else:
            log.info("figure-vision: will_attach_figure was set but no image rendered")

    image_parts = [*open_image_parts, *figure_image_parts]
    user_content: str | list[dict[str, Any]]
    if image_parts:
        user_content = [{"type": "text", "text": user_message}, *image_parts]
    else:
        user_content = user_message

    def _source_payload(c, index=None):
        # ``index`` is the 1-based [Source N] number (N = position in the
        # COURSE CONTEXT block). The frontend uses it to make inline
        # [Source N] markers clickable; documentId + pageStart let it open
        # the right PDF at the right page.
        return {
            "index": index,
            "documentId": c.document_id,
            "file_name": doc_names.get(c.document_id, "Unknown"),
            "pageStart": c.page_start,
            "pageEnd": c.page_end,
            "pages": (
                str(c.page_start)
                if c.page_start and c.page_start == c.page_end
                else (f"{c.page_start}-{c.page_end}" if c.page_start and c.page_end else None)
            ),
            "section": c.section_title,
        }

    def _source_zero_payload():
        return {
            "index": 0,
            "documentId": None,
            "file_name": "Problem Solver input" if has_problem_source else (active_file_name or "Source 0"),
            "pageStart": None,
            "pageEnd": None,
            "pages": None if has_problem_source else "currently visible",
            "section": "Problem statement" if has_problem_source else "Open PDF (visible page)",
        }

    # Buffer the streamed answer so we can filter sources by the [Source N]
    # citations the model actually used. The full text isn't known until the
    # stream completes, so the filtering happens just before the 'done' event.
    answer_buf: list[str] = []

    # Send an opening "meta" event so the client can render the bubble
    # immediately, even before the first content token arrives.
    display_strength = "strong" if app_question else effective_strength
    yield _sse({
        "meta": True,
        "retrievalMode": display_strength,
        "answerMode": answer_mode,
        "tutorMode": tutor_mode_norm,
        "confidence": "high" if display_strength == "strong" else "low",
        "unsupported": display_strength != "strong",
    })

    # No streamed source preface on purpose: sources ride the done-event
    # metadata and the UI renders them once, BELOW the answer. The stream must
    # open with the actual explanation — the intro hold below enforces that
    # deterministically (the ANSWER OPENING prompt rule alone is not enough).
    #
    # While intro_hold is True the first tokens are buffered instead of
    # emitted, so a banned opening ("I'm powered by Minallo AI…", "I will use
    # these uploaded course sources…") can be scrubbed before the client sees
    # anything. Released as soon as a substantive first line is complete, or
    # at 250 chars — longer than any announcement sentence — so the perceived
    # streaming delay stays well under a second.
    intro_hold = True
    intro_buf = ""

    # Weave in recent Q&A turns so the model can resolve follow-up
    # references ("the formula above", "explain that"). Server-side cap:
    # at most 6 messages (3 turns) and ~2000 chars total — enough to give
    # the model anaphora context without blowing prompt size on a long
    # session.
    history_messages = _trim_previous_turns(previous_turns)

    client = get_openai_client()
    prompt_tokens = None
    completion_tokens = None
    cached_tokens = None

    # Usage checkpoint for the router's abort metering. OpenAI's real usage
    # numbers only arrive in the final stream chunk — a client that aborts
    # mid-answer never delivers them, so those tokens used to vanish from the
    # meter entirely (the prompt is billed in full the moment the request
    # lands). chars/4 over the TEXT parts is the estimate; image parts are
    # billed per tile, not per base64 char, so they are skipped rather than
    # wildly overcounted. stream.py consumes this event without forwarding it.
    est_prompt_tokens = (
        len(system_prompt)
        + _meter_text_len(user_content)
        + sum(_meter_text_len(m.get("content")) for m in history_messages)
    ) // 4
    yield _sse({"usageEst": True, "model": target_model, "estPromptTokens": est_prompt_tokens})

    # Live status: everything before this point (retrieval, prompt assembly) is
    # done — from here the model is writing the answer. For reasoning models
    # (o4-mini exams) this is the long no-token pause, so advancing the status
    # line to "writing the answer" here is the most accurate it can be. The
    # router forwards this verbatim to the chatbot + side-panel status line.
    if not app_question:
        yield _sse({"status": "writing_answer"})

    try:
        stream = client.chat.completions.create(
            model=target_model,
            stream=True,
            stream_options={"include_usage": True},
            messages=[
                {"role": "system", "content": system_prompt},
                *history_messages,
                {"role": "user",   "content": user_content},
            ],
            # Reasoning models (o4-mini for math) use max_completion_tokens and
            # reject a custom temperature; chat models keep max_tokens + a low
            # temperature (0.2) so a worked solution stays near-deterministic
            # instead of resampling a different structure each regeneration.
            **chat_completion_params(
                target_model, effective_max_tokens, temperature=0.2,
                reasoning_effort=reasoning_effort_override,
            ),
        )
        for chunk in stream:
            # Usage chunk arrives at the end when include_usage=True.
            if getattr(chunk, "usage", None):
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens
                    details = getattr(chunk.usage, "prompt_tokens_details", None)
                    cached_tokens = getattr(details, "cached_tokens", None)
                continue
            choices = chunk.choices or []
            if not choices:
                continue
            delta = choices[0].delta
            token = getattr(delta, "content", None) if delta else None
            if token:
                if intro_hold:
                    intro_buf += token
                    cleaned = strip_answer_intro(intro_buf).lstrip("\n")
                    first_line = cleaned.split("\n", 1)[0].strip() if "\n" in cleaned else ""
                    if first_line or len(intro_buf) >= 250:
                        intro_hold = False
                        if cleaned:
                            answer_buf.append(cleaned)
                            # Exams are buffered (not streamed live) so they can be
                            # linted + repaired BEFORE the user sees them.
                            if not is_exam_request:
                                yield _sse({"t": cleaned})
                        intro_buf = ""
                    continue
                answer_buf.append(token)
                if not is_exam_request:
                    yield _sse({"t": token})
    except Exception as e:  # noqa: BLE001
        log.exception("stream_answer failed")
        if not answer_buf and not intro_buf:
            # Failed before any token arrived (connect/4xx on create): nothing
            # was billed — retract the abort-metering checkpoint. Mid-stream
            # failures keep it: the prompt and partial completion were billed.
            yield _sse({"usageEst": True, "cancel": True})
        yield _sse({"error": f"{type(e).__name__}: {e}"})
        return

    # Short answer that never tripped the release condition (no newline and
    # under the hold cap) — scrub and flush it now.
    if intro_hold and intro_buf:
        cleaned = strip_answer_intro(intro_buf).lstrip("\n")
        if cleaned:
            answer_buf.append(cleaned)
            if not is_exam_request:
                yield _sse({"t": cleaned})

    full_answer = "".join(answer_buf)

    # Buffered exam path: the tokens above were accumulated but NOT streamed, so
    # we can lint and (on blocking failures) repair the exam BEFORE the user sees
    # it, then emit the final version. Exams already pause on the reasoning model,
    # so losing live streaming here is an acceptable trade for a validated exam.
    if is_exam_request:
        blocking = exam_lint_blocking(lint_exam_output(full_answer))
        if blocking:
            log.warning("exam lint blocking (%d) — repairing before stream: %s",
                        len(blocking), "; ".join(blocking))
            yield _sse({"status": "writing_answer"})
            full_answer = repair_exam_output(
                system_prompt=system_prompt, user_message=user_content,
                bad_answer=full_answer, issues=blocking,
                client=client, model=target_model, max_tokens=effective_max_tokens,
            )
        # Emit the final (possibly repaired) exam in slices the client appends.
        for i in range(0, len(full_answer), 1500):
            yield _sse({"t": full_answer[i:i + 1500]})

    # Diagram refusal-recovery. The system-prompt overlay tells the model
    # to emit a fenced ``minallo-diagram`` block, but gpt-4o's RLHF refusal
    # reflex on "I can't generate images" reliably overrides even few-shot
    # examples. When the student asked for a diagram and the streamed answer
    # has no fence, we make a SECOND, narrowly-scoped call with
    # response_format=json_schema. Structured outputs can't refuse — the
    # response shape is constrained — so this is the reliable backstop.
    plot_wanted = _wants_plot(question, problem_solver) and not app_question
    log.debug(
        "[DIAGRAM_DEBUG] check wants_diagram=%s wants_plot=%s "
        "has_diag_fence=%s has_plot_fence=%s answer_len=%d",
        wants_diagram, plot_wanted,
        "```minallo-diagram" in full_answer,
        "```minallo-plot" in full_answer,
        len(full_answer),
    )
    # Plot-shape requests: a ``minallo-diagram`` fence is the WRONG fence
    # (a curve encoded as node-chain). Fire the plot fallback whenever no
    # plot fence is present — even if a diagram fence slipped through.
    if plot_wanted and "```minallo-plot" not in full_answer:
        plot_fence = _force_render_plot(
            client, target_model, question, used_chunks,
            problem_source_text or (open_ctx if include_open_source else None),
        )
        if plot_fence:
            yield _sse({"t": plot_fence})
            full_answer += plot_fence
    elif wants_diagram and "```minallo-diagram" not in full_answer:
        diagram_fence = _force_render_diagram(
            client, target_model, question, used_chunks,
            problem_source_text or (open_ctx if include_open_source else None),
        )
        if diagram_fence:
            yield _sse({"t": diagram_fence})
            full_answer += diagram_fence

    # Exam quality gate. The answer already STREAMED (we can't un-send it), so a
    # live repair pass would need to buffer the whole exam — deferred. Here we
    # lint, log, and EMIT the result (resolved style + blocking issues) in the
    # final metadata so the frontend/telemetry can see why an exam looked the way
    # it did. /ask (generate_answer) runs the actual lint→repair gate.
    if is_exam_request:
        exam_issues = lint_exam_output(full_answer)
        blocking = exam_lint_blocking(exam_issues)
        if exam_issues:
            log.warning(
                "exam lint flagged %d issue(s) (%d blocking): %s",
                len(exam_issues), len(blocking), "; ".join(exam_issues),
            )
        yield _sse({"examStyle": exam_style, "examLint": exam_issues, "examLintBlocking": blocking})

    cited = _cited_indices(full_answer, len(used_chunks))
    filtered_sources = [_source_payload(c, i) for i, c in enumerate(used_chunks, start=1) if i in cited]

    # [Source 0] = the visible PDF text snippet the model received when the
    # question was deictic ("explain this"). _cited_indices only handles
    # 1..N (the retrieved chunks); [Source 0] needs an explicit pass.
    # Without this, the answer would show "grounded in [Source 0]" inline
    # but the final Sources block would be missing that source entirely —
    # a misleading UX gap the user can't tell from a fabricated citation.
    if include_source_zero and re.search(r"\[Source\s+0\]", full_answer, re.IGNORECASE):
        filtered_sources.insert(0, _source_zero_payload())
    if has_problem_source and used_chunks and not any(src.get("file_name") != "Problem Solver input" for src in filtered_sources):
        filtered_sources.extend(_source_payload(c, i) for i, c in enumerate(used_chunks[:3], start=1))
    if not filtered_sources:
        # The UI should still show the material the answer was grounded on.
        # Verification may mark the answer down when inline citations are
        # missing, but hiding sources entirely makes students think retrieval
        # did not use their lectures/exercises at all.
        if include_source_zero:
            filtered_sources.append(_source_zero_payload())
        filtered_sources.extend(_source_payload(c, i) for i, c in enumerate(used_chunks[:4], start=1))

    # Phase 10 — deterministic verification on the streamed answer.
    # Include the open-file text in the haystack so formulas / numbers the
    # model lifted from [Source 0] aren't flagged as ungrounded.
    verification_haystack = [c.text for c in used_chunks]
    if has_problem_source:
        verification_haystack.append(problem_source_text)
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
    if app_question:
        verification = {
            "status": "verified",
            "reasons": ["Answered from Minallo app context."],
            "details": {"appSupport": True},
        }
        filtered_sources = []

    v_status = verification.get("status") if isinstance(verification, dict) else None
    if v_status == "verified":
        confidence_label = "high"
    elif v_status == "partially_verified":
        confidence_label = "medium"
    else:
        confidence_label = "low"

    # Heavy-cap notice rides the token stream (so it lands in the visible
    # answer and chat history) but NOT full_answer — verification and citation
    # filtering ran on the real answer text above. stream.py skips the cache
    # save when heavyCapped is set, so the note never replays from cache.
    if heavy_capped:
        yield _sse({"t": (
            "\n\n⚠️ *This month's advanced-solver allowance is used up, so this answer "
            "used the standard model. The allowance resets on the 1st.*"
        )})

    yield _sse({
        "done": True,
        "heavyCapped": heavy_capped,
        "retrievalMode": display_strength,
        "answerMode": answer_mode,
        "tutorMode": tutor_mode_norm,
        "verification": verification,
        "confidence": confidence_label,
        "unsupported": display_strength != "strong",
        "sources": filtered_sources,
        "model": target_model,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cachedTokens": cached_tokens,
    })
