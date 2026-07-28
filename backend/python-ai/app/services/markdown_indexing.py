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
import unicodedata
from dataclasses import dataclass
from typing import Iterable


# ── Unicode math normalisation ───────────────────────────────────────────────
#
# Some PDFs (TU course Formelzettel template, in particular) typeset formulas
# using the **Mathematical Alphanumeric Symbols** block (U+1D400–1D7FF). To
# pdfminer this is just text, so chunks come out containing characters like
# ``𝐴𝑒𝑟𝑠 = 𝜋/4 (𝐷𝐴² − 𝑑ℎ²)``. Downstream:
#   * the math-line detector misses it (the operators count fine but the
#     italic-style letters confuse the assignment-line regex which expects
#     plain ASCII identifiers),
#   * the chunker never emits a ``$$...$$`` block, so no formula companion
#     chunk is created,
#   * a user query for "Querschnittsfläche A_S" never lexically matches the
#     ``𝐴𝑆`` in the chunk text.
#
# NFKC compatibility-normalises these to their plain ASCII / Greek letter
# equivalents:
#   ``𝐴𝑒𝑟𝑠 = 𝜋/4`` → ``Aers = π/4``
#   ``𝛿`` → ``δ``
# After normalisation the formula is searchable AND the existing Phase-2
# detectors (assignment-pattern, math-operator-ratio, Greek-letter) fire
# normally, so chunk_type='formula' companions get emitted on reindex.


def _normalise_math_unicode(text: str) -> str:
    """NFKC-normalise Mathematical Alphanumeric Symbols to plain letters.

    Applied at the top of ``page_to_markdown`` so every downstream stage
    (heading detection, math detection, chunking, embedding, retrieval text)
    sees the same searchable form. NFKC is a standard Python normalisation
    — no custom mapping table to maintain."""
    if not text:
        return text
    return unicodedata.normalize("NFKC", text)

# ── Tunables ─────────────────────────────────────────────────────────────────

MIN_GOOD_CHARS = 120         # below this we suspect weak extraction
MIN_GOOD_LETTERS = 60        # letters (not digits/symbols) needed for "good"
MATH_OPERATOR_RATIO = 0.18   # fraction of math symbols above which a line is math
MATH_OPERATOR_RATIO_RELAXED = 0.12  # relaxed bar for lines that contain `=`

# Math symbols we recognise as evidence a line is a formula.
_MATH_CHARS = set("=<>±≤≥≠≈≡∑∫∂√πΣΔθωλμνβγα∇·×÷→←↔⇒⇐⇔∈∉⊂⊃∪∩∀∃∞^/*+\\")

# Greek letters used as variable names in engineering / physics formulas.
# Used both by the math-line classifier (line beginning with τ/σ/π/… is a
# strong signal even at low operator density) and the assignment-pattern
# sanity gate (RHS containing a Greek letter is allowed even without digits).
_GREEK_VARS = "τσπμθΔΣωαβγδεζηκλνξορφχψτ°"

# Quality-grading thresholds for `_grade_extraction`.
_MIN_AVG_WORD_LEN = 3.0      # avg word shorter than this → fragmented OCR
_MAX_AVG_WORD_LEN = 18.0     # avg word longer than this → no spaces, OCR garble
# Why 0.50 (not 0.35): formula-heavy engineering pages legitimately contain
# many single-char tokens (`z`, `F`, `d`, `J`, `A_S` → 'A' + 'S', …). The
# tighter 0.35 bar demoted real Aufgabe pages to ``weak``. 0.50 still catches
# true OCR fragmentation (``Sch w eiss n a h t`` scores 0.54+) without
# punishing formula sheets.
_MAX_BROKEN_WORD_RATIO = 0.50
_MAX_PUNCT_DENSITY = 0.10    # punctuation chars / total chars

# Numbered heading: `1`, `1.2`, `4.3.2`, etc., followed by text.
_NUMBERED_HEADING = re.compile(r"^\s*(\d+(?:\.\d+){0,3})\s+(.{2,80})$")
# ALL-CAPS short heading: "INTRODUCTION", "BACKGROUND", "TABLE OF CONTENTS".
_SHORT_CAPS_HEADING = re.compile(r"^[A-Z][A-Z0-9 \-–&,/]{2,60}$")
# Title-case heading: "Newton's Second Law", "Die Schraubenverbindung".
# Allow apostrophes inside words and umlaut letters.
_TITLE_CASE_HEADING = re.compile(r"^[A-ZÄÖÜ][\wÄÖÜäöüß'’][\wÄÖÜäöüß' \-–&,/’]{2,60}$")

