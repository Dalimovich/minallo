# OCR Evaluation Fixture

This fixture grades vision/OCR output against hand-typed Markdown ground truth. It complements the math/RAG fixture, which evaluates retrieval and answer behavior rather than transcription quality.

## Layout

```text
ocr_eval/
  cases.json              Case index
  <id>.pdf                Source PDF, local only and gitignored
  <id>.expected.md        Hand-typed ground truth for one page
```

## Adding A Case

1. Pick a real PDF page that stresses OCR quality:
   - formula sheet
   - dense table
   - diagram with labels
   - scanned page
   - mixed text/math layout
2. Copy the PDF into this directory as `<id>.pdf`.
3. Keep IDs short and kebab-case, for example `em2-formula-p3`.
4. Manually type the expected Markdown into `<id>.expected.md`.
5. Add the case to `cases.json` with:
   - `id`
   - `pdf`
   - `page_index` as a 0-based page number
   - `description`
6. Run the eval and record the baseline in the related PR/commit notes.

PDF files are gitignored. Tests skip cleanly when a local PDF is missing.

## Ground Truth Conventions

Follow the conventions used by the OCR prompt:

- Use `$$ ... $$` for display math.
- Use proper LaTeX commands such as `\frac`, `\delta`, `_`, and `^`.
- Preserve important formula labels and table structure.
- Use `[unclear]` only for genuinely unreadable regions.
- Do not "improve" the professor's notation unless OCR should normalize it.

## Running

This eval makes real OpenAI calls, so it is gated behind an environment variable and is not part of default `pytest`.

```powershell
$env:MINALLO_RUN_OCR_EVAL = "1"
$env:OPENAI_API_KEY = "sk-..."
pytest backend/python-ai/tests/test_vision_ocr_eval.py -v -s
```

Example output:

```text
em2-formula-p3  char_sim=0.91  formula_recall=1.00 (8/8)
```

## Metrics

| Metric | Meaning |
|---|---|
| `char_sim` | Normalized text similarity. Useful for broad layout/text regressions. |
| `formula_recall` | Fraction of expected display-math blocks recovered exactly. This is the most important signal for engineering students. |

## Tuning Loop

1. Establish a baseline on current OCR settings.
2. Change one thing: prompt, DPI, model, page preprocessing, or parser behavior.
3. Re-run the eval.
4. Compare per-case scores.
5. Keep the change only if it improves the target failure mode without hurting other cases.

Avoid subjective OCR changes without a score delta.
