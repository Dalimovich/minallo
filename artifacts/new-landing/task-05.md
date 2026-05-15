# Task-05 — Fix wheel/touch scroll on new landing

## Goal
Restore vertical wheel/touch scrolling on `frontend/pages/new_landing.html`. Anchor-link nav already works; only continuous scroll is dead.

## Background
Two prior fixes did not resolve it:
- `6d0721c` — `.nl-main { overflow: hidden }` → `overflow-x: hidden`
- `909c557` — `body.nl-body` + `.nl-main` → `overflow-x: clip`

Top suspects (from handoff-task-04.md §A):
1. `.nl-bg-gradient` is `position: fixed; inset: 0; z-index: -10` with **no `pointer-events: none`**. Other decor layers (`.nl-grid-bg`, `.nl-orb-*`) have it; this one was missed. A fixed full-viewport element without pointer-events disabled can swallow wheel events on some browsers/stacking contexts.
2. `body { overflow-x: clip }` is newer/less stable than the well-known `overflow-x: hidden` body pattern. Reverting body to `hidden` and keeping `.nl-main { overflow-x: clip }` is the safer combo.

## Write scope
`frontend/css/new-landing.css` only.

## Likely change (try together, single commit)
- Add `pointer-events: none` to `.nl-bg-gradient`.
- Revert `body.nl-body` to `overflow-x: hidden` (keep `.nl-main { overflow-x: clip }`).

## Out of scope
- HTML restructuring (moving bg layers out of `<main>`) — deferred to a follow-up if this CSS-only attempt doesn't fix it.
- Any JS edits to `new-landing.js`.

## Done criteria
- Both CSS rules updated.
- `tsc -p frontend/tsconfig.build.json --noEmit` exit 0.
- Committed on `feat/landing-vanilla-port` and pushed.
- User confirms wheel/touch scroll works on hard-reload. (User verification asynchronous — push and report.)

## Dependencies
None. Independent of task-06.
