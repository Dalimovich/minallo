"""Course-wide authentic-exam discovery and structural style extraction.

This is deliberately separate from semantic RAG: similarity search is useful for
content, but it cannot reliably preserve page order, section weights, or question
formats.  The helpers here read the course inventory and ordered page text.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_SIMILAR_REQUEST_RE = re.compile(
    r"\b(?:like|similar|same (?:type|style|structure|layout)|another version|parallel form|"
    r"different (?:questions|values|numbers)|wie|ähnlich\w*|aehnlich\w*|gleiche[rsn]? (?:art|stil|aufbau)|"
    r"andere (?:fragen|werte|zahlen))\b",
    re.IGNORECASE,
)
_EXAM_NAME_RE = re.compile(
    r"klausur|altklausur|probeklausur|prüfung|pruefung|exam|midterm|final|"
    r"prüfungsbogen|pruefungsbogen|variante\s*[a-z]",
    re.IGNORECASE,
)
_EXAM_BODY_RE = re.compile(
    r"(?:bearbeitungszeit|allowed (?:aids|tools)|gesamtpunkte|total points|"
    r"\baufgabe\s*\d+|\bquestion\s*\d+|kurzfragen|rechen(?:teil|aufgabe)|"
    r"\d+\s*(?:punkte|points)\b)",
    re.IGNORECASE,
)
_MC_RE = re.compile(
    r"multiple.?choice|single.?choice|kreuzen sie|welche aussage|"
    r"(?:☐|□|\[[ x]?\])|\b[a-e]\)\s+[^\n]{2,}",
    re.IGNORECASE,
)
_CALC_RE = re.compile(
    r"berechnen sie|bestimmen sie|ermitteln sie|calculate|compute|determine|"
    r"\bgegeben\s*:|\bgesucht\s*:",
    re.IGNORECASE,
)
_OPEN_RE = re.compile(
    r"erläutern sie|erlaeutern sie|erklären sie|erklaeren sie|begründen sie|"
    r"describe|explain|justify|nennen sie",
    re.IGNORECASE,
)
_POINT_RE = re.compile(r"(?<!\d)(\d{1,3})\s*(?:P(?:unkte|kt)?|points?)\b", re.IGNORECASE)
_TOTAL_RE = re.compile(
    r"(?:gesamt(?:punktzahl|punkte)?|total(?:\s+points)?)\s*[:=]?\s*(\d{2,3})|"
    r"(\d{2,3})\s*(?:punkte|points)\s*(?:gesamt|total)",
    re.IGNORECASE,
)
_DURATION_RE = re.compile(
    r"(?:bearbeitungszeit|dauer|duration|time)\s*[:=]?\s*(\d{2,3})\s*(?:min|minutes?)",
    re.IGNORECASE,
)
_SECTION_RE = re.compile(
    r"(?im)^(?:#{1,4}\s*)?(?:teil|part|section)\s*([A-Z0-9]+)?\s*[:.\-–—]?\s*([^\n]{2,80})"
)
_SHORT_POINTS_RE = re.compile(
    r"(?:kurzfragen?(?:teil)?|short questions?)\D{0,40}(\d{1,3})\s*(?:P(?:unkte)?|points?)",
    re.IGNORECASE,
)
_CALC_POINTS_RE = re.compile(
    r"(?:rechen(?:teil|aufgaben?)|calculations?)\D{0,40}(\d{1,3})\s*(?:P(?:unkte)?|points?)",
    re.IGNORECASE,
)


@dataclass
class ExamReference:
    document_id: str
    title: str
    text: str
    score: int
    page_count: int | None = None
    total_points: int | None = None
    duration_minutes: int | None = None
    sections: list[str] = field(default_factory=list)
    multiple_choice_count: int = 0
    calculation_count: int = 0
    open_response_count: int = 0
    short_question_points: int | None = None
    calculation_points: int | None = None


def is_similar_exam_request(question: str) -> bool:
    return bool(_SIMILAR_REQUEST_RE.search(question or ""))


def _first_int(match: re.Match[str] | None) -> int | None:
    if not match:
        return None
    for value in match.groups():
        if value:
            return int(value)
    return None


def analyse_exam_text(document_id: str, title: str, text: str, *, score: int = 0,
                      page_count: int | None = None) -> ExamReference:
    sections = []
    for match in _SECTION_RE.finditer(text):
        label = " ".join(part for part in match.groups() if part).strip(" :-–—")
        if label and label.casefold() not in {s.casefold() for s in sections}:
            sections.append(label)
    return ExamReference(
        document_id=document_id,
        title=title,
        text=text,
        score=score,
        page_count=page_count,
        total_points=_first_int(_TOTAL_RE.search(text)),
        duration_minutes=_first_int(_DURATION_RE.search(text)),
        sections=sections[:12],
        multiple_choice_count=len(_MC_RE.findall(text)),
        calculation_count=len(_CALC_RE.findall(text)),
        open_response_count=len(_OPEN_RE.findall(text)),
        short_question_points=_first_int(_SHORT_POINTS_RE.search(text)),
        calculation_points=_first_int(_CALC_POINTS_RE.search(text)),
    )


def discover_course_exams(*, user_id: str, course_id: str,
                          active_document_id: str | None = None) -> list[ExamReference]:
    """Search every course document, then read ordered pages for candidates.

    Filename/source-type candidates are loaded first. Ambiguous files are also
    classified from their opening pages, so a scanned/imported ``document.pdf``
    can still be recognized when OCR text exists.
    """
    try:
        sb = get_supabase()
        rows = ((sb.table("documents")
                 .select("id,file_name,source_type,document_type,page_count,processing_status")
                 .eq("user_id", user_id).eq("course_id", course_id).execute()).data or [])
        if not rows:
            return []
        ids = [row["id"] for row in rows]
        opening = ((sb.table("document_pages").select("document_id,page_number,cleaned_text,raw_text")
                    .in_("document_id", ids).lte("page_number", 3)
                    .order("page_number").execute()).data or [])
        opening_by_id: dict[str, list[str]] = {}
        for page in opening:
            opening_by_id.setdefault(page["document_id"], []).append(
                page.get("cleaned_text") or page.get("raw_text") or ""
            )
        candidates: list[tuple[dict, int]] = []
        for row in rows:
            intro = "\n".join(opening_by_id.get(row["id"], []))
            score = 0
            if row["id"] == active_document_id:
                score += 100
            if (row.get("source_type") == "exam" or row.get("document_type") == "exam"):
                score += 40
            if _EXAM_NAME_RE.search(row.get("file_name") or ""):
                score += 30
            if len(_EXAM_BODY_RE.findall(intro)) >= 3:
                score += 25
            if score >= 25:
                candidates.append((row, score))
        if not candidates:
            return []
        candidate_ids = [row["id"] for row, _ in candidates]
        pages = ((sb.table("document_pages").select("document_id,page_number,cleaned_text,raw_text")
                  .in_("document_id", candidate_ids).order("page_number").execute()).data or [])
        full: dict[str, list[str]] = {}
        for page in pages:
            full.setdefault(page["document_id"], []).append(
                page.get("cleaned_text") or page.get("raw_text") or ""
            )
        refs = [analyse_exam_text(
            row["id"], row.get("file_name") or "Untitled exam",
            "\n\f\n".join(full.get(row["id"], opening_by_id.get(row["id"], []))),
            score=score, page_count=row.get("page_count"),
        ) for row, score in candidates]
        return sorted(refs, key=lambda ref: (-ref.score, ref.title.casefold()))
    except Exception:  # additive feature; generation must remain available
        log.exception("course exam discovery failed")
        return []


def build_exam_reference_overlay(references: list[ExamReference]) -> str:
    if not references:
        return (
            "\n\nAUTHENTIC EXAM REFERENCE: No authentic exam was found in the complete active "
            "course inventory. State this clearly before the draft, label style confidence LOW, "
            "and describe the result as a best-effort practice exam based on course content. "
            "Never attribute it to the professor.\n"
        )
    primary = references[0]
    if primary.short_question_points and primary.calculation_points:
        counts = {
            "short-question (preserve the reference's MC/open formats)": primary.short_question_points,
            "calculation": primary.calculation_points,
        }
    else:
        counts = {
            "multiple-choice": primary.multiple_choice_count,
            "calculation": primary.calculation_count,
            "open-response": primary.open_response_count,
        }
    total = sum(counts.values()) or 1
    distribution = ", ".join(
        f"{name} about {round(value * 100 / total)}%" for name, value in counts.items() if value
    ) or "infer question formats directly from the reference"
    metadata = []
    if primary.total_points:
        metadata.append(f"total points: {primary.total_points}")
    if primary.duration_minutes:
        metadata.append(f"duration: {primary.duration_minutes} minutes")
    if primary.page_count:
        metadata.append(f"length: {primary.page_count} pages")
    section_text = " -> ".join(primary.sections) if primary.sections else "preserve detected page order"
    additional = ", ".join(ref.title for ref in references[1:4]) or "none"
    return f"""

