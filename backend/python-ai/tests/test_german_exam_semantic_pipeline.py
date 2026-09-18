from copy import deepcopy

import pytest

from test_german_exam_listening import _FakeResult, _valid_hv1_content, _passing_semantic_result
from app.services import german_exam_listening as listening
from app.services.german_exam_profiles import get_part, get_profile
from app.services.german_exam_semantic_verify import _parse_result, SemanticIssue, SemanticVerificationResult, ItemSemanticResult
from app.services.german_exam_semantic_repair import _constrain_repair


def response():
    return {"passed": True, "partWideIssues": [], "items": [
        {"questionId": "q1", "passed": True, "issues": []}
    ]}


@pytest.mark.parametrize("mutation", [
    lambda r: r.update(passed=False),
    lambda r: r.update(items=[]),
    lambda r: r.update(items="invalid"),
    lambda r: r["items"].append(deepcopy(r["items"][0])),
    lambda r: r["items"][0].update(passed=False),
    lambda r: r["items"][0].update(questionId=[]),
    lambda r: r["items"][0].update(issues=[{"code": "UNKNOWN"}]),
    lambda r: r["items"][0].update(issues=[{"code": "UNSUPPORTED_CORRECT_ANSWER", "severity": "error"}]),
])
def test_parser_fails_closed(mutation):
    data = response()
    mutation(data)
    assert not _parse_result(data, {"q1"}).passed


def test_warning_does_not_block():
    data = response()
    data["partWideIssues"] = [{"code": "WRONG_REGISTER", "severity": "warning"}]
    assert _parse_result(data, {"q1"}).passed


def test_only_evidence_references_are_retained():
    data = response()
    data["items"][0]["issues"] = [{"code": "EVIDENCE_TOO_WEAK", "severity": "error",
        "evidence": {"segmentIds": ["s1"], "reasoning": "Do not persist this", "optionIndexes": [0]}}]
    evidence = _parse_result(data, {"q1"}).items[0].issues[0].evidence
    assert evidence == {"segmentIds": ["s1"], "optionIndexes": [0]}


@pytest.mark.parametrize("mutation", [
    lambda c: c["questions"][1].update(questionId="q1"),
    lambda c: c["segments"][1].update(id="s1"),
    lambda c: c["questions"][0]["matching"].update(evidenceSegmentIds=[{}]),
    lambda c: c["questions"][0]["matching"].update(evidenceSegmentIds="s1"),
    lambda c: c.update(questions=[None]),
])
def test_malformed_evidence_and_ids_block_validation(mutation):
    from app.services.german_exam_validator import hard_issues, validate_content
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content = listening._postprocess(part, _valid_hv1_content())
    mutation(content)
    assert hard_issues(validate_content(part, content))


def test_distractor_repair_preserves_everything_else():
    original = {"questionId": "q1", "skillTags": ["detail_fact"], "mc3": {
        "stem": "Original", "options": ["correct", "bad", "wrong"],
        "correctIndex": 0, "evidenceSegmentIds": ["s1"]}}
    changed = deepcopy(original)
    changed["mc3"].update(stem="changed", options=["changed", "plausible", "wrong"], correctIndex=1)
    changed["skillTags"] = []
    fixed = _constrain_repair(original, changed, [SemanticIssue("IMPLAUSIBLE_DISTRACTOR", "error", "absurd")])
    expected = deepcopy(original)
    expected["mc3"]["options"][1] = "plausible"
    assert fixed == expected


def _sprachbausteine_part():
    return get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")


def test_cloze_repair_freezes_correct_index_and_correct_option():
    part = _sprachbausteine_part()
    original = {
        "questionId": "q1", "gapId": "g1", "category": "grammar", "skillTags": ["grammar"],
        "difficulty": "c1", "options": ["falsch1", "falsch2", "richtig", "falsch3"], "correctIndex": 2,
    }
    changed = deepcopy(original)
    # A verifier-flagged repair attempt that (wrongly) tries to also change
    # the correct option's text and move correctIndex.
    changed.update(options=["besser1", "besser2", "NEU_RICHTIG", "besser3"], correctIndex=1)
    fixed = _constrain_repair(original, changed, [SemanticIssue("IMPLAUSIBLE_DISTRACTOR", "error", "weak")], part)
    assert fixed["correctIndex"] == 2
    assert fixed["options"][2] == "richtig"
    assert fixed["options"][0] == "besser1" and fixed["options"][1] == "besser2" and fixed["options"][3] == "besser3"


