"""TestDaF Lesen 2 (paragraph_ordering, 'Textabschnitte ordnen') — offline: fixtures only, no
provider calls. Official source: testdaf.de demo PDF p.6 (task instructions, 5 standalone
paragraphs, no distractor) and p.35 (solution key confirms all 5 are used, one correct order).

Covers: generation (model writes paragraphs in correct order; backend assigns ids, records
correctOrder, shuffles display order — never the model's job), the deterministic validator,
the semantic verifier prompt registration, and profile/task-type-registry integration."""

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


_PARAGRAPHS_IN_ORDER = [
    "Kaum eine menschliche Fertigkeit ist so komplex wie die Sprachbeherrschung.",
    "Auch beim Sprechen fasst das Gehirn rasend schnell die Sprechabsicht in Worte.",
    "Wie anfällig dieser Prozess ist, erleben wir fast täglich im Alltag.",
    "Treten Versprecher häufig auf, liegt wahrscheinlich eine Sprechstörung vor.",
    "Die möglichen Folgen reichen von Angst bis hin zu sozialer Vereinsamung.",
]


def _passing_semantic_result(part, content):
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult

    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content.get("questions") or []]
    return SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)


# ── profile / task-type registry integration ─────────────────────────────────


def test_lesen2_is_paragraph_ordering_and_now_implemented() -> None:
    from app.services.german_exams import get_part
    from app.services.german_exams.task_types import is_task_type_implemented

    part = get_part(PID, "reading", "lesen_2")
    assert part.task_type == "paragraph_ordering"
    assert is_task_type_implemented("paragraph_ordering") is True
    assert part.available is False  # engine capability only, never a release decision
    assert part.constraints["itemCount"] == 5


def test_paragraph_ordering_registered_in_every_dispatch_table() -> None:
    from app.services.german_exam_reading import _PROMPT_BUILDERS
    from app.services.german_exam_validator import VALIDATORS
    from app.services.german_exam_semantic_verify import _VERIFY_PROMPT_BUILDERS

    assert "paragraph_ordering" in _PROMPT_BUILDERS
    assert "paragraph_ordering" in VALIDATORS
    assert "paragraph_ordering" in _VERIFY_PROMPT_BUILDERS


# ── generation: model writes order, backend owns ids/shuffle/answer key ──────


def test_generation_produces_five_questions_and_a_matching_correct_order(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult({"paragraphs": list(_PARAGRAPHS_IN_ORDER)}))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_2")
    content, meta = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Sprachstörungen"})

    assert meta["deterministicPassed"] is True
    assert len(content["questions"]) == 5
    ids = {q["questionId"] for q in content["questions"]}
    assert ids == {"p1", "p2", "p3", "p4", "p5"}
    assert set(content["correctOrder"]) == ids
    assert len(content["correctOrder"]) == 5

    # correctOrder reconstructs the model's original (correct) writing order.
    by_id = {q["questionId"]: q["text"] for q in content["questions"]}
    restored = [by_id[qid] for qid in content["correctOrder"]]
    assert restored == _PARAGRAPHS_IN_ORDER


def test_every_question_carries_an_allowed_skill_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult({"paragraphs": list(_PARAGRAPHS_IN_ORDER)}))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_2")
    content, _ = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test"})

    for q in content["questions"]:
        assert q["skillTags"], q
        assert set(q["skillTags"]) <= set(part.allowed_skill_tags)


def test_display_order_is_shuffled_and_deterministic_for_the_same_content(monkeypatch: pytest.MonkeyPatch) -> None:
    """The model's writing order must never leak as the displayed order (the learner would be able
    to read the answer off the delivery order) — same seeded-shuffle discipline as
    shuffle_candidates() for telc. Re-running the exact same generated paragraphs must reshuffle
    to the exact same display order (seeded from content, not from wall-clock randomness)."""
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult({"paragraphs": list(_PARAGRAPHS_IN_ORDER)}))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_2")
    content_a, _ = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test"})
    content_b, _ = mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test"})

    display_order_a = [q["questionId"] for q in content_a["questions"]]
    display_order_b = [q["questionId"] for q in content_b["questions"]]
    assert display_order_a == display_order_b  # deterministic given identical paragraph content
    assert display_order_a != content_a["correctOrder"]  # genuinely shuffled, not accidentally in order


def test_regeneration_budget_is_exhausted_on_persistently_wrong_item_count(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_reading as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult({"paragraphs": _PARAGRAPHS_IN_ORDER[:3]}))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile(PID)
    part = get_part(PID, "reading", "lesen_2")
    with pytest.raises(mod.ReadingGenerationError):
        mod.generate_reading_part(profile, part, [], {"topicId": "t", "label": "Test"})


# ── deterministic validator ───────────────────────────────────────────────────


def _valid_content() -> dict:
    questions = [{"questionId": f"p{i+1}", "text": f"Absatz Nummer {i+1} mit eigenem Inhalt.", "skillTags": ["text_structure"]} for i in range(5)]
    return {"questions": questions, "correctOrder": [q["questionId"] for q in questions]}


def test_validator_accepts_well_formed_content() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    assert hard_issues(validate_content(part, _valid_content())) == []


def test_validator_rejects_wrong_item_count() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["questions"] = c["questions"][:4]
    assert any("expected 5 paragraphs" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_duplicate_paragraph_text() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["questions"][1]["text"] = c["questions"][0]["text"]
    assert any("duplicate paragraph text" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_duplicate_ids_via_the_shared_generic_precheck() -> None:
    """validate_content()'s generic pre-check (shared by every task type with a `questions` array)
    catches duplicate questionIds before paragraph_ordering's own validator even runs — this test
    documents that paragraph_ordering relies on it rather than duplicating the check."""
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["questions"][1]["questionId"] = c["questions"][0]["questionId"]
    assert any("duplicate questionId" in i.message for i in hard_issues(validate_content(part, c)))


@pytest.mark.parametrize("leaked", ["[1] Ein Absatz.", "1. Ein Absatz.", "1) Ein Absatz.", "(1) Ein Absatz."])
def test_validator_rejects_leaked_position_numbering(leaked: str) -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["questions"][0]["text"] = leaked
    assert any("position number" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_correct_order_that_is_not_a_permutation() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["correctOrder"] = ["p1", "p2", "p3", "p4", "p1"]  # p5 missing, p1 duplicated
    assert any("correctOrder must be a permutation" in i.message for i in hard_issues(validate_content(part, c)))


def test_validator_rejects_missing_skill_tags() -> None:
    from app.services.german_exam_validator import hard_issues, validate_content
    from app.services.german_exams import get_part

    part = get_part(PID, "reading", "lesen_2")
    c = _valid_content()
    c["questions"][0]["skillTags"] = []
    assert any("skillTags must be non-empty" in i.message for i in hard_issues(validate_content(part, c)))
