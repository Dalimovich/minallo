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
