"""Token-bounded chunker that walks Phase-2 Markdown.

Design notes
------------
- Input is per-page Markdown produced by ``markdown_indexing.page_to_markdown``
  (or raw text — auto-converted for backward compatibility with older callers
  and tests). Walking the Markdown rather than the raw pdfminer text means the
  chunker shares Phase-2's heading detection, math-line classification, and
  page-quality grading instead of carrying parallel implementations.
- Targets ``target_tokens`` per chunk with ``overlap_tokens`` worth of prefix
  from the previous chunk, so retrieval rarely loses sentence context at
  boundaries. Tokeniser: tiktoken ``cl100k_base`` (same family used by
  text-embedding-3-small).
- Markdown blocks are paragraph-bounded (split on blank lines). Three block
  shapes get special handling:
    * Heading — starts with ``#`` (ATX). Flushes the current chunk so headings
      never end up mid-chunk, then becomes the ``section_title`` for the next.
    * Display math — starts with ``$$``. Treated atomically; never split
      mid-formula. If a math block alone exceeds ``target_tokens`` (rare —
      a long matrix), it ships as one over-budget chunk rather than being
      ripped apart.
    * Prose — anything else. Sentence-bounded sub-splits keep walls of text
      from blowing the budget.
- Chunk type guess is best-effort: matches German/English keywords for
  Aufgabe / Beispiel / Definition / Satz / Theorem / Formel / Lösung / etc.
- Returns a list of ``Chunk`` dataclasses ready to upsert into
  ``document_chunks``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Union

import tiktoken

from .markdown_indexing import PageMarkdown, page_to_markdown

# Same encoding family OpenAI uses for text-embedding-3-small and GPT-4 family.
_ENC = tiktoken.get_encoding("cl100k_base")


def _count_tokens(text: str) -> int:
    return len(_ENC.encode(text))


# ── Block classification ─────────────────────────────────────────────────────

# Phase-2 markdown emits headings as ``## Heading`` / ``### Sub`` (ATX form).
_ATX_HEADING = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*$")

# Phase-2 markdown emits display math as a paragraph that starts AND ends with
# ``$$`` (with the body on the lines between, or — for single-line equations
# — inline as ``$$ ... $$``).
_MATH_OPEN_OR_INLINE = re.compile(r"^\s*\$\$")


def _is_heading_block(block: str) -> bool:
    first_line = block.splitlines()[0] if block else ""
    return bool(_ATX_HEADING.match(first_line))


def _heading_text(block: str) -> str:
    m = _ATX_HEADING.match(block.splitlines()[0])
    return m.group(2).strip() if m else block.strip()


def _is_math_block(block: str) -> bool:
    return bool(_MATH_OPEN_OR_INLINE.match(block))


# Phase 3 Step C — exercise headings open a no-split region.
# Reuses block_detection's pattern so the chunker, the exercise-table
# extractor, and any future exact-match retrieval all agree on what counts
# as an "exercise X" header. The regex is tolerant of leading ``##`` markers
# since Phase-2 markdown promotes ``Aufgabe X`` to ``## Aufgabe X``.
_EXERCISE_HEADER_LINE = re.compile(
    r"^(?:#{1,6}\s*)?"
    r"(Aufgabe|Übung|Uebung|Exercise|Problem|Task|Beispiel)"
    r"\s+(\d+(?:\.\d+){0,3})"
    r"(?:\s*[\(\[]?([a-zA-Z])[\)\]]?\.?)?"
    r"[:\.\s]*$",
    re.IGNORECASE,
)


def _is_exercise_heading(heading_text: str) -> bool:
    """True when a heading line names an exercise (``Aufgabe 1.2``,
    ``Exercise 3``, ``Übung 2``, …). Step C uses this to switch the chunker
    into a no-split accumulation mode so the exercise statement stays in one
    chunk regardless of token budget."""
    return bool(_EXERCISE_HEADER_LINE.match((heading_text or "").strip()))


def _parse_exercise_heading(heading_text: str) -> tuple[str | None, str | None]:
    """Pull ``(exercise_number, subpart)`` from an exercise heading.

    Examples::

        "Aufgabe 9.1 a)" → ("9.1", "a")
        "Übung 3"        → ("3",   None)
        "Theoriekapitel" → (None,  None)

    Step D uses this so chunks emitted from the no-split exercise region
    carry the same identifiers as the matching ``document_exercises`` row,
    which is what the FK is joined on at insert time.
    """
    m = _EXERCISE_HEADER_LINE.match((heading_text or "").strip())
    if not m:
        return None, None
    number = m.group(2)
    subpart = (m.group(3) or "").lower() or None
    return number, subpart


# Keywords we use to tag chunk_type. Order matters — first match wins.
_TYPE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("definition",  re.compile(r"\b(definition|definiere|begriff)\b", re.I)),
    ("theorem",     re.compile(r"\b(theorem|satz|lemma|korollar|corollary)\b", re.I)),
    ("formula",     re.compile(r"\b(formel|formula|gleichung|equation)\b", re.I)),
    ("example",     re.compile(r"\b(beispiel|example|bsp\.)\b", re.I)),
    ("exercise",    re.compile(r"\b(aufgabe|übung|exercise|problem)\b", re.I)),
    ("solution",    re.compile(r"\b(lösung|lösungsweg|solution)\b", re.I)),
]


def _classify_chunk(text: str, heading: str | None) -> str:
    haystack = f"{heading or ''}\n{text}"
    for kind, pat in _TYPE_PATTERNS:
        if pat.search(haystack):
            return kind
    return "general"


# ── Chunker ──────────────────────────────────────────────────────────────────


@dataclass
class Chunk:
    chunk_text: str
    page_start: int
    page_end: int
    chunk_type: str
    section_title: str | None
    token_count: int
    # Phase 3 Step D — populated when the chunk was emitted from inside an
    # exercise no-split region. Indexing resolves these against the
    # ``document_exercises`` rows to set ``document_chunks.exercise_id``.
    # Left NULL for non-exercise chunks (lecture, summary, formula
    # companion under a non-exercise heading, …).
    exercise_number: str | None = None
    exercise_subpart: str | None = None


# Public input alias — accept either raw page strings or pre-built PageMarkdown.
PageInput = Union[str, PageMarkdown]


def chunk_pages(
    pages: list[PageInput],
    target_tokens: int = 700,
    overlap_tokens: int = 80,
    min_chunk_tokens: int = 80,
) -> list[Chunk]:
    """Greedy Markdown-bounded chunker with overlap and heading awareness.

    ``pages`` may be a list of raw page strings (legacy / test path — each is
    converted to Markdown internally) or pre-built ``PageMarkdown`` objects
    from the indexing pipeline (preferred — avoids double conversion).

    A chunk is emitted when (a) adding the next block would exceed
    ``target_tokens``, (b) a heading block is reached, or (c) end of document.
    Display-math blocks (``$$ ... $$``) are kept atomic — they never split
    across chunks, even if that pushes a single chunk over budget.
    """
    if not pages:
        return []

    pages_md = _normalise_pages(pages)
    if not pages_md:
        return []

    chunks: list[Chunk] = []
    current_text_parts: list[str] = []
    current_tokens = 0
    current_page_start: int | None = None
    current_page_end: int | None = None
    current_heading: str | None = None
    # Phase 3 Step C — once an exercise heading is seen, accumulate the body
    # without size-driven flushes so the statement, formulas, and solution
    # lines all land in one chunk together. The token-budget gates we'd
    # normally apply (prose sentence-splitting, math overflow guard) are
    # bypassed for as long as this flag is on. The flag flips off only when
    # the next heading arrives (exercise or otherwise) or the document ends.
    in_exercise = False
    # Phase 3 Step D — exercise identifiers extracted from the current
    # exercise heading. Stamped on every chunk emitted while ``in_exercise``
    # is true so indexing can resolve them to ``document_exercises.id``.
    current_exercise_number: str | None = None
    current_exercise_subpart: str | None = None

    def flush(reason: str) -> None:  # noqa: ARG001 — reason kept for debugging
        nonlocal current_text_parts, current_tokens, current_page_start, current_page_end
        text = "\n\n".join(p for p in current_text_parts if p).strip()
        if text and current_tokens >= min_chunk_tokens and current_page_start is not None:
            chunks.append(Chunk(
                chunk_text=text,
                page_start=current_page_start,
                page_end=current_page_end or current_page_start,
                chunk_type=_classify_chunk(text, current_heading),
                section_title=current_heading,
                token_count=current_tokens,
                exercise_number=current_exercise_number if in_exercise else None,
                exercise_subpart=current_exercise_subpart if in_exercise else None,
            ))
        current_text_parts = []
        current_tokens = 0
        current_page_start = None
        current_page_end = None

    for page in pages_md:
        page_number = page.page_number
        md = (page.markdown or "").strip()
        if not md or md == "[unclear]":
            continue

        for block in _split_blocks(md):
            # ── Heading: flush, set section title, do not accumulate body ──
            if _is_heading_block(block):
                flush("heading")
                current_heading = _heading_text(block)
                # Step C/D — entering an exercise opens the no-split region
                # AND captures the identifiers for the chunk's FK; any other
                # heading closes the region and clears the identifiers.
                if _is_exercise_heading(current_heading):
                    in_exercise = True
                    current_exercise_number, current_exercise_subpart = (
                        _parse_exercise_heading(current_heading)
                    )
                else:
                    in_exercise = False
                    current_exercise_number = None
                    current_exercise_subpart = None
                continue

            # ── Math display block: atomic, never split. May exceed budget. ──
            if _is_math_block(block):
                m_tokens = _count_tokens(block)
                # Inside a Step-C exercise region: never split — the whole
                # exercise (statement + formulas + solution lines) stays
                # together. Outside: respect the size budget as before.
                if (
                    not in_exercise
                    and current_tokens > 0
                    and current_tokens + m_tokens > target_tokens
                ):
                    tail = _overlap_tail(current_text_parts, overlap_tokens)
                    flush("size-before-math")
                    if tail:
                        current_text_parts = [tail]
                        current_tokens = _count_tokens(tail)
                        current_page_start = page_number
                        current_page_end = page_number
                current_text_parts.append(block)
                current_tokens += m_tokens
                if current_page_start is None:
                    current_page_start = page_number
                current_page_end = page_number

                # ── Phase 3 Step B — atomic formula companion chunk ──
                # In addition to keeping the formula inside the parent
                # context chunk above, emit a small standalone chunk holding
                # just the heading + the formula. The dense single-formula
                # surface ranks much better for "what's the formula for X?"
                # queries than the 700-token lecture chunk it sits inside,
                # and the parent chunk still grounds the formula in
                # surrounding context for explanatory questions.
                companion = _build_formula_companion(
                    formula_block=block,
                    heading=current_heading,
                    page=page_number,
                    exercise_number=current_exercise_number if in_exercise else None,
                    exercise_subpart=current_exercise_subpart if in_exercise else None,
                )
                if companion is not None:
                    chunks.append(companion)
                continue

            # ── Prose: may need sentence-bounded sub-splitting ──
            # Inside a Step-C exercise region: skip the budget-driven splits
            # AND the sentence-bounded segmentation. We keep the whole prose
            # paragraph as one segment so the chunker only joins on the
            # natural ``\n\n`` paragraph boundary. The point is that an
            # exercise statement reads as one thing — ripping it on the 700th
            # token loses the question.
            if in_exercise:
                segments: Iterable[str] = (block,)
            else:
                segments = _bounded_segments(block, target_tokens)
            for segment in segments:
                seg_tokens = _count_tokens(segment)
                if seg_tokens == 0:
                    continue
                if (
                    not in_exercise
                    and current_tokens > 0
                    and current_tokens + seg_tokens > target_tokens
                ):
                    tail = _overlap_tail(current_text_parts, overlap_tokens)
                    flush("size")
                    if tail:
                        current_text_parts = [tail]
                        current_tokens = _count_tokens(tail)
                        current_page_start = page_number
                        current_page_end = page_number
                current_text_parts.append(segment)
                current_tokens += seg_tokens
                if current_page_start is None:
                    current_page_start = page_number
                current_page_end = page_number

    flush("end")
    return chunks


# ── Helpers ──────────────────────────────────────────────────────────────────


def _normalise_pages(pages: list[PageInput]) -> list[PageMarkdown]:
    """Convert raw page strings to PageMarkdown for the walker. Passes
    PageMarkdown through unchanged."""
    out: list[PageMarkdown] = []
    for idx, item in enumerate(pages):
        if isinstance(item, PageMarkdown):
            out.append(item)
        elif isinstance(item, str):
            if item.strip():
                out.append(page_to_markdown(item, idx + 1))
        # Silently skip anything else — keeps the contract permissive for
        # tests/legacy callers that may pass None for missing pages.
    return out


def _split_blocks(md: str) -> Iterable[str]:
    """Split Markdown into paragraph-shaped blocks on blank lines, preserving
    multi-line math fences as a single block."""
    blocks: list[str] = []
    buf: list[str] = []
    in_math = False
    for line in md.splitlines():
        stripped = line.strip()
        # Single-line "$$ x = y $$" form — emits as its own block.
        if not in_math and re.match(r"^\s*\$\$.+\$\$\s*$", stripped):
            if buf:
                blocks.append("\n".join(buf).strip())
                buf = []
            blocks.append(stripped)
            continue
        # Opening fence of a multi-line $$ ... $$ block.
        if not in_math and stripped.startswith("$$") and stripped == "$$":
            if buf:
                blocks.append("\n".join(buf).strip())
                buf = []
            buf.append(line)
            in_math = True
            continue
        # Closing fence — emit the whole math block as one.
        if in_math and stripped == "$$":
            buf.append(line)
            blocks.append("\n".join(buf).strip())
            buf = []
            in_math = False
            continue
        # Inside a math block: keep accumulating without splitting on blanks.
        if in_math:
            buf.append(line)
            continue
        # Blank line outside math — paragraph break.
        if not stripped:
            if buf:
                blocks.append("\n".join(buf).strip())
                buf = []
            continue
        buf.append(line)

    if buf:
        blocks.append("\n".join(buf).strip())
    return [b for b in blocks if b]


# Sentence-boundary regex — keeps the punctuation with the sentence it ended.
_SENTENCE_END = re.compile(r"(?<=[\.\?\!])\s+(?=[A-Z0-9„\"\(\[])")


def _bounded_segments(paragraph: str, target_tokens: int) -> Iterable[str]:
    """Yield sub-paragraph segments that each fit roughly within target_tokens.

    For normal-sized paragraphs we just yield the original. For walls of
    text (no double-newlines) we split on sentence boundaries and pack
    sentences into segments until each segment approaches the budget.
    """
    if _count_tokens(paragraph) <= target_tokens:
        yield paragraph
        return

    sentences = [s.strip() for s in _SENTENCE_END.split(paragraph) if s.strip()]
    if not sentences:
        yield paragraph
        return

    buf: list[str] = []
    buf_tokens = 0
    for sent in sentences:
        s_tokens = _count_tokens(sent)
        if buf and buf_tokens + s_tokens > target_tokens:
            yield " ".join(buf)
            buf = []
            buf_tokens = 0
        buf.append(sent)
        buf_tokens += s_tokens
    if buf:
        yield " ".join(buf)


# ── Phase 3 Step B helpers ──────────────────────────────────────────────────


# Min/max bounds for the companion formula chunk. Below the floor we'd be
# embedding a near-trivial token sequence (e.g. ``$$ x = y $$``) — embeddings
# of such short text rarely surface in retrieval, so we'd be paying for a row
# that never gets read. Above the ceiling the companion stops being "the
# formula and only the formula" and starts duplicating a chunk of prose
# already covered by the parent context chunk, which inflates the retrieval
# index without adding signal.
_FORMULA_COMPANION_MIN_TOKENS = 6
_FORMULA_COMPANION_MAX_TOKENS = 200


def _build_formula_companion(
    *,
    formula_block: str,
    heading: str | None,
    page: int,
    exercise_number: str | None = None,
    exercise_subpart: str | None = None,
) -> Chunk | None:
    """Build a small standalone ``chunk_type='formula'`` chunk wrapping just
    the formula and (if available) its section heading.

    Returns ``None`` when the formula is too small to be a useful retrieval
    surface on its own — the parent context chunk still carries it.
    """
    parts: list[str] = []
    if heading:
        parts.append(f"## {heading}")
    parts.append(formula_block)
    text = "\n\n".join(parts).strip()
    if not text:
        return None
    token_count = _count_tokens(text)
    if token_count < _FORMULA_COMPANION_MIN_TOKENS:
        return None
    if token_count > _FORMULA_COMPANION_MAX_TOKENS:
        # A single formula block this big almost certainly contains a long
        # derivation. Don't double-index it as a "formula" — the parent
        # chunk handles it.
        return None
    return Chunk(
        chunk_text=text,
        page_start=page,
        page_end=page,
        chunk_type="formula",
        section_title=heading,
        token_count=token_count,
        exercise_number=exercise_number,
        exercise_subpart=exercise_subpart,
    )


def _overlap_tail(parts: list[str], overlap_tokens: int) -> str:
    """Return the last `overlap_tokens` worth of text, walking parts back to front."""
    if not parts or overlap_tokens <= 0:
        return ""
    acc: list[str] = []
    total = 0
    for part in reversed(parts):
        toks = _count_tokens(part)
        if total + toks > overlap_tokens and acc:
            break
        acc.insert(0, part)
        total += toks
        if total >= overlap_tokens:
            break
    return "\n\n".join(acc).strip()
