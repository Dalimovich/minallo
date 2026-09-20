"""Tests for the constraint-decomposed Sprachbausteine pipeline (see the
module docstring on german_exam_language_elements.py for why this replaced
one monolithic 22-item generation call). Mocks each stage's LLM call
(_call_stage_a / _call_passage_repair / _call_stage_b / _call_item_repair)
independently so tests can exercise one stage's repair path without the
others — this is the whole point of the decomposition: a word-count miss in
Stage A must never touch Stage B, and one bad distractor set in Stage B must
never touch the (already-valid, expensive) Stage A passage."""

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


def _passing_semantic_result(part, content, **kw):
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult

    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content.get("questions") or []]
    return SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)


def _gap_specs():
    from app.services.german_exam_language_elements import _build_gap_specs
    return _build_gap_specs(22)


def _stage_a_content(gap_specs, word_count: int = 330) -> dict:
    """A structurally valid Stage A response in the TAGGED representation: every gap is one
    "{{gN::answer}}" marker, all present exactly once in reading order. The total word count
    (each tagged gap = ONE word, like the public placeholder the real validator counts) is
    controllable for the repair-path tests. There is no separate answers list any more."""
    filler_count = max(len(gap_specs), word_count - len(gap_specs))
    filler = ["Wort"] * filler_count
    per_gap = max(1, len(filler) // len(gap_specs))
    tokens: list[str] = []
    fi = 0
    for g in gap_specs:
        tokens.extend(filler[fi:fi + per_gap])
        fi += per_gap
        tokens.append("{{" + g["gapId"] + "::antwort_" + g["gapId"] + "}}")
    tokens.extend(filler[fi:])
    return {"text": {"title": "Titel", "paragraphs": [" ".join(tokens)]}}


def _public_text(gap_specs, word_count: int = 330) -> dict:
    """The materialized (student-visible) text of _stage_a_content: plain {{gN}} placeholders."""
    from app.services.german_exam_language_elements import _materialize_stage_a_text
    return _materialize_stage_a_text(_stage_a_content(gap_specs, word_count)["text"], gap_specs)[0]


def _stage_b_payload(gap_specs, bad_gap_id: str | None = None) -> dict:
    items = []
    for i, g in enumerate(gap_specs):
        from app.services.german_exam_language_elements import _CATEGORY_SKILL_TAGS
        if g["gapId"] == bad_gap_id:
            wrong = ["falsch", "falsch", "falsch"]  # duplicate -> invalid
        else:
            wrong = [f"falsch1_{i}", f"falsch2_{i}", f"falsch3_{i}"]
        items.append({
            "questionId": g["questionId"], "gapId": g["gapId"], "wrongOptions": wrong,
            "skillTags": [_CATEGORY_SKILL_TAGS[g["category"]][0]],
        })
    return {"items": items}


def _setup(
    monkeypatch: pytest.MonkeyPatch, *, stage_a_calls, stage_b_calls=None, passage_repair=None, item_repair=None,
    missing_gap_repair=None
):
    import app.services.german_exam_language_elements as mod

    counters = {"stage_a": 0, "stage_b": 0, "passage_repair": 0, "item_repair": 0, "missing_gap_repair": 0}

    def _stage_a(**kwargs):
        i = counters["stage_a"]
        counters["stage_a"] += 1
        return _FakeResult(stage_a_calls[min(i, len(stage_a_calls) - 1)])

    def _stage_b(**kwargs):
        i = counters["stage_b"]
        counters["stage_b"] += 1
        source = stage_b_calls or [_stage_b_payload(_gap_specs())]
        return _FakeResult(source[min(i, len(source) - 1)])

    def _repair(**kwargs):
        counters["passage_repair"] += 1
        if passage_repair is None:
            raise AssertionError("passage repair was not expected to be called")
        return _FakeResult(passage_repair[min(counters["passage_repair"] - 1, len(passage_repair) - 1)])

    def _item(**kwargs):
        counters["item_repair"] += 1
        if item_repair is None:
            raise AssertionError("item repair was not expected to be called")
        return _FakeResult(item_repair[min(counters["item_repair"] - 1, len(item_repair) - 1)])

    def _missing_gap(**kwargs):
        counters["missing_gap_repair"] += 1
        if missing_gap_repair is None:
            raise AssertionError("missing-gap repair was not expected to be called")
        return _FakeResult(missing_gap_repair[min(counters["missing_gap_repair"] - 1, len(missing_gap_repair) - 1)])

    monkeypatch.setattr(mod, "_call_stage_a", _stage_a)
    monkeypatch.setattr(mod, "_call_stage_b", _stage_b)
    monkeypatch.setattr(mod, "_call_passage_repair", _repair)
    monkeypatch.setattr(mod, "_call_item_repair", _item)
    monkeypatch.setattr(mod, "_call_missing_gap_repair", _missing_gap)
    monkeypatch.setattr(mod, "verify_semantic", _passing_semantic_result)
    return mod, counters


def _profile_and_part():
    from app.services.german_exams import get_profile, get_part
    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    return profile, part


# ── Backend-owned structure ──────────────────────────────────────────────

def test_category_plan_is_always_14_6_2() -> None:
    from app.services.german_exam_language_elements import _CATEGORY_PLAN
    assert dict(_CATEGORY_PLAN) == {"grammar": 14, "lexicon": 6, "orthography": 2}
    assert sum(n for _, n in _CATEGORY_PLAN) == 22


def test_exactly_22_gap_specs_covering_g1_through_g22() -> None:
    specs = _gap_specs()
    assert len(specs) == 22
    assert [s["gapId"] for s in specs] == [f"g{i}" for i in range(1, 23)]
    assert [s["questionId"] for s in specs] == [f"q{i}" for i in range(1, 23)]
    counts: dict[str, int] = {}
    for s in specs:
        counts[s["category"]] = counts.get(s["category"], 0) + 1
    assert counts == {"grammar": 14, "lexicon": 6, "orthography": 2}


def test_category_plan_validated_against_blueprint_ranges() -> None:
    from app.services.german_exam_language_elements import _validate_category_plan, LanguageElementsGenerationError
    _, part = _profile_and_part()
    _validate_category_plan(part)  # does not raise for the real blueprint

    from dataclasses import replace
    narrow = replace(part, constraints={**part.constraints, "grammarCountMax": 13})
    with pytest.raises(LanguageElementsGenerationError):
        _validate_category_plan(narrow)


# ── Stage A: passage + answers ───────────────────────────────────────────

def test_valid_stage_a_output_with_22_placeholders_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 1
    assert counters["passage_repair"] == 0
    assert meta["deterministicPassed"] is True
    assert len(content["text"]["gaps"]) == 22
    assert len(content["questions"]) == 22


def test_out_of_range_word_count_invokes_passage_repair_not_full_regeneration(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 524-word passage (structurally sound otherwise) must be repaired
    in place, never trigger a second Stage A generation call, and Stage B
    must only run once the repaired passage is within range."""
    specs = _gap_specs()
    too_long = _stage_a_content(specs, word_count=524)
    repaired = _stage_a_content(specs, word_count=330)
    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[too_long],
        passage_repair=[{"text": repaired["text"]}],
        stage_b_calls=[_stage_b_payload(specs)],
    )
    profile, part = _profile_and_part()

    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 1, "a word-count miss must not force a second full Stage A generation"
    assert counters["passage_repair"] == 1
    assert counters["stage_b"] == 1
    assert meta["semantic"]["stageA"]["regenerationCount"] == 0


def test_repaired_passage_preserves_all_gaps_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    too_long = _stage_a_content(specs, word_count=524)
    repaired = _stage_a_content(specs, word_count=330)
    mod, counters = _setup(
        monkeypatch, stage_a_calls=[too_long], passage_repair=[{"text": repaired["text"]}], stage_b_calls=[_stage_b_payload(specs)]
    )
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    gap_ids = [g["gapId"] for g in content["text"]["gaps"]]
    assert gap_ids == [f"g{i}" for i in range(1, 23)]
    question_gap_ids = sorted(q["gapId"] for q in content["questions"])
    assert question_gap_ids == sorted(gap_ids)


def test_deterministic_trim_removes_only_non_gap_sentences() -> None:
    """The free, LLM-free trim must drop whole filler sentences to reach
    range while never touching a sentence containing a placeholder."""
    from app.services.german_exam_language_elements import _trim_passage_deterministic, _passage_word_count

    specs = _gap_specs()[:2]
    gap_sentence_1 = "Der Student braucht {{g1::etwas}} fuer sein Studium."
    gap_sentence_2 = "Am Ende sagt er {{g2::alles}} klar und deutlich."
    filler_1 = "Dies ist ein zusaetzlicher Fuellsatz der ruhig entfernt werden kann heute."
    filler_2 = "Noch ein weiterer langer Fuellsatz der problemlos komplett gestrichen werden darf."
    content = {
        "text": {"title": "t", "paragraphs": [f"{gap_sentence_1} {filler_1} {gap_sentence_2} {filler_2}"]},
    }

    trimmed = _trim_passage_deterministic(content, specs, word_min=10, word_max=20)

    assert trimmed is not None
    joined = " ".join(trimmed["text"]["paragraphs"])
    assert "{{g1::etwas}}" in joined
    assert "{{g2::alles}}" in joined
    assert 10 <= _passage_word_count(trimmed) <= 20


def test_deterministic_trim_returns_none_when_nothing_removable() -> None:
    """A passage with no non-gap sentence to drop (or not enough removable
    text to reach word_min without going under) must signal failure so the
    caller falls back to the LLM-based repair, not silently overshoot."""
    from app.services.german_exam_language_elements import _trim_passage_deterministic

    specs = _gap_specs()[:1]
    content = {
        "text": {"title": "t", "paragraphs": ["Ein einziger Satz mit {{g1::etwas}} und sonst nichts drin."]},
    }

    assert _trim_passage_deterministic(content, specs, word_min=5, word_max=3) is None


def test_deterministic_trim_avoids_any_llm_repair_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """When enough removable filler sentences exist to reach the target
    range on their own, no paid passage-repair LLM call should happen at
    all — the deterministic trim must handle it for free."""
    specs = _gap_specs()
    from app.services.german_exam_language_elements import _CATEGORY_SKILL_TAGS

    gap_sentences = " ".join(f"Punkt {g['gapId']} betrifft {{{{{g['gapId']}::antwort_{g['gapId']}}}}} klar." for g in specs)
    filler_sentence = "Dies ist ein zusaetzlicher Fuellsatz der ruhig komplett entfernt werden kann heute noch."
    paragraph = gap_sentences + " " + (filler_sentence + " ") * 40
    too_long = {"text": {"title": "Titel", "paragraphs": [paragraph]}}

    mod, counters = _setup(monkeypatch, stage_a_calls=[too_long], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 1
    assert counters["passage_repair"] == 0, "deterministic sentence-trim should have handled this without an LLM call"
    gap_ids = [g["gapId"] for g in content["text"]["gaps"]]
    assert gap_ids == [f"g{i}" for i in range(1, 23)]


def test_zero_gap_stage_a_is_rejected_before_stage_b_is_ever_called(monkeypatch: pytest.MonkeyPatch) -> None:
    broken = {"text": {"title": "x", "paragraphs": ["kein einziger Platzhalter hier"]}}
    mod, counters = _setup(monkeypatch, stage_a_calls=[broken, broken])
    profile, part = _profile_and_part()

    with pytest.raises(mod.LanguageElementsGenerationError):
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 2  # exhausted the regeneration budget on structural failure
    assert counters["stage_b"] == 0, "Stage B must never be called with an invalid Stage A passage"


# ── Stage B: distractors only, backend owns correctIndex ────────────────

def test_stage_b_only_receives_an_already_valid_stage_a_passage(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    seen_answers: dict[str, list] = {}
    import app.services.german_exam_language_elements as mod

    real_prompt_stage_b = mod._prompt_stage_b

    def _spy_prompt_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id):
        seen_answers["value"] = dict(answers_by_gap)
        return real_prompt_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id)

    monkeypatch.setattr(mod, "_prompt_stage_b", _spy_prompt_stage_b)
    _mod, counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert set(seen_answers["value"]) == {s["gapId"] for s in specs}
    assert all(seen_answers["value"][s["gapId"]] == f"antwort_{s['gapId']}" for s in specs)


def test_backend_inserts_correct_answer_and_computes_correct_index(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    for q in content["questions"]:
        correct_answer = f"antwort_{q['gapId']}"
        assert q["options"][q["correctIndex"]] == correct_answer
        # the model's Stage B response never carried a correctIndex at all —
        # confirms the backend, not the LLM, placed and located the answer
        assert correct_answer in q["options"]


def test_four_final_options_are_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    for q in content["questions"]:
        assert len(q["options"]) == 4
        assert len({o.strip().lower() for o in q["options"]}) == 4


def test_one_malformed_distractor_set_repairs_only_that_item(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    bad_gap = "g5"
    payload_with_one_bad_item = _stage_b_payload(specs, bad_gap_id=bad_gap)
    fixed_item = {"wrongOptions": ["reparatur1", "reparatur2", "reparatur3"], "skillTags": ["grammar"]}

    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[payload_with_one_bad_item],
        item_repair=[fixed_item],
    )
    profile, part = _profile_and_part()

    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_b"] == 1, "one bad item must never trigger a full Stage B regeneration"
    assert counters["item_repair"] == 1, "exactly the one bad gap should have been repaired"
    assert meta["semantic"]["stageB"]["itemRepairCount"] == 1

    fixed_q = next(q for q in content["questions"] if q["gapId"] == bad_gap)
    assert set(o.lower() for o in fixed_q["options"]) == {"reparatur1", "reparatur2", "reparatur3", f"antwort_{bad_gap}"}

    # every OTHER item's options are untouched from the original Stage B payload
    other = next(it for it in payload_with_one_bad_item["items"] if it["gapId"] == "g1")
    other_q = next(q for q in content["questions"] if q["gapId"] == "g1")
    assert set(o.lower() for o in other_q["options"]) == {*[w.lower() for w in other["wrongOptions"]], "antwort_g1"}


def test_stage_a_prompt_is_unaffected_by_the_stage_b_context_change(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stage A must stay completely untouched by the Stage B context work —
    same prompt builder, same signature, still never sees categories'
    distractor rules or gap context."""
    import inspect
    import app.services.german_exam_language_elements as mod

    sig = inspect.signature(mod._prompt_stage_a)
    assert list(sig.parameters) == ["profile", "part", "plan", "topic", "gap_specs", "word_min", "word_max"]


def test_stage_b_receives_local_sentence_context_for_every_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    seen_contexts: dict[str, dict] = {}
    import app.services.german_exam_language_elements as mod

    real_prompt_stage_b = mod._prompt_stage_b

    def _spy_prompt_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id):
        seen_contexts["value"] = gap_context_by_id
        return real_prompt_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id)

    monkeypatch.setattr(mod, "_prompt_stage_b", _spy_prompt_stage_b)
    mod, counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    contexts = seen_contexts["value"]
    assert set(contexts) == {s["gapId"] for s in specs}, "every gap must get a context, none skipped"
    for gap_id, ctx in contexts.items():
        assert f"{{{{{gap_id}}}}}" in ctx["sentenceWithGap"], f"{gap_id}: sentenceWithGap must contain the literal placeholder"
        expected_answer = f"antwort_{gap_id}"
        assert expected_answer in ctx["sentenceWithCorrectAnswer"], f"{gap_id}: sentenceWithCorrectAnswer must insert the Stage A answer"
        assert f"{{{{{gap_id}}}}}" not in ctx["sentenceWithCorrectAnswer"], f"{gap_id}: placeholder must be replaced, not left literal"


