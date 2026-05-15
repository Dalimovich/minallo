# Task-06 Implementation Summary — Auth modal back-button history

## Files touched
- **MODIFIED** `frontend/js/features/auth/auth-modal.ts` — +~20 lines
- **MODIFIED** `frontend/js/features/auth/auth-modal.js` — mirrored

## What was added
Inside `initAuthModal()` IIFE, after `showAuthModal`:

1. `pushAuthHistory()` — pushes `{ ssAuthModal: true }` history entry with URL `#auth`. Idempotent: skips if current state already has the marker.
2. `closeAuthFromHistory()` — hides `#authModal`, removes `hidden` class from `#landing`. No-op if modal is already hidden.
3. `popstate` listener registered once at module init. If the new state lacks the marker (i.e. user navigated back past the auth entry), close the modal.

Both `handleAuthClick` (`else if (authModal)` branch) and `showAuthModal` call `pushAuthHistory()` after setting `display:flex`.

## Why no explicit X/Esc/outside-click changes
The existing auth modal has no X button, Esc handler, or outside-click handler. Only `SIGNED_IN → enterApp` implicitly hides it. The history hook stays self-contained: open pushes, back pops, close-by-back hides. If a close button is added later, it should call `history.back()` so the URL stays in sync — noted as a follow-up.

## Behavior
- Open modal → URL becomes `/#auth`, history has one extra entry.
- Browser Back → modal hides, landing reappears, URL returns to previous.
- Browser Back again → user leaves the site (normal).
- Successful sign-in → `enterApp` runs as before; the stale `#auth` entry remains in history but is harmless because the user is now in-app and the modal is gone.

## Typecheck
`npx tsc -p frontend/tsconfig.build.json --noEmit` → exit 0.

## Known limitations / follow-ups
- After successful sign-in, the `#auth` URL fragment lingers until the next navigation. Could be cleaned up with `history.replaceState({}, '', window.location.pathname)` inside the SIGNED_IN branch — out of scope here, would require touching the sign-in success path.
- No close button in the modal yet; if one is added it should `history.back()` (not directly hide) so the URL/history stays consistent.
