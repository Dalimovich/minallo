"""Tests for Phase 6 retrieval additions: active-doc boost, extraction-quality
penalty, and the exercise-reference detector. These are the pure-Python pieces
of services/retrieval.py that don't require a live Supabase connection.
"""

from __future__ import annotations

import sys
import types

import pytest

# These tests intentionally avoid importing the full retrieval module
# (it pulls in `supabase` which isn't installed in the local venv). Instead
# we import the studyable internals via a thin shim that patches out the
# `supabase_client` and `embeddings` modules before import.


def _import_retrieval():
    """Patch missing deps then import the module fresh."""
    # Stub supabase_client.
    fake_sb = types.ModuleType("app.supabase_client")
    fake_sb.get_supabase = lambda: None
    sys.modules.setdefault("app.supabase_client", fake_sb)
    # Stub embeddings (only embed_texts is used at call time).
    fake_emb = types.ModuleType("app.services.embeddings")
    fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
    sys.modules.setdefault("app.services.embeddings", fake_emb)
    if "app.services.retrieval" in sys.modules:
        del sys.modules["app.services.retrieval"]
    from app.services import retrieval  # noqa: WPS433
    return retrieval


# ── Exercise reference detection ────────────────────────────────────────────


def test_finds_aufgabe_with_number():
    r = _import_retrieval()
    assert r.find_exercise_reference("Solve Aufgabe 1.2 please") == ("1.2", None)


def test_finds_exercise_with_subpart():
    r = _import_retrieval()
    assert r.find_exercise_reference("Help me with Exercise 3.1 (a)") == ("3.1", "a")


def test_finds_problem_keyword():
    r = _import_retrieval()
    assert r.find_exercise_reference("Problem 4 derivation") == ("4", None)


def test_finds_uebung_german_keyword():
    r = _import_retrieval()
    assert r.find_exercise_reference("Übung 2.3 angeordnet?") == ("2.3", None)


def test_finds_beispiel_keyword():
    r = _import_retrieval()
    assert r.find_exercise_reference("Beispiel 5.1 zur Übung") == ("5.1", None)


def test_no_match_on_plain_question():
    r = _import_retrieval()
    assert r.find_exercise_reference("What is Newton's second law?") is None


def test_no_match_on_bare_number():
    r = _import_retrieval()
    # "1.2" without an exercise keyword in front must NOT match — otherwise
    # every paragraph reference would short-circuit retrieval.
    assert r.find_exercise_reference("See section 1.2 for context.") is None


def test_empty_query_returns_none():
    r = _import_retrieval()
    assert r.find_exercise_reference("") is None


def test_formula_intent_recognises_mechanical_engineering_terms():
    r = _import_retrieval()
    tokens = r.find_formula_intent("Berechnen Sie die Nachgiebigkeit der Schraube")
    assert "nachgiebigkeit" in tokens
    assert "schraube" in tokens


def test_formula_intent_still_ignores_plain_chat():
    r = _import_retrieval()
    assert r.find_formula_intent("Kannst du das bitte einfacher erklären?") == set()


def test_subpart_normalised_to_lowercase():
    r = _import_retrieval()
    assert r.find_exercise_reference("Aufgabe 7.1 B") == ("7.1", "b")


# ── _study_score with the Phase 6 additions ─────────────────────────────────


def _chunk(text="body", source="lecture", page=1, doc_id="DOC1", similarity=0.5):
    return {
        "id": "id-" + str(page),
        "document_id": doc_id,
        "chunk_text": text,
        "source_type": source,
        "is_official": False,
        "similarity": similarity,
        "section_title": None,
        "page_start": page,
    }


def test_active_doc_boost_lifts_score():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOC1"))
    boosted = r._study_score(_chunk(doc_id="DOC1"), active_document_id="DOC1")
    assert boosted > base
    assert boosted - base == pytest.approx(r._ACTIVE_DOC_BOOST)


def test_active_doc_boost_only_applies_to_matching_doc():
    r = _import_retrieval()
    score = r._study_score(_chunk(doc_id="DOC2"), active_document_id="DOC1")
    base = r._study_score(_chunk(doc_id="DOC2"))
    assert score == base


def test_preferred_doc_set_adds_boost():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOCx"))
    boosted = r._study_score(_chunk(doc_id="DOCx"), preferred_document_ids={"DOCx"})
    assert boosted - base == pytest.approx(r._PREFERRED_DOC_BOOST)


def test_active_and_preferred_stack():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOC1"))
    both = r._study_score(
        _chunk(doc_id="DOC1"),
        active_document_id="DOC1",
        preferred_document_ids={"DOC1"},
    )
    assert both - base == pytest.approx(r._ACTIVE_DOC_BOOST + r._PREFERRED_DOC_BOOST)


def test_weak_extraction_quality_penalty():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOC1", page=3))
    penalised = r._study_score(
        _chunk(doc_id="DOC1", page=3),
        quality_by_doc_page={("DOC1", 3): "weak"},
    )
    assert base - penalised == pytest.approx(r._QUALITY_PENALTY_WEAK)


def test_failed_extraction_quality_penalty():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOC1", page=3))
    penalised = r._study_score(
        _chunk(doc_id="DOC1", page=3),
        quality_by_doc_page={("DOC1", 3): "failed"},
    )
    assert base - penalised == pytest.approx(r._QUALITY_PENALTY_FAILED)


def test_good_quality_no_penalty():
    r = _import_retrieval()
    base = r._study_score(_chunk(doc_id="DOC1", page=3))
    same = r._study_score(
        _chunk(doc_id="DOC1", page=3),
        quality_by_doc_page={("DOC1", 3): "good"},
    )
    assert base == same


def test_quality_penalty_skipped_when_page_missing():
    r = _import_retrieval()
    chunk = _chunk(doc_id="DOC1")
    chunk["page_start"] = None
    base = r._study_score(_chunk(doc_id="DOC1"))  # equivalent without page lookup
    same = r._study_score(chunk, quality_by_doc_page={("DOC1", 1): "weak"})
    # No page → no penalty applied
    assert same == base
