"""Unit tests for Deep Learn (Learning Agent Phase 5)."""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import deep_learn as dl  # noqa: E402


class _FakeChatResult:
    def __init__(self, data):
        self.data = data
        self.model = "fake-model"
        self.prompt_tokens = 7
        self.completion_tokens = 70


def test_system_prompt_requires_katex_math_formatting():
    # The lesson renderer only displays $…$/$$…$$ math; the prompt must force the
    # model to delimit every expression so it doesn't ship plain-text math.
    sys = dl._SYSTEM
    assert "Math formatting (STRICT" in sys
    assert "$f(x)=\\frac{x}{1+x^2}$" in sys
    assert "NEVER use \\[ ... \\] or \\( ... \\)" in sys
    assert "bare LaTeX command" in sys
    # keyFormulas.formula must stay raw (the formula card wraps it itself).
    assert "keyFormulas.formula stays raw LaTeX WITHOUT $ delimiters" in sys


def test_sources_indexed_for_clickability():
    chunks = [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 3, "pageEnd": 3},
        {"chunkId": "c2", "documentId": "d2", "pageStart": 5, "pageEnd": 6},
    ]
    out = dl._sources(chunks, {"d1": "A.pdf", "d2": "B.pdf"})
    assert [s["index"] for s in out] == [1, 2]
    assert out[0]["fileName"] == "A.pdf"
    assert out[1]["pageStart"] == 5


def test_generate_deep_learn_structured(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 4, "text": "Friction opposes motion."},
    ])
    monkeypatch.setattr(dl, "chat_json", lambda **k: _FakeChatResult({
        "title": "Friction",
        "lesson": "## Idea\nFriction opposes motion (Mech.pdf, p.4)",
        "workedExamples": [{
            "problem": "Block on incline",
            "solutionSteps": ["Apply the friction definition."],
            "finalAnswer": "F_f = mu N",
            "sourceOrBasis": "Source 1: Mech.pdf, p.4",
        }],
        "check": {"question": "What does friction oppose?", "answer": "Relative motion", "explanation": "By definition"},
    }))

    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="Friction", document_ids=["d1"],
        doc_names={"d1": "Mech.pdf"},
    )
    assert out["title"] == "Friction"
    assert "Friction" in out["lesson"]
    assert out["workedExample"]
    assert out["check"]["answer"] == "Relative motion"
    assert out["groundedSources"][0]["fileName"] == "Mech.pdf"
    assert out["groundedSources"][0]["index"] == 1


def test_generate_deep_learn_adapts_lesson_mode_without_forced_formulas(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {
            "chunkId": "c1",
            "documentId": "d1",
            "pageStart": 2,
            "text": "The lecture compares two interpretations of democratic legitimacy.",
        },
    ])
    seen = {}

    def fake_chat_json(**kwargs):
        seen["user"] = kwargs["user"]
        return _FakeChatResult({
            "title": "Democratic legitimacy",
            "subjectArea": "Political science",
            "contentType": "Concept comparison",
            "learningGoal": "Compare two interpretations.",
            "adaptiveBlocks": [{
                "type": "Comparison Table",
                "title": "Interpretation map",
                "body": "One interpretation stresses consent; the other stresses institutional procedure.",
                "items": ["Consent-based legitimacy", "Procedure-based legitimacy"],
                "source": "PolSci.pdf, p.2",
            }],
            "selfCheck": [{
                "question": "What is the key contrast?",
                "hint": "Look at what each view treats as decisive.",
                "answer": "Consent versus institutional procedure.",
                "stepByStep": ["Identify the basis of legitimacy.", "Compare the two bases."],
            }],
        })

    monkeypatch.setattr(dl, "chat_json", fake_chat_json)
    out = dl.generate_deep_learn(
        user_id="u",
        course_id="c",
        topic="Democratic legitimacy",
        document_ids=["d1"],
        doc_names={"d1": "PolSci.pdf"},
        lesson_mode="revision",
    )
    lesson = out["structuredLesson"]
    assert "LESSON MODE: Fast Revision" in seen["user"]
    assert lesson["lessonMode"] == "Fast Revision"
    assert lesson["subjectArea"] == "Political science"
    assert lesson["keyFormulas"] == []
    assert lesson["adaptiveBlocks"][0]["type"] == "Comparison Table"
    assert lesson["selfCheck"][0]["hint"] == "Look at what each view treats as decisive."


