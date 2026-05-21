"""End-to-end document indexing pipeline.

  download from Supabase Storage
    → extract per-page text with pdfminer
    → smart-chunk with heading + study-value awareness
    → embed each chunk with OpenAI
    → upsert document_pages and document_chunks
    → update documents.processing_status / chunk_count / indexed_at

The pipeline is idempotent on a given document_id: existing chunks/pages
for the document are deleted before fresh rows are inserted. Status
transitions are written to Postgres at each phase so a frontend that
polls /document-index-status sees real progress.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase
from .block_detection import (
    ExerciseBlock,
    FormulaBlock,
    detect_exercises,
    detect_formulas,
)
from .chunking import Chunk, chunk_pages
from .document_intelligence import classify_document, measure_ocr_need, rollup_extraction_quality
from .embeddings import embed_texts
from .extraction import extract_pages_text
from .markdown_indexing import PageMarkdown, page_to_markdown
from .storage import download_document_bytes
from .topic_extraction import extract_topics, topic_extraction_summary

log = logging.getLogger(__name__)


# ── public surface ──────────────────────────────────────────────────────────


class IndexingError(Exception):
    """Indexing failed in a way the caller (the API layer) needs to surface."""


def index_document(document_id: str, *, force: bool = False) -> dict[str, Any]:
    """Index one document end-to-end. Returns a status summary."""
    sb = get_supabase()
    doc = _load_document(sb, document_id)
    if not doc:
        raise IndexingError(f"document {document_id} not found")

    if not force and doc.get("processing_status") == "ready" and doc.get("chunk_count"):
        # Already indexed and we weren't asked to force — return current state.
        return _status_payload(doc)

    storage_path = doc.get("storage_path")
    if not storage_path:
        _mark_failed(sb, document_id, "storage_path missing on documents row")
        raise IndexingError("storage_path missing")

    user_id = doc["user_id"]
    course_id = doc["course_id"]
    source_type = doc.get("source_type") or "lecture"

    try:
        _set_status(sb, document_id, "extracting_text")
        pdf_bytes = download_document_bytes(storage_path)
        content_hash = hashlib.sha256(pdf_bytes).hexdigest()

        # Same-hash skip: avoid pointless re-embedding when only metadata changed.
        if (
            not force
            and doc.get("document_hash") == content_hash
            and doc.get("processing_status") == "ready"
            and doc.get("chunk_count")
        ):
            return _status_payload(doc)

        pages = extract_pages_text(pdf_bytes)

        # Phase 12: vision OCR fallback for image-only / heavily-scanned
        # pages. Gated by env flag + Phase 11 detector; no-op otherwise.
        try:
            from .vision_ocr import pages_via_vision, select_pages_needing_ocr  # noqa: WPS433
            bad_idx = select_pages_needing_ocr(pages)
            if bad_idx:
                ocr_results = pages_via_vision(pdf_bytes, bad_idx)
                for idx, text in ocr_results.items():
                    if 0 <= idx < len(pages):
                        pages[idx] = text
                if ocr_results:
                    log.info("vision OCR recovered %d/%d bad pages", len(ocr_results), len(bad_idx))
        except Exception:  # noqa: BLE001
            log.exception("vision OCR pass failed — continuing with pdfminer text only")

        if not pages or not any(p.strip() for p in pages):
            _mark_failed(
                sb,
                document_id,
                "no extractable text — likely a scanned/image PDF; enable MINALLO_VISION_OCR_ENABLED to retry with vision",
            )
            raise IndexingError("no extractable text")

        _set_status(sb, document_id, "chunking")
        page_md = [page_to_markdown(text, idx + 1) for idx, text in enumerate(pages)]
        _replace_pages(sb, document_id, user_id, course_id, pages, page_md)

        # Pass the already-built PageMarkdown rather than the raw pdfminer
        # text. Phase 3 Step A — keeps the chunker on the same heading +
        # math-block detector as Phase 2, and avoids running page_to_markdown
        # twice per page.
        chunks = chunk_pages(page_md)
        if not chunks:
            _mark_failed(sb, document_id, "chunking produced 0 chunks")
            raise IndexingError("0 chunks produced")

        _set_status(sb, document_id, "embedding")
        vectors = embed_texts([c.chunk_text for c in chunks])
        if len(vectors) != len(chunks):
            _mark_failed(
                sb,
                document_id,
                f"embedding count mismatch: {len(vectors)} vs {len(chunks)} chunks",
            )
            raise IndexingError("embedding count mismatch")

        # Phase 1 tutor-mode: extract topic labels + assign one primary topic
        # per chunk. Best-effort — failure leaves the columns NULL and the
        # rest of indexing proceeds. Runs BEFORE the chunk insert so the
        # primary_topic values land in the same row write.
        doc_topics: list[str] = []
        primary_topics: list[str | None] = [None] * len(chunks)
        try:
            file_name_for_topics = doc.get("file_name") or ""
            doc_topics, primary_topics = extract_topics(
                file_name=file_name_for_topics, chunks=chunks
            )
            log.info(
                "topic extraction for %s: %s",
                document_id,
                topic_extraction_summary(doc_topics, primary_topics),
            )
        except Exception:  # noqa: BLE001
            log.exception("topic extraction failed — proceeding without topic tags")
            doc_topics = []
            primary_topics = [None] * len(chunks)

        # Phase 5 + Phase 3 Step D: exact-match exercise/formula blocks are
        # now written BEFORE chunks so we can resolve the chunk's
        # (exercise_number, subpart) → exercise.id FK before insert. Failure
        # here must never break the rest of indexing — exercises remain an
        # additive surface, and chunks fall back to exercise_id=NULL.
        exercise_id_by_key: dict[tuple[str, str | None], str] = {}
        try:
            pages_md = [(p.page_number, p.markdown) for p in page_md if p.markdown]
            exercises = detect_exercises(pages_md)
            formulas = detect_formulas(pages_md)
            exercise_id_by_key = _replace_exercises(
                sb, document_id, user_id, course_id, exercises
            )
            _replace_formulas(sb, document_id, user_id, course_id, formulas)
        except Exception:  # noqa: BLE001
            log.exception("block detection failed — continuing without exercise/formula rows")

        _replace_chunks(
            sb,
            document_id=document_id,
            user_id=user_id,
            course_id=course_id,
            source_type=source_type,
            chunks=chunks,
            vectors=vectors,
            doc_topics=doc_topics,
            primary_topics=primary_topics,
            exercise_id_by_key=exercise_id_by_key,
        )

        # Phase 4: classify the document and roll up per-page extraction
        # quality. Best-effort — failure here must not block indexing.
        doc_type: str | None = None
        rollup_quality: str | None = None
        ocr_assessment_json: dict[str, Any] | None = None
        try:
            file_name = doc.get("file_name") or ""
            sample_text = "\n\n".join((p or "")[:1500] for p in pages[:6])
            doc_type = classify_document(file_name, sample_text)
            rollup = rollup_extraction_quality(p.quality for p in page_md)
            rollup_quality = rollup.quality
            # Phase 11: OCR-need measurement based on the raw page text.
            ocr_assessment_json = measure_ocr_need(pages).to_json()
        except Exception:  # noqa: BLE001
            log.exception("document classification failed — continuing without it")

        now = datetime.now(timezone.utc).isoformat()
        update_payload: dict[str, Any] = {
            "processing_status": "ready",
            "processing_error": None,
            "document_hash": content_hash,
            "page_count": len(pages),
            "chunk_count": len(chunks),
            "indexed_at": now,
            "updated_at": now,
        }
        if doc_type:
            update_payload["document_type"] = doc_type
        if rollup_quality:
            update_payload["extraction_quality"] = rollup_quality
        if ocr_assessment_json:
            update_payload["ocr_assessment"] = ocr_assessment_json
        sb.table("documents").update(update_payload).eq("id", document_id).execute()

        return {
            "documentId": document_id,
            "status": "indexed",
            "pageCount": len(pages),
            "chunkCount": len(chunks),
            "lastIndexedAt": now,
        }

    except IndexingError:
        raise
    except Exception as e:  # noqa: BLE001 — convert to IndexingError for the API layer
        log.exception("index_document failed")
        _mark_failed(sb, document_id, f"{type(e).__name__}: {e}")
        raise IndexingError(str(e)) from e


def get_index_status(document_id: str) -> dict[str, Any]:
    """Return a structured status snapshot for the frontend to poll."""
    sb = get_supabase()
    doc = _load_document(sb, document_id)
    if not doc:
        return {"documentId": document_id, "status": "not_found"}
    return _status_payload(doc)


# ── DB helpers ──────────────────────────────────────────────────────────────


def _load_document(sb, document_id: str) -> dict[str, Any] | None:
    result = (
        sb.table("documents")
        .select(
            "id, user_id, course_id, file_name, storage_path, source_type, processing_status, "
            "processing_error, document_hash, page_count, chunk_count, indexed_at"
        )
        .eq("id", document_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    return rows[0] if rows else None


def _set_status(sb, document_id: str, status: str) -> None:
    sb.table("documents").update({
        "processing_status": status,
        "processing_error": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", document_id).execute()


def _mark_failed(sb, document_id: str, reason: str) -> None:
    sb.table("documents").update({
        "processing_status": "failed",
        "processing_error": reason[:1000],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", document_id).execute()


def _replace_pages(
    sb,
    document_id: str,
    user_id: str,
    course_id: str,
    pages: list[str],
    page_md: list[PageMarkdown] | None = None,
) -> None:
    sb.table("document_pages").delete().eq("document_id", document_id).execute()
    md_by_page = {p.page_number: p for p in (page_md or [])}
    rows: list[dict[str, Any]] = []
    for idx, text in enumerate(pages):
        if not text or not text.strip():
            continue
        page_number = idx + 1
        row: dict[str, Any] = {
            "document_id": document_id,
            "user_id": user_id,
            "course_id": course_id,
            "page_number": page_number,
            "raw_text": text,
            "cleaned_text": text,
        }
        md = md_by_page.get(page_number)
        if md is not None:
            row["cleaned_markdown"] = md.markdown
            row["extraction_quality"] = md.quality
        rows.append(row)
    if rows:
        # Insert in batches to keep payload size sane on long PDFs.
        for start in range(0, len(rows), 100):
            sb.table("document_pages").insert(rows[start:start + 100]).execute()


def _replace_chunks(
    sb,
    *,
    document_id: str,
    user_id: str,
    course_id: str,
    source_type: str,
    chunks: list[Chunk],
    vectors: list[list[float]],
    doc_topics: list[str] | None = None,
    primary_topics: list[str | None] | None = None,
    exercise_id_by_key: dict[tuple[str, str | None], str] | None = None,
) -> None:
    sb.table("document_chunks").delete().eq("document_id", document_id).execute()
    rows = []
    topics_array = doc_topics or []
    primary = primary_topics or [None] * len(chunks)
    keymap = exercise_id_by_key or {}
    for idx, (chunk, embedding) in enumerate(zip(chunks, vectors)):
        row: dict[str, Any] = {
            "document_id": document_id,
            "user_id": user_id,
            "course_id": course_id,
            "chunk_index": idx,
            "chunk_text": chunk.chunk_text,
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "source_type": source_type,
            "section_title": chunk.section_title,
            "chunk_type": chunk.chunk_type,
            "token_count": chunk.token_count,
            "embedding": embedding,
        }
        # Topic columns are additive (added by migration 20260519_000006).
        # Skip writing them when extraction returned nothing — the DB default
        # leaves them NULL and queries don't break.
        if topics_array:
            row["topics"] = topics_array
        if idx < len(primary) and primary[idx]:
            row["primary_topic"] = primary[idx]
        # Phase 3 Step D — link the chunk to its parent exercise row. Skipped
        # when the chunker didn't tag this chunk with exercise identifiers
        # (lecture/summary chunks) or when the exercise insert failed and the
        # map is empty — the column is nullable so this is safe.
        if chunk.exercise_number is not None:
            ex_id = keymap.get((chunk.exercise_number, chunk.exercise_subpart))
            if ex_id:
                row["exercise_id"] = ex_id
        rows.append(row)
    for start in range(0, len(rows), 100):
        sb.table("document_chunks").insert(rows[start:start + 100]).execute()


def _replace_exercises(
    sb,
    document_id: str,
    user_id: str,
    course_id: str,
    exercises: list[ExerciseBlock],
) -> dict[tuple[str, str | None], str]:
    """Replace the document's exercise rows and return a ``(exercise_number,
    subpart) → uuid`` map so the caller can stamp the FK on the matching
    chunk rows. Empty map when there are no exercises or the insert returned
    no rows.
    """
    sb.table("document_exercises").delete().eq("document_id", document_id).execute()
    if not exercises:
        return {}
    rows = [
        {
            "document_id": document_id,
            "user_id": user_id,
            "course_id": course_id,
            "exercise_number": ex.exercise_number,
            "subpart": ex.subpart,
            "page_start": ex.page_start,
            "page_end": ex.page_end,
            "statement_markdown": ex.statement_markdown,
            "solution_markdown": ex.solution_markdown,
        }
        for ex in exercises
    ]
    key_to_id: dict[tuple[str, str | None], str] = {}
    for start in range(0, len(rows), 50):
        batch = rows[start:start + 50]
        # ``returning='representation'`` (the postgrest default for insert)
        # gives us the generated ``id`` for each row so we can build the map
        # without a second query.
        resp = sb.table("document_exercises").insert(batch).execute()
        for r in (resp.data or []):
            num = r.get("exercise_number")
            sub = r.get("subpart")
            row_id = r.get("id")
            if num and row_id:
                key_to_id[(num, sub)] = row_id
    return key_to_id


def _replace_formulas(
    sb,
    document_id: str,
    user_id: str,
    course_id: str,
    formulas: list[FormulaBlock],
) -> None:
    sb.table("document_formulas").delete().eq("document_id", document_id).execute()
    if not formulas:
        return
    rows = [
        {
            "document_id": document_id,
            "user_id": user_id,
            "course_id": course_id,
            "formula_name": f.formula_name,
            "formula_markdown": f.formula_markdown,
            "symbols": f.symbols,
            "page_number": f.page_number,
        }
        for f in formulas
    ]
    for start in range(0, len(rows), 50):
        sb.table("document_formulas").insert(rows[start:start + 50]).execute()


def _status_payload(doc: dict[str, Any]) -> dict[str, Any]:
    raw_status = doc.get("processing_status") or "uploaded"
    # Map internal status names to the external vocabulary the brief asked for.
    status_map = {
        "uploaded": "not_indexed",
        "extracting_text": "indexing",
        "chunking": "indexing",
        "embedding": "indexing",
        "ready": "indexed",
        "failed": "failed",
    }
    return {
        "documentId": doc["id"],
        "status": status_map.get(raw_status, raw_status),
        "chunkCount": doc.get("chunk_count"),
        "pageCount": doc.get("page_count"),
        "lastIndexedAt": doc.get("indexed_at"),
        "error": doc.get("processing_error"),
    }
