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
    assert "supports them" in guidance  # still gated on source support
    assert cs._formula_bank_guidance(["Unknown topic"]) == ""


def test_formula_bank_anchors_cartesian_coordinates():
    # Kartesische needs its own formulas so it stops borrowing constant-accel ones
    guidance = cs._formula_bank_guidance(["Kartesische Koordinaten"])
    assert r"\vec e_x" in guidance
    assert "x_0 + v_0 t" not in guidance  # NOT constant-acceleration


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
    # the broken formula is dropped silently — never a printed failure marker
    assert "omitted" not in out.lower()
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
    # Ceiling is the whole-course skeleton depth; parallel section generation
    # means the full count fans out into shards rather than one long call.
    assert 4 <= one <= cs._MAX_TOPICS and 4 <= four <= cs._MAX_TOPICS


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


# ── math gate (Stage C) ──────────────────────────────────────────────────────


def test_formula_count_counts_inline_and_display():
    text = "intro $a=v_0$ and $$F = m a$$ plus $E=mc^2$"
    assert cs._formula_count(text) == 3


def test_sanitize_normalises_paren_math_delimiters():
    out, _ = cs.sanitize_cheatsheet_markdown(r"position \(\mathbf{r}\) and \[F = m a\]")
    assert r"\(" not in out and r"\)" not in out
    assert r"\[" not in out and r"\]" not in out
    assert "$\\mathbf{r}$" in out
    assert "$$F = m a$$" in out


def test_sanitize_collapses_doubled_backslash_command():
    out, _ = cs.sanitize_cheatsheet_markdown(r"$\\dot{r} \\mathbf{e}_r$")
    assert "\\\\dot" not in out
    assert "\\dot{r}" in out


def test_sanitize_rewrites_text_wrapped_operators():
    out, _ = cs.sanitize_cheatsheet_markdown(r"$x = v_0 \text{cos}\beta\, t$")
    assert r"\text{cos}" not in out
    assert r"\cos" in out
    # mathrm-wrapped operators too
    assert cq.formula_to_latexish(r"\mathrm{sin}^2\alpha") == r"\sin^2\alpha"


def test_doubled_backslash_repair_keeps_matrix_row_break():
    # ``\\`` followed by whitespace is a real row break and must survive.
    assert cq.formula_to_latexish(r"\begin{matrix} a \\ b \end{matrix}") == \
        r"\begin{matrix} a \\ b \end{matrix}"


def test_gate_flags_missing_method_picker_and_no_formulas():
    cfg = cs.normalize_settings({"preset": "balanced"})
    text = "## Kinematik\nMotion is the study of movement and its effects on bodies."
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=True)
    assert "missing-method-picker" in fails
    assert "no-formulas" in fails


def test_gate_flags_missing_open_book_label():
    cfg = cs.normalize_settings({"preset": "open_book_exam"})
    text = "## Work\n**Formulas:**\n$W = F d$"
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert any(f.startswith("missing-label:use when") for f in fails)


def test_gate_passes_good_open_book_shard():
    cfg = cs.normalize_settings({"preset": "open_book_exam"})
    text = (
        "## Method Picker\n| a | b |\n|---|---|\n| x | y |\n\n"
        "## Work\n**Use when:** force over a path\n**Formulas:**\n$W = F d$\n"
        "**Watch out:** friction work is negative"
    )
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=True)
    assert fails == []


def test_gate_counts_bare_formulas_as_present():
    cfg = cs.normalize_settings({"preset": "exam_night"})
    # bare LaTeX (no $) still counts — sanitize would wrap it
    text = "## Kinematik\nv = \\frac{dx}{dt}\na = \\frac{dv}{dt}"
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert "no-formulas" not in fails


def test_gate_regenerates_failing_shard(monkeypatch):
    calls = {"n": 0}

    def fake_chat(**k):
        calls["n"] += 1
        if calls["n"] == 1:
            # initial: prose-only, no formula → fails the gate
            return _FakeChatResult({"text": "## Reibung\nFriction always opposes motion here."})
        # retry: now carries a grounded formula
        return _FakeChatResult({"text": "## Reibung\n**Use when:** friction\n$R = \\mu N$"})

    monkeypatch.setattr(cs, "chat_json", fake_chat)
    cfg = cs.normalize_settings({"preset": "balanced"})
    groups = [("Reibung und Widerstand", [{"chunkId": "c1", "documentId": "d1", "text": "R = mu N"}])]
    text, diag = cs._generate_sections_parallel(
        cfg=cfg, groups=groups, doc_names={"d1": "a.pdf"}, per_pdf=True,  # per_pdf=True → no method-picker requirement
    )
    assert diag["shardsRegenerated"] == 1
    assert "no-formulas" in diag["gateFailuresInitial"]
    assert "\\mu N" in text


