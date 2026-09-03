"""Database-leased worker for exhaustive document jobs.

The queue and all useful state live in Postgres.  Each Gunicorn process may run
one poller; ``claim_next_scoped_job`` serialises claims and expired leases make
work recoverable by another process after a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import threading
import time
import uuid
from typing import Any, AsyncIterator

from .scoped_job_store import (
    claim_next_scoped_job,
    load_job_snapshot,
    persist_scoped_result,
    renew_scoped_job_lease,
)
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)
_started = False
_start_lock = threading.Lock()


def start_scoped_job_worker() -> None:
    global _started
    with _start_lock:
        if _started:
            return
        worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        threading.Thread(
            target=_poll, args=(worker_id,), name="scoped-rag-worker", daemon=True,
        ).start()
        _started = True
        log.info("scoped_job_worker_started worker_id=%s", worker_id)


def _poll(worker_id: str) -> None:
    while True:
        try:
            job = claim_next_scoped_job(worker_id=worker_id, lease_seconds=180)
            if not job:
                time.sleep(1.5)
                continue
            _run_claimed_job(job, worker_id)
        except Exception:  # noqa: BLE001
            log.exception("scoped_job_worker_poll_failed worker_id=%s", worker_id)
            time.sleep(3)


def _run_claimed_job(job: dict[str, Any], worker_id: str) -> None:
    job_id = str(job["id"])
    stop_heartbeat = threading.Event()

    def heartbeat() -> None:
        while not stop_heartbeat.wait(45):
            try:
                renew_scoped_job_lease(job_id=job_id, worker_id=worker_id, lease_seconds=180)
            except Exception:  # noqa: BLE001
                log.exception("scoped_job_lease_renewal_failed job_id=%s", job_id)

    heartbeat_thread = threading.Thread(target=heartbeat, name=f"scoped-lease-{job_id[:8]}", daemon=True)
    heartbeat_thread.start()
    try:
        asyncio.run(_execute(job))
    except Exception as exc:  # noqa: BLE001
        log.exception("scoped_job_worker_failed job_id=%s", job_id)
        get_supabase().table("complete_document_jobs").update({
            "status": "failed_recoverable",
            "current_stage": "worker_execution",
            "failure_code": "scoped_worker_interrupted",
            "failure_message": type(exc).__name__,
            "lease_expires_at": None,
        }).eq("id", job_id).eq("worker_id", worker_id).execute()
        if job.get("request_id"):
            try:
                from .conversation_store import update_tutor_request
                update_tutor_request(
                    user_id=str(job["user_id"]), request_id=str(job["request_id"]),
                    status="failed", stage="scoped_worker_execution",
                    error_code="scoped_worker_interrupted", retryable=True,
                )
            except Exception:  # noqa: BLE001
                log.exception("scoped_job_request_failure_sync_failed job_id=%s", job_id)
    finally:
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=1)


async def _drain_capturing_answer(
    body_iterator: AsyncIterator[bytes],
) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
    """Consume _prepare_ask_stream_response's SSE stream and reconstruct the
    answer. Only the exhaustive per-item extraction lane persists its result
    onto the job row itself (persist_scoped_result) as it goes - every other
    lane (STANDARD_RAG, FAST_*, cache hits, etc.) produces a perfectly good
    answer that this worker used to just discard, leaving the job's
    finalText/processingFinished unset forever. Both the browser's own live
    poller (early_stream, stream.py) and this module's post-run sync key off
    exactly those two fields, so a request resolving through any non-
    exhaustive lane looked permanently stuck ("Could not finish") even
    though a correct answer had already been generated server-side.
    """
    text_parts: list[str] = []
    sources: list[dict[str, Any]] = []
    error: dict[str, Any] | None = None
    async for chunk in body_iterator:
        if not chunk:
            continue
        for line in chunk.decode("utf-8", errors="ignore").splitlines():
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[len("data: "):])
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if isinstance(event.get("t"), str):
                text_parts.append(event["t"])
            if event.get("error"):
                error = event
            if event.get("done") and isinstance(event.get("sources"), list):
                sources = event["sources"]
    return "".join(text_parts), sources, error


async def _execute(job: dict[str, Any]) -> None:
    # Import lazily to avoid a router/service cycle during app startup.
    from ..routers.stream import (
        AskStreamRequest,
        _load_authorized_documents,
        _prepare_ask_stream_response,
    )
    from .conversation_store import update_tutor_request
    from .execution_router import resolve_execution_plan
    from .grounding_contract import GroundingRequest, GroundingResolution

    payload = AskStreamRequest.model_validate(dict(job.get("request_payload") or {}))
    document_ids = list(job.get("document_ids") or [])
    documents = _load_authorized_documents(
        str(job["user_id"]), str(job["course_id"]), document_ids,
    )
    # ask_stream_endpoint computes grounding_request/grounding_resolution/
    # execution_plan itself before ever creating this job, and stashes the
    # first two into requestSnapshot for persistence. Re-derive all three
    # here rather than leaving them out of preflight (as a prior version of
    # this function did) - _prepare_ask_stream_response reads them from
    # preflight unconditionally, and a missing execution_plan crashed every
    # scoped job with AttributeError: 'NoneType' object has no attribute
    # 'executionLane' (confirmed via production logs, job 58007d41-...,
    # 2026-09-01).
    snapshot = dict((job.get("request_payload") or {}).get("requestSnapshot") or {})
    if not snapshot.get("groundingRequest") or not snapshot.get("groundingResolution"):
        raise RuntimeError("scoped job request_payload missing groundingRequest/groundingResolution snapshot")
    grounding_request = GroundingRequest.model_validate(snapshot["groundingRequest"])
    grounding_resolution = GroundingResolution.model_validate(snapshot["groundingResolution"])
    previous_turns = payload.previousTurns or []
    previous_user_question = next(
        (turn.text for turn in reversed(previous_turns) if turn.role == "user" and turn.text.strip()),
        None,
    )
    _task_profile, execution_plan = resolve_execution_plan(
        question=(payload.question or "").strip(),
        resolved_access=grounding_resolution.documentAccess,
        processing_pipeline=grounding_resolution.processingPipeline,
        source_mode=payload.sourceMode,
        has_previous_answer=any(
            turn.role == "assistant" and bool(turn.text.strip()) for turn in previous_turns
        ),
        previous_question=previous_user_question,
    )
    preflight = {
        "resolved_document_ids": document_ids,
        "document_name_resolution": None,
        "doc_name_map": {
            document_id: str(row.get("file_name") or "")
            for document_id, row in documents.items()
        },
        "documents": documents,
        "execution_plan": execution_plan,
        "grounding_request": grounding_request,
        "grounding_resolution": grounding_resolution,
    }
    response = await _prepare_ask_stream_response(
        payload,
        {"id": str(job["user_id"])},
        None,
        str(job.get("request_id") or uuid.uuid4().hex),
        preflight,
    )
    final_text, sources, sse_error = await _drain_capturing_answer(response.body_iterator)
    job_snapshot = load_job_snapshot(user_id=str(job["user_id"]), job_id=str(job["id"]))
    already_persisted = bool(
        job_snapshot and job_snapshot.get("finalText") and job_snapshot.get("processingFinished")
    )
    already_terminal_failed = bool(
        job_snapshot and str(job_snapshot.get("status") or "") in {
            "failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded",
        }
    )
    if sse_error and not already_persisted and not already_terminal_failed:
        get_supabase().table("complete_document_jobs").update({
            "status": "failed_recoverable",
            "current_stage": "worker_execution",
            "failure_code": str(sse_error.get("code") or "answer_stream_error"),
            "failure_message": str(sse_error.get("message") or "")[:500],
            "lease_expires_at": None,
        }).eq("id", job["id"]).execute()
        job_snapshot = load_job_snapshot(user_id=str(job["user_id"]), job_id=str(job["id"]))
    elif final_text and not already_persisted and not already_terminal_failed:
        persist_scoped_result(
            job_id=str(job["id"]), final_text=final_text,
            learning_journey=None, sources=sources, answer_mode="standard_qa",
        )
        get_supabase().table("complete_document_jobs").update({
            "status": "processing_finished", "current_stage": "completed",
        }).eq("id", job["id"]).execute()
        job_snapshot = load_job_snapshot(user_id=str(job["user_id"]), job_id=str(job["id"]))
    if (
        job_snapshot
        and job_snapshot.get("finalText")
        and job_snapshot.get("processingFinished")
        and str(job_snapshot.get("status") or "")
        not in {"failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded"}
        and job.get("request_id")
    ):
        update_tutor_request(
            user_id=str(job["user_id"]), request_id=str(job["request_id"]),
            status="completed", stage="completed",
            final_answer=str(job_snapshot["finalText"]), retryable=False,
        )
    elif (
        job_snapshot
        and str(job_snapshot.get("status") or "")
        in {"failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded"}
        and job.get("request_id")
    ):
        terminal = str(job_snapshot.get("status") or "")
        update_tutor_request(
            user_id=str(job["user_id"]), request_id=str(job["request_id"]),
            status="failed",
            stage=str(job_snapshot.get("currentStage") or terminal),
            error_code=str(job_snapshot.get("failureCode") or "scoped_worker_interrupted"),
            retryable=terminal not in {"failed_terminal", "cancelled"},
        )
    log.info("scoped_job_worker_finished job_id=%s", job["id"])


__all__ = ["start_scoped_job_worker"]
