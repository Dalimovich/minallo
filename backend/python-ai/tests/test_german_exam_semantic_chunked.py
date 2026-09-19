"""Chunked orchestration of the existing semantic verifier (transport only)."""

from __future__ import annotations

import inspect
import threading
import time
from types import SimpleNamespace

import pytest

from app.services import gen_timing
from app.services import german_exam_semantic_chunked as ch
from app.services.german_exam_semantic_verify import (
    ItemSemanticResult,
    SemanticIssue,
    SemanticVerificationResult,
)

PART = SimpleNamespace(task_type="cloze_mc4_language_elements")
IDS = [f"q{i}" for i in range(1, 23)]


def _content(n=22):
    return {"text": {"title": "t", "paragraphs": ["p"], "gaps": []},
            "questions": [{"questionId": f"q{i}", "gapId": f"g{i}"} for i in range(1, n + 1)]}


def _ok(ids, usage=None):
    return SemanticVerificationResult(True, [], [ItemSemanticResult(i, True, []) for i in ids],
                                      usage=usage or {"completionTokens": 100, "reasoningTokens": 60})


def _invalid():
    return SemanticVerificationResult(False, [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "bad")])


class Fake:
    """Records every call; per-call behavior chosen by a predicate on the chunk's ids."""

    def __init__(self, behave=None, delays=None):
        self.calls: list[tuple[list[str], int | None]] = []
        self.lock = threading.Lock()
        self.behave = behave or (lambda ids, n: "ok")
        self.delays = delays or {}

    def __call__(self, part, content, max_tokens=None):
        ids = [q["questionId"] for q in content["questions"]]
        with self.lock:
            self.calls.append((ids, max_tokens))
            n = len(self.calls)
        time.sleep(self.delays.get(ids[0], 0))
        mode = self.behave(ids, n)
        if mode == "ok":
            return _ok(ids)
        if mode == "invalid":
            return _invalid()
        if mode == "reject":
            issue = SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "doesn't fit")
            items = [ItemSemanticResult(i, i != ids[1], [issue] if i == ids[1] else []) for i in ids]
            return SemanticVerificationResult(False, [], items, usage={"completionTokens": 90, "reasoningTokens": 40})
        if mode == "missing":
            return _ok(ids[:-1])
        if mode == "duplicate":
            return _ok(ids + [ids[0]])
        if mode == "unexpected":
            return _ok(ids[:-1] + ["q99"])
        raise AssertionError(mode)


def test_a_partition_is_8_7_7_in_order():
    assert ch.split_sizes(22, 3) == [8, 7, 7]
    f = Fake()
    ch.verify_semantic_chunked(PART, _content(), f)
    sizes = sorted(len(ids) for ids, _ in f.calls)
    assert sizes == [7, 7, 8]
    ordered = sorted(f.calls, key=lambda c: int(c[0][0][1:]))
    assert [i for ids, _ in ordered for i in ids] == IDS


def test_b_every_primary_call_gets_the_fixed_8000_token_cap():
    assert ch.SPRACHBAUSTEINE_VERIFIER_CHUNK_MAX_TOKENS == 8000
    f = Fake()
    ch.verify_semantic_chunked(PART, _content(), f)
    assert [cap for _, cap in f.calls] == [8000, 8000, 8000]


def test_c_results_are_merged_in_original_order_not_completion_order():
    # chunk 2 (q16..) finishes first, chunk 0 second, chunk 1 last
    f = Fake(delays={"q16": 0.0, "q1": 0.15, "q9": 0.3})
    result = ch.verify_semantic_chunked(PART, _content(), f)
    assert [i.item_id for i in result.items] == IDS
    assert result.passed is True


def test_d_all_successful_returns_the_single_call_result_shape():
    result = ch.verify_semantic_chunked(PART, _content(), Fake())
    assert isinstance(result, SemanticVerificationResult)
    assert result.passed and result.part_wide_issues == [] and len(result.items) == 22
    assert result.usage == {"completionTokens": 300, "reasoningTokens": 180}


def test_e_semantic_rejection_is_not_retried_or_split():
    f = Fake(behave=lambda ids, n: "reject" if ids[0] == "q9" else "ok")
    result = ch.verify_semantic_chunked(PART, _content(), f)
    assert len(f.calls) == 3, "a legitimate semantic rejection must not trigger a fallback"
    errors = result.item_error_issues()
    assert list(errors) == ["q10"] and errors["q10"][0].code == "UNSUPPORTED_CORRECT_ANSWER"
    assert result.passed is False
    assert not any(i.code == "VERIFIER_RESPONSE_INVALID" for it in result.items for i in it.issues)


def test_f_one_structural_failure_splits_only_that_chunk():
    f = Fake(behave=lambda ids, n: "invalid" if len(ids) == 7 and ids[0] == "q9" and len(f.calls) <= 3 else "ok")
    result = ch.verify_semantic_chunked(PART, _content(), f)
    assert len(f.calls) == 5
    first_three = {tuple(ids) for ids, _ in f.calls[:3]}
    assert tuple(IDS[:8]) in first_three and tuple(IDS[15:]) in first_three
    for kept in (tuple(IDS[:8]), tuple(IDS[15:])):
        assert sum(1 for ids, _ in f.calls if tuple(ids) == kept) == 1, "successful chunks are never re-run"
    fallback = f.calls[3:]
    assert sorted(len(ids) for ids, _ in fallback) == [3, 4]
    assert [cap for _, cap in fallback] == [8000, 8000], "fallback halves each get the full cap, not a share of it"
    assert [i.item_id for i in result.items] == IDS and result.passed


