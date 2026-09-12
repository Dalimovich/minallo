"""Deterministic validation of copied numerical givens.

This intentionally does not attempt arbitrary symbolic mathematics.  It
protects the highest-risk boundary first: values the answer claims were given
must preserve the source's value, sign, exponent, symbol and unit.
"""

from __future__ import annotations

import ast
import math
import operator
import re
from dataclasses import asdict, dataclass, field
from typing import Literal


ValidationAction = Literal["accept", "recalculate", "regenerate", "ask_user_to_confirm"]

_ASSIGNMENT_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?P<symbol>[A-Za-z][A-Za-z0-9]*(?:_\{?[A-Za-z0-9]+\}?)?)"
    r"\s*=\s*"
    r"(?P<value>[+\-−]?\s*(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d+)?"
    r"(?:\s*(?:[x×·]\s*10\s*(?:\^|\*\*)?\s*[+\-−]?\s*\d+|[eE][+\-]?\d+))?)"
    r"\s*(?P<unit>(?:mm/s|m/min|m/s|min(?:\^-?1|⁻¹)|"
    r"mm|cm|km|kN|MPa|GPa|kPa|Pa|rpm|min|m|s|h|N|%)(?:\^?[23]|[²³])?)?",
    re.IGNORECASE,
)
_SUPERSCRIPT = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻", "0123456789+-")
_SAFE_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_SAFE_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_UNIT_SCALES: dict[str, tuple[str, float]] = {
    "mm": ("length", 1e-3),
    "cm": ("length", 1e-2),
    "m": ("length", 1.0),
    "s": ("time", 1.0),
    "min": ("time", 60.0),
    "h": ("time", 3600.0),
    "w": ("power", 1.0),
    "kw": ("power", 1e3),
    "pa": ("pressure", 1.0),
    "kpa": ("pressure", 1e3),
    "mpa": ("pressure", 1e6),
    "gpa": ("pressure", 1e9),
}


@dataclass(frozen=True)
class GivenValue:
    id: str
    symbol: str
    original: str
    normalized_numeric_value: float
    normalized_unit: str | None
    source_index: int
    confidence: float = 1.0


@dataclass(frozen=True)
class NumericalClaim:
    symbol: str
    original: str
    normalized_numeric_value: float
    normalized_unit: str | None
    supported: bool
    reason: str | None = None


@dataclass
class NumericalValidationResult:
    valid: bool
    extracted_givens: list[GivenValue] = field(default_factory=list)
    unsupported_numbers: list[NumericalClaim] = field(default_factory=list)
    mismatched_givens: list[NumericalClaim] = field(default_factory=list)
    invalid_conversions: list[str] = field(default_factory=list)
    arithmetic_errors: list[str] = field(default_factory=list)
    unit_errors: list[str] = field(default_factory=list)
    low_confidence_values: list[GivenValue] = field(default_factory=list)
    source_conflicts: list[str] = field(default_factory=list)
    action: ValidationAction = "accept"

    def to_api(self) -> dict:
        return asdict(self)


def _normalise_unit(unit: str | None) -> str | None:
    if not unit:
        return None
    return unit.replace(" ", "").replace("−", "-").casefold()


def _valid_unit_conversion(
    source_value: float,
    source_unit: str | None,
    target_value: float,
    target_unit: str | None,
) -> bool:
    if not source_unit or not target_unit:
        return False
    source = _UNIT_SCALES.get(source_unit)
    target = _UNIT_SCALES.get(target_unit)
    if not source or not target or source[0] != target[0]:
        return False
    expected = source_value * source[1] / target[1]
    return math.isclose(expected, target_value, rel_tol=1e-9, abs_tol=1e-12)