AUTHENTIC PARALLEL-EXAM CONTRACT (overrides generic 70/30 or other default mixes):
- Primary style reference: {primary.title}
- Additional authentic course references: {additional}
- Detected metadata: {', '.join(metadata) or 'use the reference values; do not invent institution metadata'}
- Detected section order: {section_text}
- Detected question-format distribution: {distribution}
- Match the primary reference's section count/order, points, option counts, calculation depth,
  terminology, diagram/table frequency, and response-space expectations. Do not turn its
  multiple-choice questions into open questions. A generic three-problem exam is forbidden.
- Generate an academically original parallel form: new scenarios, values, diagrams, distractors,
  ordering and wording. Do not copy or merely renumber a source question.
- Validate every calculation and every option internally. A capacity/equipment choice is valid
  only when capacity >= requirement (including any stated safety factor). If no equipment table
  exists, include a self-contained new table or say selection cannot be made; never invent fitness.
- Start with a compact card headed `Exam style detected`, naming the primary/additional references,
  the detected structure, and `Style confidence: High`. Say that questions are newly generated.
- Keep the student exam and solutions clearly separated. Put the blank exam first, then place the
  complete solution version in a collapsed `<details><summary>Open solutions</summary>...</details>`
  block so answers are not visible during practice.
"""


def resolve_exam_reference_overlay(*, question: str, user_id: str | None,
                                   course_id: str | None,
                                   active_document_id: str | None = None) -> tuple[str, list[ExamReference]]:
    if not (is_similar_exam_request(question) and user_id and course_id):
        return "", []
    refs = discover_course_exams(
        user_id=user_id, course_id=course_id, active_document_id=active_document_id,
    )
    return build_exam_reference_overlay(refs), refs


__all__ = (
    "ExamReference", "analyse_exam_text", "build_exam_reference_overlay",
    "discover_course_exams", "is_similar_exam_request", "resolve_exam_reference_overlay",
)
