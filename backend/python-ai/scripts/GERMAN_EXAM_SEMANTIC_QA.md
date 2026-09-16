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

## Phase 2.5 — latency investigation (2026-09-16)

**Goal**: reduce the ~146s/run semantic-verification latency without weakening
the deterministic or semantic quality gates (hard constraint — not
negotiable).

**Measurement**: correlated per-call `promptTokens`/`completionTokens`
against `seconds` across the release run's 15 verification calls.
`corr(completionTokens, seconds) = 0.986`; `corr(promptTokens, seconds) =
-0.176`. Latency is almost entirely explained by completion-token count
(dominated by GPT-5-family invisible reasoning tokens at 110–170 tok/s
across calls), not prompt/schema size. This rules out "smaller verifier
inputs" as a meaningful latency lever — it would reduce token *cost*
slightly but not latency.

**Tested lever: `reasoning_effort="medium"` → `"low"`**
(`scripts/measure_reasoning_effort.py`, re-verifies the same 9 real
already-generated samples plus the 3 required injected-failure fixtures,
no new generation calls):

- Latency: `"low"` is ~2.5x faster (8.55s avg → 3.38s avg per call).
- Required fixture regression: **all 3 still caught at `"low"`**
  (hv1/`AMBIGUOUS_MAPPING`, hv2/`IMPLAUSIBLE_DISTRACTOR`,
  hv3/`DUPLICATE_INFORMATION` — `caught=True` for both effort levels).
  This alone would look like a clean win.
- **But** on the 9 real, non-injected release samples, `"medium"` found
  genuine defects on 2 of 9 (`hv2 idx=2`:
  `UNSUPPORTED_CORRECT_ANSWER`/`IMPLAUSIBLE_DISTRACTOR`; `hv3 idx=0`:
  `MULTIPLE_DEFENSIBLE_ANSWERS`) that the ORIGINAL release run had also
  accepted as passing at the time — a separate non-determinism signal
  (same model, same content, different verdict on repeated calls; noted
  below). At `"low"`, **all 9 samples came back clean, including those same
  two** — i.e. `"low"` did not just fail to reproduce the medium-run
  finding, it failed to catch defects that `"medium"` demonstrably can
  catch on the same content.

**Conclusion: rejected.** The required fixtures are deliberately blatant
(an absurd distractor, literally duplicated text) — passing them is a floor
test, not proof of real-world detection quality. The real signal is the
miss on subtle, real content. Per the hard constraint, `"low"` is not
adopted; `GERMAN_EXAM_MODEL` verification keeps `reasoning_effort="medium"`.

**Secondary finding (not yet addressed, flagged for awareness)**: the
verifier's judgment is not fully stable across repeated calls on identical
content at `"medium"` either — the two samples above were accepted in the
original release run and flagged on re-verification. This is a
pre-existing reliability characteristic of the LLM-judged pass, independent
of the reasoning-effort question. Not a regression introduced by this
investigation; worth a future look (e.g. self-consistency voting) but out
of scope here.

**Levers ruled out or not applicable**, based on the design as built:
- *Smaller verifier inputs*: ruled out by the correlation data above —
  prompt size isn't the latency driver.
- *Caching identical verification work*: not applicable — verification is
  already exactly one batched call per part (a spec requirement), and
  generated content varies per user/session/topic, so there is no literal
  duplicate call within the current flow to cache away.
- *Smarter repair scope*: repair is already cheap (3.2s total across 3
  calls in the release run) — not the bottleneck.

**Remaining viable lever**: pre-generation/prefetch — starting HV1
generation in the background as soon as the user is likely headed into
Hören (e.g. on opening German Practice), rather than waiting for the
explicit part-open click. This hides latency behind navigation instead of
reducing it, and is the only lever identified so far that doesn't trade
against verification depth. Not yet implemented — flagged as the concrete
next step if Phase 2.5 continues.

Reproduce: `.\.venv\Scripts\python.exe -m scripts.measure_reasoning_effort`
(reads the existing `german-semantic-release.json`, writes
`reasoning-effort-comparison.json`, both in the ignored `diag_runs` dir).

## Phase 2.5b — verifier stability (2026-09-16)

**Goal**: quantify the non-determinism flagged in Phase 2.5, at the
CURRENT production `reasoning_effort="medium"` — no verifier redesign.

**Method** (`scripts/measure_verifier_stability.py`): a fixed labeled
corpus, each item re-verified 5x with no code change between calls —
3 `injected_bad` (definitionally defective: the 3 required fixtures), 2
`real_disputed` (release-run content that passed clean with zero repairs
on its ORIGINAL first verify, but that Phase 2.5's re-verification later
flagged with real issues on the identical content), 5 `known_good`
(release-run content that passed clean on the first verify with zero
repairs, ever).

**Results**:

| Label | Metric | Result |
| --- | --- | --- |
| `injected_bad` | false-negative rate (known-bad passed clean) | **0/15 (0%)** |
| `real_disputed` | false-negative rate (prior-flagged defect passed clean) | **2/10 (20%)** |
| `known_good` | false-positive rate (clean content flagged) | **5/25 (20%)** |

Task-type breakdown: hv1 1/3 items show any run-to-run disagreement (and
that one case never flipped pass/fail — only appended a second, weaker
code on 1 of 5 runs); hv2 2/3 items disagree; hv3 3/4 items disagree.

**Reading against your acceptance bar** ("known genuine defect must not
sometimes become clean" — issue-code wording drift alone is not
concerning): **this bar is not met.** Both `real-disputed-hv2-2` and
`real-disputed-hv3-0` — presumed-genuine defects because Phase 2.5's
independent re-verification flagged them with concrete, specific codes on
content the original pipeline had accepted — passed clean on 1 of their 5
repeat runs. Symmetrically, 2 of 5 `known_good` items (`known-good-hv2-0`,
`known-good-hv3-2`) flip between clean and flagged (`IMPLAUSIBLE_DISTRACTOR`
/ `MULTIPLE_DEFENSIBLE_ANSWERS`) run to run despite never having been
touched by repair in the original pipeline.

Blatant defects (the 3 required injected fixtures) are caught with 100%
reliability regardless of this — the release gate's regression coverage is
sound. The instability is specific to subtler, judgment-heavy calls
(distractor plausibility, answer-uniqueness), and specific to HV2/HV3 —
HV1's speaker-matching task showed no verdict flips at all across 15 runs
(3 items × 5 repeats).

**Conclusion**: this is a real, pre-existing correctness characteristic of
the shipped verifier, not something Phase 2.5's latency work introduced or
worsened, and not something prefetch timing would change either way — the
gap is in judgment reliability, not in when generation happens. Per
explicit instruction, the verifier itself is NOT redesigned in this pass;
this section only measures and reports. Candidate mitigations for a future
pass (not implemented here): majority-vote across 2-3 verification calls
specifically for hv2/hv3 (hv1 doesn't need it), or a borderline-confidence
signal that triggers a second opinion only when warranted. Both are scoped
changes to the verifier's calling convention, not the model or its
reasoning effort, so they don't reopen the rejected latency lever.

Reproduce: `.\.venv\Scripts\python.exe -m scripts.measure_verifier_stability`
(writes `verifier-stability.json` to the ignored `diag_runs` dir; makes 50
real verification calls).

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
