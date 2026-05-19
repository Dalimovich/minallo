"""Phase 10 — deterministic verification of generated answers.

Independent of the model's self-reported confidence. Cross-checks the
answer text against the retrieved chunks (and the user's question) and
returns a structured ``VerificationResult``:

  status   : "verified" | "partially_verified" | "missing_context"
  reasons  : list of plain-English explanations for the chosen status
  details  : machine-readable breakdown the frontend / debug log can show

Checks (cheap, no LLM, no DB):

  1. **Citation present** — when chunks were used, the answer must include
     at least one ``[Source N]`` or ``(filename, p.N)`` reference.
  2. **Formula grounding** — every ``$$ ... $$`` block in the answer must
     appear (token-similar) in some chunk.
  3. **Number grounding** — every standalone numeric token in the answer
     must appear in some chunk OR in the user's question. Tolerant of
     unit suffixes (``200 N``, ``0.5 m``).
  4. **Self-report parse** — if the model wrote ``Missing context`` or
     ``Partially verified`` in its final section, we honour it as a
     floor (the deterministic checks can only downgrade, never upgrade).

Failures collapse to the lowest applicable status. Anything we can't
check (e.g. model produced no chunks at all) collapses to
``missing_context``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable


# ── public surface ───────────────────────────────────────────────────────────


VERIFICATION_STATUSES = ("verified", "partially_verified", "missing_context")


@dataclass
class VerificationResult:
    status: str                                   # see VERIFICATION_STATUSES
    reasons: list[str] = field(default_factory=list)
    details: dict[str, object] = field(default_factory=dict)

    def to_api(self) -> dict[str, object]:
        return {
            "status":  self.status,
            "reasons": self.reasons,
            "details": self.details,
        }


# ── patterns ────────────────────────────────────────────────────────────────

_FORMULA_BLOCK_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_CITATION_RE = re.compile(
    r"\[Source\s+\d+\]|\(([^)]+\.pdf)\s*,\s*p?p?\.\s*\d+",
    re.IGNORECASE,
)
# Numbers we care about: integers and decimals. Allow comma decimals (DE).
# We deliberately ignore numbers inside KaTeX inline math ($...$) to keep
# noise down — they're usually mirroring formulas already checked.
_NUMBER_RE = re.compile(r"(?<![A-Za-z_])(\d{1,4}(?:[.,]\d+)?)(?![A-Za-z])")
_SELF_REPORT_RE = re.compile(
    r"###\s*Confidence\s*\n+\s*(.{0,400})",
    re.IGNORECASE | re.DOTALL,
)

# Tokens we strip when comparing formula expressions so trivial whitespace
# / formatting differences don't flag a real match as missing.
_NORMALIZE_FORMULA_RE = re.compile(r"\s+|\\,|\\;|\\!|\\quad|\\qquad")


def _normalize_formula(s: str) -> str:
    return _NORMALIZE_FORMULA_RE.sub("", s).lower()


def _formula_in_any_chunk(needle: str, haystacks: Iterable[str]) -> bool:
    n = _normalize_formula(needle)
    if len(n) < 3:
        # Trivial expressions ("x", "= 0") can't be meaningfully cross-checked.
        return True
    for hay in haystacks:
        if n in _normalize_formula(hay):
            return True
    return False


def _number_grounded(number: str, haystacks: Iterable[str]) -> bool:
    # Compare both 0.5 and 0,5 forms; chunks may use either.
    forms = {number, number.replace(",", "."), number.replace(".", ",")}
    for hay in haystacks:
        if any(f in hay for f in forms):
            return True
    return False


def _parse_self_report(answer_text: str) -> str | None:
    """Return one of the verification statuses if the model self-tagged
    its answer, else None."""
    m = _SELF_REPORT_RE.search(answer_text)
    body = (m.group(1) if m else answer_text).lower()
    if "missing context" in body:
        return "missing_context"
    if "partially verified" in body or "partially_verified" in body:
        return "partially_verified"
    if "verified" in body:
        return "verified"
    return None


# ── verify ──────────────────────────────────────────────────────────────────


def verify_answer(
    *,
    answer_text: str,
    chunk_texts: list[str],
    question: str = "",
    answer_mode: str | None = None,
) -> VerificationResult:
    """Run the deterministic checks. ``chunk_texts`` is the same set of
    chunks the model actually saw (its [Source N] block)."""
    reasons: list[str] = []
    details: dict[str, object] = {}

    text = (answer_text or "").strip()
    if not text:
        return VerificationResult(
            status="missing_context",
            reasons=["empty answer"],
            details={"emptyAnswer": True},
        )

    # ── citation check ──────────────────────────────────────────────────────
    has_citation = bool(_CITATION_RE.search(text))
    details["hasCitation"] = has_citation
    if chunk_texts and not has_citation:
        reasons.append("no citation present in answer")

    # ── formula grounding ──────────────────────────────────────────────────
    formulas = [m.group(1).strip() for m in _FORMULA_BLOCK_RE.finditer(text)]
    formula_misses: list[str] = []
    for f in formulas:
        if not _formula_in_any_chunk(f, chunk_texts):
            formula_misses.append(f[:120])
    details["formulaCount"]     = len(formulas)
    details["formulaMisses"]    = formula_misses
    if formula_misses:
        reasons.append(f"{len(formula_misses)} formula(s) not found in retrieved context")

    # ── number grounding ──────────────────────────────────────────────────
    # Strip out [Source N] / (file, p.N) tokens before extracting numbers —
    # those indices are structural, not content, and shouldn't be checked
    # against chunks.
    text_for_numbers = re.sub(r"\[Source\s+\d+\]", "", text)
    text_for_numbers = re.sub(r"p\.\s*\d+", "", text_for_numbers, flags=re.IGNORECASE)
    text_for_numbers = re.sub(r"pp\.\s*\d+\s*-\s*\d+", "", text_for_numbers, flags=re.IGNORECASE)
    answer_numbers = {m.group(1) for m in _NUMBER_RE.finditer(text_for_numbers)}
    number_haystacks = list(chunk_texts) + ([question] if question else [])
    number_misses: list[str] = []
    for n in sorted(answer_numbers):
        # Skip trivial markers — "1.", "2.", chapter/source indices.
        if n in {"0", "1", "2", "3", "4", "5"} and not chunk_texts:
            continue
        if not _number_grounded(n, number_haystacks):
            number_misses.append(n)
    details["numberCount"]      = len(answer_numbers)
    details["numberMisses"]     = number_misses
    if number_misses:
        reasons.append(f"{len(number_misses)} number(s) not found in context or question")

    # ── derive status ──────────────────────────────────────────────────────
    self_report = _parse_self_report(text)
    details["selfReport"]       = self_report

    if not chunk_texts:
        # No context was supplied to the model — can't be more than "missing".
        return VerificationResult(
            status="missing_context",
            reasons=reasons or ["no retrieved context"],
            details=details,
        )

    # Deterministic floor: any miss bumps us to at least partially_verified.
    if formula_misses or number_misses or (chunk_texts and not has_citation):
        det_status = "partially_verified"
    else:
        det_status = "verified"

    # Self-report can only downgrade further (model knows something we don't).
    if self_report == "missing_context":
        return VerificationResult(
            status="missing_context",
            reasons=reasons + ["model self-reported missing context"],
            details=details,
        )
    if self_report == "partially_verified" and det_status == "verified":
        return VerificationResult(
            status="partially_verified",
            reasons=reasons + ["model self-reported partial verification"],
            details=details,
        )

    return VerificationResult(status=det_status, reasons=reasons, details=details)


__all__ = ("VERIFICATION_STATUSES", "VerificationResult", "verify_answer")
