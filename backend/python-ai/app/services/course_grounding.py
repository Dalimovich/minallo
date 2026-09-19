"""Strict course-evidence policy helpers shared by /ask and /ask-stream."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


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


def infer_document_authority(file_name: str, document_type: str | None = None) -> DocumentAuthority:
    value = f"{document_type or ''} {file_name or ''}".lower()
    if re.search(r"(?:lecture|vorlesung|skript|professor|folien)", value):
        return DocumentAuthority.PROFESSOR_LECTURE
    if re.search(r"(?:official.solution|musterlösung|musterloesung|lösung|solution)", value):
        return DocumentAuthority.OFFICIAL_SOLUTION
    if re.search(r"(?:formula.sheet|formelsammlung|formelblatt)", value):
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
    required = ["professor definition or course explanation"]
    if _MATH_RE.search(question or ""):
        required = ["question statement", "applicable formula", "official solution method"]
    elif _DEFINITION_RE.search(question or ""):
        required = ["professor definition or convention"]
    elif _EXAM_RE.search(question or ""):
        required = ["exact exam question", "official solution method", "lecture explanation"]

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
