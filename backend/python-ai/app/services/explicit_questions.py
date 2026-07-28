"""Current-message question inventory and visual-reference precedence."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


_QUESTION_START_RE = re.compile(
    r"\b(?:what|how|why|which|who|name|list|explain|compare|calculate|"
    r"was|wie|warum|welche|welcher|wer|nennen|erkl[aä]r\w*|vergleichen|berechnen)\b",
    re.IGNORECASE,
)
_EXPLICIT_VISUAL_RE = re.compile(
    r"\b(?:this|that)\s+(?:image|page|diagram|figure|table|marked question|highlighted area|selection)|"
    r"\b(?:explain|show|read)\s+this\b|"
    r"\b(?:dieses|diese|dieser)\s+(?:bild|seite|abbildung|diagramm|tabelle)|"
    r"\b(?:die\s+)?markierte(?:n|r|s)?\s+(?:aufgabe|frage|bereich)|"
    r"\b(?:der\s+)?markierte(?:n|r|s)?\s+bereich|"
    r"\b(?:erkl[aä]re|lies|zeige)\s+(?:mir\s+)?das\s+hier\b",
    re.IGNORECASE,
)
_EXACT_SCOPE_RE = re.compile(
    r"\b(?:none other|no other(?:s)?|only (?:these|those)|exactly (?:these|those)|"
    r"keine anderen|nur diese|genau diese)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ExplicitQuestionDetection:
    questions: tuple[str, ...]
    question_count: int
    self_contained: bool
    contains_visual_reference: bool
    exact_scope: bool
    inventory_hash: str


def detect_explicit_questions(message: str) -> ExplicitQuestionDetection:
    """Detect complete questions in the current message, never passive viewer state."""
    text = (message or "").strip()
    questions: list[str] = []
    cleaned = re.sub(r"[§•]", "\n", text)
    for raw_line in cleaned.splitlines():
        line = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", raw_line).strip()
        start = _QUESTION_START_RE.match(line)
        if not start:
            continue
        # German exam prompts frequently use an imperative ending in a period
        # ("Nennen Sie ... ."). They are requested items just like clauses
        # ending in a question mark. Keep a same-line continuation such as
        # "...? Nennen Sie je ein Beispiel." as one item.
        imperative = re.match(
            r"^(?:name|list|explain|compare|calculate|nennen|erkl[aä]r\w*|vergleichen|berechnen)\b",
            line, re.I,
        )
        if "?" in line or (
            imperative and line.endswith(".") and len(re.findall(r"\b\w+\b", line)) >= 5
        ):
            candidate = line.strip()
            if candidate not in questions:
                questions.append(candidate)
    visual = bool(_EXPLICIT_VISUAL_RE.search(text))
    if visual:
        questions = []
    self_contained = bool(questions) and not visual
    digest = hashlib.sha256("\n".join(questions).encode("utf-8")).hexdigest() if questions else ""
    return ExplicitQuestionDetection(
        questions=tuple(questions),
        question_count=len(questions),
        self_contained=self_contained,
        contains_visual_reference=visual,
        exact_scope=bool(_EXACT_SCOPE_RE.search(text)),
        inventory_hash=digest,
    )


__all__ = ["ExplicitQuestionDetection", "detect_explicit_questions"]
