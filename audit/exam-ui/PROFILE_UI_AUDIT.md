# German exam UI — profile-driven correctness audit

Date: 2026-09-23. Scope: verify that the profile-authoritative fix in `46d4e860`
actually holds end-to-end through the exam workspace UI for all three exam
profiles (`telc_c1_hochschule`, `goethe_c1`, `testdaf_digital`), per the task
in this branch. Audit-first, then fix, per project convention.

## Path traced

1. **Saved profile resolution** — `backend/python-ai/app/services/german_learner_profile.py`
   (AI surfaces) and `backend/lib/german-learner-profile.ts` (edge/TS
   endpoints). Saved `german_exam_profile_id` wins when it is a known id;
   unknown ids fail closed (`null`), never a guessed fallback. Correct and
   unchanged by this task — this is the `46d4e860` fix, already applied to
   `main`.
2. **Manifest fetch** — `frontend/js/features/german-exam/exam-workspace.ts`
   `fetchManifest()` calls `POST /api/ai/german-exam/manifest` with an empty
   body (`{}`). The client sends **no profile id**; the server resolves the
   caller's saved profile itself. `fetchManifest` also refuses a manifest
   whose echoed `profileId` doesn't match the envelope's own `manifest.profileId`
   (`manifest_mismatch`), so a server bug can't quietly serve one exam's
   manifest under another's label.
