"""TestDaF Lesen 7 (reading_summary_error_detection, 'Fehler in Zusammenfassung erkennen') —
offline: fixtures only, no provider calls. Official source: testdaf.de demo PDF p.14 (task
instructions: text + graphic source, summary sentences out of source order, click the wrong
ones) and p.36 (solution key: a 9-sentence summary with 3 highlighted/wrong sentences).

Covers: generation (sources + summary sentences + correctIds), the deterministic validator
(including reuse of validate_graphic, never a duplicate graphic check), the semantic verifier
registration, and profile/task-type-registry integration."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


PID = "testdaf_digital"


class _FakeResult:
    def __init__(self, data) -> None:
        self.data = data
        self.model = "stub-model"
        self.prompt_tokens = 10
        self.completion_tokens = 10


def _graphic() -> dict:
    return {"title": "Haustierkosten", "unit": "Euro", "columns": [{"id": "c1", "label": "Jahr"}],
            "rows": [{"id": "r1", "label": "2024", "values": {"c1": 500}}, {"id": "r2", "label": "2025", "values": {"c1": 600}}]}


def _raw_generation() -> dict:
    sentences = [f"Satz {i} der Zusammenfassung mit eigenem Inhalt." for i in range(1, 10)]
    return {
        "sources": [
            {"id": "s1", "kind": "text", "text": "Ein langer Lesetext über Haustiere und ihre medizinische Versorgung " * 5},
            {"id": "s2", "kind": "graphic", "graphic": _graphic()},
        ],
        "questions": [{"questionId": f"sent{i+1}", "text": t} for i, t in enumerate(sentences)],
        "correctIds": ["sent2", "sent5", "sent8"],
    }


def _passing_semantic_result(part, content):
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult

    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content.get("questions") or []]
    return SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)


# ── profile / task-type registry integration ─────────────────────────────────


def test_lesen7_is_reading_summary_error_detection_and_now_implemented() -> None:
    from app.services.german_exams import get_part
    from app.services.german_exams.task_types import is_task_type_implemented

    part = get_part(PID, "reading", "lesen_7")
    assert part.task_type == "reading_summary_error_detection"
    assert is_task_type_implemented("reading_summary_error_detection") is True
    assert part.available is False  # engine capability only, never a release decision
    assert part.constraints["itemCount"] == 3
    assert set(part.constraints["requiredSourceKinds"]) == {"text", "graphic"}


def test_reading_summary_error_detection_registered_in_every_dispatch_table() -> None:
    from app.services.german_exam_reading import _PROMPT_BUILDERS
    from app.services.german_exam_validator import VALIDATORS
    from app.services.german_exam_semantic_verify import _VERIFY_PROMPT_BUILDERS

    assert "reading_summary_error_detection" in _PROMPT_BUILDERS
    assert "reading_summary_error_detection" in VALIDATORS
    assert "reading_summary_error_detection" in _VERIFY_PROMPT_BUILDERS


# ── generation ─────────────────────────────────────────────────────────────


def test_generation_produces_sources_summary_and_correct_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_raw_generation()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_7")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Haustiere"})

    assert meta["deterministicPassed"] is True
    assert len(content["sources"]) == 2
    assert {s["kind"] for s in content["sources"]} == {"text", "graphic"}
    assert len(content["questions"]) == 9
    assert content["correctIds"] == ["sent2", "sent5", "sent8"]
    for q in content["questions"]:
        assert q["skillTags"] == ["detail_comprehension"]


def test_regeneration_budget_is_exhausted_on_missing_graphic_source(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    broken = _raw_generation()
    broken["sources"] = [s for s in broken["sources"] if s["kind"] != "graphic"]
    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(broken))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_7")
    with pytest.raises(mod.ReadingGenerationError):
        mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test"})


# ── deterministic validator ───────────────────────────────────────────────────


def _valid_content() -> dict:
    content = _raw_generation()
    content["questions"] = [{**q, "skillTags": ["detail_comprehension"]} for q in content["questions"]]
    return content


def test_validator_accepts_well_formed_content() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    assert hard_issues(validate_content(part, _valid_content())) == []


def test_validator_rejects_missing_required_source_kind() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    c["sources"] = [s for s in c["sources"] if s["kind"] != "graphic"]
    assert any("missing required source kind" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_reuses_validate_graphic_for_an_invalid_graphic() -> None:
    """The graphic shape check must come from validate_graphic (german_exam_productive.py), not a
    second, parallel implementation — this malformed graphic (row values missing a column) is
    exactly what validate_graphic itself rejects."""
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    for s in c["sources"]:
        if s["kind"] == "graphic":
            s["graphic"]["rows"][0]["values"] = {}
    assert any("invalid graphic source" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_too_few_summary_sentences() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    c["questions"] = c["questions"][:3]  # itemCount (3) wrong ones need at least one correct sentence too
    assert any("multi-sentence summary" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_wrong_correct_ids_count() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    c["correctIds"] = ["sent2", "sent5"]  # only 2, itemCount is 3
    assert any("correctIds must name exactly 3" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_correct_ids_not_among_the_summary_sentences() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    c["correctIds"] = ["sent2", "sent5", "sent_unknown"]
    assert any("correctIds must name exactly 3" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_missing_skill_tags() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    c = _valid_content()
    c["questions"][0]["skillTags"] = []
    assert any("skillTags must be non-empty" in i.message for i in hard_issues(validate_content(part, c)))


# ── semantic audit wiring ──────────────────────────────────────────────────


def test_apply_audits_flags_mismatch_between_verifier_verdict_and_the_key() -> None:
    from app.services.german_exam_semantic_verify import SemanticIssue, SemanticVerificationResult, ItemSemanticResult, _apply_audits
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_7")
    content = _valid_content()
    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content["questions"]]
    result = SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)
    # The verifier says sent1 IS erroneous, but correctIds says it is NOT (sent1 not in correctIds).
    data = {"items": [
        {"questionId": q["questionId"], "audit": {"isErroneous": q["questionId"] == "sent1"}, "passed": True, "issues": []}
        for q in content["questions"]
    ]}
    final = _apply_audits(result, data, part, content)
    sent1 = next(i for i in final.items if i.item_id == "sent1")
    assert any(issue.code == "TRISTATE_VERDICT_MISMATCH" for issue in sent1.issues)
    assert sent1.passed is False
    assert final.passed is False
