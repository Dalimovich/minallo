"""Phase 5 — exercise & formula block detection on cleaned Markdown.

Operates on the per-page Markdown produced by `markdown_indexing.page_to_markdown`.
Goal: when a student asks "do exercise 1.2" or "what's the formula for bending
moment", retrieval can hit the *exact* block instead of a generic chunk that
happens to mention the keyword.

Detection is deterministic — no LLM. The chunker/embedder still owns generic
semantic retrieval; these blocks are stored alongside as exact-match handles.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── Patterns ─────────────────────────────────────────────────────────────────

# Matches "Aufgabe 1.2", "Übung 1.2 a)", "Exercise 1.2", "Problem 3", "Task 4.1.2",
# "Übungsaufgabe 9.1 a)".
# Group 1: keyword       Group 2: number ("1.2")       Group 3: optional subpart ("a")
# Compound forms (Übungsaufgabe / Uebungsaufgabe) listed first so the
# alternation matches them whole rather than greedily eating just the
# "Übung" prefix and failing the digit lookahead.
_EXERCISE_HEADER = re.compile(
    r"^(?:#{1,6}\s*)?"
    r"(Übungsaufgabe|Uebungsaufgabe|Aufgabe|Übung|Uebung|Exercise|Problem|Task|Beispiel)"
    r"\s+(\d+(?:\.\d+){0,3})"
    r"(?:\s*[\(\[]?([a-zA-Z])[\)\]]?\.?)?"
    r"[:\.\s]*",
    re.IGNORECASE,
)

# Solution / Lösung header — marks where the statement ends and the solution begins.
_SOLUTION_HEADER = re.compile(
    r"^(?:#{1,6}\s*)?(Lösung|Loesung|Solution|Antwort|Answer|Lsg\.?)\b",
    re.IGNORECASE,
)

# $$ ... $$ display-math block (markdown_indexing emits these as their own paragraph).
_DISPLAY_MATH_OPEN = re.compile(r"^\s*\$\$\s*$")
_DISPLAY_MATH_CLOSE = re.compile(r"^\s*\$\$\s*$")

# Inline single-line "$$ M = F * l $$".
_INLINE_DISPLAY_MATH = re.compile(r"^\s*\$\$\s*(.+?)\s*\$\$\s*$")

# Variable-symbol heuristic: single letters or letter+subscript/superscript.
_SYMBOL_RE = re.compile(r"\b([a-zA-ZΑ-Ωα-ω][_^]?\{?[a-zA-Z0-9]{0,3}\}?)\b")

# Page marker emitted by `assemble_document_markdown`.
_PAGE_MARKER = re.compile(r"^<!--\s*page:\s*(\d+)\s*-->\s*$")


# ── Dataclasses ──────────────────────────────────────────────────────────────


@dataclass
class ExerciseBlock:
    exercise_number: str
    subpart: str | None
    page_start: int
    page_end: int
    statement_markdown: str
    solution_markdown: str | None


@dataclass
class FormulaBlock:
    formula_name: str | None
    formula_markdown: str  # always wrapped in `$$ ... $$`
    page_number: int
    symbols: list[str] = field(default_factory=list)


# ── Public API ───────────────────────────────────────────────────────────────


def detect_exercises(pages_markdown: list[tuple[int, str]]) -> list[ExerciseBlock]:
    """Find every exercise block across a document's pages.

    `pages_markdown` is a list of `(page_number, page_markdown)` tuples in
    reading order. Page markdown is the output of `page_to_markdown(...).markdown`.

    An exercise starts at a header that matches `_EXERCISE_HEADER` and ends at:
      - the next exercise header,
      - a solution header (which captures the following lines as the solution),
      - end of document.
    """
    blocks: list[ExerciseBlock] = []
    # Flatten pages into (page_number, line) so a block can span pages.
    flat: list[tuple[int, str]] = []
    for page_number, md in pages_markdown:
        for line in (md or "").splitlines():
            flat.append((page_number, line))

    i = 0
    while i < len(flat):
        page_n, line = flat[i]
        m = _EXERCISE_HEADER.match(line.strip())
        if not m:
            i += 1
            continue

        exercise_number = m.group(2)
        subpart = (m.group(3) or "").lower() or None
        start_page = page_n
        statement_lines: list[str] = []
        solution_lines: list[str] = []
        end_page = page_n
        i += 1
        in_solution = False

        while i < len(flat):
            p_n, ln = flat[i]
            stripped = ln.strip()
            if _EXERCISE_HEADER.match(stripped):
                break  # next exercise — stop accumulating
            if _SOLUTION_HEADER.match(stripped) and not in_solution:
                in_solution = True
                i += 1
                continue
            (solution_lines if in_solution else statement_lines).append(ln)
            end_page = p_n
            i += 1

        blocks.append(ExerciseBlock(
            exercise_number=exercise_number,
            subpart=subpart,
            page_start=start_page,
            page_end=end_page,
            statement_markdown=_trim_block(statement_lines),
            solution_markdown=_trim_block(solution_lines) if solution_lines else None,
        ))
    return blocks


def detect_formulas(pages_markdown: list[tuple[int, str]]) -> list[FormulaBlock]:
    """Find every `$$ ... $$` display-math block, attaching the nearest
    preceding heading as the formula name when one is available.
    """
    blocks: list[FormulaBlock] = []
    for page_number, md in pages_markdown:
        if not md:
            continue
        lines = md.splitlines()
        nearest_heading: str | None = None
        i = 0
        while i < len(lines):
            line = lines[i].strip()

            if line.startswith("#"):
                nearest_heading = line.lstrip("#").strip() or None
                i += 1
                continue

            # Inline single-line "$$ x = y $$" form.
            inline = _INLINE_DISPLAY_MATH.match(lines[i])
            if inline:
                body = inline.group(1).strip()
                blocks.append(_make_formula(body, page_number, nearest_heading))
                i += 1
                continue

            # Multi-line $$ ... $$ block.
            if _DISPLAY_MATH_OPEN.match(line):
                body_lines: list[str] = []
                j = i + 1
                while j < len(lines) and not _DISPLAY_MATH_CLOSE.match(lines[j].strip()):
                    body_lines.append(lines[j])
                    j += 1
                body = "\n".join(body_lines).strip()
                if body:
                    blocks.append(_make_formula(body, page_number, nearest_heading))
                i = j + 1
                continue

            i += 1
    return blocks


# ── Helpers ──────────────────────────────────────────────────────────────────


def _trim_block(lines: list[str]) -> str:
    text = "\n".join(lines)
    # Collapse leading/trailing blanks, keep internal structure.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _make_formula(body: str, page_number: int, heading: str | None) -> FormulaBlock:
    wrapped = f"$$\n{body}\n$$"
    return FormulaBlock(
        formula_name=heading,
        formula_markdown=wrapped,
        page_number=page_number,
        symbols=_extract_symbols(body),
    )


def _extract_symbols(body: str) -> list[str]:
    """Return up to ~20 unique single-letter / subscripted variable names.

    Excludes pure numbers, common English words that slip through, and the
    unit token (Nm, kg, etc.) on the right-hand side of an equation.
    """
    seen: list[str] = []
    # English filler words — match case-insensitively.
    fillers = {"a", "an", "the", "of", "in", "is", "to", "and", "or", "for"}
    # SI unit tokens — match case-sensitively so "M" (moment) survives while "m" (meters) is dropped.
    units = {"kg", "Nm", "m", "s", "Hz", "Pa"}
    for raw in _SYMBOL_RE.findall(body):
        token = raw.strip()
        if not token or token.isdigit():
            continue
        if token.lower() in fillers:
            continue
        if token in units:
            continue
        if token not in seen:
            seen.append(token)
        if len(seen) >= 20:
            break
    return seen
