"""Mocks chat_json (deterministic generation/repair) and verify_semantic
(mocked as a trivial pass for the happy-path tests) for the three Lesen
task types. Confirms lesen_1 never routes semantic item-errors to
repair_items_semantic() (it always regenerates instead — see
german_exam_reading.py's module docstring), while lesen_2/lesen_3 do."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


class _FakeResult:
    def __init__(self, data) -> None:
        self.data = data
        self.model = "stub-model"
        self.prompt_tokens = 10
        self.completion_tokens = 10


def _passing_semantic_result(part, content):
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult

    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content.get("questions") or []]
    return SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)


def _valid_lesen1_content() -> dict:
    gaps = [{"gapId": f"g{i}"} for i in range(1, 7)]
    paragraphs = [f"Absatz {i} mit {{{{g{i}}}}} Lückentext." for i in range(1, 7)]
    candidates = [{"candidateId": f"c{i}", "text": f"Kandidatensatz {i}."} for i in range(1, 9)]
    questions = [
        {"questionId": f"q{i}", "gapId": f"g{i}", "correctCandidateId": f"c{i}",
         "skillTags": ["reference_resolution"], "difficulty": "c1"}
        for i in range(1, 7)
    ]
    return {"text": {"title": "Titel", "paragraphs": paragraphs, "gaps": gaps}, "candidates": candidates, "questions": questions}


def _valid_lesen2_content() -> dict:
    sections = [{"sectionId": chr(ord("a") + i), "text": f"Abschnitt {i}"} for i in range(5)]
    questions = [
        {"questionId": f"q{i+1}", "statement": f"Aussage {i+1}", "correctSectionId": chr(ord("a") + (i % 5)),
         "skillTags": ["author_intention"], "difficulty": "c1"}
        for i in range(6)
    ]
    return {"sections": sections, "questions": questions}


def _valid_lesen3_content() -> dict:
    paragraphs = [{"paragraphId": f"p{i}", "text": f"Absatz {i}"} for i in range(1, 6)]
    answers = ["richtig", "falsch", "nicht_im_text"] * 3 + ["richtig", "falsch"]
    questions = []
    for i in range(11):
        answer = answers[i]
        questions.append({
            "questionId": f"q{i+1}", "kind": "detail", "statement": f"Aussage {i+1}",
            "tristate": {"answer": answer, "evidenceParagraphIds": [] if answer == "nicht_im_text" else ["p1"]},
            "skillTags": ["detail_comprehension"], "difficulty": "c1",
        })
    questions.append({
        "questionId": "q12", "kind": "global_heading",
        "heading": {"options": [{"headingId": "h1", "text": "A"}, {"headingId": "h2", "text": "B"}, {"headingId": "h3", "text": "C"}],
                    "correctHeadingId": "h2"},
        "skillTags": ["global_comprehension"], "difficulty": "c1",
    })
    return {"text": {"title": "Titel", "paragraphs": paragraphs}, "questions": questions}


def test_lesen1_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_lesen1_content()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_1")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["deterministicRepairCount"] == 0
    assert meta["deterministicPassed"] is True
    assert meta["semantic"]["passed"] is True
    assert len(content["text"]["gaps"]) == 6
    assert len(content["candidates"]) == 8


def test_lesen1_semantic_item_error_forces_full_regeneration(monkeypatch: pytest.MonkeyPatch) -> None:
    """A lesen_1 semantic item error must never reach repair_items_semantic()
    — it must trigger a fresh generation call instead."""
    from app.services import german_exam_reading as mod
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
    from app.services.german_exam_profiles import get_profile, get_part

    gen_calls = {"n": 0}

    def _fake_chat_json(**kwargs):
        gen_calls["n"] += 1
        return _FakeResult(_valid_lesen1_content())

    verify_calls = {"n": 0}

    def _fake_verify(part, content):
        verify_calls["n"] += 1
        if verify_calls["n"] == 1:
            items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["questionId"] != "q1"),
                                         issues=[] if q["questionId"] != "q1" else
                                         [SemanticIssue("AMBIGUOUS_MAPPING", "error", "two candidates fit")])
                     for q in content["questions"]]
            return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)
        return _passing_semantic_result(part, content)

    def _fail_if_called(*args, **kwargs):
        raise AssertionError("repair_items_semantic must never be called for lesen_1")

    monkeypatch.setattr(mod, "chat_json", _fake_chat_json)
    monkeypatch.setattr(mod, "verify_semantic", _fake_verify)
    monkeypatch.setattr(mod, "repair_items_semantic", _fail_if_called)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_1")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert gen_calls["n"] >= 2  # first attempt failed semantically, second regenerated
    assert meta["semantic"]["passed"] is True


def test_lesen2_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_lesen2_content()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_2")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["deterministicPassed"] is True
    assert len(content["sections"]) == 5
    assert len(content["questions"]) == 6


def test_lesen2_item_level_semantic_repair_used(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_lesen2_content()))

    verify_calls = {"n": 0}

    def _fake_verify(part, content):
        verify_calls["n"] += 1
        if verify_calls["n"] == 1:
            items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["questionId"] != "q1"),
                                         issues=[] if q["questionId"] != "q1" else
                                         [SemanticIssue("AMBIGUOUS_MAPPING", "error", "two sections fit")])
                     for q in content["questions"]]
            return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)
        return _passing_semantic_result(part, content)

    repair_calls = {"n": 0}

    def _fake_repair(part, content, item_issues):
        repair_calls["n"] += 1
        return content, [{"itemId": iid, "code": "AMBIGUOUS_MAPPING"} for iid in item_issues]

    monkeypatch.setattr(mod, "verify_semantic", _fake_verify)
    monkeypatch.setattr(mod, "repair_items_semantic", _fake_repair)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_2")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert repair_calls["n"] == 1
    assert meta["semantic"]["passed"] is True


def test_lesen3_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_lesen3_content()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_3")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["deterministicPassed"] is True
    details = [q for q in content["questions"] if q["kind"] == "detail"]
    headings = [q for q in content["questions"] if q["kind"] == "global_heading"]
    assert len(details) == 11
    assert len(headings) == 1


def test_persistently_invalid_lesen1_output_raises_after_regeneration_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    # Always return too few gaps — a part-level issue, unrepairable per-item.
    always_broken = {"text": {"title": "x", "paragraphs": ["x"], "gaps": [{"gapId": "g1"}]}, "candidates": [], "questions": []}
    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(always_broken))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "reading", "lesen_1")
    with pytest.raises(mod.ReadingGenerationError):
        mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test topic"})