def test_stage_b_prompt_text_carries_each_gaps_context(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()
    gap_context = mod._build_gap_context(_public_text(specs), specs, {s["gapId"]: f"antwort_{s['gapId']}" for s in specs})
    answers = {s["gapId"]: f"antwort_{s['gapId']}" for s in specs}

    system, _user = mod._prompt_stage_b(profile, part, specs, answers, gap_context)

    for s in specs:
        assert gap_context[s["gapId"]]["sentenceWithCorrectAnswer"] in system, f"{s['gapId']}'s local sentence must reach the Stage B prompt"


def test_item_repair_receives_context_and_prior_rejected_options_and_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    bad_gap = "g5"
    payload_with_one_bad_item = _stage_b_payload(specs, bad_gap_id=bad_gap)
    fixed_item = {"wrongOptions": ["reparatur1", "reparatur2", "reparatur3"], "skillTags": ["grammar"]}
    seen_prompts: dict[str, tuple[str, str]] = {}
    import app.services.german_exam_language_elements as mod

    real_prompt_item_repair = mod._prompt_item_repair

    def _spy_prompt_item_repair(gap_spec, correct_answer, context, prior_wrong_options, reason):
        seen_prompts["value"] = real_prompt_item_repair(gap_spec, correct_answer, context, prior_wrong_options, reason)
        assert prior_wrong_options == ["falsch", "falsch", "falsch"]
        assert reason is not None
        assert context["sentenceWithCorrectAnswer"]
        return seen_prompts["value"]

    monkeypatch.setattr(mod, "_prompt_item_repair", _spy_prompt_item_repair)
    mod, _counters = _setup(
        monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[payload_with_one_bad_item],
        item_repair=[fixed_item],
    )
    profile, part = _profile_and_part()

    mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert "value" in seen_prompts, "item repair prompt must have been built with context"
    system, _user = seen_prompts["value"]
    assert "falsch" in system, "the rejected prior options must be surfaced to the repair prompt"


def test_stage_b_never_receives_a_gap_without_context(monkeypatch: pytest.MonkeyPatch) -> None:
    """_build_gap_context's fallback path (used only if a gap's sentence
    somehow can't be located) must still produce a usable, non-empty entry
    for every gap — never a missing key."""
    import app.services.german_exam_language_elements as mod

    specs = _gap_specs()
    answers = {s["gapId"]: f"antwort_{s['gapId']}" for s in specs}
    # A passage that mentions none of the gap placeholders at all.
    broken_text = {"title": "Titel", "paragraphs": ["Ein Satz ohne jede Lücke."]}

    contexts = mod._build_gap_context(broken_text, specs, answers)

    assert set(contexts) == {s["gapId"] for s in specs}
    for gap_id, ctx in contexts.items():
        assert ctx["sentenceWithCorrectAnswer"]


def test_stage_b_repairs_only_the_bad_gap_and_never_reruns_the_whole_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    bad_gap = "g5"
    first = _stage_b_payload(specs, bad_gap_id=bad_gap)

    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[first],
        # first per-gap attempt is still invalid, the second round fixes it
        item_repair=[{"wrongOptions": ["x", "x", "x"], "skillTags": ["grammar"]},
                     {"wrongOptions": ["alpha", "beta", "gamma"], "skillTags": ["grammar"]}],
    )
    profile, part = _profile_and_part()

    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_b"] == 1, "one bad gap must not trigger a second full Stage B call"
    assert counters["item_repair"] == 2, "only the affected gap is re-asked"
    assert len(content["questions"]) == 22