def test_corrective_guidance_mentions_failures():
    g = cs._corrective_guidance(["missing-method-picker", "missing-label:use when"])
    assert "Method Picker" in g
    assert "Use When" in g
    assert cs._corrective_guidance([]) == ""


def test_each_preset_injects_distinct_section_format():
    markers = {
        "exam_night": "EXAM NIGHT FORMAT",
        "open_book_exam": "OPEN-BOOK EXAM FORMAT",
        "formula_reference": "FORMULA REFERENCE FORMAT",
        "balanced": "BALANCED STUDY FORMAT",
        "deep_revision": "DEEP REVISION FORMAT",
        "topic_mastery": "TOPIC MASTERY FORMAT",
    }
    for preset, marker in markers.items():
        cfg = cs.normalize_settings({"preset": preset})
        prompt = cs._shard_system_prompt(cfg, ["Polarkoordinaten"], with_method_picker=False)
        assert marker in prompt, preset
        # a preset must not leak another preset's format
        for other_preset, other in markers.items():
            if other_preset != preset:
                assert other not in prompt, (preset, other_preset)


def test_open_book_uses_use_when_labels():
    cfg = cs.normalize_settings({"preset": "open_book_exam"})
    prompt = cs._shard_system_prompt(cfg, ["Reibung und Widerstand"], with_method_picker=False)
    assert "**Use when:**" in prompt
    assert "**Watch out:**" in prompt


def test_sanitize_strips_emoji_bullets():
    out, _ = cs.sanitize_cheatsheet_markdown("- ⏳ Lange Nutzungsdauer\n- ✅ Gut\n- 🔧 Werkzeug")
    for ch in ("⏳", "✅", "🔧"):
        assert ch not in out
    assert "Lange Nutzungsdauer" in out
    assert "- Lange Nutzungsdauer" in out  # bullet kept, double space collapsed


def test_sanitize_strips_stray_carets_outside_math():
    out, _ = cs.sanitize_cheatsheet_markdown("- ^Hohe Approximationsgenauigkeit^\nv = $a^2$")
    assert "^Hohe" not in out and "genauigkeit^" not in out
    assert "Hohe Approximationsgenauigkeit" in out
    assert "$a^2$" in out  # caret inside math preserved


def test_din_classification_topics_deduped_and_first():
    tm = [
        {"name": "Gießverfahren"},
        {"name": "DIN 8580"},
        {"name": "Fertigungsverfahren"},
        {"name": "Fertigungsverfahren nach DIN 8580"},
        {"name": "Drehen"},
    ]
    names = cs._topic_names(tm, None, limit=10)
    # The three DIN/Fertigungsverfahren overview topics collapse to one canonical.
    din = [n for n in names if "DIN 8580" in n]
    assert din == ["Fertigungsverfahren nach DIN 8580"]
    # ...and the backbone is ordered first.
    assert names[0] == "Fertigungsverfahren nach DIN 8580"
    # a specific family ("Gießverfahren") is NOT merged away
    assert "Gießverfahren" in names


def test_repair_mangled_highlight_closer():
    # `==text!=` (closing == mangled to !=) → `==text==`, observed in real output.
    out, _ = cs.sanitize_cheatsheet_markdown("**Merken:** ==Spritzgießen eignet sich!=")
    assert "==Spritzgießen eignet sich==" in out
    assert "!=" not in out


def test_strip_unpaired_highlight_marker():
    out, _ = cs.sanitize_cheatsheet_markdown("a ==dangling highlight without close")
    assert "==" not in out
    assert "dangling highlight without close" in out


def test_valid_highlight_marker_untouched():
    out, _ = cs.sanitize_cheatsheet_markdown("**Merken:** ==Druckguss lohnt bei Großserie==.")
    assert "==Druckguss lohnt bei Großserie==" in out


def test_sanitize_strips_leaked_scaffold_heading():
    md = "## Work\n- $W = F d$\n### CURATED EXAM TRAPS\n- friction work is negative"
    out, _ = cs.sanitize_cheatsheet_markdown(md)
    assert "CURATED EXAM TRAPS" not in out
    assert "## Method Picker" not in out  # sanity: not present here
    assert "$W = F d$" in out
    assert "friction work is negative" in out


def test_wrap_bare_formula_line():
    out, _ = cs.sanitize_cheatsheet_markdown("**Formulas:**\nv = \\frac{dx}{dt}\nx = x_0 + v_0 t")
    assert "$v = \\frac{dx}{dt}$" in out
    assert "$x = x_0 + v_0 t$" in out
    assert "**Formulas:**" in out  # label untouched


