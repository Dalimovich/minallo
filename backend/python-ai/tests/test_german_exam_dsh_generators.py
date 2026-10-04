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
    _ORAL_INPUT_COUNT,
    _TP_INPUT_COUNT,
    _WS_ITEM_COUNT,
    DshGenerationError,
    generate_dsh_hv_part,
    generate_dsh_lv_part,
    generate_dsh_oral_part,
    generate_dsh_tp_part,
    generate_dsh_ws_part,
)
from app.services.german_exams import get_part

LV_PART = get_part("dsh", "reading", "lv_1")
HV_PART = get_part("dsh", "listening", "hv_1")
WS_PART = get_part("dsh", "scientific_structures", "ws_1")
TP_PART = get_part("dsh", "writing", "tp_1")
ORAL_PART = get_part("dsh", "speaking", "sprechen_1")
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


# ---- WS (Wissenschaftssprachliche Strukturen) — bound to an already-generated LV text ---------
# Unlike HV/LV, WS needs each sourceSentence to be a UNIQUE substring of the LV text (the
# grounding check rejects a sentence found zero or more-than-once times), so these fixtures use
# six genuinely distinct sentences rather than one repeated sentence.

WS_SENTENCES = [
    "Die Untersuchung wurde von den Forschenden durchgeführt, weil die Datenlage unklar war.",
    "Viele Studierende nutzen digitale Bibliotheken für ihre Recherche.",
    "Der Zugang zu wissenschaftlichen Daten bleibt jedoch oft eingeschränkt.",
    "Einige Universitäten haben inzwischen offene Plattformen eingerichtet.",
    "Kritiker bemängeln die uneinheitlichen Standards bei der Veröffentlichung.",
    "Langfristig könnte dies die Zusammenarbeit zwischen Institutionen verbessern.",
]


def _ws_lv_text() -> str:
    base = " ".join(WS_SENTENCES) + " "
    filler = "Weitere Ausführungen ergänzen diesen Abschnitt des Textes ohne neue Aussage. "
    text = base
    while len(text) < 4600:
        text += filler
    return text


def _valid_ws_lv_content() -> dict:
    return _valid_content(source={"text": _ws_lv_text()})


def _raw_ws_items() -> list[dict]:
    return [
        {"itemId": f"w{i}", "form": "completion", "category": "syntactic", "sourceSentence": sentence,
         "prompt": f"Ergänzen Sie Lücke {i}: ___.", "families": [{"familyId": "f1", "accepted": [f"Antwort{i}"]}], "maxPoints": 1}
        for i, sentence in enumerate(WS_SENTENCES, start=1)
    ]


def _blind_answers(items: list[dict], *, correct: bool = True) -> list[dict]:
    return [{"answer": item["families"][0]["accepted"][0] if correct else "eine falsche Antwort"} for item in items]


def test_ws_accepts_a_valid_generation_when_the_blind_solver_agrees_with_every_family() -> None:
    lv_content = _valid_ws_lv_content()
    items = _raw_ws_items()
    provider = _scripted_provider({"items": items}, *_blind_answers(items))
    result, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert result["sourceRef"]["sourceId"] == lv_content["sourceId"]
    assert len(result["items"]) == _WS_ITEM_COUNT
    assert meta["regenerationCount"] == 0
    assert len(provider.calls) == 1 + _WS_ITEM_COUNT  # 1 generation + one blind-solve per item


def test_ws_sentence_not_found_verbatim_in_the_lv_text_is_a_grounding_failure() -> None:
    lv_content = _valid_ws_lv_content()
    bad = _raw_ws_items()
    bad[0]["sourceSentence"] = "Dieser Satz existiert nicht im gegebenen Text."
    good = _raw_ws_items()
    provider = _scripted_provider({"items": bad}, {"items": good}, *_blind_answers(good))
    _, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_ws_duplicate_item_ids_are_a_grounding_failure() -> None:
    lv_content = _valid_ws_lv_content()
    bad = _raw_ws_items()
    bad[1]["itemId"] = bad[0]["itemId"]
    good = _raw_ws_items()
    provider = _scripted_provider({"items": bad}, {"items": good}, *_blind_answers(good))
    _, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_ws_non_official_task_form_is_a_structural_failure_via_qualify_lv_ws() -> None:
    lv_content = _valid_ws_lv_content()
    bad = _raw_ws_items()
    bad[0]["form"] = "free_writing"
    good = _raw_ws_items()
    provider = _scripted_provider({"items": bad}, {"items": good}, *_blind_answers(good))
    _, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_ws_answer_leaked_in_the_prompt_is_a_structural_failure_via_qualify_lv_ws() -> None:
    lv_content = _valid_ws_lv_content()
    bad = _raw_ws_items()
    bad[0]["prompt"] = f"Die richtige Antwort ist {bad[0]['families'][0]['accepted'][0]}."
    good = _raw_ws_items()
    provider = _scripted_provider({"items": bad}, {"items": good}, *_blind_answers(good))
    _, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_ws_blind_solver_disagreeing_with_a_family_is_a_semantic_failure_not_accepted() -> None:
    """The central risk this function exists to guard against: a generated answer key is never
    trusted just because it is well-formed — an independent solver must actually agree with it."""
    lv_content = _valid_ws_lv_content()
    items = _raw_ws_items()
    good = _raw_ws_items()
    provider = _scripted_provider({"items": items}, *_blind_answers(items, correct=False), {"items": good}, *_blind_answers(good))
    _, meta = generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_ws_raises_after_exhausting_the_regeneration_budget_never_returns_bad_content() -> None:
    lv_content = _valid_ws_lv_content()
    always_empty = {"items": []}
    provider = _scripted_provider(always_empty, always_empty, always_empty)
    with pytest.raises(DshGenerationError):
        generate_dsh_ws_part(LV_PART, lv_content, WS_PART, [], TOPIC, provider=provider)


