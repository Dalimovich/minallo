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
from app.services import cheatsheet_quality as cq  # noqa: E402


# ── topic selection ─────────────────────────────────────────────────────────


def test_topic_names_focus_overrides_map():
    tm = [{"name": "Friction"}, {"name": "Momentum"}]
    assert cs._topic_names(tm, "Energy") == ["Arbeit, Energie und Leistung"]


def test_topic_names_uses_map_capped():
    tm = [{"name": f"T{i}"} for i in range(30)]
    out = cs._topic_names(tm, None)
    assert len(out) == cs._MAX_TOPICS
    assert out[0] == "T0"


def test_topic_names_empty_map():
    assert cs._topic_names([], None) == [None]


def test_topic_names_merge_german_english_mechanics_duplicates():
    tm = [
        {"name": "Dynamik von K\u00c3\u00b6rpersystemen"},
        {"name": "Dynamics of Systems of Point Masses"},
        {"name": "Kinematik"},
    ]
    out = cs._topic_names(tm, None)
    assert out == ["Kinematik eines Punktes", "Dynamik von Punktsystemen"]


def test_topic_focus_is_canonicalized_for_mechanics():
    assert cs._topic_names([], "projectile motion") == ["Wurfbewegung"]


def test_canonicalization_ignores_compound_word_false_positives():
    # Word-START matching: "work"/"power" must not match as a mere suffix of an
    # unrelated compound word (the old substring bug mapped these to mechanics).
    for benign in ("network protocols", "homework", "framework", "horsepower"):
        assert cs._canonical_mechanics_topic(benign) == benign
    # German morphology still canonicalizes (alias is a word-prefix).
    assert cs._canonical_mechanics_topic("Koerpersystemen") == "Dynamik von Punktsystemen"


def test_topic_query_keeps_aliases_for_retrieval():
    query = cs._topic_query("Dynamik von Punktsystemen")
    assert "systems of point masses" in query
    assert "Dynamik von Punktsystemen" in query


def test_trap_guidance_uses_precise_curated_traps():
    guidance = cs._trap_guidance(["Reibung und Widerstand", "Rollbewegung"])
    assert "Static friction is not automatically" in guidance
    assert "Rolling constraint" in guidance
    assert "Direction matters" not in guidance


def test_formula_bank_guidance_is_source_support_only():
    guidance = cs._formula_bank_guidance(["Kinematik eines Punktes"])
    assert r"v = \frac{dx}{dt}" in guidance
    assert "include a formula only when the COURSE CONTEXT supports it" in guidance
    assert cs._formula_bank_guidance(["Unknown topic"]) == ""


def test_taxonomy_classifies_and_scores_high_entropy_formula():
    formula = r"m(\ddot r-r\dot\varphi^2)=\sum F_r"
    assert cs._classify_item(formula) == "formula"
    formula_score = cs._content_score(formula)
    filler_score = cs._content_score("Forces affect motion.")
    assert formula_score["entropyScore"] > filler_score["entropyScore"]
    assert formula_score["examUtilityScore"] > filler_score["examUtilityScore"]


def test_architecture_guidance_includes_spatial_map_and_method_picker():
    cfg = cs.normalize_settings({"preset": "exam_night"})
    guidance = cs._architecture_guidance(
        evidence=[{
            "chunkId": "c1",
            "documentId": "d1",
            "pageStart": 3,
            "text": r"m(\ddot r-r\dot\varphi^2)=\sum F_r",
        }],
        topics=["Polarkoordinaten", "Arbeit, Energie und Leistung"],
        doc_names={"d1": "mec.pdf"},
        cfg=cfg,
    )
    assert "INFORMATION ARCHITECTURE RULES" in guidance
    assert "SPATIAL LAYOUT MAP" in guidance
    assert "METHOD PICKER" in guidance
    assert "TAXONOMY + HIGH-ENTROPY CANDIDATES" in guidance
    assert "mec.pdf, p.3" in guidance


def test_remove_generic_filler_notes():
    md = "## Dynamik\n- Direction matters.\n- Static friction is not automatically mu_0 N."
    out, removed = cs.remove_generic_filler_notes(md)
    assert removed == 1
    assert "Direction matters" not in out
    assert "Static friction" in out


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


def test_sanitize_trims_dangling_truncated_formula():
    # Salvaged/truncated sheet ends with an unterminated $$ → trim it.
    out, _ = cs.sanitize_cheatsheet_markdown("## A\n$$E=mc^2$$\n## B\n$$F = m a")
    assert out.count("$$") % 2 == 0
    assert "$$E=mc^2$$" in out
    assert "F = m a" not in out


def test_math_normalization_repairs_mojibake_symbols_and_units():
    assert cq.repair_mojibake("1extJ = 1extNm") == "1 J = 1 N\u00b7m"
    assert cq.formula_to_latexish("\u00ce\u00bc\u00e2\u201a\u201a N") == r"\mu_2 N"
    assert cq.formula_to_latexish("v = \u00e2\u02c6\u00ab a(t)dt") == r"v = \int a(t)dt"


def test_formula_corruption_rejects_placeholders_and_garbage():
    assert "fake-citation-placeholder" in cq.formula_corruption_reasons("(filename, p.N)")
    assert "ocr-garbage" in cq.formula_corruption_reasons("\u00ce\u00b8=90 e xto")
    assert cq.normalize_formula_text("1extJ = 1extNm") is not None


def test_sanitize_normalizes_output_formula_mojibake():
    out, dropped = cs.sanitize_cheatsheet_markdown("$$F = \u00ce\u00bcm\u00e2\u201a\u20ac N$$")
    assert dropped == 0
    assert r"\mu" in out
    assert "\u00ce\u00bc" not in out
    assert "\u00e2\u201a\u20ac" not in out


