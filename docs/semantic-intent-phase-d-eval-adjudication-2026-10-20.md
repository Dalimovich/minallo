# Semantic Student Intent Layer — Phase D live-eval adjudication (2026-10-20)

Scope: adjudicate the scoring of the independent live-model evaluation at
`reports/semantic-intent-phase-d-eval-reverify2-2026-10-20.md` (frozen,
read-only, lives in the separate detached-HEAD worktree
`C:\Users\dalim\AppData\Local\Temp\minallo-semantic-live-eval-2`). This
file documents reasoning only — it does not edit that report, the eval
script, or the fixture corpus, and it changes no code or test behavior.

This is a companion to the three code fixes landed as `2695e54f`
(`multiturn-explicit-later-override`), `3e363735` (documented KNOWN_GAP for
`german-multi-quantity-mixed-permission`), and `a402b9fa`
(`document-scope-correction-not-full-document`), plus the cache regression
`82cb0d84`. Read those commits for the behavioral analysis; this file is
scoring only.

## Scores

- **Strict score (as recorded): 16/25.**
- **Independently adjudicated score: 19/25.**

Three cases are reclassified from FAIL to PASS, each justified below with
concrete reasoning. No case is reclassified the other way, and no case is
reclassified merely because a *later* code fix changed behavior — the
adjudication judges the FROZEN recorded run's own evidence, not what the
system does today. Both `document-scope-correction-not-full-document` and
`german-multi-quantity-mixed-permission` remain scored as failures here,
even though the former is now fixed (`a402b9fa`) and the latter is now a
documented KNOWN_GAP — the recorded run's own behavior at eval time really
was wrong (or, for the KNOWN_GAP case, really did refuse a legitimate
sub-part request), so the corpus was correct to score them as failures.
Being fixed afterward is reported separately (in the fix commits), not
smuggled into this score.

## Method

For every one of the 9 recorded failures, I checked three things:

1. Is the corpus's *expectation itself* provably wrong (e.g. an invalid
   enum value, or a value that is semantically interchangeable with the
   one actually produced)?
2. Does the mismatch exist at layer1 (raw `resolved_intent`) only, with
   layer2 (the actually-governing compiled `ExecutionPolicy`) already
   correct? Per the task's own standard: a case whose compiled policy
   behaves correctly should not fail only because the pre-compilation
   intermediate representation didn't spell out a value the compiler was
   always going to fill in identically anyway.
3. Otherwise: is this a genuine behavioral gap (even a minor, safe-side
   one), and is it already a known, accepted, documented limitation
   (single-target leak-scan gap, mixed-permission fail-closed,
   `wait_for_student` prompt-only) that this round was explicitly told not
   to reopen?

When in doubt, the case stays scored as a failure.

## Corrected cases (3)

### 1. `full-solution-en` — RECLASSIFIED PASS

- Recorded failure: `layer1(understanding): target '9' field
  'final_answer': expected 'permitted', got 'unspecified'`. No layer2
  mismatch is listed at all.
- `expectedEscalates: false` — this is a deterministic-only control case
  (zero model calls), so "layer1" here is `adapt_deterministic_intent`'s
  output, which by design leaves `final_answer` at the `"unspecified"`
  sentinel for `compile_policy` to resolve (see `policy_compiler.py`'s
  rule 5 and `_TUTORING_DEFAULT["final_answer"] = "permitted"`). Leaving
  it unspecified at layer1 is not a bug — it is the documented contract:
  the deterministic adapter's job is to extract what was actually said,
  not to pre-apply the compiler's own defaults.
- The recorded `layer2_actions` (the actually-governing policy) shows
  `final_answer: "permitted"` — exactly the expected value — and layer2
  is absent from `failure_causes`, confirming the eval script itself
  found no layer2 mismatch.
- Verdict: the compiled policy already behaves correctly; failing this
  case only tests "did layer1 pre-empt a value the compiler was always
  going to produce identically," which is not a real behavioral question.

### 2. `full-solution-de` — RECLASSIFIED PASS

- Identical reasoning to `full-solution-en`: `expectedEscalates: false`,
  recorded failure is layer1-only (`final_answer` "unspecified" vs
  "permitted"), recorded `layer2_actions` already shows
  `final_answer: "permitted"`, and layer2 is absent from
  `failure_causes`.

