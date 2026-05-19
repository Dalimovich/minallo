"""Deterministic page-text → Markdown converter.

Phase 1 of the AI/RAG plan: produce a cleaned Markdown representation of each
PDF page so downstream retrieval, exercise/formula detection, and citation
rendering have a structured source to work with. No LLM is involved — every
transformation is rule-based so the output is reproducible across runs.

Rules the converter follows:
  * Numbered headings ("1.2 Force"), short ALL-CAPS lines, and short
    title-case lines are promoted to ATX headings. Numbered depth maps to
    heading level (1.2 → ##, 1.2.3 → ###).
  * Lines that look like math (operators dominate, contains LaTeX-style
    symbols, or runs of '=' / '∑' / '∫' etc.) are wrapped in `$$ ... $$`
    display-math fences.
  * Bullet markers (-, *, •, –, (a), (i)) are normalised to `- `.
  * Paragraph text is preserved as-is with blank-line separators.
  * Empty / clearly-garbled pages emit `[unclear]` so downstream knows the
    extraction is not trustworthy.

Each conversion also returns an *extraction quality* tag:
  * "good"    — normal-looking page with sentences and headings
  * "weak"    — very short, mostly numbers/symbols, or low character entropy
  * "failed"  — no extractable text at all
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

# ── Tunables ─────────────────────────────────────────────────────────────────

MIN_GOOD_CHARS = 120         # below this we suspect weak extraction
MIN_GOOD_LETTERS = 60        # letters (not digits/symbols) needed for "good"
MATH_OPERATOR_RATIO = 0.18   # fraction of math symbols above which a line is math

# Math symbols we recognise as evidence a line is a formula.
_MATH_CHARS = set("=<>±≤≥≠≈≡∑∫∂√πΣΔθωλμνβγα∇·×÷→←↔⇒⇐⇔∈∉⊂⊃∪∩∀∃∞^/*+\\")

_NUMBERED_HEADING = re.compile(r"^\s*(\d+(?:\.\d+){0,3})\s+(.{2,80})$")
_SHORT_CAPS_HEADING = re.compile(r"^[A-Z][A-Z0-9 \-–&,/]{2,60}$")
_TITLE_CASE_HEADING = re.compile(r"^[A-Z][\w][\w \-–&,/]{2,60}$")

_BULLET_PREFIX = re.compile(r"^\s*(?:[-*•–]|\([a-zA-Z0-9]{1,3}\))\s+")


# ── Public API ───────────────────────────────────────────────────────────────


@dataclass
class PageMarkdown:
    """Result of converting a single page to Markdown."""

    page_number: int
    markdown: str
    quality: str  # "good" | "weak" | "failed"


def page_to_markdown(page_text: str, page_number: int) -> PageMarkdown:
    """Convert one page of extracted text to Markdown.

    The conversion is deliberately conservative — no content is invented and
    obviously-garbled pages surface as `[unclear]` so retrieval can downweight
    them.
    """
    text = (page_text or "").strip()
    if not text:
        return PageMarkdown(page_number=page_number, markdown="[unclear]", quality="failed")

    quality = _grade_extraction(text)
    if quality == "failed":
        return PageMarkdown(page_number=page_number, markdown="[unclear]", quality="failed")

    lines_out: list[str] = []
    for block in _split_blocks(text):
        rendered = _render_block(block)
        if rendered:
            lines_out.append(rendered)

    md = "\n\n".join(lines_out).strip() or "[unclear]"
    if md == "[unclear]":
        quality = "failed"
    return PageMarkdown(page_number=page_number, markdown=md, quality=quality)


def assemble_document_markdown(
    pages: list[PageMarkdown],
    source_filename: str,
) -> str:
    """Stitch page-level Markdown into a single document Markdown string.

    Pages are separated by an HTML comment carrying the page number so any
    later tool (chunker, exercise detector) can still locate text within a
    specific page without keeping a parallel page-index data structure.
    """
    if not pages:
        return ""
    parts: list[str] = [f"<!-- source: {source_filename} -->"]
    for page in pages:
        parts.append(f"<!-- page: {page.page_number} -->")
        parts.append(page.markdown if page.markdown else "[unclear]")
    return "\n\n".join(parts).strip() + "\n"


def wrap_chunk_markdown(
    chunk_text: str,
    *,
    source_filename: str,
    page_start: int,
    page_end: int,
    chunk_type: str,
    section_title: str | None = None,
) -> str:
    """Wrap a chunk in the metadata comment block the AI sees during retrieval.

    The comments are not displayed to the user but give the model deterministic
    grounding hooks (filename, page range, chunk type) it can cite.
    """
    page_field = (
        f"{page_start}" if page_start == page_end else f"{page_start}-{page_end}"
    )
    header_lines: list[str] = [
        f"<!-- source: {source_filename} -->",
        f"<!-- page: {page_field} -->",
        f"<!-- chunk_type: {chunk_type} -->",
    ]
    if section_title:
        header_lines.append(f"<!-- section: {section_title} -->")
    header = "\n".join(header_lines)
    body = (chunk_text or "").strip() or "[unclear]"
    return f"{header}\n\n{body}\n"


# ── Quality scoring ──────────────────────────────────────────────────────────


def _grade_extraction(text: str) -> str:
    """Score how trustworthy the page-level extraction looks.

    Heuristic only — wrong on rare adversarial inputs (e.g. a page that is
    intentionally a single short title) but correct in aggregate, which is
    what the retrieval ranker cares about.
    """
    if len(text) < 20:
        return "failed"
    if len(text) < MIN_GOOD_CHARS:
        return "weak"

    letters = sum(1 for ch in text if ch.isalpha())
    if letters < MIN_GOOD_LETTERS:
        return "weak"

    # Almost-no-spaces text is usually a wall of OCR garbage.
    spaces = text.count(" ")
    if spaces < letters / 10:
        return "weak"

    return "good"


# ── Block-level rendering ────────────────────────────────────────────────────


_BLANK_LINE = re.compile(r"\n\s*\n")


def _split_blocks(text: str) -> Iterable[str]:
    """Split a page into paragraph-like blocks on double-newlines."""
    for block in _BLANK_LINE.split(text):
        block = block.strip()
        if block:
            yield block


def _render_block(block: str) -> str:
    """Convert a paragraph block into its Markdown representation."""
    lines = [ln for ln in block.splitlines() if ln.strip()]
    if not lines:
        return ""

    # Single-line block: classify the whole line.
    if len(lines) == 1:
        return _render_single_line(lines[0])

    # Multi-line block: if every line looks like a bullet, render as list.
    if all(_BULLET_PREFIX.match(ln) for ln in lines):
        return "\n".join("- " + _BULLET_PREFIX.sub("", ln).strip() for ln in lines)

    # If every line looks like math, render as a single display-math block.
    if all(_looks_like_math(ln) for ln in lines):
        return "$$\n" + "\n".join(ln.strip() for ln in lines) + "\n$$"

    # Default: heading promotion on the first line if it qualifies, else
    # plain paragraph (newlines collapsed to spaces — pdfminer breaks mid-
    # sentence on column wraps).
    first = lines[0].strip()
    rest = " ".join(ln.strip() for ln in lines[1:]).strip()
    if _looks_like_heading(first):
        body = _format_heading(first)
        return body + ("\n\n" + rest if rest else "")
    return " ".join(ln.strip() for ln in lines)


def _render_single_line(line: str) -> str:
    line = line.strip()
    if not line:
        return ""
    if _looks_like_heading(line):
        return _format_heading(line)
    if _looks_like_math(line):
        return f"$$\n{line}\n$$"
    if _BULLET_PREFIX.match(line):
        return "- " + _BULLET_PREFIX.sub("", line).strip()
    return line


# ── Heading detection ────────────────────────────────────────────────────────


def _looks_like_heading(line: str) -> bool:
    line = line.strip()
    if len(line) < 3 or len(line) > 80:
        return False
    if line.endswith((".", ":", ",", ";", "?", "!")):
        return False
    if _NUMBERED_HEADING.match(line):
        return True
    if _SHORT_CAPS_HEADING.match(line):
        return True
    if _TITLE_CASE_HEADING.match(line):
        words = [w for w in line.split() if w]
        caps = sum(1 for w in words if w[:1].isupper())
        return len(words) <= 8 and caps / max(len(words), 1) >= 0.6
    return False


def _format_heading(line: str) -> str:
    """Promote a heading line to an ATX heading at the right depth."""
    m = _NUMBERED_HEADING.match(line)
    if m:
        depth = min(m.group(1).count(".") + 2, 6)  # "1" → ##, "1.2" → ###, capped at ######
        return "#" * depth + " " + line.strip()
    return "## " + line.strip()


# ── Math detection ───────────────────────────────────────────────────────────


def _looks_like_math(line: str) -> bool:
    s = line.strip()
    if len(s) < 2:
        return False
    # Quick reject: lines that are clearly sentences shouldn't be math.
    if s.endswith((".", "?", "!")) and " " in s and not any(
        c in s for c in "=∑∫∂√≤≥≠≈≡"
    ):
        return False
    math_chars = sum(1 for ch in s if ch in _MATH_CHARS)
    if math_chars == 0:
        return False
    non_space = max(sum(1 for ch in s if not ch.isspace()), 1)
    return math_chars / non_space >= MATH_OPERATOR_RATIO