def test_g_failed_fallback_half_fails_cleanly_with_no_further_split():
    f = Fake(behave=lambda ids, n: "invalid" if ids[0] == "q9" or ids[0] == "q13" else "ok")
    result = ch.verify_semantic_chunked(PART, _content(), f)
    assert len(f.calls) == 5, "3 primary + 2 fallback halves, no third level"
    assert [cap for _, cap in f.calls] == [8000] * 5
    assert result.passed is False and result.items == []
    assert result.part_wide_issues[0].code == "VERIFIER_RESPONSE_INVALID"
    assert result.terminal_verifier_failure is True


@pytest.mark.parametrize("mode,reason", [("missing", "gap_id_mismatch"), ("duplicate", "duplicate_gap_id"), ("unexpected", "gap_id_mismatch")])
def test_h_i_j_bad_ids_are_structural_failures(mode, reason):
    ids = ["q1", "q2", "q3"]
    bad = {"missing": _ok(ids[:-1]), "duplicate": _ok(ids + ["q1"]), "unexpected": _ok(ids[:-1] + ["q99"])}[mode]
    assert ch._structural_failure_reason(bad, ids) == reason
    # and end to end: the chunk falls back once instead of being trusted
    f = Fake(behave=lambda i, n: mode if i[0] == "q1" and len(f.calls) <= 3 and len(i) == 8 else "ok")
    result = ch.verify_semantic_chunked(PART, _content(), f)
    assert len(f.calls) == 5 and [i.item_id for i in result.items] == IDS


def test_k_request_deadline_cancels_and_raises_the_budget_error():
    def slow(part, content, max_tokens=None):
        time.sleep(3)
        return _ok([q["questionId"] for q in content["questions"]])

    started = time.perf_counter()
    with gen_timing.timed_request("language_elements", "sprachbausteine_1", budget_s=0.4):
        with pytest.raises(gen_timing.GenerationBudgetExceeded):
            ch.verify_semantic_chunked(PART, _content(), slow)
    assert time.perf_counter() - started < 2.0, "must not wait for the slow calls"


def test_l_no_sdk_retries_are_reintroduced():
    from app.services import llm_json

    assert "max_retries" not in inspect.getsource(ch)
    assert "with_options(max_retries=0)" in inspect.getsource(llm_json.chat_json)


def test_existing_verifier_receives_the_cap_and_keeps_model_and_effort(monkeypatch):
    from app.config import get_settings
    from app.services import german_exam_semantic_verify as sv
    from app.services.german_exam_profiles import get_part

    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    seen = {}

    def fake_chat_json(**kw):
        seen.update(kw)
        return SimpleNamespace(data=None, completion_tokens=0, reasoning_tokens=0)

    monkeypatch.setattr(sv, "chat_json", fake_chat_json)
    questions = [{"questionId": f"q{i}", "gapId": f"g{i}", "options": ["a", "b", "c", "d"], "correctIndex": 0,
                  "category": "grammar", "skillTags": ["grammar"], "difficulty": "c1"} for i in range(1, 9)]
    content = {"text": {"title": "t", "paragraphs": ["p"], "gaps": []}, "questions": questions}
    sv.verify_semantic(part, content, max_tokens=5382)
    assert seen["max_tokens"] == 5382
    model = get_settings().german_exam_model
    assert seen["model"] == model
    assert seen["reasoning_effort"] == ("medium" if model.startswith("gpt-5") else None)
    sv.verify_semantic(part, _full_content(questions))  # default cap for the unchunked call is unchanged
    assert seen["max_tokens"] == max(10000, 6000 + 22 * 400) == 14800


def _full_content(base):
    qs = [dict(base[0], questionId=f"q{i}", gapId=f"g{i}") for i in range(1, 23)]
    return {"text": {"title": "t", "paragraphs": ["p"], "gaps": []}, "questions": qs}


def test_small_parts_still_use_one_call():
    f = Fake()
    result = ch.verify_semantic_chunked(PART, _content(6), f)
    assert len(f.calls) == 1 and f.calls[0][1] is None and result.passed


def test_production_check_does_not_use_the_experimental_chunk_wrapper(monkeypatch):
    """The 8/7/7 wrapper is dormant: Sprachbausteine's check() verifies the whole part in
    ONE call through verify_semantic, exactly as before the chunking experiment."""
    from tests.test_german_exam_language_elements import (
        _gap_specs, _profile_and_part, _setup, _stage_a_content, _stage_b_payload,
    )

    specs = _gap_specs()
    mod, _ = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    calls = []

    def verify(part, content, **kw):
        calls.append((len(content["questions"]), kw))
        return _ok([q["questionId"] for q in content["questions"]])

    monkeypatch.setattr(mod, "verify_semantic", verify)
    profile, part = _profile_and_part()
    mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert calls == [(22, {})], "one whole-part call, no max_tokens override, no chunking"
    assert "verify_semantic_chunked" not in inspect.getsource(mod)
    assert "terminal_verifier_failure" not in inspect.getsource(mod)


def test_check_retry_for_an_invalid_verifier_response_is_the_original_single_pass_behavior(monkeypatch):
    from tests.test_german_exam_language_elements import (
        _gap_specs, _profile_and_part, _setup, _stage_a_content, _stage_b_payload,
    )

    specs = _gap_specs()
    mod, _ = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    calls = []

    def verify(part, content, **kw):
        calls.append(len(content["questions"]))
        return _invalid() if len(calls) == 1 else _ok([q["questionId"] for q in content["questions"]])

    monkeypatch.setattr(mod, "verify_semantic", verify)
    profile, part = _profile_and_part()
    mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert calls == [22, 22]
