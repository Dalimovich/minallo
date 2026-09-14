# Auth / API transport audit

Audited SHA: 1ecddd6b1beaa19a1c633160ef651c2fbd78511f. Read-only investigation; production unchanged.

## Finding AUTH-01
### Severity
P1
### User scenario
An apparently unexpired access JWT is rejected by the server; student loads an authenticated feature or starts an idempotent tutor request.
### Expected
Force one coordinated refresh and retry with the refreshed token.
### Actual
The real browser adapter skips refresh because the rejected token still has a future expiry. Both requests carry the rejected token; studying remains blocked until token expiry/sign-in.
### Evidence
Executed `node --import tsx audit/repros/auth-transport.mjs`: public authenticatedFetch wrapper, browser auth stub, server 401 injection. Exactly zero refresh calls and two 401 requests. Existing dependency-injected 401 unit test passes because it bypasses browserRefresh.
### Root cause
browserRefresh combines expiry-based proactive refresh and forced server rejection recovery without a force/rejected-token parameter.
### Files
frontend/js/services/authenticated-fetch.ts: browserRefresh (95-107), authenticatedFetchWith (82-86).
### Structural fix
Pass rejected-token/force context through coordinated refresh; refresh an apparently-valid token when the server rejected it, coalescing callers and recognizing a token another caller already replaced. Preserve explicit invalid-session result centrally.
### Regression test
Exercise the public browser wrapper with valid-expiry rejected token; five concurrent 401 requests; staggered 401 responses after refresh; revoked refresh and temporary network failure. Assert actual auth.refreshSession calls and outgoing bearer values.
### Related findings
Revocation injected through the actual adapter's return-null/clear-token behavior produces five SESSION_INVALID throws for five concurrent callers and one refresh; five subsequent sequential requests call the refresh adapter five times. There is no invalid-session latch. This proves repeated adapter work, not five refresh HTTP requests: real supabase refreshSession returns null immediately when stored refresh is absent. Network failures preserve the access token but expired-token requests still attempt bounded unauthorized requests.

## Executed checks
Five simultaneous expired-token features: one refresh, five successful sends. Revoked refresh: no protected request sent, SESSION_INVALID for each caller. Temporary refresh network failure: token preserved. Focused existing frontend suites: 33/33 pass (auth transport, AI stream recovery, chat refresh durability). Offline-to-online operation resumption not executed; not claimed.

## Auth-call classification inventory
Full file/line raw search: audit/repros/auth-call-search.txt. Generated JS duplicates TS and is not a distinct architecture.

| Calls / implementation | Classification | Notes |
|---|---|---|
| services/authenticated-fetch.ts | Auth implementation | Canonical bearer/refresh/safe retry; AUTH-01 |
| js/supabase.js auth/v1, auth-bootstrap.js, admin-page.js refresh, affiliate.js refresh | Auth implementation | Login/session refresh may use raw fetch |
| ai-service.ts, study-service.ts, progress-sync.ts, subscription-service.ts protected calls; chatbot-new shell/workspace-library/Saved sync | Uses authenticated transport | Residual token read alone is not proof of bypass; wrapper overwrites headers |
| subscription-service public-billing-config; chatbot/writing-coach HTML; pdf-service/pdf-compare static assets; chat-attachments signed URL download | Public or URL-authorized | No bearer refresh required for static/signed URL fetching |
| courses/document-type-badge.ts:151 /api/documents/set-type | Should use authenticated transport | Raw captured bearer |
| js/ai.js:165,497 /api/ai and 809 index-existing | Should use authenticated transport | Legacy AI paths bypass shared refresh |
| views/flashcards/flashcards.js REST decks and flashcard-review, documents/list | Should use authenticated transport | Own headers and raw fetch; Saved/learning feature exposure |
| views/chat/chat.js REST, chat-friends, send-chat-message, username/search, room APIs | Should use authenticated transport | Numerous raw _sbHeaders/captured-token requests |
| views/editor/writer.js editor_docs; lecturenotes.js lecture_notes | Should use authenticated transport | Persistence uses raw REST |
| js/app-storage.js upload/delete/copy and XHR upload | Should use authenticated transport | Storage operations need canonical freshness; retries must remain operation-safe |
| js/app-data.js profiles; supabase.js from(table), welcome-email, affiliate-dashboard | Should use authenticated transport | Non-auth work inside auth/legacy modules is not exempt |

Bypass inventory is source-only; do not classify every legacy operation as independently reproduced P1. Explicitly migrate operations relevant to ordinary study and preserve mutation retry semantics.
