"""Phase 2.6: targeted HV2/HV3 semantic adjudication. Python derives the
issue code from a narrow factual audit — never trusts a free-text verdict
from the model, and fails closed on any malformed/incomplete/contradictory
response, matching the main verifier's audit-first philosophy."""
from app.services import german_exam_semantic_adjudicate as adj
from app.services.german_exams import get_part

HV1 = get_part("telc_c1_hochschule", "listening", "hv1")
HV2 = get_part("telc_c1_hochschule", "listening", "hv2")
HV3 = get_part("telc_c1_hochschule", "listening", "hv3")


class _FakeResult:
    def __init__(self, data) -> None:
        self.data = data
        self.model = "stub-model"
        self.prompt_tokens = 10
        self.completion_tokens = 10


def _hv2_content():
    return {
        "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "..."}],
        "questions": [
            {"questionId": f"q{i}", "skillTags": ["detail_fact"], "difficulty": "c1",
             "mc3": {"stem": f"Stem {i}", "options": ["A", "B", "C"], "correctIndex": 0, "evidenceSegmentIds": ["s1"]}}
            for i in range(1, 3)
        ],
    }


def _hv3_content():
    return {
        "segments": [{"id": "s1", "speakerId": "speaker_1", "spokenText": "Lecture..."}],
        "questions": [
            {"questionId": f"q{i}", "skillTags": ["note_taking"], "difficulty": "c1",
             "note": {"fieldLabel": f"Field {i}", "outlineContext": "...", "correctFill": f"answer {i}", "evidenceSegmentIds": ["s1"]}}
            for i in range(1, 3)
        ],
    }


# ── _derive_hv2 ──────────────────────────────────────────────────────────

def test_derive_hv2_clean():
    q = _hv2_content()["questions"][0]
    audit = {"supportedOptionIndexes": [0], "implausibleDistractorIndexes": [], "answerableFromTranscript": True}
    assert adj._derive_hv2(q, audit) == []


def test_derive_hv2_unsupported_correct_answer():
    q = _hv2_content()["questions"][0]
    audit = {"supportedOptionIndexes": [1], "implausibleDistractorIndexes": [], "answerableFromTranscript": True}
    codes = [i.code for i in adj._derive_hv2(q, audit)]
    assert codes == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_derive_hv2_multiple_defensible():
    q = _hv2_content()["questions"][0]
    audit = {"supportedOptionIndexes": [0, 1], "implausibleDistractorIndexes": [], "answerableFromTranscript": True}
    codes = [i.code for i in adj._derive_hv2(q, audit)]
    assert codes == ["MULTIPLE_DEFENSIBLE_ANSWERS"]


def test_derive_hv2_implausible_distractor():
    q = _hv2_content()["questions"][0]
    audit = {"supportedOptionIndexes": [0], "implausibleDistractorIndexes": [2], "answerableFromTranscript": True}
    codes = [i.code for i in adj._derive_hv2(q, audit)]
    assert codes == ["IMPLAUSIBLE_DISTRACTOR"]


def test_derive_hv2_not_answerable():
    q = _hv2_content()["questions"][0]
    audit = {"supportedOptionIndexes": [0], "implausibleDistractorIndexes": [], "answerableFromTranscript": False}
    codes = [i.code for i in adj._derive_hv2(q, audit)]
    assert codes == ["QUESTION_NOT_ANSWERABLE"]


def test_derive_hv2_self_contradictory_fails_closed():
    q = _hv2_content()["questions"][0]  # correctIndex=0
    audit = {"supportedOptionIndexes": [0], "implausibleDistractorIndexes": [0], "answerableFromTranscript": True}
    codes = [i.code for i in adj._derive_hv2(q, audit)]
    assert codes == ["VERIFIER_RESPONSE_INVALID"]


def test_derive_hv2_malformed_audit_fails_closed():
    q = _hv2_content()["questions"][0]
    for bad in ({}, {"supportedOptionIndexes": "not a list"}, {"supportedOptionIndexes": [5], "implausibleDistractorIndexes": [], "answerableFromTranscript": True}, None, "nope"):
        codes = [i.code for i in adj._derive_hv2(q, bad)]
        assert codes == ["VERIFIER_RESPONSE_INVALID"], bad


# ── _derive_hv3 ──────────────────────────────────────────────────────────

def test_derive_hv3_clean():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": True, "alternativeValidAnswers": [], "duplicateWithItemIds": [], "noteworthyInformation": True}
    assert adj._derive_hv3("q1", questions, audit) == []


