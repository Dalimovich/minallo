"""Tests for the shared Document Understanding context (Stage 3)."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services.document_context import (  # noqa: E402
    DocContext,
    build_understanding_prompt_block,
    load_document_understanding,
    understanding_block_for_ids,
)


def _ctx(**kw) -> DocContext:
    base = dict(
        document_id="d", file_name="f.pdf", effective_type="lecture",
        confidence=0.95, low_confidence=False, user_override=False,
    )
    base.update(kw)
    return DocContext(**base)


def test_block_empty_when_no_contexts() -> None:
    assert build_understanding_prompt_block([]) == ""
    assert understanding_block_for_ids([]) == ""
    assert understanding_block_for_ids(None) == ""


def test_block_lists_types_and_exam_rule() -> None:
    block = build_understanding_prompt_block([_ctx(effective_type="exam", confidence=0.95)])
    assert "SELECTED SOURCE TYPES: Exam (high confidence)." in block
    assert "based on one uploaded exam" in block
    assert "do NOT infer broad course predictions" in block


def test_block_solution_rule_present() -> None:
    block = build_understanding_prompt_block([_ctx(effective_type="solution_sheet")])
    assert "explain the REASONING behind the provided solutions" in block
    assert "do NOT treat a solved problem as a fresh unsolved task" in block


def test_block_reference_groups_cheat_and_formula() -> None:
    block = build_understanding_prompt_block([
        _ctx(effective_type="cheat_sheet"),
        _ctx(effective_type="formula_sheet"),
    ])
    # Both map to the same bucket → the reference rule appears exactly once.
    assert block.count("compressed reference material") == 1
    assert "Cheat sheet / Formula sheet" in block


def test_block_user_override_shows_user_set() -> None:
    block = build_understanding_prompt_block([
        _ctx(effective_type="exam", user_override=True, confidence=0.0),
    ])
    assert "Exam (user-set)" in block


def test_low_confidence_guess_becomes_cautious_unknown_rule() -> None:
    block = build_understanding_prompt_block([
        _ctx(effective_type="exam", confidence=0.4, low_confidence=True),
    ])
    # The label still shows exam (low confidence), but the BEHAVIOUR is cautious.
    assert "Exam (low confidence)" in block
    assert "uncertain type" in block
    assert "based on one uploaded exam" not in block


def test_low_confidence_but_user_override_keeps_type_rule() -> None:
    block = build_understanding_prompt_block([
        _ctx(effective_type="exam", confidence=0.4, low_confidence=True, user_override=True),
    ])
    assert "based on one uploaded exam" in block  # override is authoritative


def test_load_resolves_override_then_classifier_then_source() -> None:
    rows = [
        {"id": "d1", "file_name": "a.pdf", "source_type": "lecture",
         "document_type": "exam", "document_type_confidence": 0.9,
         "user_document_type_override": "solution_sheet",
         "document_understanding": {"detected_language": "de"}},
        {"id": "d2", "file_name": "b.pdf", "source_type": "lecture",
         "document_type": "unknown", "document_type_confidence": 0.0,
         "user_document_type_override": None, "document_understanding": {}},
    ]
    sb = MagicMock()
    sb.table.return_value.select.return_value.in_.return_value.eq.return_value.execute.return_value.data = rows
    sb.table.return_value.select.return_value.in_.return_value.execute.return_value.data = rows
    with patch("app.services.document_context.get_supabase", return_value=sb):
        ctxs = load_document_understanding(["d1", "d2"], user_id="u1")
    assert ctxs["d1"].effective_type == "solution_sheet"  # override wins
    assert ctxs["d1"].user_override is True
    assert ctxs["d1"].detected_language == "de"
    assert ctxs["d2"].effective_type == "lecture"  # classifier 'unknown' → source_type


def test_load_empty_ids_returns_empty() -> None:
    assert load_document_understanding([]) == {}
    assert load_document_understanding(None) == {}
