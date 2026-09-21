# TestDaF T1a checkpoint — not released

T0 checkpoint: `fd224858` (already pushed separately to main).
T1a is implemented on `feat/testdaf-t1a`. **available=False**. All 23 TestDaF
parts remain disabled because live quality/latency QA did not pass. No inventory
was stocked, no database writes were made by the QA harness, and T1b was not started.

## Official material checked before implementation

[TestDaF official demo, printed pages 8–9](https://www.testdaf.de/fileadmin/testdaf/downloads/Demo_Version_digitaler_TestDaF/Beispielaufgaben_Demo-Version_digitaler_TestDaF.pdf):
seven questions, four choices each, one answer, a titled article with numbered
paragraphs. The example has six paragraphs; questions 1–6 follow those paragraphs
and question 7 asks about the whole text. The example gives 15 minutes. Responses
can be changed within the task; digital options are not lettered. The demo's
general instructions prohibit returning to completed tasks.

[Official structure](https://www.testdaf.de/de/teilnehmende/der-digitale-testdaf/aufbau-des-digitalen-testdaf/)
describes university-related, cross-disciplinary reading without specialist
knowledge. The exam spans advanced B2/C1; this practice implementation targets C1.
Six paragraphs, the per-question scope pattern, and 500–650 words are explicitly
labelled **application practice policy**, not universal official requirements.

## Implementation and architecture

All TestDaF-specific editable facts/configuration remain in
`backend/python-ai/app/services/german_exams/testdaf_digital.py`: **YES**.
The profile version is 2. Model choices and practice targets also live there.

Reused the inspected reading MC implementation pattern and the existing reading
orchestrator, structural repair, semantic gate/audit, bounded semantic repair,
and final envelope. The `reading_multiple_choice` implementation supports a
blueprint-specified option count. `mc3` remains the historical payload field name
for compatibility; its list length is not assumed to be three. No separate
TestDaF generator, semantic issue codes, or frontend page was introduced.

Shared changes support option-count-aware audits and repairs, full-article
verification, configurable question scope (including whole-text questions),
paragraph numbering and unlabeled options. Part navigation now uses the manifest
and can open a partly implemented module. Scoring serialization exposes the
existing points-per-correct field so TELC keeps its scoring and uncalibrated
TestDaF practice does not acquire invented points/TDN results.

The isolated branch excludes the main workspace's uncommitted Goethe work.
Neither TELC nor Goethe profile files are changed. Their existing generation
dispatch/prompt behavior remains unchanged; optional model overrides fall back
to the existing defaults. New navigation is generic, with no profile-name branch.

Architecture findings: the committed reading switcher still assumed three TELC
parts and the module gate required every part to be implemented. These were
reported before extending the shared mechanisms. There was no need to move any
TestDaF fact into shared code. The remaining release blocker is quality and
the existing synchronous generation budget, not profile organization.

## Live QA

All raw responses, repair responses, automatic verdicts and usage/timing records
are retained in `live/` and `live-v2/`. `summary.json` adds manual review and
corrected cost estimates. The first batch used the existing mini-model defaults;
the second used the stronger profile-configured model and stricter MC prompts.

| Batch/sample | Seconds | Recorded usage USD | Structural repair calls | Semantic repair calls | Automated result | Manual/release result |
|---|---:|---:|---:|---:|---|---|
| Initial 1 | 27.488 | 0.027944 | 1 | 0 | Pass after one regeneration | C / Fail |
| Initial 2 | 26.407 | 0.030528 | 0 | 1 | Pass | C / Fail |
| Initial 3 | 25.368 | 0.029904 | 0 | 1 | Pass | C / Fail |
| Stronger 1 | 95.036 | 0.161057 | 0 | 6 | Budget exceeded | C candidate / Fail |
| Stronger 2 | 95.018 | 0.176020 | 0 | 3 | Budget exceeded | C candidate / Fail |
| Stronger 3 | 95.016 | 0.195208 | 0 | 3 | Budget exceeded | C candidate / Fail |

Initial semantic findings: none for sample 1; `IMPLAUSIBLE_DISTRACTOR` on q1
for samples 2 and 3, each followed by one repair and a passing recheck. Manual
review still found two defensible q1 answers in sample 2 and many trivial or
text-remote distractors throughout the batch. These automatic passes were rejected.

The stronger verifier flagged `IMPLAUSIBLE_DISTRACTOR` on 6/3/3 items respectively,
plus `PARAPHRASE_TOO_LITERAL` on sample 2 q1. Repair responses were returned, but
re-verification timed out in all three runs. No final envelope was accepted.
The C grades in this batch refer to the generated candidates; repaired candidates
are not certified or claimed to pass. Detailed item reasons are in `summary.json`.

Recorded-usage total: approximately **$0.621**. The old tracker reports GPT-5.4 as
unpriced, so its zero subtotal is not a free-call claim. The summary prices its
recorded tokens using [official standard pricing](https://developers.openai.com/api/docs/models/gpt-5.4)
($2.50 input, $0.25 cached input, $15 output per million tokens). Timed-out calls
can incur additional charges without returned usage; this is not a final invoice.

## Verification

- 430 German-exam backend tests passed, including TELC, Goethe, profile/manifest,
  generator, deterministic and semantic validation/repair regressions.
- 10 frontend/component checks passed using the existing workspace tests and
  real headless Chromium. These cover partial availability, disabled parts,
  paragraph labels, four options, answer changes, grading, escaping, and fixed
  versus uncalibrated scoring. This is component integration, not a logged-in
  end-to-end run against production.
- Ruff and JavaScript syntax checks passed.
- New negative tests reject wrong counts/IDs/keys, unsupported answers, multiple
  defensible answers, implausible distractors, and incomplete option audits.
  Tests assert that the semantic verifier receives the complete article and
  that semantic failure cannot produce an accepted task.
- A release-candidate manifest test proves only Lesen 3 would become enabled
  if its profile availability flag were approved after QA; the actual flag is false.

Reproduce live QA from `backend/python-ai`:

```text
python -m scripts.qa_reading_mc testdaf_digital lesen_3 --env-file PATH --out PATH
```

Run frontend/component checks from the repo root:

```text
node node_modules/tsx/dist/cli.mjs --test tests/frontend/german-exam-workspace.test.mjs tests/frontend/reading-mc-browser.spec.mjs
```

Stop here. Do not enable T1a or start T1b based on this batch. Next T1a work should
improve distractor supply and fit full independent verification into the existing
request budget without weakening the quality gate.

## Files changed

- `backend/python-ai/app/services/german_exams/testdaf_digital.py`
- `backend/python-ai/app/services/german_exams/task_types.py`
- `backend/python-ai/app/services/german_exams/manifest.py`
- `backend/python-ai/app/services/german_exam_reading.py`
- `backend/python-ai/app/services/german_exam_validator.py`
- `backend/python-ai/app/services/german_exam_semantic_verify.py`
- `backend/python-ai/app/services/german_exam_semantic_repair.py`
- `backend/python-ai/scripts/qa_reading_mc.py`
- `backend/python-ai/tests/test_german_exam_reading_mc.py`
- `backend/python-ai/tests/test_german_exam_profile_testdaf_digital.py`
- `frontend/js/features/german-exam/exam-workspace.ts`
- `frontend/views/practice/practice.js`
- `frontend/views/practice/practice.css`
- `tests/frontend/reading-mc-browser.spec.mjs`
- `tests/e2e/fixtures/german-exam-manifests.json`
- `audit/testdaf-t1a/REPORT.md`, `summary.json`, and six raw sample records
