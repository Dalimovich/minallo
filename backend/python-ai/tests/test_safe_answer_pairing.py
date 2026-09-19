import pytest

from app.services import document_extraction as extraction
from app.services.document_extraction_cache import EXTRACTOR_SCHEMA_VERSION


def question(text="Welche Aussage trifft auf eine Fertigungszelle zu?", **changes):
    values = {
        "item_id": "2.1", "normalized_item_id": "2.1", "question_text": text,
        "question_page": 2, "question_fingerprint": extraction.question_fingerprint(text),
        "confidence": .95, "document_id": "exam", "document_revision": "exam-a",
        "scope_fingerprint": "scope-a", "source_structure": "Kurzfragen",
    }
    values.update(changes)
    return extraction.ExtractedQuestion(**values)


def solution(answer="Fertigungszelle", **changes):
    values = {
        "item_id": "2.1", "normalized_item_id": "2.1", "answer_text": answer,
        "answer_page": 40, "evidence_type": "printed_answer", "confidence": .95,
        "document_id": "exam", "document_revision": "exam-a",
        "scope_fingerprint": "scope-a", "source_structure": "Kurzfragen",
    }
    values.update(changes)
    return extraction.ExtractedSolutionEvidence(**values)


@pytest.mark.parametrize("field,value", [
    ("document_id", "other-exam"),
    ("document_revision", "exam-b"),
    ("scope_fingerprint", "scope-b"),
])
def test_composite_identity_mismatch_is_rejected(field, value):
    pair = extraction.pair_questions_and_solutions([question()], [solution(**{field: value})])[0]
    assert pair.answer_text is None


def test_same_id_from_different_question_is_rejected():
    wrong = solution(
        referenced_question_text="Welche Groesse beschreibt den Vorschub?",
        question_fingerprint=extraction.question_fingerprint("Welche Groesse beschreibt den Vorschub?"),
    )
    assert extraction.pair_questions_and_solutions([question()], [wrong])[0].answer_text is None


def test_conflicting_same_id_is_unresolved_never_first_match():
    pair = extraction.pair_questions_and_solutions(
        [question(item_id="5.2", normalized_item_id="5.2")],
        [solution("Standmenge", item_id="5.2", normalized_item_id="5.2"),
         solution("Standrichtung", item_id="5.2", normalized_item_id="5.2")],
    )[0]
    assert pair.answer_text is None
    assert pair.error_code == "conflicting_solution_evidence"


@pytest.mark.parametrize("origin", ["generated_from_course_context", "previous_paired_answer"])
def test_non_raw_previous_evidence_is_rejected(origin):
    assert extraction.pair_questions_and_solutions(
        [question()], [solution(evidence_origin=origin)]
    )[0].answer_text is None


def test_compatible_raw_evidence_is_reused_deterministically():
    first = extraction.pair_questions_and_solutions([question()], [solution()])
    second = extraction.pair_questions_and_solutions([question()], [solution()])
    assert first == second
    assert first[0].answer_origin == "official_source_answer"


def test_duplicate_canonical_question_is_merged_once():
    assert len(extraction.canonicalize_questions([question(), question(question_page=3)])) == 1


def test_same_item_id_with_different_question_raises_structural_conflict():
    with pytest.raises(extraction.QuestionIdentityConflict):
        extraction.canonicalize_questions([question(), question("Welche Groesse beschreibt den Vorschub?")])


@pytest.mark.parametrize("marker", ["1P", "0P"])
def test_score_marker_is_not_final_answer(marker):
    pair = extraction.pair_questions_and_solutions([question()], [solution(marker)])[0]
    assert pair.answer_text is None
    assert pair.error_code == "score_marker_is_not_answer"


def test_score_marker_resolves_unique_marked_option_text():
    q = question(answer_type="multiple_choice", options=[
        extraction.ExtractedQuestionOption("0P", "Falsch", 0),
        extraction.ExtractedQuestionOption("1P", "Lasern", 1),
    ])
    assert extraction.pair_questions_and_solutions([q], [solution("1P")])[0].answer_text == "Lasern"


def test_semantic_answer_shape_mismatch_is_rejected():
    q = question(answer_type="multiple_choice", options=[
        extraction.ExtractedQuestionOption("A", "Lasern", 0),
    ])
    pair = extraction.pair_questions_and_solutions([q], [solution("Fraesen")])[0]
    assert pair.error_code == "answer_shape_mismatch"


def test_zero_scanned_pages_with_answers_fails_closed():
    result = extraction.DocumentExtractionResult("exam", "Kurzfragen", 43)
    result.items = [extraction.ExtractedQAItem("2.1", "Frage?", "Falsche Antwort", 2)]
    rendered = extraction.format_document_extraction(result, "de")
    assert "Falsche Antwort" not in rendered
    assert "keine extrahierten Antworten" in rendered


def test_explicit_requested_question_set_does_not_expand_to_exam_inventory():
    prompt = "Answer all of these questions: Was ist A? Was ist B?"
    assert extraction.classify_document_extraction(prompt) == (False, False, None)


def test_legacy_pairing_schema_is_invalidated():
    assert EXTRACTOR_SCHEMA_VERSION == 2
    assert extraction.pair_questions_and_solutions(
        [question()], [solution(pairing_schema_version=1)]
    )[0].answer_text is None
