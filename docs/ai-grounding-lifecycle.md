# AI grounding lifecycle

The chatbot keeps a browser-local chat ID and a separate server-persisted
conversation ID. Before a grounded request it idempotently creates or resolves
the server conversation, persists the current user message, and guarantees an
empty tutor-state row. `/ask-stream` validates that durable identity against the
authenticated user before loading or updating extraction progress.

The visual path is:

```text
authoritative viewer state
→ stable page snapshot (exact PDF page, PNG)
→ /ask-stream image validation
→ visual task identity
→ final grounding-state calculation
→ grounded answer
```

Pasted screenshots with an open PDF bind to its visible page. Without an open
PDF they use `visual_upload` as their explicit source; they are not silently
dropped and do not claim course-file citations. A missing AI service is a typed
`rag_service_unavailable` failure for every grounded request. Generic fallback
is reserved for requests that were classified as non-document chat before this
pipeline starts.

Generated summaries and cheatsheets override an open PDF only through a narrow
artifact-type/title reference. Generic words such as “created” and “generated”
must never switch the active source.
