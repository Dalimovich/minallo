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
from dataclasses import dataclass, field
from typing import Iterable

# ── public types ────────────────────────────────────────────────────────────

DOCUMENT_TYPES = (
    "exam",
    "lecture",
    "exercise_sheet",
    "solution_sheet",
    "summary",
    "slides",
    "textbook_chapter",
    "assignment",
    "cheat_sheet",
    "formula_sheet",
    "unknown",
)

# Types treated as compressed reference material (same downstream behaviour).
# cheat_sheet is a distinct vocabulary entry but behaves like formula_sheet so
# the existing formula_sheet retrieval/prompt handling stays backward-compatible.
REFERENCE_TYPES = ("cheat_sheet", "formula_sheet", "summary")

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

# Filename → strong-signal mapping. Lowercased substring match. ORDER MATTERS —
# more specific signals must come before broader ones (e.g. "folien" → slides
# before "vorlesung" → lecture; "musterlösung" → solution before "aufgabe").
_FILENAME_HINTS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("loesung", "lösung", "loesungen", "lösungen", "solution", "solutions",
      "musterlösung", "musterloesung", "answer-key", "answerkey"),         "solution_sheet"),
    (("klausur", "prüfung", "pruefung", "midterm", "final-exam", "exam",
      "probeklausur", "altklausur"),                                       "exam"),
    (("hausaufgabe", "hausübung", "hausuebung", "homework", "assignment",
      "abgabe", "hand-in", "handin", "problem-set", "problemset"),         "assignment"),
    (("aufgaben", "aufgabe", "übung", "uebung", "übungen", "uebungen",
      "exercise", "exercises", "task-sheet", "tutorial"),                  "exercise_sheet"),
    (("cheatsheet", "cheat-sheet", "cheat_sheet", "spickzettel"),          "cheat_sheet"),
    (("formelsammlung", "formel-sammlung", "formelzettel", "formula-sheet",
      "formula_sheet", "formelblatt"),                                     "formula_sheet"),
    (("zusammenfassung", "summary", "skript-zusammenfassung", "recap",
      "uebersicht", "übersicht"),                                          "summary"),
    (("folien", "slides", "präsentation", "praesentation", "presentation",
      "slideshow", ".pptx", ".ppt"),                                       "slides"),
    (("lehrbuch", "textbook", "buchkapitel", "book-chapter", "ebook",
      "e-book"),                                                           "textbook_chapter"),
    (("skript", "lecture", "vorlesung", "kapitel", "chapter"),             "lecture"),
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
# Exam-specific administrative markers that almost never appear outside a real
# exam: time budget, reachable points, sub-tasks, formal candidate fields.
_EXAM_STRONG_RE = re.compile(
    r"\b(?:bearbeitungszeit|erreichbare\s+punkte|teilaufgabe|matrikelnummer|"
    r"klausurnummer|hilfsmittel|zugelassene\s+hilfsmittel|punkte\s*[:/]|"
    r"viel\s+erfolg|bewertung|max\.?\s*punkte|/\s*\d+\s*punkte|"
    r"working\s+time|allowed\s+aids|total\s+points|marks?\s*[:/]\s*\d+)\b",
    re.IGNORECASE,
)
# Numbered tasks like "Aufgabe 1", "Task 3", "Problem 2", "1. (5 Punkte)".
_NUMBERED_TASK_RE = re.compile(
    r"(?:\b(?:aufgabe|task|problem|exercise|frage|question)\s+\d+\b"
    r"|^\s*\d+\.\s*\(\s*\d+\s*(?:punkte|points|p\.?)\))",
    re.IGNORECASE | re.MULTILINE,
)
_SUMMARY_RE = re.compile(
    r"\b(?:zusammenfassung|summary|recap|key takeaways|key points)\b",
    re.IGNORECASE,
)
_LECTURE_HEADING_RE = re.compile(
    r"\b(?:vorlesung|lecture|chapter|kapitel|section)\s+\d+",
    re.IGNORECASE,
)
# Content-flag signals (independent of the single document_type).
_THEORY_RE = re.compile(
    r"\b(?:definition|satz|theorem|lemma|beweis|proof|herleitung|"
    r"grundlagen|einführung|introduction|concept|konzept|eigenschaft)\b",
    re.IGNORECASE,
)
_EXAMPLE_RE = re.compile(
    r"\b(?:beispiel|example|z\.\s?b\.|e\.\s?g\.|zum beispiel|for instance|"
    r"musterbeispiel|worked example)\b",
    re.IGNORECASE,
)


