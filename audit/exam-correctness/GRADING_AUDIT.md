# Phase 5 — Grading Audit

Traces task output → answer key/submission → grader → score/feedback → frontend result for every
task that has grading, across the three exams.

## Objective tasks (reading/listening MC, matching, cloze, etc.)
Grading is client-side, deterministic, answer-key-based: `source-selection.ts`'s `gradeSelection()`
compares the learner's selected `answerId` per question against the generated content's own
`answerId` field (the same content object the generator produced — there is no separate,
independently-fetched answer key that could drift from the displayed question). This is identical
across all three exams' `SELECTION_TYPES` task types — genuinely shared, profile-agnostic code, no
per-exam branch. **PASS** for answer interpretation/score calc mechanics (right/wrong per item,
percent = correct/total via `practice_raw_result`), for every exam that reaches this renderer.
Whether a specific item's *designated* answer is the linguistically correct one is a content
question, not a grading-mechanics question — covered in CONTENT_AUDIT.md, not here.

## Writing
- **Grading-dimension sourcing**: `german_exam_writing_grading.py`'s `_DIMENSION_SCORE_KEYS` dict
  maps rubric dimension *names* (not profile ids) to `writing_coach.analyse_writing()` score axes —
  confirmed by direct read to include both TELC's dimension set
  (`task_fulfilment`/`correctness`/`repertoire`/`communicative_design`) and Goethe's
  (`task_fulfilment`/`coherence`/`vocabulary`/`structures`) as *distinct, independently-keyed*
  entries. No profile-id branch anywhere in this file (grep confirms). **PASS — no cross-exam
  leakage found** in dimension-to-score-axis mapping.
- **Banded vs continuous scoring**: chosen by `ScoringSpec.band_fractions` field presence (Goethe
  has it, TELC doesn't) — a structural signal, not a profile-id check. **PASS**.
- **Disclosed approximation, not fabrication**: `_BAND_THRESHOLDS` (the continuous-0-100 →
  A-E-band quintile cutoffs used only when `band_fractions` is set, i.e. only for Goethe today) is
  explicitly commented as "NOT sourced from an official Goethe cut-point table (none is published
  for continuous AI scores)... an explicit, clearly-labeled approximation." This is honest
  disclosure of an UNVERIFIED mapping, correctly not presented as an official fact. Flagged here as
  **UNVERIFIED (band-threshold approximation)**, not as a bug — the code already labels it as such.
- **Production wiring gate (real gap, unchanged from prior audit)**: `routers/german_exam.py` line
  203 (`POST /german-exam/grade-writing`) hard-501s any `task_type != "choice_long_form_writing"`.
  TELC's `schreiben_1` uses exactly that task type → **reachable**. Goethe's `forum_discussion_post`
  / `formal_context_message` and TestDaF's `argumentative_essay` / `text_graph_summary` do not
  match → **not reachable via this endpoint today**, confirmed by direct code read (not a live
  call). The generic, profile-agnostic `grade_productive(part, content, submission, grader=...)`
  contract in `german_exam_productive.py` exists and is unit-tested but is **never imported or
  called from any router** (confirmed by grep — `grep -rn "grade_productive" app/routers/` returns
  no matches). **GRADING GAP: Goethe and TestDaF writing have a working grading engine
  (`grade_productive`) with no route wiring it to production.**

## Speaking — TELC (interactive) vs TestDaF (independent recording)
- **TELC**: `german_exam_speaking_practice.py` implements a real interactive AI-partner dialogue
  model, with a working `transcribe()` (gpt-4o-mini-transcribe) and grading against
  `SPEAKING_TASK_MAXIMA`/`SPEAKING_LANGUAGE_MAXIMA` (both imported directly from
  `telc_c1_hochschule.py` — correctly TELC-specific, see IMPLEMENTATION_AUDIT.md's Phase 9
  section). Routed at `POST /german-exam/speaking`, whose `SpeakingPracticeRequest.profileId` is
  `Literal["telc_c1_hochschule"]` — **reachable for TELC only, by explicit type-level design**.