def test_wrap_bare_formula_leaves_prose_alone():
    out, _ = cs.sanitize_cheatsheet_markdown("- velocity changes when force acts\n- $a = 0$ holds")
    assert "$velocity" not in out  # prose not wrapped
    assert "velocity changes when force acts" in out


def test_wrap_inline_latex_fragment_in_prose():
    out, _ = cs.sanitize_cheatsheet_markdown(
        "v is not tangential unless \\dot r = 0 here"
    )
    assert "$\\dot r = 0$" in out
    assert "tangential" in out  # prose preserved


def test_wrap_skips_numbered_and_colon_lines():
    # numbered special-case line must NOT be wrapped whole as one formula
    out, _ = cs.sanitize_cheatsheet_markdown("2. a = a_0 = const: v(t) = v_0 + a_0 t")
    assert "$2. a" not in out
    # label: formula line is not wrapped whole either
    out2, _ = cs.sanitize_cheatsheet_markdown("Velocity: v changes with time")
    assert "$Velocity" not in out2


def test_wrap_bare_formula_skips_existing_math_and_labels():
    out, _ = cs.sanitize_cheatsheet_markdown("**Use when:** task asks for $v$\n## Heading = x")
    assert "$**Use when" not in out
    assert "## Heading" in out and "$## Heading" not in out


def test_sanitize_keeps_method_picker_heading():
    out, _ = cs.sanitize_cheatsheet_markdown("## Method Picker\n| a | b |\n|---|---|\n| x | y |")
    assert "## Method Picker" in out


def test_lone_dollar_line_removed_keeps_formulas_balanced():
    md = "**Formulas:**\n$\n$\\vec G = m\\vec g$\n$m\\ddot x = \\sum F_x$"
    out, _ = cs.sanitize_cheatsheet_markdown(md)
    assert out.count("$") % 2 == 0
    assert "$\\vec G = m\\vec g$" in out


def test_trailing_backslash_stripped_from_formula():
    out, _ = cs.sanitize_cheatsheet_markdown(r"$\Theta = \int r^2 \, dm \$")
    assert r"\, dm$" in out  # trailing backslash gone, thin space kept
    assert " \\$" not in out


def test_unsupported_latex_env_repaired():
    out, _ = cs.sanitize_cheatsheet_markdown(r"$\begin{align*} v &= x \end{align*}$")
    assert "align*" not in out
    assert "aligned" in out


def test_glued_accent_command_gets_a_space():
    # \vecg / \dotr are undefined in KaTeX; repair to \vec g / \dot r.
    assert cq.formula_to_latexish(r"\vecg") == r"\vec g"
    assert cq.formula_to_latexish(r"\dotr + 1") == r"\dot r + 1"
    # already-correct forms are untouched
    assert cq.formula_to_latexish(r"\vec g") == r"\vec g"
    assert cq.formula_to_latexish(r"\dot{r}") == r"\dot{r}"


def test_spaced_letter_ocr_formula_dropped():
    out, dropped = cs.sanitize_cheatsheet_markdown(r"angle $h e t a h e t a = 0$ here")
    assert dropped == 1
    assert "omitted" not in out.lower()
    assert "h e t a" not in out
    assert "angle" in out and "here" in out  # surrounding prose preserved


def test_strip_source_labels_removes_inline_citation():
    out, _ = cs.sanitize_cheatsheet_markdown(
        "- $F = ma$ (EngMec2 Lecture.pdf, p.25)\n- next"
    )
    assert "p.25" not in out
    assert ".pdf" not in out
    assert "$F = ma$" in out


def test_strip_source_labels_removes_sources_section_and_line():
    md = "## Work\n- $W = F d$\nSource: lecture 3\n## Sources\n- a.pdf, p.1\n- b.pdf, p.4"
    out, _ = cs.sanitize_cheatsheet_markdown(md)
    assert "## Sources" not in out
    assert "Source:" not in out
    assert "$W = F d$" in out


def test_strip_keeps_non_source_parenthetical():
    out, _ = cs.sanitize_cheatsheet_markdown("constant velocity (when $a = 0$) holds")
    assert "when" in out  # not a citation — left intact


