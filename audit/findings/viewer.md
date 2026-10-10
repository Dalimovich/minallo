# Viewer investigation

Baseline: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`. Read-only production investigation.

## Finding VIEWER-01

### Severity
P1
### User scenario
Open a course PDF, then ask the self-contained general question "What is the quadratic formula?" while PDF rendering fails (e.g. unloaded/corrupt page).
### Expected
General generation remains available; an optional PDF does not become a required evidence dependency.
### Actual
The visual-keyword detector returns true; snapshot capture returns `capture_failed`. The shell turns that into `visible_page_capture_failed` before submitting to the backend resolver.
### Evidence
Executed production snapshot/helper functions with injected renderer failure: `node --import tsx --test audit/repros/viewer-capture.mjs`, 2 passed observations. Shell reachability is deterministic source proof, not browser E2E: `streamFromAskStream` always invokes capture whenever activePdfContext exists and throws on unsuccessful capture. No actual model/browser execution claimed.
### Root cause
Optional viewer evidence is collected as a mandatory preflight dependency before authoritative evidence resolution. Visual keyword matching conflates mentioning a formula with referring to the displayed formula.
### Files
`frontend/js/features/pdf-viewer/active-pdf-context.ts`: requiresVisualPdfEvidence, captureStablePdfSnapshot. `frontend/js/features/chatbot-new/shell.ts:3390`: streamFromAskStream.
### Structural fix
Make capture requirement depend on the canonical request evidence requirement; preserve typed page recovery for required page evidence and allow general requests through without optional capture. Do not add a phrase exception.
### Regression test
Full submission integration: compatible PDF open; inject getPage/render failure; submit an unrelated general formula question; assert general request runs and completes. Same injection for an explicit visible-page formula request must produce typed page-reading recovery and retain request scope.
### Related findings
Capture is also performed for unrelated short conversational messages on scanned pages. General requests may incur avoidable render latency even when it succeeds.

## Finding VIEWER-02

### Severity
P2 / further journey verification required
### User scenario
Viewer DOM becomes hidden while authoritative viewer state still exists.
### Expected
Hidden content does not claim to be a currently visible page.
### Actual
getActivePdfContext still returns the document and visible page. Executed in the same repro.
### Evidence
Real unit execution only. Normal close routes often clear authoritative state; a complete reachable close failure has not been demonstrated.
### Root cause
isPdfViewerVisible is checked only for diagnostics, not context eligibility.
### Files
`frontend/js/features/pdf-viewer/active-pdf-context.ts`: getActivePdfContext, validateActivePdfViewerState.
### Structural fix
Decide centrally whether a hidden viewer remains an eligible document hint; do not label it visible page evidence.
### Regression test
Real close-during-capture and hidden-view transitions, asserting no stale visible context.
### Related findings
VIEWER-01.

## Existing safeguards and gaps

Source inspection shows snapshot retries on document/page/revision/viewer-instance change and shell course compatibility checks that drop Course A PDF for Course B chat. These are not newly executed complete user journeys. `active-pdf-authority.test.mjs` is source-regex wiring, not runtime proof. Page 7 to 8 late arrival, close during render, image-only mutation, and chat switch during capture still require browser/integration execution before acceptance.
