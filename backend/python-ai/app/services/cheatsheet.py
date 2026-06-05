"""Cheatsheet generation — Learning Agent Phase 4.

A cheatsheet is NOT a long study guide (that's notes.py). It is a dense,
exam-ready reference: the highest-value formulas, definitions and rules a
student wants on one page during revision. Two things make it a Learning
Agent feature rather than a second notes generator:

  * **Topic-Map driven.** Coverage and ordering come from the course Topic Map
    (``learning_agent.get_course_topic_map``) — high-importance topics first,
    so the densest page is spent on what matters most. An explicit ``topic``
    focuses the sheet on one area instead.
  * **Grounded retrieval.** Evidence is pooled per topic through
    ``retrieve_learning_context(purpose="cheatsheet")`` (broad fan-out), so
    every line traces back to the user's own chunks. No outside knowledge.

Output is markdown, stored via ``notes.save_note(note_type="cheatsheet")`` so
it reuses the notes table, RLS, CRUD endpoint and notes list — a cheatsheet is
just another generated document.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .learning_agent import get_course_topic_map, retrieve_learning_context
from .llm_json import LlmResult, chat_json
from .notes import save_note
from .cheatsheet_quality import (
    EvidenceNormalizationStats,
    formula_corruption_reasons,
    formula_to_latexish,
    normalize_evidence_chunks,
    normalize_formula_text,
    repair_mojibake,
)
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# COMPREHENSIVE coverage via PARALLEL section generation (mirrors quiz.py).
#
# A single bounded LLM call can't be both comprehensive AND fast: at ~40 tok/s a
# whole-course Hyperknow-style sheet (~22 sections, ~100 formulas) would run far
# past the edge proxy's upstream timeout and truncate its single JSON string. So
# instead of ONE big call we fan out many SMALL ones: the ordered topic skeleton
# is split into shards of a few topics each, every shard is generated
# concurrently, and the section markdown is stitched back in skeleton order.
# Wall-clock is the slowest shard (~one bounded call), not the sum — exactly the
# trick quiz.py uses for 20 questions. That lets the model cover the WHOLE course
# densely while each shard still finishes well inside the timeout. Cross-shard
# duplicate formulas (shards can't see each other) are removed deterministically
# afterwards by dedup_display_formulas, so parallelism costs no visible repeats.
_MAX_TOPICS = 24            # whole-course skeleton depth (Hyperknow ≈ 22 sections)
_PER_TOPIC_TOP_K = 6        # retrieval supplies ~6 formula chunks/topic
_MAX_EVIDENCE = 60          # generous pool; evidence is grouped per topic/shard
# Each shard covers a few topics and asks for EVERY supported formula, so its
# output is short enough to finish fast (~1500 tok ≈ 38s at ~40 tok/s) and rarely
# truncates; a shard that does truncate is salvaged (salvage_key) into a slightly
# shorter but still-renderable set of sections rather than a JSON parse failure.
_TOPICS_PER_SHARD = 3
_PER_SHARD_MAX_TOKENS = 1500
_MAX_SHARDS = 10            # safety cap on concurrent OpenAI calls per sheet

# Per-PDF mode: when the user picks a small set of PDFs we produce one section
# per PDF and dedup across them. Above this count it's effectively "whole course"
# and per-PDF sectioning can't fit the output budget, so we fall back to the
# topic-map sheet. (1 doc needs no sectioning — it's already a single-PDF sheet.)
_MAX_PER_PDF_DOCS = 5

_MECHANICS_TOPIC_ORDER = (
    "Kinematik eines Punktes",
    "Kartesische Koordinaten",
    "Geradlinige Bewegung",
    "Wurfbewegung",
    "Polarkoordinaten",
    "Tangential- und Normalkoordinaten",
    "Dynamik von Punktmassen",
    "Bewegungsgleichungen",
    "Reibung und Widerstand",
    "Arbeit, Energie und Leistung",
    "Impuls und Sto\u00df",
    "Dynamik von Punktsystemen",
    "Schwerpunkt / Massenmittelpunkt",
    "Rotation starrer K\u00f6rper",
    "Tr\u00e4gheitsmoment",
    "Drehimpuls",
    "Ebene Bewegung starrer K\u00f6rper",
    "Rollbewegung",
    "Variable Masse / Raketenbewegung",
    "Pendel",
)

_MECHANICS_TOPIC_ALIASES: tuple[tuple[str, str], ...] = (
    ("systems of point masses", "Dynamik von Punktsystemen"),
    ("dynamics of systems of point masses", "Dynamik von Punktsystemen"),
    ("korpersystem", "Dynamik von Punktsystemen"),
    ("koerpersystem", "Dynamik von Punktsystemen"),
    ("punktsystem", "Dynamik von Punktsystemen"),
    ("massensystem", "Dynamik von Punktsystemen"),
    ("schwerpunkt", "Schwerpunkt / Massenmittelpunkt"),
    ("massenmittelpunkt", "Schwerpunkt / Massenmittelpunkt"),
    ("center of mass", "Schwerpunkt / Massenmittelpunkt"),
    ("centre of mass", "Schwerpunkt / Massenmittelpunkt"),
    ("kinematik", "Kinematik eines Punktes"),
    ("kinematics", "Kinematik eines Punktes"),
    ("kartesisch", "Kartesische Koordinaten"),
    ("cartesian", "Kartesische Koordinaten"),
    ("geradlinig", "Geradlinige Bewegung"),
    ("rectilinear", "Geradlinige Bewegung"),
    ("wurf", "Wurfbewegung"),
    ("projectile", "Wurfbewegung"),
    ("polar", "Polarkoordinaten"),
    ("tangential", "Tangential- und Normalkoordinaten"),
    ("normal", "Tangential- und Normalkoordinaten"),
    ("punktmasse", "Dynamik von Punktmassen"),
    ("point mass", "Dynamik von Punktmassen"),
    ("bewegungsgleich", "Bewegungsgleichungen"),
    ("equations of motion", "Bewegungsgleichungen"),
    ("reibung", "Reibung und Widerstand"),
    ("friction", "Reibung und Widerstand"),
    ("widerstand", "Reibung und Widerstand"),
    ("drag", "Reibung und Widerstand"),
    ("arbeit", "Arbeit, Energie und Leistung"),
    ("energie", "Arbeit, Energie und Leistung"),
    ("leistung", "Arbeit, Energie und Leistung"),
    ("work", "Arbeit, Energie und Leistung"),
    ("energy", "Arbeit, Energie und Leistung"),
    ("power", "Arbeit, Energie und Leistung"),
    ("impuls", "Impuls und Sto\u00df"),
    ("stoss", "Impuls und Sto\u00df"),
    ("sto\u00df", "Impuls und Sto\u00df"),
    ("momentum", "Impuls und Sto\u00df"),
    ("impact", "Impuls und Sto\u00df"),
    ("rotation", "Rotation starrer K\u00f6rper"),
    ("starrer korper", "Rotation starrer K\u00f6rper"),
    ("rigid bod", "Rotation starrer K\u00f6rper"),
    ("tragheitsmoment", "Tr\u00e4gheitsmoment"),
    ("traegheitsmoment", "Tr\u00e4gheitsmoment"),
    ("moment of inertia", "Tr\u00e4gheitsmoment"),
    ("drehimpuls", "Drehimpuls"),
    ("angular momentum", "Drehimpuls"),
    ("ebene bewegung", "Ebene Bewegung starrer K\u00f6rper"),
    ("plane motion", "Ebene Bewegung starrer K\u00f6rper"),
    ("rollen", "Rollbewegung"),
    ("rollbewegung", "Rollbewegung"),
    ("rolling", "Rollbewegung"),
    ("variable masse", "Variable Masse / Raketenbewegung"),
    ("rakete", "Variable Masse / Raketenbewegung"),
    ("rocket", "Variable Masse / Raketenbewegung"),
    ("pendel", "Pendel"),
    ("pendulum", "Pendel"),
)

_MECHANICS_TRAP_BANK: dict[str, tuple[str, ...]] = {
    "Kinematik eines Punktes": (
        "Constant-a formulas are only valid if a = const.",
        "For a(t), integrate first and then apply initial conditions.",
    ),
    "Geradlinige Bewegung": (
        "Constant-a formulas are only valid if a = const.",
        "Initial conditions fix the integration constants; do not skip them.",
    ),
    "Polarkoordinaten": (
        "v is generally not tangential to the trajectory unless r_dot = 0.",
        "The term 2 r_dot phi_dot appears because the basis vectors change with time.",
    ),
    "Tangential- und Normalkoordinaten": (
        "a_t changes speed; a_n changes direction.",
        "Use the tangential equation for speed changes and the normal equation for direction changes.",
    ),
    "Reibung und Widerstand": (
        "Static friction is not automatically mu_0 N; only |H| <= mu_0 N.",
        "Friction direction opposes relative motion or tendency of motion.",
    ),
    "Arbeit, Energie und Leistung": (
        "Constraint forces do no work if perpendicular to displacement.",
        "Friction and drag are dissipative and have no potential energy.",
        "Friction work is negative.",
    ),
    "Dynamik von Punktsystemen": (
        "Internal forces cancel in system momentum balances.",
        "Only external forces determine center-of-mass acceleration.",
    ),
    "Schwerpunkt / Massenmittelpunkt": (
        "Use external forces for a_S; internal forces cancel in the system balance.",
    ),
    "Rollbewegung": (
        "Rolling constraint x_dot_S = r omega is valid only without slipping.",
        "If sliding occurs, the rolling constraint is invalid.",
    ),
}

_MECHANICS_FORMULA_BANK: dict[str, tuple[str, ...]] = {
    "Kinematik eines Punktes": (
        r"v = \frac{dx}{dt}",
        r"a = \frac{dv}{dt}",
        r"v(t) = v_0 + \int a(t)\,dt",
    ),
    "Geradlinige Bewegung": (
        r"x = x_0 + v_0 t + \frac{1}{2} a t^2",
        r"v^2 = v_0^2 + 2 a (x - x_0)",
    ),
    "Wurfbewegung": (
        r"x = v_0\cos\alpha\,t",
        r"z = z_0 + v_0\sin\alpha\,t - \frac{1}{2}gt^2",
        r"h_{max} = \frac{v_0^2\sin^2\alpha}{2g}",
    ),
    "Polarkoordinaten": (
        r"\vec v = \dot r\,\vec e_r + r\dot\varphi\,\vec e_\varphi",
        r"\vec a = (\ddot r-r\dot\varphi^2)\vec e_r + (r\ddot\varphi+2\dot r\dot\varphi)\vec e_\varphi",
    ),
    "Tangential- und Normalkoordinaten": (
        r"a_t = \dot v",
        r"a_n = \frac{v^2}{\rho}",
    ),
    "Dynamik von Punktmassen": (
        r"\sum \vec F = m\vec a",
        r"\vec G = m\vec g",
    ),
    "Reibung und Widerstand": (
        r"|H| \le \mu_0 N",
        r"R = \mu N",
    ),
    "Arbeit, Energie und Leistung": (
        r"dW = \vec F \cdot d\vec r",
        r"E_{kin} = \frac{1}{2}mv^2",
        r"E_{kin,1} - E_{kin,0} = W",
        r"E_p = mgz",
        r"E_p = \frac{1}{2}cx^2",
        r"P = \vec F \cdot \vec v",
    ),
    "Impuls und Stoß": (
        r"\vec p = m\vec v",
        r"\int \vec F\,dt = \Delta \vec p",
    ),
    "Dynamik von Punktsystemen": (
        r"m\vec a_S = \sum \vec F^{ext}",
        r"\vec p = m\vec v_S",
    ),
    "Schwerpunkt / Massenmittelpunkt": (
        r"\vec r_S = \frac{1}{M}\sum m_i \vec r_i",
        r"M\vec a_S = \sum \vec F^{ext}",
    ),
    "Trägheitsmoment": (
        r"\Theta = \int r^2\,dm",
        r"\Theta_A = \Theta_S + m d^2",
    ),
    "Drehimpuls": (
        r"\vec L_A = \Theta_A \vec\omega",
        r"\sum \vec M_A = \frac{d\vec L_A}{dt}",
    ),
    "Rollbewegung": (
        r"v_S = r\omega",
        r"a_S = r\alpha",
    ),
    "Variable Masse / Raketenbewegung": (
        r"m\dot v = F_{ext} + u(-\dot m)",
    ),
}

_MECHANICS_LAYOUT_COLUMNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("column1", (
        "Kinematik eines Punktes", "Kartesische Koordinaten", "Geradlinige Bewegung",
        "Wurfbewegung", "Polarkoordinaten", "Tangential- und Normalkoordinaten",
    )),
    ("column2", (
        "Dynamik von Punktmassen", "Bewegungsgleichungen", "Reibung und Widerstand",
        "Arbeit, Energie und Leistung", "Impuls und Stoß",
    )),
    ("column3", (
        "Dynamik von Punktsystemen", "Schwerpunkt / Massenmittelpunkt",
        "Rotation starrer Körper", "Trägheitsmoment", "Drehimpuls", "Rollbewegung",
    )),
)

_CHEATSHEET_ITEM_TYPES = (
    "definition", "formula", "derived_formula", "special_case", "procedure",
    "trap", "variable_definition", "example_specific", "diagram_logic", "source_note",
)

_GENERIC_FILLER_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:"
    r"(?:be\s+)?careful\s+with\s+directions?|"
    r"direction\s+(?:matters|of\s+forces\s+affects\s+acceleration)|"
    r"consider\s+all\s+forces|"
    r"pay\s+attention\s+to\s+signs?|"
    r"check\s+(?:your\s+)?units?|"
    r"achte\s+auf\s+(?:richtungen|vorzeichen|einheiten)|"
    r"richtung(?:en)?\s+(?:beachten|ist\s+wichtig)"
    r")\.?\s*$",
    re.I,
)

_SYSTEM = (
    "You are ExamForge by Minallo, writing a DENSE, exam-ready CHEATSHEET from a "
    "student's own course materials — a compressed, multi-column academic "
    "reference sheet (Hyperknow style), NOT a study guide or an AI summary.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Do not use outside knowledge.\n"
    "\n"
    "STRUCTURE — organise by the topics given, in order (most important first), "
    "one `##` section per topic. Each section is a tight block:\n"
    "- Lead with a ONE-LINE definition / core idea.\n"
    "- Then the key FORMULAS (KaTeX: $...$ inline, $$...$$ display; name each "
    "symbol once; state assumptions/conditions).\n"
    "- Then SPECIAL CASES as a numbered list (e.g. `1. Uniform motion (a=0)`), "
    "each with its formula and the condition it needs.\n"
    "- Then terse notes / pitfalls. Bullets with a bold lead-in: "
    "`- **Term:** meaning`. One line each. No prose paragraphs, no intros.\n"
    "\n"
    "PRECISION (be slightly MORE precise than a generic cheatsheet):\n"
    "- Only formulas SUPPORTED BY THE CONTEXT. Never invent or guess a formula.\n"
    "- Distinguish general formulas from special cases; keep notation consistent; "
    "define a symbol the first time it is ambiguous; include key edge conditions.\n"
    "- If the context has nothing for a planned topic, OMIT it — never pad.\n"
    "- The COURSE CONTEXT is a broad pool: mine it for EVERY distinct, "
    "high-value formula/rule it actually supports — coverage of real formulas "
    "is the goal. Keep each one tight (one line); drop duplicates and trivia "
    "rather than spending space on prose.\n"
    "- Match the language of the source material.\n"
    "\n"
    "DENSITY — this is a compact REFERENCE sheet, not a summary. Cover the "
    "HIGHEST-VALUE formulas the evidence supports, each as a display formula "
    "($$...$$). Be RUTHLESSLY TERSE: at most a few words of context per formula, "
    "no prose paragraphs, no filler. Prefer fewer well-chosen formulas over a "
    "long sheet. Drop duplicates and anything not grounded; never invent.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact/result of a block in ==double "
    "equals== (renders as a yellow highlight). At most one per block.\n"
    "- Begin a hard warning with `Important:` or `Critical:` (renders red).\n"
    "- Begin a soft remark with `Note:` (renders orange).\n"
    "- Wrap a key concept term in {{double braces}} (renders blue). Use "
    "sparingly — only genuinely central terms.\n"
    "\n"
    "SOURCES — do NOT print any citations or a `## Sources` list. The target "
    "reference shows none; grounding is an internal guard, not on-page text.\n"
    "\n"
    'Return ONLY JSON: {"text":"<markdown cheatsheet>"}'
)


# Per-shard prompt for PARALLEL section generation. Each shard writes only the
# `##` sections for the few topics it is given (no document title / intro /
# Sources list — those would otherwise be duplicated across shards). The defining
# instruction is COMPREHENSIVE coverage: every supported item, no cap.
_SECTION_SYSTEM = (
    "You are ExamForge by Minallo, writing PART of a DENSE, exam-ready CHEATSHEET "
    "from a student's own course materials — a compressed, multi-column academic "
    "reference sheet (Hyperknow style), NOT a study guide or an AI summary.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Never invent or guess a formula.\n"
    "\n"
    "OUTPUT: for each `### TOPIC: <name>` block in the context, write EXACTLY one "
    "`## <name>` section, in the same order. Output ONLY these sections — no "
    "document title, no introduction, no `## Sources` list, no closing remarks.\n"
    "\n"
    "EACH section is a tight, scannable block:\n"
    "- Lead with a ONE-LINE definition / core idea.\n"
    "- Bold-lead-in labelled points for the essentials: `- **Term:** meaning` "
    "(one line each) — directions, dimensions, conditions, critical differences.\n"
    "- The KEY FORMULAS (KaTeX: $...$ inline, $$...$$ display; name each symbol "
    "once; state the assumptions/conditions each needs).\n"
    "- SPECIAL CASES as a numbered list (e.g. `1. Uniform motion (a=0)`), each "
    "with its formula and the condition it requires.\n"
    "- Then terse traps / pitfalls. No prose paragraphs, no intros.\n"
    "\n"
    "COMPREHENSIVE COVERAGE — THE MOST IMPORTANT RULE: mine the COURSE CONTEXT for "
    "EVERY distinct, high-value item it actually supports — every formula, derived "
    "formula, definition, rule, special case, condition, and exam trap. Do NOT cap "
    "the number; completeness is the goal (this is a reference, not a summary). Keep "
    "each item to ONE tight line; drop only exact duplicates and generic filler. "
    "Never pad and never invent — if the context does not support something, leave "
    "it out. Match the language of the source material.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact/result of a block in ==double equals== "
    "(yellow highlight). At most one per block.\n"
    "- Begin a hard warning with `Important:` or `Critical:` (red).\n"
    "- Begin a soft remark with `Note:` (orange).\n"
    "- Wrap a key concept term in {{double braces}} (blue); use sparingly.\n"
    "\n"
    'Return ONLY JSON: {"text":"<markdown for these sections only>"}'
)


# ── Settings (Stage 3) ───────────────────────────────────────────────────────
#
# Four presets cover ~90% of the value; only two free overrides (pages, language)
# are exposed — deliberately NOT an 8-dimension à-la-carte matrix, which would be
# untestable and need a conflict-warning babysitter. Each preset resolves to a
# concrete generation budget (how many topics/sections, how hard to push density)
# and a layout hint (columns/font) echoed back so the renderer matches.

# Topic counts are now generous: parallel section generation means more topics no
# longer means a longer single call (and so no longer risks the upstream timeout).
# A whole-course sheet should be comprehensive — Hyperknow's reference covers ~22
# sections — so the everyday presets aim for broad coverage, not a thin highlight.
_PRESETS: dict[str, dict[str, Any]] = {
    # name                 topics  density   columns  font
    "exam_night":          {"topics": 16, "density": "max",     "columns": 4, "font": "xs"},
    "open_book_exam":      {"topics": 22, "density": "high",    "columns": 3, "font": "sm"},
    "formula_reference":   {"topics": 24, "density": "max",     "columns": 4, "font": "xs"},
    "balanced":            {"topics": 20, "density": "high",    "columns": 3, "font": "sm"},
    "deep_revision":       {"topics": 24, "density": "high",    "columns": 3, "font": "md"},
    "topic_mastery":       {"topics": 6,  "density": "thorough","columns": 2, "font": "md"},
}
_DEFAULT_PRESET = "balanced"
_VALID_PAGES = (1, 2, 3, 4)
_VALID_COLUMNS = (2, 3, 4)
_VALID_LANGS = ("source", "en", "de", "de_terms_en_explanations")
_VALID_STYLES = ("academic", "modern", "compact", "classic")
_VALID_FONT_SIZES = ("auto", "small", "medium", "large")
_VALID_DETAIL_LEVELS = ("general", "balanced", "specific", "very_thorough")
_VALID_FOCUS_MODES = ("whole_course", "specific_topic", "selected_files", "selected_pages")
_VALID_OUTPUTS = ("web", "pdf", "both")
# Density label → the count band we ask the model to aim for. HARD CONSTRAINT:
# output runs ~40 tok/s against the upstream timeout, AND the sheet is one JSON
# string (a run that overshoots the token cap truncates → "could not parse model
# JSON"). Model verbosity varies run-to-run, so we keep the TARGET modest enough
# that even a verbose run finishes well under both the cap and ~45s of wall time.
# Bigger bands gave ~30 formulas but intermittently timed out / truncated.
_DENSITY_TARGET = {
    "max": "16-24", "high": "14-20", "thorough": "10-16",
}
# Hard time bound: output runs ~40 tok/s, so 1400 tokens ≈ 35s + overhead < 45s,
# fitting even the OLD proxy timeout (so the feature works regardless of whether
# the 60s proxy bump is deployed). A verbose run that hits this cap is salvaged
# (chat_json salvage_key) into a slightly-shorter but renderable sheet instead of
# a JSON parse failure.
_MAX_TOKENS = 1400
_LANG_INSTRUCTION = {
    "source": "Match the language of the source material.",
    "en": "Write the cheatsheet in English regardless of the source language.",
    "de": "Write the cheatsheet in German (Deutsch) regardless of the source language.",
    "de_terms_en_explanations": "Use German technical terms with short English explanations.",
}

_PURPOSE_INSTRUCTION = {
    "exam_night": (
        "Purpose: Exam Night. Prioritize high-entropy formulas, critical traps, "
        "and a compact method picker. Use minimal definitions and no long explanations."
    ),
    "open_book_exam": (
        "Purpose: Open-book Exam. Prioritize lookup structure, procedures, source-backed "
        "formulas, and clear section boundaries for fast scanning."
    ),
    "formula_reference": (
        "Purpose: Formula Reference. Prioritize formulas, variable meanings, assumptions, "
        "and special cases. Use the least prose of all modes."
    ),
    "balanced": (
        "Purpose: Balanced Study. Balance formulas, short definitions, special cases, "
        "and exam traps without becoming a study guide."
    ),
    "deep_revision": (
        "Purpose: Deep Revision. Include formulas, definitions, special cases, and short "
        "method hints with slightly more context."
    ),
    "topic_mastery": (
        "Purpose: Topic Mastery. Go deeper on the focused topic: related formulas, "
        "assumptions, examples, and traps."
    ),
}

_DETAIL_CONFIG = {
    "general": {"topicDelta": -3, "topK": 4, "evidence": 28, "density": "10-16"},
    "balanced": {"topicDelta": 0, "topK": 5, "evidence": 36, "density": "14-20"},
    "specific": {"topicDelta": 2, "topK": 6, "evidence": 48, "density": "20-32"},
    "very_thorough": {"topicDelta": 4, "topK": 7, "evidence": 60, "density": "28-42"},
}

_FONT_TO_LAYOUT = {
    "auto": None,
    "small": "xs",
    "medium": "sm",
    "large": "md",
}


def normalize_settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    """Resolve a (possibly partial/garbage) settings dict into a concrete,
    clamped config. Always returns a full dict so callers never branch on None."""
    s = settings or {}
    preset = str(s.get("preset") or _DEFAULT_PRESET).lower()
    if preset not in _PRESETS:
        preset = _DEFAULT_PRESET
    base = dict(_PRESETS[preset])

    pages = s.get("pages")
    pages = pages if pages in _VALID_PAGES else (1 if preset == "exam_night" else 2)
    columns = s.get("columns")
    columns = columns if columns in _VALID_COLUMNS else base["columns"]

    style = str(s.get("style") or "academic").lower()
    if style not in _VALID_STYLES:
        style = "academic"

    font_size = str(s.get("fontSize") or "auto").lower()
    if font_size not in _VALID_FONT_SIZES:
        font_size = "auto"

    detail_explicit = "detailLevel" in s
    detail_level = str(s.get("detailLevel") or "balanced").lower()
    if detail_level not in _VALID_DETAIL_LEVELS:
        detail_level = "balanced"
    detail = _DETAIL_CONFIG[detail_level]

    focus_mode = str(s.get("focusMode") or "whole_course").lower()
    if focus_mode not in _VALID_FOCUS_MODES:
        focus_mode = "whole_course"

    output = str(s.get("output") or "both").lower()
    if output not in _VALID_OUTPUTS:
        output = "both"
    # More pages → a few more sections; fewer → tighter. A gentle ±delta. The cap
    # is the skeleton depth (_MAX_TOPICS); parallel section generation means even
    # the full count fans out into concurrent shards rather than one long call.
    base["topics"] = max(4, min(_MAX_TOPICS, base["topics"] + (pages - 2) * 2 + detail["topicDelta"]))

    lang = str(s.get("language") or "source").lower()
    if lang not in _VALID_LANGS:
        lang = "source"
    font = _FONT_TO_LAYOUT[font_size] or base["font"]

    return {
        "preset": preset,
        "pages": pages,
        "columns": columns,
        "style": style,
        "fontSize": font_size,
        "detailLevel": detail_level,
        "focusMode": focus_mode,
        "language": lang,
        "output": output,
        "font": font,
        "densityTarget": detail["density"] if detail_explicit else _DENSITY_TARGET.get(base["density"], detail["density"]),
        "maxTopics": base["topics"],
        "perTopicTopK": detail["topK"],
        "maxEvidence": detail["evidence"],
        "langInstruction": _LANG_INSTRUCTION.get(lang, _LANG_INSTRUCTION["source"]),
        "purposeInstruction": _PURPOSE_INSTRUCTION.get(preset, _PURPOSE_INSTRUCTION["balanced"]),
    }


# ── Sanitization (Stage 4) ───────────────────────────────────────────────────
#
# OCR'd source material leaks two kinds of garbage into generated sheets, both
# observed in real output:
#   * the Unicode replacement char � (�) where OCR couldn't decode a glyph
#     (e.g. "Körpersystemen" → "K�rpersystemen"), and stray control chars;
#   * malformed display formulas — unbalanced braces, empty bodies, or "$$ (20)
#     $$" (an equation NUMBER mis-captured as a formula).
# A broken formula on a cheatsheet is worse than a missing one (it looks
# authoritative and is wrong), so we drop what we can't trivially trust. This is
# strictly mechanical — no LLM, no guessing the intended content.

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_DISPLAY_FORMULA_RE = re.compile(r"\$\$(.+?)\$\$", re.S)
_INLINE_FORMULA_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)", re.S)
# A real formula body has at least one relational/operator/structure token.
_HAS_MATH_RE = re.compile(r"[=<>+\-*/^_]|\\frac|\\int|\\sum|\\sqrt|\\partial|\\cdot|\\times|\\le|\\ge")


def _formula_body_ok(body: str) -> bool:
    """True if a display-formula body is safe to render: balanced braces, no
    replacement char, non-empty, and actually contains math (not just "(20)")."""
    b = formula_to_latexish(body).strip()
    if formula_corruption_reasons(b):
        return False
    if not b or "�" in b:
        return False
    if b.count("{") != b.count("}"):
        return False
    return bool(_HAS_MATH_RE.search(b))


def sanitize_cheatsheet_markdown(text: str) -> tuple[str, int]:
    """Mechanically clean a generated cheatsheet. Returns (cleaned, dropped),
    where ``dropped`` is the number of malformed display formulas removed.

    - Strips the replacement char � and control chars everywhere.
    - Drops any ``$$...$$`` block whose body isn't safe to render, replacing it
      with a subtle, honest marker rather than broken LaTeX.
    """
    if not text:
        return "", 0
    text = repair_mojibake(text)
    # 1) corruption chars (also fixes � inside inline $...$ and headings)
    cleaned = text.replace("�", "").replace("\r", "")
    cleaned = _CTRL_RE.sub("", cleaned)

    # 1a) normalise LaTeX math delimiters to the ``$``/``$$`` the renderer expects.
    # Models intermittently emit ``\(...\)`` / ``\[...\]`` (and OCR'd sources carry
    # them in), which KaTeX-in-markdown does NOT render — they leak as raw text.
    # Done before the odd-``$$`` trim so the converted delimiters balance correctly.
    cleaned = cleaned.replace("\\[", "$$").replace("\\]", "$$")
    cleaned = cleaned.replace("\\(", "$").replace("\\)", "$")

    # 1b) a salvaged (token-cap-truncated) sheet can end mid-formula, leaving a
    # dangling unterminated "$$" that would break KaTeX. If the display-delimiter
    # count is odd, drop everything from the last "$$" onward.
    if cleaned.count("$$") % 2 == 1:
        cleaned = cleaned[: cleaned.rfind("$$")].rstrip()

    # 2) malformed display formulas
    dropped = 0

    def _display_repl(m: "re.Match[str]") -> str:
        nonlocal dropped
        normalized = normalize_formula_text(m.group(1))
        if normalized and _formula_body_ok(normalized):
            return "$$" + normalized + "$$"
        dropped += 1
        return "*(formula omitted — unreadable in source)*"

    def _inline_repl(m: "re.Match[str]") -> str:
        nonlocal dropped
        normalized = normalize_formula_text(m.group(1))
        if normalized:
            return "$" + normalized + "$"
        dropped += 1
        return "*(formula omitted - unreadable in source)*"

    cleaned = _DISPLAY_FORMULA_RE.sub(_display_repl, cleaned)
    cleaned = _INLINE_FORMULA_RE.sub(_inline_repl, cleaned)
    return cleaned, dropped


def _normalize_formula_key(body: str) -> str:
    """Whitespace/spacing-insensitive key for duplicate detection."""
    k = body.lower()
    k = re.sub(r"\\[,;:!\s]", "", k)   # latex thin spaces / escaped spaces
    k = re.sub(r"\s+", "", k)
    return k.strip("$ ")


def dedup_display_formulas(text: str) -> tuple[str, int]:
    """Remove EXACT repeated display formulas, keeping the first occurrence.

    The per-PDF prompt asks the model to dedup across PDF sections, but models
    are unreliable at it; this is the deterministic backstop that GUARANTEES no
    display formula appears twice. Duplicates are replaced with a subtle marker
    so the section still reads naturally; resulting empty bullets are trimmed.
    """
    seen: set[str] = set()
    removed = 0

    def _repl(m: "re.Match[str]") -> str:
        nonlocal removed
        key = _normalize_formula_key(m.group(1))
        if not key:
            return m.group(0)
        if key in seen:
            removed += 1
            return "*(see above)*"
        seen.add(key)
        return m.group(0)

    out = _DISPLAY_FORMULA_RE.sub(_repl, text)
    # Trim bullets/lines left empty or holding only the marker.
    out = re.sub(r"(?m)^\s*[-*]\s*(\*\(see above\)\*)?\s*$", "", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out, removed


# ── Grounding (Stage 2) ──────────────────────────────────────────────────────
#
# We can cheaply check that a formula's distinctive tokens actually appear in the
# retrieved source text — a mechanical hallucination signal, NOT proof the
# formula is on the exact cited page (the LLM still chooses the page, and LLMs
# attribute sloppily). So this only LABELS honestly and WARNS; it never drops a
# formula, because OCR noise can make a correct formula fail to match garbled
# source text — dropping it would be worse than flagging.

# LaTeX command words to ignore when extracting a formula's "real" tokens.
_LATEX_WORDS = frozenset({
    "frac", "cdot", "times", "sqrt", "int", "sum", "partial", "left", "right",
    "begin", "end", "text", "mathrm", "mathbf", "vec", "hat", "bar", "dot",
    "ddot", "infty", "alpha", "beta", "gamma", "delta", "theta", "lambda",
    "omega", "pi", "mu", "rho", "sigma", "tau", "phi", "psi", "nabla",
})
_FORMULA_TOK_RE = re.compile(r"[a-z0-9]{2,}")


def _formula_grounded(body: str, corpus: str) -> bool:
    """True if a formula body's distinctive multi-char tokens appear in the
    evidence corpus. Single-symbol formulas (no multi-char token) can't be
    disproved mechanically, so they're treated as grounded (no false alarm)."""
    toks = {t for t in _FORMULA_TOK_RE.findall(body.lower()) if t not in _LATEX_WORDS}
    if not toks:
        return True
    hits = sum(1 for t in toks if t in corpus)
    return hits >= max(1, len(toks) // 2)


def formula_grounding(text: str, evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Mechanical grounding metric over the sheet's display formulas. Returns
    {total, grounded, ratio}. ratio is None when there are no display formulas."""
    bodies = _DISPLAY_FORMULA_RE.findall(text or "")
    total = len(bodies)
    if not total:
        return {"total": 0, "grounded": 0, "ratio": None}
    corpus = " ".join((c.get("text") or "") for c in evidence).lower()
    grounded = sum(1 for b in bodies if _formula_grounded(b, corpus))
    return {"total": total, "grounded": grounded, "ratio": round(grounded / total, 3)}


def drop_unsupported_display_formulas(
    text: str,
    evidence: list[dict[str, Any]],
) -> tuple[str, int]:
    """Remove display formulas that cannot be matched to retrieved source text.

    This is a deterministic source-support gate, not a proof of mathematical
    equivalence. It only acts on display formulas; inline symbols like `$v$`
    remain usable labels/variables in prose.
    """
    corpus = " ".join((c.get("text") or "") for c in evidence).lower()
    removed = 0

    def _repl(m: "re.Match[str]") -> str:
        nonlocal removed
        body = m.group(1)
        if _formula_grounded(body, corpus):
            return m.group(0)
        removed += 1
        return "*(formula omitted - not supported by retrieved source text)*"

    return _DISPLAY_FORMULA_RE.sub(_repl, text or ""), removed


def remove_generic_filler_notes(text: str) -> tuple[str, int]:
    """Remove vague warning lines that add no exam value."""
    removed = 0
    kept: list[str] = []
    for line in (text or "").splitlines():
        if _GENERIC_FILLER_RE.match(line.strip()):
            removed += 1
            continue
        kept.append(line)
    out = "\n".join(kept)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out, removed


def _topic_key(text: str) -> str:
    repaired = repair_mojibake(text or "").lower()
    stripped = "".join(
        ch for ch in unicodedata.normalize("NFKD", repaired)
        if not unicodedata.combining(ch)
    )
    return re.sub(r"[^a-z0-9]+", " ", stripped).strip()


def _canonical_mechanics_topic(name: str) -> str:
    key = _topic_key(name)
    if not key:
        return name
    # Word-START matching (alias must begin at a word boundary), not a raw
    # substring. A leading space still allows German morphology — an alias is a
    # prefix of a longer word ("korpersystem" → "korpersystemen", "reibung" →
    # "reibungskraft") — while killing compound false positives where the alias
    # is only a SUFFIX ("work" in "net work" → "network", "homework",
    # "framework"; "power" in "horsepower"). Standalone-word collisions
    # ("normal" in "normal distribution") remain by design — the taxonomy is
    # intentionally aggressive; gate it per-subject if this goes multi-course.
    padded = " " + key
    for needle, canonical in _MECHANICS_TOPIC_ALIASES:
        if " " + needle in padded:
            return canonical
    return repair_mojibake(name).strip()


# Generic method/scaffolding terms that the topic extractor occasionally emits as
# top-level "topics". They are course-agnostic non-subjects — a real reference
# sheet never has an "Integrals" or "Initial conditions" section — so we drop them
# from the skeleton before generation. Kept tight to avoid culling real topics in
# non-mechanics courses; match is on the normalised _topic_key.
_GENERIC_NONTOPIC_WORDS = frozenset({
    "integral", "integrale", "integrals", "integration",
    "grundlagen", "basics", "einleitung", "introduction", "intro", "notation",
    "anfangsbedingungen", "randbedingungen", "initialbedingungen",
})
_GENERIC_NONTOPIC_PHRASES = frozenset({
    "initial conditions", "initial condition", "boundary conditions",
})
_GENERIC_NONTOPIC_PREFIXES = ("initialbeding", "anfangsbeding", "randbeding")


def _is_generic_nontopic(key: str) -> bool:
    if not key:
        return False
    if key in _GENERIC_NONTOPIC_PHRASES:
        return True
    if any(key.startswith(p) for p in _GENERIC_NONTOPIC_PREFIXES):
        return True
    return any(tok in _GENERIC_NONTOPIC_WORDS for tok in key.split())


def _dedupe_topic_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        canonical = _canonical_mechanics_topic(name)
        key = _topic_key(canonical)
        if not key or key in seen:
            continue
        if _is_generic_nontopic(key):
            # Generic scaffolding the topic extractor sometimes promotes to a
            # top-level topic (e.g. "Integrals", "Initial conditions"). These make
            # near-formula-free junk sections; a real reference never has them.
            continue
        seen.add(key)
        out.append(canonical)
    mechanics_rank = {name: i for i, name in enumerate(_MECHANICS_TOPIC_ORDER)}
    indexed = list(enumerate(out))
    indexed.sort(key=lambda item: (mechanics_rank.get(item[1], len(mechanics_rank)), item[0]))
    return [name for _, name in indexed]


def _topic_names(
    topic_map: list[dict[str, Any]],
    topic_focus: str | None,
    limit: int = _MAX_TOPICS,
) -> list[str | None]:
    if topic_focus:
        return [_canonical_mechanics_topic(topic_focus)]
    names = [t.get("name") for t in (topic_map or []) if t.get("name")]
    names = _dedupe_topic_names([str(n) for n in names])
    return names[:limit] or [None]


def _topic_query(topic: str | None) -> str:
    if not topic:
        return "key formulas, definitions, rules, theorems"
    aliases = [needle for needle, canonical in _MECHANICS_TOPIC_ALIASES if canonical == topic]
    if aliases:
        return topic + " " + " ".join(aliases[:8])
    return topic


def _trap_guidance(topics: list[str | None]) -> str:
    lines: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        if not topic:
            continue
        canonical = _canonical_mechanics_topic(topic)
        for trap in _MECHANICS_TRAP_BANK.get(canonical, ()):
            if trap in seen:
                continue
            seen.add(trap)
            lines.append(f"- {canonical}: {trap}")
    if not lines:
        return ""
    return (
        "\n\nCURATED EXAM TRAPS (include only relevant, precise traps; do not "
        "invent vague warnings):\n" + "\n".join(lines)
    )


def _formula_bank_guidance(topics: list[str | None]) -> str:
    lines: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        if not topic:
            continue
        canonical = _canonical_mechanics_topic(topic)
        formulas = _MECHANICS_FORMULA_BANK.get(canonical, ())
        if not formulas:
            continue
        key = _topic_key(canonical)
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"- {canonical}: " + "; ".join(formulas[:4]))
    if not lines:
        return ""
    return (
        "\n\nEXPECTED FORMULA PRIORITIES (retrieval/selection guide only; "
        "include a formula only when the COURSE CONTEXT supports it):\n"
        + "\n".join(lines)
    )


def _formula_count(text: str) -> int:
    # Sections emit mostly inline ``$...$`` formulas, not display ``$$...$$``, so
    # counting display blocks alone reports 0 for a sheet full of math. The inline
    # regex's ``$$`` guards mean display formulas are never double-counted here.
    t = text or ""
    return len(_DISPLAY_FORMULA_RE.findall(t)) + len(_INLINE_FORMULA_RE.findall(t))


def _quality_metrics(
    *,
    text: str,
    topics: list[str | None],
    grounding: dict[str, Any],
    cfg: dict[str, Any],
    dropped_formulas: int,
    unsupported_formulas: int,
    filler_notes: int,
    evidence_quality: EvidenceNormalizationStats,
) -> dict[str, Any]:
    formulas = _formula_count(text)
    covered_topics = len([t for t in topics if t])
    topic_count = max(1, covered_topics)
    grounded_ratio = grounding.get("ratio")
    m = re.match(r"\s*(\d+)\s*-\s*(\d+)", str(cfg.get("densityTarget") or ""))
    expected_min = int(m.group(1)) if m else 0
    density_ratio = min(1.0, formulas / expected_min) if expected_min else None
    layout_penalty = max(0, formulas - expected_min) * 2 if expected_min else 20
    return {
        "formulaCount": formulas,
        "formulaDensity": round(formulas / topic_count, 2),
        "formulaReadability": max(0, 100 - (dropped_formulas + evidence_quality.dropped_formula_lines) * 12),
        "sourceSupport": None if grounded_ratio is None else round(float(grounded_ratio) * 100),
        # No on-page citations (the Hyperknow target shows none); grounding is an
        # internal guard only (sourceSupport), so a "100% cited" metric would be a
        # false claim. Deliberately omitted.
        "topicCoverage": min(100, round((covered_topics / topic_count) * 100)),
        "layoutFit": max(40, min(100, 100 - layout_penalty)),
        "languageConsistency": 100,
        "corruptionCount": evidence_quality.dropped_formula_lines + dropped_formulas,
        "unsupportedFormulaCount": unsupported_formulas,
        "genericFillerCount": filler_notes,
        "formulaDensityTargetMet": density_ratio,
    }




def _classify_item(content: str) -> str:
    text = repair_mojibake(content or "").strip()
    low = text.lower()
    if not text:
        return "source_note"
    if re.search(r"\b(trap|warning|critical|only valid|invalid|slip|rutsch|vorsicht)\b", low):
        return "trap"
    if re.search(r"\b(draw|free-body|freischnitt|sketch|choose|use|first|solve|procedure)\b", low):
        return "procedure"
    if re.search(r"^\s*[A-Za-z\\][A-Za-z0-9_\\{}^]*\s*[:=]\s*(?:is|ist|means|bedeutet)\b", text):
        return "variable_definition"
    if re.search(r"(?:^|\s)(?:if|for|bei|falls|wenn|const|constant|special case|sonderfall)\b", low):
        return "special_case"
    if re.search(r"(?:=|\\frac|\\int|\\sum|\\dot|\\Theta|theta|omega|alpha|mu|sqrt|\^|_)", text):
        if re.search(r"(?:derived|follows|from|therefore|=>|->)", low):
            return "derived_formula"
        return "formula"
    if re.search(r"\b(example|exercise|aufgabe|beispiel)\b", low):
        return "example_specific"
    if re.search(r"\b(diagram|sketch|graph|figure|free-body|freischnitt)\b", low):
        return "diagram_logic"
    if re.search(r"\b(is|ist|are|definition|defined as|bezeichnet)\b", low):
        return "definition"
    return "source_note"


def _content_score(content: str, item_type: str | None = None) -> dict[str, int]:
    text = repair_mojibake(content or "")
    typ = item_type or _classify_item(text)
    math_weight = len(re.findall(r"(\\frac|\\int|\\sum|\\dot|\\Theta|theta|omega|alpha|mu|sqrt|[=_^])", text))
    variable_count = len(set(re.findall(r"\b[a-zA-Z](?:_[a-zA-Z0-9]+)?\b", text)))
    entropy = 20 + min(45, math_weight * 7 + variable_count * 3)
    if typ in ("formula", "derived_formula", "special_case"):
        entropy += 20
    if typ in ("trap", "procedure"):
        entropy += 12
    if len(text) > 160:
        entropy -= 10
    exam_utility = {
        "formula": 92,
        "derived_formula": 88,
        "special_case": 84,
        "trap": 82,
        "procedure": 72,
        "variable_definition": 66,
        "diagram_logic": 62,
        "definition": 45,
        "example_specific": 38,
        "source_note": 25,
    }.get(typ, 30)
    derivability = max(5, 80 - entropy)
    memory = min(100, entropy + (15 if math_weight >= 3 else 0))
    return {
        "entropyScore": max(0, min(100, entropy)),
        "examUtilityScore": exam_utility,
        "derivabilityScore": derivability,
        "memoryDifficultyScore": memory,
    }


def _evidence_candidates(
    chunks: list[dict[str, Any]],
    doc_names: dict[str, str],
    limit: int = 18,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for c in chunks:
        fn = doc_names.get(c.get("documentId") or "", "source")
        pg = c.get("pageStart")
        for raw in re.split(r"[\n;]+", c.get("text") or ""):
            line = raw.strip(" -*\t\r")
            if len(line) < 8:
                continue
            typ = _classify_item(line)
            score = _content_score(line, typ)
            support = 18 if c.get("chunkId") else 8
            rank = score["entropyScore"] + score["examUtilityScore"] + support - score["derivabilityScore"] // 3
            items.append({
                "type": typ,
                "content": line[:180],
                "source": f"{fn}, p.{pg}" if pg else fn,
                "score": score,
                "rank": rank,
            })
    items.sort(key=lambda x: x["rank"], reverse=True)
    return items[:limit]


def _taxonomy_candidate_guidance(
    chunks: list[dict[str, Any]],
    doc_names: dict[str, str],
) -> str:
    candidates = _evidence_candidates(chunks, doc_names)
    if not candidates:
        return ""
    lines = []
    for item in candidates:
        score = item["score"]
        lines.append(
            f"- {item['type']} | entropy {score['entropyScore']} | utility "
            f"{score['examUtilityScore']} | {item['content']} ({item['source']})"
        )
    return (
        "\n\nTAXONOMY + HIGH-ENTROPY CANDIDATES (use as planning input; still "
        "write only what is supported by COURSE CONTEXT):\n"
        "Item types: " + ", ".join(_CHEATSHEET_ITEM_TYPES) + ".\n"
        "Selection rule: high entropy + high exam utility + strong source support wins; "
        "remove generic filler and weak notes first.\n"
        + "\n".join(lines)
    )


def _spatial_layout_guidance(topics: list[str | None]) -> str:
    selected = {_canonical_mechanics_topic(t) for t in topics if t}
    lines: list[str] = []
    for col, names in _MECHANICS_LAYOUT_COLUMNS:
        hits = [name for name in names if name in selected]
        if hits:
            lines.append(f"- {col}: " + " -> ".join(hits))
    if not lines:
        return (
            "\n\nSPATIAL LAYOUT RULES:\n"
            "- Arrange sections by conceptual dependency, not by retrieval order.\n"
            "- Keep definitions, formulas, assumptions, special cases, traps, and sources inside one compact module.\n"
            "- Place derived and special-case formulas directly next to their parent formula."
        )
    return (
        "\n\nSPATIAL LAYOUT MAP (keep related blocks physically close; order sections "
        "to match this map where possible):\n" + "\n".join(lines)
    )


def _method_picker_guidance(topics: list[str | None], cfg: dict[str, Any]) -> str:
    selected = {_canonical_mechanics_topic(t) for t in topics if t}
    mechanics_hits = selected.intersection(set(_MECHANICS_TOPIC_ORDER))
    if not mechanics_hits or cfg.get("preset") == "topic_mastery":
        return ""
    return (
        "\n\nMETHOD PICKER (include one tiny `## Method Picker` table near the top "
        "when supported by the selected topics):\n"
        "| Given / problem type | Use |\n"
        "|---|---|\n"
        "| Forces + acceleration | $\\sum F = ma$ |\n"
        "| Known path / constraint | Tangential-normal coordinates |\n"
        "| Central force / rotation | Polar coordinates |\n"
        "| Force over distance | Work-energy |\n"
        "| Collision / short impact | Impulse-momentum |\n"
        "| Rigid body rotation | $\\sum M = \\Theta\\alpha$ |\n"
        "| Rolling body | Translation + rotation + rolling constraint |"
    )


def _architecture_guidance(
    *,
    evidence: list[dict[str, Any]],
    topics: list[str | None],
    doc_names: dict[str, str],
    cfg: dict[str, Any],
) -> str:
    return (
        "\n\nINFORMATION ARCHITECTURE RULES:\n"
        "- Treat the sheet as a compact knowledge map, not a flat summary.\n"
        "- For each topic module use this internal order: core definition -> main formulas -> variable meanings -> assumptions/conditions -> special cases -> derived formulas -> procedures -> exam traps -> examples only if high-value -> sources.\n"
        "- Related formulas must be adjacent; never scatter inverse relationships, coordinate systems, or method families.\n"
        "- Iterative pruning order: generic filler, duplicate definitions, low-priority examples, weak notes, overlong explanations, then only lower-priority formulas.\n"
        "- Never prune core formulas, critical assumptions, important traps, or source citations first.\n"
        + _spatial_layout_guidance(topics)
        + _method_picker_guidance(topics, cfg)
        + _taxonomy_candidate_guidance(evidence, doc_names)
    )


def _pool_evidence(
    *,
    user_id: str,
    course_id: str,
    topics: list[str | None],
    document_ids: list[str] | None,
    top_k: int = _PER_TOPIC_TOP_K,
    max_evidence: int = _MAX_EVIDENCE,
) -> list[dict[str, Any]]:
    """Retrieve a deduped, source-grounded evidence pool across the topics."""
    seen: set[str] = set()
    pooled: list[dict[str, Any]] = []
    for t in topics:
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=t,
                query=_topic_query(t),
                document_ids=document_ids or None,
                purpose="cheatsheet",
                top_k=top_k,
            )
        except Exception:  # noqa: BLE001
            log.exception("cheatsheet evidence retrieval failed (topic=%s)", t)
            chunks = []
        for c in chunks:
            cid = c.get("chunkId")
            if cid and cid not in seen:
                seen.add(cid)
                pooled.append(c)
    return pooled[:max_evidence]


def _backfill_doc_names(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> dict[str, str]:
    """Fill in filenames for any documentIds in ``chunks`` not already known.

    ``retrieve_learning_context`` returns ``to_api`` dicts, which carry no
    filename — so course-wide cheatsheets (no caller-supplied ``doc_names``)
    would otherwise cite "Unknown". Mirrors notes.backfill_doc_names but for
    dict chunks. Best-effort: lookup failures just leave "Unknown".
    """
    missing = {c.get("documentId") for c in chunks if c.get("documentId")} - set(doc_names)
    missing.discard(None)
    if not missing:
        return doc_names
    try:
        resp = (
            get_supabase().table("documents")
            .select("id, file_name")
            .in_("id", list(missing))
            .execute()
        )
        for row in (resp.data or []):
            if row.get("id") and row.get("file_name"):
                doc_names[row["id"]] = row["file_name"]
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet doc-name backfill failed (non-fatal)")
    return doc_names


def _format_evidence(
    chunks: list[dict[str, Any]], doc_names: dict[str, str], topics: list[str | None]
) -> str:
    """Group evidence by planned topic so the model can write one section each.

    Each chunk is tagged with its filename + page for inline citation.
    """
    parts: list[str] = []
    topic_line = ", ".join(t for t in topics if t) or "the course"
    parts.append("TOPICS TO COVER (in this order): " + topic_line + "\n")
    for i, c in enumerate(chunks, 1):
        fn = doc_names.get(c.get("documentId") or "", "source")
        pg = c.get("pageStart")
        text = (c.get("text") or "").strip().replace("\r", " ")
        if len(text) > 700:
            text = text[:700] + " …"
        head = f"[Source {i}] {fn}" + (f", p.{pg}" if pg else "")
        parts.append(f"{head}\n{text}")
    return "\n\n---\n\n".join(parts)


def _pool_evidence_by_doc(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str],
    topics: list[str | None],
    per_doc_cap: int,
) -> "dict[str, list[dict[str, Any]]]":
    """Retrieve topic-ranked evidence separately for each selected PDF.

    The topic map runs in the background here: we query each doc with the
    course's key-topic terms so the strongest formulas surface, but the result
    is grouped by document so the model can write one section per PDF.
    """
    topic_terms = " ".join(_topic_query(t) for t in topics if t) or ""
    query = (topic_terms + " key formulas, definitions, rules, theorems").strip()
    by_doc: dict[str, list[dict[str, Any]]] = {}
    for doc_id in document_ids:
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=None,
                query=query,
                document_ids=[doc_id],
                purpose="cheatsheet",
                top_k=per_doc_cap,
            )
        except Exception:  # noqa: BLE001
            log.exception("cheatsheet per-doc retrieval failed (doc=%s)", doc_id)
            chunks = []
        if chunks:
            by_doc[doc_id] = chunks
    return by_doc


def _format_evidence_by_doc(
    by_doc: "dict[str, list[dict[str, Any]]]", doc_names: dict[str, str]
) -> str:
    """Group evidence under one block per PDF so the model writes a section each."""
    blocks: list[str] = []
    n = 0
    for doc_id, chunks in by_doc.items():
        fn = doc_names.get(doc_id, "source")
        lines = [f"### SOURCE PDF: {fn}"]
        for c in chunks:
            n += 1
            pg = c.get("pageStart")
            text = (c.get("text") or "").strip().replace("\r", " ")
            if len(text) > 700:
                text = text[:700] + " …"
            head = f"[Source {n}] {fn}" + (f", p.{pg}" if pg else "")
            lines.append(f"{head}\n{text}")
        blocks.append("\n\n".join(lines))
    return "\n\n=====\n\n".join(blocks)


def _settings_system_prompt(cfg: dict[str, Any], *, per_pdf: bool = False) -> str:
    """Append the settings-specific overrides to the base system prompt. These
    come LAST so they take precedence over the generic guidance in _SYSTEM."""
    prompt = (
        _SYSTEM
        + "\n\nSETTINGS (override any generic guidance above):\n"
        + f"- Aim for {cfg['densityTarget']} formulas across the sheet when the "
        "evidence supports them; never invent to hit the number.\n"
        + f"- Detail level: {cfg['detailLevel']}; pages: {cfg['pages']}; columns: {cfg['columns']}.\n"
        + f"- Visual style: {cfg['style']}; keep prose compact enough for the selected layout.\n"
        + f"- {cfg['langInstruction']}\n"
        + f"- {cfg['purposeInstruction']}"
    )
    if per_pdf:
        prompt += (
            "\n\nSTRUCTURE OVERRIDE — PER-PDF MODE (ignore the topic-organisation "
            "rule above):\n"
            "- The COURSE CONTEXT is grouped under '### SOURCE PDF: <filename>' "
            "blocks. Produce ONE `##` section per SOURCE PDF, in the same order, "
            "using that PDF's filename as the `##` heading.\n"
            "- Under each heading put only the highest-value formulas/rules that "
            "come FROM THAT PDF.\n"
            "- DEDUP (critical): each distinct formula/rule appears EXACTLY ONCE, "
            "under the FIRST PDF that contains it. If it already appeared in an "
            "earlier PDF's section, OMIT it from later sections — do not repeat it.\n"
            "- If, after removing repeats, a PDF has nothing unique left, give it "
            "a one-line '(no unique formulas — covered above)' note instead of a "
            "section body."
        )
    return prompt


# A "section group" is one cheatsheet section: a label (topic name, or filename
# in per-PDF mode) plus the evidence chunks that back it.
SectionGroup = tuple[str, list[dict[str, Any]]]


def _pool_evidence_grouped(
    *,
    user_id: str,
    course_id: str,
    topics: list[str | None],
    document_ids: list[str] | None,
    top_k: int,
) -> list[SectionGroup]:
    """Retrieve evidence per topic, KEEPING it grouped by topic (in skeleton order).

    Unlike _pool_evidence (which flattens into one pool), this preserves the
    topic→evidence mapping so each parallel shard is fed only its own topics'
    chunks. A chunk is assigned to the FIRST topic that retrieves it, so the same
    formula isn't handed to several sections at once.
    """
    seen: set[str] = set()
    groups: list[SectionGroup] = []
    for t in topics:
        if not t:
            continue
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=t,
                query=_topic_query(t),
                document_ids=document_ids or None,
                purpose="cheatsheet",
                top_k=top_k,
            )
        except Exception:  # noqa: BLE001
            log.exception("cheatsheet grouped retrieval failed (topic=%s)", t)
            chunks = []
        fresh: list[dict[str, Any]] = []
        for c in chunks:
            cid = c.get("chunkId")
            if cid:
                if cid in seen:
                    continue
                seen.add(cid)
            fresh.append(c)
        if fresh:
            groups.append((t, fresh))
    return groups


def _normalize_groups(
    groups: list[SectionGroup],
) -> tuple[list[SectionGroup], EvidenceNormalizationStats]:
    """Run normalize_evidence_chunks per group, summing stats; drop empty groups."""
    out: list[SectionGroup] = []
    agg = {
        "chunks_in": 0, "chunks_out": 0,
        "repaired_chunks": 0, "dropped_chunks": 0, "dropped_formula_lines": 0,
    }
    for label, chunks in groups:
        norm, st = normalize_evidence_chunks(chunks)
        agg["chunks_in"] += st.chunks_in
        agg["chunks_out"] += st.chunks_out
        agg["repaired_chunks"] += st.repaired_chunks
        agg["dropped_chunks"] += st.dropped_chunks
        agg["dropped_formula_lines"] += st.dropped_formula_lines
        if norm:
            out.append((label, norm))
    return out, EvidenceNormalizationStats(**agg)


def _format_section_evidence(group: list[SectionGroup], doc_names: dict[str, str]) -> str:
    """Render a shard's topics + their evidence as labelled `### TOPIC:` blocks."""
    parts: list[str] = []
    n = 0
    for label, chunks in group:
        parts.append(f"### TOPIC: {label}")
        for c in chunks:
            n += 1
            fn = doc_names.get(c.get("documentId") or "", "source")
            pg = c.get("pageStart")
            text = (c.get("text") or "").strip().replace("\r", " ")
            if len(text) > 700:
                text = text[:700] + " …"
            head = f"[Source {n}] {fn}" + (f", p.{pg}" if pg else "")
            parts.append(f"{head}\n{text}")
    return "\n\n".join(parts)


def _shard_system_prompt(
    cfg: dict[str, Any], topics: list[str], *, with_method_picker: bool
) -> str:
    """Per-shard system prompt: the comprehensive section writer + settings."""
    prompt = (
        _SECTION_SYSTEM
        + "\n\nSETTINGS:\n"
        + f"- {cfg['langInstruction']}\n"
        + f"- Visual style: {cfg['style']}; keep each line compact for a "
        f"{cfg['columns']}-column sheet.\n"
        + f"- {cfg['purposeInstruction']}"
    )
    if with_method_picker:
        prompt += _method_picker_guidance(
            [str(t) for t in topics], cfg
        )
    return prompt


def _run_one_section_shard(
    *,
    cfg: dict[str, Any],
    group: list[SectionGroup],
    doc_names: dict[str, str],
    with_method_picker: bool,
) -> "LlmResult | None":
    """Generate the `##` sections for one shard's worth of topics. Thread-safe."""
    topics = [label for label, _ in group]
    system = _shard_system_prompt(cfg, topics, with_method_picker=with_method_picker)
    user = (
        "COURSE CONTEXT:\n\n"
        + _format_section_evidence(group, doc_names)
        + _formula_bank_guidance([str(t) for t in topics])
        + _trap_guidance([str(t) for t in topics])
    )
    try:
        return chat_json(
            system=system, user=user,
            max_tokens=_PER_SHARD_MAX_TOKENS, salvage_key="text",
        )
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet section shard failed (topics=%s)", topics)
        return None


def _generate_sections_parallel(
    *,
    cfg: dict[str, Any],
    groups: list[SectionGroup],
    doc_names: dict[str, str],
    per_pdf: bool,
) -> tuple[str, dict[str, Any]]:
    """Fan out section generation across shards, stitch back in skeleton order.

    Returns (combined_markdown, diagnostics). Wall-clock is the slowest shard, so
    the whole-course sheet stays inside the upstream timeout while covering every
    topic. The Method Picker is requested only on the first shard (topic mode).
    """
    shards = [
        groups[i:i + _TOPICS_PER_SHARD]
        for i in range(0, len(groups), _TOPICS_PER_SHARD)
    ][:_MAX_SHARDS]
    diag: dict[str, Any] = {"model": None, "promptTokens": 0, "completionTokens": 0}
    if not shards:
        return "", diag

    results: list[Any] = [None] * len(shards)
    with ThreadPoolExecutor(max_workers=len(shards)) as pool:
        futures = {
            pool.submit(
                _run_one_section_shard,
                cfg=cfg,
                group=shard,
                doc_names=doc_names,
                with_method_picker=(idx == 0 and not per_pdf),
            ): idx
            for idx, shard in enumerate(shards)
        }
        for fut in as_completed(futures):
            results[futures[fut]] = fut.result()

    texts: list[str] = []
    for res in results:
        if res is None:
            continue
        diag["model"] = res.model
        diag["promptTokens"] += res.prompt_tokens or 0
        diag["completionTokens"] += res.completion_tokens or 0
        t = (res.data.get("text") if isinstance(res.data, dict) else "") or ""
        if t.strip():
            texts.append(t.strip())
    return "\n\n".join(texts), diag


def generate_cheatsheet(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    topic: str | None,
    doc_names: dict[str, str],
    save: bool = True,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate (and optionally save) a grounded, Topic-Map-driven cheatsheet."""
    cfg = normalize_settings(settings)
    topic_query = (topic or "").strip() or None
    try:
        topic_map = get_course_topic_map(user_id, course_id)
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet: topic map read failed")
        topic_map = []
    topics = _topic_names(topic_map, topic_query, limit=cfg["maxTopics"])

    # Per-PDF mode: a small explicit multi-PDF selection → one section per PDF,
    # deduped across them. The topic map still ranks the evidence in the
    # background. A single PDF (or a large "whole course" selection) uses the
    # topic-map-driven sheet instead. Both modes build a list of SECTION GROUPS
    # (label + evidence) that are then generated in parallel and stitched.
    per_pdf = bool(document_ids and 2 <= len(document_ids) <= _MAX_PER_PDF_DOCS)
    if per_pdf:
        per_doc_cap = max(6, int(cfg["maxEvidence"]) // max(1, len(document_ids or [])))
        by_doc = _pool_evidence_by_doc(
            user_id=user_id, course_id=course_id,
            document_ids=document_ids or [], topics=topics, per_doc_cap=per_doc_cap,
        )
        # Backfill names first so each group's label is the real filename.
        flat_for_names = [c for chunks in by_doc.values() for c in chunks]
        merged_names = _backfill_doc_names(flat_for_names, dict(doc_names or {}))
        raw_groups: list[SectionGroup] = [
            (merged_names.get(doc_id, "source"), chunks) for doc_id, chunks in by_doc.items()
        ]
    else:
        raw_groups = _pool_evidence_grouped(
            user_id=user_id,
            course_id=course_id,
            topics=topics,
            document_ids=document_ids,
            top_k=int(cfg["perTopicTopK"]),
        )
        merged_names = _backfill_doc_names(
            [c for _, chunks in raw_groups for c in chunks], dict(doc_names or {})
        )

    # Clean evidence per group (keeps the topic→evidence grouping for the shards).
    groups, evidence_quality = _normalize_groups(raw_groups)
    evidence = [c for _, chunks in groups for c in chunks]
    covered_labels = [label for label, _ in groups]

    if not evidence:
        return {
            "text": "",
            "warning": "No relevant material found to build a cheatsheet from.",
            "groundedSources": [],
            "settings": cfg,
            "quality": {
                "evidenceNormalization": evidence_quality.__dict__,
            },
        }

    if per_pdf:
        n_pdfs = len(groups)
        title = f"Cheatsheet — {n_pdfs} PDF" + ("s" if n_pdfs != 1 else "")
    else:
        title = (topic_query + " — Cheatsheet") if topic_query else "Course Cheatsheet"

    # Fan out section generation across parallel shards and stitch in order. The
    # deterministic dedup below removes any formula repeated across shards/PDFs.
    raw_text, diag = _generate_sections_parallel(
        cfg=cfg, groups=groups, doc_names=merged_names, per_pdf=per_pdf,
    )
    if not raw_text.strip():
        return {"text": "", "error": "Cheatsheet generation produced no sections.", "groundedSources": []}

    text, dropped_formulas = sanitize_cheatsheet_markdown(raw_text)
    text, filler_notes = remove_generic_filler_notes(text)
    # Deterministic backstop so a repeated formula is GUARANTEED removed, even if
    # the model didn't dedup the per-PDF sections perfectly.
    text, deduped = dedup_display_formulas(text)
    text, unsupported_formulas = drop_unsupported_display_formulas(text, evidence)
    if dropped_formulas:
        log.info("cheatsheet sanitizer dropped %d malformed formula(s)", dropped_formulas)
    if deduped:
        log.info("cheatsheet dedup removed %d repeated formula(s)", deduped)
    if unsupported_formulas:
        log.info("cheatsheet source gate removed %d unsupported formula(s)", unsupported_formulas)
    if filler_notes:
        log.info("cheatsheet filler filter removed %d generic note(s)", filler_notes)
    grounding = formula_grounding(text, evidence)
    sources = [
        {
            "documentId": c.get("documentId"),
            "fileName": merged_names.get(c.get("documentId") or "", "Unknown"),
            "pageStart": c.get("pageStart"),
            "pageEnd": c.get("pageEnd"),
            "chunkId": c.get("chunkId"),
        }
        for c in evidence
    ]
    metrics = _quality_metrics(
        text=text,
        topics=covered_labels,
        grounding=grounding,
        cfg=cfg,
        dropped_formulas=dropped_formulas,
        unsupported_formulas=unsupported_formulas,
        filler_notes=filler_notes,
        evidence_quality=evidence_quality,
    )

    note_id: str | None = None
    if save and text.strip():
        # Course-wide cheatsheets have no single document_id; per-doc selections
        # of exactly one document keep the FK so it shows under that document.
        single_doc = document_ids[0] if document_ids and len(document_ids) == 1 else None
        note_id = save_note(
            user_id=user_id,
            course_id=course_id,
            document_id=single_doc,
            title=title,
            text=text,
            sources=sources,
            note_type="cheatsheet",
        )

    out: dict[str, Any] = {
        "noteId": note_id,
        "title": title,
        "text": text,
        "topicsCovered": covered_labels,
        "groundedSources": sources[:20],
        "settings": cfg,
        "grounding": grounding,
        "quality": {
            "evidenceNormalization": evidence_quality.__dict__,
            "droppedMalformedFormulas": dropped_formulas,
            "droppedUnsupportedFormulas": unsupported_formulas,
            "droppedGenericNotes": filler_notes,
            "metrics": metrics,
        },
        "model": diag.get("model"),
        "promptTokens": diag.get("promptTokens"),
        "completionTokens": diag.get("completionTokens"),
    }
    # Build one honest warning from both signals (sanitizer drops + weak grounding).
    warns: list[str] = []
    if dropped_formulas:
        warns.append(
            f"{dropped_formulas} formula(s) were omitted because the source text "
            "was unreadable (likely scan/OCR quality)."
        )
    if evidence_quality.dropped_formula_lines:
        warns.append(
            f"{evidence_quality.dropped_formula_lines} corrupted formula line(s) "
            "were removed before generation."
        )
    if unsupported_formulas:
        warns.append(
            f"{unsupported_formulas} formula(s) were removed because they were not "
            "supported by the retrieved source text."
        )
    if filler_notes:
        warns.append(f"{filler_notes} generic warning line(s) were removed.")
    if grounding["ratio"] is not None and grounding["total"] >= 3 and grounding["ratio"] < 0.6:
        ungrounded = grounding["total"] - grounding["grounded"]
        warns.append(
            f"{ungrounded} of {grounding['total']} formulas could not be matched "
            "to your source text — double-check them before relying on the sheet."
        )
    if warns:
        out["citationWarning"] = " ".join(warns)
    return out


__all__ = (
    "generate_cheatsheet",
    "sanitize_cheatsheet_markdown",
    "dedup_display_formulas",
    "drop_unsupported_display_formulas",
    "remove_generic_filler_notes",
    "normalize_settings",
    "formula_grounding",
)