- **Goethe**: no speaking-grading route exists anywhere in `routers/german_exam.py` for Goethe's
  `presentation_with_followup`/`guided_pair_discussion` — confirmed by grep for
  `guided_pair_discussion`/`presentation_with_followup` across `app/routers/*.py`: zero matches
  outside the profile/task-type registry files. **GRADING GAP: Goethe speaking has no grading
  implementation and no route — a distinct gap from TestDaF's** (Goethe's is "nothing built yet
  for a TELC-shaped interactive model that might fit Goethe's pair-discussion format"; TestDaF's is
  architecturally different, see below).
- **TestDaF — represented exactly as this task instructs, not fabricated, not a TELC/Goethe
  workaround**: TestDaF's speaking model is 7 independent, non-interactive parts submitted as
  `{recordingId, durationSeconds}` (confirmed directly in `german_exam_productive.py`'s
  `grading_request()`, lines 48-53: for any task type in `SPEAKING_TYPES`, it validates
  `recordingId`/`durationSeconds` only — no partner-turn/dialogue state anywhere). Feedback is
  **qualitative-only by structural enforcement**: `validate_feedback()` line 60 explicitly raises
  `ValueError("official score not permitted")` if the feedback dict contains any of
  `scaledScore`/`tdn`/`pass`/`officialScore`/`rawScore` — a numeric TestDaF speaking score is not
  just unimplemented, it is **structurally forbidden by the contract itself**. No grader adapter
  exists that calls this contract for TestDaF speaking (no TestDaF-speaking-specific grader file
  found; `german_exam_speaking.py` only implements *generation*, confirmed by direct read — its own
  docstring says "Generated speaking tasks only. Learner turns are evaluated separately," and no
  such "separately" evaluator exists in this codebase for TestDaF). **Classified exactly as
  instructed: IMPLEMENTATION GAP / GRADING CAPABILITY MISSING — not a numeric score, not forced
  into TELC's interactive model, not a content-quality issue.**

## Frontend result rendering — module-separation guarantee
`module-result.ts`'s `renderModuleResult`/`renderExamResultSummary` never render a combined
PASS/FAIL and never render a `tdn`/`scaledScore` key on a productive result (defensive check
confirmed by direct read of `validateModuleResult`). This correctly prevents a UI-level
fabrication of a TestDaF numeric speaking score even if a future grader mistakenly tried to smuggle
one through — a second layer of protection beyond the backend's `validate_feedback` refusal.
**PASS.**

## Summary of grading gaps found (all pre-existing, all confirmed by direct code read, none newly
introduced or fixed by this audit)
1. Goethe writing: grading engine exists (`grade_productive`), no route wires it in.
2. TestDaF writing: same — grading engine exists, no route wires it in.
3. Goethe speaking: no grading implementation and no route at all.
4. TestDaF speaking: **architecture gap** — the submission/feedback contract exists and correctly
   forbids fabricated scores, but no grader adapter/route exists to actually produce feedback.
   Structurally distinct from #3 (Goethe has nothing to plug in yet; TestDaF has a contract with
   nothing behind it).
5. `_BAND_THRESHOLDS` (Goethe writing banding) is a disclosed, non-official approximation —
   correctly labeled as such in the source, not a hidden fabrication, but still UNVERIFIED against
   any official cut-point table.

## 2026-10-04 follow-up — #1, #2 and #4 resolved; #3 (Goethe speaking) audited, confirmed still blocked

**#1/#2 resolved**: `goethe_c1`/`testdaf_digital` added to `GRADABLE_WRITING_PROFILE_IDS`
(`german_exam_writing_grading.py`); `POST /german-exam/grade-writing` now routes both. **#4
resolved for TestDaF**: `german_exam_testdaf_speaking.py` now has a real grader
(`grade_testdaf_speaking_transcript`) plus a no-storage transcription transport
(`transcribe_testdaf_speaking_recording`) and a dedicated route (`POST
/german-exam/grade-speaking-recording`), verified end-to-end through the real
`grade_productive()`/`validate_feedback()` contract. Availability was not touched by either fix
(still gated by `PartBlueprint.available`, separately).

**#3 (Goethe speaking) re-audited, not resolved — two distinct blockers found, not one:**

