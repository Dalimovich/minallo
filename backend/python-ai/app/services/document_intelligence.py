"""Phase 4 — document classification + extraction-quality rollup.

Two deterministic helpers, no LLM:

  * ``classify_document(file_name, sample_text)`` picks one of:
      exercise_sheet | solution_sheet | lecture | formula_sheet |
      summary | exam | unknown

    Order of evidence:
      1. filename hints (Aufgaben.pdf, Loesung.pdf, Formelsammlung.pdf, …)
      2. content hints (heading frequencies, formula density, exercise/
         solution markers)
      3. fallback to ``unknown`` so retrieval can degrade gracefully.

  * ``rollup_extraction_quality(page_qualities)`` reduces the per-page
    quality tags written by Phase 1 to a single document-level tag and
    an ``ocr_recommended`` flag for Phase 11 to consume.

Both are pure-Python, side-effect-free, and tested without Supabase.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable

# ── public types ────────────────────────────────────────────────────────────

DOCUMENT_TYPES = (
    "exercise_sheet",
    "solution_sheet",
    "lecture",
    "formula_sheet",
    "summary",
    "exam",
    "unknown",
)

EXTRACTION_QUALITIES = ("good", "weak", "failed")


@dataclass
class QualityRollup:
    quality: str            # "good" | "weak" | "failed"
    good_pages: int
    weak_pages: int
    failed_pages: int
    total_pages: int
    ocr_recommended: bool   # true when >= 30% of pages are weak/failed


# ── classification ──────────────────────────────────────────────────────────

# Filename → strong-signal mapping. Lowercased substring match.
_FILENAME_HINTS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("loesung", "lösung", "loesungen", "lösungen", "solution", "solutions",
      "musterlösung", "musterloesung"),                                   "solution_sheet"),
    (("aufgaben", "aufgabe", "übung", "uebung", "übungen", "uebungen",
      "exercise", "exercises", "problem-set", "problemset", "task-sheet"), "exercise_sheet"),
    (("formelsammlung", "formel-sammlung", "formelzettel", "formula-sheet",
      "formula_sheet", "cheatsheet", "cheat-sheet"),                       "formula_sheet"),
    (("klausur", "exam", "prüfung", "pruefung", "midterm", "final"),       "exam"),
    (("zusammenfassung", "summary", "skript-zusammenfassung",
      "spickzettel"),                                                      "summary"),
    (("skript", "lecture", "vorlesung", "slides", "folien", "kapitel",
      "chapter"),                                                          "lecture"),
)

# Content-side signals — used only when filename is ambiguous.
_EXERCISE_RE = re.compile(
    r"\b(?:aufgabe|übung|uebung|exercise|problem|task)\s+\d+",
    re.IGNORECASE,
)
_SOLUTION_RE = re.compile(
    r"\b(?:lösung|loesung|musterlösung|musterloesung|solution|answer key)\b",
    re.IGNORECASE,
)
_FORMULA_DENSITY_RE = re.compile(r"[=≈∑∫∂√π]|\$\$|\\frac|\\sum|\\int")
_EXAM_RE = re.compile(
    r"\b(?:klausur|exam|prüfung|pruefung|midterm|final|exam date|points?:?\s*\d+)\b",
    re.IGNORECASE,
)
_SUMMARY_RE = re.compile(
    r"\b(?:zusammenfassung|summary|recap|key takeaways|key points)\b",
    re.IGNORECASE,
)
_LECTURE_HEADING_RE = re.compile(
    r"\b(?:vorlesung|lecture|chapter|kapitel|section)\s+\d+",
    re.IGNORECASE,
)


def _filename_class(file_name: str) -> str | None:
    if not file_name:
        return None
    lower = file_name.lower()
    for needles, doc_type in _FILENAME_HINTS:
        if any(n in lower for n in needles):
            return doc_type
    return None


def _content_class(sample_text: str) -> str:
    """Pick a class from a representative text sample."""
    if not sample_text or not sample_text.strip():
        return "unknown"

    text = sample_text
    chars = max(len(text), 1)

    exercise_hits = len(_EXERCISE_RE.findall(text))
    solution_hits = len(_SOLUTION_RE.findall(text))
    formula_density = len(_FORMULA_DENSITY_RE.findall(text)) / chars * 1000  # per 1k chars
    exam_hits = len(_EXAM_RE.findall(text))
    summary_hits = len(_SUMMARY_RE.findall(text))
    lecture_hits = len(_LECTURE_HEADING_RE.findall(text))

    # A solution sheet must mention both exercises and solutions repeatedly.
    if solution_hits >= 2 and exercise_hits >= 2:
        return "solution_sheet"

    # Many exercise markers, few/no solution markers → exercise sheet.
    if exercise_hits >= 3 and solution_hits <= 1:
        return "exercise_sheet"

    if exam_hits >= 2:
        return "exam"

    # Formula sheets are dense with math and short on prose. Tune the
    # threshold against the eval fixture if it misfires.
    if formula_density >= 6.0 and exercise_hits == 0 and lecture_hits == 0:
        return "formula_sheet"

    # Summary takes precedence over lecture even when a chapter heading
    # is present — "Zusammenfassung Kapitel 5" is still a summary doc.
    if summary_hits >= 2:
        return "summary"

    if lecture_hits >= 1 or chars > 4000:
        return "lecture"

    return "unknown"


def classify_document(file_name: str | None, sample_text: str | None) -> str:
    """Best-effort class for a single document.

    Filename signals win when present (the upstream uploader names files
    deliberately). Content signals only run when the filename is ambiguous.
    """
    if (cls := _filename_class(file_name or "")) is not None:
        return cls
    return _content_class(sample_text or "")


# ── extraction-quality rollup ───────────────────────────────────────────────


def rollup_extraction_quality(page_qualities: Iterable[str | None]) -> QualityRollup:
    """Reduce per-page quality tags to a single document-level tag.

    Rules:
      * 0 pages or every page failed → "failed", ocr_recommended=True
      * any page failed OR weak share >= 50% → "weak", ocr_recommended=True
      * weak share >= 30% (but < 50%) → "weak", ocr_recommended=True
      * everything else → "good", ocr_recommended=False
    """
    counts: Counter[str] = Counter()
    total = 0
    for q in page_qualities:
        if q is None:
            continue
        if q in EXTRACTION_QUALITIES:
            counts[q] += 1
        total += 1

    good = counts.get("good", 0)
    weak = counts.get("weak", 0)
    failed = counts.get("failed", 0)

    if total == 0 or failed == total:
        return QualityRollup("failed", good, weak, failed, total, True)

    bad_share = (weak + failed) / total
    if failed >= 1 or bad_share >= 0.50:
        return QualityRollup("weak", good, weak, failed, total, True)
    if bad_share >= 0.30:
        return QualityRollup("weak", good, weak, failed, total, True)

    return QualityRollup("good", good, weak, failed, total, False)


# ── Phase 11 — OCR measurement ──────────────────────────────────────────────


@dataclass
class OcrAssessment:
    """Per-document signal of whether OCR/vision fallback would help.

    Computed at indexing time from the raw extracted text. The fields are
    chosen so the frontend can render a single sentence ("3 of 12 pages
    are likely scanned — re-index with OCR?") without further math.
    """

    total_pages: int
    pages_with_text: int           # pages with >= MIN_GOOD_CHARS of letters
    pages_almost_no_text: int      # pages with < 40 chars of letters
    pages_likely_scanned: int      # pages with no letters at all
    pages_image_heavy: int         # pages with < 80 letters but some chars (mixed content)
    avg_chars_per_page: float
    formula_count_estimate: int    # detected $$...$$ blocks in the raw text overall
    ocr_recommended: bool

    def to_json(self) -> dict[str, object]:
        return {
            "totalPages":           self.total_pages,
            "pagesWithText":        self.pages_with_text,
            "pagesAlmostNoText":    self.pages_almost_no_text,
            "pagesLikelyScanned":   self.pages_likely_scanned,
            "pagesImageHeavy":      self.pages_image_heavy,
            "avgCharsPerPage":      round(self.avg_chars_per_page, 1),
            "formulaCountEstimate": self.formula_count_estimate,
            "ocrRecommended":       self.ocr_recommended,
        }


# Reuse the markdown_indexing tunables for "what counts as text"; same
# definitions everywhere keeps the heuristics consistent.
_LETTER_RE = re.compile(r"[A-Za-zÄÖÜäöüß]")
_FORMULA_BLOCK_RE = re.compile(r"\$\$.+?\$\$", re.DOTALL)


def measure_ocr_need(pages: list[str]) -> OcrAssessment:
    """Examine the raw extracted text of every page and decide whether
    OCR / vision fallback would meaningfully improve coverage.

    Thresholds (kept conservative — false positives are cheap, false
    negatives mean students get bad answers):

      * page with ZERO letters → "likely scanned"
      * page with < 40 letters → "almost no text"
      * page with < 80 letters but some characters → "image heavy"
      * ocrRecommended ↔ (scanned + image_heavy) / total >= 0.30
                      OR any page with > 200 chars but < 30 letters
    """
    total = len(pages)
    if total == 0:
        return OcrAssessment(0, 0, 0, 0, 0, 0.0, 0, True)

    pages_with_text = 0
    pages_almost_no_text = 0
    pages_likely_scanned = 0
    pages_image_heavy = 0
    total_chars = 0
    formula_count = 0
    has_high_char_low_letter_page = False

    for text in pages:
        text = text or ""
        chars = len(text)
        total_chars += chars
        letters = len(_LETTER_RE.findall(text))
        formula_count += len(_FORMULA_BLOCK_RE.findall(text))

        if letters == 0:
            pages_likely_scanned += 1
        elif letters < 40:
            pages_almost_no_text += 1
        elif letters < 80:
            pages_image_heavy += 1
        else:
            pages_with_text += 1

        # A page that has lots of characters but very few letters typically
        # means OCR garbage or layout-only output — strong OCR signal.
        if chars > 200 and letters < 30:
            has_high_char_low_letter_page = True

    # "almost_no_text" is also strong OCR signal — those pages have ink we
    # know about but couldn't pull readable letters from.
    bad_pages = pages_likely_scanned + pages_image_heavy + pages_almost_no_text
    bad_share = bad_pages / total
    ocr_recommended = bad_share >= 0.30 or has_high_char_low_letter_page

    return OcrAssessment(
        total_pages=total,
        pages_with_text=pages_with_text,
        pages_almost_no_text=pages_almost_no_text,
        pages_likely_scanned=pages_likely_scanned,
        pages_image_heavy=pages_image_heavy,
        avg_chars_per_page=total_chars / total if total else 0.0,
        formula_count_estimate=formula_count,
        ocr_recommended=ocr_recommended,
    )


__all__ = (
    "DOCUMENT_TYPES",
    "EXTRACTION_QUALITIES",
    "OcrAssessment",
    "QualityRollup",
    "classify_document",
    "measure_ocr_need",
    "rollup_extraction_quality",
)
