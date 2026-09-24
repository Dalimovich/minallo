# Final frontend follow-up review

## Verification after a54d787 (September 11)

The eligibility fix now preserves saved stable scope before consulting the current source library and permits unrelated questions with incomplete viewer identity. Eleven relevant scope/eligibility/capture tests pass. The actual Playwright browser harness also exits successfully with eight synthetic-backend UI journeys, including switch-before-submission; the former switch assertion was a render-frame timing issue. Run evidence: `audit/browser-review-run.log` and regenerated `audit/repros/browser-results.json`.

One P1 remains: `streamAiReply:1497` still requires the original PDF for *every* resumed request whose snapshot contains an activeDocumentId. Internet requests record incidental PDFs too. Closing that PDF after interruption causes `original_pdf_context_unavailable` before persistence/HTTP, despite no page evidence requirement. `audit/repros/incidental-viewer-resume.test.mjs` invokes actual `streamAiReply` plus actual eligibility with explicit rendering/persistence seams: the Internet retry test fails; the paired required-visible-page protection passes (1 passed, 1 failed). This executes the orchestration gate and stops at the persistence boundary; it does not claim live model/backend verification.

The findings below describe the pre-a54d787 state; their eligibility portions are now fixed. The incidental PDF resume guard remains actionable.

Read-only follow-up of submitted scope, retry and optional viewer handling. Production function execution used the existing `shellRuntime` helper to extract/transpile `ragEligibility`; HTTP and browser were not involved. No production files changed by this reviewer.

## P1: Saved retry scope is restored after a mutable eligibility gate

`shell.ts:1476` calls `ragEligibility` before restoring the saved grounding request at line 1483. Eligibility resolves selected IDs against the current `sourceLibrary.items` at line 3127. When a persisted selected source is absent from that library (deleted, not loaded yet, or no longer imported), the specific-files branch returns null at line 3237. The original stable document IDs already stored in `requestSnapshot.groundingRequest` never reach the backend.

Executable observation: real `ragEligibility([{role:'user',text:'Explain torque'}], {selectedSourceIds:['deleted-source'],courseFileScope:'specific_files',sourceMode:'course_files',courseId:'course-a'}, 'course-a')` with an empty library and no viewer returns `null`.

Consequences, confirmed in the caller: course-files retry becomes a successful/exportable “No files are selected” message at line 1607; Auto retry enters `callGenericAi` at line 1618, silently dropping the saved document scope. The latter violates the core scope invariant. Existing transport retry regression calls `streamFromAskStream` directly and bypasses this gate.

Suggested permanent regression: invoke the actual `streamAiReply` orchestration with a failed assistant whose snapshot has specific-files scope and stable `doc-a`, then remove its source-library item before Retry. Assert `/ask-stream` receives the original `doc-a` (or a typed explicit unavailable-source outcome), never generic generation or a complete no-selection answer. Cover Auto and Course Files. Restore the saved scope before eligibility; do not invent a replacement document.

## P1: Incidental incomplete viewer still blocks unrelated questions

`shell.ts:3129` throws `active_pdf_state_incomplete` whenever viewer DOM is visible and `getActivePdfContext()` is null, before assessing mode or required evidence. This is earlier than the hardened optional snapshot fallback and therefore remains unaffected by it.

Executable observation: with visible viewer, null active context, no sources, explicit `internet` mode and question “Explain torque”, production `ragEligibility` throws `active_pdf_state_incomplete`. No request reaches the backend. An unrelated general question has the same result.

The retry guard at line 1494 also demands reopening any incidental PDF recorded in the original snapshot, even when the interrupted answer required only web/general evidence. That condition is evidence availability rather than evidence necessity.

Suggested regressions: actual eligibility/orchestration with visible incomplete viewer must allow unrelated Internet/general questions; page-dependent prompts must still receive explicit document-access recovery. Retry of an interrupted Internet answer after closing its incidental PDF must retain original Internet scope and proceed. Avoid adding a frontend phrase router: preserve the incomplete-viewer signal for backend evidence planning instead of globally throwing.

## Scope

These are two remaining root causes, extending R1 and R7. Both were reproduced at the production eligibility function boundary; caller consequences were source traced. No live account, browser, real retrieval or model execution is claimed by this report.
