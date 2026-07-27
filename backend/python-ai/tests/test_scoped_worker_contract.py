from pathlib import Path


ROOT = Path(__file__).parents[3]
STREAM = (ROOT / "backend/python-ai/app/routers/stream.py").read_text(encoding="utf-8")
WORKER = (ROOT / "backend/python-ai/app/services/scoped_job_worker.py").read_text(encoding="utf-8")
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


def test_sse_observes_persisted_job_instead_of_running_extraction():
    branch = STREAM[STREAM.index("if precreated_scoped_job:"):]
    poll = branch.index("load_job_snapshot")
    old_execution = branch.index("_prepare_ask_stream_response")
    assert poll < old_execution
    assert "await asyncio.sleep(1.5)" in branch[:old_execution]


def test_resume_and_retry_endpoints_preserve_job_identity():
    for suffix in ("resume", "retry-failed", "retry-unresolved"):
        assert f'@router.post("/scoped-jobs/{{job_id}}/{suffix}")' in STREAM
