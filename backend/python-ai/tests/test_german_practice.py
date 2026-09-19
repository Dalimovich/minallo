from types import SimpleNamespace

import pytest

from app.services import german_practice as gp


def _note():
    return {"focus": "f", "think": "t", "why": "w", "mainRule": "m", "example": "e"}


def _vocab_context(n=0):
    return {"type": "context", "promptHtml": f"Ich muss die Arbeit {n} ___.", "accepted": ["Abgeben."], "note": _note(), "hints": ["a", "b"]}


def _llm(items_by_call):
    calls = iter(items_by_call)

    def fake(**kwargs):
        return SimpleNamespace(data={"items": next(calls)})

    return fake


def test_vocab_context_normalises_accepted_and_escapes_prompt():
    item = gp._validate_vocab({**_vocab_context(), "promptHtml": "Ich <b>muss</b> ___."})
    assert item["accepted"] == ["abgeben"]
    assert "<b>" not in item["promptHtml"]


@pytest.mark.parametrize("bad", [
    {**_vocab_context(), "promptHtml": "no blank"},
    {**_vocab_context(), "promptHtml": "two ___ blanks ___"},
    {**_vocab_context(), "accepted": []},
    {**_vocab_context(), "note": {"focus": "only"}},
    {"type": "choice", "promptHtml": "a ___", "options": ["x", "x", "y", "z"], "answerIndex": 0, "note": _note(), "hints": ["h"]},
    {"type": "choice", "promptHtml": "a ___", "options": ["w", "x", "y", "z"], "answerIndex": 4, "note": _note(), "hints": ["h"]},
    {"type": "nope"},
])
def test_vocab_rejects_invalid(bad):
    assert gp._validate_vocab(bad) is None


def test_grammar_order_requires_matching_words():
    rule = _note()
    ok = {"type": "order", "words": ["weil", "ich", "lernen", "muss"], "answer": "weil ich lernen muss", "rule": rule, "hints": ["h"]}
    assert gp._validate_grammar(ok)["answer"] == "weil ich lernen muss"
    bad = {**ok, "answer": "weil ich schlafe muss"}
    assert gp._validate_grammar(bad) is None


def test_grammar_correct_sanitises_highlight_html():
    item = gp._validate_grammar({
        "type": "correct", "sentenceWrong": "Ich brauche es weil", "accepted": ["ich brauche es"],
        "highlightCorrect": "<script>x</script> <strong>brauche</strong>", "rule": _note(), "hints": ["h"],
    })
    assert "<script>" not in item["highlightCorrect"]
    assert "<strong>brauche</strong>" in item["highlightCorrect"]


def test_generate_drops_invalid_and_duplicates_and_retries(monkeypatch):
    first = [_vocab_context(1), _vocab_context(1), {"type": "context", "promptHtml": "bad"}]
    second = [_vocab_context(2), _vocab_context(3), _vocab_context(4)]
    monkeypatch.setattr(gp, "chat_json", _llm([first, second]))
    out = gp.generate_practice(user_id="u", module="vocabulary", level="B1", topic="Uni", count=4)
    assert out["schema"] == "german-practice-v1"
    assert out["source"] == "ai"
    assert len(out["items"]) == 4
    assert len({i["id"] for i in out["items"]}) == 4


def test_generate_fails_when_too_few_valid(monkeypatch):
    monkeypatch.setattr(gp, "chat_json", _llm([[{"type": "context"}], [{"type": "context"}]]))
    with pytest.raises(gp.PracticeError):
        gp.generate_practice(user_id="u", module="vocabulary", level="B1", topic="Uni", count=5)


def test_no_exam_profile_needed(monkeypatch):
    monkeypatch.setattr(gp, "chat_json", _llm([[_vocab_context(i) for i in range(5)]]))
    out = gp.generate_practice(user_id="u", module="vocabulary", level="A2", topic="Alltag", count=5)
    assert out["level"] == "A2" and len(out["items"]) == 5


