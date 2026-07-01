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
# Strict citation anchor. The ONLY token we treat as a real, verifiable
# citation. `(filename.pdf, p.N)` style references are easy for the model to
# fake (it can guess a plausible course filename + page number) so we no
# longer accept them as standalone evidence — they're display-only.
_SOURCE_TAG_RE = re.compile(r"\[Source\s+\d+\]", re.IGNORECASE)
# Inline `(somefile.pdf, p.7)` style references. Allowed only as display
# text accompanying a real [Source N] tag — see _orphan_filename_refs.
_FILENAME_CITATION_RE = re.compile(
    r"\(([A-Za-z0-9_.\-À-ſ\s]+?\.pdf)\s*,\s*pp?\.\s*\d+",
    re.IGNORECASE,
)
# Window (in characters) around a (filename, p.N) ref in which we look for a
# matching [Source N]. ~120 chars covers the typical "sentence containing
# both" pattern without letting refs anchor to citations a paragraph away.
_FILENAME_REF_NEIGHBOURHOOD = 120
# Numbers we care about: integers and decimals. Allow comma decimals (DE).
# We deliberately ignore numbers inside KaTeX inline math ($...$) to keep
# noise down — they're usually mirroring formulas already checked.
_NUMBER_RE = re.compile(r"(?<![A-Za-z_])(\d{1,4}(?:[.,]\d+)?)(?![A-Za-z])")
_SELF_REPORT_RE = re.compile(
    r"###\s*Confidence\s*\n+\s*(.{0,400})",
    re.IGNORECASE | re.DOTALL,
)

# Section headings that mark a "calculation" zone. Numbers inside these
# sections that follow an `=` / `≈` / `\approx` are treated as DERIVED, not
# Given — they don't need to appear verbatim in a chunk (correct algebra
# shouldn't be flagged as hallucination).
_CALC_SECTION_RE = re.compile(
    r"###\s*(?:Calculation|Substitution|Berechnung|Einsetzen|Rechnung|Lösung|Loesung)\b",
    re.IGNORECASE,
)
_ANY_SECTION_RE = re.compile(r"^###\s+\S", re.MULTILINE)
_DERIVED_NUMBER_PREFIX_RE = re.compile(r"[=≈]|\\approx|\\to|\\Rightarrow|\\Longrightarrow")

# Identifier-like tokens inside a formula: `F`, `tau`, `A_S`, `\sigma`, `R_e`.
# Used for "rearrangement" detection — a formula that isn't a verbatim match
# but shares its variable set with a cited formula in some chunk is treated
# as an algebraic restatement, not a hallucination.
# Variable tokens inside a formula. Matches:
#   * TeX commands: ``\\frac``, ``\\tau``, ``\\sigma``
#   * ASCII identifiers with optional subscript: ``A_S``, ``\\sigma_z``
#   * Raw Greek letters: ``τ``, ``σ``, ``δ`` (engineering PDFs use these
#     directly instead of the TeX form)
# Greek-letter support was added because pdfminer + NFKC normalisation
# converts the math-italic Unicode Greek (U+1D6E2-1D71B) to plain Greek
# (U+0370-03FF), which the previous ASCII-only regex skipped entirely —
# making ``τ = F/A`` look like a formula with no variables.
_FORMULA_VAR_RE = re.compile(
    r"\\[A-Za-z]+"
    r"|[A-Za-zα-ωΑ-Ω][A-Za-zα-ωΑ-Ω0-9]*(?:_\{[^}]+\}|_[A-Za-z0-9])?"
)
# Trivial / wildcard symbols we don't count as meaningful variables.
_TRIVIAL_VARS = frozenset({
    "x", "y", "z", "a", "b", "c", "n", "i", "j", "k", "mm", "cm", "kn",
    "and", "or", "the", "of",
})

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


def _calc_section_spans(text: str) -> list[tuple[int, int]]:
    """Return (start, end) char offsets for every Calculation/Substitution-style
    section. Numbers inside these spans that come AFTER an ``=`` on the same
    line are treated as derived results rather than facts that must be grounded
    in the source."""
    spans: list[tuple[int, int]] = []
    for m in _CALC_SECTION_RE.finditer(text):
        start = m.start()
        nxt = _ANY_SECTION_RE.search(text, m.end())
        end = nxt.start() if nxt else len(text)
        spans.append((start, end))
    return spans


