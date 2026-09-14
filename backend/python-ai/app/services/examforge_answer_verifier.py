"""Independent, answer-key-blind verification for ExamForge practice questions.

This module deliberately knows only ExamForge's three interactive question
types.  It makes one batched model call, then compares the independently
derived answers with the generated keys locally.  Prompts and hidden reasoning
are never returned to callers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import re
from typing import Any, Literal, Mapping, Sequence

from .exam_solution_validation import validate_final_answer
from .llm_json import chat_json


log = logging.getLogger(__name__)
QuestionType = Literal["mcq", "true_false", "short_answer"]
VerificationStatus = Literal["verified", "corrected", "rejected"]
_LETTERS = ("A", "B", "C", "D")


@dataclass(frozen=True)
class AnswerVerificationResult:
    question_id: str
    status: VerificationStatus
    verified_answer: str | None
    confidence: float
    key_steps: tuple[str, ...] = field(default_factory=tuple)
    reason: str | None = None

    @property
    def accepted(self) -> bool:
        return self.status in {"verified", "corrected"}


def _normalise_true_false(value: Any) -> str | None:
    word = str(value or "").strip().casefold()
    if word in {"true", "wahr", "yes", "ja", "1"}:
        return "true"
    if word in {"false", "falsch", "no", "nein", "0"}:
        return "false"
    return None


def _normalise_answer(question_type: str, value: Any, options: Sequence[str]) -> str | None:
    text = str(value or "").strip()
    if question_type == "mcq":
        letter = text.upper().removesuffix(")").removesuffix(".")
        if letter in _LETTERS[: len(options)]:
            return letter
        matches = [index for index, option in enumerate(options) if option.strip().casefold() == text.casefold()]
        return _LETTERS[matches[0]] if len(matches) == 1 else None
    if question_type == "true_false":
        return _normalise_true_false(value)
    return re.sub(r"\s+", " ", text).strip() or None


def answers_match(question_type: str, generated: Any, verified: Any, options: Sequence[str] = ()) -> bool:
    """Deterministically compare keys after type-specific canonicalisation."""
    left = _normalise_answer(question_type, generated, options)
    right = _normalise_answer(question_type, verified, options)
    if left is None or right is None:
        return False
    if question_type != "short_answer":
        return left == right
    # Exact textual agreement is deterministic. Numeric answers additionally
    # tolerate presentation-only differences such as decimal comma and spaces.
    compact_left = re.sub(r"\s+", "", left.casefold()).replace(",", ".")
    compact_right = re.sub(r"\s+", "", right.casefold()).replace(",", ".")
    return compact_left == compact_right


def _confidence(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, min(float(value), 1.0))
    labels = {"high": 0.9, "medium": 0.65, "low": 0.3}
    return labels.get(str(value or "").strip().casefold(), 0.0)


def _evidence_text(evidence: Sequence[Mapping[str, Any]]) -> str:
    safe = []
    for item in evidence:
        safe.append({
            "chunk_id": str(item.get("chunk_id") or item.get("id") or ""),
            "document": str(item.get("document") or item.get("file_name") or ""),
            "page": item.get("page"),
            "text": str(item.get("text") or item.get("content") or ""),
        })
    return json.dumps(safe, ensure_ascii=False)


def verify_examforge_answers(
    questions: Sequence[Mapping[str, Any]],
    evidence: Sequence[Mapping[str, Any]],
    *,
    model: str | None = None,
    correction_threshold: float = 0.85,
    acceptance_threshold: float = 0.60,
) -> list[AnswerVerificationResult]:
    """Solve questions independently in one call and accept, correct, or reject.

    The generated ``answer`` and solution are intentionally omitted from the
    model input.  A high-confidence, structurally valid disagreement is
    corrected; ambiguity, malformed output, and low confidence fail closed.
    """
    indexed: dict[str, Mapping[str, Any]] = {}
    blind_questions: list[dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        qid = str(question.get("id") or f"question-{index}")
        qtype = str(question.get("type") or "").strip().lower()
        if qtype not in {"mcq", "true_false", "short_answer"}:
            continue
        options = question.get("options") if isinstance(question.get("options"), list) else []
        indexed[qid] = question
        blind_questions.append({
            "id": qid,
            "type": qtype,
            "question": str(question.get("question") or question.get("prompt") or ""),
            "options": [str(option) for option in options],
            # This is provenance, not the generated key. It constrains the
            # verifier to the exact evidence claimed by this question so an
            # unrelated chunk elsewhere in the pool cannot rescue a bad cite.
            "evidence_chunk_ids": [
                str(chunk_id) for chunk_id in (question.get("source_chunk_ids") or [])
            ],
        })
    if not blind_questions:
        return []

    system = (
        "You independently verify ExamForge practice answers using only the supplied course "
        "evidence. For each question, use ONLY the chunks named in its evidence_chunk_ids; "
        "if those chunks do not answer it, mark it ambiguous. Solve each exact question yourself. "
        "For MCQ return only A-D; for true/false "
        "return true or false; for short answer return a concise final result including units. "
        "Recompute numerical work and check units, signs, assumptions, and given parameters. "
        "Do not infer unsupported facts. Return JSON with `results`, each containing id, answer, "
        "confidence (0..1), status (`solved` or `ambiguous`), and at most four concise key_steps. "
        "key_steps are short verification facts/formulas, never private chain-of-thought."
    )
    user = (
        "COURSE EVIDENCE:\n" + _evidence_text(evidence)
        + "\n\nQUESTIONS (answer keys intentionally withheld):\n"
        + json.dumps(blind_questions, ensure_ascii=False)
    )
    try:
        response = chat_json(
            system=system,
            user=user,
            model=model,
            max_tokens=max(700, len(blind_questions) * 180),
        )
    except Exception:  # noqa: BLE001 - verification must fail closed, not break generation
        log.exception("ExamForge independent answer verification failed")
        return [
            AnswerVerificationResult(qid, "rejected", None, 0.0, reason="verifier_unavailable")
            for qid in indexed
        ]
    payload = response.data if isinstance(response.data, Mapping) else {}
    raw_results = payload.get("results") if isinstance(payload.get("results"), list) else []
    by_id = {
        str(item.get("id")): item
        for item in raw_results
        if isinstance(item, Mapping) and str(item.get("id")) in indexed
    }

    results: list[AnswerVerificationResult] = []
    for qid, question in indexed.items():
        verdict = by_id.get(qid)
        if verdict is None:
            results.append(AnswerVerificationResult(qid, "rejected", None, 0.0, reason="missing_verdict"))
            continue
        qtype = str(question.get("type"))
        options = [str(x) for x in question.get("options", [])] if isinstance(question.get("options"), list) else []
        confidence = _confidence(verdict.get("confidence"))
        independently_solved = _normalise_answer(qtype, verdict.get("answer"), options)
        steps = tuple(str(step).strip()[:240] for step in (verdict.get("key_steps") or [])[:4] if str(step).strip())
        is_valid = independently_solved is not None and (
            qtype != "short_answer"
            or validate_final_answer(
                str(question.get("question") or question.get("prompt") or ""), independently_solved, qtype
            )
        )
        if verdict.get("status") != "solved" or not is_valid or confidence < acceptance_threshold:
            results.append(AnswerVerificationResult(qid, "rejected", None, confidence, steps, "not_confidently_solved"))
            continue
        if answers_match(qtype, question.get("answer"), independently_solved, options):
            results.append(AnswerVerificationResult(qid, "verified", independently_solved, confidence, steps))
        elif confidence >= correction_threshold:
            results.append(AnswerVerificationResult(qid, "corrected", independently_solved, confidence, steps, "wrong_generated_key"))
        else:
            results.append(AnswerVerificationResult(qid, "rejected", None, confidence, steps, "ambiguous_disagreement"))
    return results


__all__ = ["AnswerVerificationResult", "answers_match", "verify_examforge_answers"]
