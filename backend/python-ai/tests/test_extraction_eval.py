"""Extraction eval — real-PDF regression set.

Discovers every ``*.pdf`` under ``tests/fixtures/extraction_eval/`` with a
matching ``<stem>.expected.json`` and asserts the expectations against the
OFFLINE extraction pipeline (pdfminer -> markdown -> block detection ->
classification -> OCR-need measurement).

Deterministic and network-free: no OpenAI/Mathpix calls. Write expectations
for what pdfminer produces, not for vision-OCR recovery. See the fixtures'
README.md for the JSON format.

Self-skips when no fixture PDFs are present, so the harness can be committed
without the (large / copyrighted) PDFs.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.block_detection import detect_exercises, detect_formulas
from app.services.document_intelligence import classify_document, measure_ocr_need
from app.services.extraction import extract_pages_text
from app.services.markdown_indexing import page_to_markdown

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "extraction_eval"


def _discover() -> list[tuple[Path, Path]]:
    """Return (pdf, expected_json) pairs. Files whose stem starts with ``_``
    (e.g. the template) are ignored."""
    pairs: list[tuple[Path, Path]] = []
    if not _FIXTURE_DIR.is_dir():
        return pairs
    for pdf in sorted(_FIXTURE_DIR.glob("*.pdf")):
        if pdf.stem.startswith("_"):
            continue
        pairs.append((pdf, pdf.with_suffix(".expected.json")))
    return pairs


_PAIRS = _discover()


class _Extracted:
    """The offline pipeline's output for one PDF, pre-computed once."""

    def __init__(self, pdf_bytes: bytes, file_name: str) -> None:
        self.pages = extract_pages_text(pdf_bytes)
        self.page_md = [page_to_markdown(t, i + 1) for i, t in enumerate(self.pages)]
        md_pages = [(p.page_number, p.markdown) for p in self.page_md if p.markdown]
        self.exercises = detect_exercises(md_pages)
        self.formulas = detect_formulas(md_pages)
        self.ocr = measure_ocr_need(self.pages)
        sample_text = "\n\n".join((p or "")[:1500] for p in self.pages[:6])
        self.document_type = classify_document(file_name, sample_text)
        # Combined searchable text: raw pages + generated markdown.
        self.combined = "\n".join(self.pages) + "\n" + "\n".join(
            p.markdown for p in self.page_md
        )
        self.exercise_numbers = {e.exercise_number for e in self.exercises}
        self.unclear_count = self.combined.lower().count("[unclear]")


def _check(extracted: _Extracted, expected: dict) -> list[str]:
    """Return a list of human-readable failure messages (empty == pass)."""
    errors: list[str] = []

    want_type = expected.get("document_type")
    if want_type is not None and extracted.document_type != want_type:
        errors.append(
            f"document_type: expected {want_type!r}, got {extracted.document_type!r}"
        )

    min_pages = expected.get("min_pages")
    if min_pages is not None and len(extracted.pages) < min_pages:
        errors.append(f"min_pages: expected >= {min_pages}, got {len(extracted.pages)}")

    for needle in expected.get("must_contain", []):
        if needle not in extracted.combined:
            errors.append(f"must_contain: {needle!r} not found in extracted text")

    for needle in expected.get("must_not_contain", []):
        if needle in extracted.combined:
            errors.append(f"must_not_contain: {needle!r} unexpectedly present")

    min_formulas = expected.get("min_formula_blocks")
    if min_formulas is not None and len(extracted.formulas) < min_formulas:
        errors.append(
            f"min_formula_blocks: expected >= {min_formulas}, got {len(extracted.formulas)}"
        )

    for ex in expected.get("must_have_exercises", []):
        if str(ex) not in extracted.exercise_numbers:
            errors.append(
                f"must_have_exercises: exercise {ex!r} not detected "
                f"(detected: {sorted(extracted.exercise_numbers)})"
            )

    max_unclear = expected.get("max_unclear_markers")
    if max_unclear is not None and extracted.unclear_count > max_unclear:
        errors.append(
            f"max_unclear_markers: expected <= {max_unclear}, got {extracted.unclear_count}"
        )

    want_ocr = expected.get("expect_ocr_recommended")
    if want_ocr is not None and extracted.ocr.ocr_recommended != want_ocr:
        errors.append(
            f"expect_ocr_recommended: expected {want_ocr}, got {extracted.ocr.ocr_recommended}"
        )

    return errors


@pytest.mark.skipif(not _PAIRS, reason="no extraction_eval fixture PDFs present")
@pytest.mark.parametrize("pdf_path, json_path", _PAIRS, ids=[p.stem for p, _ in _PAIRS])
def test_extraction_fixture(pdf_path: Path, json_path: Path) -> None:
    if not json_path.is_file():
        pytest.skip(f"missing expectations file {json_path.name} for {pdf_path.name}")

    expected = json.loads(json_path.read_text(encoding="utf-8"))
    extracted = _Extracted(pdf_path.read_bytes(), pdf_path.name)
    errors = _check(extracted, expected)

    assert not errors, (
        f"\n{pdf_path.name} failed {len(errors)} extraction expectation(s):\n  - "
        + "\n  - ".join(errors)
    )


# ── _check logic (exercised without a real PDF) ─────────────────────────────


def _fake_extracted(**overrides) -> SimpleNamespace:
    base = dict(
        document_type="formula_sheet",
        pages=["p1", "p2", "p3"],
        formulas=[object()] * 9,
        exercise_numbers={"1.1", "2"},
        combined="$$ \\delta_K $$ Nachgiebigkeit Aufgabe 1.1 [unclear]",
        unclear_count=1,
        ocr=SimpleNamespace(ocr_recommended=False),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_check_passes_when_all_expectations_met() -> None:
    expected = {
        "document_type": "formula_sheet",
        "min_pages": 3,
        "must_contain": ["\\delta_K", "Nachgiebigkeit"],
        "must_not_contain": ["solution_leak"],
        "min_formula_blocks": 8,
        "must_have_exercises": ["1.1", "2"],
        "max_unclear_markers": 1,
        "expect_ocr_recommended": False,
    }
    assert _check(_fake_extracted(), expected) == []


def test_check_reports_each_failure() -> None:
    expected = {
        "document_type": "exam",
        "min_pages": 10,
        "must_contain": ["missing_token"],
        "must_not_contain": ["Nachgiebigkeit"],
        "min_formula_blocks": 20,
        "must_have_exercises": ["3.4"],
        "max_unclear_markers": 0,
        "expect_ocr_recommended": True,
    }
    errors = _check(_fake_extracted(), expected)
    # One failure per violated expectation (8 total here).
    assert len(errors) == 8
    joined = "\n".join(errors)
    assert "document_type" in joined
    assert "must_have_exercises" in joined


def test_check_ignores_absent_fields() -> None:
    # Empty expectations assert nothing — always passes.
    assert _check(_fake_extracted(), {}) == []