# Assignment line: `identifier = expression [unit]`. Catches engineering
# formulas the symbol-ratio classifier misses because the line is mostly
# letters (e.g. `Setzbetrag fz,ges = 20 μm = 0.02 mm`).
_ASSIGNMENT_LINE_RE = re.compile(
    r"^\s*"
    # Optional German "label:" prefix — "Anzahl der Schrauben: z = 30",
    # "Maximaler Überdruck im Behälter: p_max = 9 N/mm²". The label is a
    # short noun phrase ending in `:`.
    r"(?:[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\- ]{0,40}:\s*)?"
    # 0-3 optional leading words (e.g. "Setzbetrag fz,ges = …").
    r"(?:[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-]+\s+){0,3}"
    # Identifier head.
    r"[A-Za-zÄÖÜäöüß" + _GREEK_VARS + r"]"
    r"[A-Za-zÄÖÜäöüß0-9_,.\{\}\\\-" + _GREEK_VARS + r"]{0,30}"
    r"\s*(?:=|≈|≃|≤|≥|:=)\s*"
    # RHS: digits, letters (incl. umlauts/Greek), math operators, unit
    # marks. Includes super/subscript digits (mm², kg₂) that show up in
    # engineering text but aren't word/digit chars.
    r"[-+0-9A-Za-zÄÖÜäöüß·×÷/\^\(\)\[\]\{\}\\,. \t²³⁰¹⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉" + _GREEK_VARS + r"=]+"
    r"\s*$"
)
# RHS must have at least one digit OR a Greek letter OR a math operator,
# otherwise `Funktion = Quatsch` would match. Applied AFTER _ASSIGNMENT_LINE_RE.
_ASSIGNMENT_RHS_GATE_RE = re.compile(
    r"(?:=|≈|≃|≤|≥|:=)"
    r"[^=≈≃≤≥]*"
    r"(?:[0-9]|[" + _GREEK_VARS + r"]|[·×÷√π∑∫±])"
)
# A line starting with a Greek-letter variable followed by `=` within ~15
# chars is a formula even at low operator ratio: "τ_Schw = F / A".
_GREEK_LED_FORMULA_RE = re.compile(r"^\s*[" + _GREEK_VARS + r"][^\n=]{0,15}=")

# German technical heading keyword set. Used by `_looks_like_heading`: a
# short line containing one of these as a standalone word counts as a
# heading even if it doesn't pass title-case / caps / numbered tests
# (German nouns often start title-case but function words like "die"/"der"
# don't, dropping the line below the 60% capitalised threshold).
_DE_HEADING_KEYWORDS = frozenset({
    "berechnung", "nachweis", "beanspruchung", "spannung", "kraft",
    "moment", "lösung", "loesung", "aufgabe", "übung", "uebung",
    "beispiel", "formel", "definition", "satz", "verfahren",
    "schweißnaht", "schweissnaht", "schraubenverbindung", "festigkeit",
    "verformung", "biegung", "torsion", "schub", "zug", "druck", "dehnung",
    "gegeben", "gesucht", "lösungsansatz", "musterlösung", "musterloesung",
})
_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-]+", re.UNICODE)

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
    text = _normalise_math_unicode((page_text or "").strip())
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

    Phase 2 tightening: pages with the right character count but mangled
    word shapes (broken pdfminer wraps, OCR garble) are demoted to ``weak``
    so retrieval reranking penalises them via the page-quality boost.
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

    # ── Phase 2 stricter checks ────────────────────────────────────────
    # Tokenise INCLUDING single-letter fragments — those are the strongest
    # OCR-fragmentation signal and would be filtered out by the multi-char
    # `_WORD_RE`.
    tokens = re.findall(r"[A-Za-zÄÖÜäöüß]+", text)
    if not tokens:
        return "weak"
    token_count = len(tokens)

    # 1. Avg token length. <3 → fragmented (pdfminer broke words at column
    #    wraps, "Sch w eiss n a h t"); >18 → no real word boundaries.
    avg_token_len = letters / token_count
    if avg_token_len < _MIN_AVG_WORD_LEN or avg_token_len > _MAX_AVG_WORD_LEN:
        return "weak"

    # 2. Broken-token ratio. Single chars (other than common pronouns /
    #    articles), or 4+-char tokens with no vowel, are OCR artifacts.
    broken = 0
    vowels = set("aeiouäöüAEIOUÄÖÜ")
    keep_single = {"a", "i", "I", "A", "o", "O"}
    for w in tokens:
        if len(w) == 1 and w not in keep_single:
            broken += 1
            continue
        if len(w) >= 4 and not (set(w) & vowels):
            broken += 1
    if broken / token_count > _MAX_BROKEN_WORD_RATIO:
        return "weak"

    # 3. Punctuation density — runaway punctuation (>10% of chars) usually
    #    means the page is a TOC dotted-leader line or junk symbol stream.
    punct = sum(1 for ch in text if ch in ".,;:!?")
    if punct / max(len(text), 1) > _MAX_PUNCT_DENSITY:
        return "weak"

    return "good"


