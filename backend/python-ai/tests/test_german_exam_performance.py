"""Results-integrity hardening: record_attempts() must derive every
exam-structure field (family/variant/CEFR/profile_version/task_type/
skill_tags-per-part) server-side from profile_id+part_id via the profile
registry, never trust the client's own copies of them."""
from app.services import german_exam_performance as perf
from app.services.german_exam_performance import AttemptItem, record_attempts


class _FakeTable:
    def __init__(self, sink):
        self._sink = sink
        self._rows = None

    def insert(self, rows):
        self._rows = rows
        return self

    def execute(self):
        self._sink.extend(self._rows or [])
        return None


class _FakeSB:
    def __init__(self):
        self.inserted: list[dict] = []

    def table(self, name):
        assert name == "german_exam_attempts"
        return _FakeTable(self.inserted)


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
    assert row["profile_version"] == 1
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
