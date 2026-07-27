from pathlib import Path


ROOT = Path(__file__).parents[3]
MIGRATION = (ROOT / "supabase" / "migrations" / "20260726_000007_scoped_document_jobs.sql").read_text(encoding="utf-8")
REFRESH_MIGRATION = (ROOT / "supabase" / "migrations" / "20260727_000008_scoped_job_message_binding.sql").read_text(encoding="utf-8")
RESULT_MIGRATION = (ROOT / "supabase" / "migrations" / "20260727_000009_scoped_job_results.sql").read_text(encoding="utf-8")
STREAM = (ROOT / "backend" / "python-ai" / "app" / "routers" / "stream.py").read_text(encoding="utf-8")
STORE = (ROOT / "backend" / "python-ai" / "app" / "services" / "scoped_job_store.py").read_text(encoding="utf-8")


def test_scoped_schema_persists_jobs_manifests_items_events_and_units():
    for table in (
        "complete_document_jobs", "request_scope_manifests", "request_scope_items",
        "scope_job_events", "document_logical_units",
    ):
        assert f"public.{table}" in MIGRATION
    for field in (
        "stable_key", "answer_checkpoint", "event_key", "source_fingerprint",
        "scope_fingerprint", "structural_index_status",
    ):
        assert field in MIGRATION


def test_stream_uses_manifest_seal_checkpoint_before_authoritative_finalizer():
    checkpoint = STREAM.index("discovery_checkpoint=discovery_checkpoint")
    finalizer = STREAM.index("scoped_job_state = finalise_scoped_job")
    journey = STREAM.index("learning_journey = build_learning_journey")
    assert checkpoint < finalizer < journey


def test_refresh_endpoint_reuses_persisted_job_engine():
    assert '@router.get("/scoped-jobs/{job_id}")' in STREAM
    assert "load_job_snapshot" in STREAM


def test_job_is_persisted_and_bound_before_structural_reindex():
    job = STREAM.index("scoped_job = await run_in_threadpool")
    reindex = STREAM.index("lambda: index_document(payload.activeDocumentId")
    assert job < reindex
    assert "bind_scoped_job_to_tutor_turn" in REFRESH_MIGRATION
    assert "scoped_job_id" in REFRESH_MIGRATION


def test_structural_progress_is_checkpointed_on_the_durable_job():
    assert "structural_checkpoint jsonb" in REFRESH_MIGRATION
    assert "def persist_structural_checkpoint" in STORE
    assert "persist_structural_checkpoint(" in STREAM


def test_verified_manifest_skips_warm_structural_rebuild():
    assert 'active_manifest is None' in STREAM
    assert 'structural_index_status") != "structured_ready"' in STREAM


def test_early_scoped_job_event_precedes_document_extraction():
    created = STREAM.index('"event": "scope.job.created"')
    extraction = STREAM.index("extraction = await run_in_threadpool", created)
    assert created < extraction


def test_offline_result_is_persisted_and_returned_by_snapshot():
    assert "final_text text" in RESULT_MIGRATION
    assert "def persist_scoped_result" in STORE
    assert '"finalText": job.get("final_text")' in STORE


def test_manifest_items_reuse_structural_multi_page_ranges():
    assert "load_question_unit_ranges" in STORE
    assert 'structural_range.get("page_start")' in STREAM
    assert 'structural_range.get("page_end")' in STREAM
