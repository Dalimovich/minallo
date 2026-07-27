import json
from pathlib import Path

import pytest

from app.services.scoped_extraction import (
    CANONICAL_KURZFRAGEN_IDS, CoverageIntent, DiscoveryStatus, ExtractionInvariantError,
    RequestScopeManifest, RetrievalMode, ScopeItem, ScopeItemStatus, ScopedJobState,
    StructuralUnit, assert_result_invariants, classify_scoped_request,
    persist_batch_results, promote_manifest, reconcile_structural_units,
    deduplicate_scope_items, retrieve_units, scoped_state_payload,
    stable_scope_key, validate_manifest,
)


def _item(number: str, status=ScopeItemStatus.DISCOVERED):
    section = number.split(".")[0]
    return ScopeItem(number, f"rev:exam_question:{number}", "doc", "rev", number, number,
                     "exam_question", section, None, 1, 1, 1, status=status)


def _manifest(items):
    return RequestScopeManifest(
        id="m", job_id="j", document_revision_id="rev",
        discovery_status=DiscoveryStatus.COMPLETE, manifest_sealed=True,
        manifest_verified=True,
        included_section_numbers=[str(n) for n in range(2, 12)],
        excluded_section_numbers=["12", "13", "14"], question_pages=[1],
        items=items, source_fingerprint="src", scope_fingerprint="scope",
        extractor_schema_version="scoped-v1",
    )


@pytest.mark.parametrize("prompt", [
    "all Kurzfragen", "all the Kurzfragen", "every Kurzfrage",
    "the rest of the Kurzfragen", "do not leave any Kurzfrage out",
    "work through all short questions",
    "I need every Kurzfrage answered",
])
def test_equivalent_prompts_use_coverage_target(prompt):
    spec = classify_scoped_request(prompt)
    assert spec.retrieval_mode is RetrievalMode.COVERAGE
    assert spec.coverage_intent is CoverageIntent.ALL
    assert spec.canonical_target == "kurzfragen"


def test_canonical_manifest_has_exact_45_ids():
    assert len(CANONICAL_KURZFRAGEN_IDS) == 45
    assert CANONICAL_KURZFRAGEN_IDS == tuple(
        [f"2.{n}" for n in range(1, 5)]
        + [f"3.{n}" for n in range(1, 5)]
        + [f"4.{n}" for n in range(1, 5)]
        + [f"5.{n}" for n in range(1, 20)]
        + [f"6.{n}" for n in range(1, 5)]
        + [f"7.{n}" for n in range(1, 4)]
        + ["8.1"] + [f"9.{n}" for n in range(1, 4)]
        + ["10.1", "10.2", "11.1"]
    )


def test_all_kurzfragen_matches_canonical_manifest_fixture():
    fixture = json.loads((
        Path(__file__).parent / "fixtures" / "fertigungstechnik_ws17_18_kurzfragen_manifest.json"
    ).read_text(encoding="utf-8"))
    assert tuple(fixture["expected_ids"]) == CANONICAL_KURZFRAGEN_IDS
    assert fixture["expected_count"] == len(CANONICAL_KURZFRAGEN_IDS)
    assert fixture["question_pages"] == list(range(3, 14))


def test_questions_cannot_exist_without_resolved_pages():
    with pytest.raises(ExtractionInvariantError, match="questions_without_resolved_question_pages"):
        assert_result_invariants(question_pages_total=0, discovered_count=1)


def test_kurzfragen_rejects_sections_12_to_14():
    accepted, rejected = validate_manifest(_manifest([_item("2.1"), _item("12.20"), _item("13.10"), _item("14.6")]))
    assert [x.item_number for x in accepted] == ["2.1"]
    assert rejected == ["12.20", "13.10", "14.6"]


def test_state_separates_scope_from_answer_verification():
    state = ScopedJobState(DiscoveryStatus.COMPLETE, True, 45, answered_count=44, unresolved_count=1)
    assert state.discovery_complete and state.processing_finished and not state.all_answers_verified


def test_processing_and_failure_block_authoritative_states():
    processing = ScopedJobState(DiscoveryStatus.COMPLETE, True, 45, processing_count=1, answered_count=44)
    failed = ScopedJobState(DiscoveryStatus.COMPLETE, True, 45, answered_count=44, failed_count=1)
    assert not processing.processing_finished
    assert failed.processing_finished and not failed.all_answers_verified


def test_no_items_found_is_not_success():
    state = ScopedJobState(DiscoveryStatus.NO_ITEMS_FOUND, False, 0)
    assert not state.discovery_complete and not state.all_answers_verified


def test_stable_semantic_ids_survive_reindex():
    assert stable_scope_key("r", "exam_question", "2.1", 1, 3) == stable_scope_key("r", "exam_question", "2.1", 99, 8)


def test_partial_candidate_cannot_replace_verified_manifest():
    existing = _manifest([_item(item_id) for item_id in CANONICAL_KURZFRAGEN_IDS])
    candidate = _manifest([_item("12.20"), _item("13.1")])
    candidate.id = "candidate"
    candidate.question_pages = []
    assert promote_manifest(existing, candidate).active_manifest is existing
    assert promote_manifest(existing, candidate).candidate_rejected


def test_same_revision_candidate_cannot_lose_known_ids():
    existing = _manifest([_item(item_id) for item_id in CANONICAL_KURZFRAGEN_IDS])
    candidate = _manifest([_item(item_id) for item_id in CANONICAL_KURZFRAGEN_IDS[:-2]])
    candidate.id = "candidate"
    result = promote_manifest(existing, candidate)
    assert result.candidate_rejected
    assert result.active_manifest is existing


