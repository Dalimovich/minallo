from pathlib import Path


ROOT = Path(__file__).parents[3]
MIGRATION = (ROOT / "supabase" / "migrations" / "20260726_000007_scoped_document_jobs.sql").read_text(encoding="utf-8")
STREAM = (ROOT / "backend" / "python-ai" / "app" / "routers" / "stream.py").read_text(encoding="utf-8")


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
