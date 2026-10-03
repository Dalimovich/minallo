"""TestDaF digital speaking (Sprechen 1-7) grader — offline: fixtures only, no provider calls.

grade_testdaf_speaking_transcript() is pure grading logic over an already-obtained transcript;
it never fetches a recording or calls a transcription API (see german_exam_testdaf_speaking.py's
module docstring for the still-open storage/transport question). These tests cover: honest
handling of pronunciation (never scored) and fluency (disfluency markers only, never pacing),
never-fabricated evidence (quotes/timestamps must be real and in range), dimension coverage, and
a full round-trip through the real grade_productive()/validate_feedback() contract (proving this
grader's output actually satisfies the generic schema, not just my own assumptions about it)."""

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


DIMENSIONS = ("task_fulfilment", "situational_appropriateness", "source_fidelity", "fluency", "pronunciation", "linguistic_range", "comprehensibility")


def _request(**overrides) -> dict:
    base = {
        "kind": "practice_feedback", "taskType": "spoken_advice", "dimensions": list(DIMENSIONS),
        "task": {"id": "t1", "prompt": "Geben Sie Ihrem Freund einen Rat."},
        "submission": {"recordingId": "r1", "durationSeconds": 42.0},
        "constraints": {"speakingSeconds": 45},
    }
    base.update(overrides)
    return base


def _segments() -> list[dict]:
    return [
        {"start": 0.0, "end": 3.2, "text": "Also, äh, ich würde dir empfehlen, mit deinem Chef zu sprechen."},
        {"start": 3.2, "end": 7.0, "text": "Das ist wichtig, weil du sonst das Problem nicht lösen kannst."},
        {"start": 7.0, "end": 10.5, "text": "Du solltest das Gespräch bald suchen."},
    ]


def _fake_provider(dimensions_payload):
    return lambda **kwargs: _FakeResult({"dimensions": dimensions_payload})


# ── input validation ──────────────────────────────────────────────────────


def test_rejects_non_testdaf_speaking_task_type() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    with pytest.raises(ValueError, match="not a TestDaF speaking task type"):
        grade_testdaf_speaking_transcript(_request(taskType="choice_long_form_writing"), _segments())


def test_rejects_missing_duration() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    with pytest.raises(ValueError, match="durationSeconds"):
        grade_testdaf_speaking_transcript(_request(submission={"recordingId": "r1"}), _segments())


def test_rejects_empty_transcript() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    with pytest.raises(ValueError, match="empty transcript"):
        grade_testdaf_speaking_transcript(_request(), [{"start": 0, "end": 1, "text": "   "}])


# ── honest handling of acoustic-only dimensions ──────────────────────────────


def test_pronunciation_is_never_scored_regardless_of_what_the_model_returns() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript, _NOT_ASSESSABLE_MESSAGE

    # Even if the model tried to claim a pronunciation judgment, it must be ignored entirely.
    provider = _fake_provider({"pronunciation": {"feedback": "Excellent pronunciation!", "quotes": ["ich würde dir empfehlen"]}})
    result = grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    pron = next(d for d in result["dimensions"] if d["id"] == "pronunciation")
    assert pron["feedback"] == _NOT_ASSESSABLE_MESSAGE
    assert pron["evidence"] == []


def test_fluency_prompt_restricts_to_disfluency_markers_not_pacing() -> None:
    """The system prompt sent to the model must explicitly narrow 'fluency' to transcript-visible
    disfluency markers — never pacing/pausing/rhythm, which would require audio."""
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    calls = []

    def provider(**kwargs):
        calls.append(kwargs)
        return _FakeResult({"dimensions": {}})

    grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    assert "never infer speaking pace, pausing or rhythm" in calls[0]["system"]
    assert "filler words" in calls[0]["system"]


# ── never-fabricated evidence ─────────────────────────────────────────────


def test_evidence_quote_not_found_in_transcript_is_dropped_not_fabricated() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    provider = _fake_provider({"task_fulfilment": {"feedback": "Gut.", "quotes": ["etwas, das nie gesagt wurde"]}})
    result = grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    tf = next(d for d in result["dimensions"] if d["id"] == "task_fulfilment")
    assert tf["evidence"] == []


def test_evidence_quote_found_in_transcript_gets_its_real_segment_timestamp() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    provider = _fake_provider({"task_fulfilment": {"feedback": "Gut.", "quotes": ["mit deinem Chef zu sprechen"]}})
    result = grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    tf = next(d for d in result["dimensions"] if d["id"] == "task_fulfilment")
    assert len(tf["evidence"]) == 1
    assert tf["evidence"][0]["quote"] == "mit deinem Chef zu sprechen"
    assert tf["evidence"][0]["startSeconds"] == 0.0


def test_evidence_outside_the_submitted_duration_is_dropped() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    long_segments = _segments() + [{"start": 50.0, "end": 51.0, "text": "Satz nach Ablauf der Aufnahme."}]
    provider = _fake_provider({"task_fulfilment": {"feedback": "Gut.", "quotes": ["Satz nach Ablauf der Aufnahme."]}})
    # durationSeconds is 42.0 (see _request) — a segment starting at 50s must never be cited.
    result = grade_testdaf_speaking_transcript(_request(), long_segments, provider=provider)
    tf = next(d for d in result["dimensions"] if d["id"] == "task_fulfilment")
    assert tf["evidence"] == []


# ── coverage / fallback ───────────────────────────────────────────────────


def test_every_requested_dimension_is_present_even_with_no_model_signal() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    provider = _fake_provider({})
    result = grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    assert {d["id"] for d in result["dimensions"]} == set(DIMENSIONS)
    for d in result["dimensions"]:
        assert d["feedback"]  # never an empty feedback string


def test_never_claims_an_official_score() -> None:
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript

    provider = _fake_provider({"task_fulfilment": {"feedback": "TDN 5, scaledScore 18", "quotes": []}})
    result = grade_testdaf_speaking_transcript(_request(), _segments(), provider=provider)
    assert not any(k in result for k in ("scaledScore", "tdn", "pass", "officialScore", "rawScore"))


# ── full round-trip through the real generic contract ────────────────────


def test_round_trips_through_the_real_grade_productive_and_validate_feedback() -> None:
    """Proves this grader's output actually satisfies german_exam_productive.py's real,
    independently-written schema — not just this module's own assumptions about it."""
    from app.services.german_exam_productive import grade_productive
    from app.services.german_exam_testdaf_speaking import grade_testdaf_speaking_transcript
    from app.services.german_exams import get_part

    part = get_part("testdaf_digital", "speaking", "sprechen_1")
    assert part.task_type == "spoken_advice"
    content = {"schemaVersion": "productive-task-v1", "id": "t1", "prompt": "Geben Sie Ihrem Freund einen Rat.", "sources": []}
    submission = {"recordingId": "r1", "durationSeconds": 42.0}

    provider = _fake_provider({"task_fulfilment": {"feedback": "Guter Rat.", "quotes": ["mit deinem Chef zu sprechen"]}})
    grader = lambda request: grade_testdaf_speaking_transcript(request, _segments(), provider=provider)  # noqa: E731

    feedback = grade_productive(part, content, submission, grader=grader)
    assert feedback["kind"] == "practice_feedback"
    assert {d["id"] for d in feedback["dimensions"]} == set(part.grading_dimensions)
    assert not any(k in feedback for k in ("scaledScore", "tdn", "pass", "officialScore", "rawScore"))