def _is_explicit_conversion(text: str, start: int) -> bool:
    line_start = (text or "").rfind("\n", 0, start) + 1
    line_end = (text or "").find("\n", start)
    if line_end < 0:
        line_end = len(text or "")
    line = (text or "")[line_start:line_end]
    nearby = (text or "")[max(0, start - 100):start]
    return bool(
        re.search(r"\b(conversion|convert|converted|umrechnung|umrechnen)\b", nearby, re.IGNORECASE)
        or re.search(r"(?:→|->|/ ?1000|\* ?1000|× ?1000)", line)
    )


def parse_locale_number(raw: str, *, locale_hint: str | None = None) -> float:
    value = (raw or "").strip().replace("−", "-").replace(" ", "")
    sci_match = re.fullmatch(
        r"([+\-]?(?:\d+(?:[.,]\d+)?))[x×·]10(?:\^|\*\*)?([+\-]?\d+)",
        value,
        re.IGNORECASE,
    )
    if sci_match:
        return parse_locale_number(sci_match.group(1), locale_hint=locale_hint) * (
            10 ** int(sci_match.group(2))
        )
    if re.search(r"[eE][+\-]?\d+$", value):
        mantissa, exponent = re.split(r"[eE]", value, maxsplit=1)
        return parse_locale_number(mantissa, locale_hint=locale_hint) * (10 ** int(exponent))
    if "," in value and "." in value:
        if value.rfind(",") > value.rfind("."):
            value = value.replace(".", "").replace(",", ".")
        else:
            value = value.replace(",", "")
    elif "," in value:
        groups = value.lstrip("+-").split(",")
        if locale_hint == "en" and len(groups[-1]) == 3:
            value = value.replace(",", "")
        else:
            value = value.replace(",", ".")
    elif "." in value and locale_hint == "de":
        groups = value.lstrip("+-").split(".")
        if len(groups) > 1 and all(len(g) == 3 for g in groups[1:]):
            value = value.replace(".", "")
    return float(value)


def _assignments(text: str, *, locale_hint: str | None = None):
    for match in _ASSIGNMENT_RE.finditer(text or ""):
        line_start = (text or "").rfind("\n", 0, match.start()) + 1
        # In an equation chain such as ``M = F·l = 200·0.5``, ``l = 200``
        # is a regex artefact, not a copied given. Only the first assignment
        # on a line is eligible for source-given comparison.
        if "=" in (text or "")[line_start:match.start()]:
            continue
        raw_value = match.group("value").translate(_SUPERSCRIPT)
        try:
            numeric = parse_locale_number(raw_value, locale_hint=locale_hint)
        except (TypeError, ValueError, OverflowError):
            continue
        yield match, numeric, _normalise_unit(match.group("unit"))


def extract_givens(
    source_texts: list[str],
    *,
    locale_hint: str | None = None,
) -> list[GivenValue]:
    # Earlier sources have higher priority; Source 0 (exact visible question)
    # must beat a similar worked example later in the evidence package.
    by_symbol: dict[str, GivenValue] = {}
    for source_index, text in enumerate(source_texts):
        for match, numeric, unit in _assignments(text, locale_hint=locale_hint):
            symbol = match.group("symbol").casefold()
            if symbol in by_symbol:
                continue
            by_symbol[symbol] = GivenValue(
                id=f"source-{source_index}:{symbol}",
                symbol=match.group("symbol"),
                original=match.group(0),
                normalized_numeric_value=numeric,
                normalized_unit=unit,
                source_index=source_index,
            )
    return list(by_symbol.values())


def detect_source_conflicts(
    source_texts: list[str],
    *,
    locale_hint: str | None = None,
) -> list[str]:
    """Report later-source values that conflict with the active Source 0."""
    if len(source_texts) < 2:
        return []
    primary = {
        match.group("symbol").casefold(): (numeric, unit, match.group(0))
        for match, numeric, unit in _assignments(source_texts[0], locale_hint=locale_hint)
    }
    conflicts: list[str] = []
    for source_index, text in enumerate(source_texts[1:], start=1):
        for match, numeric, unit in _assignments(text, locale_hint=locale_hint):
            first = primary.get(match.group("symbol").casefold())
            if not first:
                continue
            primary_value, primary_unit, primary_raw = first
            if (
                not math.isclose(primary_value, numeric, rel_tol=1e-9, abs_tol=1e-12)
                or (primary_unit and unit and primary_unit != unit)
            ):
                conflicts.append(
                    f"{match.group('symbol')}: Source 0 has {primary_raw}; "
                    f"Source {source_index} has {match.group(0)}"
                )
    return list(dict.fromkeys(conflicts))


