from __future__ import annotations

from app.services.multi_item_retrieval import (
    EvidenceStatus,
    analyse_request,
    answer_plan_overlay,
    controlled_course_terms,
    ensure_complete_answer,
    retrieve_multi_item_course_evidence,
    validate_final_answer,
)
from app.services.retrieval import RetrievedChunk

REQUEST = """Explain all of these questions in German using course files:
1. What are the three main groups of forming processes?
2. How is forming classified according to DIN 8582 or stress state?
3. What distinctions are made in Gesenkschmieden?
4. Name the advantages of Verzahnungswalzen?
"""

EXACT_TEN_REQUEST = """Wie können Umformverfahren eingeteilt werden (drei Gruppen)?
§ Wie kann das Umformen nach der DIN 8582 bzw. dem Spannungszustand eingeteilt werden?
§ Was kann beim Gesenkschmieden unterschieden werden?
§ Nennen Sie drei Vorteile des Verzahnungswalzens.
Urformen ist das Fertigen eines festen Körpers aus formlosem Stoff durch Schaffen des Zusammenhaltes.
DIN 8580
M.Sc. Lena Brömstrup | Fertigungstechnik | Übung – Klausurvorbereitung | Seite 6
Institut für Füge- und Schweißtechnik
Beispielhafte Kurzfrageninhalte
§ Nennen Sie die sechs Hauptgruppen des Trennens nach der DIN 8580.
§ Welche beiden Schneidenarten werden beim Trennen unterschieden? Nennen Sie je ein Beispiel.
§ Wie setzt sich die Schweißbarkeit eines Bauteils zusammen? (Schweißdreieck)
§ Nennen Sie zwei Beschichtungsgruppen nach der DIN 8580.
§ Nennen Sie zwei Vor- und zwei Nachteile der Stereolithographie.
§ Was sind die drei Zonen einer Standard-3-Zonen-Schnecke?
I want the answers to all of these questions from the course files. in detail please and explained. The terms should be in german. I want these questions to be answered and none other"""


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


def test_exact_ten_question_slide_inventory_excludes_noise_and_merges_continuation():
    manifest = analyse_request(EXACT_TEN_REQUEST)
    assert len(manifest.requested_items) == 10
    assert [item.id for item in manifest.requested_items] == [f"item-{i}" for i in range(1, 11)]
    questions = [item.original_text for item in manifest.requested_items]
    assert "Urformen ist das Fertigen" not in "\n".join(questions)
    assert not any(question == "DIN 8580" for question in questions)
    assert "Lena Brömstrup" not in "\n".join(questions)
    assert questions[5] == "Welche beiden Schneidenarten werden beim Trennen unterschieden? Nennen Sie je ein Beispiel."
    q9 = manifest.requested_items[8]
    requirements = {(item.category, item.expected_count) for item in q9.requirements}
    assert ("advantage", 2) in requirements
    assert ("disadvantage", 2) in requirements
    assert manifest.language == "de"


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


def test_final_validator_repairs_a_skipped_question_without_raw_status():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=inventory_loader, semantic_retriever=no_semantic,
    )
    partial = "\n".join(
        f"## {item.original_text}\nAnswer" for item in result.manifest.requested_items[:3]
    ) + "\nStatus: index_gap"
    assert not validate_final_answer(result, partial).complete
    repaired, validation = ensure_complete_answer(
        result, partial, allow_general_fallback=True,
        fallback_generator=lambda question: (
            "1. Verified answer point with a concrete technical cause.\n"
            "2. A second verified point explains the practical consequence in sufficient detail.\n"
            "3. A third verified point gives an applicable engineering example and explanation."
        ),
    )
    assert validation.complete
    assert result.manifest.requested_items[3].original_text in repaired
    assert "Status: index_gap" not in repaired
    assert "Source basis: General knowledge" in repaired


def test_german_fallback_template_stays_german():
    request = "Nennen Sie drei Vorteile des Walzens? Was ist Umformen?"
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=request,
        inventory_loader=lambda **_: (["forming"], [], False),
        semantic_retriever=no_semantic,
    )
    repaired, validation = ensure_complete_answer(
        result, "", allow_general_fallback=True,
        fallback_generator=lambda question: (
            "1. Sachliche deutsche Antwort mit einer ausführlichen technischen Begründung.\n"
            "2. Der Zusammenhang wird verständlich erklärt und durch ein praktisches Beispiel ergänzt.\n"
            "3. Dadurch ist die Antwort vollständig und für die Prüfung nachvollziehbar."
        ),
    )
    assert validation.complete
    assert "Grundlage: Allgemeines Fachwissen" in repaired
    assert "Source basis:" not in repaired


def test_placeholder_heading_is_not_substantive_coverage_and_is_repaired():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=REQUEST,
        inventory_loader=inventory_loader, semantic_retriever=no_semantic,
    )
    placeholder = "\n\n".join(
        f"## {item.original_text}\nThe authorised course material did not provide enough reliable evidence for this item."
        for item in result.manifest.requested_items
    )
    before = validate_final_answer(result, placeholder)
    assert len(before.rendered_item_ids) == 4
    assert not before.complete
    assert all(item.unresolved_placeholder_only for item in before.item_coverage)

    repaired, after = ensure_complete_answer(
        result, placeholder, allow_general_fallback=True,
        fallback_generator=lambda _: (
            "1. First substantive technical answer with a clear causal explanation.\n"
            "2. Second substantive point explains its practical engineering significance.\n"
            "3. Third substantive point includes a concrete application example for context."
        ),
    )
    assert after.complete
    assert "authorised course material did not provide" not in repaired
    assert all(item.substantive_answer_present for item in after.item_coverage)
    assert all(item.explanation_present for item in after.item_coverage)


def test_exact_ten_question_request_requires_ten_substantive_explanations():
    result = retrieve_multi_item_course_evidence(
        user_id="u", course_id="c", question=EXACT_TEN_REQUEST,
        inventory_loader=lambda **_: (["forming"], [], False),
        semantic_retriever=no_semantic,
    )
    repaired, validation = ensure_complete_answer(
        result, "", allow_general_fallback=True,
        fallback_generator=lambda _: "\n".join(
            f"{index}. Fachlich geprüfter Punkt {index} mit technischer Ursache, "
            "praktischer Bedeutung und einer nachvollziehbaren ausführlichen Erklärung."
            for index in range(1, 7)
        ),
    )
    assert len(validation.expected_item_ids) == 10
    assert len(validation.rendered_item_ids) == 10
    assert validation.complete
    assert all(item.substantive_answer_present for item in validation.item_coverage)
    assert all(item.explanation_present for item in validation.item_coverage)
    assert all(item.requested_counts_satisfied for item in validation.item_coverage)
    assert "The authorised course material" not in repaired
    assert repaired.count("Grundlage: Allgemeines Fachwissen") == 10
