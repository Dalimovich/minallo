"""Structural validation + tamper-detection for the frozen holdout
(tests/fixtures/semantic_blind_ab_holdout.json, 2026-10-23).

The freeze test exists so "never edit expected labels after seeing a
model's output" (the rule the holdout's own "notes" field states) is a
provable, enforced fact, not a promise: if this file's bytes ever change,
this test fails until the hash below is deliberately updated BY SOMEONE
WHO KNOWS WHY -- it cannot pass silently."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOLDOUT_PATH = ROOT / "tests/fixtures/semantic_blind_ab_holdout.json"
DOCUMENTS_PATH = ROOT / "tests/fixtures/semantic_blind_ab_documents.json"

# Recorded 2026-10-24 (updated when the size-caveat note was added --
# see the fixture's own "notes" field). Update ONLY when deliberately
# adding/editing holdout cases BEFORE ever running them against any
# interpreter -- never after seeing a model's mistakes on them.
_FROZEN_SHA256 = "2e0b1259339578296be6f18934c02f785a1d08003488785d5771bd2dd2473f55"

_VALID_FORMS = frozenset({
    "answer_check", "confirmation", "full_solution", "hint",
    "method_explanation", "quiz_start", "summary",
})
_VALID_RELEASES = frozenset({
    "ambiguous_expect_clarify_or_both", "partial", "permitted", "prohibited",
})

_HOLDOUT = json.loads(HOLDOUT_PATH.read_text(encoding="utf-8"))
_DOCUMENTS = json.loads(DOCUMENTS_PATH.read_text(encoding="utf-8"))


def test_frozen_byte_content_is_unchanged():
    actual = hashlib.sha256(HOLDOUT_PATH.read_bytes()).hexdigest()
    assert actual == _FROZEN_SHA256, (
        "semantic_blind_ab_holdout.json's bytes changed since it was frozen. "
        "If this is a deliberate addition written BEFORE running it against "
        "any interpreter, update _FROZEN_SHA256 above. If it is not, revert "
        "the file -- the whole point of a holdout is that it never moves "
        "after seeing a model's answers."
    )


def test_minimum_case_and_turn_coverage():
    assert len(_HOLDOUT["cases"]) >= 10
    total_turns = sum(len(c["turns"]) for c in _HOLDOUT["cases"])
    assert total_turns >= 15


def test_case_ids_are_unique_and_namespaced():
    ids = [c["id"] for c in _HOLDOUT["cases"]]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    assert all(i.startswith("HOLD-") for i in ids), "holdout ids must not collide with the main AB-* corpus"


def test_both_languages_represented():
    languages = {c["language"] for c in _HOLDOUT["cases"]}
    assert languages == {"en", "de"}


def test_multi_turn_and_multi_target_cases_exist():
    assert any(len(c["turns"]) > 1 for c in _HOLDOUT["cases"]), "needs at least one multi-turn scenario"
    assert any(
        len(t["expected"]) > 1 for c in _HOLDOUT["cases"] for t in c["turns"]
    ), "needs at least one multi-target turn"


def test_every_expected_entry_uses_real_enum_values():
    for case in _HOLDOUT["cases"]:
        for turn in case["turns"]:
            for entry in turn["expected"]:
                assert entry["form"] in _VALID_FORMS, f"{case['id']}: unknown form {entry['form']!r}"
                assert entry["release"] in _VALID_RELEASES, f"{case['id']}: unknown release {entry['release']!r}"


def test_every_document_and_target_reference_is_real():
    for case in _HOLDOUT["cases"]:
        document = _DOCUMENTS.get(case["document"])
        assert document is not None, f"{case['id']}: unknown document {case['document']!r}"
        exercises = set((document.get("exercises") or {}).keys())
        sections = {f"section:{s}" for s in (document.get("sections") or {})}
        valid_targets = exercises | sections | {"document"}
        for turn in case["turns"]:
            for entry in turn["expected"]:
                assert str(entry["target"]) in valid_targets, (
                    f"{case['id']}: target {entry['target']!r} not in {sorted(valid_targets)}"
                )
