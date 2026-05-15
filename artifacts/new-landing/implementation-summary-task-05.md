# Task-05 Implementation Summary — Scroll fix

## Files touched
- **MODIFIED** `frontend/css/new-landing.css` — two surgical edits.

## Change 1 — `pointer-events: none` on `.nl-bg-gradient`
Added inside the existing rule. Sibling decor layers `.nl-grid-bg` and `.nl-orb-*` already have it; this was the one missed full-viewport fixed layer that could intercept wheel events.

## Change 2 — body overflow-x revert
`body.nl-body` reverted from `overflow-x: clip` to `overflow-x: hidden`. Rationale: `.nl-main` correctly uses `clip` (no fixed height → `hidden` would make it a dead scroll container), but the body's viewport scroll range is the document height, so `hidden` is the safe stable pattern and `clip` was unreliable on user's browser.

## Typecheck
`npx tsc -p frontend/tsconfig.build.json --noEmit` → exit 0.

## Verification
User to hard-reload and report whether wheel/touch scroll works. If still broken, fallback (per task-05.md) is to move bg layers out of `<main>` to direct `<body>` children.

## Commit
`bb6649a` on `feat/landing-vanilla-port`, pushed.
