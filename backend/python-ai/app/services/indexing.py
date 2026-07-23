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
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from ..supabase_client import get_supabase
from .block_detection import (
    ExerciseBlock,
    FormulaBlock,
    detect_exercises,
    detect_formulas,
)
from .chunking import Chunk, chunk_pages
from .document_intelligence import (
    analyze_document,
    measure_ocr_need,
    prefer_ocr_text,
    rollup_extraction_quality,
)
from .embeddings import embed_texts
from .extraction import TextBlock, extract_pages_with_blocks
from .markdown_indexing import PageMarkdown, page_to_markdown
from .storage import download_document_bytes
from .topic_extraction import extract_topics, topic_extraction_summary

log = logging.getLogger(__name__)


# ── public surface ──────────────────────────────────────────────────────────


class IndexingError(Exception):
    """Indexing failed in a way the caller (the API layer) needs to surface."""


# ── Concurrency + crash recovery ─────────────────────────────────────────────
#
# Indexing is heavy (download → OCR render → embed) and runs in-process via the
# router's BackgroundTask, sharing the same threadpool that serves answers and
# generation. Two safeguards keep an upload burst (or a redeploy) from hurting
# the rest of the service:
#   1. A bounded semaphore caps how many documents index at once PER PROCESS, so
#      uploads can't drain the event-loop threadpool and starve generation. It
#      also protects the 2 GB box from N concurrent vision-OCR rasterizations.
#   2. recover_orphaned_indexing() re-queues documents a killed process left
#      stuck mid-pipeline (the "frozen in extracting_text after a deploy" trap).
# Env-overridable; no settings.py change needed.

_INDEXING_MAX_CONCURRENCY = max(1, int(os.getenv("INDEXING_MAX_CONCURRENCY", "2")))
_INDEXING_RECOVERY_AGE_SECONDS = max(60, int(os.getenv("INDEXING_RECOVERY_AGE_SECONDS", "120")))
_INDEXING_SEMAPHORE = threading.BoundedSemaphore(_INDEXING_MAX_CONCURRENCY)

# Non-terminal statuses an interrupted indexing run leaves behind.
_IN_FLIGHT_STATUSES = ("extracting_text", "chunking", "embedding")


def run_document_indexing(document_id: str, *, force: bool = False) -> dict[str, Any]:
    """Concurrency-bounded entrypoint for indexing — what callers should use.

    Caps concurrent indexing per process (``_INDEXING_SEMAPHORE``) so an upload
    burst can't exhaust the threadpool that also serves answers/generation, then
    delegates to :func:`index_document`. Blocks until a slot frees."""
    with _INDEXING_SEMAPHORE:
        return index_document(document_id, force=force)


def claim_orphaned_indexing() -> list[str]:
    """Atomically claim documents left mid-indexing by a dead process.

    Selects rows stuck in a non-terminal status and untouched for longer than
    ``_INDEXING_RECOVERY_AGE_SECONDS`` (the staleness guard means we never grab a
    document a peer worker is actively processing — a live run re-stamps
    ``updated_at`` at each phase). For each candidate we issue a guarded UPDATE
    (``WHERE updated_at < threshold``) that re-stamps ``updated_at``; Postgres
    serializes the writes, so only the worker whose UPDATE actually changes the
    row claims it — every other worker's guarded UPDATE matches 0 rows. Returns
    the claimed document ids. Never raises."""
    sb = get_supabase()
    threshold_iso = (
        datetime.now(timezone.utc) - timedelta(seconds=_INDEXING_RECOVERY_AGE_SECONDS)
    ).isoformat()
    try:
        stuck = (
            sb.table("documents")
            .select("id, processing_status, updated_at")
            .in_("processing_status", list(_IN_FLIGHT_STATUSES))
            .lt("updated_at", threshold_iso)
            .limit(200)
            .execute()
        ).data or []
    except Exception:  # noqa: BLE001
        log.exception("claim_orphaned_indexing: failed to query stuck documents")
        return []

    claimed: list[str] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for row in stuck:
        doc_id = row.get("id")
        if not doc_id:
            continue
        try:
            resp = (
                sb.table("documents")
                .update({"updated_at": now_iso})
                .eq("id", doc_id)
                .lt("updated_at", threshold_iso)
                .execute()
            )
            if resp.data:
                claimed.append(doc_id)
        except Exception:  # noqa: BLE001
            log.exception("claim_orphaned_indexing: claim failed for %s", doc_id)
    return claimed


