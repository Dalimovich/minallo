"""Deterministic quality helpers for cheatsheet generation.

This module is intentionally conservative: it repairs common OCR/mojibake
artifacts only when the mapping is unambiguous, and rejects formula fragments
that are still visibly corrupted after repair.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class EvidenceNormalizationStats:
    chunks_in: int = 0
    chunks_out: int = 0
    repaired_chunks: int = 0
    dropped_chunks: int = 0
    dropped_formula_lines: int = 0


_MOJIBAKE_REPAIRS = {
    # German text.
    "\u00c3\u00a4": "\u00e4",
    "\u00c3\u00b6": "\u00f6",
    "\u00c3\u00bc": "\u00fc",
    "\u00c3\u201e": "\u00c4",
    "\u00c3\u2013": "\u00d6",
    "\u00c3\u0153": "\u00dc",
    "\u00c3\u0178": "\u00df",
    # Greek symbols commonly used in mechanics.
    "\u00ce\u00bc": "\u03bc",
    "\u00ce\u00b8": "\u03b8",
    "\u00cf\u2020": "\u03c6",
    "\u00cf\u2030": "\u03c9",
    "\u00ce\u00b1": "\u03b1",
    "\u00cf\u0081": "\u03c1",
    "\u00ce\u02dc": "\u0398",
    "\u00ce\u00a3": "\u03a3",
    "\u00ce\u201d": "\u0394",
    # Math operators and punctuation.
    "\u00e2\u02c6\u00ab": "\u222b",
    "\u00e2\u02c6\u2019": "\u2212",
    "\u00e2\u2020\u2019": "\u2192",
    "\u00e2\u2030\u00a4": "\u2264",
    "\u00e2\u2030\u00a5": "\u2265",
    "\u00e2\u2030\u00a0": "\u2260",
    "\u00c2\u00b7": "\u00b7",
    "\u00c2\u00b2": "\u00b2",
    "\u00c2\u00bd": "\u00bd",
    "\u00e2\u2026\u201c": "\u2153",
    # Subscripts from UTF-8 decoded as Windows-1252.
    "\u00e2\u201a\u20ac": "\u2080",
    "\u00e2\u201a\u0081": "\u2081",
    "\u00e2\u201a\u201a": "\u2082",
    "\u00e2\u201a\u0192": "\u2083",
    "\u00e2\u201a\u201e": "\u2084",
    "\u00e2\u201a\u00a5": "\u2085",
    "\u00e2\u201a\u00a6": "\u2086",
    "\u00e2\u201a\u00a7": "\u2087",
    "\u00e2\u201a\u02c6": "\u2088",
    "\u00e2\u201a\u2030": "\u2089",
    # Dotted variables sometimes used in OCR'd German mechanics.
    "\u00c3\u00a1\u00c2\u00b9\u00e2\u201e\u00a2": "\u1e59",
    "\u00c3\u00a1\u00c2\u00b9\u00c2\u00a1": "\u1e61",
}

_LATEX_SYMBOL_REPAIRS = {
    "\u03bc": r"\mu",
    "\u03b8": r"\theta",
    "\u03c6": r"\phi",
    "\u03c9": r"\omega",
    "\u03b1": r"\alpha",
    "\u03c1": r"\rho",
    "\u0398": r"\Theta",
    "\u03a3": r"\Sigma",
    "\u0394": r"\Delta",
    "\u222b": r"\int",
    "\u2212": "-",
    "\u2192": r"\to",
    "\u2264": r"\le",
    "\u2265": r"\ge",
    "\u2260": r"\ne",
    "\u00b7": r"\cdot",
    "\u00bd": r"\frac{1}{2}",
    "\u2153": r"\frac{1}{3}",
    "\u00b2": "^2",
    "\u2080": "_0",
    "\u2081": "_1",
    "\u2082": "_2",
    "\u2083": "_3",
    "\u2084": "_4",
    "\u2085": "_5",
    "\u2086": "_6",
    "\u2087": "_7",
    "\u2088": "_8",
    "\u2089": "_9",
}

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_FAKE_CITATION_RE = re.compile(r"\(?\s*filename\s*,\s*p\.?\s*N\s*\)?", re.I)
_UNIT_CORRUPTION_RE = re.compile(r"\b1\s*ext\s*J\s*=\s*1\s*ext\s*Nm\b", re.I)
_MOJIBAKE_LEFT_RE = re.compile(r"[\u00c2\u00c3\u00ce\u00cf]\S|[\u00e2][\u0080-\u203a]")
_OBVIOUS_GARBAGE_RE = re.compile(
    # NB: match EMPTY braces ``{}`` only — ``[{}]\s*[{}]`` also matched ``}{``,
    # which is normal LaTeX (``\frac{1}{2}``) and dropped every valid fraction.
    r"(\bext[A-Za-z]|\b[A-Za-z]?xto\b|\{\s*\}|_{3,}|\.{4,}|[^\s]{45,})"
)
_FORMULAISH_RE = re.compile(
    r"(=|\\frac|\\int|\\sum|[+\-*/^_]|[\u222b\u03bc\u03b8\u03c6\u03c9\u03b1\u03c1\u0398\u03a3])"
)
# ``\\`` glued to a command letter (``\\dot``, ``\\mathbf``) is a doubled-escape
# artifact \u2014 a real LaTeX line break ``\\`` is only ever followed by whitespace,
# ``[``, or end-of-line, never a letter.
_DOUBLED_BACKSLASH_CMD_RE = re.compile(r"\\\\(?=[A-Za-z])")
# Models often wrap a standard math operator in ``\text{}``/``\mathrm{}`` (e.g.
# ``\text{cos}\beta``), which loses the operator spacing KaTeX gives ``\cos``.
# Rewrite the known operators to their proper command.
_MATH_OPERATORS = (
    "sin", "cos", "tan", "cot", "sec", "csc",
    "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan",
    "log", "ln", "exp", "lim", "min", "max", "det", "dim", "arg", "gcd",
)
_TEXT_OPERATOR_RE = re.compile(
    r"\\(?:text|mathrm|mathop|operatorname)\s*\{\s*(" + "|".join(_MATH_OPERATORS) + r")\s*\}"
)
# An accent command glued straight to its argument letter (``\vecg``, ``\dotr``)
# is undefined in KaTeX and renders as the raw letters ("vecg"). ``\vec g`` /
# ``\vec{g}`` are correct, so only the glued-to-a-letter case needs a space.
_GLUED_ACCENT_RE = re.compile(
    r"\\(vec|dot|ddot|hat|bar|tilde|acute|grave|check|breve)(?=[A-Za-z])"
)
# A run of 4+ single letters separated by spaces (``h e t a``) is OCR that split a
# word/symbol glyph-by-glyph — unsalvageable, so the formula is dropped.
_SPACED_LETTERS_RE = re.compile(r"(?:\b[A-Za-z]\b[ \t]+){4,}")
# KaTeX does not support align*/equation/eqnarray/gather; map them to the
# supported aligned/gathered so a model that wraps a formula in one still renders.
_LATEX_ENV_RE = re.compile(r"\\(begin|end)\{(align\*?|alignat\*?|eqnarray\*?|equation\*?|gather\*?)\}")


def _fix_latex_env(m: "re.Match[str]") -> str:
    env = m.group(2)
    repl = "gathered" if env.startswith("gather") else "aligned"
    return f"\\{m.group(1)}{{{repl}}}"


def repair_mojibake(text: str) -> str:
    """Repair common mojibake without guessing from context."""
    out = unicodedata.normalize("NFC", text or "")
    for bad, good in _MOJIBAKE_REPAIRS.items():
        out = out.replace(bad, good)
    out = _UNIT_CORRUPTION_RE.sub("1 J = 1 N\u00b7m", out)
    out = out.replace("\ufffd", "")
    out = _CTRL_RE.sub("", out)
    return out


def formula_to_latexish(text: str) -> str:
    """Convert safe Unicode math symbols to compact LaTeX-ish notation."""
    out = repair_mojibake(text)
    for sym, latex in _LATEX_SYMBOL_REPAIRS.items():
        out = out.replace(sym, latex)
    out = _DOUBLED_BACKSLASH_CMD_RE.sub(r"\\", out)
    out = _TEXT_OPERATOR_RE.sub(r"\\\1", out)
    out = _GLUED_ACCENT_RE.sub(r"\\\1 ", out)
    out = _LATEX_ENV_RE.sub(_fix_latex_env, out)
    # A trailing lone backslash (a dangling row break ``\\`` or a stray ``\``) left
    # at the very end of a body becomes ``\$`` once wrapped — an escaped dollar that
    # breaks KaTeX delimiter pairing. Drop it. (``\,`` etc. are safe: a command
    # letter/punct follows the backslash, so the trailing-only match never fires.)
    out = re.sub(r"\s*\\+\s*$", "", out)
    return out


def formula_corruption_reasons(text: str) -> list[str]:
    """Return deterministic reasons a formula/text fragment is unsafe."""
    raw = text or ""
    repaired = repair_mojibake(raw)
    reasons: list[str] = []
    if _CTRL_RE.search(raw) or "\ufffd" in raw:
        reasons.append("control-or-replacement-character")
    if _FAKE_CITATION_RE.search(repaired):
        reasons.append("fake-citation-placeholder")
    if _MOJIBAKE_LEFT_RE.search(repaired):
        reasons.append("unresolved-mojibake")
    if _OBVIOUS_GARBAGE_RE.search(repaired):
        reasons.append("ocr-garbage")
    if _SPACED_LETTERS_RE.search(repaired):
        reasons.append("spaced-letter-ocr")
    if repaired.count("{") != repaired.count("}"):
        reasons.append("unbalanced-braces")
    if repaired.count("$$") % 2 == 1:
        reasons.append("unbalanced-display-math")
    if "\n" in repaired:
        lines = [ln.strip() for ln in repaired.splitlines() if ln.strip()]
        if len(lines) >= 5 and sum(1 for ln in lines if len(ln) <= 2) / len(lines) > 0.45:
            reasons.append("stacked-fragment")
    return reasons


def is_unreadable_formula(text: str) -> bool:
    repaired = repair_mojibake(text)
    if not repaired.strip():
        return True
    if formula_corruption_reasons(repaired):
        return True
    return False


def normalize_formula_text(text: str) -> str | None:
    """Return clean LaTeX-ish formula text, or None if unsafe."""
    repaired = formula_to_latexish(text).strip()
    if not repaired or is_unreadable_formula(repaired):
        return None
    return repaired


def normalize_evidence_text(text: str) -> tuple[str, int]:
    """Repair a retrieved chunk and remove formula-like lines still corrupted."""
    repaired = repair_mojibake(text)
    dropped = 0
    lines: list[str] = []
    for line in repaired.splitlines():
        stripped = line.strip()
        if stripped and _FORMULAISH_RE.search(stripped) and formula_corruption_reasons(stripped):
            dropped += 1
            continue
        lines.append(line)
    cleaned = "\n".join(lines).strip()
    return cleaned, dropped


def normalize_evidence_chunks(chunks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], EvidenceNormalizationStats]:
    """Clean retrieved evidence before prompt construction."""
    out: list[dict[str, Any]] = []
    repaired_chunks = 0
    dropped_chunks = 0
    dropped_formula_lines = 0
    for chunk in chunks or []:
        text = chunk.get("text") or ""
        cleaned, dropped_lines = normalize_evidence_text(text)
        dropped_formula_lines += dropped_lines
        if not cleaned:
            dropped_chunks += 1
            continue
        next_chunk = dict(chunk)
        next_chunk["text"] = cleaned
        if cleaned != text:
            repaired_chunks += 1
        out.append(next_chunk)
    return out, EvidenceNormalizationStats(
        chunks_in=len(chunks or []),
        chunks_out=len(out),
        repaired_chunks=repaired_chunks,
        dropped_chunks=dropped_chunks,
        dropped_formula_lines=dropped_formula_lines,
    )