# Abbreviated exercise marker in a filename: "Ex2", "Ex_10", "Ex 3", "ExN"
# as used by the EngMec2 series ("EngMec2_Ex2.pdf"). Requires a separator (or
# start) before "ex" so it can't fire inside words like "index2" / "annex 3"
# / "complex_4". Checked only as a FALLBACK, after the explicit word hints, so
# a "…Solutions.pdf" still classifies as solution_sheet.
_EX_FILENAME_RE = re.compile(r"(?:^|[_\s\-])ex[._\s]*\d")


def _filename_class(file_name: str) -> str | None:
    if not file_name:
        return None
    lower = file_name.lower()
    for needles, doc_type in _FILENAME_HINTS:
        if any(n in lower for n in needles):
            return doc_type
    if _EX_FILENAME_RE.search(lower):
        return "exercise_sheet"
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
    exam_strong_hits = len(_EXAM_STRONG_RE.findall(text))
    numbered_tasks = len(_NUMBERED_TASK_RE.findall(text))
    theory_hits = len(_THEORY_RE.findall(text))
    summary_hits = len(_SUMMARY_RE.findall(text))
    lecture_hits = len(_LECTURE_HEADING_RE.findall(text))

    # Exam first: a strong admin marker (Bearbeitungszeit / erreichbare Punkte /
    # Teilaufgabe) is near-decisive. Note: many numbered tasks ALONE is NOT exam
    # evidence — exercise sheets look identical; only the exam admin markers (or
    # explicit exam words) separate them.
    if exam_strong_hits >= 1 or exam_hits >= 2:
        return "exam"
    if numbered_tasks >= 3 and exam_strong_hits >= 1:
        return "exam"

    # A solution sheet must mention both exercises and solutions repeatedly.
    if solution_hits >= 2 and exercise_hits >= 2:
        return "solution_sheet"

    # Many exercise markers, few/no solution markers → exercise sheet.
    if exercise_hits >= 3 and solution_hits <= 1:
        return "exercise_sheet"

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


@dataclass
class ClassificationResult:
    """Document classification with a confidence score + the signals that
    fired. Lets downstream code (retrieval scoring) weight the result by
    confidence instead of treating every classification as equally trustworthy.
    """
    document_type: str
    confidence: float                # 0.0 (no signal) to 1.0 (both signals agree)
    signals: list[str] = field(default_factory=list)


