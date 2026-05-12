# StudySphere — Python AI/RAG Migration Plan

Status: **Phase 1 in progress** (FastAPI skeleton + Supabase wiring).
Branch: `python-ai-rag-service` (forked off `main`).
Constraint: same Supabase project, same tables, same Netlify functions folder, same env var names.

---

## Goal

Move the heavy AI/PDF work (PDF indexing, retrieval, answer generation, quiz/flashcard/notes generation) into a dedicated Python FastAPI service while the existing website and Netlify functions keep running. Old JS logic stays behind a feature flag (`USE_PYTHON_AI`) until the new service is proven stable.

```
Frontend (JS, unchanged URLs)
  └── /api/ai/*      (Netlify proxy after Phase 2)
        └── Python FastAPI (new)
              ├── Supabase Postgres (existing tables)
              └── Supabase Storage (existing bucket)
```

---

## Current state — what lives where

### Frontend → backend call sites
All AI/PDF calls go through `frontend/js/services/ai-service.js`:

| Endpoint | What it does |
|---|---|
| `POST /api/documents/upload`            | upload to storage + insert `documents` row |
| `GET  /api/documents/list`              | list course docs |
| `POST /api/documents/index-existing`    | re-trigger indexing |
| `POST /api/documents/delete`            | cascade delete |
| `POST /api/ai/ask`                      | RAG question answering |
| `POST /api/ai/generate`                 | flashcards / quiz / summary |
| `POST /api/ai/feedback`                 | retrieval evals |
| `POST /api/ai`                          | legacy generic AI call |

### Netlify functions / libs (current responsibilities)

| File | Lines | Will it move? |
|---|---|---|
| `backend/functions/documents-upload.js` | 141 | **stay** — auth + storage, fires indexing |
| `backend/functions/documents-process-background.js` | 781 | **→ Python** (PDF parse, chunk, embed) |
| `backend/functions/documents-index-existing.js` | — | **stay** as thin proxy |
| `backend/functions/documents-delete.js` | — | **stay** |
| `backend/functions/documents-list.js` | — | **stay** |
| `backend/functions/ai-ask.js` | 1462 | **→ Python** (retrieve / rerank / ground / cache) |
| `backend/functions/ai-generate.js` | 51 | **stay** as proxy shell |
| `backend/lib/study-pipeline.js` | 899 | **→ Python** (quiz, flashcards, summary) |
| `backend/lib/summary-pipeline.js` | 268 | **→ Python** |
| `backend/functions/notes-generate.js` | 734 | **→ Python** |
| `backend/functions/ai-evaluate.js`, `ai-feedback.js` | — | stay |

All non-AI endpoints (Stripe, chat, friends, admin, billing) stay in JS.

### Database — already adequate

Existing tables in `supabase/migrations/` (canonical) and `backend/migrations/` (older copies, dedup later):

| Table / RPC | Purpose | Maps to user-proposed |
|---|---|---|
| `documents` (with `document_hash`, `processing_status`, `processing_error`) | doc metadata + index state | `documents` + `document_index_jobs` |
| `document_pages` | per-page raw + cleaned text | `document_pages` |
| `document_chunks` (embedding column built in via `pgvector`) | chunks + 1536-dim vectors | `document_chunks` + `document_embeddings` |
| `ai_answer_cache` | answer cache by question hash | `ai_answer_cache` |
| `ai_question_cache` | normalized question variants | fuzzy match helper |
| `flashcard_decks` | persisted decks | `generated_flashcards` |
| `study_sets` | quizzes | `generated_quizzes` |
| `notes` | generated notes | `generated_notes` |
| RPC `match_chunks_hybrid()` | hybrid vector + BM25 with `document_id` filter | retrieval |
| eval tables | retrieval quality logging | `retrieval_logs` |

**Conclusion:** the DB layer is in good shape. At most one small migration to add columns to `documents` (covered in Phase 2).

---

## What stays JS vs. what moves to Python

