# Concurrency / scaling roadmap (python-ai)

Living checklist for making the Fly `python-ai` service survive heavy traffic.
Companion to the `ai-scaling-initiative` memory and
[`async-streaming-plan.md`](async-streaming-plan.md).

## Architecture in one line
FastAPI + gunicorn (2 × UvicornWorker) on one Fly machine (2 shared vCPU / 2 GB).
All state is DB-backed via Supabase PostgREST HTTP (no raw Postgres). Heavy work
= OpenAI calls (answers, generation, embeddings, vision OCR). Concurrency is
bounded by the anyio threadpool (64/worker), the single OpenAI key's TPM/RPM,
and 2 GB of RAM.

## Done
- **Phase 1** — sync routes → `def` (FastAPI threadpools them); anyio limiter 64;
  gunicorn 2 workers; 2 vCPU / 2 GB. (Event loop no longer blocked.)
- **Phase 2a** — indexing crash-recovery + in-process concurrency bound.
- **Pooling** — one process-wide `get_openai_client()` instead of rebuilding a
  client (new TLS handshake) per call.
- **This batch (Phase 2b, wave 1):**
  - [x] **Supabase client timeout** — `SyncClientOptions(postgrest/storage
    timeout)`, env `SUPABASE_CLIENT_TIMEOUT` (default 30s). A hung PostgREST call
    can no longer pin a threadpool thread forever.
  - [x] **Global generation fan-out bound** — one process-wide
    `BoundedSemaphore` inside `chat_json` (`app/services/concurrency.py`), env
    `LLM_FANOUT_MAX_CONCURRENCY` (default 16). Caps total concurrent generation
    LLM calls so cheatsheet/quiz/flashcards fan-out can't spawn unbounded threads
    or saturate the OpenAI quota. The interactive stream path bypasses
    `chat_json`, so live tutoring is never throttled by bulk generation.
  - [x] **Worker recycling** — gunicorn `--max-requests 2000
    --max-requests-jitter 200` to shed slow memory growth on the 2 GB box.
  - [x] **Edge admission control** — `[http_service.concurrency]` soft 100 /
    hard 140 in `fly.toml`. Beyond the hard limit Fly returns 503 instead of
    letting requests pile into the threadpool and die on the 120s Cloudflare cap.
  - [x] **Query-embedding cache** — `embed_query()` LRU (env
    `EMBED_QUERY_CACHE_SIZE`, default 2048); repeated/popular questions skip a
    per-request OpenAI embedding call.
  - [x] **Observability** — `GET /internal/metrics` (internal-token) reports
    threadpool total/borrowed + fan-out limit/in-use, per worker PID.
  - [x] **Load harness** — `scripts/loadtest/locustfile.py` (Phase 0).

## Next (load-test-gated — run the harness first)
- [ ] **Run the load test** (k6/locust 50→200) and read `/internal/metrics` to
  confirm whether threadpool, OpenAI quota, or RAM tips first. Everything below
  is prioritised by that result.
- [ ] **Async streaming** — convert the ask-stream hot path to `AsyncOpenAI` so
  streams stop holding a threadpool thread each. See
  [`async-streaming-plan.md`](async-streaming-plan.md). Biggest lever if the
  threadpool saturates first.
- [ ] **Job + poll for heavy generation** — return a job id + poll instead of
  holding a ~50s request open (cheatsheet/examforge/quiz). Frees the worker and
  dodges the proxy timeout entirely.
- [ ] **TPM-aware, prioritised LLM governor** — richer than the count semaphore:
  a token-budget governor that prioritises interactive answers over bulk
  indexing/generation, with proper 429 backoff. Pair with an OpenAI tier bump.

## Judgement calls (need an operator decision, not a blind change)
- [ ] **Horizontal scale (machine count).** `fly.toml` is now ready to
  load-balance + auto-start, but actually provisioning more machines
  (`fly scale count N`) is a **cost decision**. Revisit once the load test shows
  one box tips over. When scaling >1: the indexing semaphore + recovery sweep are
  per-machine (verify aggregate OpenAI/OCR load and that the DB-claim dedup holds
  across machines).
- [ ] **CPU-bound work vs the GIL.** tiktoken chunking, PDF→PNG rasterization and
  large-JSON parsing are CPU-bound; with 2 shared vCPU + the GIL, a bigger
  threadpool does NOT help them — they serialize. This is analysis, not a blind
  patch: profile under load, then either isolate the hot CPU paths (process pool)
  or accept/size around the 2-vCPU ceiling (possibly `performance` CPUs, which
  force ≥4 GB). Don't "fix" speculatively.

## Tunables (env)
| Var | Default | Effect |
| --- | --- | --- |
| `LLM_FANOUT_MAX_CONCURRENCY` | 16 | Max concurrent generation LLM calls / worker |
| `SUPABASE_CLIENT_TIMEOUT` | 30 | PostgREST/storage HTTP timeout (s) |
| `EMBED_QUERY_CACHE_SIZE` | 2048 | Query-embedding LRU entries / worker |
| `INDEXING_MAX_CONCURRENCY` | 2 | Concurrent document indexings / worker (Phase 2a) |
