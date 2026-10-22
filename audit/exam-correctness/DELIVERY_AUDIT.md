# Phase 6 — Delivery/Frontend Audit

Per the task's own allowance, done primarily by reading renderer/dispatch code and existing tests
rather than manually driving a browser (no dev server was started; Playwright browsers were not
installed/run in this pass — a real reduced-depth item, stated here and in the final report).

## Renderer/task-type mounting
`task-workspace.ts`'s `TASK_RENDERERS` registry is built generically from 4 renderer modules
(`productive-task.ts` for writing types, `speaking-task.ts` for all 7 TestDaF speaking types plus
TELC/Goethe's `presentation_summary_followup`/`quote_guided_discussion`/
`presentation_with_followup`/`guided_pair_discussion` — confirmed: `speaking-task.ts`'s
`mountSpeaking` is reused by both the productive-contract TestDaF types and the TELC/Goethe
part-id-based speaking generator per `audit/testdaf-offline/REPORT.md` T4's own statement that
`german_exam_speaking.py`'s TELC/Goethe path is "untouched" and separate from TestDaF's dispatch —
i.e. same renderer, two different backend generation paths, correctly kept apart), `media-task.ts`
for all `MEDIA_TASKS` (audio/video), `source-selection.ts` for all matching/MC/cloze types. **No
renderer branches on profile id** — every mapping is keyed by `taskType` string (confirmed by
direct read of `task-workspace.ts` lines 11-24). **PASS.**

## Option counts / answer controls
`source-selection.ts`'s `mountSelection`/`gradeSelection` render from `content.options`/
`content.questions` — the option count on screen is whatever the generated content actually
contains, never a hardcoded exam-specific number. **PASS** structurally; whether the *generated*
option count matches the profile's own `constraints.optionCount` is a validator-layer concern
already covered by `german_exam_validator.py` (Phase 3) and exercised by the passing
`test_german_exam_reading_validator.py`/`test_german_exam_language_elements_validator.py` suites.

## Timers (preparation/response)
- Speaking: `mountSpeaking` implements `idle → permission → preparing (if
  `part.constraints.preparationSeconds`) → recording → preview → submitting → submitted/error`,
  with `hideSourceAfterPreparation` gating source visibility — read directly from
  `speaking-task.ts` and confirmed by `audit/testdaf-offline/REPORT.md`'s T4/Phase-6-preflight
  sections. **Confirmed gap (already documented, re-confirmed here by this audit's own read):**
  `sprechen_4`/`sprechen_6` (TestDaF) require a source-viewing/listening phase *before*
  preparation that this state machine does not implement — there is no `sourcePhase` state.
  **DELIVERY GAP**, correctly still `available=False` for both parts, not fixed in this pass (per
  the original task's constraint against building new architecture speculatively).
- Full-exam module timer: `exam-session.ts`'s `tick()`/`remainingModuleSeconds`, driven by
  `DeliveryPolicy`, fake-clock-unit-tested per T6. **Not wired into the free-practice UI**
  (`exam-workspace.ts`) — confirmed still true by grep (`grep -n "ExamSession" frontend/js/features/german-exam/exam-workspace.ts` → no match). This is a known, already-documented release
  blocker (T6), not new.

## Submission / answer state / reset / teardown
- `media-task.ts` line 112: teardown aborts its `AbortController`, pauses the media element,
  clears `src`, calls `.load()` to release the browser's decode buffer, and clears the DOM —
  confirmed by direct read. **PASS** — matches REPORT.md T2's claim ("Media teardown aborts
  listeners, pauses playback and clears URLs").
- `task-workspace.ts`'s `open()` function: increments an `epoch` counter, aborts the previous
  `AbortController`, disposes the previous renderer, and — critically — verifies the returned
  envelope's `exam.profileId`/`profileVersion`/`module`/`part.id`/`part.taskType` all match what
  was requested (`if (... !== ...) throw new Error('Exercise identity mismatch')`) **before**
  rendering. This is the single most important guard against stale cross-exam state: even a
  slow/out-of-order network response cannot render into the wrong exam's slot. **PASS, directly
  confirmed by code read.**

## Exam/part switching (TELC→Goethe, Goethe→TestDaF, TestDaF→TELC) — stale-state leakage
`tests/e2e/33-german-exam-profile-switch.spec.ts` (131 lines, read in full, not executed — no
Playwright browser/dev-server run in this pass) asserts, for **TELC↔Goethe only**:
- Switching profiles rebuilds the exam navigation live, no page reload (a `__staleMarker` window
  property survives the switch, proving no reload occurred).
- Sprachbausteine is *absent* for Goethe (not disabled, not empty) — correctly modeled as "this
  module doesn't exist for this exam," matching `goethe_c1.py`'s structural absence of a
  `language_elements` key.
- Opening a not-yet-generatable Goethe part never falls through to TELC's reading view, and no
  `generate` request carries `profileId: "telc_c1_hochschule"` while Goethe is the active profile.
- The manifest request itself never leaks a profile identifier client-side (`expect(body).not.toMatch(/profileId|telc|goethe/i)`) — the server resolves the exam from the **saved** profile, never
  from anything the client requests, closing an entire class of "client asks for the wrong exam"
  bugs by construction.

**Gap found (this audit, not previously flagged in the T-checkpoint history I read):** this spec
file covers **TELC↔Goethe switching only** — it never exercises a switch involving
`testdaf_digital`. Given TestDaF is a third real, registered profile (`GERMAN_EXAM_PROFILES`
includes it, `resolve_profile_id` can return it, `tests/e2e/fixtures/german-exam-manifests.json` is
generated from all three real profiles per T1's "regenerated from the updated profile" pattern),
the same identity/stale-navigation guarantees this spec proves for TELC↔Goethe are **UNVERIFIED at
the e2e level for any transition involving TestDaF** — the frontend code path is identical
(`task-workspace.ts` has no profile-specific branch, so there is strong structural reason to expect
it behaves the same), but this audit did not find or run a test that actually exercises
`TELC↔TestDaF` or `Goethe↔TestDaF` switching. Recorded as a **DELIVERY_AUDIT gap → routed to
MANUAL_REVIEW.md / Phase 12 test gap**, not fixed in this pass (adding a new e2e spec was judged
out of scope for a documentation-only audit that explicitly should not touch/extend browser specs
beyond reading them, per the task's own instruction to "read/run it, don't rebuild it").

## Result display
`module-result.ts` — no combined pass/fail, no TDN/scaledScore key leakage (Phase 5). **PASS.**

## What this phase did NOT do (reduced depth, stated explicitly)
- Did not install Playwright browsers or start a dev server to actually run
  `33-german-exam-profile-switch.spec.ts` or any other `tests/e2e/*.spec.ts` file — read only.
  Frontend **unit** tests (`node scripts/run-unit-tests.mjs`) and **typecheck**
  (`npx tsc -p frontend/tsconfig.json`) **were** run (see Phase 12 / final report) — those don't
  need a browser.
- Did not manually drive the app in a real browser at all (no `run` skill invocation) — this audit
  relied entirely on static code reading plus the already-existing, already-passing test suites,
  consistent with the task's explicit allowance for this phase.
