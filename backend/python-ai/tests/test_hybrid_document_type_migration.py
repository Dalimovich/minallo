from pathlib import Path


def test_latest_hybrid_rpc_uses_an_unambiguous_effective_document_type():
    migration = (
        Path(__file__).parents[3]
        / "supabase" / "migrations"
        / "20260728_000003_fix_hybrid_document_type_ambiguity.sql"
    ).read_text("utf-8")
    assert "as effective_document_type" in migration
    assert "e.effective_document_type" in migration
    assert "d.document_type) as document_type," not in migration