def test_stage_b_gives_up_on_a_gap_without_a_full_regeneration(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[_stage_b_payload(specs, bad_gap_id="g5")],
        item_repair=[{"wrongOptions": ["x", "x", "x"], "skillTags": ["grammar"]}] * 4,
    )
    profile, part = _profile_and_part()
    with pytest.raises(mod.LanguageElementsGenerationError, match="g5"):
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert counters["stage_b"] == 1


def test_stage_b_omitted_gap_is_repaired_individually(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    payload = _stage_b_payload(specs)
    payload["items"] = [it for it in payload["items"] if it["gapId"] != "g7"]  # model skipped one gap
    mod, counters = _setup(
        monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[payload],
        item_repair=[{"wrongOptions": ["alpha", "beta", "gamma"], "skillTags": ["grammar"]}],
    )
    profile, part = _profile_and_part()
    content, _ = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert counters["stage_b"] == 1 and counters["item_repair"] == 1
    assert len(content["questions"]) == 22


def test_wrong_option_reason_codes_are_content_free() -> None:
    from app.services import german_exam_language_elements as mod

    r = mod._wrong_options_reason
    assert r(None, "x") == "missing_options"
    assert r({"wrongOptions": ["a", "b"]}, "x") == "wrong_option_count"
    assert r({"wrongOptions": ["a", "", "c"]}, "x") == "empty_option"
    assert r({"wrongOptions": ["a", "A", "c"]}, "x") == "duplicate_option"
    assert r({"wrongOptions": ["a", "b", "x"]}, "X") == "equals_correct_answer"
    assert r({"wrongOptions": ["a", "b", "c"]}, "x") is None


def test_stage_b_schema_makes_the_option_count_structural() -> None:
    from app.services import german_exam_language_elements as mod

    item = mod._STAGE_B_SCHEMA["properties"]["items"]["items"]
    assert set(item["required"]) == set(item["properties"])
    assert {"distractor1", "distractor2", "distractor3"} <= set(item["required"])
    assert item["additionalProperties"] is False
    converted = mod._with_wrong_options({"gapId": "g1", "questionId": "q1", "distractor1": "a",
                                          "distractor2": "b", "distractor3": "c", "skillTags": []})
    assert converted["wrongOptions"] == ["a", "b", "c"] and "distractor1" not in converted


def test_gap_outcomes_are_recorded_without_content(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import gen_timing

    specs = _gap_specs()
    mod, _ = _setup(
        monkeypatch, stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[_stage_b_payload(specs, bad_gap_id="g5")],
        item_repair=[{"wrongOptions": ["alpha", "beta", "gamma"], "skillTags": ["grammar"]}],
    )
    profile, part = _profile_and_part()
    with gen_timing.timed_request("language_elements", "sprachbausteine_1") as timer:
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
        entries = [e for e in timer.summary("ok")["validation"] if e.get("stage") == "sprachbausteine_stage_b"]
    assert entries and entries[0]["gapId"] == "g5" and entries[0]["resolved"] is True
    assert set(entries[0]) == {"stage", "gapId", "category", "reason", "initialReason", "repairRound", "resolved"}
    assert "alpha" not in str(entries)


def test_unsupported_correct_answer_skips_repair_and_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    """UNSUPPORTED_CORRECT_ANSWER means the Stage A answer itself is being
    challenged — repair_items_semantic can never fix that (Stage B repair
    is distractor-only, and _constrain_repair now freezes the correct
    option unconditionally for this task type), so it must never be sent
    there. Must fail the whole generation (surfacing Retry to the user, and
    a fresh Stage A on the next attempt) rather than spend the single
    repair-round budget on something structurally unfixable."""
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult

    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    def _always_unsupported(part, content, **kw):
        issue = SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "doesn't fit")
        items = [ItemSemanticResult(item_id=q["questionId"], passed=(q["gapId"] != "g5"), issues=([issue] if q["gapId"] == "g5" else []))
                 for q in content.get("questions") or []]
        return SemanticVerificationResult(passed=False, part_wide_issues=[], items=items)

    monkeypatch.setattr(mod, "verify_semantic", _always_unsupported)

    def _repair_should_not_be_called(part, content, item_issues):
        raise AssertionError("repair_items_semantic must never be called for an UNSUPPORTED_CORRECT_ANSWER-only item")

    monkeypatch.setattr(mod, "repair_items_semantic", _repair_should_not_be_called)

    with pytest.raises(mod.LanguageElementsGenerationError):
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})


