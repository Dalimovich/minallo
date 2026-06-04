"""Unit tests for Cheatsheet generation (Learning Agent Phase 4).

Topic selection is tested directly; generation uses fake retrieval / LLM / save
so no real DB or LLM calls happen.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import cheatsheet as cs  # noqa: E402


# ── topic selection ─────────────────────────────────────────────────────────


def test_topic_names_focus_overrides_map():
    tm = [{"name": "Friction"}, {"name": "Momentum"}]
    assert cs._topic_names(tm, "Energy") == ["Energy"]


def test_topic_names_uses_map_capped():
    tm = [{"name": f"T{i}"} for i in range(30)]
    out = cs._topic_names(tm, None)
    assert len(out) == cs._MAX_TOPICS
    assert out[0] == "T0"


def test_topic_names_empty_map():
    assert cs._topic_names([], None) == [None]


# ── sanitizer (Stage 4) ──────────────────────────────────────────────────────


def test_sanitize_strips_replacement_char():
    out, dropped = cs.sanitize_cheatsheet_markdown("## K�rpersystemen\n- text�")
    assert "�" not in out
    assert "## Krpersystemen" in out
    assert dropped == 0


def test_sanitize_drops_unbalanced_brace_formula():
    out, dropped = cs.sanitize_cheatsheet_markdown("$$\\frac{a}{b$$")
    assert dropped == 1
    assert "omitted" in out
    assert "frac" not in out


def test_sanitize_drops_equation_number_misread_as_formula():
    out, dropped = cs.sanitize_cheatsheet_markdown("Foo $$ (20) $$ bar")
    assert dropped == 1
    assert "(20)" not in out


def test_sanitize_keeps_valid_display_formula():
    src = "$$E_k = \\frac{1}{2} m v^2$$"
    out, dropped = cs.sanitize_cheatsheet_markdown(src)
    assert dropped == 0
    assert out == src


def test_sanitize_keeps_inline_symbols_and_strips_corruption_inside():
    out, dropped = cs.sanitize_cheatsheet_markdown("velocity $v�$ and $a=0$")
    assert dropped == 0
    assert "$v$" in out and "$a=0$" in out


def test_sanitize_removes_control_chars():
    out, _ = cs.sanitize_cheatsheet_markdown("a\x07b\x00c")
    assert out == "abc"


def test_sanitize_empty():
    assert cs.sanitize_cheatsheet_markdown("") == ("", 0)


# ── settings (Stage 3) ───────────────────────────────────────────────────────


def test_settings_default_is_balanced():
    cfg = cs.normalize_settings(None)
    assert cfg["preset"] == "balanced"
    assert cfg["pages"] == 2
    assert cfg["language"] == "source"
    assert cfg["columns"] == 3


def test_settings_unknown_preset_falls_back():
    assert cs.normalize_settings({"preset": "nonsense"})["preset"] == "balanced"


def test_settings_exam_night_defaults_one_page():
    cfg = cs.normalize_settings({"preset": "exam_night"})
    assert cfg["pages"] == 1
    assert cfg["columns"] == 4
    assert cfg["densityTarget"] == "16-24"


def test_settings_pages_clamped():
    # out-of-range pages ignored → preset default
    assert cs.normalize_settings({"preset": "balanced", "pages": 99})["pages"] == 2
    assert cs.normalize_settings({"preset": "balanced", "pages": 3})["pages"] == 3


def test_settings_language_override():
    assert cs.normalize_settings({"language": "de"})["language"] == "de"
    assert "German" in cs.normalize_settings({"language": "de"})["langInstruction"]
    assert cs.normalize_settings({"language": "klingon"})["language"] == "source"


def test_settings_maxtopics_scales_with_pages():
    one = cs.normalize_settings({"preset": "deep_revision", "pages": 1})["maxTopics"]
    four = cs.normalize_settings({"preset": "deep_revision", "pages": 4})["maxTopics"]
    assert four > one
    assert 4 <= one <= 20 and 4 <= four <= 20


# ── grounding (Stage 2) ──────────────────────────────────────────────────────


def test_grounding_none_when_no_display_formulas():
    g = cs.formula_grounding("just text, $inline$ only", [])
    assert g["ratio"] is None
    assert g["total"] == 0


def test_grounding_formula_matched_to_evidence():
    text = "$$E_{kin} = \\frac{1}{2} m v^2$$"
    evidence = [{"text": "The kinetic energy E_kin depends on m and v squared."}]
    g = cs.formula_grounding(text, evidence)
    assert g["total"] == 1
    assert g["grounded"] == 1
    assert g["ratio"] == 1.0


def test_grounding_flags_ungrounded_formula():
    text = "$$\\zeta_{xyz} = \\alpha_{qrs} + \\beta_{tuv}$$"
    evidence = [{"text": "completely unrelated lecture content about history"}]
    g = cs.formula_grounding(text, evidence)
    assert g["total"] == 1
    assert g["grounded"] == 0
    assert g["ratio"] == 0.0


def test_grounding_single_symbol_not_penalized():
    # No multi-char token to disprove → treated as grounded (no false alarm).
    g = cs.formula_grounding("$$x$$", [{"text": "nothing relevant"}])
    assert g["grounded"] == 1


# ── generation ──────────────────────────────────────────────────────────────


class _FakeChatResult:
    def __init__(self, data):
        self.data = data
        self.model = "fake-model"
        self.prompt_tokens = 5
        self.completion_tokens = 50


def test_generate_cheatsheet_grounded(monkeypatch):
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: [{"name": "Friction"}])

    def _fake_retrieve(**k):
        assert k["purpose"] == "cheatsheet"
        return [
            {"chunkId": "c1", "documentId": "d1", "pageStart": 4, "text": "F = μN"},
            {"chunkId": "c2", "documentId": "d1", "pageStart": 5, "text": "Static vs kinetic"},
        ]

    monkeypatch.setattr(cs, "retrieve_learning_context", _fake_retrieve)
    monkeypatch.setattr(cs, "chat_json", lambda **k: _FakeChatResult({"text": "## Friction\n- $F=\\mu N$ (a.pdf, p.4)"}))
    saved = {}
    def _fake_save(**k):
        saved.update(k)
        return "note-123"
    monkeypatch.setattr(cs, "save_note", _fake_save)

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=["d1"], topic=None,
        doc_names={"d1": "a.pdf"}, save=True,
    )
    assert out["noteId"] == "note-123"
    assert out["topicsCovered"] == ["Friction"]
    assert "Friction" in out["text"]
    assert out["model"] == "fake-model"
    # grounded sources carry the filename + chunk linkage
    assert out["groundedSources"][0]["fileName"] == "a.pdf"
    assert out["groundedSources"][0]["chunkId"] == "c1"
    # saved as a cheatsheet-typed note
    assert saved["note_type"] == "cheatsheet"
    assert saved["title"] == "Course Cheatsheet"


def test_generate_cheatsheet_no_evidence_warns(monkeypatch):
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: [])
    monkeypatch.setattr(cs, "retrieve_learning_context", lambda **k: [])
    called = {"chat": 0, "save": 0}
    monkeypatch.setattr(cs, "chat_json", lambda **k: called.__setitem__("chat", called["chat"] + 1))
    monkeypatch.setattr(cs, "save_note", lambda **k: called.__setitem__("save", called["save"] + 1))

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None, doc_names={}, save=True,
    )
    assert out["text"] == ""
    assert out["warning"]
    assert called["chat"] == 0  # no LLM call when there's nothing to ground in
    assert called["save"] == 0


def test_generate_cheatsheet_topic_focus_titles(monkeypatch):
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: [{"name": "Other"}])
    monkeypatch.setattr(
        cs, "retrieve_learning_context",
        lambda **k: [{"chunkId": "c1", "documentId": "d1", "pageStart": 1, "text": "x"}],
    )
    monkeypatch.setattr(cs, "chat_json", lambda **k: _FakeChatResult({"text": "## Energy\n- stuff"}))
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=["d1"], topic="Energy",
        doc_names={"d1": "a.pdf"}, save=True,
    )
    assert out["title"] == "Energy — Cheatsheet"
    assert out["topicsCovered"] == ["Energy"]