def test_generate_deep_learn_validates_formula_method_example_and_language(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {
            "chunkId": "c1",
            "documentId": "d1",
            "pageStart": 7,
            "text": "Dynamik von Punktmassen: Arbeitssatz Delta E_k = W. Kraefte, Freikoerperbild, Einheiten.",
        },
        {
            "chunkId": "c2",
            "documentId": "d1",
            "pageStart": 8,
            "text": "Massentraegheitsmoment: Theta_A = integral r^2 dm.",
        },
    ])
    seen = {}

    def fake_chat_json(**kwargs):
        seen["user"] = kwargs["user"]
        return _FakeChatResult({
            "title": "Dynamik von Punktmassen",
            "learningGoal": "Verstehen",
            "coreExplanation": "Punktmassen werden mit Kraeften beschrieben.",
            "keyFormulas": [
                {
                    "formula": "Ek0 = W(e) + W(i) = W Ek",
                    "meaning": "Initial kinetic energy is the sum of work.",
                    "source": "Source 1: Mech.pdf, p.7",
                },
                {
                    "formula": "Delta E_k = W",
                    "meaning": "Die Aenderung der kinetischen Energie ist gleich der Arbeit.",
                    "source": "Source 1: Mech.pdf, p.7",
                },
                {
                    "formula": "Theta_A = integral r^2 dm",
                    "meaning": "Massentraegheitsmoment",
                    "source": "Source 2: Mech.pdf, p.8",
                },
            ],
            "stepByStepMethod": ["No strong course evidence for this section."],
            "workedExamples": [{
                "title": "Seilaufgabe",
                "problem": "Zwei Massen am Seil.",
                "solutionSteps": ["Kraeftegleichungen aufstellen."],
                "finalAnswer": "Calculate the individual accelerations and tension in the rope.",
                "sourceOrBasis": "Source 1: Mech.pdf, p.7",
            }],
        })

    monkeypatch.setattr(dl, "chat_json", fake_chat_json)
    out = dl.generate_deep_learn(
        user_id="u",
        course_id="c",
        topic="Dynamik von Punktmassen",
        document_ids=["d1"],
        doc_names={"d1": "Mech.pdf"},
        lesson_language="de",
    )
    lesson = out["structuredLesson"]
    formulas = lesson["keyFormulas"]
    assert "LESSON LANGUAGE: German" in seen["user"]
    assert [f["formula"] for f in formulas] == ["Delta E_k = W", "Theta_A = integral r^2 dm"]
    assert formulas[0]["relevance"] == "core"
    assert formulas[1]["relevance"] == "related"
    assert "No strong course evidence" not in " ".join(lesson["stepByStepMethod"])
    assert lesson["workedExamples"] == []
    assert lesson["workedExample"]["problem"] == ""
    assert lesson["practiceTasks"][0]["prompt"] == "Zwei Massen am Seil."
    assert "Formelkarten" in lesson["citationWarning"]


def test_generate_deep_learn_no_evidence_warns(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [])
    called = {"chat": 0}
    monkeypatch.setattr(dl, "chat_json", lambda **k: called.__setitem__("chat", called["chat"] + 1))
    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="Nonexistent", document_ids=None, doc_names={},
    )
    assert out["warning"]
    assert out["lesson"] == ""
    assert out["check"] is None
    assert called["chat"] == 0  # no LLM call without evidence


def test_generate_deep_learn_requires_topic():
    out = dl.generate_deep_learn(user_id="u", course_id="c", topic="  ", document_ids=None, doc_names={})
    assert out["error"]


def test_generate_deep_learn_drops_empty_check(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 1, "text": "x"},
    ])
    monkeypatch.setattr(dl, "chat_json", lambda **k: _FakeChatResult({
        "title": "T", "lesson": "L", "workedExample": "", "check": {"question": "  "},
    }))
    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="T", document_ids=None, doc_names={"d1": "a.pdf"},
    )
    assert out["check"] is None