def _safe_eval_numeric(expression: str) -> float:
    node = ast.parse(expression, mode="eval")

    def visit(item: ast.AST) -> float:
        if isinstance(item, ast.Expression):
            return visit(item.body)
        if isinstance(item, ast.Constant) and isinstance(item.value, (int, float)):
            return float(item.value)
        if isinstance(item, ast.BinOp) and type(item.op) in _SAFE_BINOPS:
            return _SAFE_BINOPS[type(item.op)](visit(item.left), visit(item.right))
        if isinstance(item, ast.UnaryOp) and type(item.op) in _SAFE_UNARY:
            return _SAFE_UNARY[type(item.op)](visit(item.operand))
        raise ValueError("unsupported arithmetic expression")

    value = visit(node)
    if not math.isfinite(value):
        raise ValueError("non-finite arithmetic result")
    return value


def _safe_eval_expression(expression: str, variables: dict[str, float]) -> float:
    node = ast.parse(expression.replace("^", "**"), mode="eval")

    def visit(item: ast.AST) -> float:
        if isinstance(item, ast.Expression):
            return visit(item.body)
        if isinstance(item, ast.Constant) and isinstance(item.value, (int, float)):
            return float(item.value)
        if isinstance(item, ast.Name) and item.id in variables:
            return float(variables[item.id])
        if isinstance(item, ast.BinOp) and type(item.op) in _SAFE_BINOPS:
            return _SAFE_BINOPS[type(item.op)](visit(item.left), visit(item.right))
        if isinstance(item, ast.UnaryOp) and type(item.op) in _SAFE_UNARY:
            return _SAFE_UNARY[type(item.op)](visit(item.operand))
        raise ValueError("unsupported symbolic expression")

    value = visit(node)
    if not math.isfinite(value):
        raise ValueError("non-finite symbolic result")
    return value


def restricted_expressions_equivalent(left: str, right: str) -> bool:
    """Compare allowlisted arithmetic expressions by deterministic sampling."""
    parsed = ast.parse(left.replace("^", "**"), mode="eval")
    parsed_right = ast.parse(right.replace("^", "**"), mode="eval")
    allowed_nodes = (
        ast.Expression, ast.Constant, ast.Name, ast.BinOp, ast.UnaryOp,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.UAdd, ast.USub,
        ast.Load,
    )
    if any(not isinstance(node, allowed_nodes) for node in ast.walk(parsed)):
        raise ValueError("unsupported symbolic expression")
    if any(not isinstance(node, allowed_nodes) for node in ast.walk(parsed_right)):
        raise ValueError("unsupported symbolic expression")
    names = sorted({
        node.id for tree in (parsed, parsed_right)
        for node in ast.walk(tree) if isinstance(node, ast.Name)
    })
    for seed in (1.25, 2.0, 3.5, 7.0):
        values = {name: seed + index * 0.75 for index, name in enumerate(names)}
        try:
            a = _safe_eval_expression(left, values)
            b = _safe_eval_expression(right, values)
        except ZeroDivisionError:
            continue
        if not math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-10):
            return False
    return True


def round_for_constraint(value: float, *, digits: int = 0, constraint: str = "nearest") -> float:
    factor = 10 ** digits
    if constraint == "maximum":
        return math.floor(value * factor) / factor
    if constraint == "minimum":
        return math.ceil(value * factor) / factor
    if constraint != "nearest":
        raise ValueError("constraint must be nearest, maximum, or minimum")
    return round(value, digits)


