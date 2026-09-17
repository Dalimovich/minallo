import base64
from types import SimpleNamespace

import pytest

from app.services import german_exam_speaking as generation
from app.services import german_exam_speaking_practice as practice
from app.services.german_exam_profiles import get_profile, get_part, SPEAKING_TASK_MAXIMA, SPEAKING_LANGUAGE_MAXIMA
from app.services.german_exam_validator import validate_content, hard_issues

PART1 = {"questions": [
    {"questionId": "a", "title": "Digitales Studium", "taskInstructions": "Strukturieren Sie Ihre Präsentation mit Einleitung, Beispielen und Schluss."},
    {"questionId": "b", "title": "Nachhaltiger Campus", "taskInstructions": "Erläutern Sie mit Einleitung und Schluss Chancen und Probleme eines nachhaltigen Campus."},
]}
PART2 = {"quote": "Bildung beginnt dort, wo Gewissheiten hinterfragt werden.",
         "sourceLabel": "Generiertes Übungszitat (keine reale Quelle)", "guidingPoints": generation.DISCUSSION_GUIDING_POINTS}
TASKS = {"sprechen_1": PART1, "sprechen_2": PART2}
SESSION = "session-speaking-1234"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    settings = SimpleNamespace(ai_service_internal_token="test-secret", german_exam_model="stub")
    monkeypatch.setattr(practice, "get_settings", lambda: settings)
    monkeypatch.setattr(generation, "get_settings", lambda: settings)


def turns():
    return [practice.signed_turn("u1", SESSION, role, stage, f"Mein Beitrag zu {stage} {i}") for i, (role, stage) in enumerate([
        ("learner", "presentation"), ("partner", "own_followup"), ("learner", "own_followup"),
        ("partner", "partner_presentation"), ("learner", "summary"), ("learner", "questions"),
        ("partner", "partner_answer"), ("partner", "discussion"), ("learner", "discussion"),
        ("partner", "discussion"), ("learner", "discussion"), ("partner", "discussion")])]


def result(scores=None):
    return SimpleNamespace(data={"scores": scores or {**SPEAKING_TASK_MAXIMA, **SPEAKING_LANGUAGE_MAXIMA},
                                "strengths": ["Struktur"], "weaknesses": ["Register"], "improvements": ["Beispiele ergänzen"],
                                "examples": [{"quote": "Mein Beitrag", "suggestion": "Konkreter formulieren"},
                                             {"quote": "fabricated quote", "suggestion": "must be dropped"}]})


def test_all_five_modules_and_official_two_part_structure():
    profile = get_profile("telc_c1_hochschule")
    assert profile.profile_version == 5
    assert all(profile.modules[module] for module in ("listening", "reading", "language_elements", "writing", "speaking"))
    parts = profile.modules["speaking"]
    assert len(parts) == 2
    assert [(p.part_id, p.task_type) for p in parts] == [("sprechen_1", "presentation_summary_followup"), ("sprechen_2", "quote_guided_discussion")]
    assert parts[0].constraints["topicChoiceCount"] == 2
    assert parts[0].constraints["presentationSeconds"] == 180
    assert parts[0].constraints["summaryFollowupSeconds"] == 120
    assert parts[1].constraints["discussionSeconds"] == 360
    assert SPEAKING_TASK_MAXIMA == {"presentation": 6, "summary_followup": 4, "discussion": 6}
    assert list(SPEAKING_LANGUAGE_MAXIMA.values()) == [8, 8, 8, 8]
    assert sum(p.scoring.max_points for p in parts) == 16
    assert sum(SPEAKING_TASK_MAXIMA.values()) + sum(SPEAKING_LANGUAGE_MAXIMA.values()) == 48


@pytest.mark.parametrize("part_id,content", list(TASKS.items()))
def test_generated_content_shape(part_id, content):
    assert not hard_issues(validate_content(get_part("telc_c1_hochschule", "speaking", part_id), content))


def test_invalid_topic_count_duplicate_topics_and_fabricated_source_rejected():
    p1 = get_part("telc_c1_hochschule", "speaking", "sprechen_1")
    p2 = get_part("telc_c1_hochschule", "speaking", "sprechen_2")
    for content in ({"questions": PART1["questions"][:1]}, {"questions": PART1["questions"] * 2}, {"questions": [PART1["questions"][0]] * 2}):
        assert hard_issues(validate_content(p1, content))
    assert hard_issues(validate_content(p2, {**PART2, "sourceLabel": "Albert Einstein"}))
    assert hard_issues(validate_content(p2, {**PART2, "guidingPoints": []}))


def test_semantic_failure_regenerates_before_exposure(monkeypatch):
    calls = []
    monkeypatch.setattr(generation, "chat_json", lambda **kwargs: SimpleNamespace(data=PART1))
    def verify(part, content):
        calls.append(content)
        return SimpleNamespace(passed=len(calls) == 2)
    monkeypatch.setattr(generation, "verify_semantic_full", verify)
    content, meta = generation.generate_speaking_part(get_profile("telc_c1_hochschule"), get_part("telc_c1_hochschule", "speaking", "sprechen_1"), [], {"label": "Studium"})
    assert content == PART1 and len(calls) == 2
    assert meta["semantic"]["passed"]


