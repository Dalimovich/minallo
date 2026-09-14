# Minallo AI Reliability Audit

> **2026-09-11 freeze decision:** independently reverified at this SHA (backend `pytest`: 1627 passed/8
> skipped; frontend `npm run test:unit`: 618 passed/0 failed; frontend typecheck and backend `pyright`:
> clean) — no reproduced P0/P1 defect remains. The "NOT READY TO FREEZE" recommendation below is about
> incomplete full end-to-end coverage for roughly a third of the 25 required journeys (see
> [critical-journey-coverage.md](critical-journey-coverage.md), rows marked GAP), not a live bug. Per
> the audit's own stop rule (P0=0, normal-user P1=0 → stop), the project owner has chosen to freeze now
> and track the remaining journey-coverage gaps as backlog rather than continue the acceptance-gate
> push. See [AI_RELIABILITY_BACKLOG.md](AI_RELIABILITY_BACKLOG.md) for the tracked items.

## Audited SHA

Initial fetched `origin/main`: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`. Latest production fix in this pass: `436cf76` (incidental-viewer resume), following `131bfbb` (logging privacy). Other sessions advanced the shared checkout during this audit; their newer fixes were preserved and rechecked. The previous closure report at `786f9b1` predates these two confirmed P1 fixes.

Verification ran on the shared working tree. Concurrent changes to `ai-markdown.ts`, `shell.ts` recommendation launching, `workspace-library.ts`, generated JavaScript, and the original `.claude/scheduled_tasks.lock` were not included in this pass's commits. This is not a clean production deployment certification.

## Architecture map

[Request/evidence/persistence architecture](AI_RELIABILITY_ARCHITECTURE.md). Chat submission captures the originating chat and source scope, ensures a durable turn through central authentication, and sends a canonical grounding request. Backend dialogue resolution separates task from evidence; preflight chooses general/contextual, web, page, retrieval or exhaustive processing. SSE carries progress and terminal metadata; chat storage preserves partial output, request snapshots and provenance. Generated study tools have separate generation, persistence and reopen boundaries.

## Agents used

Initial investigators: `conversation_routing`, `documents_features`, `frontend_lifecycle`. Resumed/replacement reviewers: `terminal_review`, `coverage_review`, `frontend_review`. They investigated, ran isolated reproductions and wrote reports. The coordinator deduplicated findings and applied production fixes sequentially. Agent sessions encountered quota and saved-session failures; replacement agents were used when available. No claim of uninterrupted parallel execution is made.

Latest independent signoff: [focused review](findings/final-signoff.md), 133 backend tests passed with six skips and 12 frontend runtime tests passed. Later coverage review reran the 50-scenario resolver campaign at `786f9b1`.

## User journeys executed

- Eight actual browser scenarios using the real chat shell and synthetic HTTP: successful send, empty completion, retry, partial disconnect, reload of interrupted text, Stop, next prompt, and switching chats during delayed submission. All passed, including a rerun through the permanent suite.
- Fifty multi-turn resolver scenarios executed; 32 inject semantic-service timeout. These are diagnostic traces with synthetic prior answers, not 50 passing complete user journeys. [Corpus](student-journeys.json), [execution summary](student-campaign-summary.md).
- Real route/transport integration regressions cover explicit evidence, context provenance, full-document processing, terminal ownership, auth refresh, retry eligibility and typed recovery. Provider, database and rendering dependencies are mocked where stated.
- [The 25 required journeys](critical-journey-coverage.md) map each requirement to its exact evidence and remaining gap. The complete 25-journey acceptance gate is not established.

## P0 findings

| Problem → root cause | Fix | Executable evidence / result |
|---|---|---|
| Chat switching changes submitted source scope → async reads use mutable active chat | Immutable originating request snapshot; retry uses stable saved IDs before current library lookup | `ai-request-scope-runtime`, `chat-eligibility-runtime`; failing reproductions now pass. Browser delayed-switch scenario passes. |
| Internet/selected evidence bypassed → fast execution chosen before explicit constraints | Explicit evidence participates in preflight planning | `test_explicit_evidence_preflight.py`; explicit-web and selected-document route regressions pass. Newer routing fixes from the other session were retained. |

## P1 findings

| Problem → root cause | Fix | Executable evidence / result |
|---|---|---|
| Unexpired server-rejected JWT reused → expiry mistaken for validity | Force refresh rejected token; reuse newer concurrent token; fail revoked refresh visibly | `auth-browser-adapter.test.mjs`; three baseline failures now pass. |
| Partial output lost / duplicate completion → terminal ownership split | Preserve read buffer; stop at terminal; reject empty completion in general and deferred paths | `ai-terminal-runtime`, `test_fast_stream_terminals.py`, `test_deferred_stream_terminals.py`; late token/error/timeout and empty-result injections pass. |
| Grounded clarification becomes general → execution lane overwrites provenance | Persist and hydrate answer evidence independently of execution lane | `test_answer_provenance_journey.py`, `chat-provenance-hydration`; clarification chain then verification passes. |
| Full coverage claimed after blank/truncated output → input availability counted as successful processing | Count successful page maps; reject missing/blank map or synthesis; reject provider truncation/filter completion | `test_full_document_failures.py`, `test_full_document_truncation.py`; missing page 40/100, empty maps/final and truncated map/final pass safely. |
| Unrelated question blocked by PDF capture/state → incidental viewer treated as required evidence | Allow authoritative evidence planning to decide; retain required-page protections | `optional-pdf-capture-runtime`, `test_optional_viewer_evidence.py`, `chat-eligibility-runtime`; optional/required pair passes. |
| Retry blocked after closing incidental PDF → all saved active documents required on resume | Require original PDF only for requested/resolved visible-page evidence | `incidental-viewer-resume.test.mjs`; actual orchestration reaches persistence for Internet retry and rejects missing required-page evidence. |
| Sign-in/reopen action lost → retryability controls unrelated recovery actions | Preserve independent recovery actions; normalize transport/error aliases | `ai-error-message`, `chat-error-recovery-runtime`; real sign-in callback and typed action regressions pass. |
| Follow-up loses referent → known task family suppresses semantic resolution | Resolve referential tasks; validate structured types and finite confidence | `test_semantic_followup_gate.py`; timeout, malformed JSON/types, NaN/Infinity/bool/out-of-range cases pass. |
| Retrieval outage produces unapproved general answer → fallback checks source availability instead of required evidence | Preserve required grounding; allow only optional general/context recovery | `test_grounding_failure_fallback.py`; explicit course mode/wording, grounded verification and persistence outage pass. Newer `needsCourseEvidence` recovery distinction also rechecked. |
| User/document text enters logs → whole dialogue logged through blacklist | Allowlisted diagnostic metadata and explicit routing fields | `test_observer_privacy.py`; two baseline failures now pass, including unknown nested payload exclusion. |

The initial serialized queue is preserved in [consolidated findings](AI_RELIABILITY_FINDINGS.md); follow-up reports in `findings/` document additional reproductions. Historical baseline probes may deliberately assert old defective behavior; the permanent suite uses required-behavior assertions.

## P2 findings

Deferred with evidence and closure conditions in [the backlog](AI_RELIABILITY_BACKLOG.md). Uniform terminal diagnostics remain incomplete; the privacy leak itself is fixed. Existing unused Python test imports were cleaned up by the other session and Ruff now passes. No redesign was introduced for unproved viewer edge cases.

## Failure injections

[Complete boundary/injection matrix](failure-injection-matrix.md). Executed examples include semantic timeout/malformed output, provider truncation, missing document page, empty completion, pre/post-token errors, native reader disconnect, late provider output, rejected JWT and refresh token, state-write outage, unavailable source library and PDF capture failure. Static inventory and helper-only checks are explicitly separated from injected runtime failures. [Error contract](error-contract.md) runs the actual frontend classifier over statically discovered backend codes; it is not an injection campaign.

## Tests added

Permanent regressions cover each fixed root cause. [Permanent reliability runner](../tests/reliability/README.md) selects the relevant backend/frontend tests, compiles the frontend and runs the local browser fixture. Command: `backend/python-ai/.venv/Scripts/python.exe tests/reliability/run.py` on Windows. No missing journey is disguised as a passing placeholder.

## Full test results

| Check | Latest observed result |
|---|---|
| Full backend pytest | 1,627 passed, 8 skipped, 3 dependency deprecation warnings |
| Full frontend unit/runtime suite | 618 passed, zero failed |
| Permanent reliability selection | 369 backend passed, 6 skipped; 76 frontend passed; eight browser scenarios passed |
| Backend/frontend/functions TypeScript checks | Passed |
| Production build | Passed |
| ESLint | Passed |
| Ruff | Passed |
| Pyright | Zero errors, warnings or information diagnostics |

Skipped semantic/live-provider cases were not counted as passed. Test totals include newer work by other sessions, not only this pass's additions. Local logs are retained under `audit/`; runtime output is summarized here rather than treated as live-production evidence.

## Known remaining risks

Exact Saved reopen, actual interrupted worker restart/resume and other complete acceptance journeys remain partially covered. The provider's factual quality and exhaustive semantic coverage are not proved by nonempty output or synthetic model fixtures. Required diagnostic fields are dispersed rather than available in one authoritative terminal record. See the backlog for the bounded remaining checks.

## Production deployment verification

This pass did not deploy, push, change production configuration, or execute authenticated live-service journeys. The browser used a local synthetic backend. Production auth/index/provider/persistence/Saved compatibility remains unverified by this pass.

## Recommendation

**NOT READY TO FREEZE against the user's full acceptance gate.** The reproduced P0/P1 defects in this pass have passing regressions, but complete evidence for all 25 critical journeys is missing. This supersedes the earlier READY assessment for the scope of this audit. Complete the bounded acceptance gaps; do not reopen theoretical P2 architecture work merely because more auditing is possible.