def test_ws_is_deliberately_not_wired_into_generate_tasks_module_dispatch() -> None:
    """Pins the documented boundary: scientific_structures has no module dispatch branch at all
    (see generate_dsh_ws_part's own docstring for why) — this must stay a deliberate, known gap,
    not something a future session mistakes for an oversight and silently works around."""
    from app.services.german_exam_generator import _dispatch_module
    from app.services.german_exams import GermanExamProfileError

    with pytest.raises(GermanExamProfileError):
        _dispatch_module("scientific_structures")


# ---- TP (Textproduktion) ------------------------------------------------------------------------


def _valid_tp_content(**over) -> dict:
    content = {
        "inputs": [{"id": "i1", "kind": "quotation", "text": "Wer nicht wagt, der nicht gewinnt."},
                   {"id": "i2", "kind": "statement", "text": "Risikobereitschaft wird in der Forschung unterschätzt."}],
        "languageActs": ["describe", "evaluate"],
        "instructions": "Beschreiben Sie die Positionen in Zitat und Aussage und nehmen Sie begründet Stellung dazu.",
        "wordCountApprox": 250, "inputRefs": ["i1", "i2"],
    }
    content.update(over)
    return content


def _valid_tp_audit() -> dict:
    return {"requiresBothInputs": True, "answerableWithoutSpecialistKnowledge": True, "isFreeEssay": False, "inputsAreDistinct": True}


def test_tp_accepts_a_valid_generation_and_audit_on_the_first_attempt() -> None:
    content = _valid_tp_content()
    provider = _scripted_provider(content, _valid_tp_audit())
    result, meta = generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)
    assert len(result["inputs"]) == _TP_INPUT_COUNT
    assert meta["regenerationCount"] == 0
    assert len(provider.calls) == 2


def test_tp_structural_failure_regenerates_then_succeeds() -> None:
    bad = _valid_tp_content(wordCountApprox=300)  # must exactly equal the official 250
    good = _valid_tp_content()
    provider = _scripted_provider(bad, good, _valid_tp_audit())
    _, meta = generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_tp_non_text_input_kind_is_rejected_by_this_generator() -> None:
    """This generator deliberately only produces text-only input kinds (no chart/table/diagram
    DATA generation yet) — a diagram/graphic/table kind must regenerate, never be accepted."""
    bad = _valid_tp_content(inputs=[{"id": "i1", "kind": "diagram", "text": "x"}, {"id": "i2", "kind": "statement", "text": "y"}])
    good = _valid_tp_content()
    provider = _scripted_provider(bad, good, _valid_tp_audit())
    _, meta = generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_tp_reused_qualify_tp_free_essay_heuristic_blocks_a_bad_generation() -> None:
    """Reuses dsh_qualification.qualify_tp's own not_free_essay heuristic rather than
    re-implementing it — instructions with no language-act stem and no input anchoring fail here."""
    bad = _valid_tp_content(instructions="Schreiben Sie einen freien Text über ein Thema Ihrer Wahl.")
    good = _valid_tp_content()
    provider = _scripted_provider(bad, good, _valid_tp_audit())
    _, meta = generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


@pytest.mark.parametrize("field,value", [
    ("requiresBothInputs", False), ("answerableWithoutSpecialistKnowledge", False),
    ("isFreeEssay", True), ("inputsAreDistinct", False),
])
def test_tp_each_semantic_audit_criterion_independently_blocks_acceptance(field, value) -> None:
    content = _valid_tp_content()
    audit = _valid_tp_audit()
    audit[field] = value
    good = _valid_tp_content()
    provider = _scripted_provider(content, audit, good, _valid_tp_audit())
    _, meta = generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_tp_raises_after_exhausting_the_regeneration_budget_never_returns_bad_content() -> None:
    always_bad = _valid_tp_content(wordCountApprox=999)
    provider = _scripted_provider(always_bad, always_bad, always_bad)
    with pytest.raises(DshGenerationError):
        generate_dsh_tp_part(None, TP_PART, [], TOPIC, provider=provider)


