"""Phase 7 — conservative math query expansion.

The hybrid search RPC takes a text BM25 query and a vector embedding. We
already embed the *original* question (semantic similarity handles
synonyms naturally), but BM25 needs literal token overlap to score
documents that phrase the same idea in a different language or keyword.

This module supplies a second, *expanded* BM25 query string for
math-flavoured questions. Non-math questions are returned unchanged so
casual chat ("summarize chapter 2") doesn't pull in unrelated formula
chunks.

Rules per plan-v2:
  * Only expand math-flavoured questions (solve/derive/prove, exercise
    keywords, formula keywords, numbers+units, equation tokens).
  * For exact exercise references, add the German/English keyword
    variants and the bare number/solution variants. Nothing else.
  * No broad synonym lists — that's how noise enters retrieval.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .retrieval import find_exercise_reference

# ── math-question detection ─────────────────────────────────────────────────

_MATH_VERBS = (
    "solve", "calculate", "compute", "derive", "prove", "evaluate",
    "differentiate", "integrate", "simplify", "factor", "expand",
    "lösen", "loesen", "berechne", "berechnen", "rechne", "leite", "beweise",
    "vereinfache", "vereinfachen",
)
_EXERCISE_KEYWORDS = (
    "aufgabe", "übung", "uebung", "exercise", "problem", "task", "beispiel",
    "lösung", "loesung", "solution",
)
_FORMULA_KEYWORDS = (
    "formula", "formel", "formelsammlung", "gleichung", "equation",
    "theorem", "satz", "ungleichung", "inequality",
    "kinematics", "kinematik", "velocity", "geschwindigkeit",
    "acceleration", "beschleunigung", "deceleration", "verzögerung",
    "verzoegerung", "free fall", "freier fall",
)
# A few common physics/engineering units. Hitting one of these is a
# strong signal that the question is numerical.
_UNIT_RE = re.compile(
    r"\b\d+(?:[\.,]\d+)?\s?"
    r"(?:m|cm|mm|km|kg|g|n|nm|kn|pa|kpa|mpa|gpa|j|kj|w|kw|s|ms|hz|khz|"
    r"a|ma|v|mv|kv|c|k|°c|°f|°)\b",
    re.IGNORECASE,
)
_EQUATION_TOKEN_RE = re.compile(r"[=≈≤≥≠]|[+\-*/^]\s*\d|[a-z]\s*=")
_NUMBER_RE = re.compile(r"\b\d+(?:[\.,]\d+)?\b")


def is_math_question(question: str) -> bool:
    """True when the question warrants math-style expansion + answer format.

    Conservative — false-positives ripple into Phase 8 ranking and Phase 9
    answer format. Better to under-classify than over-classify.
    """
    if not question:
        return False
    q = question.lower()

    if any(v in q for v in _MATH_VERBS):
        return True
    if any(k in q for k in _EXERCISE_KEYWORDS):
        return True
    if any(k in q for k in _FORMULA_KEYWORDS):
        return True
    if _UNIT_RE.search(question):
        return True
    if _EQUATION_TOKEN_RE.search(question):
        return True
    # Bare numerics alone don't trigger — "what's slide 3?" shouldn't be
    # treated as math. Two-or-more numbers plus an operator/= we caught
    # above; a single number isn't enough on its own.
    return False


# ── expansion ───────────────────────────────────────────────────────────────

# Exact-exercise keyword set: every variant we want BM25 to match.
_EXERCISE_VARIANTS = (
    "Aufgabe", "Übung", "Uebung",
    "Exercise", "Problem", "Task", "Beispiel",
)
_SOLUTION_VARIANTS = ("Lösung", "Loesung", "Musterlösung", "Solution")


@dataclass
class ExpandedQuery:
    text: str             # the BM25-side query (possibly expanded)
    expanded: bool        # true when we changed it
    exercise_number: str | None
    subpart: str | None


def expand_query(question: str) -> ExpandedQuery:
    """Return the BM25 query string to send to the hybrid RPC.

    * Non-math questions: original text unchanged.
    * Math questions with no exercise reference: original text unchanged
      (semantic embedding handles broader synonyms; we don't want to add
      formula tokens to a 'derive' question and pollute BM25).
    * Math questions with an exercise reference: original text PLUS the
      full set of language/solution variants for that exercise number.
    """
    if not is_math_question(question):
        return ExpandedQuery(text=question, expanded=False,
                             exercise_number=None, subpart=None)

    ref = find_exercise_reference(question)
    if not ref:
        return ExpandedQuery(text=question, expanded=False,
                             exercise_number=None, subpart=None)

    exercise_number, subpart = ref
    variants: list[str] = []
    for kw in _EXERCISE_VARIANTS:
        variants.append(f"{kw} {exercise_number}")
    for kw in _SOLUTION_VARIANTS:
        variants.append(f"{kw} {exercise_number}")
    variants.append(exercise_number)  # bare number — last so it doesn't dominate

    if subpart:
        # Add (a)/(b) variants and ungrouped letter variants.
        with_parens = [f"{v} ({subpart})" for v in (
            f"{kw} {exercise_number}" for kw in _EXERCISE_VARIANTS
        )]
        variants.extend(with_parens)

    expanded_text = question + " " + " ".join(variants)
    return ExpandedQuery(
        text=expanded_text,
        expanded=True,
        exercise_number=exercise_number,
        subpart=subpart,
    )


__all__ = ("ExpandedQuery", "expand_query", "is_math_question")
