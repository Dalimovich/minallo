"""Shared diagram-rendering overlay used by both ``answer.py`` (single-shot
generate) and ``answer_stream.py`` (SSE streaming).

The overlay appends a tightly-scoped instruction to the system prompt that
tells the model to emit a fenced ``minallo-diagram`` block when the
student's question asks for a sketch / free-body diagram / flowchart /
visual. The frontend renderer at ``frontend/js/features/ai-chat/ai-markdown.ts``
parses the JSON inside that fence and produces SVG.

This module is the single source of truth. The old per-file copies in
``answer.py`` / ``answer_stream.py`` import from here.
"""

from __future__ import annotations

import re
from typing import Any

# Trigger words. Keyword-based detection is coarse — see "Negative filters"
# below for the cases we explicitly exclude. Expand the positive list when
# CS students start asking "show me the call graph" / "sketch the AST".
#
# German vocabulary covers the Konstruktion / Maschinenbau course flavour
# we see today: Freikörperbild (FBD), Lageplan (layout drawing), Schnittbild
# (cross-section), Querschnitt (cross-section), Skizze, Zeichnung, etc.
_POSITIVE_RE = re.compile(
    r"\b("
    # Generic visual requests. German "Diagramm" (double m) and English
    # "redraw"/"re-draw" must match too — the boundaries are looser than
    # \bword\b for that reason.
    r"diagramm?|re[- ]?draw|sketch|draw|drawing|visuali[sz]e|visual|picture|illustration|"
    r"flowchart|flow[- ]chart|block[- ]diagram|state[- ]machine|"
    r"sequence[- ]diagram|class[- ]diagram|er[- ]diagram|entity[- ]relationship|"
    # Engineering specifics
    r"free[- ]body|fbd|circuit|schematic|graph[- ]of|"
    # German — "zeichne"/"zeichnen"/"zeichnest"/"zeichnet"/"neu zeichnen"
    r"kraftbild|skizze|skizzier|zeichne(n|st|t)?|neu[- ]?zeichnen|zeichnung|schaubild|"
    r"freik[oö]rper(bild)?|freischnitt|lageplan|schnittbild|querschnitt|"
    r"flussdiagramm|blockdiagramm|schaltplan|zustandsdiagramm"
    r")\b",
    re.IGNORECASE,
)

# Negative filters. Catch words that LOOK like diagram requests but aren't.
# Each tuple is (regex, reason — for debugging / future test cases).
# Order matters; the first match wins and disables the diagram overlay.
_NEGATIVE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # "graph theory" is the math topic, not a request to draw something.
    (re.compile(r"\bgraph(en)?[- ]?theorie\b|\bgraph theory\b", re.IGNORECASE), "graph theory topic"),
    # Course/lecture meta-references; "lecture diagram" is a question
    # ABOUT a diagram that was in lecture, not "draw me one".
    (re.compile(r"\b(what (does|did) the )?(figure|diagram|sketch) (in|on|from) (the )?(lecture|slide|chapter)\b", re.IGNORECASE), "asking about an existing figure"),
    # "Explain the diagram" can go either way — usually they want the
    # explanation, not a redrawn version. Keep this loose for now.
    (re.compile(r"\bexplain (the |this |that )?(diagram|figure|sketch|graph)\b", re.IGNORECASE), "explain-existing"),
)


def wants_diagram(question: str, problem_solver: dict[str, Any] | None = None) -> bool:
    """True when the student's question (or Problem Solver input) is asking
    for a renderable diagram, AND no negative filter excludes it.

    Accepts an optional ``problem_solver`` payload so we also inspect the
    problem text — a student in the Problem Solver panel writes the
    request there, not in the chat input.
    """
    text = question or ""
    if problem_solver:
        text += "\n" + str(problem_solver.get("problem") or "")
    if not _POSITIVE_RE.search(text):
        return False
    for pattern, _reason in _NEGATIVE_PATTERNS:
        if pattern.search(text):
            return False
    return True


def diagram_overlay(has_context: bool) -> str:
    """The prompt overlay appended to the system message when
    ``wants_diagram`` is True.

    ``has_context`` flips the source-attribution stanza: with context we
    require [Source N] citations on source-derived geometry; without
    context the diagram self-labels as conceptual / general knowledge so
    the student isn't misled.
    """
    source_rule = (
        "First inspect COURSE CONTEXT for any matching figure, diagram, labels, "
        "geometry, setup, or notation. If you use source-derived geometry, "
        "labels, formulas, or values, cite the sentence that introduces them "
        "with [Source N]."
        if has_context
        else
        "No matching COURSE CONTEXT may be available. In that case create a "
        "conceptual diagram from standard engineering / CS knowledge and "
        "explicitly label its caption as general knowledge."
    )
    return f"""

DIAGRAM RENDERING MODE.
You CAN render diagrams in this app. The fenced ``minallo-diagram`` block
below is your drawing tool — the browser parses the JSON and produces an
SVG diagram for the student. NEVER refuse with phrases like "I can't draw
diagrams" / "Ich kann keine Diagramme zeichnen" / "Es tut mir leid, ich
kann keine Diagramme zeichnen" / "I can only describe it" — those answers
are wrong in this app. Emit the fenced block instead. Always include ONE
renderable diagram after a short explanation, even when the student asks
you to "redraw" / "neu zeichnen" an existing figure.
{source_rule}

Use this exact fenced block format so the browser can render it:
```minallo-diagram
{{
  "title": "Short diagram title",
  "caption": "One sentence. Say 'Conceptual diagram (general knowledge)' if no source matched.",
  "nodes": [
    {{"id": "a", "label": "Object / step / component", "shape": "rect"}},
    {{"id": "b", "label": "Second item", "shape": "circle"}}
  ],
  "edges": [
    {{"from": "a", "to": "b", "label": "relation / force / flow"}}
  ],
  "labels": [
    {{"text": "Given values or assumptions"}}
  ]
}}
```

Rules for diagram JSON:
- Return valid JSON only inside the fenced block. No comments, no trailing commas.
- ``shape`` values: ``rect`` (block / component / step), ``circle`` (joint / wheel / state), ``triangle`` (fixed support / pin), ``ground`` (immovable surface / earth / wall), ``arrow`` (force vector — use as a node when the force is the focus; otherwise put forces on edges).
- ``x``/``y`` coordinates are OPTIONAL — omit them and the renderer auto-lays-out the diagram. Provide them only when the geometry actually matters (e.g. positions on a beam). If you do provide them, keep within x=30..770 and y=36..420.
- ``edges`` may include ``"type": "arc"`` for self-loops or curved flow; default is a straight line.
- Use simple labels (≤40 chars). Wrap long descriptions in ``labels`` (free-floating) instead of stuffing them into node labels.
- For free-body diagrams: a node for the body, ``ground``/``triangle`` for supports, ``arrow`` for force vectors, edges to attach them.
- For flowcharts / state machines: ``rect`` for steps, ``circle`` for states, directed edges with labels for transitions.
- For circuits / block diagrams: ``rect`` for components, edges for wiring with a label on at least one edge ("signal", "Vcc", etc.).
"""


__all__ = ("wants_diagram", "diagram_overlay")