def test_skeleton_drops_generic_nontopics():
    topic_map = [
        {"name": "Kinematik eines Punktes"},
        {"name": "Integrale"},
        {"name": "Initialbedingungen"},
        {"name": "Impuls und Stoß"},
    ]
    names = cs._topic_names(topic_map, None, limit=10)
    assert "Integrale" not in names
    assert "Initialbedingungen" not in names
    assert "Kinematik eines Punktes" in names
    assert "Impuls und Stoß" in names


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
    # dropped silently — no internal failure text in the sheet
    assert "not supported" not in out
    assert "omitted" not in out.lower()


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
        grounding={"total": 1, "grounded": 1, "ratio": 1.0},
        cfg=cs.normalize_settings({"detailLevel": "general"}),
        dropped_formulas=1,
        unsupported_formulas=2,
        filler_notes=3,
        evidence_quality=stats,
    )
    assert metrics["formulaCount"] == 1
    assert metrics["sourceSupport"] == 100
    assert "citationCoverage" not in metrics
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
    # A lone, ambiguous topic ("Friction") is NOT a mechanics course (needs >= 2
    # strong mechanics topics), so the aggressive English→German mechanics aliasing
    # is gated off and the real topic name is kept. (Aliasing for a genuine
    # mechanics map is covered by test_generate_cheatsheet_per_pdf_*.)
    assert out["topicsCovered"] == ["Friction"]
    assert "Friction" in out["text"]
    # No on-page citation metric (the target sheet shows none); grounding stays
    # internal via sourceSupport.
    assert "citationCoverage" not in out["quality"]["metrics"]
    # The inline `$F=\mu N$` formula is counted (display-only counting reported 0).
    assert out["quality"]["metrics"]["formulaCount"] == 1
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


def test_generate_cheatsheet_parallel_shards_stitch_and_dedup(monkeypatch):
    """Whole-course generation fans out into parallel shards, stitches the
    sections in skeleton order, and removes a formula repeated across shards."""
    import re as _re

    # Six topics → two shards of three (skeleton order is enforced by _topic_names).
    tm = [
        {"name": "Kinematics"}, {"name": "Cartesian"}, {"name": "Rectilinear"},
        {"name": "Projectile"}, {"name": "Polar"}, {"name": "Friction"},
    ]
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: tm)

    counter = 0

    def _fake_retrieve(**k):
        nonlocal counter
        counter += 1
        cid = f"c{counter}"
        return [{"chunkId": cid, "documentId": "d1", "pageStart": counter, "text": "evidence"}]

    monkeypatch.setattr(cs, "retrieve_learning_context", _fake_retrieve)

    calls: list[int] = []

    def _fake_chat(**k):
        calls.append(1)
        topics = _re.findall(r"### TOPIC: (.+)", k["user"])
        # Every section emits the SAME duplicate display formula plus a unique line.
        body = "\n".join(
            f"## {t}\n$$p=q$$\n- {{{{note}}}} for {t}" for t in topics
        )
        return _FakeChatResult({"text": body})

    monkeypatch.setattr(cs, "chat_json", _fake_chat)
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None,
        doc_names={"d1": "a.pdf"}, save=True,
    )

    # Fanned out into >1 parallel shard.
    assert len(calls) >= 2
    text = out["text"]
    # All six canonical sections present, in skeleton order.
    order = [
        "Kinematik eines Punktes", "Kartesische Koordinaten", "Geradlinige Bewegung",
        "Wurfbewegung", "Polarkoordinaten", "Reibung und Widerstand",
    ]
    positions = [text.find("## " + name) for name in order]
    assert all(p != -1 for p in positions)
    assert positions == sorted(positions)
    # The duplicate formula survived exactly once; the rest were deduped.
    assert text.count("$$p=q$$") == 1


# ── subject-type detection + reference template ──────────────────────────────


_FT_EVIDENCE = [
    {"text": (
        "Druckguss ist ein Gießverfahren für Großserien.\n"
        "Vorteile: kurze Zykluszeiten, gute Oberfläche.\n"
        "Nachteile: hohe Werkzeugkosten.\n"
        "Typische Fehler: Lunker, Poren, Kaltlauf."
    )},
    {"text": (
        "Sandguss ist flexibel und günstig, aber geringe Maßgenauigkeit.\n"
        "Fertigungsverfahren nach DIN 8580: Urformen, Umformen, Trennen, Fügen.\n"
        "Urformen schafft Stoffzusammenhalt; Umformen erhält ihn."
    )},
]

_MECH_EVIDENCE = [
    {"text": "v = \\frac{dx}{dt}\na = \\frac{dv}{dt}\nx = x_0 + v_0 t + \\frac{1}{2} a t^2"},
    {"text": "F = m a\nE_{kin} = \\frac{1}{2} m v^2\n\\sum F = m \\ddot x\nv^2 = v_0^2 + 2 a x"},
]


def test_classify_formula_heavy_from_formula_corpus():
    assert cs.classify_subject_type(_MECH_EVIDENCE) == "formula_heavy"