# ── Block-level rendering ────────────────────────────────────────────────────


_BLANK_LINE = re.compile(r"\n\s*\n")

# Phase 3 follow-up — recognise an exercise heading line so we can force a
# paragraph break before it, even when the upstream PDF extractor ran the
# document banner, lecturer names, and the exercise heading into one
# unbroken block. Without this, ``Übungsaufgabe 9.1`` ends up buried mid-
# paragraph and `detect_exercises` (which only matches at line start) never
# fires — leaving the exercise-exact retrieval path completely dead.
_EXERCISE_HEADING_LINE = re.compile(
    r"^\s*"
    r"(?:Aufgabe|Übungsaufgabe|Übung|Uebungsaufgabe|Uebung|Exercise|Problem|Task|Beispiel|Example)"
    r"\s+\d+(?:\.\d+){0,3}"
    r"(?:\s*[\(\[]?[a-zA-Z][\)\]]?\.?)?"
    r"\s*$",
    re.IGNORECASE,
)


def _split_blocks(text: str) -> Iterable[str]:
    """Split a page into paragraph-like blocks.

    Two passes:
      1. Split on blank lines (the normal paragraph boundary).
      2. Within each resulting block, force an additional break BEFORE any
         line matching ``_EXERCISE_HEADING_LINE`` so the exercise heading
         lands on its own block and the downstream heading-promoter can
         render it as ``## Übungsaufgabe X``. Required because academic
         PDF templates (lecture banner + names + exercise heading + body)
         frequently arrive from pdfminer without the blank line that would
         have separated the heading.
    """
    for blank_block in _BLANK_LINE.split(text):
        for sub in _force_split_on_exercise_headings(blank_block):
            sub = sub.strip()
            if sub:
                yield sub


def _force_split_on_exercise_headings(block: str) -> list[str]:
    """Break ``block`` into sub-blocks whenever an exercise heading line
    appears, even mid-paragraph. The heading line itself becomes the first
    line of the new sub-block so the multi-line promoter (``_render_block``)
    sees it at index 0 and lifts it to ``## …``."""
    lines = block.splitlines()
    if not lines:
        return []
    out: list[list[str]] = []
    buf: list[str] = []
    for line in lines:
        if _EXERCISE_HEADING_LINE.match(line.strip()) and buf:
            out.append(buf)
            buf = [line]
        else:
            buf.append(line)
    if buf:
        out.append(buf)
    return ["\n".join(b) for b in out]


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
    """Multi-signal heading detector.

    Basic shape filter (length 3-80, ≤10 words, no trailing `,`/`;`) AND
    at least one of:

    * exercise heading (``Übungsaufgabe 9.1``, ``Exercise 3 (a)``,
      ``Beispiel 2 b``) — short-circuits the whole detector so the rest
      of the shape filters can't accidentally reject them. Critical for
      retrieval: ``detect_exercises`` only matches lines that start with
      ``# ``, so an exercise label that the heading promoter ignores is
      invisible to the exercise-exact retrieval path.
    * numbered prefix (``1.2 Force``)
    * ALL-CAPS short line
    * title-case ≥60% capitalised, ≤8 words (period allowed when ≤6 words —
      "Biegung und Torsion." is a slide heading, not a sentence)
    * colon-terminated ≤6-word line (``Spannungsnachweis:``, ``Lösung:``)
    * contains a German technical heading keyword as a standalone word
      (``Die Schweißnaht-Berechnung``)
    """
    line = line.strip()
    if _EXERCISE_HEADING_LINE.match(line):
        return True
    if len(line) < 3 or len(line) > 80:
        return False
    if line.endswith((",", ";")):
        return False
    words = [w for w in line.split() if w]
    if not words or len(words) > 10:
        return False

    # Internal colons / question / exclamation marks are sentence patterns
    # — disqualify before the per-signal checks (covers "Spannung: das ist
    # die Kraft pro Fläche").
    if line.endswith(("?", "!")):
        return False
    inner = line[:-1] if line.endswith((":", ".")) else line
    if ":" in inner or "?" in inner or "!" in inner:
        return False

    # Signal 1: numbered prefix.
    if _NUMBERED_HEADING.match(line):
        return True
    # Signal 2: short ALL-CAPS.
    if _SHORT_CAPS_HEADING.match(line):
        return True
    # Signal 3: title-case. Allow a trailing period when the line is short
    # enough to obviously be a heading rather than a sentence.
    title_candidate = line.rstrip(".").rstrip()
    if _TITLE_CASE_HEADING.match(title_candidate):
        caps = sum(1 for w in words if w[:1].isupper())
        cap_ratio = caps / max(len(words), 1)
        if line.endswith("."):
            # Period-terminated headings must be tighter to avoid catching
            # short prose ("Es gilt das Hookesche Gesetz.", "Berechnen Sie
            # die Spannung nach Hooke."). 4 words covers the realistic
            # heading shape ("Biegung und Torsion.", "Lineare Elastizität.")
            # without grabbing 5-6-word sentences.
            if len(words) <= 4 and cap_ratio >= 0.6:
                return True
        elif len(words) <= 8 and cap_ratio >= 0.6:
            return True
    # Signal 4: colon-terminated short line.
    if line.endswith(":") and len(words) <= 6:
        return True
    # Signal 5: German technical heading keyword. Short line, no sentence
    # punctuation other than a trailing colon/period, contains a known
    # heading word.
    if len(words) <= 6 and not line.endswith((".", "?", "!")):
        tokens = {w.lower().rstrip(":") for w in _WORD_RE.findall(line)}
        # Also strip German compound suffix matches: "Schweißnaht-Berechnung"
        # → tokens already split on `-` by _WORD_RE.
        if tokens & _DE_HEADING_KEYWORDS:
            return True
    return False