def recover_orphaned_indexing() -> int:
    """Claim and re-index documents orphaned by a killed/redeployed process.

    Meant to run once per process at startup (off the request path). Re-indexes
    each claimed document with ``force=True`` — the partial state from the
    interrupted run is unreliable, and ``index_document`` is idempotent (it
    deletes existing pages/chunks first). Returns the number re-queued."""
    claimed = claim_orphaned_indexing()
    if not claimed:
        return 0
    log.warning(
        "recover_orphaned_indexing: re-indexing %d orphaned document(s): %s",
        len(claimed), claimed,
    )
    for doc_id in claimed:
        try:
            run_document_indexing(doc_id, force=True)
        except IndexingError:
            log.warning("recover_orphaned_indexing: reindex failed for %s", doc_id)
        except Exception:  # noqa: BLE001
            log.exception("recover_orphaned_indexing: unexpected error reindexing %s", doc_id)
    return len(claimed)


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
        try:
            sb.table("documents").update({
                "index_revision_status": "building",
            }).eq("id", document_id).execute()
        except Exception:
            log.warning(
                "index revision status column unavailable for document %s",
                document_id,
            )

        # Same-hash skip: avoid pointless re-embedding when only metadata changed.
        if (
            not force
            and doc.get("document_hash") == content_hash
            and doc.get("processing_status") == "ready"
            and doc.get("chunk_count")
        ):
            return _status_payload(doc)

        # One pdfminer pass yields both the page text and the per-block bbox
        # coordinates (text-layer pages only). page_blocks aligns by page index
        # and reflects the pdfminer text layer, so it corresponds to raw_text
        # even when a page's cleaned_text is later replaced by OCR.
        pages, page_blocks = extract_pages_with_blocks(pdf_bytes)
        # Keep the untouched pdfminer text so we can (a) store it as raw_text
        # for debugging and (b) score it against any OCR result before
        # deciding to overwrite the page.
        pdfminer_pages = list(pages)

        # Phase 12: vision OCR fallback for image-only / heavily-scanned
        # pages AND structurally garbled pages (multi-column formula sheets
        # where pdfminer pulled tokens out of reading order). Gated by env
        # flag; no-op otherwise.
        ocr_pages_run = 0
        ocr_pages_recovered = 0
        ocr_provider = "openai"
        ocr_page_metadata: dict[int, dict[str, Any]] = {}
        try:
            from .vision_ocr import (  # noqa: WPS433
                choose_ocr_provider,
                pages_via_vision_results,
                rank_ocr_candidates,
                select_handwriting_candidates,
                select_pages_needing_ocr,
            )
            # Pass pdf_bytes so the selector can use the image-aware path:
            # diagram pages with a thin text caption (which pdfminer can't
            # read) are flagged by rendered ink coverage, not just letter count.
            bad_idx = select_pages_needing_ocr(pages, pdf_bytes)
            if bad_idx:
                from ..config import get_settings  # noqa: WPS433

                max_ocr_pages = get_settings().vision_ocr_max_pages
                ranked_candidates = rank_ocr_candidates(pages, bad_idx, pdf_bytes)
                attempt_idx = [
                    candidate.page_index
                    for candidate in ranked_candidates[:max_ocr_pages]
                ]
                attempt_set = set(attempt_idx)
                for candidate in ranked_candidates:
                    ocr_page_metadata[candidate.page_index] = {
                        "page_processing_status": (
                            "processing"
                            if candidate.page_index in attempt_set
                            else candidate.classification
                        ),
                        "ocr_priority_score": candidate.score,
                        "ocr_priority_reasons": list(candidate.reasons),
                        "ocr_needs_review": (
                            candidate.page_index not in attempt_set
                            and candidate.classification
                            != "skipped_probable_front_matter"
                        ),
                    }
                handwriting_idx = select_handwriting_candidates(
                    doc.get("file_name") or "", pages, attempt_idx, pdf_bytes
                )
                handwriting_set = set(handwriting_idx)
                normal_idx = [
                    idx for idx in attempt_idx if idx not in handwriting_set
                ]
                # Phase A: route formula-dense pages to Mathpix when
                # MINALLO_MATHPIX_ROUTING enables it (off → always OpenAI).
                # Provider choice sees the full bad-page set for the best
                # formula-density signal.
                ocr_provider = choose_ocr_provider(
                    doc.get("file_name") or "", pages, normal_idx
                )
                # Handwriting pages normally take the dedicated OpenAI
                # handwriting prompt/preprocess path. But when Mathpix is the
                # chosen backend (MINALLO_MATHPIX_ROUTING), route them to Mathpix
                # too: it transcribes handwriting/math and — critically — keeps
                # OCR off the OpenAI tokens-per-minute budget. Otherwise a bulk
                # pass saturates the OpenAI TPM cap and the handwriting batch
                # 429-fails wholesale (the normal batch already went to Mathpix).
                handwriting_provider = (
                    "mathpix" if ocr_provider == "mathpix" else "openai_handwriting"
                )
                # pages_via_vision caps the batch at vision_ocr_max_pages.
                # Mirror that cap here so ocr_pages_run counts what was
                # actually attempted — counting the uncapped bad_idx would
                # over-report attempts and could falsely demote a fully
                # successful (but capped) run to "partial" / "weak".
                if len(bad_idx) > len(attempt_idx):
                    log.info(
                        "indexing.ocr_ranked_cap document_id=%s candidates=%d cap=%d selected_pages=%s",
                        document_id, len(bad_idx), max_ocr_pages,
                        ",".join(str(index + 1) for index in attempt_idx),
                    )
                ocr_pages_run = len(attempt_idx)
                handwriting_attempt = [
                    idx for idx in attempt_idx if idx in handwriting_set
                ]
                normal_attempt = [
                    idx for idx in attempt_idx if idx not in handwriting_set
                ]
                ocr_results = {}
                if handwriting_attempt:
                    ocr_results.update(
                        pages_via_vision_results(
                            pdf_bytes,
                            handwriting_attempt,
                            provider=handwriting_provider,
                        )
                    )
                if normal_attempt:
                    ocr_results.update(
                        pages_via_vision_results(
                            pdf_bytes,
                            normal_attempt,
                            provider=ocr_provider,
                        )
                    )
                # Don't blindly trust OCR: only overwrite the page when the
                # OCR text scores at least as well as the pdfminer original.
                # A page that scores lower (mostly [unclear], blurred render)
                # keeps its original text and is NOT counted as recovered.
                for idx, result in ocr_results.items():
                    if (
                        0 <= idx < len(pages)
                        and prefer_ocr_text(pages[idx], result.text)
                    ):
                        pages[idx] = result.text
                        ocr_page_metadata[idx] = {
                            **ocr_page_metadata.get(idx, {}),
                            "ocr_provider": result.provider,
                            "ocr_mode": result.mode,
                            "ocr_confidence": result.confidence,
                            "ocr_needs_review": result.needs_review,
                            "ocr_unclear_count": result.unclear_count,
                            "page_processing_status": (
                                "weak_or_ambiguous"
                                if result.needs_review
                                else "ocr_complete"
                            ),
                        }
                        ocr_pages_recovered += 1
                for idx in attempt_idx:
                    if ocr_page_metadata.get(idx, {}).get(
                        "page_processing_status"
                    ) == "processing":
                        ocr_page_metadata[idx] = {
                            **ocr_page_metadata.get(idx, {}),
                            "page_processing_status": (
                                "weak_or_ambiguous"
                                if idx in ocr_results
                                else "failed"
                            ),
                            "ocr_needs_review": True,
                        }
                if ocr_pages_recovered:
                    log.info(
                        "vision OCR recovered %d/%d bad pages "
                        "(provider=%s handwriting_pages=%d)",
                        ocr_pages_recovered, ocr_pages_run, ocr_provider,
                        len(handwriting_attempt),
                    )
        except Exception:  # noqa: BLE001
            log.exception("vision OCR pass failed — continuing with pdfminer text only")

        # Per-doc OCR cost-tracking line. Single structured log entry the
        # operator can grep for to see "how many OCR calls did indexing
        # actually make for THIS document". Counted at the indexer, not in
        # vision_ocr.py, so it survives even when the OCR call itself
        # raises and gets swallowed by the broad except above.
        log.info(
            "indexing.ocr_summary document_id=%s file=%s provider=%s pages_attempted=%d pages_recovered=%d",
            document_id,
            (doc.get("file_name") or "?"),
            ocr_provider,
            ocr_pages_run,
            ocr_pages_recovered,
        )

        if not pages or not any(p.strip() for p in pages):
            _mark_failed(
                sb,
                document_id,
                "no extractable text — likely a scanned/image PDF; enable MINALLO_VISION_OCR_ENABLED to retry with vision",
            )
            raise IndexingError("no extractable text")

        _set_status(sb, document_id, "chunking")
        page_md = [page_to_markdown(text, idx + 1) for idx, text in enumerate(pages)]
        _replace_pages(
            sb, document_id, user_id, course_id, pages, page_md,
            raw_pages=pdfminer_pages, page_blocks=page_blocks,
            ocr_page_metadata=ocr_page_metadata,
            index_revision=content_hash,
        )

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
                sb, document_id, user_id, course_id, exercises,
                index_revision=content_hash,
            )
            _replace_formulas(
                sb, document_id, user_id, course_id, formulas,
                index_revision=content_hash,
            )
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
            document_revision=content_hash,
            index_revision=content_hash,
        )

        # Phase 4: classify the document and roll up per-page extraction
        # quality. Best-effort — failure here must not block indexing.
        doc_type: str | None = None
        doc_type_confidence: float | None = None
        understanding_json: dict[str, Any] | None = None
        rollup_quality: str | None = None
        ocr_assessment_json: dict[str, Any] | None = None
        try:
            file_name = doc.get("file_name") or ""
            sample_text = "\n\n".join((p or "")[:1500] for p in pages[:6])
            # Document Understanding Layer: full deterministic payload (type +
            # confidence + signals + language + subject/topic + content flags).
            understanding = analyze_document(
                file_name,
                sample_text,
                fallback_language=doc.get("language"),
                course_topics=doc_topics or None,
            )
            doc_type = understanding.document_type
            doc_type_confidence = understanding.document_type_confidence
            understanding_json = understanding.to_json()
            rollup = rollup_extraction_quality(p.quality for p in page_md)
            rollup_quality = rollup.quality
            # Phase 11: OCR-need measurement based on the raw page text.
            ocr_assessment_json = measure_ocr_need(pages).to_json()
        except Exception:  # noqa: BLE001
            log.exception("document classification failed — continuing without it")

        # Phase 12 follow-up: surface OCR-failure to the operator + UI.
        # When the indexer flagged N pages for OCR but recovered fewer
        # than half of them, the resulting chunks are likely missing real
        # content (scanned formula table, broken column extraction, …).
        # Force the rollup quality down to 'weak' so the frontend badge
        # warns the student that this doc may answer poorly, and stash
        # the counts into ocr_assessment for ops visibility.
        # Only an actual OCR *attempt* (feature enabled) can signal a quality
        # problem, and a doc is only "weak" when the pages OCR couldn't recover
        # are a MATERIAL share of the whole document. Two false positives this
        # guards against:
        #   * OCR disabled → ``ocr_pages_run`` is still set by the page selector,
        #     so the old rule demoted every figure-heavy doc to weak even with
        #     no OCR attempted.
        #   * A text-clean lecture with a handful of flagged figure pages (the
        #     attempt is capped at vision_ocr_max_pages=20) — 20 unrecovered
        #     pages out of 238 is not a weak document.
        from ..config import get_settings as _get_settings  # noqa: WPS433

        ocr_attempted = _get_settings().vision_ocr_enabled and ocr_pages_run > 0
        unrecovered = ocr_pages_run - ocr_pages_recovered
        material_failure = unrecovered / max(1, len(pages)) >= 0.25
        if ocr_attempted and ocr_pages_recovered * 2 < ocr_pages_run and material_failure:
            log.warning(
                "indexing.ocr_partial_failure document_id=%s attempted=%d recovered=%d pages=%d — demoting extraction_quality to weak",
                document_id, ocr_pages_run, ocr_pages_recovered, len(pages),
            )
            if rollup_quality == "good":
                rollup_quality = "weak"
            ocr_assessment_json = {
                **(ocr_assessment_json or {}),
                "indexer_ocr_provider": ocr_provider,
                "indexer_ocr_attempted": ocr_pages_run,
                "indexer_ocr_recovered": ocr_pages_recovered,
                "indexer_ocr_status": "partial_failure",
            }
        elif ocr_attempted:
            # OCR ran without a material failure — record the counts (so we can
            # spot patterns) but DON'T demote quality.
            ocr_assessment_json = {
                **(ocr_assessment_json or {}),
                "indexer_ocr_provider": ocr_provider,
                "indexer_ocr_attempted": ocr_pages_run,
                "indexer_ocr_recovered": ocr_pages_recovered,
                "indexer_ocr_status": (
                    "succeeded" if ocr_pages_recovered == ocr_pages_run else "partial"
                ),
            }

        coverage_counts: dict[str, int] = {
            "embedded_text_reliable": max(
                0, len(pages) - len(ocr_page_metadata)
            )
        }
        for metadata in ocr_page_metadata.values():
            page_status = str(
                metadata.get("page_processing_status")
                or "weak_or_ambiguous"
            )
            coverage_counts[page_status] = coverage_counts.get(page_status, 0) + 1
        ocr_assessment_json = {
            **(ocr_assessment_json or {}),
            "embedded_text_analyzed": len(pages),
            "total_pages": len(pages),
            "automatic_vision_cap": _get_settings().vision_ocr_max_pages,
            "page_status_counts": coverage_counts,
            "vision_fully_processed": all(
                status in {"embedded_text_reliable", "ocr_complete"}
                for status in (
                    metadata.get("page_processing_status")
                    for metadata in ocr_page_metadata.values()
                )
            ),
        }

        now = datetime.now(timezone.utc).isoformat()
        activated = (
            sb.rpc("activate_document_index_revision", {
                "p_document_id": document_id,
                "p_user_id": user_id,
                "p_revision": content_hash,
                "p_expected_pages": len(pages),
                "p_expected_chunks": len(chunks),
            }).execute().data
        )
        if not activated:
            _mark_failed(
                sb,
                document_id,
                "candidate index revision failed coverage validation",
            )
            raise IndexingError("index revision activation failed")
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
        if doc_type_confidence is not None:
            update_payload["document_type_confidence"] = doc_type_confidence
        if understanding_json:
            update_payload["document_understanding"] = understanding_json
        if rollup_quality:
            update_payload["extraction_quality"] = rollup_quality
        if ocr_assessment_json:
            update_payload["ocr_assessment"] = ocr_assessment_json
        try:
            sb.table("documents").update(update_payload).eq("id", document_id).execute()
        except Exception:  # noqa: BLE001
            # The understanding columns may not exist yet (migration 20260610_000004
            # not applied). Strip them and retry so indexing NEVER breaks on a
            # missing column — understanding just won't persist until the migration
            # + a backfill/reindex run.
            log.exception(
                "documents.update failed — retrying without document-understanding fields"
            )
            for _k in ("document_type_confidence", "document_understanding"):
                update_payload.pop(_k, None)
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


