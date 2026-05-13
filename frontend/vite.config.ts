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
  },
});
