# Frontend JS → TS migration — progress tracker

Branch: `frontend-ts-migration` (work happens in the
`../studysphere-ts/` git worktree to keep `main` shippable).

Approach approved: **big-bang Vite cutover**. The legacy
`<script>` + `loader.js` boot is incompatible with Vite's module
graph, so the migration completes only when:

1. Every legacy `<script src="js/…">` is replaced by a single
   `<script type="module" src="/src/main.ts">`.
2. `loader.js`'s HTML-injection mechanic is replaced by proper
   imports.
3. Netlify publish dir is switched from `frontend/` to
   `frontend/dist/`.

Until those three things land in the same commit, the `.ts` files
in this branch are **shadow types only** — they coexist with the
`.js` originals; production still ships the `.js`.

---

## Status — 2026-05-13

### Foundation
- [x] `frontend/tsconfig.json` (strict, bundler module resolution,
      ES2022, DOM lib).
- [x] `frontend/globals.d.ts` — ambient `window` typings for the
      legacy globals (`_currentUser`, `_sbToken`, `_t`, `_ssDb`,
      `pdfjsLib`, etc.). Each migrated module shrinks this file.
- [x] `frontend/vite.config.ts` — dev server + build to
      `frontend/dist/`.
- [x] Root `package.json` scripts:
  - `npm run typecheck:frontend`
  - `npm run dev:frontend`
  - `npm run build:frontend`
- [x] `npx tsc -p frontend/tsconfig.json` returns clean (no errors).

### Converted (.ts shadow files alongside .js)

**utils + config + services (9 files, ~470 LOC):**
- [x] `frontend/js/utils/escape-html.ts`
- [x] `frontend/js/utils/db-helpers.ts`
- [x] `frontend/js/config/icons.ts`
- [x] `frontend/js/config/pdf-config.ts`
- [x] `frontend/js/services/admin-service.ts`
- [x] `frontend/js/services/ai-service.ts`
- [x] `frontend/js/services/pdf-service.ts`
- [x] `frontend/js/services/storage-service.ts`
- [x] `frontend/js/services/subscription-service.ts`

**core (10 files, ~810 LOC):**
- [x] `frontend/js/core/app-shell.ts`
- [x] `frontend/js/core/console-filter.ts`
- [x] `frontend/js/core/globals.ts`
- [x] `frontend/js/core/navigation.ts`
- [x] `frontend/js/core/panels.ts`
- [x] `frontend/js/core/pdf-worker.ts`
- [x] `frontend/js/core/portal-ui.ts`
- [x] `frontend/js/core/pull-to-refresh.ts`
- [x] `frontend/js/core/state-persistence.ts`
- [x] `frontend/js/core/state.ts`

**19 files total, ~1,280 LOC. `npx tsc -p frontend/tsconfig.json` clean.**

### Still to convert (in suggested order)

| Area | Files | LOC | Notes |
|---|---|---|---|
| `frontend/js/core/**` | 10 | ~1.5k | Already ES modules. |
| `frontend/js/features/**` (modular features) | ~30 | ~8k | Already ES modules. |
| `frontend/js/app*.js`, `app-pdf.js`, `app-storage.js`, `app-data.js`, `app.js` | 6 | ~3.5k | App shell — touchy because of window globals. |
| `frontend/features/**` | ~28 | ~22k | Window-global scripts; need de-globalization too. |
| `frontend/ai/ai.js` + stragglers | 3 | ~1.5k | Misc. |
| **Cutover (single commit when all above done)** | | | Replace `loader.js`, swap `index.html` to module entry, flip `netlify.toml` publish dir to `frontend/dist/`. |

### Estimated remaining effort
- Step 2 (core + modular features): ~2–3 sessions, mechanical.
- Step 3 (app shell): ~1–2 sessions.
- Step 4 (window-globals): ~5–8 sessions — biggest bucket.
- Step 5 (cutover + smoke test): 1 session.

### Working notes
- `globals.d.ts` is a *temporary* surface. Every migrated module
  that stops touching `window.X` should remove `X` from
  `globals.d.ts`. The file shrinks as the migration progresses.
- The legacy IIFE in `db-helpers.ts` still assigns `window._ssDb`
  — keep until all IIFE feature scripts are converted.
- The `.js` originals stay in place until the cutover. Bug fixes
  during the migration need to apply to both sources of truth.
- `tsc` runs with `noEmit: true`; Vite handles the actual build.
