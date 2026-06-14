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


# Plot-style requests: continuous 2D function plots (stress-strain,
# characteristic curves, IV curves, temperature curves, frequency
# response, etc.). These produce ``minallo-plot`` fences with line
# series + axes, NOT the node-edge graph that wants_diagram routes to.
_PLOT_RE = re.compile(
    r"\b("
    # English
    r"stress[- ]strain|strain[- ]stress|"
    r"force[- ]displacement|displacement[- ]force|"
    r"current[- ]voltage|voltage[- ]current|"
    r"frequency response|bode plot|"
    r"plot of|graph of|chart of|"
    r"x[- ]?y (plot|chart|graph)|"
    # German
    r"spannungs[- ]?dehnungs|dehnungs[- ]?spannungs|"
    r"kraft[- ]?weg|weg[- ]?kraft|"
    r"strom[- ]?spannungs|spannungs[- ]?strom|"
    r"kennlinie|kennfeld|"
    r"abh[aä]ngigkeit von|als funktion (von|der)|"
    # Generic curve language
    r"curve|kurve|wendepunkt|s[- ]kurve|"
    r"function plot|plot der|plotte"
    r")\b",
    re.IGNORECASE,
)


def wants_plot(question: str, problem_solver: dict[str, Any] | None = None) -> bool:
    """True when the request is for a continuous 2D plot (axes + series),
    not a node-edge graph. Plot intent is a SUBSET of diagram intent —
    callers should check ``wants_plot`` BEFORE ``wants_diagram`` to route
    to the right fence type.
    """
    text = question or ""
    if problem_solver:
        text += "\n" + str(problem_solver.get("problem") or "")
    return bool(_PLOT_RE.search(text))


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

DIAGRAM / PLOT RENDERING MODE.
You CAN render diagrams AND continuous 2D plots in this app. Two fence
formats are available — pick the right one for the request:
  * ``minallo-diagram`` — node + edge graph. Use for flowcharts, state
    machines, free-body diagrams, circuit blocks, sequence diagrams.
  * ``minallo-plot`` — continuous 2D plot with axes + line series + named
    marker points. Use for stress-strain curves, characteristic curves
    (Kennlinien), I-V curves, frequency response, anything that is a
    function y(x) on labelled axes. Provide 8-20 (x, y) sample points
    per series so the polyline looks smooth, plus marker objects with
    {{x, y, label}} for named feature points (yield point, peak, etc.).
NEVER refuse with phrases like "I can't draw" / "Ich kann keine Diagramme
zeichnen" / "Es tut mir leid, ich kann keine Diagramme zeichnen" / "I can
only describe it" — those answers are wrong in this app. Emit the fenced
block instead. Always include ONE renderable diagram OR plot after a
short explanation, even when the student asks you to "redraw" / "neu
zeichnen" an existing figure.
{source_rule}

CHOOSING THE FENCE — this is the single most-violated rule, read carefully:
- If the answer is a CURVE on labelled axes (y as a function of x — stress-strain,
  Spannungs-Dehnungs-Diagramm, Kennlinie, I-V, Bode, force-displacement,
  Kraft-Weg, anything with "ε on x, σ on y" or similar) → use ``minallo-plot``.
  NEVER encode a curve as nodes-and-edges. A chain of circles labelled
  "Streckgrenze → Zugfestigkeit → Bruch" is WRONG — those are points ON
  the curve, not graph nodes.
- If the answer is a topology / connectivity / parts-with-arrows picture
  (FBD, flowchart, state machine, circuit blocks) → use ``minallo-diagram``.

``minallo-diagram`` format (node-edge graph):
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

``minallo-plot`` format (continuous 2D curve):
```minallo-plot
{{
  "title": "Short plot title",
  "caption": "One sentence. Say 'Conceptual plot (general knowledge)' if no source matched.",
  "xAxis": {{"label": "x quantity", "unit": "unit"}},
  "yAxis": {{"label": "y quantity", "unit": "unit"}},
  "series": [
    {{"label": "curve name", "points": [[x1,y1],[x2,y2], ...]}}
  ],
  "markers": [
    {{"x": x, "y": y, "label": "named feature point"}}
  ]
}}
```