def _format_heading(line: str) -> str:
    """Promote a heading line to an ATX heading at the right depth."""
    line = line.strip()
    m = _NUMBERED_HEADING.match(line)
    if m:
        depth = min(m.group(1).count(".") + 2, 6)  # "1" → ##, "1.2" → ###, capped at ######
        return "#" * depth + " " + line
    # Strip a single trailing `:` so headings render as `## Lösung`, not
    # `## Lösung:`. Trailing periods are kept — they're part of the heading
    # text (`Biegung und Torsion.`).
    if line.endswith(":"):
        line = line[:-1].rstrip()
    return "## " + line


# ── Math detection ───────────────────────────────────────────────────────────


def _looks_like_math(line: str) -> bool:
    """True when a line should be wrapped as a `$$ ... $$` display-math block.

    Multi-path classifier — any one of the following is sufficient:

    1. Operator ratio ≥ 18% (symbol-dense math: ``A = π · d²/4``).
    2. Operator ratio ≥ 12% AND line contains ``=`` (engineering assignment
       with units: ``τ_Schw = F / A``).
    3. Assignment pattern with a digit / Greek letter / math symbol on the
       RHS (``Setzbetrag fz,ges = 20 μm = 0.02 mm`` — only 9% operators but
       clearly a formula).
    4. Greek-led formula (``τ = F/A``) — starts with τ/σ/π/… and has ``=``
       within ~15 chars.

    The pre-existing 18%-ratio rule is the fallback; the other three paths
    are the Phase 2 additions to catch German engineering formulas the
    symbol-ratio classifier was missing.
    """
    s = line.strip()
    if len(s) < 2:
        return False

    has_eq = any(c in s for c in "=≈≃≤≥")
    # Quick reject: sentences without ANY equation operator are never math.
    if s.endswith((".", "?", "!")) and " " in s and not has_eq and not any(
        c in s for c in "∑∫∂√≠≡"
    ):
        return False

    math_chars = sum(1 for ch in s if ch in _MATH_CHARS)
    non_space = max(sum(1 for ch in s if not ch.isspace()), 1)
    ratio = math_chars / non_space

    # Path 1: original symbol-density rule.
    if ratio >= MATH_OPERATOR_RATIO:
        return True
    # Path 2: relaxed bar for assignment-like lines.
    if has_eq and ratio >= MATH_OPERATOR_RATIO_RELAXED:
        return True
    # Path 3: assignment pattern with a non-prose RHS.
    if (
        _ASSIGNMENT_LINE_RE.match(s)
        and _ASSIGNMENT_RHS_GATE_RE.search(s)
    ):
        return True
    # Path 4: line starting with a Greek variable followed by `=`.
    if _GREEK_LED_FORMULA_RE.match(s):
        return True
    return False
