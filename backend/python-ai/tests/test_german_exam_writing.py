"""Mocks chat_json (deterministic generation/repair) and verify_semantic
(mocked as a trivial pass for the happy-path tests) for Schreiben
(choice_long_form_writing). Confirms a DUPLICATE_INFORMATION (not-genuinely-
distinct topics) semantic finding forces a full regeneration — like lesen_1
— while every other per-topic defect routes to targeted item repair."""

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


def _valid_schreiben_content() -> dict:
    return {
        "questions": [
            {
                "questionId": "a",
                "title": "Digitalisierung im Studium",
                "statements": ["Digitale Lehrveranstaltungen erm?glichen allen Studierenden flexibles Lernen unabh?ngig vom Wohnort und pers?nlichen Verpflichtungen.", "Pr?senzunterricht bleibt unverzichtbar, weil pers?nlicher Austausch das gemeinsame Lernen und soziale Beziehungen entscheidend st?rkt."],
                "communicativeSituation": "Sie schreiben einen Beitrag für das Studierendenmagazin Ihrer Hochschule.",
                "taskInstructions": "Beschreiben Sie Vor- und Nachteile digitaler Lehrformate und nehmen Sie klar Stellung.",
                "writingCoachTaskType": "stellungnahme",
            },
            {
                "questionId": "b",
                "title": "Nachhaltigkeit am Campus",
                "statements": ["Hochschulen sollten verbindliche ?kologische Regeln einf?hren und dadurch gesellschaftliche Verantwortung im Alltag sichtbar ?bernehmen.", "Freiwillige Initiativen ?berzeugen Studierende langfristig besser als zus?tzliche Vorschriften, die pers?nliche Entscheidungen unn?tig einschr?nken."],
                "communicativeSituation": "Sie schreiben einen Diskussionsbeitrag für ein Hochschulforum.",
                "taskInstructions": "Erörtern Sie, welche Maßnahmen Hochschulen ergreifen sollten, um nachhaltiger zu werden.",
                "writingCoachTaskType": "argumentation",
            },
        ]
    }


def test_valid_first_shot_needs_no_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing as mod
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_schreiben_content()))
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    content, meta = mod.generate_writing_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert meta["deterministicRepairCount"] == 0
    assert meta["deterministicPassed"] is True
    assert meta["semantic"]["passed"] is True
    assert len(content["questions"]) == 2


def test_non_duplicate_item_semantic_repair_used(monkeypatch: pytest.MonkeyPatch) -> None:
    """A per-topic defect that ISN'T about distinctness (e.g. unclear
    instructions) must route to targeted item repair, not full regeneration."""
    from app.services import german_exam_writing as mod
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
    from app.services.german_exams import get_profile, get_part

    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(_valid_schreiben_content()))

    verify_calls = {"n": 0}

    def _fake_verify(part, content):
        verify_calls["n"] += 1
        if verify_calls["n"] == 1:
            items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["questionId"] != "a"),
                                         issues=[] if q["questionId"] != "a" else
                                         [SemanticIssue("QUESTION_NOT_ANSWERABLE", "error", "instructions are contradictory")])
                     for q in content["questions"]]
            return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)
        return _passing_semantic_result(part, content)

    repair_calls = {"n": 0}

    def _fake_repair(part, content, item_issues):
        repair_calls["n"] += 1
        return content, [{"itemId": iid, "code": "QUESTION_NOT_ANSWERABLE"} for iid in item_issues]

    monkeypatch.setattr(mod, "verify_semantic", _fake_verify)
    monkeypatch.setattr(mod, "repair_items_semantic", _fake_repair)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    content, meta = mod.generate_writing_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert repair_calls["n"] == 1
    assert meta["semantic"]["passed"] is True


def test_duplicate_information_forces_full_regeneration(monkeypatch: pytest.MonkeyPatch) -> None:
    """A DUPLICATE_INFORMATION (not-genuinely-distinct) finding must never
    reach repair_items_semantic() — it must trigger a fresh generation call
    instead, mirroring lesen_1's shared-pool-defect handling."""
    from app.services import german_exam_writing as mod
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
    from app.services.german_exams import get_profile, get_part

    gen_calls = {"n": 0}

    def _fake_chat_json(**kwargs):
        gen_calls["n"] += 1
        return _FakeResult(_valid_schreiben_content())

    verify_calls = {"n": 0}

    def _fake_verify(part, content):
        verify_calls["n"] += 1
        if verify_calls["n"] == 1:
            items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["questionId"] != "b"),
                                         issues=[] if q["questionId"] != "b" else
                                         [SemanticIssue("DUPLICATE_INFORMATION", "error", "topic b restates topic a")])
                     for q in content["questions"]]
            return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)
        return _passing_semantic_result(part, content)

    def _fail_if_called(*args, **kwargs):
        raise AssertionError("repair_items_semantic must never be called for a DUPLICATE_INFORMATION finding")

    monkeypatch.setattr(mod, "chat_json", _fake_chat_json)
    monkeypatch.setattr(mod, "verify_semantic", _fake_verify)
    monkeypatch.setattr(mod, "repair_items_semantic", _fail_if_called)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    content, meta = mod.generate_writing_part(profile, part, [], {"topicId": "t", "label": "Test topic"})

    assert gen_calls["n"] >= 2  # first attempt failed semantically, second regenerated
    assert meta["semantic"]["passed"] is True


def test_persistently_invalid_output_raises_after_regeneration_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing as mod
    from app.services.german_exams import get_profile, get_part

    always_broken = {"questions": [{"questionId": "a", "title": "x", "communicativeSituation": "x", "taskInstructions": "x", "writingCoachTaskType": "stellungnahme"}]}
    monkeypatch.setattr(mod, "chat_json", lambda **kwargs: _FakeResult(always_broken))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    with pytest.raises(mod.WritingGenerationError):
        mod.generate_writing_part(profile, part, [], {"topicId": "t", "label": "Test topic"})