def test_classify_vocabulary_from_manufacturing_corpus():
    st = cs.classify_subject_type(_FT_EVIDENCE)
    assert st in ("vocabulary_memorization", "process_comparison")
    assert st not in cs._FORMULA_DRIVEN_TYPES


def test_classify_uses_mechanics_topic_prior():
    # Even thin/odd evidence is formula-driven when the topic map is mechanics.
    topics = ["Kinematik eines Punktes", "Impuls und Stoß"]
    assert cs.classify_subject_type([{"text": "x"}], topics) == "formula_heavy"


def test_classify_empty_defaults_formula_heavy():
    assert cs.classify_subject_type([]) == "formula_heavy"


def test_reference_shard_prompt_uses_reference_template():
    cfg = cs.normalize_settings({"preset": "balanced", "subjectType": "vocabulary_memorization"})
    assert cfg["formulaDriven"] is False
    prompt = cs._shard_system_prompt(cfg, ["Druckguss"], with_method_picker=False)
    assert "MEMORIZATION / REFERENCE" in prompt
    assert "Prüfungsfalle" in prompt
    assert "REFERENCE BALANCED FORMAT" in prompt
    # must NOT carry the formula-first contract
    assert "BALANCED STUDY FORMAT" not in prompt


def test_formula_shard_prompt_unchanged_for_formula_subjects():
    cfg = cs.normalize_settings({"preset": "balanced"})  # auto → formula-driven
    assert cfg["formulaDriven"] is True
    prompt = cs._shard_system_prompt(cfg, ["Polarkoordinaten"], with_method_picker=False)
    assert "BALANCED STUDY FORMAT" in prompt
    assert "MEMORIZATION / REFERENCE" not in prompt


def test_reference_gate_does_not_require_formulas():
    cfg = cs.normalize_settings({"subjectType": "vocabulary_memorization"})
    text = (
        "## Druckguss\n**Kurzdefinition:** Gießen unter Druck.\n"
        "**Vorteile:**\n- schnell\n**Prüfungsfalle:** nicht für Kleinserien."
    )
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert "no-formulas" not in fails
    assert fails == []


def test_reference_gate_flags_formula_cluster_and_na_leak():
    cfg = cs.normalize_settings({"subjectType": "vocabulary_memorization"})
    text = "## Druckguss\n**Formula cluster:**\nN/A\n**Definition:** x"
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert "formula-cluster-leak" in fails
    assert "na-leak" in fails


def test_reference_gate_flags_missing_structure():
    cfg = cs.normalize_settings({"subjectType": "vocabulary_memorization"})
    text = "## Druckguss\nGießverfahren unter hohem Druck fuer Grossserien."
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert "no-structure" in fails


def test_strip_reference_template_leaks():
    md = (
        "## Druckguss\n**Kurzdefinition:** x\n- **Formula cluster:** $$F=ma$$\n"
        "**Vorteile:** N/A\n**Merken:** Großserie."
    )
    out = cs.strip_reference_template_leaks(md)
    assert "Formula cluster" not in out
    assert "N/A" not in out
    assert "**Merken:** Großserie." in out
    assert "**Kurzdefinition:** x" in out


def test_corrective_guidance_reference_failures():
    g = cs._corrective_guidance(["formula-cluster-leak", "no-structure", "raw-markdown"])
    assert "Formula cluster" in g
    assert "comparison table" in g
    assert "literal" in g


def test_generate_cheatsheet_routes_reference_subject(monkeypatch):
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: [{"name": "Druckguss"}, {"name": "Sandguss"}])
    monkeypatch.setattr(cs, "retrieve_learning_context", lambda **k: _FT_EVIDENCE)

    captured = {}

    def _fake_chat(**k):
        captured["system"] = k["system"]
        return _FakeChatResult({"text": (
            "## Druckguss\n**Kurzdefinition:** Gießen unter Druck.\n"
            "**Vorteile:**\n- schnell\n**Prüfungsfalle:** nicht für Kleinserien."
        )})

    monkeypatch.setattr(cs, "chat_json", _fake_chat)
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None,
        doc_names={}, save=True,
    )
    assert out["subjectType"] not in cs._FORMULA_DRIVEN_TYPES
    # The reference (non-formula) writer was used, not the mechanics formula one.
    assert "MEMORIZATION / REFERENCE" in captured["system"]
    assert "Prüfungsfalle" in out["text"]


# ── engineering-design routing + mechanics gate ─────────────────────────────


