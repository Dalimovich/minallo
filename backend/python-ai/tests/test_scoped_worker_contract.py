from pathlib import Path


ROOT = Path(__file__).parents[3]
STREAM = (ROOT / "backend/python-ai/app/routers/stream.py").read_text(encoding="utf-8")
WORKER = (ROOT / "backend/python-ai/app/services/scoped_job_worker.py").read_text(encoding="utf-8")
STORE = (ROOT / "backend/python-ai/app/services/scoped_job_store.py").read_text(encoding="utf-8")
SHELL = (ROOT / "frontend/js/features/chatbot-new/shell.ts").read_text(encoding="utf-8")
MAIN = (ROOT / "backend/python-ai/app/main.py").read_text(encoding="utf-8")
MIGRATION = (ROOT / "supabase/migrations/20260727_000010_scoped_job_worker.sql").read_text(encoding="utf-8")


def test_exhaustive_job_is_queued_before_stream_execution():
    queued = STREAM.index("precreated_scoped_job = await run_in_threadpool")
    stream = STREAM.index("async def early_stream")
    reindex = STREAM.index("lambda: index_document(payload.activeDocumentId")
    assert queued < stream < reindex


def test_worker_uses_database_claim_and_expiring_lease():
    assert "for update skip locked" in MIGRATION.lower()
    assert "lease_expires_at" in MIGRATION
    assert "claim_next_scoped_job" in WORKER
    assert "renew_scoped_job_lease" in WORKER


def test_worker_starts_from_application_lifespan_and_consumes_pipeline():
    assert "start_scoped_job_worker()" in MAIN
    assert "_prepare_ask_stream_response" in WORKER
    assert "async for _event in response.body_iterator" in WORKER


def test_worker_reconstructs_authorized_preflight_for_canonical_job_reuse():
    assert "_load_authorized_documents" in WORKER
    assert '"resolved_document_ids": document_ids' in WORKER
    assert '"documents": documents' in WORKER
    assert "_prepare_ask_stream_response(" in WORKER
    assert "preflight," in WORKER


def test_worker_only_completes_tutor_turn_after_successful_processing():
    assert 'snapshot.get("processingFinished")' in WORKER
    assert '"failed_recoverable"' in WORKER
    assert '"failed_terminal"' in WORKER


def test_sse_observes_persisted_job_instead_of_running_extraction():
    branch = STREAM[STREAM.index("if precreated_scoped_job:"):]
    poll = branch.index("load_job_snapshot")
    old_execution = branch.index("_prepare_ask_stream_response")
    assert poll < old_execution
    assert "await asyncio.sleep(1.5)" in branch[:old_execution]
    assert '"failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded"' in branch


def test_resume_and_retry_endpoints_preserve_job_identity():
    for suffix in ("resume", "retry-failed", "retry-unresolved"):
        assert f'@router.post("/scoped-jobs/{{job_id}}/{suffix}")' in STREAM


def test_terminal_job_failure_is_synchronised_to_durable_request():
    assert 'in {"failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded"}' in WORKER
    assert 'error_code=str(snapshot.get("failureCode")' in WORKER


def test_resume_is_idempotent_while_worker_lease_is_valid():
    assert "Resume is idempotent while a valid worker owns this attempt" in STORE
    assert '@router.post("/requests/{request_id}/resume")' in STREAM
    assert 'retry_count >= 2' in STREAM
    assert 'stage="completion_repaired"' in STREAM
    assert "supersede_incompatible_job_binding" in STREAM
    assert 'error_code="request_routing_corrected"' in STREAM


def test_frontend_requires_live_nonstalled_worker_before_claiming_continuation():
    assert "job.isActivelyProcessing" in SHELL
    assert "job.isProgressStalled" in SHELL
    assert "request_progress_stalled" in SHELL
    assert "automaticResumeAttempts" in SHELL


def test_focused_numbered_target_overrides_legacy_document_extraction_classifier():
    gate = 'if scoped_request.target_type == "focused_numbered_target":'
    assert gate in STREAM
    assert STREAM.index(gate) < STREAM.index("if document_extraction:", STREAM.index(gate))
