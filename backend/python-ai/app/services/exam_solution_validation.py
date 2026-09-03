"""Deterministic lower-bound checks for generated-exam answer keys."""
from __future__ import annotations

import re


_PROCEDURAL_START_RE = re.compile(
    r"^(?:please\s+)?(?:calculate|compute|determine|use|apply|solve|formulate|"
    r"sketch|draw|derive|find|show|describe|discuss|explain|verify|confirm|"
    r"berechne|bestimme|ermittle|verwende|benutze|wende|löse|formuliere|"
    r"skizziere|zeichne|leite|finde|zeige|beschreibe|diskutiere|erkläre|prüfe)\b",
    re.IGNORECASE,
)
_CALCULATION_REQUEST_RE = re.compile(
    r"\b(?:calculate|compute|determine|solve|derive|evaluate|find\s+(?:the\s+)?(?:value|function)|"
    r"berechne|bestimme|ermittle|löse|leite\s+.*her|wert|gleichung|funktion)\b",
    re.IGNORECASE,
)
_DRAWING_REQUEST_RE = re.compile(
    r"\b(?:sketch|draw|plot|diagram|characteristics?|skizziere|zeichne|diagramm|charakteristik)\b",
    re.IGNORECASE,
)
_CONCRETE_RESULT_RE = re.compile(
    r"(?:=|≈|≃|\b\d+(?:[.,]\d+)?\s*(?:%|N|kN|Pa|MPa|J|W|m|mm|s|Hz|rad|°C)\b|"
    r"\b(?:answer|result|therefore|thus|equals?|is|are|means|beträgt|ergibt|daher|somit|ist|sind)\b)",
    re.IGNORECASE,
)
_EQUATION_OR_VALUE_RE = re.compile(
    r"(?:=|≈|≃|\b\d+(?:[.,]\d+)?\b|\\(?:frac|sin|cos|lambda|sigma|omega|pi)\b)",
    re.IGNORECASE,
)
_DRAWING_RESULT_RE = re.compile(
    r"\b(?:slope|gradient|intersect|parallel|increasing|decreasing|curve|line|"
    r"steigung|schnitt|parallel|steigend|fallend|kurve|gerade|verlauf)\b|=",
    re.IGNORECASE,
)


def _plain_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").splitlines():
        line = re.sub(r"^[\s>*#-]+", "", raw).strip()
        line = re.sub(r"^\*{0,2}[a-z]\)\*{0,2}\s*", "", line, flags=re.IGNORECASE)
        if line:
            lines.append(line)
    return lines


def solution_is_only_procedural_instruction(text: str) -> bool:
    lines = _plain_lines(text)
    if not lines:
        return True
    substantive = [line for line in lines if not re.fullmatch(r"Aufgabe\s+\d+[:.]?", line, re.I)]
    if not substantive:
        return True
    procedural = sum(bool(_PROCEDURAL_START_RE.match(line)) for line in substantive)
    return procedural == len(substantive) and not _CONCRETE_RESULT_RE.search("\n".join(substantive))


def answer_has_question_specific_result(question: str, answer: str) -> bool:
    """Enforce a real result; semantic/model verification remains separate."""
    if solution_is_only_procedural_instruction(answer):
        return False
    if _CALCULATION_REQUEST_RE.search(question or ""):
        return bool(_EQUATION_OR_VALUE_RE.search(answer or ""))
    if _DRAWING_REQUEST_RE.search(question or ""):
        return bool(_DRAWING_RESULT_RE.search(answer or ""))
    return len(" ".join(_plain_lines(answer))) >= 20


__all__ = ["answer_has_question_specific_result", "solution_is_only_procedural_instruction"]