def test_transcription_receipt_bound_to_user_session_and_exact_text(monkeypatch):
    calls = []
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text="Meine gesprochene Antwort", usage=None)
    monkeypatch.setattr(practice, "get_openai_client", lambda: SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
    monkeypatch.setattr(practice, "record_usage", lambda **kwargs: None)
    turn = practice.transcribe("u1", SESSION, "presentation", base64.b64encode(b"x" * 1000).decode(), "audio/webm;codecs=opus")
    assert calls[0]["language"] == "de" and calls[0]["file"][0].endswith('.webm')
    practice.verify_turns("u1", SESSION, [turn])
    for user, session, payload in [("u2", SESSION, turn), ("u1", "another-session", turn), ("u1", SESSION, {**turn, "text": "tampered"})]:
        with pytest.raises(ValueError):
            practice.verify_turns(user, session, [payload])


@pytest.mark.parametrize("data,mime", [("bad!", "audio/webm"), (base64.b64encode(b"x").decode(), "audio/webm"), ("abc", "text/plain")])
def test_bad_recordings_rejected_before_transcription(data, mime):
    with pytest.raises(ValueError):
        practice.transcribe("u1", SESSION, "presentation", data, mime)


def test_partner_context_includes_learner_arguments_and_stage(monkeypatch):
    calls = []
    def chat(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(data={"text": "Sie nannten digitale Seminare. Welche Nachteile sehen Sie?"})
    monkeypatch.setattr(practice, "chat_json", chat)
    turn = practice.partner_turn("u1", SESSION, "own_followup", TASKS, "a", turns()[:1])
    assert "actual presentation" in calls[0]["system"]
    assert turns()[0]["text"] in calls[0]["user"]
    practice.verify_turns("u1", SESSION, [turn])
    with pytest.raises(ValueError):
        practice.partner_turn("u1", SESSION, "partner_presentation", TASKS, "a", [])


def test_session_rubric_uses_task_weights_and_global_language_once_without_fabricated_audio_scores(monkeypatch):
    monkeypatch.setattr(practice, "chat_json", lambda **kwargs: result())
    grade = practice.grade_speaking("u1", SESSION, TASKS, "a", turns())
    assert grade["scoreValue"] == grade["maxScoreValue"] == 32
    assert grade["officialMaxScoreValue"] == 48
    assert grade["completeOfficialEquivalent"] is False
    assert grade["rubric"]["pronunciation_intonation"]["score"] is None
    assert grade["rubric"]["fluency"]["score"] is None
    items = grade["examResultItems"]
    assert len(items) == 5
    assert [i["maxScoreValue"] for i in items] == [6, 4, 6, 8, 8]
    assert sum(i["metadata"]["scope"] == "global" for i in items) == 2
    assert all(i["firstAttemptCorrect"] is None and i["finalCorrect"] is None for i in items)
    assert len(grade["feedback"]["examples"]) == 1


def test_grade_rejects_monologue_or_skipped_summary(monkeypatch):
    monkeypatch.setattr(practice, "chat_json", lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not grade")))
    for incomplete in (turns()[:1], [t for t in turns() if t["stage"] != "summary"], turns()[:9]):
        with pytest.raises(ValueError):
            practice.grade_speaking("u1", SESSION, TASKS, "a", incomplete)


def test_speaking_rows_persist_idempotently_and_feed_rubric_weaknesses(monkeypatch):
    from app.routers.german_exam import SubmitExamResultsRequest, submit_exam_results_endpoint
    from app.services import german_exam_performance as performance
    from app.services.german_exam_adaptation import _attempt_score
    monkeypatch.setattr(practice, "chat_json", lambda **kwargs: result())
    grade = practice.grade_speaking("u1", SESSION, TASKS, "a", turns())
    saved = {}
    class DB:
        def table(self, name):
            assert name == "german_exam_attempts"
            return self
        def upsert(self, rows, **kwargs):
            assert kwargs == {"on_conflict": "id", "ignore_duplicates": True}
            for row in rows:
                saved.setdefault(row["id"], row)
            return self
        def execute(self):
            return None
    monkeypatch.setattr(performance, "get_supabase", DB)
    payload = SubmitExamResultsRequest(userId="u1", examFamily="telc", targetLevel="C1", module="speaking", items=grade["examResultItems"])
    for _ in range(2):
        assert submit_exam_results_endpoint(payload) == {"accepted": 5, "dropped": 0}
    assert len(saved) == 5
    assert all(row["first_attempt_correct"] is None and row["final_correct"] is None for row in saved.values())
    assert all(_attempt_score(row) == 1 for row in saved.values())
    assert all(row["metadata"]["rubric"] == grade["rubric"] for row in saved.values())


def test_speaking_adaptation_stays_within_c1_blueprint():
    from app.services.german_exam_adaptation import WeaknessReport, TagWeakness, build_adaptation_plan
    report = WeaknessReport(tags={tag: TagWeakness(tag, .2, 4, "low") for tag in ("interaction", "response_to_partner", "argumentation")})
    part = get_part("telc_c1_hochschule", "speaking", "sprechen_2")
    plan = build_adaptation_plan(part, "C1 Hochschule", report)
    assert plan and all(i.axis in part.allowed_adaptations for i in plan)
    assert part.constraints["discussionTopicCount"] == 1