# ── OCR review / correction surface ──────────────────────────────────────────


def list_review_pages(document_id: str) -> list[dict[str, Any]]:
    """Return the OCR'd pages a student should review for this document.

    These are pages the vision/handwriting OCR path flagged with
    ``ocr_needs_review=true`` (handwriting is always flagged; printed pages
    with ``[unclear]`` markers or low confidence are flagged too). The frontend
    correction UI lists them and lets the student fix ``cleaned_text``.
    """
    sb = get_supabase()
    result = (
        sb.table("document_pages")
        .select(
            "page_number, ocr_provider, ocr_mode, ocr_confidence, "
            "ocr_needs_review, ocr_unclear_count, cleaned_text"
        )
        .eq("document_id", document_id)
        .eq("ocr_needs_review", True)
        .order("page_number")
        .execute()
    )
    rows = result.data or []
    return [
        {
            "pageNumber": r.get("page_number"),
            "provider": r.get("ocr_provider"),
            "mode": r.get("ocr_mode"),
            "confidence": r.get("ocr_confidence"),
            "unclearCount": r.get("ocr_unclear_count") or 0,
            "text": r.get("cleaned_text") or "",
        }
        for r in rows
    ]


def correct_document_page(
    document_id: str, page_number: int, corrected_text: str
) -> int:
    """Persist a student's correction to one OCR'd page (no re-embed).

    Stores a pending correction against the active index revision. The active
    page remains untouched until a complete corrected revision is built,
    validated and atomically activated. Returns the new ``[unclear]`` count.

    This is the fast, synchronous half of a correction — the caller should run
    :func:`reindex_chunks_from_pages` afterwards (typically in the background)
    so retrieval reflects the fix.
    """
    text = (corrected_text or "").strip()
    if not text:
        raise IndexingError("corrected text is empty")

    sb = get_supabase()
    unclear = text.lower().count("[unclear]")
    docs = (
        sb.table("documents")
        .select("user_id, course_id, active_index_revision")
        .eq("id", document_id)
        .limit(1)
        .execute()
    ).data or []
    if not docs:
        raise IndexingError(f"document {document_id} not found")
    doc = docs[0]
    active_revision = str(doc.get("active_index_revision") or "")
    pages = (
        sb.table("document_pages")
        .select("page_number")
        .eq("document_id", document_id)
        .eq("index_revision", active_revision)
        .eq("page_number", page_number)
        .limit(1)
        .execute()
    ).data or []
    if not pages:
        raise IndexingError(
            f"page {page_number} not found for document {document_id}"
        )
    (
        sb.table("document_page_corrections")
        .upsert({
            "user_id": doc["user_id"],
            "course_id": doc["course_id"],
            "document_id": document_id,
            "base_index_revision": active_revision,
            "page_number": page_number,
            "corrected_text": text,
            "status": "pending",
            "applied_index_revision": None,
            "applied_at": None,
        }, on_conflict=(
            "user_id,document_id,base_index_revision,page_number"
        ))
        .execute()
    )
    return unclear