# ── Final assembly stays the existing, unchanged contract ───────────────

def test_final_content_passes_the_existing_deterministic_validator(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.german_exam_validator import hard_issues, validate_content

    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert hard_issues(validate_content(part, content)) == []


def test_semantic_verifier_still_runs_after_assembly(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])

    verify_calls = {"n": 0}

    def _counting_verify(part, content, **kw):
        verify_calls["n"] += 1
        return _passing_semantic_result(part, content)

    import app.services.german_exam_language_elements as le_mod
    monkeypatch.setattr(le_mod, "verify_semantic", _counting_verify)
    profile, part = _profile_and_part()

    _content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert verify_calls["n"] >= 1
    assert meta["semantic"]["passed"] is True


def test_external_envelope_shape_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    """The frontend-facing content shape must stay exactly what it was
    before the pipeline rework: text.{title,paragraphs,gaps} and
    questions[].{questionId,gapId,options,correctIndex,category,skillTags,difficulty}."""
    specs = _gap_specs()
    mod, _counters = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert set(content) == {"text", "questions"}
    assert set(content["text"]) == {"title", "paragraphs", "gaps"}
    for q in content["questions"]:
        assert set(q) == {"questionId", "gapId", "options", "correctIndex", "category", "skillTags", "difficulty"}
        assert q["difficulty"] == "c1"
        assert q["category"] in {"grammar", "lexicon", "orthography"}