_GDK_EVIDENCE = [
    {"text": (
        "Konstruktionsmethodik nach VDI 2221: Anforderungsliste, Funktionsstruktur, "
        "morphologischer Kasten, Bewertung der Konzepte.\n"
        "Konstruktionsphasen: Planen, Konzipieren, Entwerfen, Ausarbeiten."
    )},
    {"text": (
        "Toleranzen und Passungen nach DIN EN ISO 286: Spielpassung, Übergangspassung, "
        "Presspassung. Das Grundabmaß bestimmt die Lage des Toleranzfeldes.\n"
        "Welle-Nabe-Verbindung: Passfeder, Keilwelle, Pressverband übertragen das Drehmoment."
    )},
    {"text": (
        "Lager: Wälzlager gegen Gleitlager. Schmierung und Tribologie bestimmen "
        "Verschleiß. Getriebe und Verzahnung setzen die Drehzahl um."
    )},
]


def test_classify_engineering_design_from_design_corpus():
    # GdK/Maschinenelemente: design vocabulary dominates, so it routes to the
    # engineering-design template even though some strength formulas exist.
    assert cs.classify_subject_type(_GDK_EVIDENCE) == "engineering_design"
    assert "engineering_design" not in cs._FORMULA_DRIVEN_TYPES


def test_course_is_mechanics_gate():
    assert cs._course_is_mechanics(["Kinematik eines Punktes", "Impuls und Stoß"]) is True
    # ambiguous design topics are NOT a mechanics course
    assert cs._course_is_mechanics(["Normalspannung", "Reibung in Lagern", "Toleranzen"]) is False
    # a single strong mechanics topic is not enough
    assert cs._course_is_mechanics(["Drehimpuls", "Toleranzen"]) is False


def test_dedupe_topic_names_skips_mechanics_alias_when_not_mechanics():
    names = ["Normalspannung", "Reibung in Lagern"]
    # mechanics ON → aggressive aliasing rewrites into mechanics sections
    aliased = cs._dedupe_topic_names(names, mechanics=True)
    assert "Tangential- und Normalkoordinaten" in aliased
    # mechanics OFF → the course keeps its real design topic names
    assert cs._dedupe_topic_names(names, mechanics=False) == ["Normalspannung", "Reibung in Lagern"]


def test_design_shard_prompt_uses_design_template():
    cfg = cs.normalize_settings({"preset": "balanced", "subjectType": "engineering_design"})
    assert cfg["formulaDriven"] is False
    prompt = cs._shard_system_prompt(cfg, ["Welle-Nabe-Verbindung"], with_method_picker=False)
    assert "ENGINEERING-DESIGN / MACHINE-ELEMENTS" in prompt
    assert "Auswahlkriterien" in prompt
    # balanced has no design-specific override → falls back to the reference format
    assert "REFERENCE BALANCED FORMAT" in prompt
    # never the mechanics formula contract
    assert "BALANCED STUDY FORMAT" not in prompt


def test_generate_cheatsheet_routes_engineering_design(monkeypatch):
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: [
        {"name": "Toleranzen und Passungen"},
        {"name": "Welle-Nabe-Verbindung"},
        {"name": "Normalspannung"},
        {"name": "Lager und Schmierung"},
    ])
    monkeypatch.setattr(cs, "retrieve_learning_context", lambda **k: _GDK_EVIDENCE)
    captured = {}

    def _fake_chat(**k):
        captured["system"] = k["system"]
        return _FakeChatResult({"text": (
            "## Toleranzen und Passungen\n**Kurzdefinition:** Passung beschreibt Spiel/Übermaß.\n"
            "**Varianten / Arten:**\n| Art | Merkmal |\n|---|---|\n| Spielpassung | immer Spiel |\n"
            "**Prüfungsfalle:** Presspassung erschwert die Montage."
        )})

    monkeypatch.setattr(cs, "chat_json", _fake_chat)
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None, doc_names={}, save=True,
    )
    assert out["subjectType"] == "engineering_design"
    assert out["settings"]["formulaDriven"] is False
    assert out["settings"]["mechanics"] is False
    # the design writer was used, not the mechanics formula one
    assert "ENGINEERING-DESIGN / MACHINE-ELEMENTS" in captured["system"]
    # GdK topics keep their REAL names — never rewritten into mechanics sections
    assert "Normalspannung" in out["topicsCovered"]
    assert "Tangential- und Normalkoordinaten" not in out["topicsCovered"]
    assert "Reibung und Widerstand" not in out["topicsCovered"]


# ── raw-LaTeX / table-leak sanitation ───────────────────────────────────────