def test_cloze_repair_freezes_correct_answer_even_for_unsupported_correct_answer_issue():
    """UNSUPPORTED_CORRECT_ANSWER means the verifier thinks the marked
    answer doesn't fit — but that answer came from Stage A, and Stage B
    repair must never be the thing that silently overwrites Stage A truth
    (see generate_language_elements_part's module docstring / point 6)."""
    part = _sprachbausteine_part()
    original = {
        "questionId": "q5", "gapId": "g5", "category": "lexicon", "skillTags": ["lexical_choice"],
        "difficulty": "c1", "options": ["a", "b", "richtig", "d"], "correctIndex": 2,
    }
    changed = deepcopy(original)
    changed.update(options=["a", "b", "ANDERE_ANTWORT", "d"])
    fixed = _constrain_repair(
        original, changed, [SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "doesn't fit")], part
    )
    assert fixed["options"][2] == "richtig"
    assert fixed["correctIndex"] == 2


def test_cloze_repair_leaves_non_cloze_items_on_the_mc3_path():
    """part=None (the default) must behave exactly as before this change —
    no regression for listening/reading's own repair path."""
    original = {"questionId": "q1", "skillTags": ["detail_fact"], "mc3": {
        "stem": "Original", "options": ["correct", "bad", "wrong"],
        "correctIndex": 0, "evidenceSegmentIds": ["s1"]}}
    changed = deepcopy(original)
    changed["mc3"].update(options=["changed", "plausible", "wrong"], correctIndex=1)
    fixed = _constrain_repair(original, changed, [SemanticIssue("IMPLAUSIBLE_DISTRACTOR", "error", "absurd")])
    assert fixed["mc3"]["options"][1] == "plausible"
    assert fixed["mc3"]["correctIndex"] == 0


def test_verifier_scales_max_tokens_for_high_item_count_parts(monkeypatch):
    """A live acceptance run hit VERIFIER_RESPONSE_INVALID (truncated JSON)
    specifically on Sprachbausteine's 22-item cloze part — german_exam_model
    is a gpt-5-class reasoning model whose hidden reasoning tokens share the
    same completion-token budget as the visible JSON (see llm_json.py's
    _token_limit_param), and a flat max_tokens=10000 wasn't enough headroom
    for the largest per-item judgment payload (4 optionVerdicts x 22 items).
    verify_semantic must scale the budget up for a part this size, while
    leaving a small part (like HV1's 2 items here) at the original floor."""
    from app.services import german_exam_semantic_verify as verify_mod

    captured: dict = {}

    def fake_chat_json(**kwargs):
        captured['max_tokens'] = kwargs['max_tokens']
        return _FakeResult({"passed": True, "partWideIssues": [], "items": [
            {"questionId": qid, "audit": {}, "passed": True, "issues": []}
            for qid in captured['expected_ids']
        ]})

    monkeypatch.setattr(verify_mod, "chat_json", fake_chat_json)

    hv1_part = get_part("telc_c1_hochschule", "listening", "hv1")
    hv1_content = listening._postprocess(hv1_part, _valid_hv1_content())
    captured['expected_ids'] = [q["questionId"] for q in hv1_content["questions"]]
    verify_mod.verify_semantic(hv1_part, hv1_content)
    assert captured['max_tokens'] == 10000, "a small (2-item) part must stay at the original floor"

    sb_part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    sb_questions = [
        {"questionId": f"q{i}", "gapId": f"g{i}", "options": ["a", "b", "c", "d"], "correctIndex": 0,
         "category": "grammar", "skillTags": ["grammar"], "difficulty": "c1"}
        for i in range(1, 23)
    ]
    sb_content = {
        "text": {"title": "Titel", "paragraphs": ["Ein Satz."], "gaps": [{"gapId": f"g{i}"} for i in range(1, 23)]},
        "questions": sb_questions,
    }
    captured['expected_ids'] = [q["questionId"] for q in sb_questions]
    verify_mod.verify_semantic(sb_part, sb_content)
    assert captured['max_tokens'] == 6000 + 22 * 400, "a 22-item part must get a scaled-up budget"
    assert captured['max_tokens'] > 10000


