"""Shared German Exam Engine — combines the semantic detector
(german_exam_semantic_verify.py) with the targeted HV2/HV3 adjudicator
(german_exam_semantic_adjudicate.py) into verify_semantic_full(), the single
entry point german_exam_listening.py actually calls (imported there bound
to the local name `verify_semantic`, so existing tests that monkeypatch
`listening.verify_semantic` are unaffected by this file's existence). See
both modules' docstrings for why this two-stage design exists (Phase 2.5b's
stability measurement, and why "run the same verifier twice, reject on
either complaint" was explicitly rejected as the fix).
"""

from __future__ import annotations

from typing import Any

from .german_exam_profiles import PartBlueprint
from .german_exam_semantic_adjudicate import adjudicate_items
from .german_exam_semantic_verify import SemanticVerificationResult, verify_semantic


def verify_semantic_full(part: PartBlueprint, content: dict[str, Any]) -> SemanticVerificationResult:
    result = verify_semantic(part, content)

    expected_ids = {q.get("questionId") for q in (content.get("questions") or []) if q.get("questionId")}
    covered = {item.item_id for item in result.items}
    if covered != expected_ids:
        # The detector already failed closed (malformed/incomplete
        # response) — that failure is already correct on its own; a second
        # pass has nothing well-formed to overwrite and would only add
        # cost/latency for no benefit.
        return result

    adjudicated = adjudicate_items(part, content, expected_ids)
    if adjudicated is None:
        return result  # HV1 (or any task_type with no adjudicator) — detector's own result stands, unchanged.

    for item in result.items:
        item.issues = adjudicated.get(item.item_id, item.issues)
        item.passed = not any(issue.severity == "error" for issue in item.issues)
    result.passed = (
        not any(issue.severity == "error" for issue in result.part_wide_issues)
        and all(item.passed for item in result.items)
    )
    return result
