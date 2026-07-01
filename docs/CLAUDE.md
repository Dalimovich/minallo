# CLAUDE.md

## Stack
TypeScript compiled to JS with `tsc`. No runtime bundler — `loader.ts` injects HTML partials and JS runs via script tags sharing `window` scope. Hosted on Cloudflare Pages with Pages Functions for API routes.

## Folder Structure
```
frontend/
  index.html          — app shell (entry point)
  css/                — all CSS; light/dark via CSS vars, body.night class
  js/
    loader.ts         — fetches & injects HTML sections; fires ss-ready when done
    app.ts            — main UI logic — navigation, course/file rendering, AI panel, state
    app-data.js       — SEMS course data, localStorage caching, save/load/migration
    app-storage.js    — Supabase Storage file operations (upload, list, merge, delete)
    supabase.js       — auth (_enterApp), Supabase REST client, session restore
    config.js         — public config (Supabase URL, asset version, AI model)
    core/             — navigation, state persistence, panels
    config/           — icons, dependencies
    features/         — feature modules (ai-chat, courses, pdf-viewer, auth, etc.)
    pages/            — landing page JS
    services/         — ai-service, storage-service wrappers
  pages/              — HTML sections injected by loader
  views/              — lazy-loaded feature views (chatbot, chat, quiz, flashcards, etc.)
  extension/          — Chrome browser extension

functions/api/        — Cloudflare Pages Functions (API routes)
backend/lib/          — shared TS helpers (auth, cors, rate-limit, stripe, etc.)
backend/python-ai/    — FastAPI AI/RAG service (Fly.io)
```

## HTML Injection Order (loader.ts)
landing → auth → signup → toast → portal → modals → studip → files

## Key Frontend Modules

| File | Responsibility |
|---|---|
| `loader.ts` | Injects HTML partials, fires `ss-ready` |
| `app.ts` | UI shell, navigation, openFile, openCourse, theme |
| `app-data.js` | SEMS course state, localStorage caching, Supabase profile sync |
| `app-storage.js` | File upload/list/merge/delete via Supabase Storage |
| `supabase.js` | Auth, session restore, Google Sign-In |
| `core/navigation.ts` | Portal section switching, deep-link routing |
| `core/state-persistence.ts` | Save/restore active course, section, file on refresh |
| `features/courses/courses-render.ts` | Dashboard course card rendering |
| `features/courses/course-view.ts` | Course detail view, file listing, _ufMerge |
| `features/courses/course-files.ts` | Upload flow, indexing, processing progress |
| `features/ai-chat/` | AI chat panel (ask, render, export, markdown, etc.) |
| `features/pdf-viewer/` | PDF.js viewer with tabs, panes, text extraction |
| `services/ai-service.ts` | Frontend AI API wrapper |

## Rules
- **After every edit, tell the user which file(s) were modified.**
- No frameworks — use `getElementById`, `querySelector`, event listeners
- Light/dark mode: CSS vars in styles.css; night class is `body.night`
- PDF rendering: PDF.js v3.11.174 from CDN
- Math rendering: KaTeX v0.16.10 from CDN
- Hosting: Cloudflare Pages (NOT Netlify)
- Backend AI deploy: `flyctl deploy` from backend/python-ai/ (manual)
- Bump `assetVersion` in `frontend/js/config.js` after any frontend CSS/JS edit
- Edit `.ts` files, not compiled `.js` files