def test_targeted_repair_reverified(monkeypatch):
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content = listening._postprocess(part, _valid_hv1_content())
    before = deepcopy(content)
    issue = SemanticIssue("PARAPHRASE_TOO_LITERAL", "error", "near copy")
    calls = []

    def verify(part, value):
        calls.append(deepcopy(value))
        if len(calls) == 1:
            return SemanticVerificationResult(False, [], [ItemSemanticResult("q1", False, [issue])])
        return _passing_semantic_result(part, value)

    def repair(part, value, issues):
        assert set(issues) == {"q1"}
        result = deepcopy(value)
        result["questions"][0]["prompt"] = "Paraphrased"
        return result, [{"itemId": "q1", "code": issue.code}]

    monkeypatch.setattr(listening, "verify_semantic", verify)
    monkeypatch.setattr(listening, "repair_items_semantic", repair)
    result, meta, passed = listening._semantic_phase(part, content)
    assert passed and meta["verificationCount"] == 2
    assert result["segments"] == before["segments"]
    assert result["questions"][1:] == before["questions"][1:]
    assert meta["issuesResolved"]


def test_semantic_exhaustion_never_returns_content(monkeypatch):
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    calls = []
    def generate(**kwargs):
        calls.append(1)
        return _FakeResult(_valid_hv1_content())
    monkeypatch.setattr(listening, "chat_json", generate)
    monkeypatch.setattr(listening, "verify_semantic", lambda *args: SemanticVerificationResult(
        False, [SemanticIssue("PART_WIDE_INCOHERENCE", "error", "overlapping speakers")]))
    with pytest.raises(listening.ListeningGenerationError):
        listening.generate_listening_part(get_profile("telc_c1_hochschule"), part, [], {"label": "Campus"})
    assert len(calls) == 3


@pytest.mark.parametrize("break_structure", [False, True])
def test_unresolved_repairs_are_not_reported_resolved(monkeypatch, break_structure):
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content = listening._postprocess(part, _valid_hv1_content())
    issue = SemanticIssue("AMBIGUOUS_MAPPING", "error", "two speakers match")
    calls = []
    def verify(*args):
        calls.append(1)
        return SemanticVerificationResult(False, [], [ItemSemanticResult("q1", False, [issue])])
    def repair(part, content, issues):
        result = deepcopy(content)
        if break_structure:
            result["questions"].pop()
        return result, [{"itemId": "q1", "code": issue.code}]
    monkeypatch.setattr(listening, "verify_semantic", verify)
    monkeypatch.setattr(listening, "repair_items_semantic", repair)
    _, meta, passed = listening._semantic_phase(part, content)
    assert not passed
    assert meta["issuesResolved"] == []
    assert len(calls) == (1 if break_structure else 3)


def test_verifier_failure_is_closed(monkeypatch):
    from app.services import german_exam_semantic_verify as mod
    def unavailable(**kwargs):
        raise RuntimeError("provider unavailable")
    monkeypatch.setattr(mod, "chat_json", unavailable)
    result = mod.verify_semantic(get_part("telc_c1_hochschule", "listening", "hv1"), _valid_hv1_content())
    assert not result.passed
    assert result.part_wide_issues[0].code == "VERIFIER_RESPONSE_INVALID"