Rules:
- Return valid JSON only inside the fenced block. No comments, no trailing commas.
- For ``minallo-diagram``: ``shape`` values are ``rect`` (block / component / step), ``circle`` (joint / wheel / state), ``triangle`` (fixed support / pin), ``ground`` (immovable surface / earth / wall), ``arrow`` (force vector). ``x``/``y`` coordinates are OPTIONAL — omit them and the renderer auto-lays-out the diagram. If you do provide them, keep within x=30..770 and y=36..420. ``edges`` may include ``"type": "arc"`` for self-loops or curved flow.
- For ``minallo-plot``: provide 8-20 sample points per series so the polyline looks smooth. Markers are named feature points the curve passes through (yield point, peak, breakdown, cutoff frequency, etc.).
- For free-body diagrams: a node for the body, ``ground``/``triangle`` for supports, ``arrow`` for force vectors, edges to attach them.
- For flowcharts / state machines: ``rect`` for steps, ``circle`` for states, directed edges with labels for transitions.
- For circuits / block diagrams: ``rect`` for components, edges for wiring with a label on at least one edge ("signal", "Vcc", etc.).

EXAMPLE — correct response to "zeichne das Spannungs-Dehnungs-Diagramm für Stahl":

Hier ist das Spannungs-Dehnungs-Diagramm für duktilen Stahl:

```minallo-plot
{{
  "title": "Spannungs-Dehnungs-Diagramm (duktiler Stahl)",
  "caption": "Conceptual plot (general knowledge).",
  "xAxis": {{"label": "Dehnung ε", "unit": "%"}},
  "yAxis": {{"label": "Spannung σ", "unit": "N/mm²"}},
  "series": [
    {{"label": "σ(ε)", "points": [
      [0, 0], [0.1, 210], [0.2, 420], [0.25, 500],
      [0.3, 520], [0.5, 525], [1.0, 540], [2.0, 580],
      [5.0, 620], [10.0, 640], [15.0, 630], [18.0, 600], [20.0, 540]
    ]}}
  ],
  "markers": [
    {{"x": 0.25, "y": 500, "label": "Streckgrenze R_e"}},
    {{"x": 10.0, "y": 640, "label": "Zugfestigkeit R_m"}},
    {{"x": 20.0, "y": 540, "label": "Bruch"}}
  ]
}}
```

EXAMPLE — correct response to "zeichne ein Freikörperbild für einen Balken auf zwei Stützen":

Hier ist das Freikörperbild:

```minallo-diagram
{{
  "title": "Freikörperbild — Balken auf zwei Stützen",
  "caption": "Conceptual diagram (general knowledge).",
  "nodes": [
    {{"id": "b", "label": "Balken", "shape": "rect"}},
    {{"id": "a", "label": "A", "shape": "triangle"}},
    {{"id": "c", "label": "B", "shape": "circle"}},
    {{"id": "f", "label": "F", "shape": "arrow"}}
  ],
  "edges": [
    {{"from": "a", "to": "b", "label": "A_v"}},
    {{"from": "c", "to": "b", "label": "B_v"}},
    {{"from": "f", "to": "b", "label": "Last"}}
  ],
  "labels": [
    {{"text": "F = 10 kN, L = 2 m"}}
  ]
}}
```

EXAMPLE — INCORRECT response (do NOT do this):

Encoding the stress-strain curve as a chain of circles ("0 → R_e → R_m → Bruch") inside a ``minallo-diagram`` fence. The yield point, tensile strength, and fracture point are MARKERS ON A CURVE, not graph nodes — they must appear inside a ``minallo-plot`` fence as entries in ``markers``.

"Ich kann hier keine Grafiken oder Zeichnungen generieren. Ich kann dir aber beschreiben, wie du es zeichnest..."  ← FORBIDDEN. You CAN draw — emit the fenced block above instead.
"""


__all__ = ("wants_diagram", "wants_plot", "diagram_overlay")
