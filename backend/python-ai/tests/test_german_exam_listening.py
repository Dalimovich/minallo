"""Mocks chat_json; exercises the bounded per-item repair loop and confirms
the generator never returns audio fields (TTS is out of scope for this module)."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def _valid_hv1_content() -> dict:
    segments = [{"id": f"s{i}", "speakerId": f"speaker_{i}", "spokenText": f"Text {i}", "displayText": f"Text {i}"} for i in range(1, 9)]
    questions = []
    for i in range(1, 9):
        questions.append({
            "questionId": f"q{i}", "prompt": f"Statement {i}", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1", "matching": {"correctSpeakerId": f"speaker_{i}", "isDistractor": False},
        })
    for i in range(9, 11):
        questions.append({
            "questionId": f"q{i}", "prompt": f"Distractor {i}", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1", "matching": {"correctSpeakerId": None, "isDistractor": True},
        })
    return {"segments": segments, "questions": questions}


class _FakeResult:
    def __init__(self, data) -> None:
        self.data = data
        self.model = "stub-model"
        self.prompt_tokens = 10
        self.completion_tokens = 10


def test_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_listening as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_hv1_content()))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content, meta = mod.generate_listening_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["repairCount"] == 0
    assert meta["deterministicPassed"] is True
    for seg in content["segments"]:
        assert "audioUrl" not in seg
        assert "durationMs" not in seg


def test_one_bad_item_gets_repaired_without_full_regeneration(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_listening as mod
    from app.services.german_exam_profiles import get_profile, get_part

    broken = _valid_hv1_content()
    # Break q2 with an item-level issue (unknown skill tag) — repairable per-item,
    # unlike a part-level issue (e.g. wrong overall item count) which forces
    # full regeneration instead.
    broken["questions"][1]["skillTags"] = ["not_a_real_tag"]

    call_count = {"n": 0}

    def _fake_chat_json(**kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _FakeResult(broken)
        # Repair call: return a fixed q2 with a valid skill tag.
        return _FakeResult({
            "questionId": "q2", "prompt": "Statement 2", "skillTags": ["paraphrase_mapping"],
            "difficulty": "c1", "matching": {"correctSpeakerId": "speaker_2", "isDistractor": False},
        })

    monkeypatch.setattr(mod, "chat_json", _fake_chat_json)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content, meta = mod.generate_listening_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["repairCount"] >= 1
    fixed_q2 = next(q for q in content["questions"] if q["questionId"] == "q2")
    assert fixed_q2["skillTags"] == ["paraphrase_mapping"]
    # The other 9 items were never touched by the repair call.
    assert content["questions"][0]["questionId"] == "q1"


def test_persistently_invalid_output_raises_after_regeneration_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_listening as mod
    from app.services.german_exam_profiles import get_profile, get_part

    # Always return too few segments — a part-level issue, unrepairable per-item.
    always_broken = {"segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "x", "displayText": "x"}], "questions": []}
    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(always_broken))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    with pytest.raises(mod.ListeningGenerationError):
        mod.generate_listening_part(profile, part, [], {"topicId": "t", "label": "Test topic"})