def _pos_in_spans(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(s <= pos < e for s, e in spans)


def _number_is_derived(text: str, number_pos: int) -> bool:
    """True when the number sits after an ``=`` / ``≈`` on its own line —
    the canonical shape of a calculated step (e.g. ``A = 109.96 mm × 5 mm = 549.80 mm²``)."""
    line_start = text.rfind("\n", 0, number_pos) + 1
    prefix = text[line_start:number_pos]
    return bool(_DERIVED_NUMBER_PREFIX_RE.search(prefix))


def _formula_variables(expr: str) -> set[str]:
    """Extract meaningful identifiers from a (Tex-ish) formula expression.

    Accept as math variables:
      * TeX commands (``\\frac``, ``\\sigma``, ``\\cdot``) — always.
      * Single Greek letters (τ, σ, μ, δ, …) — engineering PDFs use the
        raw Unicode forms after NFKC normalisation, not ``\\sigma``.
      * Single UPPERCASE Latin letters (F, A, M) — math convention.
      * Multi-char ASCII identifiers like ``Aers``, ``lK`` — formula
        variables after NFKC collapsed subscripts onto the line.
      * Subscripted identifiers (``A_S``, ``\\sigma_z``).

    Reject:
      * Single lowercase ASCII letters (a, b, c, n, …) — too ambiguous,
        will match prose articles when a formula-shaped line slipped in.
      * Anything in ``_TRIVIAL_VARS`` (unit abbreviations etc.).

    This was previously a "drop everything < 2 chars" filter, which
    accidentally rejected raw Greek letters and forced the
    rearrangement check to fail on the most common pattern in the corpus.
    """
    tokens: set[str] = set()
    for m in _FORMULA_VAR_RE.finditer(expr):
        raw = m.group(0)
        if raw.startswith("\\"):
            # TeX command. Keep without normalisation.
            tokens.add(raw[1:].lower())
            continue
        # Greek letter (single character in α-ω / Α-Ω)?
        if len(raw) == 1 and ("α" <= raw <= "ω" or "Α" <= raw <= "Ω"):
            tokens.add(raw.lower())
            continue
        # Single uppercase ASCII (F, A, M) — keep, but compare in lower.
        if len(raw) == 1 and "A" <= raw <= "Z":
            tokens.add(raw.lower())
            continue
        # Drop single lowercase letters: too ambiguous on prose-laced lines.
        if len(raw) == 1:
            continue
        t = raw.lower()
        if t in _TRIVIAL_VARS:
            continue
        tokens.add(t)
    return tokens


# Review fix #9 — distinguish "linear" vs "advanced" operators.
# Linear arithmetic (·, /, +, -) is the only group that can be freely
# REARRANGED across the equals sign — ``τ = F/A`` and ``F = τ·A`` are
# the same formula, just solved for different variables, and the `/`
# in the first version legitimately becomes a `·` in the second.
# Advanced operators (exponentiation, summation, integration, sqrt) do
# NOT interchange like that — ``F = m·a`` and ``E = m·c²`` share the
# variable {m} but the `^2` in the second formula is structural, not a
# rearrangement.
_OPERATOR_TOKEN_RE = re.compile(
    r"\\frac|\\sum|\\int|\\sqrt|\\pi|\\cdot|\\times|\\div|\\partial|\\nabla|"
    r"\^|/|·|×|÷|±|≤|≥|≈|∑|∫|√|∂"
)

# Advanced operators: changing one of these is a structural change, not
# a rearrangement. Both sides of the check must have the SAME advanced-
# operator set.
_ADVANCED_OPS = frozenset({
    "^",       # exponentiation
    "\\sum",   "∑",
    "\\int",   "∫",
    "\\sqrt",  "√",
    "\\partial", "∂",
    "\\nabla",
})


def _formula_operators(expr: str) -> set[str]:
    """Extract the operator/structural tokens from a formula expression.
    Trivial single-operand operators (`=`) are excluded because every
    formula has one. Visually-equivalent forms (``\\cdot`` and ``·``,
    ``\\frac`` and ``/``) collapse to one token so the rearrangement
    check doesn't double-count them."""
    if not expr:
        return set()
    out: set[str] = set()
    for m in _OPERATOR_TOKEN_RE.finditer(expr):
        tok = m.group(0)
        if tok in ("\\cdot", "·"):
            tok = "·"
        elif tok in ("\\times", "×"):
            tok = "×"
        elif tok in ("\\div", "÷"):
            tok = "÷"
        elif tok in ("\\frac", "/"):
            tok = "/"
        elif tok in ("\\pi",):
            tok = "π"
        elif tok in ("\\sum",):
            tok = "∑"
        elif tok in ("\\int",):
            tok = "∫"
        elif tok in ("\\sqrt",):
            tok = "√"
        elif tok in ("\\partial",):
            tok = "∂"
        out.add(tok)
    return out


def _advanced_ops(ops: set[str]) -> frozenset[str]:
    """The advanced-operator subset of a formula's operator set."""
    return frozenset(ops & _ADVANCED_OPS)


def _formula_is_rearrangement_of_cited(needle: str, haystacks: Iterable[str]) -> bool:
    """A formula that isn't a verbatim match still counts as grounded when
    the SAME variable set AND a similar operator profile appear in a
    formula-shaped line in some chunk.

    e.g. source ``τ = F/A``  → answer ``F = τ·A`` is an allowed restatement
    (same vars {τ,F,A}, both use multiplicative ops).

    Review fix #9 — added an operator-overlap requirement on top of the
    variable check. Variables alone would mark ``F = m·a`` and
    ``E = m·c²`` as rearrangements of each other on shared {m}, since
    `c` is in the trivial-vars set. Adding the operator profile prevents
    this: the citation must share BOTH the variable set AND have
    overlapping operator structure.
    """
    needle_vars = _formula_variables(needle)
    if len(needle_vars) < 2:
        return False
    needle_ops = _formula_operators(needle)
    needle_adv = _advanced_ops(needle_ops)
    for hay in haystacks:
        # Only consider lines/segments that themselves look like formulas
        # (contain `=`). Otherwise random prose with overlapping letters
        # would count as a cited formula.
        for line in re.split(r"[\n\r]+", hay):
            if "=" not in line:
                continue
            hay_vars = _formula_variables(line)
            if not hay_vars:
                continue
            overlap = needle_vars & hay_vars
            if len(overlap) < max(2, len(needle_vars) - 1):
                continue
            # Advanced-operator profile MUST match. Linear operators
            # (·, /, +, -) can freely swap because rearrangement
            # legitimately turns ``F/A`` into ``F·(1/A)`` etc. But
            # advanced operators (^, ∑, ∫, √, ∂) are structural — if
            # the cited formula has none and the candidate has ``^2``,
            # they aren't the same formula.
            hay_adv = _advanced_ops(_formula_operators(line))
            if needle_adv == hay_adv:
                return True
    return False


def _orphan_filename_refs(text: str, valid_source_tag_spans: list[tuple[int, int]]) -> list[str]:
    """Filename refs `(file.pdf, p.N)` that are NOT within `_FILENAME_REF_NEIGHBOURHOOD`
    of any real `[Source N]` tag. The model writes these as plausible-looking
    sources without grounding them in the actual context block."""
    orphans: list[str] = []
    for m in _FILENAME_CITATION_RE.finditer(text):
        ref_start, ref_end = m.start(), m.end()
        near_source_tag = any(
            (s <= ref_end + _FILENAME_REF_NEIGHBOURHOOD)
            and (e >= ref_start - _FILENAME_REF_NEIGHBOURHOOD)
            for s, e in valid_source_tag_spans
        )
        if not near_source_tag:
            fn = (m.group(1) or "").strip().lower()
            if fn and fn not in orphans:
                orphans.append(fn)
    return orphans


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
    allowed_filenames: list[str] | None = None,
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
    # Only `[Source N]` is a real citation. `(filename.pdf, p.N)` written in
    # prose is display-only — easy to fabricate, can't anchor verification by
    # itself.
    source_tag_spans = [(m.start(), m.end()) for m in _SOURCE_TAG_RE.finditer(text)]
    has_citation = bool(source_tag_spans)
    details["hasCitation"] = has_citation
    details["sourceTagCount"] = len(source_tag_spans)
    if chunk_texts and not has_citation:
        reasons.append("no [Source N] citation present in answer")

    # ── filename-citation validation ───────────────────────────────────────
    # Two failure modes for `(file.pdf, p.N)` style refs:
    #   1. fabricated — the filename isn't among the docs the model saw
    #   2. orphan     — the filename IS valid but no [Source N] anchors it
    fabricated_filenames: list[str] = []
    if allowed_filenames is not None:
        allowed_lc = {f.lower() for f in allowed_filenames if f}
        for m in _FILENAME_CITATION_RE.finditer(text):
            fn = (m.group(1) or "").strip().lower()
            if fn and fn not in allowed_lc and fn not in fabricated_filenames:
                fabricated_filenames.append(fn)
    details["fabricatedFilenames"] = fabricated_filenames
    if fabricated_filenames:
        reasons.append(
            f"{len(fabricated_filenames)} citation(s) reference files not in the retrieved context"
        )

    orphan_filenames = _orphan_filename_refs(text, source_tag_spans)
    # Don't double-count: a fabricated filename is already worse than orphan.
    orphan_filenames = [f for f in orphan_filenames if f not in fabricated_filenames]
    details["orphanFilenameRefs"] = orphan_filenames
    if orphan_filenames:
        reasons.append(
            f"{len(orphan_filenames)} filename ref(s) not paired with a [Source N] tag"
        )

    # ── formula grounding ──────────────────────────────────────────────────
    # A `$$...$$` block counts as grounded if EITHER (a) it appears verbatim
    # in a chunk OR (b) it's an algebraic restatement of a cited formula
    # (same variables, also written as an equation). Without (b), every
    # rearrangement ("F = τ·A" from a chunk that has "τ = F/A") would be
    # flagged as a hallucination.
    formulas = [m.group(1).strip() for m in _FORMULA_BLOCK_RE.finditer(text)]
    formula_misses: list[str] = []
    formula_rearrangements: list[str] = []
    for f in formulas:
        if _formula_in_any_chunk(f, chunk_texts):
            continue
        if _formula_is_rearrangement_of_cited(f, chunk_texts):
            formula_rearrangements.append(f[:120])
            continue
        formula_misses.append(f[:120])
    details["formulaCount"]          = len(formulas)
    details["formulaMisses"]         = formula_misses
    details["formulaRearrangements"] = formula_rearrangements
    if formula_misses:
        reasons.append(f"{len(formula_misses)} formula(s) not found in retrieved context")

    # ── number grounding ──────────────────────────────────────────────────
    # Distinguish:
    #   - Given numbers (prose / Given section)  → must appear in chunk or question
    #   - Calculated numbers (in Calculation/Substitution, after `=` or `≈`)
    #                                             → derived; do NOT require grounding
    # Strip out [Source N] / (file, p.N) tokens first so structural indices
    # aren't treated as content numbers.
    cleaned = re.sub(r"\[Source\s+\d+\]", " ", text)
    cleaned = re.sub(r"pp?\.\s*\d+(?:\s*-\s*\d+)?", " ", cleaned, flags=re.IGNORECASE)
    calc_spans = _calc_section_spans(cleaned)
    number_haystacks = list(chunk_texts) + ([question] if question else [])
    number_misses: list[str] = []
    derived_numbers: list[str] = []
    seen_numbers: set[str] = set()
    for m in _NUMBER_RE.finditer(cleaned):
        n = m.group(1)
        if n in seen_numbers:
            continue
        seen_numbers.add(n)
        # Trivial section markers ("1.", "2.") aren't worth checking.
        if n in {"0", "1", "2", "3", "4", "5"} and not chunk_texts:
            continue
        if _number_grounded(n, number_haystacks):
            continue
        # Allow numbers that are computed results: inside a Calculation /
        # Substitution section AND on a line that contains an `=`/`≈` before
        # the number itself.
        if _pos_in_spans(m.start(), calc_spans) and _number_is_derived(cleaned, m.start()):
            derived_numbers.append(n)
            continue
        number_misses.append(n)
    details["numberCount"]      = len(seen_numbers)
    details["numberMisses"]     = number_misses
    details["derivedNumbers"]   = derived_numbers
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

    # Hard-fail conditions — collapse straight to missing_context:
    #   - any fabricated filename citation
    #   - context was supplied but the model didn't anchor with [Source N]
    if fabricated_filenames:
        return VerificationResult(
            status="missing_context",
            reasons=reasons + ["fabricated filename citation"],
            details=details,
        )
    if chunk_texts and not has_citation:
        return VerificationResult(
            status="missing_context",
            reasons=reasons,
            details=details,
        )

    # Soft-fail conditions — partially verified:
    #   - formula not found and not a rearrangement of a cited formula
    #   - ungrounded number that isn't a derived calculation step
    #   - orphan filename ref (valid file, but no nearby [Source N])
    if formula_misses or number_misses or orphan_filenames:
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
