"""Provenance-aware reusable results for an ongoing tutoring conversation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any, Literal


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
    formula: str | None = None
    quantity: str | None = None
    assumptions: tuple[str, ...] = ()
    verification: dict[str, Any] = field(default_factory=dict)
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
    user_id: str | None = None
    course_id: str | None = None
    generation: int = 0
    document_id: str | None = None
    document_revision: str | None = None
    index_revision: str | None = None
    exam_variant: str | None = None
    active_question: str | None = None
    active_subquestion: str | None = None
    active_page: int | None = None
    active_region_id: str | None = None
    region_revision: str | None = None
    response_language: str = "en"
    response_mode: str = "explain"
    explanation_level: str = "normal"
    dialogue_act: str = "new_question"
    academic_task: str = "unknown"
    risk_class: str = "low"
    pending_clarification: str | None = None
    prompt_version: str | None = None
    model_version: str | None = None
    retrieval_version: str | None = None
    verifier_version: str | None = None
    results: dict[str, VerifiedResult] = field(default_factory=dict)
    corrections: list[CorrectionRecord] = field(default_factory=list)
    evidence_dependencies: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending_questions: list[str] = field(default_factory=list)

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

    def reusable_results(self) -> list[VerifiedResult]:
        """Return only results whose complete dependency chain is current."""
        reusable: list[VerifiedResult] = []
        for result in self.results.values():
            if not self.document_id or not self.document_revision:
                continue
            candidate = self.reusable_result(
                result.id,
                document_id=self.document_id,
                document_revision=self.document_revision,
                exam_variant=self.exam_variant,
            )
            if not candidate:
                continue
            if any(
                self.results.get(dep) is None
                or self.results[dep].status != "verified"
                for dep in candidate.derived_from_result_ids
            ):
                continue
            if any(
                self.evidence_dependencies.get(dep, {}).get("status") != "verified"
                for dep in candidate.derived_from_evidence_ids
            ):
                continue
            reusable.append(candidate)
        return reusable

    def to_api(self) -> dict[str, Any]:
        data = asdict(self)
        data["results"] = {key: value.to_api() for key, value in self.results.items()}
        return data

    @classmethod
    def from_api(cls, data: dict[str, Any], *, conversation_id: str) -> "TutorState":
        allowed = {
            "user_id", "course_id", "generation", "document_id", "document_revision",
            "index_revision", "exam_variant", "active_question", "active_subquestion",
            "active_page", "active_region_id", "region_revision", "response_language",
            "response_mode", "explanation_level", "dialogue_act", "academic_task",
            "risk_class", "pending_clarification", "prompt_version", "model_version",
            "retrieval_version", "verifier_version", "evidence_dependencies",
            "pending_questions",
        }
        kwargs = {key: data[key] for key in allowed if key in data}
        state = cls(conversation_id=conversation_id, **kwargs)
        for key, raw in (data.get("results") or {}).items():
            try:
                raw = dict(raw)
                raw["derived_from_evidence_ids"] = tuple(raw.get("derived_from_evidence_ids") or ())
                raw["derived_from_result_ids"] = tuple(raw.get("derived_from_result_ids") or ())
                raw["assumptions"] = tuple(raw.get("assumptions") or ())
                state.results[key] = VerifiedResult(**raw)
            except (TypeError, ValueError):
                continue
        for raw in data.get("corrections") or []:
            try:
                state.corrections.append(CorrectionRecord(
                    turn_id=str(raw.get("turn_id") or ""),
                    rejected_evidence_ids=tuple(raw.get("rejected_evidence_ids") or ()),
                    rejected_result_ids=tuple(raw.get("rejected_result_ids") or ()),
                    reason=raw.get("reason"),
                ))
            except (TypeError, ValueError):
                continue
        return state


__all__ = ["CorrectionRecord", "TutorState", "VerifiedResult"]
