from app.services.question_routing import (
    AcademicIntent, build_question_routing_plan, detect_topic, evidence_is_sufficient,
)
from app.services.retrieval import RetrievedChunk, retrieve_routed_chunks


def _types(plan):
    return [stage.document_types for stage in plan.source_stages]


def test_conceptual_and_explanation_source_orders():
    conceptual = build_question_routing_plan("Was ist Gesenkschmieden?", ["Gesenkschmieden"])
    assert conceptual.intents == (AcademicIntent.DEFINITION, AcademicIntent.CONCEPTUAL)
    assert _types(conceptual)[0] == ("lecture",)
    explanation = build_question_routing_plan("Erkläre Gesenkschmieden im Detail.", ["Gesenkschmieden"])
    assert AcademicIntent.EXPLANATION in explanation.intents
    assert _types(explanation)[:3] == [("lecture",), ("professor_notes",), ("solution_sheet",)]


def test_calculation_preserves_multiple_intents_and_stages():
    plan = build_question_routing_plan("Löse Aufgabe 13.1 und erkläre jeden Schritt.", ["Standzeit"])
    assert {AcademicIntent.CALCULATION, AcademicIntent.EXERCISE_SOLUTION,
            AcademicIntent.EXPLANATION}.issubset(plan.intents)
    assert _types(plan)[:4] == [
        ("exercise_sheet", "exam"), ("solution_sheet",), ("lecture",), ("formula_sheet",),
    ]
    assert "givens" in plan.required_evidence


def test_formula_and_exam_have_distinct_primary_sources():
    formula = build_question_routing_plan("Welche Formel wird für die Standzeit verwendet?", ["Standzeit"])
    assert _types(formula)[0] == ("formula_sheet",)
    exam = build_question_routing_plan("Beantworte die Kurzfragen aus der Klausur.")
    assert _types(exam)[0] == ("exam",)
    assert _types(exam)[1] == ("solution_sheet",)


def test_topic_inventory_exact_and_uncertain_fallback():
    exact = detect_topic("Nenne Vorteile des Verzahnungswalzens", ["Strangpressen", "Verzahnungswalzen"])
    assert exact.primary_topic == "Verzahnungswalzen" and exact.confidence >= 0.8
    ambiguous = detect_topic("Erkläre dieses Verfahren", ["Strangpressen", "Verzahnungswalzen"])
    assert ambiguous.confidence < 0.8


def test_calculation_evidence_requires_problem_method_and_units():
    plan = build_question_routing_plan("Berechne die Standzeit.", ["Standzeit"])
    weak = [RetrievedChunk("a", "d", 1, 1, "Standzeit", 1, .8, "definition", None,
                           primary_topic="Standzeit")]
    assert not evidence_is_sufficient(plan, weak)
    complete = [RetrievedChunk("b", "d", 2, 2, "Standzeit: T = 12 s", 1, .8,
                               "worked_example", None, primary_topic="Standzeit")]
    assert evidence_is_sufficient(plan, complete)


def test_staged_executor_keeps_lecture_before_exercise(monkeypatch):
    calls = []
    def fake_retrieve(**kwargs):
        calls.append(kwargs)
        doc_type = kwargs.get("document_types", ("unknown",))[0]
        if doc_type not in {"lecture", "exercise_sheet"}:
            return []
        return [RetrievedChunk(doc_type, doc_type, 1, 1, "Gesenkschmieden definition",
                               0.5 if doc_type == "lecture" else 9.0, .7, "definition", None,
                               document_type=doc_type, retrieval_stage=kwargs["retrieval_stage"],
                               retrieval_reason=kwargs["retrieval_reason"])]
    monkeypatch.setattr("app.services.retrieval.retrieve_chunks", fake_retrieve)
    plan = build_question_routing_plan("Was ist Gesenkschmieden?", ["Gesenkschmieden"])
    chunks = retrieve_routed_chunks(user_id="u", course_id="c", query=plan.original_question,
                                    course_topics=("Gesenkschmieden",), routing_plan=plan)
    assert chunks[0].document_type == "lecture"
    assert calls[0]["primary_topics"] == ("Gesenkschmieden",)


def test_calculation_reserves_one_candidate_from_every_evidence_stage(monkeypatch):
    def fake_retrieve(**kwargs):
        stage = kwargs["retrieval_stage"]
        return [RetrievedChunk(f"c-{stage}-{i}", f"d-{stage}", 1, 1, "T = 12 s",
                               10 - i, .8, "worked_example", None,
                               document_type=kwargs["document_types"][0],
                               retrieval_stage=stage, retrieval_reason=kwargs["retrieval_reason"])
                for i in range(8)]
    monkeypatch.setattr("app.services.retrieval.retrieve_chunks", fake_retrieve)
    plan = build_question_routing_plan("Löse Aufgabe 13.1 und erkläre jeden Schritt.")
    chunks = retrieve_routed_chunks(user_id="u", course_id="c", query=plan.original_question,
                                    course_topics=(), routing_plan=plan, top_k=6)
    assert {1, 2, 3, 4}.issubset({chunk.retrieval_stage for chunk in chunks})