def reindex_chunks_from_pages(document_id: str) -> dict[str, Any]:
    """Re-chunk + re-embed a document from its stored ``document_pages`` rows.

    Used after a student submits an OCR correction. A candidate revision clones
    the active pages, overlays pending corrections, rebuilds every derived
    artifact, validates counts, and atomically activates. The prior revision
    remains available for rollback.
    """
    sb = get_supabase()
    doc = _load_document(sb, document_id)
    if not doc:
        raise IndexingError(f"document {document_id} not found")

    user_id = doc["user_id"]
    course_id = doc["course_id"]
    source_type = doc.get("source_type") or "lecture"

    base_revision = str(doc.get("active_index_revision") or "")
    page_rows = (
        sb.table("document_pages")
        .select("*")
        .eq("document_id", document_id)
        .eq("index_revision", base_revision)
        .order("page_number")
        .execute()
    ).data or []
    if not page_rows:
        raise IndexingError("no stored pages to reindex")

    corrections = (
        sb.table("document_page_corrections")
        .select("id, page_number, corrected_text")
        .eq("user_id", user_id)
        .eq("document_id", document_id)
        .eq("base_index_revision", base_revision)
        .eq("status", "pending")
        .execute()
    ).data or []
    correction_by_page = {
        int(row["page_number"]): str(row.get("corrected_text") or "")
        for row in corrections
    }
    if not correction_by_page:
        raise IndexingError("no pending page corrections")

    # Build a dense, page-number-ordered text list (gaps → empty page). The
    # original indexer fed pdfminer/OCR text through page_to_markdown; the
    # stored cleaned_text IS that final text, so we reproduce it exactly.
    max_page = max(int(r["page_number"]) for r in page_rows)
    texts: list[str] = [""] * max_page
    for r in page_rows:
        n = int(r["page_number"])
        if 1 <= n <= max_page:
            texts[n - 1] = (
                correction_by_page.get(n)
                or r.get("cleaned_text")
                or ""
            )

    revision_material = "\n".join(
        [base_revision, *[f"{index + 1}:{text}" for index, text in enumerate(texts)]]
    )
    new_revision = hashlib.sha256(
        revision_material.encode("utf-8")
    ).hexdigest()
    (
        sb.table("document_pages").delete()
        .eq("document_id", document_id)
        .eq("index_revision", new_revision)
        .execute()
    )
    cloned_rows: list[dict[str, Any]] = []
    for source in page_rows:
        row = {
            key: value
            for key, value in source.items()
            if key not in {"id", "created_at", "updated_at"}
        }
        page_number = int(row["page_number"])
        row["index_revision"] = new_revision
        if page_number in correction_by_page:
            corrected = correction_by_page[page_number]
            markdown = page_to_markdown(corrected, page_number)
            row.update({
                "cleaned_text": corrected,
                "cleaned_markdown": markdown.markdown,
                "extraction_quality": markdown.quality,
                "ocr_needs_review": False,
                "ocr_unclear_count": corrected.lower().count("[unclear]"),
                "page_processing_status": "ocr_complete",
            })
        cloned_rows.append(row)
    for start in range(0, len(cloned_rows), 100):
        sb.table("document_pages").insert(
            cloned_rows[start:start + 100]
        ).execute()

    page_md = [page_to_markdown(t, i + 1) for i, t in enumerate(texts)]
    chunks = chunk_pages(page_md)
    if not chunks:
        raise IndexingError("0 chunks produced from stored pages")

    vectors = embed_texts([c.chunk_text for c in chunks])
    if len(vectors) != len(chunks):
        raise IndexingError(
            f"embedding count mismatch: {len(vectors)} vs {len(chunks)} chunks"
        )

    doc_topics: list[str] = []
    primary_topics: list[str | None] = [None] * len(chunks)
    try:
        doc_topics, primary_topics = extract_topics(
            file_name=doc.get("file_name") or "", chunks=chunks
        )
    except Exception:  # noqa: BLE001
        log.exception("topic extraction failed during reindex — proceeding without topics")
        doc_topics = []
        primary_topics = [None] * len(chunks)

    exercise_id_by_key: dict[tuple[str, str | None], str] = {}
    try:
        pages_md = [(p.page_number, p.markdown) for p in page_md if p.markdown]
        exercises = detect_exercises(pages_md)
        formulas = detect_formulas(pages_md)
        exercise_id_by_key = _replace_exercises(
            sb, document_id, user_id, course_id, exercises,
            index_revision=new_revision,
        )
        _replace_formulas(
            sb, document_id, user_id, course_id, formulas,
            index_revision=new_revision,
        )
    except Exception:  # noqa: BLE001
        log.exception("block detection failed during reindex — continuing")

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
        document_revision=doc.get("document_revision") or doc.get("document_hash"),
        index_revision=new_revision,
    )

    now = datetime.now(timezone.utc).isoformat()
    activated = sb.rpc("activate_document_index_revision", {
        "p_document_id": document_id,
        "p_user_id": user_id,
        "p_revision": new_revision,
        "p_expected_pages": len(page_rows),
        "p_expected_chunks": len(chunks),
    }).execute().data
    if not activated:
        raise IndexingError("corrected index revision activation failed")
    (
        sb.table("document_page_corrections")
        .update({
            "status": "applied",
            "applied_index_revision": new_revision,
            "applied_at": now,
        })
        .in_("id", [row["id"] for row in corrections])
        .execute()
    )
    sb.table("documents").update(
        {"chunk_count": len(chunks), "indexed_at": now, "updated_at": now}
    ).eq("id", document_id).execute()

    log.info(
        "reindex_from_pages document_id=%s pages=%d chunks=%d",
        document_id, len(texts), len(chunks),
    )
    return {
        "documentId": document_id,
        "status": "reindexed",
        "chunkCount": len(chunks),
        "indexRevision": new_revision,
    }