def test_sanitize_strips_latex_table_leak():
    # The exact shape that leaked red onto the GdK sheet: a cases/array row body
    # with `&` separators and `\\` row breaks left outside any math wrapper.
    src = (
        r"1.0 & \text{Vollwelle (solid shaft)} \\ 1.0 & \text{Hohlwelle (hollow shaft)} "
        r"\text{2.0 bis 3.0} & \text{Torsion} > 3.0 & \text{Beliebig}"
    )
    out, _ = cs.sanitize_cheatsheet_markdown(src)
    assert "&" not in out          # column separators neutralized
    assert "\\\\" not in out       # row breaks neutralized
    assert "Vollwelle" in out      # the actual content is preserved
    # no raw LaTeX env scaffolding survives outside a math span
    assert not cs._broken_formula_reasons(out)


def test_sanitize_drops_lone_unknown_command():
    out, dropped = cs.sanitize_cheatsheet_markdown("Variablen: \\nd: Durchmesser, D: Nennmaß")
    assert "\\nd" not in out
    assert "Durchmesser" in out


def test_broken_formula_reasons_flags_table_leak():
    reasons = cs._broken_formula_reasons(r"1.0 & \text{Vollwelle} \\ 2.0 & \text{Torsion}")
    assert "latex-table-leak" in reasons


def test_reference_gate_flags_raw_latex():
    cfg = cs.normalize_settings({"subjectType": "engineering_design"})
    text = (
        "## Festigkeitsnachweis\n**Kurzdefinition:** Nachweis der Tragfähigkeit.\n"
        r"1.0 & \text{Vollwelle} \\ 2.0 & \text{Hohlwelle}"
    )
    fails = cs._shard_gate_failures(text, cfg, expect_method_picker=False)
    assert "raw-latex" in fails


def test_corrective_guidance_raw_latex():
    g = cs._corrective_guidance(["raw-latex"])
    assert "markdown" in g
    assert "\\begin{cases}" in g or "cases" in g


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
    # Focus topic "Energy" with a non-mechanics map ("Other") is not a mechanics
    # course, so the focus topic keeps its given name rather than being aliased to
    # the German mechanics canonical "Arbeit, Energie und Leistung".
    assert out["topicsCovered"] == ["Energy"]


# ── Stage 5: document-level quality hardening ────────────────────────────────


def test_assess_quality_good_sheet_passes_clean():
    """A formula sheet whose sections all carry grounded, well-formed formulas and
    cover the requested topics passes with no flags."""
    text = (
        "## Kinematik eines Punktes\n"
        "Lead idea.\n$$v = \\frac{dx}{dt}$$\n$$a = \\frac{dv}{dt}$$\n"
        "## Geradlinige Bewegung\n"
        "Lead idea.\n$$x = x_0 + v_0 t$$\n$$v^2 = v_0^2 + 2 a x$$\n"
    )
    a = cs.assess_cheatsheet_quality(
        text=text, raw_text=text,
        topics=["Kinematik eines Punktes", "Geradlinige Bewegung"],
        grounding={"total": 4, "grounded": 4, "ratio": 1.0},
        cfg=cs.normalize_settings({}), dropped_formulas=0,
    )
    assert a["passed"] is True
    assert a["flags"] == []
    assert a["score"] == 100
    assert a["checks"]["topicCoverage"] == 1.0


def test_assess_quality_missing_topics_and_low_grounding_flag_and_fail():
    """A sheet that lost most requested topics and whose formulas don't trace to
    the source is flagged and fails the threshold."""
    text = "## Kinematik eines Punktes\n$$v = x$$\n"
    a = cs.assess_cheatsheet_quality(
        text=text, raw_text=text,
        topics=[
            "Kinematik eines Punktes", "Geradlinige Bewegung",
            "Polarkoordinaten", "Impuls und Stoß",
        ],
        grounding={"total": 5, "grounded": 1, "ratio": 0.2},
        cfg=cs.normalize_settings({}), dropped_formulas=0,
    )
    assert a["passed"] is False
    assert "low-topic-coverage" in a["flags"]
    assert "low-source-support" in a["flags"]
    assert a["score"] < a["threshold"]


def test_assess_quality_formula_subject_without_formulas_fails():
    text = "## Kinematik\nJust prose, no math here.\n## Dynamik\nMore prose only.\n"
    a = cs.assess_cheatsheet_quality(
        text=text, raw_text=text, topics=["Kinematik", "Dynamik"],
        grounding={"total": 0, "grounded": 0, "ratio": None},
        cfg=cs.normalize_settings({}), dropped_formulas=0,
    )
    assert "no-formulas" in a["flags"]
    assert a["passed"] is False