3. **Module/part list construction** — entirely server/manifest-driven.
   `buildNavModel()` maps `manifest.modules` directly; nothing in
   `exam-workspace.ts` or `task-workspace.ts` special-cases a profile id.
   Confirmed by an existing regression test
   (`tests/frontend/german-exam-workspace.test.mjs`, "the workspace has no
   exam-specific branching...") that asserts the source contains no
   `"goethe_c1"`/`"telc_c1_hochschule"` literals.
4. **Renderer selection** — `task-workspace.ts` dispatches purely on
   `part.taskType` via the `TASK_RENDERERS` map (built from
   `media-task.ts`/`productive-task.ts`/`speaking-task.ts`/`source-selection.ts`
   task-type tables). No `if (profileId === …)` branch exists anywhere in the
   renderer path. A button is disabled whenever `!part.implemented ||
   !TASK_RENDERERS[part.taskType]` — this is also what keeps an
   `available=False` part inert even if a taskType renderer exists for it
   (the manifest's `implemented` flag, not the renderer table, is the gate).
5. **Availability display** — `applyDom()` in `exam-workspace.ts` hides a
   skill card entirely when the manifest has no such module
   (`card.hidden = !nav`) and marks it "coming soon" when the module exists
   but has zero generatable parts. There is no code path where an
   unavailable/missing part is silently replaced by a same-slot part from a
   different exam — the nav model is rebuilt fresh from `state.manifest` on
   every render, and `state.manifest` is only ever the just-fetched profile's
   own manifest (never merged with a previous one).
6. **Task/timer/TTS/prefetch state** — `createExamWorkspace()`'s `run()`
   drops the previous profile's `state.manifest`/`state.profileId`
   synchronously the moment the saved-selection key changes (`wanted !==
   key`), calls `hooks.onProfileChange(prev, null)` (wrapped in `safe()` so a
   throwing reset hook can't block the switch), and only then starts loading
   the new manifest. `practice.js`'s per-module state objects (`rd`, `sb`,
   `ls`) each independently compare their cached `profileId` against
   `rdResolveProfileId()`/`sbResolveProfileId()`/`lsResolveProfileId()` on
   every render tick and reset `usingGenerated`/`profileId`/`profileVersion`/
   `generationId` the moment they diverge — this is the mechanism that clears
   stale generated content, prefetch (`lsPrefetch`), and (for `ls`, the
   listening view) TTS/audio between profiles.
7. **Stale-response protection** — two layers, both already generic:
   - Manifest level: `createExamWorkspace()` uses a monotonic `seq` +
     `AbortController` (`pendingAbort`); a response is applied only if
     `mine === seq && wanted === key`, and is aborted otherwise. Cache is
     keyed by the saved-selection string (e.g. `"TestDaF|TDN 4"`), not by
     profile id, so a switch away and back always re-validates against the
     current saved selection.
   - Task level: `task-workspace.ts`'s `mountTaskWorkspace()` uses its own
     `epoch` counter + `AbortController` per `open()` call; a task response
     is discarded if `mine !== epoch`, and the envelope's echoed identity
     (`profileId`, `profileVersion`, `module`, `part.id`, `part.taskType`) is
     checked against the manifest before rendering, so even a same-epoch
     cross-exam mismatch throws instead of rendering.

## Grep for hardcoded per-profile UI branches

`grep -rn '"telc_c1_hochschule"\|"goethe_c1"\|"testdaf_digital"' frontend/js
frontend/views` (plus the equivalent `===` form) turns up matches only in:
- `frontend/js/features/auth/german-profile.ts` — the registry table itself
  (this **is** the legitimate, single place profile ids are enumerated on the
  client; not a UI branch).
- Test fixtures/tests (`tests/frontend/*.test.mjs`, `tests/e2e/fixtures/*`) —
  expected, these assert against real ids.

No `if (profileId === 'goethe_c1') { … }`-style UI branch exists in
`exam-workspace.ts`, `task-workspace.ts`, `media-task.ts`,
`productive-task.ts`, `speaking-task.ts`, `source-selection.ts`, or
`practice.js`. **Verdict: nothing to genericize — the workspace was already
built profile-agnostic** across the TestDaF T1-T8 work and the `1418f9a3`
merge (which kept the cache/sequencing/abort-race-protection controller from
one branch and the manifest-driven task-mounting from the other; neither side
reintroduced per-exam branching).

## Test coverage already in place (pre-existing, this branch only extends it)

`tests/frontend/german-exam-profile-switch.test.mjs` already drives the
harness through **Goethe → TestDaF → TELC** and TELC→Goethe with fake
manifests for all three profiles, and separately proves: immediate stale-state
clear, part/module list correctness per profile, race protection (superseded
requests are aborted and their late responses discarded and never cached),
throwing-reset-hook safety, cache-hit reuse for repeated events, and
error/unsupported states never leaking the previous exam's structure.
`tests/frontend/german-exam-workspace.test.mjs` covers nav-model construction,
availability blocking, and the "no hardcoded profile id in this file" guard.
This is a large majority of the task's 21-item checklist and did not need to
be rebuilt — see the final report for the item-by-item mapping.

## The one real, confirmed gap: registry mirror drift

`backend/lib/german-learner-profile.ts` (`EXAM_PROFILE_REGISTRY`) and
`frontend/js/features/auth/german-profile.ts`
(`GERMAN_EXAM_PROFILES_CLIENT`) — the two client/edge mirrors of the backend's
`GERMAN_EXAM_PROFILES` registry (`backend/python-ai/app/services/german_exams/registry.py`)
— were **missing `testdaf_digital` entirely**. This matches the prior audit
finding cited in the task. Confirmed via
`tests/backend/german-learner-profile.test.mjs`, which already asserts
mirror-completeness against every `<exam>.py` file's `profile_id`
(`registry mirrors the Python exam registry (same ids)` — this test was
passing only because it checks id presence, not full-row equality) and a
second, stricter test (`edge and browser registries mirror the Python
registry (id, family, legacy levels)`) that failed once its extraction regex
was made robust enough to read `testdaf_digital.py`'s single-line
`ExamProfile(profile_id=..., family=..., ...)` constructor call (the other two
exam files put `family=` on its own line; `testdaf_digital.py` does not —
whitespace-only difference, not a content change).

**Impact of the gap**: `resolveGermanExamProfileIdClient()` / `resolveGermanExamProfileId()`
still worked correctly for `testdaf_digital` whenever a caller passed the
saved id explicitly (both functions prefer an explicit `savedProfileId` before
falling back to family/level lookup — this is the `46d4e860` contract, and it
degrades gracefully to "pass the id through unchanged" for ids the local
table doesn't know about). So the gap was not user-visible for the
profile-authoritative path today. It *would* have surfaced the moment any
caller needed the client mirror to answer "does this profile id exist / what
family is it" without an explicit id in hand (e.g. any future onboarding or
Profile-page UI that lists `testdaf_digital` as a selectable option by
iterating the client table). Fixed in this branch (see report).

## Onboarding — TestDaF specifically has no legacy-resolution path

`testdaf_digital`'s `legacy_level_values` is deliberately empty in
`testdaf_digital.py` ("TDN alone does not distinguish digital from
paper-based TestDaF"). `frontend/js/features/auth/onboarding.ts` calls
`resolveGermanExamProfileIdClient(_obTest, _obLevel)` with **no third
(`savedProfileId`) argument**, so a fresh learner picking TestDaF + any TDN
level during onboarding gets `german_exam_profile_id: null` — never
`testdaf_digital` — by design of the existing (test, level) → profile
mapping, not a bug introduced or found in this task. Onboarding has no UI
field to distinguish "digital" vs "paper-based" TestDaF at all today. This is
correctly conservative (never silently assumes digital), but it does mean
TestDaF onboarding cannot reach the `testdaf_digital` manifest through any
existing UI path — see the final report's "not fixed" section; adding that
distinction is an onboarding-form scope question, not a manifest/workspace
bug, and doing so would mean inventing UI structure this task's hard
constraints don't authorize.
