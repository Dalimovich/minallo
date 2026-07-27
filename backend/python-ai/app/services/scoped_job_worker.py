"""Database-leased worker for exhaustive document jobs.

The queue and all useful state live in Postgres.  Each Gunicorn process may run
one poller; ``claim_next_scoped_job`` serialises claims and expired leases make
work recoverable by another process after a restart.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import threading
import time
import uuid
from typing import Any

from .scoped_job_store import claim_next_scoped_job, load_job_snapshot, renew_scoped_job_lease
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
    finally:
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=1)


async def _execute(job: dict[str, Any]) -> None:
    # Import lazily to avoid a router/service cycle during app startup.
    from ..routers.stream import (
        AskStreamRequest,
        _load_authorized_documents,
        _prepare_ask_stream_response,
    )
    from .conversation_store import update_tutor_request

    payload = AskStreamRequest.model_validate(dict(job.get("request_payload") or {}))
    document_ids = list(job.get("document_ids") or [])
    documents = _load_authorized_documents(
        str(job["user_id"]), str(job["course_id"]), document_ids,
    )
    preflight = {
        "resolved_document_ids": document_ids,
        "document_name_resolution": None,
        "doc_name_map": {
            document_id: str(row.get("file_name") or "")
            for document_id, row in documents.items()
        },
        "documents": documents,
    }
    response = await _prepare_ask_stream_response(
        payload,
        {"id": str(job["user_id"])},
        None,
        str(job.get("request_id") or uuid.uuid4().hex),
        preflight,
    )
    async for _event in response.body_iterator:
        # The authoritative pipeline persists manifests, checkpoints, item
        # states, and the renderable result before yielding its terminal event.
        pass
    snapshot = load_job_snapshot(user_id=str(job["user_id"]), job_id=str(job["id"]))
    if snapshot and snapshot.get("finalText") and job.get("request_id"):
        update_tutor_request(
            user_id=str(job["user_id"]), request_id=str(job["request_id"]),
            status="completed", stage="completed",
            final_answer=str(snapshot["finalText"]), retryable=False,
        )
    log.info("scoped_job_worker_finished job_id=%s", job["id"])


__all__ = ["start_scoped_job_worker"]
