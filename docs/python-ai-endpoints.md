# Minallo Python AI — Endpoint Reference

Base URL: `https://python-ai.fly.dev`
Auth: every endpoint requires `X-Internal-Token: <INTERNAL_SECRET>` except
`/ask-stream` (browser hits it directly with `Authorization: Bearer <supabase_jwt>`)
and `/health` (unauthenticated).

Netlify functions are auth + proxy shells. The browser still calls the
existing `/api/*` URLs; each handler verifies the Supabase JWT, injects
`userId` from the verified token, and forwards to the matching Python
route below.

---

## Health

### `GET /health`
Unauthenticated liveness probe.
**Response:** `{ status, service, version, environment }`

---

## Indexing

### `POST /index-document`
Parse a PDF from Supabase Storage, chunk it, embed, upsert into
`document_pages` + `document_chunks`.

**Request**
```json
{ "userId": "uuid", "courseId": "uuid", "documentId": "uuid", "storagePath": "bucket:path" }
```
**Response** `{ "ok": true, "chunkCount": int }`
**Called by** `documents-upload.js`, `documents-index-existing.js`

---

## RAG

### `POST /ask`
Non-streaming grounded answer. Cache-aware.

**Request**
```json
{ "userId": "uuid", "courseId": "uuid", "documentIds": ["uuid", ...] | null,
  "question": "...", "bypassCache": false }
```
**Response**
```json
{ "answer": "...", "retrievalMode": "strong|weak|none",
  "groundedSources": [{ "fileName", "pageStart", "pageEnd", "sectionTitle", "chunkType", "similarity" }],
  "cacheHit": bool, "model": "...", "promptTokens": int, "completionTokens": int }
```
Sources are filtered to `[Source N]` mentions actually present in the answer text.
**Called by** `ai-ask.js`

### `POST /ask-stream`
Same as `/ask` but SSE-streamed. **Browser calls this directly** with the
Supabase JWT — bypasses Netlify so the connection isn't capped at 30s.

**Events** (`data: <json>\n\n`)
- `{ meta: true, retrievalMode, confidence, unsupported }` — opening
- `{ t: "token" }` — each token
- `{ done: true, sources: [{file_name, pages, section}], retrievalMode, model, ... }` — closing
- `{ error: "..." }` — fatal

### `POST /retrieve-context`
Returns raw retrieved chunks without generating an answer. Used by
evaluation tooling.

**Request** `{ userId, courseId, documentIds?, query, topK }`
**Response** `{ chunks: [{ chunkId, documentId, text, score, similarity, pageStart, pageEnd, ... }] }`

---

## Study tools

### `POST /generate-quiz`
**Request**
```json
{ "userId", "courseId", "documentIds": [..] | null,
  "requestedCount": 1..20, "difficulty": "easy|medium|hard|mixed",
  "questionTypes": ["mcq","true_false","short_answer"] | null,
  "save": true, "name": "..." }
```
**Response** `{ requestedCount, actualCount, questions: [...], warning?, studySetId?, model, promptTokens, completionTokens }`
**Note** — Python emits `options` as `{A,B,C,D}` dict and `answer` as a letter; the JS proxy normalises to array + numeric index before reaching the frontend.

### `POST /generate-flashcards`
**Request** `{ userId, courseId, documentIds, requestedCount: 1..24, save, name }`
**Response** `{ requestedCount, actualCount, cards: [...], warning?, studySetId?, model, ... }`

### `POST /generate-notes`
RAG-driven whole-document notes. Used by `ai-generate.js` (tool='summary').
**Request** `{ userId, courseId, documentIds, topic?, title?, save }`
**Response** `{ text, pageCount, lengthCue, groundedSources: [...], warning?, noteId? }`

### `POST /notes-generate`
Full notes pipeline with scope + mode (used by the per-PDF notes panel).
**Request**
```json
{ "userId", "courseId", "documentId" | null, "tool": "notes|summary",
  "mode": "generate|section|merge|analyze",
  "scope": "page|section|range|document",
  "fileName" | null, "pdfText" | null,
  "language": "same_as_source|de|en|bilingual",
  "detailLevel": "brief|balanced|detailed|exam",
  "currentPage", "pageRange": {start,end} | null,
  "topicTitle", "sections": [...], "effectivePages", "title" }
```
**Response by mode**
- `analyze` → `{ groups: [], effectivePages }` (frontend uses fixed splits)
- `section` → `{ markdown, pageStart, pageEnd, empty?, error? }`
- `merge` → `{ note: { id, title, type, content_markdown, sources } }`
- `generate` → same `{ note: {...} }` shape, or `{ error, indexing? }` if no context
**Called by** `notes-generate.js`

---

## Chat

### `POST /chat`
Generic vision-capable GPT-4o chatbot. Anthropic-shaped input → Anthropic-shaped output (so the existing frontend code in `chatbot.js` works unchanged).

**Request**
```json
{ "userId", "system": "...",
  "messages": [{ "role": "user|assistant|system",
                 "content": "string" | [{ "type": "text", "text": "..." } |
                                        { "type": "image", "source": { "type": "base64", "media_type": "...", "data": "..." } }] }],
  "max_tokens": int }
```
**Response** `{ "content": [{ "type": "text", "text": "..." }] }`
**Limits** 200 msgs, 120k system chars, 120k text chars, 5 images, 5 MB base64/image, 2048 completion tokens.

---

## Misc

### `POST /feedback`
Insert into `ai_feedback`.
**Request** `{ userId, courseId, question, rating, answerCacheId?, feedbackText?, reason? }`
Valid ratings: `helpful, not_helpful, wrong_answer, not_in_lecture, missing_citation, wrong_formula, too_vague, wrong_language`
**Response** `{ ok: true }`

### `POST /evaluate-retrieval`
Run RAG eval suite for a course (or a single test by `evaluationId`).
**Request** `{ userId, courseId, evaluationId? }`
**Response** `{ ran, passed, failed, results: [...] }`

---

## Internal

### `GET /internal/db-smoke`
Auth: `X-Internal-Token`. Returns `documents` count — used during deploy
to verify the service can reach Postgres.

---

## Env vars (Fly secrets)

| Var | Source |
|---|---|
| `SUPABASE_URL` | reused from Netlify |
| `SUPABASE_SERVICE_ROLE_KEY` | reused from Netlify |
| `OPENAI_API_KEY` | reused from Netlify |
| `OPENAI_GENERATE_MODEL` (default `gpt-4o-mini`) | new |
| `OPENAI_GENERATE_MODEL_STRONG` (default `gpt-4o`) | new |
| `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`) | new |
| `INTERNAL_SECRET` | shared with Netlify — internal-token auth |
| `RAG_STORAGE_BUCKET` (default `course-uploads`) | new |
| `ENVIRONMENT`, `LOG_LEVEL` | new |

## Deploy

```
flyctl deploy -a python-ai -c python-ai/fly.toml
flyctl logs -a python-ai
flyctl status -a python-ai
```

Two HA machines in `fra`. Auto-stop on idle — first request after idle has ~3–5s cold-start.