### 3. `explain-method-no-result-de` — RECLASSIFIED PASS

- Recorded failure: `form` expected `"unspecified"`, got `"explanation"`
  — at BOTH layer1 and layer2 this time (unlike the two cases above,
  `expectedLayer2` was not supplied for this case, so the eval script's
  `layer2_expected = case.get("expectedLayer2") or case.get(
  "expectedLayer1")` fallback re-checked layer2 against the same strict
  layer1 expectation).
- The model's real action has `objective: "explain"` (not `"hint"`), so
  `policy_compiler.py`'s hint-objective fallback (which treats an unset
  `form` specially) never applies to this target either way.
  `_TUTORING_DEFAULT["form"]` is `"explanation"` — the SAME value the
  model produced explicitly. Whether the model leaves `form` at
  `"unspecified"` (letting the compiler default it) or sets it to
  `"explanation"` directly, the governing `ExecutionPolicy` value is
  identical: `"explanation"`.
- Verdict: there is no actual behavioral difference between "what the
  corpus expected to happen" and "what happened" — the student asked to
  be walked through the solution step by step ("Erkläre mir den
  Lösungsweg... Schritt für Schritt"), and got exactly a full explanation
  with the final answer withheld (`final_answer: "prohibited"` already
  matched, not in the failure list at all). The `"unspecified"`
  expectation was checking an implementation detail (did the model need
  to state the value explicitly) that has zero effect on real behavior.

## One confirmed-invalid sub-expectation, conservatively NOT used to flip the case

### `explain-method-no-result-en` — remains FAIL

- `expectedLayer1` for this case includes
  `"explanation_depth": "normal"`. `resolved_student_intent.py` defines
  `ExplanationDepth = Literal["none", "concept", "method",
  "worked_derivation", "unspecified"]` — `"normal"` is not a member of
  that type at all; it cannot be produced by any correct implementation.
  This sub-expectation is a corpus typo (most likely intending
  `"method"`, which is exactly what the model produced), and I am
  confident in this specific finding — it is independently verifiable
  from the type definition itself, not a judgment call.
- However, the SAME case has a SECOND, independent mismatch that the
  typo does not excuse: `form` expected `"unspecified"`, got
  `"guided_questions"` (at both layers). The model chose a Socratic,
  question-guided teaching form for "walk me through how to set up
  exercise 5b -- just the approach" — a more conservative (safe-side) but
  arguably under-delivering choice relative to a direct walkthrough.
  Unlike the `explain-method-no-result-de` case above, `"guided_questions"`
  is NOT semantically interchangeable with what a default would have
  produced (`_TUTORING_DEFAULT["form"]` is `"explanation"`, which is a
  DIFFERENT, less restrictive value than `"guided_questions"` — see
  `RESTRICTIVENESS_RANK["form"]`: `explanation=1`, `guided_questions=2`).
- Verdict: the case still fails on a genuine, non-typo mismatch, so I do
  not reclassify it even though one of its two listed causes
  (`explanation_depth`) is independently provably invalid as written. Per
  the task's "be conservative" instruction, a case is reclassified only
  when EVERY listed cause is resolved, not when one of several is.

## Cases left as genuine failures (not reclassified)

### `multi-exercise-three-targets-de`

- Single mismatch: `layer2(policy compiler): target '7' field 'form':
  expected 'unspecified', got 'explanation'`. The student said "zu
  Aufgabe 7 bitte gar nichts sagen" ("please say nothing at all about
  exercise 7"); the model correctly set `final_answer: "prohibited"` for
  that target (matches expectation, not failing), but `form` was left
  unset by the model and the compiler's ordinary tutoring default
  (`"explanation"`) filled it in — unlike the `explain-method-no-result-de`
  case above, this default does NOT match the student's actual intent
  ("say nothing at all" is not well served by actively defaulting to an
  explanation form). This looks like a genuine, if minor and safe-side
  (it doesn't leak `final_answer`), gap: a fully-withheld target's `form`
  probably shouldn't default to `"explanation"` the same way an ordinary
  unconstrained target's would. This was not one of the three cases this
  round was asked to fix, and fixing it would mean touching
  `policy_compiler.py`'s tutoring-default logic again, out of scope here
  — left as a genuine, scored failure.

### `quiz-answer-hiding-unseen-phrasing`

- Mismatch: `wait_for_student` expected `True`, got `None`/`False`. This
  is precisely the already-identified, already-accepted limitation this
  round was explicitly told to leave alone: `wait_for_student` is
  prompt-instruction-only right now and is not wired into
  `answer_release_validator.py` or the structural release gate in
  `stream.py` (see this round's restrictions, item 4). A real,
  genuine, and currently-accepted gap — scored as a failure, not
  reclassified, and not touched.

### `multiturn-explicit-later-override`

- Fixed in `2695e54f`: the compiled action's `objective`/`state` no
  longer get clobbered by a reconstructed historical action, which was a
  confirmed, independent bug (see that commit's message and the new
  `test_real_eval_recorded_case_explicit_hint_release_keeps_real_objective_and_preserves_other_fields`
  regression, which fails pre-fix and passes post-fix).
- That fix does NOT make `final_answer` flip to `"unspecified"`/
  `"permitted"` for target `"5"` — it stays `"prohibited"`, correctly
  inherited from the persisted turn-1 restriction, because the model's
  OWN current-turn action never addressed `final_answer` at all (it only
  addressed `form`/hints). Per `policy_compiler.py`'s rule 2 ("a later
  turn wins over an earlier one, but only for the fields it actually
  touched"), preserving an unaddressed field is the documented, correct,
  safe behavior — not a bug.
- Whether the corpus's expectation that final_answer SHOULD flip too
  (treating "hints are fine now... help more actively" as a full,
  broader release rather than a hint-scoped one) is itself right or
  wrong is a genuine product-intent judgment call, not a verifiable fact
  like the `"normal"` enum typo. I am not confident enough to call this
  expectation wrong, so — conservatively — this case remains scored as a
  failure even after the real bug fix, pending an actual product
  decision on how broad "you can help more actively" should be read.

### `document-scope-correction-not-full-document`

- Fixed in `a402b9fa`: `resolve_target_identity` now grounds a
  model-claimed sub-label of an already-verified `active_question`
  (e.g. `"5a"`/`"5c"` when the active question is `"5"`), closing a
  confirmed bug where a legitimate correction request was wrongly
  fail-closed.
- At the time this eval actually ran, the system had NOT been fixed yet:
  `5a`/`5c` were genuinely `state="unresolved"` and fail-closed
  (`official_solution: "prohibited"`, most-restrictive fallback across
  the board) — a real, confirmed defect, correctly scored as a failure
  by the corpus. The fix lands after this score was recorded, so this
  adjudication does not retroactively change the score for a run that
  really did exhibit the bug.
- Separately (not a scoring correction, just worth noting): even after
  the fix, a strict re-run of the exact eval script would likely still
  report `"target '5' not found"`, because the model splits the
  correction into `"5a"`/`"5c"` rather than a single merged `"5"` action
  — a label-granularity difference between the corpus's expectation and
  how the model naturally represents "parts a and c," independent of the
  (now-fixed) grounding bug. This is the same kind of label-granularity
  mismatch as the `german-multi-quantity-mixed-permission` case below,
  and is not corrected here since it was never actually re-run.

### `german-multi-quantity-mixed-permission`

- Documented in `3e363735` as a KNOWN_GAP, not fixed: the model's
  real target label (`"3 (second part)"`) was never literally present in
  the student's message, and `resolve_target_identity`'s refusal to trust
  an ungrounded, model-invented label is the SAME deliberate authority
  boundary protecting the whole system elsewhere — teaching it to accept
  an arbitrary natural-language ordinal reference would mean trusting the
  model's own choice of which letter "the second part" is, which is
  exactly the kind of unverified claim this gate exists to refuse. A
  real, accepted, intentionally fail-closed limitation — scored as a
  failure, not reclassified.

## What this adjudication does NOT do

- It does not touch `reports/semantic-intent-phase-d-eval-reverify2-2026-10-20.md`,
  its `.json` sibling, or `tests/fixtures/semantic_intent_phase_d_eval_cases.json`
  in the separate eval worktree — all read-only inputs.
- It does not reclassify any case whose compiled policy actually produced
  different (and worse) behavior than the student asked for, even when
  the difference is small or safe-side.
- It does not change pytest, pyright, or any runtime behavior. It is
  documentation only.
