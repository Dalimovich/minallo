# OCR transcription eval fixture

Grades vision-OCR output against hand-typed ground truth. Complements
[../math_eval_cases.json](../math_eval_cases.json) (which grades retrieval/answer
quality, not OCR transcription).

## Layout

```
ocr_eval/
├── cases.json              ← index of all cases
├── <id>.pdf                ← source PDF (any page count)
└── <id>.expected.md        ← hand-typed ground truth for ONE page
```

## Adding a case

1. Pick a real page from a PDF in the product that exercises a hard OCR
   pattern — formula sheet, dense table, diagram with labels, scanned
   page, etc. Aim for 5–10 cases total, covering different failure modes.
2. Drop the PDF into this directory as `<id>.pdf` (keep ids kebab-case
   and short: `ag91_formelzettel`, `lin_alg_ch2_table`, etc). **PDFs are
   gitignored** — they stay local. Only the `<id>.expected.md` ground
   truth is checked in. Tests skip cleanly if the local PDF is missing.
3. Open the page in any PDF viewer and *manually type* the correct
   Markdown into `<id>.expected.md`. Follow the conventions the vision
   prompt enforces (see [vision_ocr.py](../../../app/services/vision_ocr.py)):
   - `$$ ... $$` for display math, proper LaTeX (`\frac`, `\delta`, `_`, `^`)
   - Two-column formula-label tables: formula then label on next line
   - `[unclear]` for genuinely unreadable regions
4. Add an entry to `cases.json` with `id`, `pdf`, `page_index` (0-based),
   and a one-line `description` of what failure mode the case covers.
5. Run the eval (below) and record the baseline score in the PR.

## Running

The eval makes real OpenAI calls (~$0.005 per page on gpt-4o), so it is
**gated behind an env var** and is not part of the default `pytest` run.

```powershell
$env:MINALLO_RUN_OCR_EVAL = "1"
$env:OPENAI_API_KEY       = "sk-..."
pytest backend/python-ai/tests/test_vision_ocr_eval.py -v -s
```

Output per case:

```
ag91_formelzettel_p3  char_sim=0.91  formula_recall=1.00 (8/8)
```

- `char_sim` — difflib SequenceMatcher ratio on normalized text. Loose;
  catches large layout regressions.
- `formula_recall` — fraction of LaTeX `$$ ... $$` blocks from the
  expected file that appear (token-for-token) in the actual output.
  This is the real quality signal — formulas are what students rely on.

## Tuning loop

1. Establish baseline on current `MINALLO_VISION_OCR_*` settings.
2. Change ONE knob (prompt edit, DPI, model).
3. Re-run, compare per-case scores.
4. Commit the change *with* the score delta in the message.

That's it — no more "I think it looks better."