def test_tp_routed_from_the_real_writing_dispatcher_before_productive_or_telc_logic(monkeypatch) -> None:
    import app.services.german_exam_dsh_generators as dsh_gen
    from app.services.german_exam_writing import generate_writing_part

    sentinel = ({"inputs": "sentinel"}, {"deterministicPassed": True})
    calls = []
    monkeypatch.setattr(dsh_gen, "generate_dsh_tp_part", lambda *a, **kw: calls.append((a, kw)) or sentinel)

    result = generate_writing_part(None, TP_PART, [], TOPIC)
    assert result == sentinel
    assert len(calls) == 1


# ---- Oral (Kurzvortrag stimulus only) ----------------------------------------------------------


def _valid_oral_content(**over) -> dict:
    content = {
        "inputs": [{"id": "i1", "kind": "short_text", "text": "Ein kurzer Text über wissenschaftliche Methoden."}],
        "languageActs": ["describe", "evaluate"],
        "instructions": "Beschreiben Sie den Text und nehmen Sie begründet Stellung dazu.",
        "inputRefs": ["i1"],
    }
    content.update(over)
    return content


def _valid_oral_audit() -> dict:
    return {"requiresTheInput": True, "answerableWithoutSpecialistKnowledge": True, "noPreformulatedPassage": True}


def test_oral_accepts_a_valid_generation_and_audit_on_the_first_attempt() -> None:
    content = _valid_oral_content()
    provider = _scripted_provider(content, _valid_oral_audit())
    result, meta = generate_dsh_oral_part(None, ORAL_PART, [], TOPIC, provider=provider)
    assert len(result["inputs"]) == _ORAL_INPUT_COUNT
    assert meta["regenerationCount"] == 0
    assert len(provider.calls) == 2


def test_oral_structural_failure_regenerates_then_succeeds() -> None:
    bad = _valid_oral_content(inputs=[])
    good = _valid_oral_content()
    provider = _scripted_provider(bad, good, _valid_oral_audit())
    _, meta = generate_dsh_oral_part(None, ORAL_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_oral_non_short_text_input_kind_is_rejected_by_this_generator() -> None:
    """This generator deliberately only produces the short_text input kind — "graphic" (the
    other official kind) is a scope decision skipped for this first build, not silently faked."""
    bad = _valid_oral_content(inputs=[{"id": "i1", "kind": "graphic", "text": "x"}])
    good = _valid_oral_content()
    provider = _scripted_provider(bad, good, _valid_oral_audit())
    _, meta = generate_dsh_oral_part(None, ORAL_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


@pytest.mark.parametrize("field,value", [
    ("requiresTheInput", False), ("answerableWithoutSpecialistKnowledge", False), ("noPreformulatedPassage", False),
])
def test_oral_each_semantic_audit_criterion_independently_blocks_acceptance(field, value) -> None:
    content = _valid_oral_content()
    audit = _valid_oral_audit()
    audit[field] = value
    good = _valid_oral_content()
    provider = _scripted_provider(content, audit, good, _valid_oral_audit())
    _, meta = generate_dsh_oral_part(None, ORAL_PART, [], TOPIC, provider=provider)
    assert meta["regenerationCount"] == 1


def test_oral_raises_after_exhausting_the_regeneration_budget_never_returns_bad_content() -> None:
    always_bad = _valid_oral_content(inputs=[])
    provider = _scripted_provider(always_bad, always_bad, always_bad)
    with pytest.raises(DshGenerationError):
        generate_dsh_oral_part(None, ORAL_PART, [], TOPIC, provider=provider)


def test_oral_routed_before_the_shared_sprechen_1_part_id_branch(monkeypatch) -> None:
    """DSH's oral part shares the part_id "sprechen_1" convention with TELC/Goethe — without the
    DSH task_type check running FIRST in generate_speaking_part, this would silently fall into
    the shared part_id=="sprechen_1" branch and get TELC/Goethe's presentation-topic-choice
    prompt instead of the Kurzvortrag stimulus shape. Pins that the DSH check wins."""
    import app.services.german_exam_dsh_generators as dsh_gen
    from app.services.german_exam_speaking import generate_speaking_part

    sentinel = ({"inputs": "sentinel"}, {"deterministicPassed": True})
    calls = []
    monkeypatch.setattr(dsh_gen, "generate_dsh_oral_part", lambda *a, **kw: calls.append((a, kw)) or sentinel)

    result = generate_speaking_part(None, ORAL_PART, [], TOPIC)
    assert result == sentinel
    assert len(calls) == 1
