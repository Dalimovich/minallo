# Minallo

Minallo is an AI study workspace for students. It combines course PDFs, grounded AI tutoring, page-level citations, PDF tools, notes, flashcards, quizzes, exam prep, cheatsheets, deep-learn mode, German practice, a writing coach, focus tools, music, study games, and student chat in one authenticated app.

Production: [minallo.de](https://minallo.de)

Legal pages:
- [Impressum](https://minallo.de/impressum.html)
- [Privacy](https://minallo.de/privacy.html)
- [Terms](https://minallo.de/terms.html)
- [Withdrawal](https://minallo.de/withdrawal.html)

## Product Focus

Minallo is built around one promise: students should be able to ask questions about their own course material and get answers that match the uploaded lectures, exercises, and formula sheets.

Core user flows:
- Upload lecture PDFs, exercise sheets, notes, and formula sheets.
- Ask the AI tutor questions about course material with source-page citations.
- Solve exercises with structured steps and grounded references.
- View, annotate, summarize, merge, and organize PDFs.
- Generate lecture notes, flashcards, quizzes, cheatsheets, and exam prep material.
- Deep-learn mode for focused topic mastery with adaptive difficulty.
- Practice German in a separate learner space with a writing coach.
- Use Pomodoro timer, streaks, games, and study progress tools.
- Chat with other students in rooms and direct messages.
- Manage subscriptions (Stripe / PayPal) with pause, cancel, and retention flows.

## Architecture

```text
Browser
  |
  | HTTPS
  v
Cloudflare Pages
  - Static frontend from dist/ (built from frontend/)
  - Pages Functions under functions/api/
  - API routes: /api/ai/ask, /api/documents/upload, /api/create-checkout, etc.
  |
  | Authenticated proxy calls
  v
FastAPI AI service (Fly.io, Frankfurt)
  - backend/python-ai
  - PDF indexing, retrieval, streaming answers, generation, writing coach
  - Uses OpenAI models (gpt-4o, gpt-4o-mini, gpt-4.1-mini) and embeddings
  |
  v
Supabase
  - Auth (email + Google OAuth)
  - Postgres + pgvector
  - Storage (course uploads)
  - Row-level security

Payments:
  - Stripe subscriptions
  - PayPal subscriptions
```

## Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, TypeScript compiled to JS, custom loader (no runtime bundler) |
| Hosting | Cloudflare Pages |
| Functions | Cloudflare Pages Functions, TypeScript |
| AI service | FastAPI, Python 3.11+, deployed on Fly.io |
| LLM | OpenAI (gpt-4o, gpt-4o-mini, gpt-4.1-mini, gpt-4.1-nano) |
| Embeddings | OpenAI text-embedding-3-small (1536 dim) |
| Database | Supabase Postgres with pgvector |
| Auth | Supabase Auth + Google Sign-In |
| Storage | Supabase Storage |
| Payments | Stripe and PayPal subscriptions |
| PDF rendering | PDF.js 3.11.174 (CDN) |
| Math rendering | KaTeX 0.16.10 (CDN) |
| Tests | Node test runner, Playwright, pytest |

## Repository Layout

```text
frontend/
  index.html                  App entry loaded by loader.ts
  pages/                      Landing, portal, auth, static legal pages
  css/                        Global app and performance styles
  js/                         TypeScript source compiled to JS
    core/                     Navigation, state persistence, panels
    config/                   Icons, dependencies, app config
    features/                 Feature modules (see below)
    pages/                    Landing page behavior
    services/                 AI service, storage service wrappers
  views/                      Feature HTML/CSS/JS fragments loaded lazily
    chatbot/                  AI chatbot (standalone)
    chat/                     Student social chat + rooms
    dashboard/                Main dashboard
    deep-learn/               Deep-learn study mode
    editor/                   PDF editor (merge, write, convert)
    examforge/                Exam preparation generator
    flashcards/               Flashcard decks
    games/                    Study games (Tetris, Chess, Solitaire, etc.)
    lecturenotes/             Lecture notes viewer/generator
    notes/                    Notes panel
    practice/                 Practice/exercise mode
    quiz/                     Quiz generation and taking
    cheatsheet/               Cheatsheet generation
    writing-coach/            German writing coach (Schreibtrainer)
    profile/                  User profile
    settings/                 App settings
    subscription/             Billing and subscription management
  extension/                  Chrome browser extension

functions/
  api/                        Cloudflare Pages Functions (API routes)
    ai/                       AI endpoints (ask, stream, generate, feedback, etc.)
    documents/                Upload, list, delete, index, reindex
    learning/                 Topic map, next-action
    notes/                    Notes CRUD
    admin/                    Admin retrieval logs
    ...                       Billing, chat, webhooks

backend/
  lib/                        Shared TypeScript helpers (auth, cors, rate-limit, etc.)
  python-ai/                  FastAPI AI and retrieval service

supabase/migrations/          Reproducible SQL migrations (65+)
tests/                        Node and Playwright tests
docs/                         Specs, launch notes, endpoint docs
```

## Features

| Feature | Description |
|---|---|
| Course management | Semester-based course cards with file counts, progress, last-opened |
| PDF viewer | Multi-tab, page navigation, text extraction, source-link citations |
| AI tutor | RAG-grounded Q&A with streaming answers, source metadata, citations |
| Chatbot | Standalone AI chat with image/file support |
| Lecture notes | AI-generated full lecture notes from course PDFs |
| Flashcards | AI-generated flashcard decks from course material |
| Quiz | AI-generated quizzes with scoring |
| Cheatsheet | Compressed formula/reference sheets |
| ExamForge | Exam preparation material generator |
| Deep Learn | Adaptive topic mastery with difficulty progression |
| Writing Coach | German Schreibtrainer for language learners |
| PDF editor | Merge, annotate, convert PDFs |
| Practice mode | Exercise-focused study sessions |
| Study timer | Pomodoro timer with session tracking |
| Study games | Tetris, Chess, Solitaire, Flappy Bird |
| Student chat | Rooms, DMs, friend lists, GIF search, reports |
| Admin panel | User dashboard, retrieval debug logs, usage charts |
| Subscriptions | Stripe + PayPal with pause, cancel, retention offers |
| Onboarding | University/major selection, guided setup |
| Notifications | In-app notification system |

## API Surface

All paid routes are authenticated with a Supabase JWT and checked against subscription/fair-use limits.

Key routes:

| Route | Purpose |
|---|---|
| `POST /api/ai/ask` | Course-grounded RAG answer |
| `POST /api/ai/stream` | SSE streaming AI answers |
| `POST /api/ai/generate` | Notes, quiz, flashcard, summary generation |
| `POST /api/ai/feedback` | Per-answer feedback |
| `POST /api/ai/writing-coach` | German writing coach |
| `POST /api/ai/cheatsheet` | Cheatsheet generation |
| `POST /api/ai/deep-learn` | Deep-learn session |
| `POST /api/ai/examforge` | Exam prep generation |
| `POST /api/ai/mastery` | Topic mastery tracking |
| `POST /api/ai/quiz-attempt` | Quiz attempt recording |
| `POST /api/ai/usage` | AI usage tracking |
| `POST /api/documents/upload` | Upload and index a document |
| `POST /api/documents/list` | List indexed documents |
| `POST /api/documents/delete` | Delete a document and chunks |
| `POST /api/documents/reindex-course` | Reindex a course |
| `POST /api/documents/index-existing` | Index already-uploaded file |
| `POST /api/notes/generate` | Full lecture-notes generation |
| `GET /api/notes` | Notes CRUD |
| `POST /api/learning/topic-map-generate` | Generate topic map |
| `GET /api/learning/topic-map` | Retrieve topic map |
| `POST /api/create-checkout` | Stripe Checkout |
| `POST /api/create-portal` | Stripe Billing Portal |
| `POST /api/verify-payment` | Post-checkout verification |
| `POST /api/activate-paypal-subscription` | PayPal activation |
| `POST /api/pause-subscription` | Pause subscription |
| `POST /api/cancel-subscription` | Cancel subscription |
| `POST /api/resume-subscription` | Resume subscription |
| `POST /api/stripe-webhook` | Stripe webhook |
| `POST /api/paypal-webhook` | PayPal webhook |
| `POST /api/chat-friends` | Friend list and profile reads |
| `POST /api/send-chat-message` | Student chat message send |
| `POST /api/chat-user-search` | Search for chat users |
| `POST /api/join-room-by-code` | Join chat room by invite code |
| `POST /api/admin-users` | Admin user dashboard |

## Local Development

### Prerequisites

- Node 20+
- Wrangler CLI (Cloudflare)
- Python 3.11+ for the AI service
- Supabase project with migrations applied
- OpenAI, Stripe, and PayPal keys for full local functionality

### Install

```bash
npm install
cp .env.example .env
```

Fill `.env` with Supabase, OpenAI, Stripe, PayPal, and AI service values.

### Run frontend and functions

```bash
npm run dev
```

This runs `wrangler pages dev`, serving the frontend and Cloudflare Pages Functions locally. Opening `frontend/index.html` directly will not support auth, functions, payments, AI, or chat.

### Run Python AI service

```powershell
cd backend/python-ai
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Set `AI_SERVICE_URL=http://localhost:8000` for local function proxying.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run Wrangler Pages dev server |
| `npm run dev:frontend` | Run Vite frontend dev server (HMR) |
| `npm run build` | Full production build (TS compile + dist) |
| `npm run build:frontend` | Compile frontend TypeScript |
| `npm run typecheck` | Type-check backend, frontend, and functions |
| `npm run typecheck:backend` | Type-check backend lib |
| `npm run typecheck:frontend` | Type-check frontend |
| `npm run typecheck:pages` | Type-check Cloudflare Pages Functions |
| `npm run lint` | ESLint frontend JS/TS |
| `npm run test` | Node tests |
| `npm run test:e2e` | Playwright tests |
| `npm run format` | Prettier write |

## Database Migrations

Migrations live in `supabase/migrations/` and should be run in filename order. Do not edit an already-applied production migration. Add a new migration instead.

See [supabase/migrations/README.md](supabase/migrations/README.md).

## Deployment

Frontend deploys automatically via Cloudflare Pages on push to `main`.

Python AI service requires manual deploy:

```bash
cd backend/python-ai
flyctl deploy
```

After deploys that touch subscriptions, webhooks, RLS, or retrieval, run the relevant verification queries from the migration files.

## Security and Cost Controls

- Supabase RLS protects user-owned tables.
- Cloudflare Pages Functions verify Supabase JWTs before paid operations.
- Python AI endpoints require trusted authentication/proxy headers.
- Stripe and PayPal webhooks use signature checks and idempotency tables.
- AI usage is subscription-gated and rate-limited.
- Monthly fair-use limits split interactive chat/RAG calls from heavier generation calls.
- Retrieval uses document/course filters, debug logging, cache keys, and source citations.

## Third-Party Licenses

See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) for all third-party software used.

## Documentation

- [backend/README.md](backend/README.md)
- [backend/python-ai/README.md](backend/python-ai/README.md)
- [supabase/migrations/README.md](supabase/migrations/README.md)
- [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md)
- [docs/python-ai-endpoints.md](docs/python-ai-endpoints.md)

## License

Proprietary. Copyright 2026 Mohamed Ali Mariam. All rights reserved.
