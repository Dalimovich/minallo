"""generate_task()'s listening answer-key protection (german_exam_generator.
_secure_listening_envelope) — closes the exposure audited 2026-10-10: the generated (AI) Hören
path used to hand the browser the full answer key (matching.correctSpeakerId, mc3.correctIndex,
note.correctFill, tristate.answer, matching.evidenceSegmentIds) embedded in every question,
because nothing held it server-side between generation and grading. These tests prove that is no
longer true for BOTH paths generate_task() can take — live generation and the stocked/inventory
serve path — and that the stored grading_content is what german_exam_listening_grading.
build_grading_content actually produces, not a re-derivation of it.

Mocked throughout, same style as test_german_exam_generator.py: compute_weakness/
build_adaptation_plan/pick_topic/record_topic_used/_generate_listening are stubbed, and
listening_practice_state.create_generation is stubbed to a recording fake instead of hitting
Supabase — no network, no database."""

from __future__ import annotations

from app.services import german_exam_generator as gen
from app.services import german_exam_listening_grading as grading


def _stub_common(monkeypatch):
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: None)
    monkeypatch.setattr(gen, "build_adaptation_plan", lambda *a, **k: [])
    monkeypatch.setattr(gen, "pick_topic", lambda *a, **k: {"topicId": "urban_mobility", "label": "Stadtplanung"})
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: None)


def _matching_generated_content() -> dict:
    return {
        "segments": [{"id": "s1", "speakerId": "speaker_1"}, {"id": "s2", "speakerId": "speaker_2"}],
        "questions": [
            {"questionId": "q1", "prompt": "Quelle 2 sagt X.",
             "matching": {"correctSpeakerId": "speaker_2", "isDistractor": False, "evidenceSegmentIds": ["s2"]}},
            {"questionId": "q2", "prompt": "Niemand sagt das.",
             "matching": {"correctSpeakerId": None, "isDistractor": True, "evidenceSegmentIds": []}},
        ],
    }


def _recording_create_generation(monkeypatch, store: list):
    def fake(user_id, part_id, grading_content, *, generation_id):
        store.append({"user_id": user_id, "part_id": part_id, "grading_content": grading_content, "generation_id": generation_id})
        return generation_id

    monkeypatch.setattr(gen.listening_practice_state, "create_generation", fake)


# ---- live generation path -----------------------------------------------------------------

def test_live_generated_envelope_contains_no_answer_key_fields(monkeypatch):
    _stub_common(monkeypatch)
    stored = []
    _recording_create_generation(monkeypatch, stored)
    monkeypatch.setattr(gen, "_generate_listening", lambda profile, part, plan, topic: (_matching_generated_content(), {"deterministicPassed": True}))

    envelope = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice")

    serialized = str(envelope)
    assert "correctSpeakerId" not in serialized
    assert "evidenceSegmentIds" not in serialized
    q1 = envelope["content"]["questions"][0]
    assert q1["prompt"] == "Quelle 2 sagt X."  # non-answer fields survive
    assert set(q1["matching"]) == {"isDistractor"}  # correctSpeakerId/evidenceSegmentIds gone, isDistractor stays


def test_live_generation_stores_grading_content_server_side_keyed_by_the_envelopes_own_generation_id(monkeypatch):
    _stub_common(monkeypatch)
    stored = []
    _recording_create_generation(monkeypatch, stored)
    monkeypatch.setattr(gen, "_generate_listening", lambda profile, part, plan, topic: (_matching_generated_content(), {"deterministicPassed": True}))

    envelope = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice")

    assert len(stored) == 1
    assert stored[0]["user_id"] == "u1"
    assert stored[0]["part_id"] == "hv1"
    assert stored[0]["generation_id"] == envelope["generationId"]
    assert stored[0]["grading_content"] == grading.build_grading_content("speaker_statement_matching", _matching_generated_content())
    assert stored[0]["grading_content"]["q1"]["correct"] == "speaker_2"


def test_non_listening_modules_never_touch_listening_practice_state(monkeypatch):
    _stub_common(monkeypatch)
    stored = []
    _recording_create_generation(monkeypatch, stored)
    monkeypatch.setattr(gen, "_generate_reading", lambda profile, part, plan, topic: ({"text": {}, "candidates": [], "questions": []}, {"deterministicPassed": True}))

    gen.generate_task("u1", "telc_c1_hochschule", "reading", "lesen_1", "adaptive_practice")

    assert stored == []


# ---- stocked/inventory serve path -----------------------------------------------------------

def test_stocked_listening_envelope_is_equally_stripped(monkeypatch):
    """The inventory path (german_exam_inventory.take()) forwards a previously-built envelope
    unchanged — this proves _secure_listening_envelope is applied there too, not only to live
    generation, since both paths previously shipped the answer key just the same."""
    _stub_common(monkeypatch)
    stored = []
    _recording_create_generation(monkeypatch, stored)
    stocked_envelope = {
        "schemaVersion": "german-exam-v1",
        "generationId": "stock-gen-1",
        "inventoryId": "row-1",
        "source": "inventory",
        "module": "listening",
        "part": {"id": "hv1", "title": "x", "taskType": "speaker_statement_matching", "approxDurationSeconds": 600},
        "content": _matching_generated_content(),
        "topic": {"topicId": "urban_mobility", "label": "Stadtplanung"},
    }
    monkeypatch.setattr(gen.german_exam_inventory, "is_stocked", lambda *a, **k: True)
    monkeypatch.setattr(gen.german_exam_inventory, "take", lambda *a, **k: stocked_envelope)

    envelope = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice")

    assert "correctSpeakerId" not in str(envelope)
    assert len(stored) == 1
    assert stored[0]["generation_id"] == "stock-gen-1"
    assert stored[0]["grading_content"]["q1"]["correct"] == "speaker_2"