def classify_document_with_confidence(
    file_name: str | None,
    sample_text: str | None,
) -> ClassificationResult:
    """Cross-check filename and content classifiers.

    Review fix #12 — the old logic trusted the filename unconditionally
    when it matched any hint. That misclassified misleading names
    (``Lösung.pdf`` that actually contains only exercises) as
    ``solution_sheet``, and gave the same confidence as an unambiguous
    case where filename + content agreed.

    Returns a structured result with confidence so the caller can decide
    whether to apply doc-type-based boosts at all (low-confidence
    classifications should NOT influence retrieval ranking).
    """
    file_name = file_name or ""
    sample_text = sample_text or ""

    filename_class = _filename_class(file_name)
    content_class: str | None = None
    if sample_text.strip():
        cc = _content_class(sample_text)
        content_class = cc if cc != "unknown" else None

    signals: list[str] = []
    if filename_class:
        signals.append(f"filename:{filename_class}")
    if content_class:
        signals.append(f"content:{content_class}")

    # Case A: both agree → highest confidence.
    if filename_class and content_class and filename_class == content_class:
        return ClassificationResult(filename_class, 0.95, signals)
    # Case B: only the content classifier fires (filename is silent /
    # generic like "scan.pdf"). Trust the content read.
    if not filename_class and content_class:
        return ClassificationResult(content_class, 0.75, signals)
    # Case C: only the filename matches (content empty or below the
    # classifier's threshold). Filename gets benefit of doubt but at
    # noticeably lower confidence so a misleading filename can be
    # filtered out downstream.
    if filename_class and not content_class:
        return ClassificationResult(filename_class, 0.55, signals)
    # Case D: they disagree. The PDF body is the ground truth — the
    # filename was probably mis-labeled by the student.
    if filename_class and content_class and filename_class != content_class:
        return ClassificationResult(
            content_class, 0.50, [*signals, "disagreement"]
        )
    # Case E: neither classifier produced a hit.
    return ClassificationResult("unknown", 0.0, [])


def classify_document(file_name: str | None, sample_text: str | None) -> str:
    """Backward-compatible single-string classifier. Delegates to the
    confidence-aware variant. Callers that need to know how trustworthy
    the result is should use ``classify_document_with_confidence`` instead.
    """
    return classify_document_with_confidence(file_name, sample_text).document_type


# ── document understanding (Stage 1: classifier → full payload) ──────────────
#
# A document's understanding is more than one type label: every AI feature needs
# to know what the file *contains* (tasks vs theory vs solutions), its language,
# and its subject/topic before prompting. These are computed deterministically
# (no LLM) and persisted so features read them instead of re-deriving each time.

# Below this, doc-type-based behaviour/retrieval boosts should NOT be trusted
# unless the user explicitly confirmed/overrode the type.
LOW_CONFIDENCE_THRESHOLD = 0.65


@dataclass
class ContentFlags:
    """What the document *contains*, independent of its single type label — so an
    exam can be has_tasks=True / has_theory=False / has_solutions=False."""

    has_tasks: bool
    has_theory: bool
    has_solutions: bool
    has_examples: bool
    is_mixed: bool

    def to_json(self) -> dict[str, bool]:
        return {
            "has_tasks":     self.has_tasks,
            "has_theory":    self.has_theory,
            "has_solutions": self.has_solutions,
            "has_examples":  self.has_examples,
            "is_mixed":      self.is_mixed,
        }


def detect_content_flags(sample_text: str | None) -> ContentFlags:
    text = sample_text or ""
    if not text.strip():
        return ContentFlags(False, False, False, False, False)
    has_tasks = (
        len(_NUMBERED_TASK_RE.findall(text)) >= 1
        or len(_EXERCISE_RE.findall(text)) >= 1
    )
    has_solutions = len(_SOLUTION_RE.findall(text)) >= 1
    has_theory = (
        len(_THEORY_RE.findall(text)) >= 2
        or len(_LECTURE_HEADING_RE.findall(text)) >= 1
    )
    has_examples = len(_EXAMPLE_RE.findall(text)) >= 1
    is_mixed = has_tasks and has_theory
    return ContentFlags(has_tasks, has_theory, has_solutions, has_examples, is_mixed)


# Deterministic de/en detection — umlauts + stopword frequency + filename hints.
_DE_STOPWORDS = frozenset({
    "der", "die", "das", "und", "mit", "für", "ist", "eine", "einen", "nicht",
    "werden", "auf", "von", "den", "dem", "des", "zu", "sich", "auch", "wird",
    "sind", "aufgabe", "lösung", "über", "durch", "bei", "oder", "als", "aus",
})
_EN_STOPWORDS = frozenset({
    "the", "and", "of", "is", "for", "with", "not", "are", "this", "that",
    "from", "which", "exercise", "solution", "question", "answer", "you",
    "there", "their", "these", "where", "when", "while", "because", "therefore",
})
_WORD_TOKEN_RE = re.compile(r"[A-Za-zÄÖÜäöüß]+")


