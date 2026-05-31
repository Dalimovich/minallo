"""Phase 8 — ranking boosts/penalties. Pure-Python tests on `_study_score`
and `_apply_neighbour_boost`. Stubs supabase + embeddings before import."""

from __future__ import annotations

import sys
import types

import pytest


def _import_retrieval():
    fake_sb = types.ModuleType("app.supabase_client")
    fake_sb.get_supabase = lambda: None
    sys.modules.setdefault("app.supabase_client", fake_sb)
    fake_emb = types.ModuleType("app.services.embeddings")
    fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
    sys.modules.setdefault("app.services.embeddings", fake_emb)
    if "app.services.retrieval" in sys.modules:
        del sys.modules["app.services.retrieval"]
    from app.services import retrieval  # noqa: WPS433
    return retrieval


def _chunk(text="The bending moment formula is M = F*l.", **overrides):
    base = {
        "id": "c1",
        "document_id": "DOC1",
        "page_start": 5,
        "page_end": 5,
        "chunk_text": text,
        "section_title": None,
        "source_type": "lecture",
        "similarity": 0.5,
        "is_official": False,
    }
    base.update(overrides)
    return base


# ── infer_question_intent ───────────────────────────────────────────────────


@pytest.mark.parametrize("q, expected", [
    ("Lösung von Aufgabe 1", "solution_sheet"),
    ("Solve Exercise 3", "exercise_sheet"),
    ("Aufgabe 1.2", "exercise_sheet"),
    ("What's the formula for shear force", "formula_sheet"),
    ("Klausur Sommer 2023", "exam"),
    ("Summary of chapter 5", "summary"),
    ("Recap of the lecture", "summary"),
    ("Random unrelated question", None),
])
def test_infer_question_intent(q, expected):
    r = _import_retrieval()
    assert r.infer_question_intent(q) == expected


# ── individual boosts/penalties ─────────────────────────────────────────────


def test_exercise_number_match_boost():
    r = _import_retrieval()
    base = r._study_score(_chunk(text="Some unrelated discussion."))
    with_match = r._study_score(
        _chunk(text="Aufgabe 1.2 — Berechne die Kraft."),
        exercise_number="1.2",
        query_tokens={"aufgabe", "berechne"},
    )
    assert with_match > base


def test_doc_type_match_boost():
    r = _import_retrieval()
    meta = {"DOC1": {"document_type": "exercise_sheet", "file_name": "anon.pdf"}}
    base = r._study_score(_chunk(), question_intent="exercise_sheet")
    with_meta = r._study_score(_chunk(), question_intent="exercise_sheet", doc_meta=meta)
    assert with_meta > base


def test_doc_type_mismatch_no_boost():
    r = _import_retrieval()
    meta = {"DOC1": {"document_type": "lecture", "file_name": "anon.pdf"}}
    no_boost = r._study_score(
        _chunk(),
        question_intent="exercise_sheet",
        query_is_math=False,
        doc_meta=meta,
    )
    base = r._study_score(_chunk(), question_intent=None)
    assert abs(no_boost - base) < 1e-9


def test_exercise_math_boosts_lecture_reference_chunks():
    r = _import_retrieval()
    meta = {"DOC1": {"document_type": "lecture", "file_name": "Vorlesung Schrauben.pdf"}}
    base = r._study_score(
        _chunk(source_type="lecture"),
        question_intent="exercise_sheet",
        query_is_math=False,
        doc_meta=meta,
    )
    boosted = r._study_score(
        _chunk(source_type="lecture"),
        question_intent="exercise_sheet",
        query_is_math=True,
        doc_meta=meta,
    )
    assert boosted > base


def test_conceptual_explanation_prefers_lecture_over_solution():
    r = _import_retrieval()
    q = "Explain in detail for an engineering student why we square and sum the equations"
    assert r.is_conceptual_explanation_query(q)

    lecture_meta = {"DOC1": {"document_type": "lecture", "file_name": "Vorlesung 04.pdf"}}
    solution_meta = {"DOC1": {"document_type": "solution_sheet", "file_name": "Seminar_04_Solutions.pdf"}}
    text = "Eliminate the angle alpha by squaring x and z and summing the equations."

    lecture_score = r._study_score(
        _chunk(text=text, source_type="lecture"),
        conceptual_explanation=True,
        doc_meta=lecture_meta,
    )
    solution_score = r._study_score(
        _chunk(text=text, source_type="solution"),
        conceptual_explanation=True,
        doc_meta=solution_meta,
    )

    assert lecture_score > solution_score


def test_conceptual_reference_mix_keeps_lecture_source():
    r = _import_retrieval()
    ranked = [
        (3.0, _chunk(id="sol1", document_id="SOL", source_type="solution", similarity=0.9)),
        (2.9, _chunk(id="sol2", document_id="SOL", source_type="solution", similarity=0.8)),
        (2.1, _chunk(id="lec1", document_id="LEC", source_type="lecture", similarity=0.6)),
    ]
    meta = {
        "SOL": {"document_type": "solution_sheet", "file_name": "Seminar_04_Solutions.pdf"},
        "LEC": {"document_type": "lecture", "file_name": "Vorlesung 04.pdf"},
    }

    chosen = r._ensure_professor_reference_mix(
        ranked,
        top_k=2,
        doc_meta=meta,
        query_is_math=False,
        question_intent=None,
        conceptual_explanation=True,
    )

    chosen_docs = {row["document_id"] for _, row in chosen}
    assert "LEC" in chosen_docs


