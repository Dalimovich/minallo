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


def _passing_semantic_result(part, content):
    from app.services.german_exam_semantic_verify import ItemSemanticResult, SemanticVerificationResult

    items = [ItemSemanticResult(item_id=q["questionId"], passed=True, issues=[]) for q in content.get("questions") or []]
    return SemanticVerificationResult(passed=True, part_wide_issues=[], items=items)


def _gap_specs():
    from app.services.german_exam_language_elements import _build_gap_specs
    return _build_gap_specs(22)


def _stage_a_content(gap_specs, word_count: int = 330) -> dict:
    """A structurally valid Stage A response: all placeholders present
    exactly once in reading order, one answer per gap, total split()-word
    count (placeholder tokens included, matching how both the pipeline's
    _passage_word_count and the real validator count) controllable for the
    repair-path tests."""
    filler_count = max(len(gap_specs), word_count - len(gap_specs))
    filler = ["Wort"] * filler_count
    per_gap = max(1, len(filler) // len(gap_specs))
    tokens: list[str] = []
    fi = 0
    for g in gap_specs:
        tokens.extend(filler[fi:fi + per_gap])
        fi += per_gap
        tokens.append("{{" + g["gapId"] + "}}")
    tokens.extend(filler[fi:])
    from app.services.german_exam_language_elements import _CATEGORY_SKILL_TAGS
    answers = [
        {"gapId": g["gapId"], "answer": f"antwort_{g['gapId']}", "skillTags": [_CATEGORY_SKILL_TAGS[g["category"]][0]]}
        for g in gap_specs
    ]
    return {"text": {"title": "Titel", "paragraphs": [" ".join(tokens)]}, "answers": answers}


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
    from app.services.german_exam_profiles import get_profile, get_part
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
    gap_sentence_1 = "Der Student braucht {{g1}} fuer sein Studium."
    gap_sentence_2 = "Am Ende sagt er {{g2}} klar und deutlich."
    filler_1 = "Dies ist ein zusaetzlicher Fuellsatz der ruhig entfernt werden kann heute."
    filler_2 = "Noch ein weiterer langer Fuellsatz der problemlos komplett gestrichen werden darf."
    content = {
        "text": {"title": "t", "paragraphs": [f"{gap_sentence_1} {filler_1} {gap_sentence_2} {filler_2}"]},
        "answers": [
            {"gapId": "g1", "answer": "a", "skillTags": ["grammar"]},
            {"gapId": "g2", "answer": "b", "skillTags": ["grammar"]},
        ],
    }

    trimmed = _trim_passage_deterministic(content, specs, word_min=10, word_max=20)

    assert trimmed is not None
    joined = " ".join(trimmed["text"]["paragraphs"])
    assert "{{g1}}" in joined
    assert "{{g2}}" in joined
    assert 10 <= _passage_word_count(trimmed) <= 20


def test_deterministic_trim_returns_none_when_nothing_removable() -> None:
    """A passage with no non-gap sentence to drop (or not enough removable
    text to reach word_min without going under) must signal failure so the
    caller falls back to the LLM-based repair, not silently overshoot."""
    from app.services.german_exam_language_elements import _trim_passage_deterministic

    specs = _gap_specs()[:1]
    content = {
        "text": {"title": "t", "paragraphs": ["Ein einziger Satz mit {{g1}} und sonst nichts drin."]},
        "answers": [{"gapId": "g1", "answer": "a", "skillTags": ["grammar"]}],
    }

    assert _trim_passage_deterministic(content, specs, word_min=5, word_max=3) is None


def test_deterministic_trim_avoids_any_llm_repair_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """When enough removable filler sentences exist to reach the target
    range on their own, no paid passage-repair LLM call should happen at
    all — the deterministic trim must handle it for free."""
    specs = _gap_specs()
    from app.services.german_exam_language_elements import _CATEGORY_SKILL_TAGS

    gap_sentences = " ".join(f"Punkt {g['gapId']} betrifft {{{{{g['gapId']}}}}} klar." for g in specs)
    filler_sentence = "Dies ist ein zusaetzlicher Fuellsatz der ruhig komplett entfernt werden kann heute noch."
    paragraph = gap_sentences + " " + (filler_sentence + " ") * 40
    answers = [
        {"gapId": g["gapId"], "answer": f"antwort_{g['gapId']}", "skillTags": [_CATEGORY_SKILL_TAGS[g["category"]][0]]}
        for g in specs
    ]
    too_long = {"text": {"title": "Titel", "paragraphs": [paragraph]}, "answers": answers}

    mod, counters = _setup(monkeypatch, stage_a_calls=[too_long], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_a"] == 1
    assert counters["passage_repair"] == 0, "deterministic sentence-trim should have handled this without an LLM call"
    gap_ids = [g["gapId"] for g in content["text"]["gaps"]]
    assert gap_ids == [f"g{i}" for i in range(1, 23)]


def test_zero_gap_stage_a_is_rejected_before_stage_b_is_ever_called(monkeypatch: pytest.MonkeyPatch) -> None:
    broken = {"text": {"title": "x", "paragraphs": ["kein einziger Platzhalter hier"]}, "answers": []}
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

    def _spy_prompt_stage_b(profile, part, gap_specs, answers_by_gap):
        seen_answers["value"] = dict(answers_by_gap)
        return real_prompt_stage_b(profile, part, gap_specs, answers_by_gap)

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


def test_stage_b_regenerates_only_when_item_repair_cannot_fix_it(monkeypatch: pytest.MonkeyPatch) -> None:
    specs = _gap_specs()
    bad_gap = "g5"
    first = _stage_b_payload(specs, bad_gap_id=bad_gap)
    second = _stage_b_payload(specs)  # a clean regeneration, no bad items

    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[_stage_a_content(specs)],
        stage_b_calls=[first, second],
        # item repair NEVER returns a valid fix, forcing the fallback to a
        # full Stage B regeneration
        item_repair=[{"wrongOptions": ["x", "x", "x"], "skillTags": ["grammar"]}] * 4,
    )
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["stage_b"] == 2
    assert len(content["questions"]) == 22


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

    def _counting_verify(part, content):
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
    always_broken = {"text": {"title": "x", "paragraphs": ["x"]}, "answers": []}
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
        p.replace("{{g5}}", "wenig").replace("{{g12}}", "sehr") for p in complete["text"]["paragraphs"]
    ]

    mod, counters = _setup(
        monkeypatch,
        stage_a_calls=[missing_two],
        stage_b_calls=[_stage_b_payload(specs)],
        missing_gap_repair=[{
            "text": complete["text"],  # the "fixed" passage has all 22 placeholders again
            "newAnswers": [
                {"gapId": "g5", "answer": "antwort_g5", "skillTags": ["grammar"]},
                {"gapId": "g12", "answer": "antwort_g12", "skillTags": ["word_formation"]},
            ],
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
        paragraphs = [p.replace("{{" + gid + "}}", "Wort") for p in paragraphs]
    too_broken["text"]["paragraphs"] = paragraphs

    mod, counters = _setup(monkeypatch, stage_a_calls=[too_broken, complete], stage_b_calls=[_stage_b_payload(specs)])
    profile, part = _profile_and_part()

    content, _meta = mod.generate_language_elements_part(profile, part, [], {"topicId": "t", "label": "Test"})

    assert counters["missing_gap_repair"] == 0, "too many missing gaps must skip the targeted repair"
    assert counters["stage_a"] == 2, "must fall back to a full Stage A regeneration instead"
    assert len(content["text"]["gaps"]) == 22
