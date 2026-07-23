"""Provenance-aware reusable results for an ongoing tutoring conversation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Literal


ResultStatus = Literal["verified", "stale", "rejected"]


@dataclass(frozen=True)
class VerifiedResult:
    id: str
    document_id: str
    document_revision: str
    exam_variant: str | None
    question_id: str
    value: str
    unit: str | None = None
    derived_from_evidence_ids: tuple[str, ...] = ()
    derived_from_result_ids: tuple[str, ...] = ()
    status: ResultStatus = "verified"
    source_priority: str = "active_question"

    def to_api(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class CorrectionRecord:
    turn_id: str
    rejected_evidence_ids: tuple[str, ...] = ()
    rejected_result_ids: tuple[str, ...] = ()
    reason: str | None = None


@dataclass
class TutorState:
    conversation_id: str
    generation: int = 0
    document_id: str | None = None
    document_revision: str | None = None
    exam_variant: str | None = None
    active_question: str | None = None
    active_page: int | None = None
    active_region_id: str | None = None
    response_language: str = "en"
    response_mode: str = "explain"
    explanation_level: str = "normal"
    results: dict[str, VerifiedResult] = field(default_factory=dict)
    corrections: list[CorrectionRecord] = field(default_factory=list)

    def add_verified_result(self, result: VerifiedResult) -> None:
        if result.status != "verified":
            raise ValueError("only verified results may enter reusable state")
        self.results[result.id] = result

    def invalidate(
        self,
        *,
        rejected_evidence_ids: set[str] | None = None,
        rejected_result_ids: set[str] | None = None,
        status: ResultStatus = "stale",
        turn_id: str = "",
        reason: str | None = None,
    ) -> set[str]:
        """Transitively invalidate every result depending on rejected input."""
        evidence_ids = set(rejected_evidence_ids or set())
        invalid_ids = set(rejected_result_ids or set())
        changed = True
        while changed:
            changed = False
            for result in self.results.values():
                if result.id in invalid_ids:
                    continue
                if (
                    evidence_ids.intersection(result.derived_from_evidence_ids)
                    or invalid_ids.intersection(result.derived_from_result_ids)
                ):
                    invalid_ids.add(result.id)
                    changed = True
        for result_id in invalid_ids:
            result = self.results.get(result_id)
            if result:
                self.results[result_id] = replace(result, status=status)
        self.corrections.append(CorrectionRecord(
            turn_id=turn_id,
            rejected_evidence_ids=tuple(sorted(evidence_ids)),
            rejected_result_ids=tuple(sorted(invalid_ids)),
            reason=reason,
        ))
        self.generation += 1
        return invalid_ids

    def reusable_result(
        self,
        result_id: str,
        *,
        document_id: str,
        document_revision: str,
        exam_variant: str | None,
    ) -> VerifiedResult | None:
        result = self.results.get(result_id)
        if not result or result.status != "verified":
            return None
        if result.document_id != document_id or result.document_revision != document_revision:
            return None
        if result.exam_variant != exam_variant:
            return None
        if result.source_priority in {"teaching_example", "similar_exercise"}:
            return None
        return result

    def change_document(self, document_id: str, revision: str) -> set[str]:
        stale = {
            result.id for result in self.results.values()
            if result.document_id != document_id or result.document_revision != revision
        }
        if stale:
            self.invalidate(rejected_result_ids=stale, reason="document revision changed")
        self.document_id = document_id
        self.document_revision = revision
        return stale


__all__ = ["CorrectionRecord", "TutorState", "VerifiedResult"]
