# Offline Digital TestDaF implementation checkpoints

No live qualification, provider calls, media generation, inventory writes, or release flags are authorized in this phase.

## Foundation
Saved profile ID is authoritative in backend and frontend. Unknown saved IDs fail closed in the backend; legacy resolution only applies without a saved ID. Profile edits preserve the explicit variant when the legacy target is unchanged. 23 backend and 32 frontend tests passed. Commit 46d4e860.

## T1 checkpoint
Reusable speech-act matching, category assignment, grouped candidate selection, and lexical cloze now have generator contracts, deterministic validators, independent source-only audit contracts, bounded source-preserving repair, practice grading, and production reading renderer dispatch. Offline fixtures deliberately test mechanics, not language quality. Test results: 69 new backend cases, 58 profile/manifest/MC regressions, 6 browser/MC checks; frontend typecheck passed.

All seven reading parts remain disabled. Existing reading MC retained. No official scale conversion.

### Paused tasks ? official information required
- lesen_2: current itemCount=4. Official demo page 6 presents five movable paragraphs. Need official explanation of how these yield four scored items before implementing raw grading. Do not assume fixed first paragraph or adjacent-pair scoring.
- lesen_7: current constraints contain only itemCount=3. Official demo pages 14?15 require text AND graphic; profile lacks that source requirement. Requested confirmation before adding it. Error candidates must not be confused with three erroneous sentences.

Source: https://www.testdaf.de/fileadmin/testdaf/downloads/Demo_Version_digitaler_TestDaF/Beispielaufgaben_Demo-Version_digitaler_TestDaF.pdf

All editable exam facts remain in german_exams/testdaf_digital.py. Fixture copies are test data, not runtime configuration.

## T2 checkpoint
All seven listening interaction contracts implemented: overview short answers, grouped notes, summary sentence errors, video speaker categories, video outline notes, multiple choice, and aligned spoken/displayed words. Script generation is independent of media delivery; generator-supplied assets are rejected. Explicit answer variants and profile normalization only, with no semantic-equivalence claim. Source-only audits require coverage and reject ambiguity, unsupported keys, outside knowledge and implausible distractors.

A shared task workspace now dispatches renderers from manifest task types and rejects stale/mismatched envelopes. Media teardown aborts listeners, pauses playback and clears URLs. Summary reveal-after-media is profile-driven. Video uses a video element, never audio substitution. 100 backend cases and 7 mocked browser media cases passed; existing 8 workspace tests passed; frontend typecheck passed.

Release blockers: all parts need live linguistic qualification. All listening parts need playable, script-aligned media delivery. Video acquisition/generation is not implemented. Short-answer variants are practice scoring only, not a replacement for official human assessment. No paid media calls occurred.

## T3 checkpoint
Both writing task types have content generation/validation, editor, word guidance/count, timer, local draft recovery, submission lifecycle and injectable practice-feedback contracts. Structured graphics render accessible tables. Grader output rejects invented official scores, wrong dimension coverage, wrong word counts and fabricated learner quotes. 26 backend tests and two browser tests passed. Draft identity includes account, profile/version, part and generation identity.

Remaining implementation: connect the injected productive grader to the authenticated production grading service. Current default fails visibly and preserves the draft; no fake success or fake grading. This is a release blocker in addition to live qualification.

## T4 checkpoint
All seven speaking task types (spoken_advice, spoken_option_comparison, spoken_text_summary, spoken_information_comparison, recorded_topic_presentation, spoken_argument_response, spoken_measure_critique) reuse the same generic productive-task contract as writing: `generate_productive`/`grading_request`/`grade_productive`/`validate_feedback` in `german_exam_productive.py` now branch on `SPEAKING_TYPES` for recording-duration validation (bounded by `speakingSeconds`, rejects non-finite/negative/over-limit/NaN) and evidence timestamps (`startSeconds` must fall inside the submitted recording) instead of word counts and text quotes. `german_exam_speaking.py` dispatches TestDaF's seven task types straight to `generate_productive`, leaving the existing TELC/Goethe `sprechen_1`/`sprechen_2` part_id-based generator untouched.

One generic speaking renderer (`frontend/js/features/german-exam/speaking-task.ts`, `mountSpeaking`) drives all seven from part constraints: microphone permission request, optional preparation countdown (source hidden during preparation when `hideSourceAfterPreparation`), recording with elapsed/remaining countdown, automatic stop at `speakingSeconds` when `recordingPolicy.autoStop`, manual stop only when `manualStopAllowed`, audio preview, retry gated by `retryAllowed`, upload, submission with injectable grader, and failure handling that preserves the recording for retry instead of discarding it. All dependencies (getUserMedia, MediaRecorder, upload, grader, clock) are injectable for tests; no real speech/model call is made. `spoken_information_comparison` and `spoken_argument_response` require a `script` (spoken) source; since no TTS audio exists in this offline phase, their fixtures correctly leave `media.audioUrl` unset, and the renderer disables recording with a visible "Source audio unavailable" status rather than allowing a task with no audible material.

TestDaF-specific speaking facts (speakingSeconds, preparationSeconds, hideSourceAfterPreparation, requiredSourceKinds, sourcePages, recordingPolicy) remain centralized in `testdaf_digital.py`; `recordingPolicy` is injected once by the shared `_part()` helper for every speaking part (practice policy, not an official exam rule — noted in a source comment). `task-workspace.ts` registers the seven speaking task types against `mountSpeaking` through the same manifest task_type -> renderer registry as writing/media/selection types; no new page/component was built per task type.

33 backend tests (`test_german_exam_productive.py`, including the new speaking-duration/evidence/generation/dispatch cases across all 7 speaking parts) and 8 browser tests (`speaking-task-browser.spec.mjs`: recording lifecycle incl. preparation countdown, auto-stop, manual-stop gating, retry, upload/grading failure recovery, teardown, and the missing-policy guard) passed. Regenerated `tests/e2e/fixtures/german-exam-manifests.json` from the updated profile (manifest fixture is generated, not hand-edited). Frontend typecheck passed; no regression in TELC/Goethe speaking or writing suites.

All seven speaking parts remain `available=False`. Release blockers: no real transcription/grading yet (contracts and fixtures only); no real speech-source audio pipeline for the two script-based comparison tasks (audio generation is out of scope for this phase); live linguistic qualification still required for every part.

Preparation-phase sequencing for `spoken_information_comparison` (two-source comparison with no stated preparationSeconds in the cited demo) and the exact multi-phase structure implied by some tasks (e.g. listen-then-respond ordering) are represented as a single recording pass per the existing shared productive-task/recording contract; if the official demo specifies a distinct multi-phase interaction (e.g. separate listen phase before a timed response), that would need official confirmation before changing the shared contract — not assumed here.