def test_evidence_normalization_drops_corrupt_formula_lines():
    chunks = [
        {
            "chunkId": "c1",
            "documentId": "d1",
            "pageStart": 2,
            "text": "good line\n\u00ce\u00b8=90 e xto\n1extJ = 1extNm",
        }
    ]
    out, stats = cq.normalize_evidence_chunks(chunks)
    assert len(out) == 1
    assert "good line" in out[0]["text"]
    assert "e xto" not in out[0]["text"]
    assert "1 J = 1 N\u00b7m" in out[0]["text"]
    assert stats.dropped_formula_lines == 1


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
    assert "Exam Night" in cfg["purposeInstruction"]


def test_settings_new_purpose_presets():
    open_book = cs.normalize_settings({"preset": "open_book_exam"})
    formula_ref = cs.normalize_settings({"preset": "formula_reference"})
    assert open_book["preset"] == "open_book_exam"
    assert "Open-book Exam" in open_book["purposeInstruction"]
    assert formula_ref["preset"] == "formula_reference"
    assert formula_ref["columns"] == 4
    assert "Formula Reference" in formula_ref["purposeInstruction"]


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


def test_settings_expanded_controls_affect_budget_and_layout():
    cfg = cs.normalize_settings({
        "pages": 4,
        "columns": 4,
        "style": "compact",
        "fontSize": "small",
        "detailLevel": "very_thorough",
        "focusMode": "selected_files",
        "language": "de_terms_en_explanations",
        "output": "pdf",
    })
    assert cfg["columns"] == 4
    assert cfg["style"] == "compact"
    assert cfg["font"] == "xs"
    assert cfg["detailLevel"] == "very_thorough"
    assert cfg["focusMode"] == "selected_files"
    assert cfg["language"] == "de_terms_en_explanations"
    assert cfg["output"] == "pdf"
    assert cfg["perTopicTopK"] == 7
    assert cfg["maxEvidence"] == 60
    assert cfg["maxTopics"] > cs.normalize_settings({"detailLevel": "general"})["maxTopics"]


def test_settings_invalid_expanded_controls_fall_back():
    cfg = cs.normalize_settings({
        "columns": 99,
        "style": "nope",
        "fontSize": "huge",
        "detailLevel": "encyclopedia",
        "focusMode": "magic",
        "output": "printer",
    })
    assert cfg["columns"] == 3
    assert cfg["style"] == "academic"
    assert cfg["fontSize"] == "auto"
    assert cfg["detailLevel"] == "balanced"
    assert cfg["focusMode"] == "whole_course"
    assert cfg["output"] == "both"


# ── per-PDF dedup ────────────────────────────────────────────────────────────


def test_dedup_removes_exact_repeat_keeps_first():
    md = "## A.pdf\n$$E = m c^2$$\n## B.pdf\n$$E = m c^2$$"
    out, removed = cs.dedup_display_formulas(md)
    assert removed == 1
    assert out.count("E = m c^2") == 1          # only the first survives
    assert "see above" in out                    # later one marked


def test_dedup_ignores_whitespace_differences():
    md = "$$F=ma$$\n$$F = m a$$"
    out, removed = cs.dedup_display_formulas(md)
    assert removed == 1


def test_dedup_keeps_distinct_formulas():
    md = "$$a^2+b^2=c^2$$\n$$E=mc^2$$"
    out, removed = cs.dedup_display_formulas(md)
    assert removed == 0


def test_dedup_trims_emptied_bullet():
    md = "$$x=1$$\n- $$x=1$$"
    out, removed = cs.dedup_display_formulas(md)
    assert removed == 1
    # the bullet that held only the duplicate is gone
    assert "\n- \n" not in out and not out.rstrip().endswith("-")


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


def test_source_gate_drops_unsupported_display_formula():
    text = "$$\\zeta_{xyz} = \\alpha_{qrs} + \\beta_{tuv}$$"
    out, removed = cs.drop_unsupported_display_formulas(
        text,
        [{"text": "course source only has F = m a"}],
    )
    assert removed == 1
    assert "\\zeta" not in out
    assert "not supported" in out


def test_source_gate_keeps_supported_display_formula():
    text = "$$E_{kin} = \\frac{1}{2} m v^2$$"
    out, removed = cs.drop_unsupported_display_formulas(
        text,
        [{"text": "The source states E_kin and m and v for kinetic energy."}],
    )
    assert removed == 0
    assert "E_{kin}" in out


# ── generation ──────────────────────────────────────────────────────────────


def test_quality_metrics_surface_deterministic_counts():
    stats = cq.EvidenceNormalizationStats(dropped_formula_lines=1)
    metrics = cs._quality_metrics(
        text="$$E = m c^2$$",
        topics=["Arbeit, Energie und Leistung"],
        sources=[{"chunkId": "c1"}],
        grounding={"total": 1, "grounded": 1, "ratio": 1.0},
        cfg=cs.normalize_settings({"detailLevel": "general"}),
        dropped_formulas=1,
        unsupported_formulas=2,
        filler_notes=3,
        evidence_quality=stats,
    )
    assert metrics["formulaCount"] == 1
    assert metrics["sourceSupport"] == 100
    assert metrics["corruptionCount"] == 2
    assert metrics["unsupportedFormulaCount"] == 2
    assert metrics["genericFillerCount"] == 3


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
    assert out["topicsCovered"] == ["Reibung und Widerstand"]
    assert "Friction" in out["text"]
    assert out["quality"]["metrics"]["citationCoverage"] == 100
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
    assert out["topicsCovered"] == ["Arbeit, Energie und Leistung"]