def test_source_not_ready(monkeypatch):
    monkeypatch.setattr(gp, "_load_source_text", lambda *_: (_ for _ in ()).throw(gp.SourceNotReadyError("x")))
    with pytest.raises(gp.SourceNotReadyError):
        gp.generate_practice(user_id="u", module="grammar", level="B1", topic="t", count=5, source_document_ids=["d"])


# ── validator rejection reasons (safe codes only) ──────────────────────────

def test_rejection_reasons_are_content_free_codes():
    from app.services import german_practice as gp

    def reason(raw, check=gp._check_vocab):
        try:
            check(raw)
        except gp._Reject as r:
            return r.code
        return None

    good_note = {"focus": "f", "think": "t", "why": "w", "mainRule": "m", "example": "e"}
    assert reason({"type": "context", "promptHtml": "Er ___ Brot.", "accepted": ["isst"], "hints": ["a"]}) == "missing_note"
    assert reason({"type": "context", "note": {**good_note, "think": ""}, "promptHtml": "x ___", "accepted": ["a"], "hints": ["a"]}) == "missing_note_think"
    assert reason({"type": "context", "note": good_note, "promptHtml": "kein Blank", "accepted": ["a"], "hints": ["a"]}) == "invalid_gap_count"
    assert reason({"type": "context", "note": good_note, "promptHtml": "x ___", "accepted": ["a"]}) == "missing_hints"
    assert reason({"type": "bogus", "note": good_note, "hints": ["h"]}) == "unknown_type"
    assert reason({"type": "choice", "note": good_note, "promptHtml": "x ___", "options": ["a", "b", "c"], "answerIndex": 0, "hints": ["h"]}) == "invalid_options_count"
    assert reason({"type": "choice", "note": good_note, "promptHtml": "x ___", "options": ["a", "a", "b", "c"], "answerIndex": 0, "hints": ["h"]}) == "duplicate_options"
    assert reason({"type": "choice", "note": good_note, "promptHtml": "x ___", "options": ["a", "b", "c", "d"], "answerIndex": 9, "hints": ["h"]}) == "invalid_answer_index"
    assert reason({"type": "gap", "rule": {**good_note, "why": ""}, "hints": ["h"]}, gp._check_grammar) == "missing_rule_why"
    assert reason({"type": "order", "rule": good_note, "hints": ["h"], "words": ["a", "b"], "answer": "a b"}, gp._check_grammar) == "invalid_order_words"


def test_generation_records_aggregated_rejections_without_content(monkeypatch):
    from types import SimpleNamespace

    from app.services import gen_timing, german_practice as gp

    bad = {"type": "context", "promptHtml": "Er ___ Brot.", "accepted": ["isst"], "hints": ["a"], "note": {"focus": "f"}}
    monkeypatch.setattr(gp, "chat_json", lambda **kw: SimpleNamespace(data={"items": [bad] * 5}))
    with gen_timing.timed_request("vocabulary", budget_s=30) as timer:
        try:
            gp.generate_practice(user_id="u", module="vocabulary", level="B2", topic="t", count=5)
        except gp.PracticeError:
            pass
        summary = timer.summary("invalid_output")
    assert summary["validation"][0]["rawItems"] == 5 and summary["validation"][0]["validItems"] == 0
    assert summary["validation"][0]["rejected"] == {"missing_note_think": 5}
    assert "Brot" not in str(summary)


def test_failure_response_is_structured_json_with_reference():
    import json

    from app.services import gen_timing

    with gen_timing.timed_request("vocabulary", budget_s=30) as timer:
        resp = gen_timing.failure_response(timer, "invalid_output", 502, "Could not create enough valid exercises.")
    body = json.loads(resp.body)
    assert resp.status_code == 502 and resp.media_type == "application/json"
    assert body["requestId"] == timer.request_id and f"(ref {timer.request_id})" in body["detail"]
    assert body["diagnostics"]["outcome"] == "invalid_output"
