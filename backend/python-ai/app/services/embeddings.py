"""OpenAI embeddings wrapper.

Single function: take a list of strings, return a list of float vectors,
batched to stay under the OpenAI per-request input limit. Vector dimension
is fixed at the model's native dimension (1536 for text-embedding-3-small)
to match the existing `vector(1536)` column in document_chunks.
"""

from __future__ import annotations

import logging
from typing import Sequence

from openai import APIError, OpenAI, RateLimitError

from ..config import get_settings
from .openai_client import get_openai_client

log = logging.getLogger(__name__)

# OpenAI accepts up to ~8k tokens per item and up to 2048 items per request.
# We batch on item count; tiktoken-bounded chunks are already well under the per-item cap.
_BATCH_SIZE = 100


class EmbeddingServiceUnavailable(RuntimeError):
    """Raised when the embedding provider cannot serve retrieval right now."""


def _client() -> OpenAI:
    return get_openai_client()


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Embed a list of strings. Returns vectors aligned to input order."""
    if not texts:
        return []

    settings = get_settings()
    client = _client()
    out: list[list[float]] = []

    for start in range(0, len(texts), _BATCH_SIZE):
        batch = list(texts[start:start + _BATCH_SIZE])
        try:
            resp = client.embeddings.create(
                model=settings.openai_embedding_model,
                input=batch,
                dimensions=settings.openai_embedding_dim,
            )
        except RateLimitError as exc:
            log.exception("embedding provider rate-limited retrieval")
            raise EmbeddingServiceUnavailable(
                "AI retrieval is temporarily unavailable because the embedding provider is out of quota."
            ) from exc
        except APIError as exc:
            log.exception("embedding provider failed")
            raise EmbeddingServiceUnavailable(
                "AI retrieval is temporarily unavailable because the embedding provider failed."
            ) from exc
        # OpenAI returns embeddings in input order.
        out.extend(item.embedding for item in resp.data)

    return out
