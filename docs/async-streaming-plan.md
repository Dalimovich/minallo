# Async streaming (AsyncOpenAI SSE path) — plan

Status: **planned, not started.** Part of the AI scaling initiative (Phase 2b).
Prereq shipped: per-worker pooled OpenAI client (`get_openai_client()` in
[`backend/python-ai/app/services/openai_client.py`](../backend/python-ai/app/services/openai_client.py)).

## Problem

`ask_stream_endpoint` returns `StreamingResponse(gen(), …)` where
[`gen()`](../backend/python-ai/app/routers/stream.py) is a **sync** generator that
wraps a sync `client.chat.completions.create(stream=True)` plus `for chunk in
stream`. Starlette iterates a sync generator via `iterate_in_threadpool`, so
**every active stream borrows an anyio threadpool token for each token-wait**
across the full 30–50 s of an answer.

The anyio threadpool is raised to 64 tokens per worker (128 across the 2 gunicorn
workers) in `main.py`. That pool is the concurrency ceiling, and streaming
answers are the longest-lived consumers of it. Phase 1 already moved the sync
*routes* into the threadpool (so the event loop itself isn't blocked), but it did
not remove the threadpool dependency of the streaming hot path.

Native async network I/O would let each token-wait sit on the event loop (epoll)
instead of pinning a thread, freeing the threadpool for genuinely-sync work
(Supabase PostgREST HTTP, vision-OCR rasterization).

## Changes (in dependency order)

1. **Async client.** Add `get_async_openai_client()` to `openai_client.py`: an
   `AsyncOpenAI` instance over a pooled `httpx.AsyncClient`, mirroring the sync
   singleton (lru_cache, 100 keep-alive conns). Builds directly on the pooling
   work already shipped.

2. **Async token loop.** Add `astream_answer(...)`, an async-generator twin of
   `stream_answer` in `answer_stream.py`. Keep prompt-building sync (it's fast and
   the endpoint already threadpools its prep); convert only the hot loop to:

   ```python
   stream = await aclient.chat.completions.create(stream=True, …)
   async for chunk in stream:
       ...
       yield _sse({"t": token})
   ```

   Wrap the occasional post-stream **blocking** calls in `run_in_threadpool` /
   `asyncio.to_thread` so they don't re-block the loop:
   - `_force_render_plot` / `_force_render_diagram` (extra LLM calls, refusal
     recovery)
   - deterministic verification
   - `save_answer` (cache write, PostgREST)
   - `record_retrieval_debug` (PostgREST)

3. **Async `gen()`.** Make `gen()` in `stream.py` `async def` with `async for
   chunk_bytes in agen_iter`. The SSE event interception (meta injection, `done`
   frame source translation, `full_text_buf` capture) is unchanged. With an async
   generator, `StreamingResponse` iterates it natively on the loop — no per-chunk
   threadpool token.

## Risk controls

- **Feature flag `MINALLO_ASYNC_STREAM` (default off).** This is the core answer
  path; never a hard cutover. The flag selects async vs the existing sync path so
  prod can flip instantly on regression.
- **Keep sync `stream_answer` intact** as the fallback path behind the flag. Zero
  change to the non-streaming `def` generate endpoints (they remain
  FastAPI-threadpooled and are fine).
- **Tests.** `asyncio_mode=auto` is already configured. Add a patchable
  `get_async_openai_client` seam (same pattern `test_chat_routing` now uses for
  the sync client) plus an async fake stream. Router-level tests that mock
  `stream_answer`/`astream_answer` keep working.
- **Validate with a real load test** (k6 / locust, 50 → 200 concurrent streams)
  comparing threadpool saturation and `/health` latency with the flag off vs on.
  This is the load-test evidence the scaling initiative gates the rewrite on —
  confirm the threadpool is the actual tip-over before committing.

## Optional follow-on (Phase 2b item 3)

Once async, add an `asyncio.Semaphore` around LLM calls to respect the single
OpenAI key's TPM/RPM budget across all users, and consider an account-tier bump.

## Effort

~one focused session. The fiddly parts are the post-stream sync helpers and the
async test fakes, not the loop conversion itself.
