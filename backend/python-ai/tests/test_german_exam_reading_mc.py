"""Blueprint-driven reading MC: shape, semantic audits and bounded pipeline."""
import copy
from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_semantic_repair import _constrain_repair
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import build_manifest, get_part, get_profile

PART = get_part("testdaf_digital", "reading", "lesen_3")


def content():
    return {
        "text": {"title": "Forschung", "paragraphs": [
            {"paragraphId": f"p{i}", "text": " ".join(f"wort{i}x{j}" for j in range(90))}
            for i in range(1, 7)]},
        "questions": [{"questionId": f"q{i}", "difficulty": "c1", "skillTags": ["detail_comprehension"],
                       "mc3": {"stem": f"Frage {i}?", "options": [f"Antwort {i}-{j}" for j in range(4)],
                               "correctIndex": 3, "evidenceParagraphIds": [f"p{i}"] if i < 7 else [f"p{j}" for j in range(1, 7)]}}
                      for i in range(1, 8)],
    }


def issues(c):
    return hard_issues(validate_content(PART, c))


def test_blueprint_and_prompts():
    assert PART.constraints["itemCount"] == 7 and PART.constraints["optionCount"] == 4
    system, _ = reading._PROMPT_BUILDERS[PART.task_type](get_profile("testdaf_digital"), PART, [], {"label": "Forschung"})
    assert "exactly 4 options" in system and "exactly 7 multiple-choice items" in system
    assert "500-650 words" in system and "6 paragraphs" in system and "global" in system
    assert issues(content()) == []


def test_release_gate_keeps_failed_qa_unavailable_and_only_mc_is_eligible():
    profile = get_profile("testdaf_digital")
    assert not any(p.available for parts in profile.modules.values() for p in parts)
    candidate = replace(profile, modules={**profile.modules, "reading": tuple(
        replace(p, available=True) if p.part_id == PART.part_id else p for p in profile.modules["reading"]
    )})
    enabled = [(m["id"], p["id"]) for m in build_manifest(candidate)["modules"] for p in m["parts"] if p["implemented"]]
    assert enabled == [("reading", "lesen_3")]


@pytest.mark.parametrize("mutation", [
    lambda c: c["questions"].pop(),
    lambda c: c["questions"][0]["mc3"]["options"].pop(),
    lambda c: c["questions"][0]["mc3"].update(correctIndex=4),
    lambda c: c["questions"][0]["mc3"].update(correctIndex=True),
    lambda c: c["questions"][0].update(questionId="q2"),
    lambda c: c["questions"][0].update(questionId=""),
    lambda c: c["text"]["paragraphs"][0].update(paragraphId="p9"),
    lambda c: c["questions"][0]["mc3"].update(evidenceParagraphIds=["p2"]),
    lambda c: c["questions"][-1]["mc3"].update(evidenceParagraphIds=["p6"]),
    lambda c: c["questions"][0].update(mc3=[]),
    lambda c: c["text"]["paragraphs"][0].update(text="short"),
])
def test_invalid_structure_rejected(mutation):
    c = content()
    mutation(c)
    assert issues(c)


def test_full_article_reaches_verifier(monkeypatch):
    c = content()
    def chat(**kw):
        payload = json.loads(kw["user"].split("\n", 1)[1])
        assert payload["article"] == c["text"]["paragraphs"]
        assert len(payload["article"]) == 6
        assert "IMPLAUSIBLE_DISTRACTOR" in kw["system"]
        return SimpleNamespace(completion_tokens=0, data=verdict(c))
    monkeypatch.setattr(verify, "chat_json", chat)
    assert verify.verify_semantic(PART, c).passed


def verdict(c):
    return {"passed": True, "partWideIssues": [], "items": [
        {"questionId": q["questionId"], "passed": True, "issues": [],
         "audit": {"optionVerdicts": ["supported" if j == q["mc3"]["correctIndex"] else "plausible_wrong" for j in range(4)]}}
        for q in c["questions"]]}


@pytest.mark.parametrize("values,code", [
    (["supported", "plausible_wrong", "plausible_wrong", "plausible_wrong"], "UNSUPPORTED_CORRECT_ANSWER"),
    (["supported", "plausible_wrong", "plausible_wrong", "supported"], "MULTIPLE_DEFENSIBLE_ANSWERS"),
    (["implausible_wrong", "plausible_wrong", "plausible_wrong", "supported"], "IMPLAUSIBLE_DISTRACTOR"),
    (["plausible_wrong", "plausible_wrong", "supported"], "VERIFIER_RESPONSE_INVALID"),
])
def test_semantic_audit_overrules_false_pass(values, code, monkeypatch):
    c = content()
    data = verdict(c)
    data["items"][0]["audit"]["optionVerdicts"] = values
    monkeypatch.setattr(verify, "chat_json", lambda **kw: SimpleNamespace(completion_tokens=0, data=data))
    result = verify.verify_semantic(PART, c)
    assert not result.passed
    assert code in [i.code for i in result.item_error_issues()["q1"]]


def test_four_option_repair_preserves_key_and_other_fields():
    original = content()["questions"][0]
    fixed = copy.deepcopy(original)
    fixed["mc3"].update(options=["new0", "new1", "new2", "new3"], correctIndex=0)
    result = _constrain_repair(original, fixed, [verify.SemanticIssue("IMPLAUSIBLE_DISTRACTOR", "error", "wrong")], PART)
    assert result["mc3"]["correctIndex"] == 3
    assert result["mc3"]["options"] == ["new0", "new1", "new2", original["mc3"]["options"][3]]


def test_pipeline_verifies_before_accepting_and_copies_presentation(monkeypatch):
    c = content()
    monkeypatch.setattr(reading, "chat_json", lambda **kw: SimpleNamespace(completion_tokens=0, data=copy.deepcopy(c)))
    seen = []
    def check(part, generated):
        seen.append(copy.deepcopy(generated))
        raw = verdict(generated)
        return verify._apply_audits(verify._parse_result(raw, {q["questionId"] for q in generated["questions"]}), raw, part, generated)
    monkeypatch.setattr(reading, "verify_semantic", check)
    result, meta = reading.generate_reading_part(get_profile("testdaf_digital"), PART, [], {"label": "Forschung"})
    assert seen and meta["semantic"]["passed"]
    assert result["presentation"] == PART.constraints["presentation"]
    assert result["presentation"] is not PART.constraints["presentation"]
    assert {q["mc3"]["correctIndex"] for q in result["questions"]} == {0, 1, 2, 3}


def test_pipeline_never_accepts_semantic_failure(monkeypatch):
    monkeypatch.setattr(reading, "chat_json", lambda **kw: SimpleNamespace(completion_tokens=0, data=content()))
    failure = verify.SemanticVerificationResult(passed=False, items=[], part_wide_issues=[verify.SemanticIssue("PART_WIDE_INCOHERENCE", "error", "Unsuitable register")])
    monkeypatch.setattr(reading, "verify_semantic", lambda *a: failure)
    with pytest.raises(reading.ReadingGenerationError, match="semantically valid"):
        reading.generate_reading_part(get_profile("testdaf_digital"), PART, [], {"label": "Forschung"})
