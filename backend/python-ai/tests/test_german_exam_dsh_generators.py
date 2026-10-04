"""DSH LV (Leseverstehen) generator — offline: fixtures/fakes only, no real provider calls.

Covers the 5-stage pipeline (generation -> structural validation -> semantic/content audit ->
bounded full-regeneration repair -> accept/reject) with a fake provider that returns scripted
responses per call, never a real chat_json/OpenAI call."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.german_exam_dsh_generators import (
    _HV_ITEM_COUNT,
    _LV_ITEM_COUNT,
    DshGenerationError,
    generate_dsh_hv_part,
    generate_dsh_lv_part,
)
from app.services.german_exams import get_part

LV_PART = get_part("dsh", "reading", "lv_1")
HV_PART = get_part("dsh", "listening", "hv_1")
TOPIC = {"topicId": "open_science", "label": "Offene Wissenschaft"}
SENTENCE = "Die Untersuchung wurde von den Forschenden durchgeführt, weil die Datenlage unklar war."


def _text(chars: int = 5000) -> str:
    unit = SENTENCE + " "
    return (unit * (chars // len(unit) + 1))[:chars]


def _valid_content(item_count: int = _LV_ITEM_COUNT, **over) -> dict:
    items = [
        {"itemId": f"q{i}", "question": f"Frage {i}?", "requiredPoints": [{"pointId": f"p{i}", "description": f"Punkt {i}", "points": 1}]}
        for i in range(1, item_count + 1)
    ]
    content = {"sourceId": "src-1", "source": {"text": _text()}, "tasks": [{"form": "questions", "items": items}]}
    content.update(over)
    return content


def _valid_audit(content: dict) -> dict:
    ids = [item["itemId"] for task in content["tasks"] for item in task["items"]]
    return {
        "items": [{"itemId": i, "answerableFromTextAlone": True, "singleDefensibleReading": True, "unsupportedPointDescriptions": []} for i in ids],
        "textRequiresSpecialistKnowledge": False, "textIsCoherent": True,
    }


class _Result:
    def __init__(self, data) -> None:
        self.data = data
        self.completion_tokens = 10
        self.reasoning_tokens = 0


def _scripted_provider(*responses):
    calls: list[dict] = []

    def provider(**kwargs):
        calls.append(kwargs)
        return _Result(responses[len(calls) - 1])

    provider.calls = calls  # type: ignore[attr-defined]
    return provider


def test_accepts_a_valid_generation_and_audit_on_the_first_attempt() -> None:
    content = _valid_content()
    provider = _scripted_provider(content, _valid_audit(content))
    result, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert result["sourceId"] == "src-1"
    assert len(result["tasks"][0]["items"]) == _LV_ITEM_COUNT
    assert meta == {"deterministicPassed": True, "semanticPassed": True, "regenerationCount": 0, "liveQualificationRequired": True}
    assert len(provider.calls) == 2  # exactly one generation + one audit call, no waste


def test_fills_in_a_missing_sourceid_rather_than_failing() -> None:
    content = _valid_content()
    del content["sourceId"]
    provider = _scripted_provider(content, _valid_audit(content))
    result, _ = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert result["sourceId"]  # a real, non-empty generated id


@pytest.mark.parametrize("bad_content_over", [
    {"source": {"text": "too short"}},  # fails text length
    {},  # placeholder — item-count failure injected below
])
def test_structural_failure_regenerates_then_succeeds(bad_content_over) -> None:
    if bad_content_over == {}:
        bad = _valid_content(item_count=_LV_ITEM_COUNT - 1)  # wrong item count
    else:
        bad = _valid_content(**bad_content_over)
    good = _valid_content()
    provider = _scripted_provider(bad, good, _valid_audit(good))
    result, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert result["sourceId"] == good["sourceId"]
    assert meta["regenerationCount"] == 1
    assert len(provider.calls) == 3  # failed generation (no audit call wasted) + good generation + audit


def test_duplicate_item_ids_are_a_structural_failure() -> None:
    bad = _valid_content()
    bad["tasks"][0]["items"][1]["itemId"] = bad["tasks"][0]["items"][0]["itemId"]
    good = _valid_content()
    provider = _scripted_provider(bad, good, _valid_audit(good))
    _, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_semantic_audit_failure_regenerates_even_when_structurally_valid() -> None:
    bad_content = _valid_content()
    bad_audit = _valid_audit(bad_content)
    bad_audit["items"][0]["unsupportedPointDescriptions"] = ["Punkt 1"]  # claimed point not in the text
    good_content = _valid_content()
    provider = _scripted_provider(bad_content, bad_audit, good_content, _valid_audit(good_content))
    result, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert result["sourceId"] == good_content["sourceId"]
    assert meta["regenerationCount"] == 1
    assert len(provider.calls) == 4  # bad gen + bad audit (wasted, but needed to detect it) + good gen + good audit


@pytest.mark.parametrize("field,value", [
    ("answerableFromTextAlone", False),
    ("singleDefensibleReading", False),
])
def test_each_semantic_audit_criterion_independently_blocks_acceptance(field, value) -> None:
    content = _valid_content()
    audit = _valid_audit(content)
    audit["items"][0][field] = value
    good = _valid_content()
    provider = _scripted_provider(content, audit, good, _valid_audit(good))
    _, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_audit_requiring_specialist_knowledge_or_incoherent_text_blocks_acceptance() -> None:
    for key in ("textRequiresSpecialistKnowledge", "textIsCoherent"):
        content = _valid_content()
        audit = _valid_audit(content)
        audit[key] = True if key == "textRequiresSpecialistKnowledge" else False
        good = _valid_content()
        provider = _scripted_provider(content, audit, good, _valid_audit(good))
        _, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
        assert meta["regenerationCount"] == 1


def test_audit_not_covering_every_item_is_treated_as_failure_not_an_implicit_pass() -> None:
    content = _valid_content()
    audit = _valid_audit(content)
    audit["items"].pop()  # one item silently missing from the audit response
    good = _valid_content()
    provider = _scripted_provider(content, audit, good, _valid_audit(good))
    _, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_malformed_audit_response_is_a_failure_not_a_crash() -> None:
    content = _valid_content()
    good = _valid_content()
    provider = _scripted_provider(content, "not a dict at all", good, _valid_audit(good))
    _, meta = generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_raises_after_exhausting_the_regeneration_budget_never_returns_bad_content() -> None:
    always_bad = _valid_content(item_count=1)
    provider = _scripted_provider(always_bad, always_bad, always_bad)
    with pytest.raises(DshGenerationError):
        generate_dsh_lv_part(None, LV_PART, [], TOPIC, provider=provider)


# ---- HV (Hörverstehen) — same shared pipeline, different top-level field/constraints ----------


def _valid_hv_content(item_count: int = _HV_ITEM_COUNT, **over) -> dict:
    items = [
        {"itemId": f"q{i}", "question": f"Frage {i}?", "requiredPoints": [{"pointId": f"p{i}", "description": f"Punkt {i}", "points": 1}]}
        for i in range(1, item_count + 1)
    ]
    content = {"lectureText": _text(6000), "tasks": [{"form": "questions", "items": items}]}
    content.update(over)
    return content


def test_hv_accepts_a_valid_generation_and_audit_on_the_first_attempt() -> None:
    content = _valid_hv_content()
    provider = _scripted_provider(content, _valid_audit(content))
    result, meta = generate_dsh_hv_part(None, HV_PART, [], TOPIC, provider=provider)
    assert len(result["tasks"][0]["items"]) == _HV_ITEM_COUNT
    assert "sourceId" not in result  # HV has no sourceId concept, unlike LV
    assert meta["regenerationCount"] == 0
    assert len(provider.calls) == 2


def test_hv_structural_failure_regenerates_then_succeeds() -> None:
    bad = _valid_hv_content(lectureText="too short")
    good = _valid_hv_content()
    provider = _scripted_provider(bad, good, _valid_audit(good))
    _, meta = generate_dsh_hv_part(None, HV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_hv_semantic_audit_failure_regenerates_even_when_structurally_valid() -> None:
    content = _valid_hv_content()
    audit = _valid_audit(content)
    audit["items"][0]["answerableFromTextAlone"] = False
    good = _valid_hv_content()
    provider = _scripted_provider(content, audit, good, _valid_audit(good))
    _, meta = generate_dsh_hv_part(None, HV_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_hv_raises_after_exhausting_the_regeneration_budget_never_returns_bad_content() -> None:
    always_bad = _valid_hv_content(item_count=1)
    provider = _scripted_provider(always_bad, always_bad, always_bad)
    with pytest.raises(DshGenerationError):
        generate_dsh_hv_part(None, HV_PART, [], TOPIC, provider=provider)


def test_hv_routed_from_the_real_listening_dispatcher_before_any_other_exam_logic(monkeypatch) -> None:
    import app.services.german_exam_dsh_generators as dsh_gen
    from app.services.german_exam_listening import generate_listening_part

    sentinel = ({"lectureText": "sentinel"}, {"deterministicPassed": True})
    calls = []
    monkeypatch.setattr(dsh_gen, "generate_dsh_hv_part", lambda *a, **kw: calls.append((a, kw)) or sentinel)

    result = generate_listening_part(None, HV_PART, [], TOPIC)
    assert result == sentinel
    assert len(calls) == 1


def test_routed_from_the_real_reading_dispatcher_not_telc_testdaf_goethe_logic(monkeypatch) -> None:
    """generate_reading_part must route DSH's task type to this generator before reaching any
    of the TELC/TestDaF/Goethe-specific prompt builders or the selection-types path."""
    import app.services.german_exam_dsh_generators as dsh_gen
    from app.services.german_exam_reading import generate_reading_part

    sentinel = ({"sourceId": "sentinel"}, {"deterministicPassed": True})
    calls = []
    monkeypatch.setattr(dsh_gen, "generate_dsh_lv_part", lambda *a, **kw: calls.append((a, kw)) or sentinel)

    result = generate_reading_part(None, LV_PART, [], TOPIC)
    assert result == sentinel
    assert len(calls) == 1