def units_compatible(left: str, right: str) -> bool:
    a = _UNIT_SCALES.get(_normalise_unit(left) or "")
    b = _UNIT_SCALES.get(_normalise_unit(right) or "")
    return bool(a and b and a[0] == b[0])


def validate_arithmetic_steps(answer_text: str) -> list[str]:
    """Check numeric-only ``expression = result`` steps in generated work."""
    errors: list[str] = []
    normalized = (
        (answer_text or "")
        .replace("\\cdot", "*")
        .replace("\\times", "*")
        .replace("×", "*")
        .replace("·", "*")
        .replace("\\div", "/")
        .replace("÷", "/")
        .replace("^", "**")
        .replace(",", ".")
    )
    for line in normalized.splitlines():
        segments = [part.strip(" $") for part in line.split("=")]
        if len(segments) < 2:
            continue
        for expression, result_segment in zip(segments, segments[1:]):
            expression = re.sub(r"\\(?:left|right)", "", expression)
            expression = expression.replace("{", "(").replace("}", ")")
            expression = re.sub(r"\s+", "", expression)
            if not expression or not re.fullmatch(r"[0-9+\-*/().]+", expression):
                continue
            result_match = re.match(r"\s*([+\-]?\d+(?:\.\d+)?)", result_segment)
            if not result_match:
                continue
            try:
                expected = _safe_eval_numeric(expression)
                actual = float(result_match.group(1))
            except (ValueError, ZeroDivisionError, OverflowError, SyntaxError):
                continue
            if not math.isclose(expected, actual, rel_tol=1e-6, abs_tol=1e-9):
                errors.append(
                    f"{expression} evaluates to {expected:g}, not {actual:g}"
                )
    return errors


def validate_numerical_claims(
    *,
    answer_text: str,
    source_texts: list[str],
    locale_hint: str | None = None,
) -> NumericalValidationResult:
    givens = extract_givens(source_texts, locale_hint=locale_hint)
    source_by_symbol = {g.symbol.casefold(): g for g in givens}
    mismatches: list[NumericalClaim] = []
    unit_errors: list[str] = []
    arithmetic_errors = validate_arithmetic_steps(answer_text)
    source_conflicts = detect_source_conflicts(source_texts, locale_hint=locale_hint)

    for match, numeric, unit in _assignments(answer_text, locale_hint=locale_hint):
        symbol = match.group("symbol")
        source = source_by_symbol.get(symbol.casefold())
        if not source:
            continue
        value_matches = math.isclose(
            numeric,
            source.normalized_numeric_value,
            rel_tol=1e-9,
            abs_tol=1e-12,
        )
        unit_matches = not source.normalized_unit or unit == source.normalized_unit
        if value_matches and unit_matches:
            continue
        if (
            _is_explicit_conversion(answer_text, match.start())
            and _valid_unit_conversion(
                source.normalized_numeric_value,
                source.normalized_unit,
                numeric,
                unit,
            )
        ):
            continue
        reason_parts: list[str] = []
        if not value_matches:
            reason_parts.append(
                f"value differs from {source.original}"
            )
        if not unit_matches:
            reason_parts.append(
                f"unit {unit or '(missing)'} differs from {source.normalized_unit}"
            )
            unit_errors.append(f"{symbol}: " + reason_parts[-1])
        mismatches.append(NumericalClaim(
            symbol=symbol,
            original=match.group(0),
            normalized_numeric_value=numeric,
            normalized_unit=unit,
            supported=False,
            reason="; ".join(reason_parts),
        ))

    valid = not mismatches and not arithmetic_errors
    return NumericalValidationResult(
        valid=valid,
        extracted_givens=givens,
        mismatched_givens=mismatches,
        arithmetic_errors=arithmetic_errors,
        unit_errors=unit_errors,
        source_conflicts=source_conflicts,
        action="accept" if valid else "regenerate",
    )
