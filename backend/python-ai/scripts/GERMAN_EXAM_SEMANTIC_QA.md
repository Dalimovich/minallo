# Phase 2 Semantic Verification

## Status: release gate PASSED (2026-09-16, `german-semantic-release.json`)

The pipeline performs structural validation, batched semantic review, at most
two targeted repair rounds with both validators rerun, and at most two full
regenerations. Exhaustion raises an error instead of returning rejected
content. Malformed, incomplete, contradictory, or unknown-code verifier
responses block acceptance (fail-closed — see `test_parser_fails_closed`).
Distractor-only MC3 repairs preserve the stem and correct option; repairs
preserve IDs, tags, difficulty, transcript, and untouched questions
(`_constrain_repair`, tested in `test_german_exam_semantic_pipeline.py`).

## Live results (release run)

`scripts/diag_runs/german-semantic-release.json` — 3 real samples each for
HV1/HV2/HV3 (9 total), real OpenAI calls, `GERMAN_EXAM_MODEL` (gpt-5.4-mini)
for both generation and semantic verification/repair.

- **9/9 accepted, 0 rejected.** No sample exhausted the repair/regeneration
  budget.
- **All three required injected failure classes caught**, per the exact
  scenario section 20 specifies: an HV1 statement force-copied from a
  different speaker's own text → caught as `AMBIGUOUS_MAPPING`; an HV2
  distractor replaced with an absurd unrelated option ("alle Kreuzungen
  abschaffen und durch fliegende Einhörner ersetzen") → caught as
  `IMPLAUSIBLE_DISTRACTOR`; an HV3 field force-duplicated from another field
  → caught as `DUPLICATE_INFORMATION`. `hv1: caught=True`, `hv2:
  caught=True`, `hv3: caught=True`.
- **Rates**: pass-without-repair 55.6%, repair 33.3% (semantic repair
  actually fired and resolved the issue), full regeneration 11.1%.
- **Issue codes seen on real (non-injected) generations**:
  `AMBIGUOUS_MAPPING` ×1, `UNSUPPORTED_CORRECT_ANSWER` ×1,
  `IMPLAUSIBLE_DISTRACTOR` ×4, `MULTIPLE_DEFENSIBLE_ANSWERS` ×2,
  `DUPLICATE_INFORMATION` ×2 — i.e. the verifier is finding genuine,
  varied defects on ordinary generation output, not just the injected ones.

**Manual quality read** (required by section 20, not just the aggregate
rates): read the full content of two repaired samples end-to-end.
- HV1 sample (repaired once, `IMPLAUSIBLE_DISTRACTOR` on q10): 8 speakers
  with genuinely distinct positions on campus sustainable-mobility (fare/
  schedule coordination, bike-infrastructure reliability, pricing
  disincentives, e-scooter regulation, last-mile transit, combined-measures
  argument, awareness campaigns, student affordability) — no two speakers
  restate each other. The repaired distractor (q10, employer-subsidized
  transit passes) now reads as a plausible-but-unmatched statement, not an
  absurd one.
- HV3 sample (repaired once, `MULTIPLE_DEFENSIBLE_ANSWERS` on q4): 10 fields
  covering genuinely distinct lecture points (structure, ridership count,
  peak hours, root cause, bike infrastructure, e-bike charging, shuttle
  frequency, parking policy, information services, success criteria) — no
  duplication, concise note-worthy answers, coherent academic outline.

Both read as real, defensible C1 Hochschule content, not generic filler —
this is the qualitative signal the pass-rate numbers alone can't give.

### Cost/latency (measured, not inferred from mocks)

| Stage | Calls | Seconds (sum) | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: |
| Generation (+ structural repair) | 10 | 142.8 | 6,900 | 23,537 |
| Semantic verification | 15 | 145.8 | 51,900 | 22,678 |
| Semantic repair | 3 | 3.2 | 7,687 | 271 |

Semantic verification's own latency is roughly on par with generation's
(~146s vs ~143s across the run) — **semantic verification is adding
roughly 1x generation latency, not a small fraction of it**, driven mostly
by the large prompt (full transcript + questions + schema) rather than
completion length. Repair is cheap in both time and tokens when it fires.
This is the real number the "does semantic verification double cost"
question (spec §15) needed — it does, roughly, for latency; per-token cost
is dominated by verification's prompt tokens (52k vs 7k generation prompt
tokens), not its completion tokens. No dollar figure is asserted here
without applying the account's actual per-token pricing for
`GERMAN_EXAM_MODEL`.

## Prior failing run (historical, superseded)

An earlier run on the pre-audit-based verifier design (plain freeform
pass/fail JSON, `gpt-4o-mini`, no reasoning effort) failed outright: 0/9
accepted, and when injected faults were checked in isolation the verifier
missed the HV2 absurd distractor and the HV3 duplicate field, and
misclassified the HV1 ambiguity as generic incoherence. That result drove
the redesign to the current audit-based approach (`_apply_audits()`
deterministically derives the issue code from a structured factual audit —
`supportedSpeakerIds`, `optionVerdicts`, `duplicateItemIds` — rather than
trusting the model's own freeform verdict directly), the switch to
`GERMAN_EXAM_MODEL`, and OpenAI structured-output (`json_schema`, strict
mode) for the verifier call. Kept here as institutional memory of what
*doesn't* work, not as the current status.

## Reproduce

Run from `backend/python-ai` with the existing environment configured:

```powershell
.\.venv\Scripts\python.exe -m scripts.verify_german_exam_live --samples 3
.\.venv\Scripts\python.exe -m scripts.verify_german_exam_live --verifier-model gpt-4o --injections-from scripts/diag_runs/german-semantic.json --output scripts/diag_runs/german-semantic-strong.json
```

The runner writes local QA artifacts only; it does not publish exercises or
generate audio. Local outputs live in the ignored `scripts/diag_runs`
directory (re-run to reproduce — the JSON artifacts themselves are not
committed).

## Release gate (spec §21) — checklist

- [x] Deterministic validation passes (existing Phase 1 guarantee, unaffected)
- [x] Semantic validation passes (9/9 real samples, 0 rejected)
- [x] Unresolved semantic errors never reach users (exhaustion raises
      `ListeningGenerationError`, tested in `test_semantic_exhaustion_never_returns_content`)
- [x] Live verifier catches all three injected failure classes (hv1/hv2/hv3
      all `caught=True` above)
- [x] Repair preserves official task structure (`_constrain_repair` +
      `test_unresolved_repairs_are_not_reported_resolved` with
      `break_structure=True`; production `_semantic_phase` re-runs the
      deterministic validator after every repair and abandons item-level
      repair if structure moved)
- [x] Latency/cost measured (table above) — **acceptability is a product
      call, not an engineering one**: ~10s/part generation + ~10s/part
      verification (roughly doubling wall time per part) is the real
      number to decide against, not inferred or hidden.

Phase 2 is closed on the engineering criteria. The one remaining open
question is a product decision, not a technical gap: is ~2x latency
acceptable for production Hören generation, or does semantic verification
need to become optional/async/cached before wider rollout? That decision
is out of scope for this document.
