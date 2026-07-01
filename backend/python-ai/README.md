# Minallo Python AI Service

FastAPI service for document indexing, retrieval, grounded answers, streaming AI, notes, flashcards, quizzes, and German writing coach support.

This service is the AI/RAG backend used by the Cloudflare Pages Functions API layer.

## Responsibilities

- Index uploaded course documents into Supabase/pgvector.
- Extract and store page/chunk metadata, document type, exercise handles, formula blocks, topics, and OCR quality signals.
- Retrieve relevant chunks with hybrid semantic/keyword ranking.
- Prefer active/open document context when useful, then expand to course-level context.
- Return answers with source metadata so the frontend can show citations.
- Generate notes, summaries, quizzes, flashcards, and study material.
- Support streamed answers for the chatbot/problem-solver experience.
- Run German writing coach analysis.
- Provide evaluation hooks for retrieval and OCR quality.

## Layout

```text
backend/python-ai/
  app/
    main.py                 FastAPI app wiring
    routers/                ask, stream, generate, index, chat, notes, misc
    services/               retrieval, embeddings, answer, generation, OCR, etc.
  scripts/                  Live/manual eval helpers
  tests/                    Pytest tests and fixtures
  requirements.txt          Runtime dependencies
  pyproject.toml            Package/dev tooling
  fly.toml                  Fly.io deployment config
```

## Main Routers

| Router | Purpose |
|---|---|
| `ask.py` | Grounded RAG answers |
| `stream.py` | Streaming answer path |
| `generate.py` | Quiz, flashcard, summary, study material generation |
| `index.py` | Document indexing/reindexing |
| `chat.py` | Chat-oriented AI endpoint helpers |
| `notes_full.py` | Full notes generation |
| `writing_coach.py` | German writing coach |
| `misc.py` | Health and support endpoints |

## Local Development

Requires Python 3.11+.

```powershell
cd backend/python-ai
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

Point Cloudflare Pages Functions at the local service:

```text
AI_SERVICE_URL=http://localhost:8000
```

## Tests

```bash
cd backend/python-ai
pytest -q
```

Some tests/evals are intentionally gated because they require real Supabase/OpenAI access. See the fixture READMEs under `tests/fixtures/`.

## Live Evaluation

Math/RAG fixture runner:

```bash
python scripts/run_math_eval.py
```

Required environment variables are documented in [scripts/README.md](scripts/README.md).

OCR evaluation:

```powershell
$env:MINALLO_RUN_OCR_EVAL = "1"
$env:OPENAI_API_KEY = "sk-..."
pytest backend/python-ai/tests/test_vision_ocr_eval.py -v -s
```

OCR indexing is enabled by default with `MINALLO_VISION_OCR_ENABLED=true`.
When enabled, sparse/scanned pages use OpenAI vision, formula-sheet pages can
route to Mathpix via `MINALLO_MATHPIX_ROUTING`, and likely handwritten pages use
the `openai_handwriting` path with higher DPI rendering, image preprocessing,
page-level confidence, and `ocr_needs_review` flags for a correction workflow.

## Docker

```bash
docker build -t minallo-ai .
docker run --rm -p 8000:8000 --env-file .env minallo-ai
```

## Deployment

```bash
cd backend/python-ai
flyctl deploy
```

Prefer the `fra` region to keep latency close to the European Supabase project.

## Environment Variables

See `.env.example` for the full list.

Common variables:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase API base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access |
| `OPENAI_API_KEY` | LLM and embedding calls |
| `OPENAI_GENERATE_MODEL` | Default generation model |
| `OPENAI_GENERATE_MODEL_STRONG` | Stronger model for harder tasks |
| `OPENAI_EMBEDDING_MODEL` | Embedding model, dimension must match DB |
| `INTERNAL_SECRET` | Shared trust secret with Cloudflare Pages Functions |
| `LOG_LEVEL` | Logging verbosity |
| `ENVIRONMENT` | local/staging/production behavior |

## Security Model

The browser should not call privileged endpoints without the same checks enforced by the Cloudflare Pages Functions layer.

Expected production flow:

```text
browser
  -> Cloudflare Pages /api/ai/*
  -> JWT, subscription, and rate-limit checks
  -> Python AI service
  -> Supabase/OpenAI
```

Every endpoint that reads user data must keep user/course/document filters explicit. Retrieval must never treat all uploaded files as globally available context.

## Retrieval Notes

The current retrieval stack is designed for course-material accuracy:

- Hybrid semantic + keyword retrieval.
- Active document as a ranking hint, not a hard limit.
- Course-level fallback when the active PDF does not contain enough context.
- Document type awareness for lecture, exercise, formula sheet, notes, and unknown files.
- Exercise/formula exact-match handles.
- Retrieval debug logging for admin inspection.
- Answer cache keyed by document/course context.
- Missing-context behavior instead of confident unsupported answers.
