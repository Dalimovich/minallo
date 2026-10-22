# Current-state reconciliation (post-audit)

Baseline: the frozen `audit/exam-correctness/*` documents (not edited). This file records what changed
afterwards, on branch `chore/zero-cost-correctness` (from main `c735ce11`). Zero AI/API calls were made.
Status values: FIXED, PARTIALLY_FIXED, STILL_OPEN, BLOCKED, UNVERIFIED. Code existing is never PASS.

| # | Audit finding | Status now | Evidence |
|---|---|---|---|
| 1 | TestDaF speaking task_types registry stale | FIXED | `c3554275` flipped the registry; `available` stays False on all parts |
| 2 | No TestDaF profile-switch e2e | PARTIALLY_FIXED | `e6085a38` added TELC<->TestDaF and Goethe<->TestDaF cases in spec 33 (5 tests list under Playwright). Not executed: no E2E login credentials in this environment |
| 3 | Toast stacked under Profile modal | FIXED | `e4f058c4` mounts toast stack on `document.body`; `c735ce11` bumps stale loader CSS versions. Spec 34 not executed (same credentials gap) |
| 4a | TestDaF writing grading route unreachable | PARTIALLY_FIXED | Task-type gate opened earlier (`fix/testdaf-grading-gating`). This branch fixes two remaining deterministic bugs: the route only accepted a TELC two-statement topic (now accepts a validated `productive-task-v1` `task` for non-TELC parts, in python-ai and the edge function), and the adapter silently reused another axis for unmapped dimensions and defaulted to a 48-point scale (now: no signal, no scale when `scoring is None`). STILL OPEN: the frontend productive renderer's default grader throws "not connected"; nothing in the UI calls `/grade-writing` for TestDaF |
| 4b | Goethe writing grading route | STILL_OPEN (intentional) | Goethe is deliberately absent from `GRADABLE_WRITING_PROFILE_IDS`; unchanged, still 501 |
| 4c | TestDaF/Goethe speaking grading | BLOCKED | Route locked to `telc_c1_hochschule`; no `recordingId` grader exists. Deferred by decision (needs live qualification) |
| 5 | QA harness grading reachability table stale | FIXED | writing reachability now derives from `gradable_writing_task_types()`; test updated |
| 6 | TELC Sprechen 16 vs 11 min | FIXED (was a summing error) | Handbuch pp.47-50: 20 min prep; pair exam ca. 16 min; Teil 1A ca. 3 min and 1B ca. 2 min per participant; Teil 2 ca. 6 min. 2x(180+120)+360 = 960 s. Profile was already correct; regression test added |
| 7 | Availability default is True | PARTIALLY_FIXED | `PartBlueprint.available` still defaults True (value untouched). New frozen-allowlist test fails on any availability change, and proves implemented task types alone cannot serve a blocked part or mark it `implemented` in the manifest |
| 8 | No video storage path | PARTIALLY_FIXED | Private `generated-video` bucket migration (NOT applied), config, validated upload and https-only signed URL helpers. BLOCKED on content: nothing produces or sources a video |
| 9 | Sprechen 4/6 source phase (view/listen before preparation) | BLOCKED (spec) | Public TestDaF pages document only the paper test's flow. Skip/replay/auto-start of digital playback is not documented, so nothing was implemented |
| 10 | Real content quality, all 44 parts | UNVERIFIED | Requires live qualification after credits are restored |
| 11 | TestDaF Hören 7 phonetic realism, Hören 4/5 video realism, TELC partner responsiveness | UNVERIFIED | Human review needed |
| 12 | Qwen TTS infrastructure | NOT TOUCHED | The qwen-tts working-tree edits belong to a parallel session and were left alone; no Qwen call made |
| 13 | Playwright execution | BLOCKED | Needs `E2E_EMAIL`/`E2E_PASSWORD`. Chromium is installed, specs compile, generation is mocked in spec 33 so a run costs no AI credit |

## Official facts verified this pass
- TELC C1 Hochschule Sprechen: 20 min prep; pair ca. 16 min, trio ca. 24 min; Teil 1A ca. 3 min, Teil 1B ca. 2 min per participant; Teil 2 ca. 6 min; points 1A=6, 1B=4, Teil 2=6, language=32.
  Source: telc Handbuch (telc.net .../Deutsch_c1_hochschule_Handbuch.pdf), pp.47-50.
- Not verified: Goethe Sprechen criterion weights, the `_BAND_THRESHOLDS` approximation, TestDaF raw-to-scaled conversion.

## Release gate
Zero parts outside the 10 TELC parts are available. Nothing here changes an `available` value, writes inventory, or enables a task.