def test_missing_batch_item_is_not_marked_answered():
    items = [_item(number, ScopeItemStatus.PENDING) for number in ("2.1", "2.2", "2.3")]
    result = persist_batch_results(
        items, requested_ids=["2.1", "2.2", "2.3"], returned_ids=["2.1", "2.3"],
    )
    states = {item.item_number: item.status for item in result.items}
    assert states["2.2"] is ScopeItemStatus.PENDING
    assert result.missing_ids == ("2.2",)


def test_reindex_preserves_stable_scope_units_without_duplicates():
    first = StructuralUnit("rev:exam_question:12.4", "doc", "rev", "exam_question", 1, 12, 16, "Question", "12.4", "12")
    improved = StructuralUnit("rev:exam_question:12.4", "doc", "rev", "exam_question", 1, 12, 16, "Improved OCR", "12.4", "12")
    reconciled = reconcile_structural_units([first], [improved])
    assert len(reconciled) == 1
    assert reconciled[0].source_text == "Improved OCR"


def test_multi_page_question_is_one_logical_unit():
    parent = StructuralUnit("rev:exam_question:12", "doc", "rev", "exam_question", 1, 12, 16, "Shared givens", "12")
    child = StructuralUnit("rev:exam_question:12.4", "doc", "rev", "exam_subquestion", 2, 16, 16, "Part 4", "12.4", "12")
    units = reconcile_structural_units([], [parent, child])
    assert units[0].page_start == 12 and units[0].page_end >= 16
    assert units[1].parent_question == "12"


def test_coverage_mode_enumerates_beyond_top_k():
    units = [
        StructuralUnit(f"u-{n}", "doc", "rev", "exam_question", n, n, n, str(n), f"2.{n}", "2")
        for n in range(1, 76)
    ]
    assert len(retrieve_units(
        units, mode=RetrievalMode.COVERAGE, configured_limit=20,
    )) == 75


def test_relevance_mode_remains_focused():
    units = [
        StructuralUnit(f"u-{n}", "doc", "rev", "definition", n, n, n, str(n))
        for n in range(30)
    ]
    focused = retrieve_units(units, mode=RetrievalMode.RELEVANCE, configured_limit=8)
    assert len(focused) == 8


def test_scoped_job_resumes_without_duplicates():
    first = [_item(number, ScopeItemStatus.ANSWERED) for number in CANONICAL_KURZFRAGEN_IDS[:20]]
    resumed = first + [_item(number, ScopeItemStatus.PENDING) for number in CANONICAL_KURZFRAGEN_IDS[20:]] + first
    merged = deduplicate_scope_items(resumed)
    assert len(merged) == len(CANONICAL_KURZFRAGEN_IDS)
    assert sum(item.status is ScopeItemStatus.ANSWERED for item in merged) == 20


def test_answer_recovery_failure_cannot_shrink_inventory():
    manifest = _manifest([_item(number, ScopeItemStatus.PENDING) for number in CANONICAL_KURZFRAGEN_IDS])
    for item in manifest.items:
        item.error_code = "vision_extraction_failed"
    assert tuple(manifest.discovered_ids) == CANONICAL_KURZFRAGEN_IDS


def test_stream_and_polling_use_identical_authoritative_payload():
    state = ScopedJobState(
        DiscoveryStatus.COMPLETE, True, 45, answered_count=26, unresolved_count=19,
    )
    streamed = scoped_state_payload(job_id="job", manifest_id="manifest", state=state)
    polled = scoped_state_payload(job_id="job", manifest_id="manifest", state=state)
    assert streamed == polled


def test_cached_partial_job_remains_resumable_not_complete():
    state = ScopedJobState(
        DiscoveryStatus.COMPLETE, True, 45, pending_count=25, answered_count=20,
    )
    assert state.discovery_complete
    assert not state.processing_finished
    assert not state.all_answers_verified


def test_existing_indexer_persists_logical_units_alongside_chunks():
    from types import SimpleNamespace
    from app.services import indexing
    from app.services.chunking import Chunk

    written = []

    class Query:
        def delete(self): return self
        def eq(self, *_): return self
        def execute(self): return SimpleNamespace(data=[])
        def upsert(self, rows, **_):
            written.extend(rows)
            return self

    class Db:
        def table(self, _): return Query()

    indexing._replace_logical_units(
        Db(), document_id="doc", document_revision="rev", user_id="user",
        course_id="course",
        pages=["2. Kurzfragen - Grundlagen\n2.1 Welche Aussage ist korrekt?"],
        chunks=[Chunk("Definition Energie", 1, 1, "definition", "Grundlagen", 3)],
    )
    assert {row["block_type"] for row in written} == {
        "section_heading", "exam_question", "definition",
    }
    question = next(row for row in written if row["block_type"] == "exam_question")
    assert question["question_number"] == "2.1"
    assert question["stable_block_id"] == "rev:exam_question:2.1"
    for row in written:
        assert row["continues_on_next_page"] is not None
        assert row["has_diagram"] is not None
        assert row["previous_stable_keys"] is not None
        assert row["diagram_region_ids"] is not None
        assert row["solution_block_ids"] is not None
        assert row["source_text"] is not None
        assert row["metadata"] is not None
