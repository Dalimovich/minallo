"""Strict course-evidence policy helpers shared by /ask and /ask-stream."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any

from .reliability import VisualTaskKind, classify_task_traits


class DocumentAuthority(str, Enum):
    PROFESSOR_LECTURE = "professor_lecture"
    OFFICIAL_SOLUTION = "official_solution"
    OFFICIAL_FORMULA_SHEET = "official_formula_sheet"
    OFFICIAL_EXAM = "official_exam"
    EXERCISE_SHEET = "exercise_sheet"
    STUDENT_NOTES = "student_notes"
    GENERATED_SUMMARY = "generated_summary"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class CourseEvidenceReport:
    course_id: str
    searched_document_ids: list[str]
    supporting_document_ids: list[str]
    required_evidence: list[str]
    found_evidence: list[str]
    missing_evidence: list[str]
    sufficient: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_MATH_RE = re.compile(r"(?:\d|=|calculate|solve|berechne|bestimme|aufgabe|formula|formel)", re.I)
_DEFINITION_RE = re.compile(r"(?:definition|definiere|was ist|what is|begriff)", re.I)
_EXAM_RE = re.compile(r"(?:exam|klausur|prüfung|pruefung)", re.I)
# A request can explicitly demand the worked/official solution regardless of
# how its task kind otherwise classifies (e.g. "what's the official solution
# for this formula?" still classifies as FORMULA_EXPLANATION below) -- that
# explicit ask must still be backed by an OFFICIAL_SOLUTION-authority
# document, never waved through just because a topically relevant chunk
# (e.g. a student's own notes) happens to exist.
_SOLUTION_REQUEST_RE = re.compile(
    r"\b(?:solution|musterl[öo]sung|l[öo]sung(?:en)?|worked.?solution|answer.?key|"
    r"official\s+answer)\b",
    re.I,
)
# reliability._FORMULA_RE (feeding classify_task_traits) only matches the
# singular "formula"/"formel" -- it also drives evidence_requirement's
# image-capture gate elsewhere in the pipeline, so widening it there to catch
# plurals would additionally start demanding a page image for every plural
# "formulas"/"equations" question across /ask and /ask-stream, not just this
# evidence check. Scoped locally instead: this plural-tolerant variant is used
# only to recognise a formula topic for required-evidence purposes.
_FORMULA_TOPIC_RE = re.compile(
    r"\b(?:formulas?|equations?|formeln?|gleichung(?:en)?)\b", re.I,
)


def infer_document_authority(file_name: str, document_type: str | None = None) -> DocumentAuthority:
    value = f"{document_type or ''} {file_name or ''}".lower()
    if re.search(r"(?:lecture|vorlesung|skript|professor|folien)", value):
        return DocumentAuthority.PROFESSOR_LECTURE
    if re.search(r"(?:official.solution|musterlösung|musterloesung|lösung|solution)", value):
        return DocumentAuthority.OFFICIAL_SOLUTION
    if re.search(r"(?:formula.sheet|formelsammlung|formelblatt|formelzettel)", value):
        return DocumentAuthority.OFFICIAL_FORMULA_SHEET
    if re.search(r"(?:exam|klausur|prüfung|pruefung)", value):
        return DocumentAuthority.OFFICIAL_EXAM
    if re.search(r"(?:exercise|übung|uebung|aufgabenblatt)", value):
        return DocumentAuthority.EXERCISE_SHEET
    if re.search(r"(?:generated|summary|zusammenfassung|cheatsheet)", value):
        return DocumentAuthority.GENERATED_SUMMARY
    if re.search(r"(?:student|notes|notizen|mitschrift)", value):
        return DocumentAuthority.STUDENT_NOTES
    return DocumentAuthority.UNKNOWN


def authority_priority(authority: DocumentAuthority, question: str) -> int:
    if _MATH_RE.search(question or ""):
        order = [DocumentAuthority.EXERCISE_SHEET, DocumentAuthority.OFFICIAL_SOLUTION,
                 DocumentAuthority.OFFICIAL_FORMULA_SHEET, DocumentAuthority.PROFESSOR_LECTURE]
    elif _DEFINITION_RE.search(question or ""):
        order = [DocumentAuthority.PROFESSOR_LECTURE, DocumentAuthority.OFFICIAL_FORMULA_SHEET,
                 DocumentAuthority.EXERCISE_SHEET]
    elif _EXAM_RE.search(question or ""):
        order = [DocumentAuthority.OFFICIAL_EXAM, DocumentAuthority.OFFICIAL_SOLUTION,
                 DocumentAuthority.PROFESSOR_LECTURE, DocumentAuthority.EXERCISE_SHEET,
                 DocumentAuthority.OFFICIAL_FORMULA_SHEET]
    else:
        order = [DocumentAuthority.PROFESSOR_LECTURE, DocumentAuthority.OFFICIAL_SOLUTION,
                 DocumentAuthority.OFFICIAL_FORMULA_SHEET, DocumentAuthority.EXERCISE_SHEET]
    try:
        return len(order) - order.index(authority)
    except ValueError:
        return -2 if authority == DocumentAuthority.GENERATED_SUMMARY else 0


def rank_course_chunks(chunks: list[Any], doc_names: dict[str, str], question: str) -> list[Any]:
    """Stable authority-aware ordering; semantic score remains the tie-breaker."""
    def stage_priority(chunk: Any) -> int:
        stage = getattr(chunk, "retrieval_stage", None)
        return -(stage if stage is not None else 999)
    return sorted(
        chunks,
        key=lambda chunk: (
            stage_priority(chunk),
            authority_priority(
                infer_document_authority(doc_names.get(getattr(chunk, "document_id", ""), "")),
                question,
            ),
            float(getattr(chunk, "score", 0.0) or 0.0),
        ),
        reverse=True,
    )


def build_course_evidence_report(
    *, course_id: str, searched_document_ids: list[str], chunks: list[Any],
    doc_names: dict[str, str], question: str,
) -> CourseEvidenceReport:
    """Required evidence follows the student's actual learning objective, via
    the same task classifier the rest of the pipeline already uses to tell a
    calculation apart from an explanation (reliability.classify_task_traits)
    -- not a flat "does the question contain a math-ish word" catch-all.
    Explaining/defining a formula only ever needs the formula itself; solving
    a specific exercise needs the full question+formula+solution bundle a
    pure explanation request was never going to supply in the first place."""
    visual_kind = classify_task_traits(question).visual_kind
    if _EXAM_RE.search(question or ""):
        required = ["exact exam question", "official solution method", "lecture explanation"]
    elif visual_kind is VisualTaskKind.NUMERICAL_CALCULATION:
        required = ["question statement", "applicable formula", "official solution method"]
    # Checked ahead of FORMULA_EXPLANATION/definition/default: an explicit
    # solution request is its own learning objective (needs an authoritative
    # worked solution) independent of whether the question also happens to
    # mention a formula or use definition-style wording ("what is ...").
    elif _SOLUTION_REQUEST_RE.search(question or ""):
        required = ["official solution method"]
    elif visual_kind is VisualTaskKind.FORMULA_EXPLANATION or _FORMULA_TOPIC_RE.search(question or ""):
        required = ["applicable formula"]
    elif _DEFINITION_RE.search(question or ""):
        required = ["professor definition or convention"]
    else:
        required = ["professor definition or course explanation"]

    authorities = {
        infer_document_authority(doc_names.get(getattr(chunk, "document_id", ""), ""))
        for chunk in chunks
    }
    found: list[str] = []
    if authorities & {DocumentAuthority.EXERCISE_SHEET, DocumentAuthority.OFFICIAL_EXAM}:
        found.append("question statement")
    if DocumentAuthority.OFFICIAL_FORMULA_SHEET in authorities or any(
        getattr(chunk, "chunk_type", "") == "formula" for chunk in chunks
    ):
        found.append("applicable formula")
    if DocumentAuthority.OFFICIAL_SOLUTION in authorities:
        found.append("official solution method")
    if DocumentAuthority.PROFESSOR_LECTURE in authorities:
        found.extend(["professor definition or course explanation", "professor definition or convention", "lecture explanation"])
    missing = [item for item in required if item not in found]
    supporting = list(dict.fromkeys(
        getattr(chunk, "document_id", "") for chunk in chunks
        if getattr(chunk, "document_id", "") and not str(getattr(chunk, "document_id", "")).startswith("__")
    ))
    return CourseEvidenceReport(
        course_id=course_id,
        searched_document_ids=list(dict.fromkeys(searched_document_ids)),
        supporting_document_ids=supporting,
        required_evidence=required,
        found_evidence=list(dict.fromkeys(found)),
        missing_evidence=missing,
        sufficient=bool(supporting) and not missing,
    )


def assert_authorised_course_chunks(chunks: list[Any], authorised_document_ids: set[str]) -> None:
    unauthorised = {
        getattr(chunk, "document_id", "") for chunk in chunks
        if getattr(chunk, "document_id", "")
        and not str(getattr(chunk, "document_id", "")).startswith("__")
        and getattr(chunk, "document_id", "") not in authorised_document_ids
    }
    if unauthorised:
        raise ValueError("retrieval returned documents outside the authorised course manifest")
