"""Canonical, UI-neutral representation and validation of generated exams."""
from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, Mapping

from .exam_solution_validation import validate_final_answer


@dataclass(frozen=True)
class ExamValidationIssue:
    code: str
    message: str
    question_id: str | None = None


@dataclass
class VerifiedSolution:
    question_id: str
    key_steps: list[str] = field(default_factory=list)
    final_answer: str = ""
    explanation: str = ""
    validation_status: str = "pending"


@dataclass
class VerifiedExamQuestion:
    id: str
    question_type: str
    prompt: str
    points: int
    section_id: str | None = None
    subpart_id: str | None = None
    topic: str | None = None
    difficulty: str | None = None
    generated_parameters: dict[str, Any] = field(default_factory=dict)
    solution: VerifiedSolution = field(default_factory=lambda: VerifiedSolution(question_id=""))
    sources: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class VerifiedExam:
    title: str
    questions: list[VerifiedExamQuestion]
    duration_minutes: int | None = None
    total_points: int | None = None
    source_summary: str | None = None
    validation_status: str = "pending"

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "VerifiedExam":
        questions: list[VerifiedExamQuestion] = []
        for index, raw_value in enumerate(value.get("questions") or [], start=1):
            raw = raw_value if isinstance(raw_value, Mapping) else {}
            qid = str(raw.get("id") or f"question-{index}")
            sol_value = raw.get("solution")
            sol = sol_value if isinstance(sol_value, Mapping) else {}
            params = raw.get("generatedParameters") or raw.get("generated_parameters") or {}
            questions.append(VerifiedExamQuestion(
                id=qid,
                question_type=str(raw.get("type") or raw.get("questionType") or "short_answer"),
                prompt=str(raw.get("question") or raw.get("prompt") or "").strip(),
                points=int(raw.get("points") or 0),
                section_id=str(raw.get("sectionId")) if raw.get("sectionId") is not None else None,
                subpart_id=str(raw.get("subpartId")) if raw.get("subpartId") is not None else None,
                topic=str(raw.get("topic")) if raw.get("topic") is not None else None,
                difficulty=str(raw.get("difficulty")) if raw.get("difficulty") is not None else None,
                generated_parameters=dict(params) if isinstance(params, Mapping) else {},
                solution=VerifiedSolution(
                    question_id=str(sol.get("questionId") or qid),
                    key_steps=[str(x) for x in (sol.get("keySteps") or []) if str(x).strip()],
                    final_answer=str(sol.get("finalAnswer") or raw.get("answer") or "").strip(),
                    explanation=str(sol.get("explanation") or raw.get("explanation") or "").strip(),
                    validation_status=str(sol.get("validationStatus") or "pending"),
                ),
                sources=list(raw.get("sources") or []),
            ))
        stated_total = value.get("totalPoints") or value.get("total_points")
        return cls(
            title=str(value.get("title") or "Exam"), questions=questions,
            duration_minutes=value.get("durationMinutes") or value.get("duration_minutes"),
            total_points=int(stated_total) if stated_total is not None else None,
            source_summary=value.get("sourceSummary") or value.get("source_summary"),
            validation_status=str(value.get("validationStatus") or "pending"),
        )


def _normalise_parameter(value: Any) -> str:
    return re.sub(r"\s+", "", str(value)).replace(",", ".").lower()


def _parameter_conflicts(question: VerifiedExamQuestion) -> list[str]:
    haystack = " ".join([question.solution.final_answer, question.solution.explanation, *question.solution.key_steps])
    conflicts: list[str] = []
    for name, expected in question.generated_parameters.items():
        expected_values = expected if isinstance(expected, list) else [expected]
        matches = re.findall(rf"(?<!\w){re.escape(str(name))}\s*=\s*([^,;\s$]+)", haystack, re.I)
        allowed = {
            candidate
            for value in expected_values
            for candidate in (_normalise_parameter(value), _normalise_parameter(str(value).split()[0]))
        }
        if matches and any(_normalise_parameter(actual) not in allowed for actual in matches):
            conflicts.append(str(name))
    return conflicts


def validate_verified_exam(exam: VerifiedExam | Mapping[str, Any]) -> list[ExamValidationIssue]:
    """Run deterministic acceptance checks for every renderer/generation path."""
    canonical = exam if isinstance(exam, VerifiedExam) else VerifiedExam.from_dict(exam)
    issues: list[ExamValidationIssue] = []
    seen_ids: set[str] = set()
    for question in canonical.questions:
        if not question.id or question.id in seen_ids:
            issues.append(ExamValidationIssue("question_id", "Question IDs must be present and unique.", question.id))
        seen_ids.add(question.id)
        if question.solution.question_id != question.id:
            issues.append(ExamValidationIssue("solution_id", "Solution questionId does not match its question.", question.id))
        if question.points <= 0:
            issues.append(ExamValidationIssue("points", "Question points must be positive.", question.id))
        if not validate_final_answer(question.prompt, question.solution.final_answer, question.question_type):
            issues.append(ExamValidationIssue("final_answer", "A result-bearing final answer is required.", question.id))
        conflicts = _parameter_conflicts(question)
        if conflicts:
            issues.append(ExamValidationIssue("parameter_mismatch", f"Solution uses stale generated parameter(s): {', '.join(conflicts)}.", question.id))
    computed_total = sum(q.points for q in canonical.questions)
    if canonical.total_points is not None and canonical.total_points != computed_total:
        issues.append(ExamValidationIssue("point_total", "Exam total does not equal the sum of question points."))
    return issues


__all__ = ["ExamValidationIssue", "VerifiedExam", "VerifiedExamQuestion", "VerifiedSolution", "validate_verified_exam"]