def test_persistently_invalid_stage_a_raises_after_regeneration_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    always_broken = {"text": {"title": "x", "paragraphs": ["x"]}}
    mod, counters = _setup(monkeypatch, stage_a_calls=[always_broken, always_broken, always_broken])
    profile, part = _profile_and_part()

    with pytest.raises(mod.LanguageElementsGenerationError):
        mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert counters["stage_b"] == 0


# ── Missing-gap repair: fix a near-complete passage, don't discard it ────

def test_a_small_number_of_missing_gaps_is_repaired_not_fully_regenerated(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    complete = _stage_a_content(specs)
    missing_two = dict(complete)
    missing_two["text"] = dict(complete["text"])
    missing_two["text"]["paragraphs"] = [
        p.replace("{{g5::antwort_g5}}", "wenig").replace("{{g12::antwort_g12}}", "sehr") for p in complete["text"]["paragraphs"]
    ]

    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[missing_two],
        stage_b_calls=[_stage_b_payload(specs)],
        missing_gap_repair=[{
            "text": complete["text"],  # the "fixed" passage has all 22 tagged gaps again (answers inline)
        }],
    )
    profile, part = _profile_and_part()

    content, meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 1, "2 missing gaps must be repaired in place, not trigger a full regeneration"
    assert counters["missing_gap_repair"] == 1
    assert len(content["text"]["gaps"]) == 22
    assert meta["deterministicPassed"] is True