def test_derive_hv3_unsupported():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": False, "alternativeValidAnswers": [], "duplicateWithItemIds": [], "noteworthyInformation": True}
    codes = [i.code for i in adj._derive_hv3("q1", questions, audit)]
    assert codes == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_derive_hv3_trivial():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": True, "alternativeValidAnswers": [], "duplicateWithItemIds": [], "noteworthyInformation": False}
    codes = [i.code for i in adj._derive_hv3("q1", questions, audit)]
    assert codes == ["TRIVIAL_ITEM"]


def test_derive_hv3_multiple_defensible():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": True, "alternativeValidAnswers": ["other phrasing"], "duplicateWithItemIds": [], "noteworthyInformation": True}
    codes = [i.code for i in adj._derive_hv3("q1", questions, audit)]
    assert codes == ["MULTIPLE_DEFENSIBLE_ANSWERS"]


def test_derive_hv3_duplicate():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": True, "alternativeValidAnswers": [], "duplicateWithItemIds": ["q2"], "noteworthyInformation": True}
    codes = [i.code for i in adj._derive_hv3("q1", questions, audit)]
    assert codes == ["DUPLICATE_INFORMATION"]


def test_derive_hv3_duplicate_referencing_self_or_unknown_fails_closed():
    questions = {"q1": {}, "q2": {}}
    for bad_dupe in (["q1"], ["q99"]):
        audit = {"answerSupported": True, "alternativeValidAnswers": [], "duplicateWithItemIds": bad_dupe, "noteworthyInformation": True}
        codes = [i.code for i in adj._derive_hv3("q1", questions, audit)]
        assert codes == ["VERIFIER_RESPONSE_INVALID"], bad_dupe


def test_derive_hv3_multiple_codes_can_combine():
    questions = {"q1": {}, "q2": {}}
    audit = {"answerSupported": False, "alternativeValidAnswers": [], "duplicateWithItemIds": ["q2"], "noteworthyInformation": True}
    codes = sorted(i.code for i in adj._derive_hv3("q1", questions, audit))
    assert codes == ["DUPLICATE_INFORMATION", "UNSUPPORTED_CORRECT_ANSWER"]


# ── adjudicate_items ─────────────────────────────────────────────────────

def test_adjudicate_items_returns_none_for_hv1():
    assert adj.adjudicate_items(HV1, {"segments": [], "questions": []}, set()) is None


def test_adjudicate_items_hv2_derives_from_response(monkeypatch):
    content = _hv2_content()
    ids = {"q1", "q2"}

    def fake_chat_json(**kwargs):
        return _FakeResult({"items": [
            {"questionId": "q1", "supportedOptionIndexes": [0], "implausibleDistractorIndexes": [], "answerableFromTranscript": True},
            {"questionId": "q2", "supportedOptionIndexes": [1], "implausibleDistractorIndexes": [], "answerableFromTranscript": True},
        ]})

    monkeypatch.setattr(adj, "chat_json", fake_chat_json)
    result = adj.adjudicate_items(HV2, content, ids)
    assert result["q1"] == []
    assert [i.code for i in result["q2"]] == ["UNSUPPORTED_CORRECT_ANSWER"]


def test_adjudicate_items_call_failure_fails_closed_for_all(monkeypatch):
    content = _hv2_content()
    ids = {"q1", "q2"}

    def raising(**kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(adj, "chat_json", raising)
    result = adj.adjudicate_items(HV2, content, ids)
    assert set(result.keys()) == ids
    for issues in result.values():
        assert [i.code for i in issues] == ["VERIFIER_RESPONSE_INVALID"]


def test_adjudicate_items_omitted_item_fails_closed(monkeypatch):
    content = _hv3_content()
    ids = {"q1", "q2"}

    def fake_chat_json(**kwargs):
        return _FakeResult({"items": [
            {"questionId": "q1", "answerSupported": True, "alternativeValidAnswers": [], "duplicateWithItemIds": [], "noteworthyInformation": True},
        ]})

    monkeypatch.setattr(adj, "chat_json", fake_chat_json)
    result = adj.adjudicate_items(HV3, content, ids)
    assert result["q1"] == []
    assert [i.code for i in result["q2"]] == ["VERIFIER_RESPONSE_INVALID"]


def test_adjudicate_items_malformed_top_level_fails_closed_for_all(monkeypatch):
    content = _hv3_content()
    ids = {"q1", "q2"}
    monkeypatch.setattr(adj, "chat_json", lambda **kwargs: _FakeResult({"notItems": []}))
    result = adj.adjudicate_items(HV3, content, ids)
    for issues in result.values():
        assert [i.code for i in issues] == ["VERIFIER_RESPONSE_INVALID"]
