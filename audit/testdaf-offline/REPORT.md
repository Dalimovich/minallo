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
