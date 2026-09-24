# Error and recovery investigation

Baseline: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`.

## Finding ERROR-01

### Severity
P1
### User scenario
Access expires or a document's access changes; the student receives a typed error and needs to sign in or reopen the original document.
### Expected
The appropriate recovery action remains available even when retrying the identical request is disallowed.
### Actual
`classifyAiError({code:'session_expired'})` and `document_access_revoked` both return `action:'none'`. The shell therefore renders no recovery action. `SESSION_INVALID`, emitted by authenticated transport, is not classified as auth and suggests generic retry.
### Evidence
Real classifier execution: `node --import tsx audit/repros/error-contract.mjs`. Shell `attachStructuredRecoveryAction` immediately returns for `action === 'none'` (deterministic reachability). No browser behavior claimed yet.
### Root cause
Retry permission is conflated with all recovery actions; transport and UI auth codes disagree.
### Files
`frontend/js/services/ai-error-message.ts`: classifyAiError; `frontend/js/features/chatbot-new/shell.ts`: attachStructuredRecoveryAction.
### Structural fix
Suppress retry/continue when retry is forbidden, retaining independent sign-in/reopen actions. Normalize auth transport codes at the canonical error boundary. Classify important emitted full-document and scope errors rather than mislabeling them as general failures.
### Regression test
Execute classifier for session/auth, access-changed, and nonretryable generation errors; execute DOM recovery rendering and sign-in action target. Verify retry cannot broaden a selected source.
### Related findings
AUTH-01, SSE-01. Full inventory in `audit/error-contract.md` (47 literal backend codes; only 9 direct mappings at baseline, excluding dynamically constructed emissions).

## Finding ERROR-02

### Severity
P2
### User scenario
Support investigates a failed request without access to document contents.
### Expected
One structured diagnostic provides all requested routing, scope, failure, and terminal fields.
### Actual
Fields are spread over separate log messages. Some generic exceptions carry stack traces in server logs. UI-facing stack trace exposure has not been reproduced.
### Evidence
Static trace of stream.py logging only.
### Root cause
Logging predates the unified execution/evidence contract.
### Files
`backend/python-ai/app/routers/stream.py`: fast and deferred execution logging.
### Structural fix
Extend existing request diagnostics with sanitized structured terminal facts; do not log question/document text.
### Regression test
Capture logs for one general and one grounded failure, assert IDs and routing/terminal fields and absence of synthetic private text.
### Related findings
No independent P0/P1 asserted from observability alone.
