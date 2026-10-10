"""Results-integrity hardening: record_attempts() must derive every
exam-structure field (family/variant/CEFR/profile_version/task_type/
skill_tags-per-part) server-side from profile_id+part_id via the profile
registry, never trust the client's own copies of them. Also covers Phase
2.6's generationId traceability + consume idempotency."""
from app.services import german_exam_performance as perf
from app.services.german_exam_performance import AttemptItem, record_attempts, record_topic_used
from app.services.german_exams import get_profile


class _FakeTable:
    def __init__(self, sink, calls):
        self._sink = sink
        self._calls = calls
        self._pending = None

    def insert(self, rows):
        self._pending = ("insert", rows if isinstance(rows, list) else [rows], {})
        return self

    def upsert(self, rows, **kwargs):
        self._pending = ("upsert", rows if isinstance(rows, list) else [rows], kwargs)
        return self

    def execute(self):
        op, rows, kwargs = self._pending
        self._calls.append((op, kwargs))
        self._sink.extend(rows)
        return None


class _FakeSB:
    def __init__(self):
        self.inserted: list[dict] = []
        self.calls: list[tuple] = []

    def table(self, name):
        assert name in ("german_exam_attempts", "german_exam_topic_history")
        return _FakeTable(self.inserted, self.calls)


def _item(**overrides):
    base = dict(
        profile_id="telc_c1_hochschule", profile_version=999, module="listening",
        part_id="hv1", task_type="wrong_task_type", item_id="q1",
        skill_tags=["global_main_idea"], difficulty=None, attempt_count=1,
        first_attempt_correct=True, final_correct=True, hint_level=0,
        replay_count=0, transcript_revealed=False, score_value=1.0,
        max_score_value=1.0, metadata={},
    )
    base.update(overrides)
    return AttemptItem(**base)


def test_client_supplied_family_variant_level_are_ignored(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    record_attempts("u1", "wrong_family", "wrong_variant", "wrong_level", [_item()])
    row = sb.inserted[0]
    assert row["exam_family"] == "telc"
    assert row["exam_variant"] == "C1 Hochschule"
    assert row["target_level"] == "C1"


def test_client_supplied_profile_version_and_task_type_are_overridden(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(profile_version=999, task_type="bogus")])
    row = sb.inserted[0]
    assert row["profile_version"] == get_profile("telc_c1_hochschule").profile_version
    assert row["task_type"] == "speaker_statement_matching"


def test_skill_tag_valid_for_module_but_not_for_part_is_dropped(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    # "detail_fact" is a real listening tag (valid for hv2/hv3) but not in hv1's allowed_skill_tags.
    result = record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(skill_tags=["detail_fact"])])
    assert result == {"accepted": 0, "dropped": 1}
    assert sb.inserted == []


def test_unknown_module_tag_is_dropped(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    result = record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(skill_tags=["not_a_real_tag"])])
    assert result == {"accepted": 0, "dropped": 1}


def test_unknown_part_is_dropped(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    result = record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(part_id="hv9")])
    assert result == {"accepted": 0, "dropped": 1}


def test_mismatched_module_for_part_is_dropped(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    # hv1 only exists under "listening" -- declaring it under "reading" must not resolve.
    result = record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(module="reading")])
    assert result == {"accepted": 0, "dropped": 1}


def test_valid_hv2_tag_accepted(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    result = record_attempts(
        "u1", "telc", "C1 Hochschule", "C1",
        [_item(part_id="hv2", task_type="sentence_completion_mc3", skill_tags=["detail_fact"])],
    )
    assert result == {"accepted": 1, "dropped": 0}
    assert sb.inserted[0]["task_type"] == "sentence_completion_mc3"
    assert sb.inserted[0]["skill_tags"] == ["detail_fact"]


def test_generation_id_is_stored_on_attempt_rows(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(generation_id="gen-abc")])
    assert sb.inserted[0]["generation_id"] == "gen-abc"


def test_record_topic_used_without_generation_id_uses_plain_insert(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    record_topic_used("u1", "telc_c1_hochschule", "listening", "hv1", "urban_mobility")
    assert sb.calls == [("insert", {})]
    assert sb.inserted[0]["generation_id"] is None


def test_record_topic_used_with_generation_id_is_idempotent_upsert(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    record_topic_used("u1", "telc_c1_hochschule", "listening", "hv1", "urban_mobility", "gen-abc")
    op, kwargs = sb.calls[0]
    assert op == "upsert"
    assert kwargs["on_conflict"] == "generation_id"
    assert kwargs["ignore_duplicates"] is True
    assert sb.inserted[0]["generation_id"] == "gen-abc"


def test_record_topic_used_swallows_errors(monkeypatch):
    class _Boom:
        def table(self, name):
            raise RuntimeError("db unavailable")
    monkeypatch.setattr(perf, "get_supabase", lambda: _Boom())
    record_topic_used("u1", "telc_c1_hochschule", "listening", "hv1", "urban_mobility", "gen-abc")  # must not raise


def test_writing_persists_rubric_and_overrides_correctness_booleans(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    rubric = {"taskFulfilment": 75, "examScoreValue": 36, "examMaxScoreValue": 48}
    result = record_attempts("u1", "telc", "C1 Hochschule", "C1", [_item(
        module="writing", part_id="schreiben_1", item_id="rubric_task_fulfilment",
        skill_tags=["task_fulfilment"], first_attempt_correct=True, final_correct=True,
        score_value=75, max_score_value=100, metadata={"rubric": rubric}, generation_id="writing-gen",
    )])
    assert result == {"accepted": 1, "dropped": 0}
    row = sb.inserted[0]
    assert row["first_attempt_correct"] is None
    assert row["final_correct"] is None
    assert row["score_value"] == 75
    assert row["max_score_value"] == 100
    assert row["metadata"]["rubric"] == rubric
    assert row["generation_id"] == "writing-gen"


def test_writing_save_retries_use_stable_ids_scoped_to_user_and_generation(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(perf, "get_supabase", lambda: sb)
    item = _item(module="writing", part_id="schreiben_1", skill_tags=["task_fulfilment"], generation_id="gen")
    for user in ["u1", "u1", "u2"]:
        record_attempts(user, "telc", "C1 Hochschule", "C1", [item])
    assert sb.inserted[0]["id"] == sb.inserted[1]["id"]
    assert sb.inserted[0]["id"] != sb.inserted[2]["id"]
    assert all(call == ("upsert", {"on_conflict": "id", "ignore_duplicates": True}) for call in sb.calls)