def detect_language(
    file_name: str | None,
    sample_text: str | None,
    fallback: str | None = None,
) -> str:
    """Return 'de' | 'en' | the caller fallback | 'unknown'."""
    text = sample_text or ""
    name = (file_name or "").lower()
    de = 2 * len(re.findall(r"[äöüß]", text, re.IGNORECASE))  # umlauts: strong DE
    en = 0
    for w in (t.lower() for t in _WORD_TOKEN_RE.findall(text)[:4000]):
        if w in _DE_STOPWORDS:
            de += 1
        elif w in _EN_STOPWORDS:
            en += 1
    if any(h in name for h in ("loesung", "lösung", "klausur", "übung", "uebung",
                               "vorlesung", "zusammenfassung", "prüfung")):
        de += 3
    if any(h in name for h in ("solution", "exercise", "lecture", "summary", "exam")):
        en += 3
    if de == 0 and en == 0:
        return fallback or "unknown"
    if abs(de - en) <= 1:  # too close to call → trust the stored language if any
        return fallback or ("de" if de >= en else "en")
    return "de" if de > en else "en"


# Words to strip from a filename before using the remainder as a subject guess.
_FILENAME_NOISE_RE = re.compile(
    r"\b(?:pdf|docx?|pptx?|loesung|lösung|aufgaben?|übung|uebung|klausur|exam|"
    r"prüfung|pruefung|skript|vorlesung|folien|slides|zusammenfassung|summary|"
    r"formelsammlung|cheatsheet|chapter|kapitel|final|midterm|teil|blatt|sheet|"
    r"ws\d*|ss\d*|sose\d*|wise\d*)\b",
    re.IGNORECASE,
)


def extract_subject_name(file_name: str | None, sample_text: str | None) -> str | None:
    """Best-effort subject from the filename stem (type/term noise stripped),
    falling back to the first substantive heading. May return None — deliberately
    conservative; a wrong subject is worse than no subject."""
    stem = re.sub(r"\.[a-z0-9]+$", "", file_name or "", flags=re.IGNORECASE)
    stem = re.sub(r"[_\-]+", " ", stem)
    stem = _FILENAME_NOISE_RE.sub(" ", stem)
    stem = re.sub(r"\b\d{1,4}\b", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip()
    if len(stem) >= 4 and re.search(r"[A-Za-zÄÖÜäöüß]{4,}", stem):
        return stem[:80]
    for raw in (sample_text or "").splitlines():
        s = raw.strip().lstrip("#").strip()
        if 4 <= len(s) <= 80 and re.search(r"[A-Za-zÄÖÜäöüß]{4,}", s):
            return s
    return None


def match_topic_area(
    sample_text: str | None,
    course_topics: Iterable[str] | None,
) -> str | None:
    """Pick the course topic whose name appears most in the text (>=2 mentions)."""
    if not course_topics:
        return None
    text = (sample_text or "").lower()
    if not text:
        return None
    best: str | None = None
    best_score = 0
    for topic in course_topics:
        if not topic:
            continue
        score = text.count(topic.lower())
        if score > best_score:
            best, best_score = topic, score
    return best if best_score >= 2 else None


@dataclass
class DocumentUnderstanding:
    document_type: str
    document_type_confidence: float
    document_type_signals: list[str]
    detected_language: str
    subject_name: str | None
    topic_area: str | None
    content_flags: ContentFlags

    def to_json(self) -> dict[str, object]:
        return {
            "document_type":            self.document_type,
            "document_type_confidence": round(self.document_type_confidence, 3),
            "document_type_signals":    list(self.document_type_signals),
            "detected_language":        self.detected_language,
            "subject_name":             self.subject_name,
            "topic_area":               self.topic_area,
            "content_flags":            self.content_flags.to_json(),
        }


def analyze_document(
    file_name: str | None,
    sample_text: str | None,
    *,
    fallback_language: str | None = None,
    course_topics: Iterable[str] | None = None,
) -> DocumentUnderstanding:
    """Compose the deterministic understanding payload for one document. No LLM,
    no I/O — safe to call inline during indexing or on a backfill pass."""
    cls = classify_document_with_confidence(file_name, sample_text)
    return DocumentUnderstanding(
        document_type=cls.document_type,
        document_type_confidence=cls.confidence,
        document_type_signals=cls.signals,
        detected_language=detect_language(file_name, sample_text, fallback_language),
        subject_name=extract_subject_name(file_name, sample_text),
        topic_area=match_topic_area(sample_text, course_topics),
        content_flags=detect_content_flags(sample_text),
    )


def effective_document_type(
    classifier_type: str | None,
    user_override: str | None,
    source_type: str | None = None,
) -> str:
    """Authoritative type for downstream AI behaviour:
    user override → classifier → legacy source_type → 'unknown'."""
    if user_override:
        return user_override
    if classifier_type and classifier_type != "unknown":
        return classifier_type
    if source_type:
        return source_type
    return "unknown"


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


# ── pdfminer-vs-OCR scoring ─────────────────────────────────────────────────
#
# A page only reaches OCR because the detector judged pdfminer's text bad
# (empty or structurally garbled). But OCR can fail too — blur, handwriting,
# a hallucinated table. So instead of blindly overwriting, we score both
# versions and keep the stronger one.

_HEADING_RE = re.compile(r"(?m)^\s{0,3}#{1,6}\s")
_MATH_BLOCK_RE = re.compile(r"\$\$.+?\$\$", re.DOTALL)
_LATEX_STRUCT_RE = re.compile(r"\\frac|\\sqrt|\\sum|\\int|\\begin\{")
_UNCLEAR_RE = re.compile(r"\[unclear\]", re.IGNORECASE)
_READABLE_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß]{4,}")