def test_unit_match_boost():
    r = _import_retrieval()
    score_no = r._study_score(_chunk(text="A long prose paragraph about beams."))
    score_yes = r._study_score(
        _chunk(text="The bending moment is M = 100 N·m on a 0.5 m beam."),
        query_units={"n", "m"},
    )
    assert score_yes > score_no


def test_filename_match_boost():
    r = _import_retrieval()
    meta = {"DOC1": {"document_type": None, "file_name": "Bending_Moment_Lecture.pdf"}}
    base = r._study_score(_chunk(), query_tokens={"bending"})
    boosted = r._study_score(_chunk(), query_tokens={"bending"}, doc_meta=meta)
    assert boosted > base


def test_generic_chunk_penalty():
    r = _import_retrieval()
    base = r._study_score(_chunk(text="A long-enough prose paragraph about beams and forces."))
    generic = r._study_score(_chunk(text="abc"))
    assert generic < base


def test_no_query_term_penalty():
    r = _import_retrieval()
    # Chunk shares no meaningful token with the query → penalised.
    penalised = r._study_score(
        _chunk(text="completely unrelated content about painting techniques."),
        query_tokens={"bending", "moment"},
    )
    base = r._study_score(_chunk(text="completely unrelated content about painting techniques."))
    assert penalised < base


def test_query_term_overlap_avoids_penalty():
    r = _import_retrieval()
    # Same query, but the chunk DOES mention "bending" — no penalty.
    no_penalty = r._study_score(
        _chunk(text="The bending moment is large at the fixed support."),
        query_tokens={"bending", "moment"},
    )
    base = r._study_score(_chunk(text="The bending moment is large at the fixed support."))
    # The two should be (approximately) equal — no penalty applied.
    assert abs(no_penalty - base) < 1e-9


# ── neighbour boost ─────────────────────────────────────────────────────────


def test_neighbour_boost_lifts_adjacent_page():
    r = _import_retrieval()
    # Top-scoring anchor on page 5 should boost a candidate on page 4 or 6
    # of the same document.
    ranked = [
        (2.0, _chunk(page_start=5, page_end=5, document_id="DOC1")),  # anchor
        (1.0, _chunk(page_start=6, page_end=6, document_id="DOC1")),  # neighbour
        (1.0, _chunk(page_start=20, page_end=20, document_id="DOC1")),  # not neighbour
    ]
    boosted = r._apply_neighbour_boost(ranked, top_n=1)
    # Order is sorted descending; neighbour should now be > the far chunk.
    scores_by_page = {row["page_start"]: score for score, row in boosted}
    assert scores_by_page[6] > scores_by_page[20]


def test_neighbour_boost_skips_other_docs():
    r = _import_retrieval()
    ranked = [
        (2.0, _chunk(page_start=5, document_id="DOC1")),
        (1.0, _chunk(page_start=6, document_id="DOC2")),  # adjacent page but other doc
    ]
    boosted = r._apply_neighbour_boost(ranked, top_n=1)
    # The DOC2 chunk score should be unchanged.
    other_doc_score = [s for s, row in boosted if row["document_id"] == "DOC2"][0]
    assert other_doc_score == 1.0


def test_neighbour_boost_handles_empty():
    r = _import_retrieval()
    assert r._apply_neighbour_boost([]) == []


# ── professor reference mix ─────────────────────────────────────────────────


def test_exercise_context_keeps_lecture_and_formula_sources():
    r = _import_retrieval()
    ranked = [
        (3.0, _chunk(id="ex1", document_id="EX", source_type="exercise", similarity=0.9)),
        (2.9, _chunk(id="ex2", document_id="EX", source_type="exercise", similarity=0.8)),
        (2.8, _chunk(id="ex3", document_id="EX", source_type="exercise", similarity=0.7)),
        (2.1, _chunk(id="lec1", document_id="LEC", source_type="lecture", similarity=0.6)),
        (2.0, _chunk(id="form1", document_id="FORM", source_type="other", similarity=0.5)),
    ]
    meta = {
        "EX": {"document_type": "exercise_sheet", "file_name": "AG_9.pdf"},
        "LEC": {"document_type": "lecture", "file_name": "Vorlesung Schrauben.pdf"},
        "FORM": {"document_type": "formula_sheet", "file_name": "Formelzettel.pdf"},
    }

    chosen = r._ensure_professor_reference_mix(
        ranked,
        top_k=3,
        doc_meta=meta,
        query_is_math=True,
        question_intent="exercise_sheet",
    )

    chosen_docs = {row["document_id"] for _, row in chosen}
    assert "EX" in chosen_docs
    assert "LEC" in chosen_docs
    assert "FORM" in chosen_docs


# ── _meaningful_tokens ──────────────────────────────────────────────────────


def test_meaningful_tokens_filters_stopwords_and_short_tokens():
    r = _import_retrieval()
    tokens = r._meaningful_tokens("What is the bending moment of a beam?")
    assert "bending" in tokens
    assert "moment" in tokens
    assert "beam" in tokens
    assert "the" not in tokens
    assert "is" not in tokens


def test_meaningful_tokens_handles_german_umlauts():
    r = _import_retrieval()
    tokens = r._meaningful_tokens("Berechne die Lösung für Aufgabe")
    assert "lösung" in tokens or "lÖsung" not in tokens  # umlaut preserved, lowercased
    assert "aufgabe" in tokens
    assert "die" not in tokens
