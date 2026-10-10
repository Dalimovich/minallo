"""Unit tests for the Phase 1 document study-profile helpers.

Pure functions only — no Supabase, no LLM. They guard the planner's trust
boundary: a malformed/hostile LLM read must degrade to a safe, deterministic
profile and never inject invented topics or out-of-range values.
"""

from __future__ import annotations

from app.services.study_planner import (
    _chunk_digest,
    _coerce_profile,
    _resolve_fallback_role,
)

_DOC = {
    "id": "11111111-1111-1111-1111-111111111111",
    "file_name": "Mechanics_Lecture_03.pdf",
    "page_count": 24,
    "source_type": "lecture",
}


def test_coerce_repairs_invalid_enums_to_safe_defaults():
    raw = {
        "documentRole": "wizardry",          # invalid → fallback role
        "topicsCovered": [
            {"name": "Kinematics", "confidence": "telepathic", "depth": "ultra"},
        ],
        "estimatedStudyMinutes": 9999,        # out of range → clamped
        "recommendedUse": "teleport",         # invalid → role default
        "summary": "Covers kinematics basics.",
    }
    p = _coerce_profile(raw, _DOC, fallback_role="lecture")
    assert p["documentRole"] == "lecture"
    assert p["topicsCovered"][0]["confidence"] == "medium"
    assert p["topicsCovered"][0]["depth"] == "core"
    assert p["estimatedStudyMinutes"] <= 180
    assert p["recommendedUse"] == "learn_first"  # lecture default
    assert p["documentId"] == _DOC["id"]


def test_coerce_non_dict_falls_back_without_inventing_topics():
    # A garbage/empty LLM read must NOT fabricate topics.
    p = _coerce_profile(None, _DOC, fallback_role="exercise")
    assert p["documentRole"] == "exercise"
    assert p["topicsCovered"] == []
    assert p["prerequisites"] == []
    assert 5 <= p["estimatedStudyMinutes"] <= 180


def test_coerce_drops_topics_without_names():
    raw = {"topicsCovered": [{"confidence": "high"}, {"name": "  "}, {"name": "Energy"}]}
    p = _coerce_profile(raw, _DOC, fallback_role="lecture")
    names = [t["name"] for t in p["topicsCovered"]]
    assert names == ["Energy"]


def test_resolve_fallback_role_trusts_explicit_solution_tag():
    doc = {**_DOC, "source_type": "solution"}
    assert _resolve_fallback_role(doc, doc["file_name"], "") == "solution"


def test_resolve_fallback_role_ignores_bare_lecture_default_for_exercise_file():
    # source_type defaults to 'lecture'; an exercise filename must win.
    doc = {"id": "x", "file_name": "EngMec2_Ex2.pdf", "source_type": "lecture"}
    assert _resolve_fallback_role(doc, doc["file_name"], "") == "exercise"


def test_chunk_digest_summarizes_topics():
    chunks = [
        {"primary_topic": "Forces", "page_start": 1, "page_end": 3, "chunk_type": "text"},
        {"primary_topic": "Forces", "page_start": 4, "page_end": 4, "chunk_type": "formula"},
        {"primary_topic": "", "page_start": 9, "page_end": 9, "chunk_type": "text"},
    ]
    digest = _chunk_digest(chunks)
    assert "Forces" in digest
    assert "p.1-4" in digest
    # The empty-topic chunk is ignored.
    assert digest.count("\n") == 0
