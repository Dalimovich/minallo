// Vite config — Minallo frontend.
//
// During the JS → TS migration Vite is set up as an *additive* tool: it
// type-checks the converted .ts modules and can build them. The legacy
// loader.js + script-tag entry point is still what ships from `frontend/`
// in production. A later commit will flip the Netlify publish dir to
// `frontend/dist/` once every module has been converted and a single
// module entry (`src/main.ts`) replaces `loader.js`.
//
// To run locally:
//   npm run dev:frontend   - Vite dev server with HMR (against src/main.ts)
//   npm run build:frontend - emit production bundle to frontend/dist
//   npm run typecheck:fe   - tsc against frontend/tsconfig.json

import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'assets',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
    // Without this, any POST to `/api/*` falls through Vite's static handler
    // and Vite returns HTTP 501 "Not Implemented" — which is what was hitting
    // the Schreibtrainer (and every other AI endpoint) in local dev.
    //
    // Forward `/api/*` to `wrangler pages dev` (default port 8788) so the
    // Pages Functions handle the request. Without this Vite returns HTTP 501
    // for every POST. Override with VITE_API_PROXY=https://minallo.de to hit
    // the live backend, but unreleased functions like the Schreibtrainer will
    // 404 there — local `wrangler pages dev` is the only way to test them.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://localhost:8788',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
