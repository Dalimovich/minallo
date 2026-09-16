"""generate_task()'s speculative/prefetch behavior: a speculative generation
must not record the chosen topic as used (that only happens once the
frontend actually consumes it, via POST /german-exam/consume), and every
generation gets a unique generationId in its envelope."""
from app.services import german_exam_generator as gen
from app.services.german_exam_profiles import get_part, get_profile


def _stub(monkeypatch, record_calls):
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: None)
    monkeypatch.setattr(gen, "build_adaptation_plan", lambda *a, **k: [])
    monkeypatch.setattr(gen, "pick_topic", lambda *a, **k: {"topicId": "urban_mobility", "label": "Stadtplanung"})
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: record_calls.append(a))
    monkeypatch.setattr(gen, "_generate_listening", lambda profile, part, plan, topic: ({"segments": [], "questions": []}, {"deterministicPassed": True}))


def test_speculative_generation_does_not_record_topic_used(monkeypatch):
    calls = []
    _stub(monkeypatch, calls)
    envelope = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice", speculative=True)
    assert calls == []
    assert envelope["generationId"]


def test_normal_generation_records_topic_used(monkeypatch):
    calls = []
    _stub(monkeypatch, calls)
    envelope = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice", speculative=False)
    assert len(calls) == 1
    assert calls[0] == ("u1", "telc_c1_hochschule", "listening", "hv1", "urban_mobility", envelope["generationId"])


def test_generation_id_is_unique_per_call(monkeypatch):
    calls = []
    _stub(monkeypatch, calls)
    e1 = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice", speculative=True)
    e2 = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice", speculative=True)
    assert e1["generationId"] != e2["generationId"]


def test_reading_module_dispatches_to_reading_adapter(monkeypatch):
    calls = []
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: None)
    monkeypatch.setattr(gen, "build_adaptation_plan", lambda *a, **k: [])
    monkeypatch.setattr(gen, "pick_topic", lambda *a, **k: {"topicId": "academic_writing_skills", "label": "Wissenschaftliches Schreiben"})
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(gen, "_generate_reading", lambda profile, part, plan, topic: ({"text": {}, "candidates": [], "questions": []}, {"deterministicPassed": True}))
    envelope = gen.generate_task("u1", "telc_c1_hochschule", "reading", "lesen_1", "adaptive_practice", speculative=False)
    assert envelope["module"] == "reading"
    assert envelope["part"]["id"] == "lesen_1"
    assert len(calls) == 1
