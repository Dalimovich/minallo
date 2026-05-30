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
import re
from typing import Any, Generator

from openai import OpenAI

from ..config import get_settings
from .answer import (
    DEFAULT_TUTOR_MODE,
    MINALLO_APP_CONTEXT,
    _APP_ONLY_SYSTEM_PROMPT,
    _build_context_block,
    _cited_indices,
    _context_strength,
    is_app_question,
    normalise_tutor_mode,
    pick_system_prompt,
)
from .retrieval import RetrievedChunk

log = logging.getLogger(__name__)

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
    for img in (open_file_images or [])[:1]:
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
    print(f"[DIAGRAM_DEBUG] _force_render_diagram entered model={model}", flush=True)
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
        raw = (completion.choices[0].message.content or "").strip()
        print(f"[DIAGRAM_DEBUG] structured call returned raw_len={len(raw)}", flush=True)
        if not raw:
            print("[DIAGRAM_DEBUG] empty content -> None", flush=True)
            return None
        parsed = json.loads(raw)
        node_count = len(parsed.get("nodes", [])) if isinstance(parsed, dict) else 0
        print(f"[DIAGRAM_DEBUG] parsed nodes={node_count}", flush=True)
        if not isinstance(parsed, dict) or not parsed.get("nodes"):
            return None
        return "\n\n```minallo-diagram\n" + raw + "\n```\n"
    except Exception as e:  # noqa: BLE001
        print(f"[DIAGRAM_DEBUG] exception {type(e).__name__}: {e}", flush=True)
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
    print(f"[PLOT_DEBUG] _force_render_plot entered model={model}", flush=True)
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
        raw = (completion.choices[0].message.content or "").strip()
        print(f"[PLOT_DEBUG] structured call returned raw_len={len(raw)}", flush=True)
        if not raw:
            return None
        parsed = json.loads(raw)
        series = parsed.get("series", []) if isinstance(parsed, dict) else []
        valid_series = sum(1 for s in series if isinstance(s, dict) and len(s.get("points", [])) >= 2)
        print(f"[PLOT_DEBUG] series_count={len(series)} valid={valid_series}", flush=True)
        if valid_series == 0:
            return None
        return "\n\n```minallo-plot\n" + raw + "\n```\n"
    except Exception as e:  # noqa: BLE001
        print(f"[PLOT_DEBUG] exception {type(e).__name__}: {e}", flush=True)
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
- For code problems: write code in triple-backtick fences with a language tag (```python, ```java, ```c, ```sql, ...). Inline identifiers, function names, paths in `single backticks`. Preserve indentation exactly. NEVER wrap code in `$...$` math delimiters.
- Cite source material with [Source N] tags exactly as the base prompt requires.
- Do not invent course-specific formulas, APIs, or library functions. If the needed material is absent, say what is missing.
- Reply in the same language the student is writing in (German or English). Section headings translate too ("Given" → "Gegeben", "Approach" → "Vorgehen", "Complexity" → "Komplexität", ...).
"""
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
For engineering/math tasks:
- If all required numeric inputs are present in the PROBLEM SOLVER INPUT or
  COURSE CONTEXT, you MUST carry out the arithmetic and end with a visibly
  boxed final answer, e.g. `$$\\boxed{...}$$`.
- Do not end with "insert the values", "use the formulas", "if the values are
  known", "please provide the lengths", or similar placeholders when the
  required values are available in the visible problem/context.
- If a final numeric answer is impossible, write a short "Cannot finish
  numerically" section and list the exact missing quantities by symbol/name
  (for example `l_i`, `A_i`, `A_ers`, `d_h`) and where they should come from.
  Do not present this as a full solution and do not label confidence high.
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

    strength = _context_strength(chunks)
    # Review fix #3 — partial retrieval mode. Mirrors answer.py's logic:
    #   strong → all chunks    weak → top 3 (with PARTIAL prompt)    none → []
    if app_question:
        used_chunks = []
    elif strength == "strong":
        used_chunks = chunks
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
        system_prompt, answer_mode = pick_system_prompt(
            routing_question, effective_strength, routing_chunks, tutor_mode=tutor_mode_norm,
            weak_topics=weak_topics,
        )
        if problem_mode:
            system_prompt += _problem_solver_overlay(problem_mode, problem_solver or {})
    wants_diagram = _wants_diagram(question, problem_solver) and not app_question
    if wants_diagram:
        system_prompt += _diagram_overlay(bool(used_chunks or (has_open and deictic)))
    # Route by answer mode: math/exercise questions hit the strong model,
    # everything else stays on the cheaper mini model. Must compute AFTER
    # pick_system_prompt because we need its returned label. Math reasoning
    # is where mini gets variable distinctions wrong (d vs d_3) and
    # silently drops sum terms it can't compute — gpt-4o handles both.
    # The math gate is tight (strong retrieval + is_math_question +
    # exercise anchor + formula chunk presence ALL agree), so cost stays
    # predictable.
    if model:
        target_model = model
    elif answer_mode == "math" or problem_mode in {"setup", "check", "solve"} or wants_diagram or has_open_image:
        target_model = settings.openai_generate_model_strong
    else:
        target_model = settings.openai_generate_model

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
    if not app_question:
        system_prompt += _intent_resolution_runtime_overlay(
            question,
            has_visible_context=include_source_zero,
            has_history=bool(previous_turns),
            active_file_name=("Problem Solver input" if has_problem_source else active_file_name),
        )

    user_message = "QUESTION:\n" + question.strip()
    if problem_mode and problem_solver:
        user_message += _problem_solver_user_block(problem_solver)
    if context_block:
        user_message += "\n\nCOURSE CONTEXT:\n\n" + context_block
    user_content: str | list[dict[str, Any]]
    if open_image_parts:
        user_content = [{"type": "text", "text": user_message}, *open_image_parts]
    else:
        user_content = user_message

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
    display_strength = "strong" if app_question else effective_strength
    yield _sse({
        "meta": True,
        "retrievalMode": display_strength,
        "answerMode": answer_mode,
        "tutorMode": tutor_mode_norm,
        "confidence": "high" if display_strength == "strong" else "low",
        "unsupported": display_strength != "strong",
    })

    # Weave in recent Q&A turns so the model can resolve follow-up
    # references ("the formula above", "explain that"). Server-side cap:
    # at most 6 messages (3 turns) and ~2000 chars total — enough to give
    # the model anaphora context without blowing prompt size on a long
    # session.
    history_messages = _trim_previous_turns(previous_turns)

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
                *history_messages,
                {"role": "user",   "content": user_content},
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

    # Diagram refusal-recovery. The system-prompt overlay tells the model
    # to emit a fenced ``minallo-diagram`` block, but gpt-4o's RLHF refusal
    # reflex on "I can't generate images" reliably overrides even few-shot
    # examples. When the student asked for a diagram and the streamed answer
    # has no fence, we make a SECOND, narrowly-scoped call with
    # response_format=json_schema. Structured outputs can't refuse — the
    # response shape is constrained — so this is the reliable backstop.
    plot_wanted = _wants_plot(question, problem_solver) and not app_question
    print(
        f"[DIAGRAM_DEBUG] check wants_diagram={wants_diagram} wants_plot={plot_wanted} "
        f"has_diag_fence={'```minallo-diagram' in full_answer} "
        f"has_plot_fence={'```minallo-plot' in full_answer} "
        f"answer_len={len(full_answer)}",
        flush=True,
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

    cited = _cited_indices(full_answer, len(used_chunks))
    filtered_sources = [_source_payload(c) for i, c in enumerate(used_chunks, start=1) if i in cited]

    # [Source 0] = the visible PDF text snippet the model received when the
    # question was deictic ("explain this"). _cited_indices only handles
    # 1..N (the retrieved chunks); [Source 0] needs an explicit pass.
    # Without this, the answer would show "grounded in [Source 0]" inline
    # but the final Sources block would be missing that source entirely —
    # a misleading UX gap the user can't tell from a fabricated citation.
    if include_source_zero and re.search(r"\[Source\s+0\]", full_answer, re.IGNORECASE):
        filtered_sources.insert(0, {
            "file_name": "Problem Solver input" if has_problem_source else (active_file_name or "Source 0"),
            "pages": None if has_problem_source else "currently visible",
            "section": "Problem statement" if has_problem_source else "Open PDF (visible page)",
        })
    if has_problem_source and used_chunks and not any(src.get("file_name") != "Problem Solver input" for src in filtered_sources):
        filtered_sources.extend(_source_payload(c) for c in used_chunks[:3])
    if not filtered_sources:
        # The UI should still show the material the answer was grounded on.
        # Verification may mark the answer down when inline citations are
        # missing, but hiding sources entirely makes students think retrieval
        # did not use their lectures/exercises at all.
        if include_source_zero:
            filtered_sources.append({
                "file_name": "Problem Solver input" if has_problem_source else (active_file_name or "Source 0"),
                "pages": None if has_problem_source else "currently visible",
                "section": "Problem statement" if has_problem_source else "Open PDF (visible page)",
            })
        filtered_sources.extend(_source_payload(c) for c in used_chunks[:4])

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

    yield _sse({
        "done": True,
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
    })
