"""Per-document topic extraction for the tutor-mode plan (phase 1).

Two cheap LLM passes run after chunking + embedding:
  1. propose a short list of 3-8 high-signal topics for the whole document
     (think: "Kräftegleichgewicht", "Momentengleichgewicht", "Reibung").
  2. assign each chunk a single primary topic drawn from that list.

The result is written to document_chunks.topics + primary_topic. Phase 2
reads those columns to build user_topic_mastery.

Cost: ~1 + ceil(n_chunks / BATCH) gpt-4o-mini calls per indexed doc — well
under $0.05 even on a 200-chunk textbook.

All failures here are non-fatal: index_document() catches and logs.
"""

from __future__ import annotations

import logging
from typing import Any

from .chunking import Chunk
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MIN_TOPICS = 3
_MAX_TOPICS = 8
_ASSIGN_BATCH = 25                 # chunks per assignment LLM call
_CHUNK_SAMPLE_CHARS = 320          # per-chunk snippet length sent to the model
_PROPOSE_SAMPLE_CHUNKS = 18        # number of representative chunks for proposal
_MAX_TOPIC_LABEL_CHARS = 60


def _sample_for_proposal(chunks: list[Chunk]) -> list[str]:
    """Pick representative chunks evenly across the doc for the proposal step.

    Evenly-spaced sampling beats "first N" because textbook intros / TOCs
    are not where the real topics live.
    """
    n = len(chunks)
    if n <= _PROPOSE_SAMPLE_CHUNKS:
        picks = chunks
    else:
        step = max(1, n // _PROPOSE_SAMPLE_CHUNKS)
        picks = chunks[::step][:_PROPOSE_SAMPLE_CHUNKS]
    return [(c.chunk_text or "")[:_CHUNK_SAMPLE_CHARS] for c in picks if c.chunk_text]


def _propose_topics(file_name: str, samples: list[str]) -> list[str]:
    if not samples:
        return []
    system = (
        "You read a chunk of a university course document and propose a short "
        "list of high-signal topic labels that summarise what the document "
        "actually covers. Topics are nouns or noun phrases a student would "
        "recognise from the syllabus: e.g. 'Kräftegleichgewicht', "
        "'Momentengleichgewicht', 'Reibung', 'Eigenwertproblem', "
        "'Fourier-Transformation'.\n\n"
        f"Return between {_MIN_TOPICS} and {_MAX_TOPICS} topics. Prefer the "
        "language the document is written in. No duplicates. No filler "
        "labels like 'Introduction' or 'Summary'. Each label ≤ "
        f"{_MAX_TOPIC_LABEL_CHARS} characters."
    )
    user_parts = [f"FILE: {file_name or 'unknown.pdf'}", "", "SAMPLE CHUNKS:"]
    for i, s in enumerate(samples, start=1):
        user_parts.append(f"--- chunk {i} ---")
        user_parts.append(s)
    user_parts.append("")
    user_parts.append('Respond as JSON: {"topics": ["...", "..."]}')

    result = chat_json(system=system, user="\n".join(user_parts), max_tokens=400)
    raw = result.data.get("topics") if isinstance(result.data, dict) else None
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        if not isinstance(t, str):
            continue
        label = t.strip()[:_MAX_TOPIC_LABEL_CHARS]
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
        if len(out) >= _MAX_TOPICS:
            break
    return out


def _assign_primary_topics(
    chunks: list[Chunk], topics: list[str]
) -> list[str | None]:
    """Return one primary topic (or None) per input chunk, preserving order.

    Runs in batches so the prompt stays small and a single failure only
    knocks out one batch instead of the whole doc.
    """
    if not topics or not chunks:
        return [None] * len(chunks)

    topics_block = "\n".join(f"- {t}" for t in topics)
    results: list[str | None] = []

    for start in range(0, len(chunks), _ASSIGN_BATCH):
        batch = chunks[start:start + _ASSIGN_BATCH]
        system = (
            "You assign exactly one topic from the provided list to each chunk "
            "of course material. Choose the topic that best matches what the "
            "chunk teaches. If a chunk genuinely covers none of the topics "
            "(e.g. a title page, a table of contents, a generic intro), return "
            "null for that chunk. Do not invent new topics. Do not change "
            "spelling or capitalisation of the topic labels — copy them "
            "verbatim from the list."
        )
        user_parts = [
            "TOPICS:",
            topics_block,
            "",
            "CHUNKS (assign one topic per chunk, by index):",
        ]
        for i, c in enumerate(batch):
            snippet = (c.chunk_text or "")[:_CHUNK_SAMPLE_CHARS]
            user_parts.append(f"--- chunk {i} ---")
            user_parts.append(snippet)
        user_parts.append("")
        user_parts.append(
            'Respond as JSON: '
            '{"assignments": [{"index": 0, "topic": "..."}, ...]}. '
            'Use null for chunks that match no topic.'
        )
        try:
            result = chat_json(
                system=system,
                user="\n".join(user_parts),
                max_tokens=800,
            )
            raw = result.data.get("assignments") if isinstance(result.data, dict) else None
        except Exception:  # noqa: BLE001
            log.exception(
                "topic assignment batch %d–%d failed; leaving primary_topic NULL",
                start, start + len(batch),
            )
            raw = None

        batch_out: list[str | None] = [None] * len(batch)
        topics_lower = {t.lower(): t for t in topics}
        if isinstance(raw, list):
            for entry in raw:
                if not isinstance(entry, dict):
                    continue
                idx = entry.get("index")
                topic = entry.get("topic")
                if not isinstance(idx, int) or idx < 0 or idx >= len(batch):
                    continue
                if not isinstance(topic, str):
                    continue
                canonical = topics_lower.get(topic.strip().lower())
                if canonical:
                    batch_out[idx] = canonical
        results.extend(batch_out)

    # Defensive: pad/truncate to exactly len(chunks). Should already match.
    if len(results) < len(chunks):
        results.extend([None] * (len(chunks) - len(results)))
    return results[:len(chunks)]


def extract_topics(
    *, file_name: str, chunks: list[Chunk]
) -> tuple[list[str], list[str | None]]:
    """Return ``(topics, primary_topic_per_chunk)``.

    Best-effort. Empty topics + all-None assignments is a valid return
    (the caller writes those as NULL columns and indexing succeeds).
    """
    if not chunks:
        return [], []
    samples = _sample_for_proposal(chunks)
    topics = _propose_topics(file_name, samples)
    if not topics:
        return [], [None] * len(chunks)
    assignments = _assign_primary_topics(chunks, topics)
    return topics, assignments


def topic_extraction_summary(
    topics: list[str], assignments: list[str | None]
) -> dict[str, Any]:
    """Counters for logging / debug — never raises."""
    by_topic: dict[str, int] = {}
    for a in assignments:
        if a:
            by_topic[a] = by_topic.get(a, 0) + 1
    return {
        "topic_count": len(topics),
        "assigned_chunks": sum(1 for a in assignments if a),
        "unassigned_chunks": sum(1 for a in assignments if not a),
        "per_topic": by_topic,
    }
