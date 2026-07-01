# Extraction eval fixtures

A small, real-PDF regression set for the extraction pipeline. The point is to
stop "fix one PDF, silently break another": every change to extraction,
markdown conversion, OCR routing, or block detection runs against these and
must keep passing.

## How it runs

`tests/test_extraction_eval.py` discovers every `*.pdf` in this directory,
loads the matching `<name>.expected.json`, runs the **offline** pipeline
(pdfminer → markdown → exercise/formula detection → classification → OCR-need
measurement), and asserts the expectations.

It is deterministic and offline: **no OpenAI/Mathpix calls, no network**. It
measures what pdfminer + our markdown/block code produce. So write
expectations for the *pdfminer* output, not for what a vision model would
recover. (OCR-path eval is a separate future harness — it needs API keys and
is non-deterministic.)

If there are no `*.pdf` files here, the test self-skips — committing the
harness without the (potentially large / copyrighted) PDFs is fine.

## Adding a fixture

1. Drop the PDF in here, e.g. `formula_sheet.pdf`.
2. Add `formula_sheet.expected.json` next to it (same stem).
3. Run: `py -3 -m pytest tests/test_extraction_eval.py -q`

Suggested corpus (one of each failure mode):

- `clean_text_lecture.pdf` — good text layer, prose slides
- `scanned_exercise.pdf` — image-only, pdfminer gets ~nothing
- `formula_sheet.pdf` — dense Formelzettel, multi-column
- `two_column_slide.pdf` — reading-order hazard
- `diagram_heavy_page.pdf` — figures/labels
- `past_exam.pdf` — Aufgaben + points

## Expected-JSON format

Every field is **optional** — only the ones you include are asserted. See
`_example.expected.json` for a filled-in template.

| field                   | type        | assertion |
|-------------------------|-------------|-----------|
| `description`           | string      | none (human note) |
| `document_type`         | string      | `classify_document(name, text)` equals this |
| `min_pages`             | int         | extracted page count `>=` |
| `must_contain`          | string[]    | each substring appears in raw-or-markdown text |
| `must_not_contain`      | string[]    | none of these appear |
| `min_formula_blocks`    | int         | `detect_formulas(...)` count `>=` |
| `must_have_exercises`   | string[]    | each exercise number is detected (e.g. `"1.1"`, `"2"`) |
| `max_unclear_markers`   | int         | count of `[unclear]` in text `<=` |
| `expect_ocr_recommended`| bool        | `measure_ocr_need(...).ocr_recommended` equals this |

Notes:
- `must_contain` matching is exact substring (case- and whitespace-sensitive)
  against the combined raw page text **and** the generated markdown. Pick
  short, stable anchors — a symbol like `δ_K`, a German label word, a number.
- Keep expectations loose enough to survive harmless reflow but tight enough
  to catch real regressions (a missing formula, a dropped exercise).
