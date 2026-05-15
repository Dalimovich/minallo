# Task-06 — Wire browser back-button to close auth modal

## Goal
When the auth modal opens, push a history entry so the browser back button returns the user to the landing page (closes the modal) instead of leaving the site.

## Behavior
1. On modal open: `history.pushState({ ssAuthModal: true }, '', '#auth')` — only if `history.state?.ssAuthModal` isn't already true (avoid double-push).
2. On modal close via X / Esc / outside-click / successful auth: if `history.state?.ssAuthModal === true`, call `history.back()` so URL falls back to the previous entry. The popstate handler will see the new state lacks the marker and skip re-closing.
3. On `popstate`: if the modal is currently open AND the new `history.state?.ssAuthModal` is not true, close the modal *without* calling `history.back()` (the browser already moved).

## Write scope
- `frontend/js/features/auth/auth-modal.js`
- `frontend/js/features/auth/auth-modal.ts`

Mirror every change in both files (project convention — see `feedback`/`project_ts_js_cleanup_deferred`).

## Out of scope
- Deep-linking to `#auth` to open the modal on page load. Not requested.
- Any HTML/CSS changes.
- Refactoring existing open/close paths beyond the minimal hook.

## Done criteria
- pushState on open, popstate listener wired once (idempotent), close path calls `history.back()` only when the marker is set.
- `tsc -p frontend/tsconfig.build.json --noEmit` exit 0.
- Manual test (described to user): open auth modal from landing → hit back → modal closes, URL returns to `/`. Hit back again → leaves site (normal).
- Committed on `feat/landing-vanilla-port` and pushed.

## Dependencies
None. Independent of task-05.
