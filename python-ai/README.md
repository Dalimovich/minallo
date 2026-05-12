# StudySphere AI Service

FastAPI service that owns PDF indexing, retrieval, and grounded answer generation for StudySphere.

Currently at **Phase 1**: skeleton + Supabase wiring. No production endpoints yet — see [`docs/python-ai-migration-plan.md`](../docs/python-ai-migration-plan.md) for the full plan and phase status.

## Local dev

Requires Python 3.11+.

```bash
cd python-ai
python -m venv .venv
. .venv/Scripts/activate   # PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"
cp .env.example .env       # then fill in real values
uvicorn app.main:app --reload --port 8080
```

Verify:

```bash
curl http://localhost:8080/health
# → {"status":"ok","service":"studysphere-ai",...}

curl -H "X-Internal-Token: $AI_SERVICE_INTERNAL_TOKEN" \
     http://localhost:8080/internal/db-smoke
# → {"ok":true,"documents_count":<n>}
```

## Tests

```bash
pytest -q
```

The default tests stub env vars and don't touch Supabase or OpenAI. Integration tests that hit real services come later phases.

## Docker

```bash
docker build -t studysphere-ai .
docker run --rm -p 8080:8080 --env-file .env studysphere-ai
```

## Deploy (Fly.io, later phase)

`flyctl launch` from this directory once Phase 2 ships. Region: `fra` to match the Supabase EU region.

## Environment variables

See [`.env.example`](.env.example) for the full list. Naming matches the existing Netlify functions so the two stacks read the same secrets — **no new Supabase project, no new API keys.**

| Var | Origin | Used for |
|---|---|---|
| `SUPABASE_URL` | existing | Supabase REST/Storage base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | existing | server-side admin client |
| `OPENAI_API_KEY` | existing | embeddings + chat completions |
| `OPENAI_GENERATE_MODEL` / `..._STRONG` | existing | chat models |
| `OPENAI_EMBEDDING_MODEL` | new (default `text-embedding-3-small`) | embedding model — must match existing chunks (1536 dim) |
| `AI_SERVICE_INTERNAL_TOKEN` | **new** | shared secret with Netlify proxy |
| `LOG_LEVEL`, `ENVIRONMENT` | new | observability |

## Security model

The browser **never** talks to this service. The flow is:

```
browser  →  studysphere-website.netlify.app/api/ai/*  (verifies Supabase JWT)
         →  Netlify proxy injects trusted user_id + AI_SERVICE_INTERNAL_TOKEN
         →  AI_SERVICE_URL  (this service)
```

Every endpoint other than `/health` requires the internal token header.