**Stays JS (Netlify):**
- Auth + RLS-touching endpoints (`documents-upload`, `-delete`, `-list`).
- All non-AI endpoints (Stripe, chat, etc.).
- A thin **proxy layer** (`ai-proxy.js`) that:
  1. verifies the Supabase JWT,
  2. injects `user_id` from the token (so client can't spoof),
  3. signs the request with `AI_SERVICE_INTERNAL_TOKEN`,
  4. forwards to `$AI_SERVICE_URL`,
  5. streams the response back.

**Moves to Python (FastAPI):**
- PDF parsing, OCR fallback, page extraction, chunking, embedding (`documents-process-background.js`).
- RAG retrieve / rerank / answer / cache (`ai-ask.js`).
- Quiz / flashcards / summary (`study-pipeline.js`, `summary-pipeline.js`).
- Notes (`notes-generate.js`).

**Why proxy through Netlify, not direct browser → Python:**
- JWT verification stays in one place.
- Browser only talks to `studysphere-website.netlify.app` (CORS stays simple).
- Python service can be swapped (Fly → Render → VPS) by changing one env var.
- Flip JS ↔ Python with `USE_PYTHON_AI` during cutover without touching frontend.

---

## Endpoints the Python service must expose

| Method | Path | Replaces |
|---|---|---|
| `POST` | `/index-document`           | `documents-process-background.js` |
| `GET`  | `/document-index-status`    | (status sniff inside upload + frontend polling) |
| `POST` | `/retrieve-context`         | retrieval half of `ai-ask.js` |
| `POST` | `/ask`                      | `ai-ask.js` |
| `POST` | `/generate-quiz`            | quiz path in `study-pipeline.js` |
| `POST` | `/generate-flashcards`      | flashcards path in `study-pipeline.js` |
| `POST` | `/generate-notes`           | `notes-generate.js` + `summary-pipeline.js` |
| `POST` | `/evaluate-retrieval`       | optional logging hook |

Full request/response shapes are spec'd in the original brief; this doc is the running plan, not the spec.

### Required AI behaviour (binding)
- Use uploaded files as the **only** source of truth.
- Never invent content.
- Cite source pages.
- If context quality is weak, say so explicitly — **no silent general-knowledge fallback.**
- Strict count validation on quiz / flashcards; retry to fill shortfall, surface warning if impossible.
- Notes length scales with PDF length.

---

## Phases

### Phase 1 — Python skeleton + Supabase wiring **← we are here**
Adds only:
- `python-ai/pyproject.toml` — fastapi, uvicorn, httpx, supabase-py, openai, pdfminer.six, tiktoken, pytest.
- `python-ai/app/main.py` — FastAPI app + `/health`.
- `python-ai/app/config.py` — env loading.
- `python-ai/app/supabase_client.py` — service-role client.
- `python-ai/app/auth.py` — `AI_SERVICE_INTERNAL_TOKEN` check (shared secret between Netlify and Python).
- `python-ai/Dockerfile`, `.dockerignore`.
- `python-ai/README.md`.
- `python-ai/.env.example`.

No frontend changes. No Netlify changes. No DB migrations. Service must run locally and return 200 on `/health`.

### Phase 2 — `/index-document` + `/document-index-status` + Netlify proxy
Python: routers + indexing service (download from storage, pdfminer extract, chunk, embed `text-embedding-3-small`, upsert into `document_pages` + `document_chunks`, update `documents`).
Netlify: new `backend/functions/ai-proxy.js` that auth + forwards. `documents-upload.js` switches to proxy call (behind `USE_PYTHON_AI`).
DB: one small additive migration (only if columns are missing) — explained and approved before running.

### Phase 3 — `/retrieve-context` + `/ask`
Python: retrieval service using existing `match_chunks_hybrid` RPC, reranker (start with open-source `bge-reranker-base`), grounded-answer composer, answer cache against `ai_answer_cache`.
Netlify: `ai-ask.js` becomes a flag-gated proxy.

### Phase 4 — quiz, flashcards, notes
Python: `/generate-quiz`, `/generate-flashcards`, `/generate-notes` with the strict count-validation + retry loop.
Netlify: `ai-generate.js` and `notes-generate.js` become flag-gated proxies.

### Phase 5 — observability + cutover
Structured logs from Python, retrieval logs into existing eval table. After a week clean on real traffic, default `USE_PYTHON_AI=true`. Two more weeks stable → remove dead JS bodies.

### Phase 6 — cleanup
Delete the old AI implementations (keep proxy shells). Dedup `backend/migrations/` vs `supabase/migrations/` in a separate pass.

---

## Deployment

**Host: Fly.io** (Dockerfile-based, EU region to match Supabase, comfortable free tier).
Alternatives ranked: Render → Railway → VPS.

**New env vars:**
- `AI_SERVICE_URL` (set in Netlify) — base URL of the Python service.
- `AI_SERVICE_INTERNAL_TOKEN` — shared secret, set in **both** Netlify and Fly.
- `USE_PYTHON_AI` (Netlify, "true"/"false") — global feature flag during cutover.

**Reused env vars (no renames):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_GENERATE_MODEL`, `OPENAI_GENERATE_MODEL_STRONG`

---

## Decisions for v1

| Decision | Choice | Notes |
|---|---|---|
| Branch base | `main` | `editor-redesign` can rebase later if it ships first. |
| Host | Fly.io | EU region. |
| OCR (tesseract) | **Skip in v1** | Adds ~500MB to image; add later when a user reports a scanned PDF. |
| Streaming `/ask` | **Skip in v1** | Match current parity; add later. |
| Embedding model | **Keep `text-embedding-3-small`** | All existing chunks are 1536-dim; switching means re-embed everything. |
| Reranker | `bge-reranker-base` (open-source, CPU-friendly) | Cohere reranker is the upgrade path if quality demands it. |

---

## Security checklist (binding for every endpoint)
- Every retrieval query filters by `user_id` AND `course_id`.
- Every document query verifies the caller owns / has access.
- `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` never reach the browser.
- Python ↔ Netlify auth via `AI_SERVICE_INTERNAL_TOKEN`; the Python service never trusts a raw user-supplied `user_id` — Netlify proxy derives it from the verified JWT and includes it in the signed request.

---

## Open / deferred
- OCR support — backlog.
- Streaming `/ask` — backlog.
- Reranker cost / quality A/B — measure after Phase 3 ships.
- Migrations folder dedup — Phase 6.
- Re-embedding for any model change — would require a backfill job; out of scope for v1.

---

## What progress means
- ✅ Phase 1: `python-ai/` boots locally, `/health` returns 200, Supabase service-role client connects (smoke test reads from `documents` table).
- ⏳ Phase 2 starts after Phase 1 is approved.
