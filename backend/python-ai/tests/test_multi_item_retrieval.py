from __future__ import annotations

from app.services.multi_item_retrieval import (
    EvidenceStatus,
    analyse_request,
    answer_plan_overlay,
    controlled_course_terms,
    retrieve_multi_item_course_evidence,
)
from app.services.retrieval import RetrievedChunk

REQUEST = """Explain all of these questions in German using course files:
1. What are the three main groups of forming processes?
2. How is forming classified according to DIN 8582 or stress state?
3. What distinctions are made in Gesenkschmieden?
4. Name the advantages of Verzahnungswalzen?
"""


def row(chunk_id, page, text, section=None):
    return {
        "id": chunk_id, "document_id": "forming", "page_start": page,
        "page_end": page, "chunk_text": text, "chunk_type": "lecture",
        "section_title": section,
    }


ROWS = [
    row("p5", 5, "Einteilung der Umformverfahren: Massivumformen, Blechumformen und inkrementelles Umformen", "Einteilung der Umformverfahren"),
    row("p6", 6, "DIN 8582 nach Spannungszustand: Druckumformen, Zugdruckumformen, Zugumformen, Biegeumformen, Schubumformen", "DIN 8582"),
    row("p14", 14, "Ringwalzen", "Ringwalzen"),
    row("p18", 18, "Gesenkschmieden mit Grat, ohne Grat und Präzisionsschmieden", "Gesenkschmieden"),
    row("p19", 19, "Die Varianten unterscheiden sich durch den Stofffluss und die Gratbildung", "Gesenkschmieden"),
    row("p20", 20, "Vorteile des Verzahnungs-\nwalzens: Kaltverfestigung, günstiger Faserverlauf und hohe Oberflächengüte", "Verzahnungswalzen"),
    row("p22", 22, "Video Strangpressen", "Strangpressen"),
]


def inventory_loader(**_):
    return ["forming"], list(ROWS), False


def no_semantic(**_):
    return []


def test_four_questions_produce_four_retrieval_items():
    manifest = analyse_request(REQUEST)
    assert len(manifest.requested_items) == 4
    assert [item.id for item in manifest.requested_items] == ["item-1", "item-2", "item-3", "item-4"]


def test_english_request_expands_to_controlled_german_course_terms():
    terms = controlled_course_terms("advantages of gear rolling")
    assert "vorteile verzahnungswalzen" in terms
    assert "kaltverfestigung" in terms


def test_exact_regression_retrieves_evidence_for_every_item_and_neighbours():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=inventory_loader, semantic_retriever=no_semantic,
    )
    assert [item.status for item in result.evidence] == [EvidenceStatus.SUPPORTED] * 4
    pages = [set(item.searched_pages) for item in result.evidence]
    assert pages[0] & {5, 6}
    assert 6 in pages[1]
    assert 18 in pages[2]
    assert 20 in pages[3]
    assert "p19" in result.evidence[2].candidate_chunk_ids
    assert "p14" not in {chunk_id for item in result.evidence for chunk_id in item.supporting_chunk_ids}
    assert "p22" not in {chunk_id for item in result.evidence for chunk_id in item.supporting_chunk_ids}


def test_hyphenated_ocr_term_matches_compound_query():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c",
        question="Answer these questions: What are advantages of gear rolling? What is DIN 8582?",
        inventory_loader=inventory_loader, semantic_retriever=no_semantic,
    )
    assert "p20" in result.evidence[0].supporting_chunk_ids


def test_partial_result_answers_supported_items_and_marks_only_absent_one():
    missing_rows = [item for item in ROWS if item["id"] != "p18" and item["id"] != "p19"]
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=lambda **_: (["forming"], missing_rows, False),
        semantic_retriever=no_semantic,
    )
    assert result.evidence[0].status is EvidenceStatus.SUPPORTED
    assert result.evidence[1].status is EvidenceStatus.SUPPORTED
    assert result.evidence[2].status is EvidenceStatus.NOT_FOUND
    assert result.evidence[3].status is EvidenceStatus.SUPPORTED
    overlay = answer_plan_overlay(result)
    assert "Do not let an unresolved item suppress supported items" in overlay


def test_index_gap_is_distinct_from_missing_upload():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=lambda **_: (["forming"], [], True),
        semantic_retriever=no_semantic,
    )
    assert all(item.status is EvidenceStatus.INDEX_GAP for item in result.evidence)
    assert "already indexed file" in answer_plan_overlay(result)


def test_retrieval_failure_is_not_reported_as_absent_material():
    def broken(**_):
        raise RuntimeError("RPC unavailable")

    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=inventory_loader, semantic_retriever=broken,
    )
    assert all(item.status is EvidenceStatus.SUPPORTED for item in result.evidence)

    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=lambda **_: (["forming"], [], False), semantic_retriever=broken,
    )
    assert all(item.status is EvidenceStatus.RETRIEVAL_FAILED for item in result.evidence)
    assert all(item.error_code == "semantic_retrieval_failed" for item in result.evidence)


def test_exact_heading_survives_even_without_semantic_similarity():
    exact = [row("heading", 30, "", "Verzahnungswalzen Vorteile")]
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c",
        question="Answer these questions: Name advantages of gear rolling? What is DIN 8582?",
        inventory_loader=lambda **_: (["forming"], exact, False),
        semantic_retriever=no_semantic,
    )
    assert result.evidence[0].status is EvidenceStatus.SUPPORTED
    assert result.chunks[0].score >= 3.0


def test_semantic_candidates_are_deduplicated_across_items():
    shared = RetrievedChunk("shared", "forming", 5, 5, "DIN 8582", .8, .8, "lecture", "DIN 8582")
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=lambda **_: (["forming"], [], False),
        semantic_retriever=lambda **_: [shared],
    )
    assert [chunk.chunk_id for chunk in result.chunks].count("shared") == 1


def test_stream_and_non_stream_use_the_same_multi_item_orchestrator():
    from pathlib import Path

    app_root = Path(__file__).parents[1] / "app" / "routers"
    for router_name in ("ask.py", "stream.py"):
        source = (app_root / router_name).read_text(encoding="utf-8")
        assert "retrieve_multi_item_course_evidence(" in source
        assert "answer_plan_overlay(multi_item_result)" in source


def test_answer_contract_preserves_all_questions_and_hides_internal_statuses():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=lambda **_: (["forming"], ROWS[:2], False),
        semantic_retriever=no_semantic,
    )
    overlay = answer_plan_overlay(result)
    assert "Produce exactly 4 numbered sections" in overlay
    assert all(item.original_text in overlay for item in result.manifest.requested_items)
    assert "Status:" not in overlay
    assert "status=" not in overlay
    assert "Source basis:" in overlay
