"""Mocks chat_json (deterministic generation/repair) and verify_semantic
(mocked as a trivial pass for the happy-path tests) for Sprachbausteine
(cloze_mc4_language_elements). Confirms item-level semantic errors DO route
to repair_items_semantic() here (unlike lesen_1) — a Sprachbausteine defect
always lives entirely inside one item's own options/correctIndex/category."""

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


_CATEGORY_PLAN = ["grammar"] * 14 + ["lexicon"] * 6 + ["orthography"] * 2


def _valid_sprachbausteine_content() -> dict:
    words = ["Wort"] * 40
    paragraphs = []
    gap_n = 1
    for p in range(8):
        para_words = list(words)
        gaps_here = 3 if p < 6 else 2
        for _ in range(gaps_here):
            if gap_n > 22:
                break
            para_words.append(f"{{{{g{gap_n}}}}}")
            gap_n += 1
        paragraphs.append(" ".join(para_words))

    gaps = [{"gapId": f"g{i}"} for i in range(1, 23)]
    questions = []
    for i in range(1, 23):
        category = _CATEGORY_PLAN[i - 1]
        tag = "grammar" if category == "grammar" else ("lexical_choice" if category == "lexicon" else "register")
        questions.append({
            "questionId": f"q{i}", "gapId": f"g{i}",
            "options": [f"opt{i}a", f"opt{i}b", f"opt{i}c", f"opt{i}d"], "correctIndex": 0,
            "category": category, "skillTags": [tag], "difficulty": "c1",
        })
    return {"text": {"title": "Titel", "paragraphs": paragraphs, "gaps": gaps}, "questions": questions}


def test_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_language_elements as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_sprachbausteine_content()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["deterministicRepairCount"] == 0
    assert meta["deterministicPassed"] is True
    assert meta["semantic"]["passed"] is True
    assert len(content["text"]["gaps"]) == 22
    assert len(content["questions"]) == 22


def test_item_level_semantic_repair_used(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unlike lesen_1, a Sprachbausteine item-level semantic error must
    route to repair_items_semantic() — never force a full regeneration."""
    from app.services import german_exam_language_elements as mod
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_sprachbausteine_content()))

    verify_calls = {"n": 0}

    def _fake_verify(part, content):
        verify_calls["n"] += 1
        if verify_calls["n"] == 1:
            items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["questionId"] != "q1"),
                                         issues=[] if q["questionId"] != "q1" else
                                         [SemanticIssue("MULTIPLE_DEFENSIBLE_ANSWERS", "error", "two options fit")])
                     for q in content["questions"]]
            return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)
        return _passing_semantic_result(part, content)

    repair_calls = {"n": 0}

    def _fake_repair(part, content, item_issues):
        repair_calls["n"] += 1
        return content, [{"itemId": iid, "code": "MULTIPLE_DEFENSIBLE_ANSWERS"} for iid in item_issues]

    monkeypatch.setattr(mod, "verify_semantic", _fake_verify)
    monkeypatch.setattr(mod, "repair_items_semantic", _fake_repair)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert repair_calls["n"] == 1
    assert meta["semantic"]["passed"] is True


def test_persistently_invalid_output_raises_after_regeneration_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_language_elements as mod
    from app.services.german_exam_profiles import get_profile, get_part

    # Always return too few gaps — a part-level issue, unrepairable per-item.
    always_broken = {"text": {"title": "x", "paragraphs": ["x"], "gaps": [{"gapId": "g1"}]}, "questions": []}
    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(always_broken))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    with pytest.raises(mod.LanguageElementsGenerationError):
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test topic"})