@pytest.mark.parametrize("part_id,code", [
    ("hv1", "AMBIGUOUS_MAPPING"), ("hv1", "PARAPHRASE_TOO_LITERAL"),
    ("hv1", "IMPLAUSIBLE_DISTRACTOR"),
    ("hv2", "MULTIPLE_DEFENSIBLE_ANSWERS"), ("hv2", "UNSUPPORTED_CORRECT_ANSWER"),
    ("hv2", "IMPLAUSIBLE_DISTRACTOR"), ("hv2", "QUESTION_NOT_ANSWERABLE"),
    ("hv3", "DUPLICATE_INFORMATION"), ("hv3", "UNSUPPORTED_CORRECT_ANSWER"),
    ("hv3", "TRIVIAL_ITEM"), ("hv3", "INSUFFICIENT_SOURCE_CONTENT"),
])
def test_batched_verifier_reports_controlled_failure_classes(monkeypatch, part_id, code):
    from app.services import german_exam_semantic_verify as mod
    from german_exam_semantic_fixtures import bad_content
    calls = []
    content = bad_content(part_id, code)
    def judge(**kwargs):
        calls.append(kwargs)
        return _FakeResult({"passed": False, "partWideIssues": [], "items": [
            {"questionId": q["questionId"], "passed": index != 0,
             "issues": [{"code": code, "severity": "error", "message": "Fixture failure",
                         "evidence": {"segmentIds": ["s1"]}}] if index == 0 else []}
            for index, q in enumerate(content["questions"])]})
    monkeypatch.setattr(mod, "chat_json", judge)
    result = mod.verify_semantic(get_part("telc_c1_hochschule", "listening", part_id), content)
    assert not result.passed and len(calls) == 1
    assert result.items[0].issues[0].code == code
    assert "spokenText" in calls[0]["user"] and "blueprint" in calls[0]["user"]


@pytest.mark.parametrize("part_id,audit,expected", [
    ("hv1", {"supportedSpeakerIds": ["speaker_1", "speaker_2"], "plausible": True}, "AMBIGUOUS_MAPPING"),
    ("hv1", {}, "VERIFIER_RESPONSE_INVALID"),
    ("hv2", {"optionVerdicts": ["supported", "implausible_wrong", "plausible_wrong"]}, "IMPLAUSIBLE_DISTRACTOR"),
    ("hv2", {"optionVerdicts": ["supported", "supported", "plausible_wrong"]}, "MULTIPLE_DEFENSIBLE_ANSWERS"),
    ("hv2", {"optionVerdicts": ["plausible_wrong", "supported", "plausible_wrong"]}, "UNSUPPORTED_CORRECT_ANSWER"),
    ("hv3", {"duplicateItemIds": ["q2"]}, "DUPLICATE_INFORMATION"),
])
def test_explicit_audit_cannot_be_overridden_by_pass_flag(part_id, audit, expected):
    from app.services.german_exam_semantic_verify import _apply_audits
    from german_exam_semantic_fixtures import bad_content
    content = bad_content(part_id, {"hv1": "AMBIGUOUS_MAPPING", "hv2": "BASE", "hv3": "DUPLICATE_INFORMATION"}[part_id])
    parsed = SemanticVerificationResult(True, [], [ItemSemanticResult("q1", True)])
    data = {"items": [{"questionId": "q1", "audit": audit}]}
    result = _apply_audits(parsed, data, get_part("telc_c1_hochschule", "listening", part_id), content)
    assert not result.passed
    assert result.items[0].issues[0].code == expected


def test_cross_item_findings_stay_targeted():
    data = response()
    data["passed"] = False
    data["partWideIssues"] = [{"code": "DUPLICATE_INFORMATION", "severity": "error",
                                "evidence": {"questionIds": ["q1"]}}]
    result = _parse_result(data, {"q1"})
    assert not result.passed
    assert not result.part_wide_error_issues()
    assert "q1" in result.item_error_issues()


def test_unusable_verifier_response_retries_frozen_content(monkeypatch):
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    content = listening._postprocess(part, _valid_hv1_content())
    calls = []
    def verify(part, value):
        calls.append(deepcopy(value))
        return _parse_result(None, set()) if len(calls) == 1 else _passing_semantic_result(part, value)
    monkeypatch.setattr(listening, "verify_semantic", verify)
    _, meta, passed = listening._semantic_phase(part, content)
    assert passed and meta["verificationCount"] == 2 and meta["repairCount"] == 0
    assert calls[0] == calls[1]
