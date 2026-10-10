"""OCR transcription quality eval.

Grades `vision_ocr.pages_via_vision` against hand-typed ground truth in
`tests/fixtures/ocr_eval/`. Makes real OpenAI calls — gated behind
``MINALLO_RUN_OCR_EVAL=1`` so it does not run in default `pytest`.

See tests/fixtures/ocr_eval/README.md for how to add cases and run.
"""

from __future__ import annotations

import json
import os
import re
from difflib import SequenceMatcher
from pathlib import Path

import pytest

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "ocr_eval"
_CASES_JSON = _FIXTURE_DIR / "cases.json"

_GATE_ENV = "MINALLO_RUN_OCR_EVAL"


def _gated_skip() -> None:
    if os.environ.get(_GATE_ENV) != "1":
        pytest.skip(
            f"OCR eval is gated — set {_GATE_ENV}=1 to run (makes real API calls)",
            allow_module_level=False,
        )
    if not os.environ.get("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY not set", allow_module_level=False)


def _load_cases() -> list[dict]:
    if not _CASES_JSON.exists():
        return []
    with _CASES_JSON.open(encoding="utf-8") as f:
        return json.load(f).get("cases", [])


_CASES = _load_cases()


_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text.strip().lower())


# Match $$...$$ display math first, then leftover $...$ inline math.
# The eval treats both the same — what matters is whether the formula
# content was captured, not the delimiter style. (Downstream chunking
# can normalise inline → display if needed.)
_DISPLAY_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_INLINE_RE = re.compile(r"\$([^$\n]+?)\$")
_TEXT_MACRO_RE = re.compile(r"\\(?:text|mathrm|mathit|mathbf|operatorname)\{([^}]*)\}")
_FORCED_SPACE_RE = re.compile(r"\\[,;: ]")
_SINGLE_CHAR_GROUP_RE = re.compile(r"([_^])\{([A-Za-z0-9])\}")
_PUNCT_GROUP_RE = re.compile(r"\{([,.])\}")


def _normalize_formula(latex: str) -> str:
    """Normalize a LaTeX block for semantic comparison.

    Strips cosmetic differences that render identically:
      * `\\text{X}` / `\\mathrm{X}` / `\\mathit{X}` / `\\mathbf{X}` /
        `\\operatorname{X}` → `X`
      * `\\,` `\\;` `\\:` `\\ ` (forced spaces) → single space
      * `_{X}` / `^{X}` with a single-char arg → `_X` / `^X`
      * `{,}` / `{.}` (German decimal-comma idiom) → `,` / `.`
      * collapses ASCII whitespace and lowercases.
    """
    latex = _TEXT_MACRO_RE.sub(r"\1", latex)
    latex = _FORCED_SPACE_RE.sub(" ", latex)
    latex = _SINGLE_CHAR_GROUP_RE.sub(r"\1\2", latex)
    latex = _PUNCT_GROUP_RE.sub(r"\1", latex)
    return _normalize(latex)


_BLOCK_SPLIT_RE = re.compile(r"\\quad\b|\\qquad\b|\\\\")


def _split_merged(latex: str) -> list[str]:
    """Split a block that contains multiple formulas joined by `\\quad`,
    `\\qquad`, or `\\\\` (newline in math mode). The OCR occasionally emits
    `A \\quad B` for what was visually two adjacent rows."""
    parts = [p.strip() for p in _BLOCK_SPLIT_RE.split(latex)]
    return [p for p in parts if p]


def _formula_blocks(md: str) -> list[str]:
    blocks: list[str] = []
    # Pull display math first and remove from the haystack so the inline
    # pass doesn't double-count the inner $ pairs.
    for m in _DISPLAY_RE.finditer(md):
        for part in _split_merged(m.group(1)):
            blocks.append(_normalize_formula(part))
    leftover = _DISPLAY_RE.sub(" ", md)
    for m in _INLINE_RE.finditer(leftover):
        content = m.group(1).strip()
        if not content:
            continue
        for part in _split_merged(content):
            blocks.append(_normalize_formula(part))
    return blocks


def _char_similarity(expected: str, actual: str) -> float:
    return SequenceMatcher(None, _normalize(expected), _normalize(actual)).ratio()


def _formula_recall(expected: str, actual: str) -> tuple[float, int, int, list[str], list[str]]:
    exp_blocks = _formula_blocks(expected)
    if not exp_blocks:
        return 1.0, 0, 0, [], []
    act_blocks = _formula_blocks(actual)
    matched = [b for b in exp_blocks if b in act_blocks]
    missed = [b for b in exp_blocks if b not in act_blocks]
    return len(matched) / len(exp_blocks), len(matched), len(exp_blocks), missed, act_blocks


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_ocr_case(case: dict, capsys: pytest.CaptureFixture[str]) -> None:
    _gated_skip()

    pdf_path = _FIXTURE_DIR / case["pdf"]
    expected_path = _FIXTURE_DIR / f"{case['id']}.expected.md"
    if not pdf_path.exists():
        pytest.skip(f"local PDF missing: {pdf_path.name} (gitignored — see README)")
    assert expected_path.exists(), f"missing ground truth: {expected_path}"

    from app.services.vision_ocr import pages_via_vision

    pdf_bytes = pdf_path.read_bytes()
    page_index = int(case["page_index"])
    provider = os.environ.get("MINALLO_OCR_EVAL_PROVIDER", "openai")
    result = pages_via_vision(pdf_bytes, [page_index], provider=provider)
    assert page_index in result, (
        f"{case['id']}: pages_via_vision returned no output for page "
        f"{page_index} (provider={provider}, check creds + MINALLO_VISION_OCR_ENABLED)"
    )

    actual = result[page_index]
    expected = expected_path.read_text(encoding="utf-8")

    # Persist the raw OCR output next to the ground truth for diffing.
    # Gitignored — see .gitignore in this dir.
    actual_path = _FIXTURE_DIR / f"{case['id']}.{provider}.actual.md"
    actual_path.write_text(actual, encoding="utf-8")

    char_sim = _char_similarity(expected, actual)
    recall, hits, total, missed, actual_blocks = _formula_recall(expected, actual)

    with capsys.disabled():
        print(
            f"\n  {case['id']} [{provider}]  char_sim={char_sim:.2f}  "
            f"formula_recall={recall:.2f} ({hits}/{total})"
        )
        if missed:
            print(f"  missed {len(missed)} expected formula block(s):")
            for blk in missed:
                print(f"    EXPECTED: $$ {blk} $$")
            print(f"  actual page produced {len(actual_blocks)} formula block(s):")
            for blk in actual_blocks:
                print(f"    ACTUAL:   $$ {blk} $$")

    # Only formula_recall is asserted — char_sim varies a lot with how the
    # model renders headings / image placeholders / paragraph breaks and is
    # noisier than useful as a gate. Print it for context, gate on recall.
    #
    # 0.80 floor accommodates two reproducible gpt-4o weaknesses surfaced by
    # the eval on AG_9.1 exercise p1 (2026-05-22): italic lowercase "a"
    # misread as `\alpha`, and unit spaces eaten (`20 \mu m` → `20 \mum`).
    # When/if those get fixed via prompt tweak, raise the floor.
    assert recall >= 0.80, f"{case['id']} formula recall below 0.80 (was {recall:.2f})"


def test_fixture_index_loads() -> None:
    # Always runs (not gated) — guards against accidentally breaking cases.json.
    if not _CASES_JSON.exists():
        pytest.skip("no cases.json yet")
    for case in _CASES:
        for field in ("id", "pdf", "page_index", "description"):
            assert field in case, f"case missing {field!r}: {case}"
