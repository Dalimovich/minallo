"""Semantic Student Intent Layer Phase D — an independent, deterministic
backstop against a generated answer leaking a result the compiled
``ExecutionPolicy`` prohibited.

Why this exists, stated plainly: ``policy_prompt_rendering.py`` (Phase C)
only ever produces PROMPT TEXT — the same enforcement level PR3's own
reconciliation packet already names as a real limitation ("enforcement
mechanism is prompt-overlay only, with no structural/verification check
of compliance"). A model can still ignore, forget, or be talked out of
an instruction, especially under an adversarial framing ("let's check
our work: the answer is 42 N"). This module is the check that runs on
the ACTUAL generated text, independent of whether the prompt asked
correctly.

What this module is NOT: a general-purpose, reliable "is this text
correct" verifier. It cannot know the real numeric answer, so it cannot
confirm a number is RIGHT — only that the text contains a RELEASE-SHAPED
pattern (a final-answer/official-solution statement) when the policy
says that should be withheld for some target. This is a deliberately
narrow, pattern-based, conservative scan — not a claim of semantic
understanding. Where it is uncertain, it treats the output as a match
(fail closed) rather than silently passing it through. Per the explicit
instruction this module was built against: "do not claim a general-
purpose output validator is perfect based on a handful of examples" —
it is not claimed to be; see the module's own test file for exactly
which adversarial shapes are covered (prose, table cell, LaTeX, a
"let's check our work" framing) and which are explicitly NOT (e.g. a
genuinely novel unit-conversion phrasing never seen in these patterns —
flagged in the final report as needing real-model adversarial
evaluation, not claimed solved here).

Missing target attribution: the scan does not (cannot, from plain text)
attribute a matched leak to a SPECIFIC target when a policy has
multiple actions. It treats ANY prohibited final_answer/official_
solution across ANY target as grounds to withhold the WHOLE response —
the conservative choice the task explicitly asked for ("treat missing
target attribution and ambiguous results conservatively"), not an
attempt to surgically redact only the offending target's portion (doing
that correctly would itself need per-target text attribution this
plain-text scan does not have).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .policy_compiler import ExecutionPolicy

_LEAK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("final_answer_phrase", re.compile(
        r"\b(?:the\s+(?:final\s+)?(?:answer|result)\s+is|final\s+answer\s*:|"
        r"das\s+(?:end)?ergebnis\s+ist|die\s+(?:l(?:ö|oe)sung|antwort)\s+(?:ist|lautet))\b",
        re.IGNORECASE,
    )),
    ("boxed_or_labeled_result", re.compile(
        r"\\boxed\{|\*\*(?:final\s+)?(?:answer|result|ergebnis)\*\*|"
        r"^\s*(?:answer|result|ergebnis)\s*:\s*\S",
        re.IGNORECASE | re.MULTILINE,
    )),
    ("result_table_row", re.compile(
        r"\|[^|\n]{0,40}\b(?:final\s+)?(?:answer|result|ergebnis|l(?:ö|oe)sung)\b[^|\n]{0,10}\|",
        re.IGNORECASE,
    )),
    ("verification_framing_with_number", re.compile(
        r"\b(?:let'?s\s+check|checking\s+our\s+work|let'?s\s+verify|zur\s+kontrolle)\b"
        r"[^.\n]{0,60}[-+]?\d+(?:[.,]\d+)?\s*[a-zA-Z°%]{0,6}\b",
        re.IGNORECASE,
    )),
    ("official_solution_phrase", re.compile(
        r"\b(?:official\s+solution|musterl(?:ö|oe)sung|solution\s+key|answer\s+key)\b",
        re.IGNORECASE,
    )),
)


@dataclass(frozen=True)
class ReleaseValidationResult:
    allowed: bool
    reason: str
    matched_patterns: tuple[str, ...]


def _any_action_prohibits(policy: ExecutionPolicy, field: str) -> bool:
    return any(getattr(action.release, field) == "prohibited" for action in policy.actions)


def scan_generated_answer_for_prohibited_release(
    text: str, *, policy: ExecutionPolicy | None,
) -> ReleaseValidationResult:
    """The one real check: does ``text`` look like it reveals a final
    result or official solution the compiled policy prohibits for ANY
    target? Conservative by construction — see module docstring for
    exactly what this does and does not detect."""
    if policy is None:
        return ReleaseValidationResult(allowed=True, reason="no_policy", matched_patterns=())
    prohibits_final_answer = _any_action_prohibits(policy, "final_answer")
    prohibits_official_solution = _any_action_prohibits(policy, "official_solution")
    if not prohibits_final_answer and not prohibits_official_solution:
        return ReleaseValidationResult(allowed=True, reason="no_restriction", matched_patterns=())

    matched = tuple(name for name, pattern in _LEAK_PATTERNS if pattern.search(text or ""))
    if matched:
        return ReleaseValidationResult(allowed=False, reason="matched_leak_pattern", matched_patterns=matched)
    return ReleaseValidationResult(allowed=True, reason="no_match", matched_patterns=())


def safe_withheld_answer_text(*, response_language: str) -> str:
    """What the student sees instead, when the scan withholds a response.
    Honest about WHY (their own request), never a generic error — this is
    an expected, requested state, not a failure."""
    if (response_language or "").lower().startswith("de"):
        return (
            "Ich halte das Endergebnis hier zurück, da du das für diese Aufgabe "
            "ausdrücklich so gewünscht hast. Sag mir, wenn du bereit für die "
            "Lösung bist oder stattdessen einen Hinweis möchtest."
        )
    return (
        "I'm withholding the final result here, since that's what you asked for "
        "this exercise. Let me know when you'd like the solution, or if a hint "
        "would help instead."
    )


__all__ = [
    "ReleaseValidationResult",
    "safe_withheld_answer_text",
    "scan_generated_answer_for_prohibited_release",
]