def test_too_many_missing_gaps_skips_repair_and_regenerates(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    complete = _stage_a_content(specs)
    # Strip more placeholders than _MAX_MISSING_GAPS_FOR_REPAIR — too broken
    # for a targeted insertion repair to be the right tool.
    from app.services.german_exam_language_elements import _MAX_MISSING_GAPS_FOR_REPAIR
    too_broken = dict(complete)
    too_broken["text"] = dict(complete["text"])
    paragraphs = complete["text"]["paragraphs"]
    for gid in [f"g{i}" for i in range(1, _MAX_MISSING_GAPS_FOR_REPAIR + 3)]:
        paragraphs = [p.replace("{{" + gid + "::antwort_" + gid + "}}", "Wort") for p in paragraphs]
    too_broken["text"]["paragraphs"] = paragraphs

    mod, counters = _setup(monkeypatch, stage_a_calls=[too_broken, complete], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["missing_gap_repair"] == 0, "too many missing gaps must skip the targeted repair"
    assert counters["stage_a"] == 2, "must fall back to a full Stage A regeneration instead"
    assert len(content["text"]["gaps"]) == 22


# ── Stage B per-gap repair: candidate-specific reasons + round 2 repairs round 1 ──

def _repair_env(monkeypatch, outputs):
    """One orthography gap whose ORIGINAL distractors equal the correct answer after _norm."""
    from app.services import german_exam_language_elements as mod

    specs = [{"gapId": "g1", "questionId": "q1", "category": "orthography"}]
    answers = {"g1": "Beispiel"}
    ctx = {"g1": {"sentenceWithCorrectAnswer": "Das ist ein Beispiel."}}
    original = {"wrongOptions": ["beispiel", "Bespiel", "Beispill"], "skillTags": ["register"]}
    prompts: list[str] = []
    queue = list(outputs)

    def _call(*, system, user):
        prompts.append(system)
        return _FakeResult(queue.pop(0))

    monkeypatch.setattr(mod, "_call_item_repair", _call)
    return mod, specs, answers, ctx, original, prompts


_B = {"wrongOptions": ["Fehler", "Fehler", "Irrtum"], "skillTags": ["register"]}       # duplicate_option
_C = {"wrongOptions": ["Beispiehl", "Bayspiel", "Beispeel"], "skillTags": ["register"]}  # valid


def _two_rounds(mod, specs, answers, ctx, items):
    rejected: dict = {}
    out = []
    for round_no in (1, 2):
        items, repaired, unresolved = mod._repair_stage_b_items(specs, answers, items, ctx, round_no, rejected)
        out.append((repaired, list(unresolved)))
        if not unresolved:
            break
    return items, out


def test_repair_round_two_receives_the_round_one_candidate_not_the_original(monkeypatch):
    mod, specs, answers, ctx, original, prompts = _repair_env(monkeypatch, [_B, _C])
    _two_rounds(mod, specs, answers, ctx, {"g1": dict(original)})
    assert len(prompts) == 2
    assert '["beispiel", "Bespiel", "Beispill"]' in prompts[0]          # round 1 sees the original
    assert '["Fehler", "Fehler", "Irrtum"]' in prompts[1]                # round 2 sees round 1's candidate
    assert '"Bespiel"' not in prompts[1]                                  # ...and NOT the original


def test_repair_round_two_is_told_the_round_one_candidates_actual_reason(monkeypatch):
    mod, specs, answers, ctx, original, prompts = _repair_env(monkeypatch, [_B, _C])
    _two_rounds(mod, specs, answers, ctx, {"g1": dict(original)})
    assert "(equals_correct_answer)" in prompts[0]      # the ORIGINAL item's reason
    assert "(duplicate_option)" in prompts[1]            # round 1 candidate's own reason
    assert "(equals_correct_answer)" not in prompts[1]


def test_invalid_candidates_never_become_the_accepted_item(monkeypatch):
    mod, specs, answers, ctx, original, _ = _repair_env(monkeypatch, [_B, _B])
    items = {"g1": dict(original)}
    items_out, rounds = _two_rounds(mod, specs, answers, ctx, items)
    assert rounds[-1] == (0, ["g1"])
    assert items_out["g1"]["wrongOptions"] == original["wrongOptions"], "no invalid Stage B item may leak downstream"
    assert items_out["g1"] is items["g1"]


def test_a_valid_round_two_candidate_is_the_only_one_stored(monkeypatch):
    mod, specs, answers, ctx, original, _ = _repair_env(monkeypatch, [_B, _C])
    items_out, rounds = _two_rounds(mod, specs, answers, ctx, {"g1": dict(original)})
    assert rounds == [(0, ["g1"]), (1, [])]
    assert items_out["g1"] == _C


def test_diagnostics_record_each_candidates_own_reason_without_content(monkeypatch):
    from app.services import gen_timing

    equals = {"wrongOptions": ["Beispiel", "Irrtum", "Fehlern"], "skillTags": ["register"]}  # equals_correct_answer
    mod, specs, answers, ctx, original, _ = _repair_env(monkeypatch, [equals, _B])
    with gen_timing.timed_request("language_elements", "sprachbausteine_1") as timer:
        _two_rounds(mod, specs, answers, ctx, {"g1": dict(original)})
        entries = [e for e in timer.summary("ok")["validation"] if e.get("stage") == "sprachbausteine_stage_b"]
    assert [(e["repairRound"], e["reason"], e["resolved"]) for e in entries] == [
        (1, "equals_correct_answer", False), (2, "duplicate_option", False)]
    assert all(e["initialReason"] == "equals_correct_answer" for e in entries)
    assert not any(w in str(entries) for w in ("Beispiel", "Fehler", "Irrtum"))


def test_round_one_success_is_unchanged(monkeypatch):
    from app.services import gen_timing

    mod, specs, answers, ctx, original, prompts = _repair_env(monkeypatch, [_C])
    with gen_timing.timed_request("language_elements", "sprachbausteine_1") as timer:
        items_out, rounds = _two_rounds(mod, specs, answers, ctx, {"g1": dict(original)})
        entries = [e for e in timer.summary("ok")["validation"] if e.get("stage") == "sprachbausteine_stage_b"]
    assert len(prompts) == 1 and rounds == [(1, [])]
    assert items_out["g1"] == _C
    assert [(e["repairRound"], e["reason"], e["resolved"]) for e in entries] == [(1, None, True)]


def test_stage_b_runner_threads_the_rejected_candidate_between_rounds(monkeypatch):
    specs = _gap_specs()
    seen: list[str] = []
    mod, _ = _setup(
        monkeypatch, stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[_stage_b_payload(specs, bad_gap_id="g5")],
        item_repair=[{"wrongOptions": ["x", "x", "y"], "skillTags": ["grammar"]},
                     {"wrongOptions": ["alpha", "beta", "gamma"], "skillTags": ["grammar"]}],
    )
    real = mod._prompt_item_repair

    def spy(gap_spec, correct, context, prior_wrong, reason):
        seen.append((prior_wrong, reason))
        return real(gap_spec, correct, context, prior_wrong, reason)

    monkeypatch.setattr(mod, "_prompt_item_repair", spy)
    profile, part = _profile_and_part()
    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    assert len(content["questions"]) == 22 and len(seen) == 2
    assert seen[1] == (["x", "x", "y"], "duplicate_option"), "round 2 repairs round 1's rejected candidate"


# ── Stage A: TAGGED gaps ("{{gN::answer}}") are the single source of truth ─────

def _mod():
    import app.services.german_exam_language_elements as m
    return m


def _tagged(*pairs, filler="Text"):
    return {"text": {"title": "t", "paragraphs": [" ".join(f"{filler} {{{{{g}::{a}}}}}" for g, a in pairs)]}}


def test_tagged_parser_extracts_gap_id_and_exact_answer_in_reading_order() -> None:
    m = _mod()
    assert m._extract_tagged_gaps("Das {{g1::ist}} wichtig, {{g2::dennoch}} sicher.") == [("g1", "ist"), ("g2", "dennoch")]


def test_multiword_answer_is_one_gap_and_one_word() -> None:
    m = _mod()
    text = "Wir arbeiten {{g1::im Hinblick auf}} das Ziel."
    assert m._extract_tagged_gaps(text) == [("g1", "im Hinblick auf")]
    assert m._count_words_tagged(text) == 5  # Wir arbeiten <gap> das Ziel.
    public = m._materialize_stage_a_text({"title": "t", "paragraphs": [text]}, _gap_specs()[:1])[0]["paragraphs"][0]
    assert len(public.split()) == m._count_words_tagged(text)  # what the final validator will count


def test_materialization_derives_public_text_and_answers_from_the_tags() -> None:
    m = _mod()
    src = {"title": "T", "paragraphs": ["Interkulturelle Kompetenz {{g1::ist}} ein zentraler Baustein."]}
    final, answers = m._materialize_stage_a_text(src, _gap_specs()[:1])
    assert final["paragraphs"] == ["Interkulturelle Kompetenz {{g1}} ein zentraler Baustein."]
    assert answers == {"g1": "ist"} and final["title"] == "T"
    assert "::" in src["paragraphs"][0], "the input is not mutated"


def test_out_of_order_gaps_fail_structural_validation() -> None:
    m = _mod()
    issues = m._stage_a_structural_issues(_tagged(("g1", "a1"), ("g3", "a3"), ("g2", "a2")), _gap_specs()[:3])
    assert any("out of reading order" in i for i in issues)


def test_duplicate_gap_fails() -> None:
    m = _mod()
    assert m._stage_a_structural_issues(_tagged(("g1", "a1"), ("g1", "a1x")), _gap_specs()[:2])


def test_empty_tagged_answer_fails() -> None:
    m = _mod()
    assert m._stage_a_structural_issues(_tagged(("g1", "  ")), _gap_specs()[:1])


def test_a_plain_or_nested_marker_in_stage_a_is_rejected() -> None:
    m = _mod()
    specs = _gap_specs()[:2]
    plain = {"text": {"title": "t", "paragraphs": ["Text {{g1}} und {{g2::b}} Text"]}}
    nested = {"text": {"title": "t", "paragraphs": ["Text {{g1::{{g2::b}}}} Text"]}}
    assert m._stage_a_structural_issues(plain, specs)
    assert m._stage_a_structural_issues(nested, specs)
    assert m._missing_gap_ids(plain, specs) is None, "an untagged marker is not a simple missing-gap case"


def test_passage_rewrite_may_change_prose_but_never_a_tagged_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    m = _mod()
    specs = _gap_specs()[:2]
    words = " ".join(["Wort"] * 60)
    original = {"text": {"title": "t", "paragraphs": [words + " Er ging {{g1::obwohl}} es regnete. Sie kam {{g2::dennoch}} an."]}}
    tail = "Kurz. Er ging GAP1 es regnete. Sie kam {{g2::dennoch}} an. " + " ".join(["Wort"] * 30)
    good = {"text": {"title": "t", "paragraphs": [tail.replace("GAP1", "{{g1::obwohl}}")]}}
    bad_shortened = {"text": {"title": "t", "paragraphs": [tail.replace("GAP1", "{{g1}}")]}}
    bad_edited = {"text": {"title": "t", "paragraphs": [tail.replace("GAP1", "{{g1::weil}}")]}}
    prompts: list[str] = []

    def run(candidate):
        def fake(*, system, user):
            prompts.append(system)
            return _FakeResult(candidate)
        monkeypatch.setattr(m, "_call_passage_repair", fake)
        monkeypatch.setattr(m, "_trim_passage_deterministic", lambda *a, **k: None)
        return m._repair_passage_word_count(original, specs, 30, 60)

    assert "{{g1::obwohl}}" in run(good)["text"]["paragraphs"][0]
    assert run(bad_shortened) == original, "a rewrite that shortens a tag to {{gN}} is discarded"
    assert run(bad_edited) == original, "a rewrite that edits a tagged answer is discarded"
    assert "COMPLETE and UNCHANGED" in prompts[0] and "{{gN::answer}}" in prompts[0]


def test_deterministic_trim_never_removes_a_sentence_containing_a_tagged_gap() -> None:
    m = _mod()
    specs = _gap_specs()[:1]
    text = "Der Satz mit {{g1::Gap}} hat viele Woerter und bleibt. " + "Fueller Satz eins ist hier. " * 20
    out = m._trim_passage_deterministic({"text": {"title": "t", "paragraphs": [text]}}, specs, 15, 30)
    assert out is not None and "{{g1::Gap}}" in out["text"]["paragraphs"][0]
    assert m._has_tagged_gap("Wir {{g1::z. B.}} tun") and not m._has_tagged_gap("Wir tun {{g1}} das")


def test_sentence_split_never_falls_inside_a_tagged_marker() -> None:
    m = _mod()
    parts = m._split_sentences("Das gilt {{g3::z. B.}} heute. Danach {{g4::bzw. sogar}} morgen.")
    assert parts == ["Das gilt {{g3::z. B.}} heute.", "Danach {{g4::bzw. sogar}} morgen."]


def test_missing_gap_repair_keeps_existing_markers_and_takes_the_new_answer_from_its_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    m = _mod()
    specs = _gap_specs()[:3]
    content = _tagged(("g1", "a1"), ("g3", "a3"))
    repaired_ok = {"text": {"title": "t", "paragraphs": ["Text {{g1::a1}} Text {{g2::neu}} Text {{g3::a3}}"]}}
    monkeypatch.setattr(m, "_call_missing_gap_repair", lambda *, system, user: _FakeResult(repaired_ok))
    out = m._repair_missing_gaps(content, specs, ["g2"])
    assert out is not None
    _final, answers = m._materialize_stage_a_text(out["text"], specs)
    assert answers == {"g1": "a1", "g2": "neu", "g3": "a3"}
    tampered = {"text": {"title": "t", "paragraphs": ["Text {{g1::CHANGED}} Text {{g2::neu}} Text {{g3::a3}}"]}}
    monkeypatch.setattr(m, "_call_missing_gap_repair", lambda *, system, user: _FakeResult(tampered))
    assert m._repair_missing_gaps(content, specs, ["g2"]) is None, "an existing tagged answer must not change"


def test_a_legacy_answers_field_never_overrides_the_inline_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    payload = _stage_a_content(specs)
    payload["answers"] = [{"gapId": s["gapId"], "answer": "GEGENANTWORT", "skillTags": []} for s in specs]
    mod, _ = _setup(monkeypatch, stage_a_calls=[payload], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()
    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    for q in content["questions"]:
        assert q["options"][q["correctIndex"]] == f"antwort_{q['gapId']}"


def test_the_public_passage_never_contains_tags_or_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    mod, _ = _setup(monkeypatch, stage_a_calls=[_stage_a_content(specs)], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()
    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})
    text = " ".join(content["text"]["paragraphs"])
    assert "::" not in text and "antwort_" not in text
    assert all("{{" + s["gapId"] + "}}" in text for s in specs)


def test_adjacent_duplicate_guard_is_narrow() -> None:
    m = _mod()
    assert m._adjacent_duplicate_gap_ids("Programme bieten {{g10::bieten}} Studierenden") == ["g10"]
    assert m._adjacent_duplicate_gap_ids("Ich weiss, dass {{g1::das}} das Problem ist") == []   # short function word
    assert m._adjacent_duplicate_gap_ids("Diejenigen, {{g2::die}} die Regel kennen") == []
    assert m._adjacent_duplicate_gap_ids("Programme {{g10::bieten}} Studierenden Unterstuetzung") == []


def test_stage_a_prompts_use_the_tagged_contract() -> None:
    m = _mod()
    profile, part = _profile_and_part()
    system, _user = m._prompt_stage_a(profile, part, [], {"topicId": "t", "label": "T"}, _gap_specs(), 320, 350)
    assert "{{g5::ist}}" in system and "bieten" in system
    assert "NO separate answer list" in system
    sysm, _u = m._prompt_missing_gap_repair({"g2": {"category": "grammar"}}, {"paragraphs": []}, ["g2"])
    assert "{{gN::answer}}" in sysm and "newAnswers" not in sysm