# ── DB helpers ──────────────────────────────────────────────────────────────


def _load_document(sb, document_id: str) -> dict[str, Any] | None:
    result = (
        sb.table("documents")
        .select(
            "id, user_id, course_id, file_name, storage_path, source_type, processing_status, "
            "processing_error, document_hash, page_count, chunk_count, indexed_at, "
            "active_index_revision, previous_index_revision, index_revision_status"
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
    raw_pages: list[str] | None = None,
    page_blocks: list[list[TextBlock]] | None = None,
    ocr_page_metadata: dict[int, dict[str, Any]] | None = None,
    index_revision: str = "",
) -> None:
    (
        sb.table("document_pages").delete()
        .eq("document_id", document_id)
        .eq("index_revision", index_revision)
        .execute()
    )
    md_by_page = {p.page_number: p for p in (page_md or [])}
    rows: list[dict[str, Any]] = []
    for idx, text in enumerate(pages):
        page_number = idx + 1
        # raw_text = the pdfminer original (so a re-OCR'd page still records
        # what the text layer held); cleaned_text = the final text actually
        # indexed. Falls back to the final text when no original was kept or
        # pdfminer extracted nothing for that page.
        raw = text
        if raw_pages is not None and idx < len(raw_pages) and raw_pages[idx] and raw_pages[idx].strip():
            raw = raw_pages[idx]
        row: dict[str, Any] = {
            "document_id": document_id,
            "user_id": user_id,
            "course_id": course_id,
            "page_number": page_number,
            "raw_text": raw,
            "cleaned_text": text,
            # Uniform defaults for the additive OCR columns. PostgREST normalises
            # a batch insert to the UNION of keys across its rows and sends an
            # explicit NULL for any row missing a key — so a MIXED batch (some
            # OCR'd pages carrying ocr_* keys, some not) would push NULL into the
            # NOT NULL columns (ocr_needs_review / ocr_unclear_count) and fail.
            # A column DEFAULT only applies when the key is omitted from EVERY
            # row. Setting defaults on every row keeps the batch uniform; the
            # ocr_page_metadata update below overrides them for recovered pages.
            "ocr_provider": None,
            "ocr_mode": None,
            "ocr_confidence": None,
            "ocr_needs_review": False,
            "ocr_unclear_count": 0,
            "page_processing_status": (
                "embedded_text_reliable"
                if text and text.strip()
                else "pending_on_demand_ocr"
            ),
            "ocr_priority_score": None,
            "ocr_priority_reasons": [],
            "index_revision": index_revision,
        }
        md = md_by_page.get(page_number)
        if md is not None:
            row["cleaned_markdown"] = md.markdown
            row["extraction_quality"] = md.quality
        # Text-layer bbox coordinates (top-left normalised), when present.
        # These align with raw_text; a page OCR'd from an image has none.
        if page_blocks is not None and idx < len(page_blocks) and page_blocks[idx]:
            row["text_blocks"] = [b.to_json() for b in page_blocks[idx]]
        if ocr_page_metadata and idx in ocr_page_metadata:
            row.update(ocr_page_metadata[idx])
        rows.append(row)
    if not rows:
        return
    # Insert in batches to keep payload size sane on long PDFs.
    try:
        for start in range(0, len(rows), 100):
            sb.table("document_pages").insert(rows[start:start + 100]).execute()
    except Exception as exc:  # noqa: BLE001
        # Deploy-order safety: the additive OCR/text-block columns may be
        # unavailable to PostgREST — either the migration (20260604_000001)
        # hasn't run, or it ran but PostgREST is still serving a STALE schema
        # cache (columns added via SQL aren't visible until it reloads). In
        # both cases we degrade by reinserting without the additive metadata so
        # indexing still succeeds.
        #
        # Crucially, scope this to genuine schema/column errors. The old check
        # ``any(col in str(exc))`` also matched constraint-violation messages
        # (e.g. ``document_pages_ocr_confidence_chk``) and silently dropped the
        # data instead of surfacing a real bug — and it logged a misleading
        # "columns missing" line even when the true cause was a stale cache.
        msg = str(exc)
        optional_page_cols = {
            "text_blocks",
            "ocr_provider",
            "ocr_mode",
            "ocr_confidence",
            "ocr_needs_review",
            "ocr_unclear_count",
            "page_processing_status",
            "ocr_priority_score",
            "ocr_priority_reasons",
        }
        mentions_optional = any(col in msg for col in optional_page_cols)
        lower = msg.lower()
        schema_issue = (
            "schema cache" in lower          # PostgREST PGRST204 — stale/unknown column
            or "could not find" in lower     # PostgREST "Could not find the 'X' column"
            or "does not exist" in lower      # Postgres 42703 — column really absent
        )
        if not (mentions_optional and schema_issue):
            # Not a missing-column/cache problem (constraint violation, FK,
            # NOT NULL, …) — never hide that by dropping data.
            raise
        log.warning(
            "document_pages additive OCR/text-block columns unavailable — "
            "reinserting WITHOUT that metadata. Likely a missing migration or a "
            "stale PostgREST schema cache (reload it if the columns do exist). "
            "Underlying error: %s",
            msg,
        )
        sb.table("document_pages").delete().eq("document_id", document_id).execute()
        stripped = [
            {k: v for k, v in r.items() if k not in optional_page_cols}
            for r in rows
        ]
        for start in range(0, len(stripped), 100):
            sb.table("document_pages").insert(stripped[start:start + 100]).execute()


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
    document_revision: str | None = None,
    index_revision: str = "",
) -> None:
    (
        sb.table("document_chunks").delete()
        .eq("document_id", document_id)
        .eq("index_revision", index_revision)
        .execute()
    )
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
            "document_revision": document_revision,
            "index_revision": index_revision,
            "question_number": chunk.exercise_number,
            "parent_question_number": (
                chunk.exercise_number.split(".")[0]
                if chunk.exercise_number and "." in chunk.exercise_number
                else None
            ),
            "source_priority": {
                "solution": 85,
                "exam": 80,
                "exercise": 75,
                "lecture": 65,
                "formula": 60,
            }.get(source_type, 50),
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
        batch = rows[start:start + 100]
        try:
            sb.table("document_chunks").insert(batch).execute()
        except Exception as exc:
            # Rolling-deploy compatibility: the grounding metadata migration
            # may land just after this application release. Keep indexing
            # operational on the old schema, while logging only the category
            # (never private chunk text). Once migrated, the first insert path
            # writes the full provenance fields automatically.
            message = str(exc).casefold()
            optional = {
                "document_revision", "question_number",
                "parent_question_number", "source_priority",
            }
            if not any(column in message for column in optional):
                raise
            log.warning(
                "grounding_metadata_schema_not_ready document_id=%s batch_start=%d",
                document_id, start,
            )
            legacy_batch = [
                {key: value for key, value in row.items() if key not in optional}
                for row in batch
            ]
            sb.table("document_chunks").insert(legacy_batch).execute()


def _replace_exercises(
    sb,
    document_id: str,
    user_id: str,
    course_id: str,
    exercises: list[ExerciseBlock],
    *,
    index_revision: str = "",
) -> dict[tuple[str, str | None], str]:
    """Replace the document's exercise rows and return a ``(exercise_number,
    subpart) → uuid`` map so the caller can stamp the FK on the matching
    chunk rows. Empty map when there are no exercises or the insert returned
    no rows.
    """
    (
        sb.table("document_exercises").delete()
        .eq("document_id", document_id)
        .eq("index_revision", index_revision)
        .execute()
    )
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
            "index_revision": index_revision,
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
    *,
    index_revision: str = "",
) -> None:
    (
        sb.table("document_formulas").delete()
        .eq("document_id", document_id)
        .eq("index_revision", index_revision)
        .execute()
    )
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
            "index_revision": index_revision,
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