def score_extraction(text: str) -> float:
    """Heuristic quality score for one page of extracted text — higher is
    better. Rewards parseable structure; penalises honest-OCR gaps.

      + readable words   — tokens of >= 4 letters (real words, not formula soup)
      + display formulas — clean ``$$ ... $$`` blocks
      + latex structure  — ``\\frac`` / ``\\sqrt`` / ``\\sum`` / ``\\begin{}``
      + headings         — Markdown ATX headings (structure survived)
      - [unclear] markers— regions the model could not read
    """
    if not text or not text.strip():
        return 0.0
    readable_words = len(_READABLE_WORD_RE.findall(text))
    formula_blocks = len(_MATH_BLOCK_RE.findall(text))
    latex = len(_LATEX_STRUCT_RE.findall(text))
    headings = len(_HEADING_RE.findall(text))
    unclear = len(_UNCLEAR_RE.findall(text))
    return (
        readable_words
        + 4.0 * formula_blocks
        + 2.0 * latex
        + 3.0 * headings
        - 5.0 * unclear
    )


def prefer_ocr_text(original: str, ocr: str) -> bool:
    """Decide whether the OCR result should replace the pdfminer ``original``.

    The bar is low because the page was already flagged as bad pdfminer
    output: take the OCR text unless it scores strictly worse than what we
    had. An empty original always loses; an OCR result that came back mostly
    ``[unclear]`` can lose to a partially-readable original.
    """
    if not ocr or not ocr.strip():
        return False
    return score_extraction(ocr) >= score_extraction(original)


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
    "REFERENCE_TYPES",
    "EXTRACTION_QUALITIES",
    "LOW_CONFIDENCE_THRESHOLD",
    "ContentFlags",
    "DocumentUnderstanding",
    "OcrAssessment",
    "QualityRollup",
    "analyze_document",
    "classify_document",
    "classify_document_with_confidence",
    "detect_content_flags",
    "detect_language",
    "effective_document_type",
    "extract_subject_name",
    "match_topic_area",
    "measure_ocr_need",
    "rollup_extraction_quality",
)
