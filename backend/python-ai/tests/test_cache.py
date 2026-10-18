"""ai_answer_cache hashing helpers — deterministic, no network."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def test_question_hash_normalises_whitespace_and_case() -> None:
    from app.services.cache import question_hash

    a = question_hash("  What IS  Newton's  second law? ")
    b = question_hash("what is newton's second law?")
    assert a == b


def test_question_hash_changes_with_wording() -> None:
    from app.services.cache import question_hash

    assert question_hash("Define velocity") != question_hash("Define acceleration")


def test_question_hash_changes_with_source_scope() -> None:
    from app.services.cache import question_hash

    course = question_hash(
        "Define velocity",
        source_mode="course_files",
        source_scope="course_files",
    )
    internet = question_hash(
        "Define velocity",
        source_mode="internet",
        source_scope="internet",
    )

    assert course != internet


def test_question_hash_changes_with_selected_documents() -> None:
    from app.services.cache import question_hash

    doc_a = question_hash(
        "Define velocity",
        source_mode="course_files",
        source_scope="course_files",
        selected_document_ids=["doc_a"],
    )
    doc_b = question_hash(
        "Define velocity",
        source_mode="course_files",
        source_scope="course_files",
        selected_document_ids=["doc_b"],
    )

    assert doc_a != doc_b


def test_question_hash_scopes_visible_page_language_revision_and_region() -> None:
    from app.services.cache import question_hash

    base = question_hash(
        "Explain this",
        visible_page=11,
        response_language="en",
        viewer_revision="rev-a",
        selected_region_fingerprint='{"x":0.1}',
        grounding_mode="strict-course-files",
    )
    assert base != question_hash(
        "Explain this",
        visible_page=12,
        response_language="en",
        viewer_revision="rev-a",
        selected_region_fingerprint='{"x":0.1}',
        grounding_mode="strict-course-files",
    )
    assert base != question_hash(
        "Explain this",
        visible_page=11,
        response_language="de",
        viewer_revision="rev-a",
        selected_region_fingerprint='{"x":0.1}',
        grounding_mode="strict-course-files",
    )
    assert base != question_hash(
        "Explain this",
        visible_page=11,
        response_language="en",
        viewer_revision="rev-b",
        selected_region_fingerprint='{"x":0.1}',
        grounding_mode="strict-course-files",
    )


def test_cache_identity_includes_generation_and_pipeline_versions() -> None:
    from app.services.cache import question_hash

    base = question_hash(
        "continue",
        conversation_generation=4,
        model_version="gpt-model-a",
    )
    assert base != question_hash(
        "continue",
        conversation_generation=5,
        model_version="gpt-model-a",
    )
    assert base != question_hash(
        "continue",
        conversation_generation=4,
        model_version="gpt-model-b",
    )
    assert base != question_hash(
        "continue",
        conversation_generation=4,
        model_version="gpt-model-a",
        validator_version="future-validator",
    )


# ── PR3: intent_fingerprint cache isolation ─────────────────────────────────
# off/shadow always compute "" (student_intent.intent_constraints_fingerprint
# is mode-gated) — these tests confirm that produces byte-identical cache
# keys to pre-PR3 behavior (no mass invalidation), while a non-empty,
# enabled-mode fingerprint produces a genuinely distinct key.


def test_question_hash_unaffected_by_empty_intent_fingerprint() -> None:
    """off/shadow's "" must match both a caller that omits the kwarg
    entirely (existing cache rows) and one that passes intent_fingerprint=""
    explicitly."""
    from app.services.cache import question_hash

    omitted = question_hash("Explain torsion")
    empty = question_hash("Explain torsion", intent_fingerprint="")
    none_value = question_hash("Explain torsion", intent_fingerprint=None)
    assert omitted == empty == none_value


def test_question_hash_separates_enabled_mode_intent_fingerprint() -> None:
    """A non-empty (enabled-mode) fingerprint must never collide with the
    off/shadow "" partition, nor with another distinct fingerprint."""
    from app.services.cache import question_hash

    base = question_hash("Explain torsion")
    withheld = question_hash("Explain torsion", intent_fingerprint="intent:v1:w1h0o0")
    hint_only = question_hash("Explain torsion", intent_fingerprint="intent:v1:w0h1o0")
    assert base != withheld
    assert base != hint_only
    assert withheld != hint_only


def test_question_hash_lookup_and_save_kwargs_must_match_to_produce_same_key() -> None:
    """Simulates the lookup/save symmetry contract: identical kwargs (as a
    single cache_key_kwargs dict would enforce) produce the same key;
    mismatched intent_fingerprint values (a symmetry bug) do not."""
    from app.services.cache import question_hash

    lookup_kwargs = {"tutor_mode": "explain", "intent_fingerprint": "intent:v1:w1h0o0"}
    save_kwargs_matching = {"tutor_mode": "explain", "intent_fingerprint": "intent:v1:w1h0o0"}
    save_kwargs_mismatched = {"tutor_mode": "explain", "intent_fingerprint": "intent:v1:w0h0o0"}
    question = "Quiz me but hide the answer"
    assert question_hash(question, **lookup_kwargs) == question_hash(question, **save_kwargs_matching)
    assert question_hash(question, **lookup_kwargs) != question_hash(question, **save_kwargs_mismatched)


def test_document_version_hash_is_order_independent() -> None:
    from app.services.cache import document_version_hash

    h1 = document_version_hash(["abc", "def", "ghi"])
    h2 = document_version_hash(["ghi", "abc", "def"])
    assert h1 == h2


def test_document_version_hash_ignores_nulls() -> None:
    from app.services.cache import document_version_hash

    h1 = document_version_hash(["abc", None, "def"])
    h2 = document_version_hash(["abc", "def"])
    assert h1 == h2


def test_document_version_hash_changes_when_a_doc_changes() -> None:
    from app.services.cache import document_version_hash

    h1 = document_version_hash(["abc", "def"])
    h2 = document_version_hash(["abc", "def-v2"])
    assert h1 != h2
