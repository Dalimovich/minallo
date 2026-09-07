"""Deterministic lower-bound checks for generated-exam answer keys."""
from __future__ import annotations

import re

_PROCEDURAL_START_RE = re.compile(
    r"^(?:please\s+)?(?:calculate|compute|determine|use|apply|solve|formulate|sketch|draw|derive|find|"
    r"show|describe|discuss|explain|verify|confirm|berechne|bestimme|ermittle|verwende|benutze|wende|"
    r"l(?:o|\u00f6)se|formuliere|skizziere|zeichne|leite|finde|zeige|beschreibe|diskutiere|"
    r"erkl(?:a|\u00e4)re|pr(?:u|\u00fc)fe)\b", re.I)
_CALCULATION_REQUEST_RE = re.compile(
    r"\b(?:calculate|compute|determine|solve|derive|evaluate|find\s+(?:the\s+)?(?:value|function)|"
    r"berechne|bestimme|ermittle|l(?:o|\u00f6)se|leite\s+.*her|wert|gleichung|funktion|"
    r"separation|characteristics?|charakteristik)\b", re.I)
_DRAWING_REQUEST_RE = re.compile(
    r"\b(?:sketch|draw|plot|diagram|characteristics?|skizziere|zeichne|diagramm|charakteristik)\b", re.I)
_RESULT_ASSIGNMENT_RE = re.compile(
    r"(?:(?:[^\W\d]\w*(?:\s*\([^=\n]{1,80}\))?|\\?[A-Za-z]+(?:_\{?[^\s=]+\}?)?"
    r"(?:\s*\([^=\n]{1,80}\))?|[\u222b\u222e][^=\n]{0,160})\s*(?:=|\u2248|\u2243|:=)\s*"
    r"(?=\S)(?!\s*(?:\?|\.\.\.|\u2026|unknown|result)\s*$))", re.I)
_FINAL_VALUE_WITH_UNIT_RE = re.compile(
    r"(?:\b(?:answer|result|value|ergebnis|wert)\b\s*(?:is|ist|betr(?:a|\u00e4)gt|:)?\s*)?"
    r"[-+]?\d+(?:[.,]\d+)?(?:\s*[\u00d7x*]\s*10\^?[-+]?\d+)?\s*"
    r"(?:%|N|kN|Pa|kPa|MPa|GPa|J|W|kW|m|cm|mm|s|ms|Hz|rad|\u00b0C|K|kg|g|mol|V|A)\b", re.I)
_DRAWING_RESULT_RE = re.compile(
    r"\b(?:slope|gradient|intersect|parallel|increasing|decreasing|curve|line|straight|steigung|schnitt|"
    r"parallel|steigend|fallend|kurve|gerade|verlauf)\b.{0,100}(?:=|\b(?:is|are|ist|sind|with|mit)\b)", re.I | re.S)
_EXPLICIT_CONCLUSION_RE = re.compile(
    r"\b(?:true|false|wahr|falsch|therefore|thus|hence|consequently|daher|somit|folglich)\b.{3,}", re.I)
_MCQ_RE = re.compile(r"^\s*(?:option|answer|antwort)?\s*[:.-]?\s*([A-D])\s*[).:]?\s*$", re.I)


def _plain_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").splitlines():
        line = re.sub(r"^[\s>*#-]+", "", raw).strip()
        line = re.sub(r"^\*{0,2}[a-z]\)\*{0,2}\s*", "", line, flags=re.I)
        if line:
            lines.append(line)
    return lines


def contains_result_bearing_expression(answer: str) -> bool:
    """Return whether *answer* states a result rather than merely mentioning maths."""
    text = " ".join(_plain_lines(answer))
    return bool(text and (_RESULT_ASSIGNMENT_RE.search(text) or _FINAL_VALUE_WITH_UNIT_RE.search(text) or _EXPLICIT_CONCLUSION_RE.search(text)))


def solution_is_only_procedural_instruction(text: str) -> bool:
    lines = _plain_lines(text)
    substantive = [line for line in lines if not re.fullmatch(r"Aufgabe\s+\d+[:.]?", line, re.I)]
    if not substantive:
        return True
    procedural = sum(bool(_PROCEDURAL_START_RE.match(line)) for line in substantive)
    return procedural == len(substantive) and not contains_result_bearing_expression("\n".join(substantive))


def contains_explicit_result(question: str, answer: str, question_type: str | None = None) -> bool:
    """Strict final-answer gate shared by Markdown and structured exam paths."""
    text = " ".join(_plain_lines(answer))
    # A final-answer field must state the result directly. Even a procedural
    # sentence containing an incidental assignment ("Use x = 2 and solve")
    # belongs in keySteps, not in the canonical final answer.
    if not text or _PROCEDURAL_START_RE.match(text) or solution_is_only_procedural_instruction(answer):
        return False
    kind = (question_type or "").lower()
    if kind == "mcq":
        return bool(_MCQ_RE.fullmatch(text))
    if kind == "true_false":
        return text.lower().rstrip(".") in {"true", "false", "wahr", "falsch"}
    if _DRAWING_REQUEST_RE.search(question or ""):
        return bool(_RESULT_ASSIGNMENT_RE.search(text) or _DRAWING_RESULT_RE.search(text))
    if _CALCULATION_REQUEST_RE.search(question or ""):
        return contains_result_bearing_expression(text)
    return len(text.split()) >= 4 and not _PROCEDURAL_START_RE.match(text)


def validate_final_answer(question: str, final_answer: str, question_type: str | None = None) -> bool:
    """Validate only the canonical ``solution.finalAnswer`` field."""
    return contains_explicit_result(question, final_answer, question_type)


def answer_has_question_specific_result(question: str, answer: str) -> bool:
    """Backward-compatible entry point for free-form exam linting."""
    return contains_explicit_result(question, answer)


__all__ = ["answer_has_question_specific_result", "contains_explicit_result", "contains_result_bearing_expression", "solution_is_only_procedural_instruction", "validate_final_answer"]