1. **Per-criterion point weights — confirmed still absent**, exactly as this file and
   `MANUAL_REVIEW.md` item 2 already stated: `goethe_c1.py`'s own comment above
   `_GOETHE_C1_SPRECHEN` reads "Per-criterion point weights are in the Modellsatz Prüferblätter
   and are added when Sprechen is implemented" — that document is not in this repository, and
   `GOETHE_C1.source_reference` cites only the Handbuch + Durchführungsbestimmungen PDFs, never a
   Prüferblätter/Modellsatz source. Per `MANUAL_REVIEW.md`: "if not available, this must stay
   UNVERIFIED indefinitely, not guessed." Confirmed: still not guessed, still absent.

2. **New finding — TELC's interactive turn-sequence does not obviously fit Goethe's own timing,
   independent of the weights question**: `german_exam_speaking_practice.py`'s `grade_speaking()`
   hardcodes a 9-step required sequence (`presentation → own_followup[partner,learner] →
   partner_presentation → summary → questions → partner_answer → discussion[partner,learner]`) —
   i.e. the learner also LISTENS to a simulated partner's own presentation and must summarize it
   before asking it follow-up questions. `OFFICIAL_SPEC_MATRIX.md`'s Goethe Sprechen row gives
   sprechen_1 (`presentation_with_followup`) a budget of "~5 min presentation, ~7 min total" —
   only ~2 minutes beyond the presentation itself, which does not obviously leave room for a full
   extra "listen to and summarize a second presentation" phase on top of "anschließende Fragen"
   (the task's own title: presentation WITH follow-up questions, not WITH a partner's presentation
   too). This is a genuine structural question distinct from the point-weights gap: even with
   official weights in hand, reusing TELC's exact `STAGES`/required-sequence for Goethe without
   confirming it against the Handbuch's own Sprechen section (pp.39-42, cited in
   `OFFICIAL_SPEC_MATRIX.md` but not transcribed turn-by-turn in this repo) risks inventing exam
   structure Goethe doesn't actually have. Both `german_exam_speaking_practice.py` (turn sequence,
   stage labels, `get_profile("telc_c1_hochschule")` hardcoded directly inside `grade_speaking()`)
   and its frontend counterpart `speaking-workspace.ts` (German UI labels naming TELC's specific
   Teil 1A/1B stages, `profileId: 'telc_c1_hochschule'` hardcoded in `save()`) are TELC-specific
   enough that generalizing either is a real architecture change, not a profile-id parameterization.

**What is already safely reusable once both are resolved (no new code needed now, confirmed by
direct read)**: the qualitative-only `practice_feedback`/`validate_feedback()` contract
(`german_exam_productive.py` — already enforces "no official score" generically, for ANY task
type); `renderFeedback()`/`module-result.ts` (frontend — already refuses to render a
tdn/scaledScore for a non-TELC result, confirmed PASS above); the whisper-based transcription
transport built for TestDaF (`transcribe_testdaf_speaking_recording`) if segment-timestamped
evidence is ever wanted for Goethe too, or TELC's simpler existing `transcribe()` if it isn't.

**Still correctly blocked, confirmed unchanged**: `guided_pair_discussion`/
`presentation_with_followup` remain outside `SPEAKING_TYPES`, outside
`GRADABLE_SPEAKING_PROFILE_IDS`, and outside `GRADABLE_SPEAKING_RECORDING_PROFILE_IDS`; both
Goethe speaking parts remain `available=False` (frozen allowlist test unchanged). No code was
changed for Goethe speaking in this pass — see the regression tests added to
`test_german_exam_goethe_sprechen.py` and `test_german_exam_grading_router.py` that pin this
exactly, so a future session attempting either generalization sees these tests fail and knows to
read this section first, rather than re-diagnosing from scratch.

**Next steps, in order, once unblocked**: (a) source the Modellsatz Prüferblätter, or decide
to go qualitative-only like TestDaF's speaking feedback (sidesteps the weights question
entirely); (b) independently confirm Goethe's actual Sprechen turn-by-turn structure from the
Handbuch's pp.39-42 (not just the summary-level timing already transcribed) before writing any
interactive grading/turn-sequence code.