def test_assess_quality_reference_subject_uses_definition_not_formula():
    """Reference (non-formula) subjects must NOT be failed for lacking formulas —
    they pass on structured definitions/labels instead."""
    text = (
        "## Druckguss\n- **Kurzdefinition:** Gießverfahren für Großserien.\n"
        "- **Vorteile:** kurze Zykluszeiten.\n"
        "## Sandguss\n- **Kurzdefinition:** flexibel und günstig.\n"
        "- **Nachteile:** geringe Maßgenauigkeit.\n"
        "## Urformen\n- **Einordnung:** schafft Stoffzusammenhalt.\n"
    )
    cfg = cs.normalize_settings({"subjectType": "vocabulary_memorization"})
    assert cfg["formulaDriven"] is False
    a = cs.assess_cheatsheet_quality(
        text=text, raw_text=text, topics=["Druckguss", "Sandguss", "Urformen"],
        grounding={"total": 0, "grounded": 0, "ratio": None},
        cfg=cfg, dropped_formulas=0,
    )
    assert "no-formulas" not in a["flags"]
    assert "low-definition-coverage" not in a["flags"]
    assert a["passed"] is True


# Formula-dense, NON-mechanics evidence → classifies as ``formula_heavy`` but
# ``mechanics`` is False, so the mechanics formula-bank enforcement does NOT run
# and a prose-only draft genuinely reaches the document quality gate (the bank
# would otherwise inject canonical formulas and mask the deficiency).
_EE_EVIDENCE = [
    {"text": (
        "I = \\int x\\, dx\nV = R \\cdot I\nP = U I\nZ = R + j X\n"
        "f = 1/T\n\\sum I = 0\nU = L \\frac{di}{dt}"
    )},
]
_EE_TM = [
    {"name": "Ohmsches Gesetz"}, {"name": "Wechselstrom"},
    {"name": "Leistung"}, {"name": "Filter"},
]


def test_generate_cheatsheet_repairs_once_and_is_capped(monkeypatch):
    """A first draft below the quality bar triggers EXACTLY one whole-document
    repair pass; the better second draft is kept and the assessment passes."""
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: _EE_TM)
    monkeypatch.setattr(cs, "retrieve_learning_context", lambda **k: _EE_EVIDENCE)

    def _fake_chat(**k):
        import re as _re
        topics = _re.findall(r"### TOPIC: (.+)", k["user"])
        if "QUALITY REPAIR" in k["system"]:
            # Repaired draft: every section carries a DISTINCT grounded formula.
            body = "\n".join(
                f"## {t}\n$$V_{{{i}}} = R \\cdot I$$" for i, t in enumerate(topics)
            )
        else:
            body = "\n".join(f"## {t}\nplain prose only here" for t in topics)
        return _FakeChatResult({"text": body})

    monkeypatch.setattr(cs, "chat_json", _fake_chat)
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None,
        doc_names={"d1": "a.pdf"}, save=True,
    )

    q = out["quality"]
    assert q["repairAttempted"] is True
    # The kept (repaired) draft has formulas and passes — and no warning is set.
    assert q["assessment"]["passed"] is True
    assert "= R \\cdot I$$" in out["text"]
    assert out.get("warning") is None


def test_generate_cheatsheet_warns_when_still_below_bar(monkeypatch):
    """If even the single repair pass cannot lift the sheet above the bar, the
    weak sheet is surfaced with a `warning` rather than shipped silently."""
    monkeypatch.setattr(cs, "get_course_topic_map", lambda u, c: _EE_TM)
    monkeypatch.setattr(cs, "retrieve_learning_context", lambda **k: _EE_EVIDENCE)

    def _fake_chat(**k):
        import re as _re
        topics = _re.findall(r"### TOPIC: (.+)", k["user"])
        # Always prose-only, both draft and repair → never reaches the bar.
        body = "\n".join(f"## {t}\nplain prose only" for t in topics)
        return _FakeChatResult({"text": body})

    monkeypatch.setattr(cs, "chat_json", _fake_chat)
    monkeypatch.setattr(cs, "save_note", lambda **k: "n1")

    # Spy on the section generator: it must run twice total — the initial draft
    # plus EXACTLY ONE whole-document repair pass (the Stage-5 cap), never more.
    real_parallel = cs._generate_sections_parallel
    passes = {"n": 0}

    def _spy(**k):
        passes["n"] += 1
        return real_parallel(**k)

    monkeypatch.setattr(cs, "_generate_sections_parallel", _spy)

    out = cs.generate_cheatsheet(
        user_id="u", course_id="c", document_ids=None, topic=None,
        doc_names={"d1": "a.pdf"}, save=True,
    )
    assert out["quality"]["repairAttempted"] is True
    assert out["quality"]["assessment"]["passed"] is False
    assert passes["n"] == 2  # initial draft + exactly one repair pass (capped)
    assert out.get("warning")
    assert "quality bar" in out["warning"]
