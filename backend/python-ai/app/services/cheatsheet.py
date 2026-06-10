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
from .document_context import understanding_block_for_ids
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

# UNAMBIGUOUS mechanics topic words — used to decide whether the mechanics
# taxonomy (alias-renaming, formula/trap banks, layout map, method picker) should
# run AT ALL for a given course. The full alias table above is intentionally
# aggressive (it maps "normal", "reibung", "rotation" onto mechanics sections),
# which is correct for a real mechanics course but WRONG for any other formula
# subject: a Grundlagen-des-Konstruierens sheet has "Normalspannung" and "Reibung
# (Tribologie)" topics that the aggressive aliases would rewrite into
# "Tangential- und Normalkoordinaten" / "Reibung und Widerstand" and then fill
# with fabricated kinematics formulas. So we gate the whole mechanics path behind
# a count of these STRONG, non-overlapping words (>= 2 ⇒ genuinely a mechanics
# course). Ambiguous words (normal, tangential, reibung, arbeit, energie,
# rotation, …) are deliberately EXCLUDED here.
_MECHANICS_STRONG_NEEDLES = frozenset({
    "kinematik", "kinematics", "kartesisch", "cartesian", "geradlinig",
    "rectilinear", "wurf", "projectile", "polar", "punktmasse", "point mass",
    "bewegungsgleich", "equations of motion", "impuls", "momentum", "impact",
    "tragheitsmoment", "traegheitsmoment", "moment of inertia", "drehimpuls",
    "angular momentum", "ebene bewegung", "plane motion", "rollbewegung",
    "rakete", "rocket", "pendel", "pendulum", "schwerpunkt", "massenmittelpunkt",
    "center of mass", "centre of mass",
})

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
    "Dynamik von Punktmassen": (
        "Draw the free-body diagram first; a missed constraint or friction force changes Sum F.",
        "Project Sum F = m a onto the right axes (x/y or t/n); do not mix coordinate systems.",
    ),
    "Impuls und Stoß": (
        "Momentum is conserved only when no external impulse acts during the (short) impact.",
        "For e: e=1 is elastic (energy kept), e=0 is plastic (bodies stick); energy is NOT conserved unless e=1.",
    ),
    "Drehimpuls": (
        "Angular momentum is conserved only about a point with zero resultant moment.",
        "Always state the reference point; L and M must be taken about the SAME point.",
    ),
    "Rotation starrer Körper": (
        "Take the moment of inertia about the actual rotation axis — use Steiner if it is not through S.",
        "Sum M = Theta * phi_dotdot holds about a fixed axis or the centre of mass, not an arbitrary point.",
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
    "Kartesische Koordinaten": (
        r"\vec r = x\,\vec e_x + y\,\vec e_y + z\,\vec e_z",
        r"\vec v = \dot x\,\vec e_x + \dot y\,\vec e_y + \dot z\,\vec e_z",
        r"\vec a = \ddot x\,\vec e_x + \ddot y\,\vec e_y + \ddot z\,\vec e_z",
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
        r"\vec r = r\,\vec e_r",
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
        r"m\ddot x = \sum F_x",
        r"m\ddot y = \sum F_y",
        r"m\ddot s = \sum F_t",
        r"m\frac{v^2}{\rho} = \sum F_n",
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
        r"E_{rot} = \tfrac{1}{2}\Theta\omega^2",
    ),
    "Drehimpuls": (
        r"\vec L_A = \Theta_A \vec\omega",
        r"\sum \vec M_A = \frac{d\vec L_A}{dt}",
    ),
    "Rotation starrer Körper": (
        r"\omega = \dot\varphi",
        r"\alpha = \ddot\varphi",
        r"v_P = r\omega",
        r"a_t = r\alpha",
        r"a_n = r\omega^2",
        r"\sum M_A = \Theta_A\alpha",
        r"E_{rot} = \tfrac{1}{2}\Theta_A\omega^2",
    ),
    "Ebene Bewegung starrer Körper": (
        r"\vec v_P = \vec v_A + \vec\omega\times\vec r_{AP}",
        r"m\vec a_S = \sum \vec F",
        r"\Theta_S\ddot\varphi = \sum M_S",
        r"E_{kin} = \tfrac{1}{2}mv_S^2 + \tfrac{1}{2}\Theta_S\omega^2",
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
    "STRICT TOPIC BOUNDARIES — write each `## <name>` section using ONLY the "
    "evidence under its matching `### TOPIC: <name>` block. If a formula belongs to "
    "a DIFFERENT listed topic, put it in THAT topic's section, never here; the "
    "evidence pool is fuzzy, so judge by what the formula IS, not where it was "
    "retrieved. Hard rules (do NOT violate):\n"
    "- Friction/resistance (Reibung) = ONLY $R=\\mu N$, $|H|\\le\\mu_0 N$, friction "
    "direction, static vs sliding, drag. NEVER work-energy, NEVER moment of inertia.\n"
    "- Work/energy/power (Arbeit, Energie, Leistung) = work, kinetic/potential "
    "energy, power. The work-energy theorem lives HERE, not under friction.\n"
    "- Angular momentum (Drehimpuls) = ONLY $L=r\\times mv$ and its theorem. NEVER "
    "impact/collision impulse formulas.\n"
    "- Impact/collision (Impuls und Stoß, Zentraler Stoß) = impulse, restitution, "
    "momentum conservation — its own section, never under Drehimpuls.\n"
    "- Moment of inertia (Trägheitsmoment) = $\\Theta=\\int r^2 dm$, Steiner. NEVER "
    "under friction.\n"
    "- Variable mass / rockets ≠ rigid-body dynamics: rigid-body (Starrkörper) is "
    "rotation/rolling/planar motion; 'varying mass throughout motion' is the rocket "
    "topic, do NOT use it to describe rigid bodies.\n"
    "- Coordinate definitions ($r=x e_x+y e_y$) → coordinate-system topic; "
    "$v_P=v_A+\\omega\\times r_{AP}$ and the instantaneous centre → rigid-body planar "
    "motion; 1D constant-acceleration → rectilinear motion.\n"
    "\n"
    "OMIT WEAK SECTIONS — fewer clean sections beat many thin or mixed ones. If a "
    "topic has no grounded formula you can state cleanly, DROP its `## ` section "
    "entirely rather than emit a definition-only or mixed block. Never write a "
    "section whose formulas you are unsure of.\n"
    "\n"
    "GENERAL FORMULAS ONLY — the course evidence is mostly worked EXERCISE "
    "solutions, so it is full of setup-specific formulas. A general topic section "
    "must contain only the GENERAL law/relation, never a formula that holds for one "
    "specific figure or exercise (e.g. $v_A = r_A$, $\\omega = \\omega\\cos\\phi$, a "
    "numbered numeric result). If a useful formula is exercise-specific, omit it "
    "(or, only in Topic Mastery, label it **Example-specific**). For rigid bodies "
    "use the general forms $\\vec v_P = \\vec v_A + \\vec\\omega\\times\\vec r_{AP}$ "
    "and $\\Theta\\ddot\\varphi = \\sum M$, not a single exercise's $v_A,v_B$.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact/result of a block in ==double equals== "
    "(yellow highlight). Write it as `==text==` with NO spaces between the equals "
    "and the text, and always TWO equals on each side — never `= text =`. At most "
    "one per block.\n"
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
        "Purpose: Open-book Exam — an exam NAVIGATION tool, not a summary. Prioritize "
        "fast lookup: problem-type triggers, method selection, formula usage conditions, "
        "assumptions, and traps. Clean section boundaries, minimal clutter, easy scanning."
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

# Each preset is a DISTINCT artefact, not a density knob on one template. The
# section-format override (injected LAST, so it beats the generic block contract)
# is what makes the modes feel different. Labels are bold lead-ins the renderer
# already styles; formulas are always $...$ / $$...$$.
_PRESET_SECTION_FORMAT = {
    # Exam Night — one-page emergency formula+trap sheet, highest yield / smallest
    # space. Formula-first, almost no prose.
    "exam_night": (
        "\n\nEXAM NIGHT FORMAT — OVERRIDES the section shape. This is a one-page "
        "emergency sheet of only what a student would FORGET: highest-yield formulas "
        "and the nastiest traps, in the least space. Each `## <name>` section:\n"
        "- the highest-yield FORMULAS first, each on its own line, hardest-to-recall "
        "special cases folded in as `$...$ (case)`. No definitions unless a symbol is "
        "ambiguous.\n"
        "- **Condition:** one line, only when non-obvious.\n"
        "- **Trap:** one precise, exam-relevant mistake.\n"
        "Drop low-yield topics and anything obvious. No prose, no explanations."
    ),
    # Open-book Exam — exam NAVIGATION tool: problem-type → method → formula →
    # condition → trap, optimised for fast lookup.
    "open_book_exam": (
        "\n\nOPEN-BOOK EXAM FORMAT — OVERRIDES the section shape. Write EVERY "
        "`## <name>` section as a fast-lookup card with these exact bold labels, in "
        "order, no prose paragraphs, no definitions block:\n"
        "- **Use when:** the problem-type trigger — what the question gives or asks "
        "that signals this method/topic (the most important line for lookup).\n"
        "- **Formulas:** the core formula(s), each on its own line; fold special "
        "cases as `$...$ (case)`.\n"
        "- **Conditions:** the assumptions that must hold.\n"
        "- **Watch out:** the exam trap(s), one short line each.\n"
        "Omit a label only when nothing grounded fits it. Clean section boundaries, "
        "minimal clutter, scannable in seconds."
    ),
    # Formula Reference — densest mode: maximum formulas, minimum prose.
    "formula_reference": (
        "\n\nFORMULA REFERENCE FORMAT — OVERRIDES the section shape. The DENSEST mode: "
        "maximum formulas, minimum words (aim ≥75% formulas/variables/conditions, "
        "≤25% notes). Each `## <name>` section starts IMMEDIATELY with the formulas — "
        "do NOT write any opening definition or concept sentence:\n"
        "- the core + derived formulas FIRST, each on its own line as $...$ / $$...$$.\n"
        "- **Variables:** terse `symbol: meaning` for the non-obvious symbols only.\n"
        "- **Conditions:** assumptions in one line.\n"
        "- **Special cases:** simplified formulas, each `$...$ (case)`.\n"
        "No explanations, no worked examples, no concept sentences, no Method Picker. "
        "Always prefer one more formula over one more sentence."
    ),
    # Balanced Study — ~60% formulas, 25% short explanation, 15% traps.
    "balanced": (
        "\n\nBALANCED STUDY FORMAT — OVERRIDES the section shape. Compact but "
        "understandable (≈60% formulas, 25% short explanation, 15% traps). Each "
        "`## <name>` section:\n"
        "- **Concept:** ONE short line — what it is / when it is used.\n"
        "- **Formulas:** the core formulas, each on its own line.\n"
        "- **Special cases:** the important simplified cases.\n"
        "- **Trap:** the common mistake (one line).\n"
        "Not a formula dump and not a textbook summary."
    ),
    # Deep Revision — deeper than Balanced, still compact (no paragraph > 3-4 lines).
    "deep_revision": (
        "\n\nDEEP REVISION FORMAT — OVERRIDES the section shape. Deeper than Balanced "
        "but still compact — NO paragraph longer than 3-4 lines. Each `## <name>` "
        "section:\n"
        "- **Concept:** what the topic means (1-2 lines).\n"
        "- **Why it matters:** how it is used in problems (1 line).\n"
        "- **Formula cluster:** the main formulas, each on its own line.\n"
        "- **Conditions:** when they apply.\n"
        "- **Special cases:** important simplified cases.\n"
        "- **Method hint:** a short numbered how-to-solve.\n"
        "- **Trap:** the common mistake."
    ),
    # Topic Mastery — go DEEP on the single focus topic; expand it into ordered
    # `##` subsections instead of one block.
    "topic_mastery": (
        "\n\nTOPIC MASTERY FORMAT — OVERRIDES the section shape AND the one-section-"
        "per-topic rule. You are given ONE focus topic; cover ONLY it, in depth, by "
        "expanding it into these `##` subsections in order (omit any with no grounded "
        "content): `## Core Idea`, `## Prerequisites`, `## Main Formula Cluster`, "
        "`## Coordinate / Case Variants`, `## Conditions & Assumptions`, "
        "`## Problem-Solving Method` (numbered steps), `## Special Cases`, "
        "`## Common Traps`, `## Related Topics`. Label any formula that holds only for "
        "one exercise setup as **Example-specific** — never present it as a general "
        "rule. Do not drift into unrelated course topics."
    ),
}


# ── Subject-type detection + reference (non-formula) template ─────────────────
#
# The generator above was built for formula-heavy mechanics: it forces a
# formula-cluster shape onto every section and the quality gate FAILS any
# section without formulas. That is exactly wrong for memorization / process
# subjects — Fertigungstechnik, Werkstoffkunde, Biologie, Jura — where the
# student needs definitions, classifications, comparison tables, advantages /
# disadvantages, typical defects, selection rules and exam memory cues, NOT
# invented formulas. So before generation we CLASSIFY the subject from its OWN
# retrieved evidence (data-driven, not a hardcoded course list) and route
# non-formula subjects to a reference template with a reference-shaped gate.

_SUBJECT_TYPES = (
    "formula_heavy",
    "vocabulary_memorization",
    "process_comparison",
    "engineering_design",
    "conceptual_theory",
    "proof_theory",
    "mixed",
)
# Which detected types keep the original formula-first pipeline. Everything else
# uses the reference template (definitions / tables / Merken), never formulas.
# ``engineering_design`` (Grundlagen des Konstruierens, Maschinenelemente) is
# deliberately NOT formula-driven: it is a design-decision sheet that may carry a
# few grounded strength formulas but must NOT be forced into a formula-cluster
# shape, and must NEVER get the mechanics taxonomy. It uses its own template.
_FORMULA_DRIVEN_TYPES = frozenset({"formula_heavy", "mixed"})

# Engineering-design / machine-element vocabulary. These courses mix a little math
# (Festigkeitsnachweis) with design methodology, standards, tolerances and machine
# elements, so they read neither as a pure formula sheet nor as pure memorization.
# Detection is data-driven from the student's OWN evidence, like every other type.
_DESIGN_KEYWORDS = (
    "konstru", "gestalt", "toleranz", "passung", "grundabma", "welle", "nabe",
    "lager", "getriebe", "verzahnung", "schnappverbind", "maschinenelement",
    "festigkeitsnachweis", "anforderungsliste", "funktionsstruktur", "morpholog",
    "bewertung", "fügen", "fuegen", "niet", "schraubverbind", "schweißverbind",
    "oberflächenbesch", "oberflaechenbesch", "beanspruchung", "steifigkeit",
    "wälzlager", "waelzlager", "gleitlager", "schmierung", "tribolog",
    "din en iso", "machine element", "shaft", "bearing", "gearbox", "tolerance fit",
)
# A stricter subset whose presence signals a genuine design course (not just a
# stray mention). ``engineering_design`` requires >= 2 DISTINCT core terms.
_DESIGN_CORE = (
    "konstru", "toleranz", "passung", "welle", "nabe", "maschinenelement",
    "gestalt", "anforderungsliste", "funktionsstruktur", "getriebe", "wälzlager",
    "waelzlager", "gleitlager", "schnappverbind", "festigkeitsnachweis", "verzahnung",
)

# A line counts as "math" only on a STRONG token: an equals sign, a LaTeX math
# command, a super/subscript on a letter, or a Greek letter. Deliberately NOT
# bare +/-/* (German prose is full of hyphens and bullet dashes), so plain
# definition/process text does not register as formulas.
_CORPUS_FORMULA_RE = re.compile(
    r"\\frac|\\int|\\sum|\\sqrt|\\cdot|\\times|\\partial|\\Theta|\\omega|"
    r"[=<>≤≥]|[A-Za-z]\^|[A-Za-z]_\{?\w|[Α-Ωα-ω]"
)
# Substring signals (lowercased corpus). German first, English equivalents next.
_PROCESS_KEYWORDS = (
    "vorteil", "nachteil", "verfahren", "prozess", "geeignet", "anwendung",
    "werkstoff", "eigenschaft", "fehler", "defekt", "serie", "guss", "schwei",
    "umform", "urform", "zerspan", "advantage", "disadvantage", "process",
    "suitable", "application", "defect", "tooling", "workpiece",
)
_VOCAB_KEYWORDS = (
    "definition", "bedeutet", "bezeichnet", "begriff", "einordnung", "klassifik",
    "einteilung", "kategorie", "unterscheid", "abgrenzung", "din ", "means ",
    "refers to", "defined as", "classification", "category", "terminology",
)
_PROOF_KEYWORDS = (
    "beweis", "theorem", "satz ", "lemma", "korollar", "proof", "corollary",
    "q.e.d", "genau dann", "if and only if", "induktion", "induction",
    "automat", "turing", "komplexit", "decidab", "entscheidbar",
)


def _line_is_formula(line: str) -> bool:
    """True if a source line reads as a formula, not prose. A strong math token
    must be present AND the line must not be a long prose sentence."""
    if not _CORPUS_FORMULA_RE.search(line):
        return False
    # A long, word-dense line that merely contains an '=' (e.g. a definition
    # "Wirkungsgrad = Nutzen / Aufwand" written as prose) is not a formula line.
    words = re.findall(r"[A-Za-zÄÖÜäöüß]{3,}", line)
    return not (len(words) >= 8 and len(line) > 90)


def classify_subject_type(
    evidence: list[dict[str, Any]],
    topic_names: "list[str | None]" = (),
) -> str:
    """Classify the course's subject type from its retrieved evidence.

    Returns one of ``_SUBJECT_TYPES``. The decisive signal is the formula
    density of the student's OWN source text: a real formula sheet has many
    equation lines; a Fertigungstechnik script has almost none and instead
    talks about Verfahren / Vorteile / Nachteile. Defaults to ``formula_heavy``
    on empty evidence so behaviour is unchanged when there is nothing to judge.
    """
    # Strong prior: if the course topic map carries two or more UNAMBIGUOUS
    # mechanics topics, it is a mechanics formula course — trust that over a thin
    # evidence sample. Uses the strong needles (not the aggressive alias table) so
    # a design/standards course that merely says "Normalspannung"/"Reibung" is not
    # misread as mechanics.
    if _course_is_mechanics(topic_names or []):
        return "formula_heavy"

    corpus = " ".join((c.get("text") or "") for c in evidence)
    lines = [ln.strip() for ln in re.split(r"[\n;]+", corpus) if len(ln.strip()) >= 6]
    if not lines:
        return "formula_heavy"
    formula_lines = sum(1 for ln in lines if _line_is_formula(ln))
    formula_ratio = formula_lines / len(lines)
    low = corpus.lower()
    n_lines = len(lines)
    process_hits = sum(low.count(k) for k in _PROCESS_KEYWORDS)
    vocab_hits = sum(low.count(k) for k in _VOCAB_KEYWORDS)
    proof_hits = sum(low.count(k) for k in _PROOF_KEYWORDS)
    process_density = process_hits / n_lines
    vocab_density = vocab_hits / n_lines
    proof_density = proof_hits / n_lines
    design_hits = sum(low.count(k) for k in _DESIGN_KEYWORDS)
    design_density = design_hits / n_lines
    design_core_hits = sum(1 for k in _DESIGN_CORE if k in low)

    # Engineering design / machine elements (GdK, Maschinenelemente). Checked
    # BEFORE the formula branch: these courses DO carry strength formulas, so the
    # formula gate would otherwise mislabel them formula_heavy and route them into
    # the mechanics pipeline. The signal is design/machine-element vocabulary that
    # DOMINATES — several distinct core terms AND a design density clearly above the
    # process/vocab densities. The dominance test is essential: a manufacturing
    # course (Fertigungstechnik) also mentions Toleranz/Welle in passing but is
    # overwhelmingly process vocabulary, so it must stay process_comparison.
    if (
        design_core_hits >= 3
        and design_density >= 0.5
        and design_density >= 2 * process_density
        and design_density >= 2 * vocab_density
    ):
        return "engineering_design"

    # Strong, broad formula presence → formula-driven. A subject with BOTH heavy
    # formulas and heavy process/vocab vocabulary (e.g. Thermodynamik) is "mixed"
    # — still formula-driven, but the label is recorded for diagnostics.
    if formula_ratio >= 0.18 and formula_lines >= 5:
        if process_density >= 0.5 or vocab_density >= 0.5:
            return "mixed"
        return "formula_heavy"

    # Low formula density → a reference subject. Pick the best-fit shape.
    if proof_density >= 0.4 and proof_hits >= 3 and proof_density >= process_density:
        return "proof_theory"
    if process_density >= 0.25 and process_density >= vocab_density:
        return "process_comparison"
    if vocab_density >= 0.15 or vocab_hits >= 3:
        return "vocabulary_memorization"
    # Some formulas but not dominant, and no strong vocab/process signal → treat
    # as conceptual theory (reference template, no forced formulas).
    if formula_ratio >= 0.08:
        return "conceptual_theory"
    return "vocabulary_memorization"


def _resolve_subject_type(
    cfg: dict[str, Any],
    evidence: list[dict[str, Any]],
    topics: "list[str | None]",
) -> str:
    """Honour an explicit ``subjectType`` setting; otherwise auto-detect."""
    forced = str(cfg.get("subjectType") or "auto")
    if forced != "auto" and forced in _SUBJECT_TYPES:
        return forced
    return classify_subject_type(evidence, topics)


# Reference (non-formula) section writer. Mirrors _SECTION_SYSTEM's contract
# (one `## <name>` per `### TOPIC:` block, emphasis markers, JSON envelope) but
# the section SHAPE is memory/comparison, never formula clusters. Labels are
# given bilingually so the model uses the German labels for a German course.
_SECTION_SYSTEM_REFERENCE = (
    "You are ExamForge by Minallo, writing PART of a DENSE, exam-ready CHEATSHEET "
    "from a student's own course materials. This is a MEMORIZATION / REFERENCE "
    "subject (manufacturing, materials, biology, law, theory) — NOT a formula "
    "subject. Do NOT force formulas. The student needs definitions, "
    "classifications, comparisons, advantages/disadvantages, typical defects, "
    "selection rules and exam memory cues.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Never invent facts or formulas.\n"
    "\n"
    "OUTPUT: for each `### TOPIC: <name>` block in the context, write EXACTLY one "
    "`## <name>` section, in the same order. Output ONLY these sections — no "
    "document title, no introduction, no `## Sources` list, no closing remarks.\n"
    "\n"
    "EACH section is a tight, scannable memory block. Use these bold-lead-in "
    "labels IN THE SOURCE LANGUAGE (for a German course use the German label), "
    "omitting any label with no grounded content — never write a label with an "
    "empty or `N/A` body:\n"
    "- **Kurzdefinition:** one-line definition / core idea.\n"
    "- **Einordnung:** where it sits in the classification / process family.\n"
    "- **Geeignet für:** typical use case / application.\n"
    "- **Vorteile:** bullets (for a process/method).\n"
    "- **Nachteile:** bullets (for a process/method).\n"
    "- **Typische Fehler:** common defects / mistakes (for a process).\n"
    "- **Abgrenzung:** how it differs from an easily-confused neighbour.\n"
    "- **Merken:** ONE short, punchy exam memory cue.\n"
    "- **Prüfungsfalle:** ONE precise, subject-specific exam trap.\n"
    "\n"
    "VARY THE BLOCK TYPE — do NOT make every section an identical "
    "Geeignet/Vorteile/Nachteile list; that is flat and unmemorable. Match the "
    "block to the topic:\n"
    "- a CATEGORY / FAMILY / overview topic whose evidence names 3+ members "
    "(casting methods, the DIN main groups, joining methods) → a COMPARISON or "
    "CLASSIFICATION TABLE listing the members as rows. If the evidence lists "
    "several members, you MUST use a table, not prose.\n"
    "- a single concrete process → a compact card (Geeignet für / Vorteile / "
    "Nachteile / Typische Fehler) capped with a **Merken:** cue.\n"
    "- two easily-confused terms → an **Abgrenzung:** contrast line.\n"
    "\n"
    "COMPARISON TABLES — THE MOST VALUABLE FORMAT here. When a topic's evidence "
    "describes several items (casting methods, joining methods, material classes), "
    "render a compact markdown table instead of repeated prose, e.g.:\n"
    "| Verfahren | Geeignet für | Vorteile | Nachteile | Typische Fehler |\n"
    "|---|---|---|---|---|\n"
    "A classification topic (e.g. Fertigungsverfahren nach DIN 8580) → a "
    "classification table (group | meaning | examples). KEEP CELLS SHORT — a few "
    "words each; the table must fit the page width, so never write a full sentence "
    "in a cell.\n"
    "\n"
    "RESPECT THE CLASSIFICATION HIERARCHY — never list sibling categories as "
    "members of one another. In manufacturing the SIX DIN 8580 main groups are "
    "PEERS: Urformen, Umformen, Trennen, Fügen, Beschichten, Stoffeigenschaften "
    "ändern. So an `## Urformen` section lists only ITS OWN examples (Gießen, "
    "Sintern) — NEVER put Umformen or Beschichten as rows inside the Urformen "
    "table. The full six-group table belongs only under the DIN 8580 / "
    "Fertigungsverfahren overview topic.\n"
    "\n"
    "ABGRENZUNG + MERKEN ARE HIGH-VALUE — for memorization subjects these are the "
    "most useful blocks, so include them whenever the context supports them. When "
    "sibling categories are easily confused, add a one-line Abgrenzung contrast "
    "(e.g. 'Urformen schafft Stoffzusammenhalt, Umformen erhält ihn, Trennen "
    "vermindert ihn, Fügen verbindet Teile'), or a small 2-column Abgrenzung table "
    "(Begriff | Bedeutung) for the most-confused pair in the section. End most "
    "process sections with a compact **Merken:** cue that fuses the 2-3 facts a "
    "student must recall (e.g. 'Druckguss = Großserie + hohe Werkzeugkosten + hohe "
    "Maßgenauigkeit'; 'Sandguss = flexibel + günstig + große Teile, aber "
    "schlechtere Oberfläche').\n"
    "\n"
    "PROCESS-SELECTION — for a classification/overview topic, ALSO add a compact "
    "'Verfahren wählen' selection table (Ziel/Aufgabe | Geeignetes Verfahren) when "
    "the evidence supports it — it is one of the highest-yield exam aids.\n"
    "\n"
    "HARD RULES:\n"
    "- NEVER write a `Formula cluster` heading/label, and NEVER write `N/A`. Only "
    "include a formula if the context genuinely has one for the topic, inline as "
    "$...$ (e.g. the Taylor cutting model); otherwise omit formulas entirely.\n"
    "- Traps and Merken must be CONCRETE and subject-specific (e.g. 'Druckguss "
    "lohnt wegen hoher Werkzeugkosten nicht für Kleinserien'), never generic "
    "('wrong choice can cause defects', 'pay attention to quality').\n"
    "- For every process, prefer to give its Vorteile, Nachteile and Typische "
    "Fehler — these are exactly the exam-relevant facts.\n"
    "- Keep each line tight; prefer tables and bullets over paragraphs. Match the "
    "language of the source material consistently — do not mix English structural "
    "labels into German content.\n"
    "- NEVER use emoji or icon characters (⏳, ✅, ❌, 🔧, 🟢 …) — this is an "
    "academic PDF; use plain `-` bullets only.\n"
    "\n"
    "OMIT WEAK SECTIONS — if a topic has no grounded definition or facts you can "
    "state cleanly, DROP its `## ` section rather than padding it.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact of a block in ==double equals== "
    "(yellow). Write `==text==` with NO inner spaces and TWO equals each side. At "
    "most one per block.\n"
    "- Begin a hard warning with `Important:` or `Critical:` (red).\n"
    "- Begin a soft remark with `Note:` (orange).\n"
    "- Wrap a key concept term in {{double braces}} (blue); use sparingly.\n"
    "\n"
    'Return ONLY JSON: {"text":"<markdown for these sections only>"}'
)

# Per-preset section-format override for REFERENCE subjects (mirrors
# _PRESET_SECTION_FORMAT, but memory/comparison-shaped). Injected LAST so it
# beats the generic reference contract. Markers are kept distinct per preset.
_PRESET_SECTION_FORMAT_REFERENCE = {
    "exam_night": (
        "\n\nREFERENCE EXAM NIGHT FORMAT — OVERRIDES the section shape. A one-page "
        "emergency MEMORY sheet of only what a student would FORGET. Each "
        "`## <name>` section:\n"
        "- **Merken:** the single highest-yield memory cue (one line).\n"
        "- **Prüfungsfalle:** the nastiest, most exam-specific trap.\n"
        "- a compact comparison table ONLY when it captures several items at once.\n"
        "Drop low-yield topics and anything obvious. No prose, no full definitions."
    ),
    "open_book_exam": (
        "\n\nREFERENCE OPEN-BOOK FORMAT — OVERRIDES the section shape. A fast-lookup "
        "SELECTION tool. Each `## <name>` section, with these exact bold labels in "
        "order (omit one only when nothing grounded fits):\n"
        "- **Geeignet für:** the use case / when to pick this (most important line).\n"
        "- **Vorteile:** short bullets.\n"
        "- **Nachteile:** short bullets.\n"
        "- **Prüfungsfalle:** the selection/exam trap.\n"
        "Prefer a comparison table when several processes share a decision."
    ),
    "formula_reference": (
        "\n\nREFERENCE QUICK-REFERENCE FORMAT — OVERRIDES the section shape. The "
        "DENSEST reference: maximum facts, minimum prose. Lead with comparison and "
        "classification TABLES wherever the context supports them; otherwise terse "
        "`- **Begriff:** Bedeutung` definition bullets. Add a one-line **Merken** "
        "per block. No paragraphs."
    ),
    "balanced": (
        "\n\nREFERENCE BALANCED FORMAT — OVERRIDES the section shape. Each "
        "`## <name>` section:\n"
        "- **Kurzdefinition:** one line.\n"
        "- **Einordnung** / **Geeignet für:** one line each when relevant.\n"
        "- **Vorteile** / **Nachteile:** short bullets for processes.\n"
        "- **Merken:** one memory cue.\n"
        "- **Prüfungsfalle:** one concrete trap.\n"
        "Use a comparison table when several items are compared."
    ),
    "deep_revision": (
        "\n\nREFERENCE DEEP-REVISION FORMAT — OVERRIDES the section shape. Deeper "
        "but still compact. Each `## <name>` section:\n"
        "- **Kurzdefinition** and **Einordnung.**\n"
        "- **Geeignet für**, **Vorteile**, **Nachteile.**\n"
        "- **Typische Fehler:** defects and their cause.\n"
        "- **Abgrenzung:** the most-confused neighbour.\n"
        "- **Merken** and **Prüfungsfalle.**\n"
        "Use classification/comparison tables for process families."
    ),
    "topic_mastery": (
        "\n\nREFERENCE TOPIC-MASTERY FORMAT — OVERRIDES the section shape AND the "
        "one-section-per-topic rule. You are given ONE focus topic; cover ONLY it, "
        "in depth, expanding it into these `##` subsections in order (omit any with "
        "no grounded content): `## Kurzdefinition`, `## Einordnung`, "
        "`## Varianten / Verfahren` (a comparison table), `## Vorteile & Nachteile`, "
        "`## Typische Fehler`, `## Auswahlregeln`, `## Abgrenzung`, `## Merksätze`, "
        "`## Prüfungsfallen`. Do not drift into unrelated course topics."
    ),
}


# ── Engineering-design / machine-elements section writer ─────────────────────
#
# Grundlagen des Konstruierens / Maschinenelemente are NEITHER a pure formula
# sheet NOR pure memorization: the student needs design-decision rules, selection
# criteria, standards (DIN/ISO tolerances, fits), machine-element variants AND a
# few grounded strength formulas (Festigkeitsnachweis). So this writer produces a
# mixed design-decision card: definition → when to use → selection criteria →
# rules → formulas ONLY if grounded → variants → pros/cons → trap. It must NEVER
# pull in unrelated mechanics-coordinate sections (that is the mechanics path).
_SECTION_SYSTEM_DESIGN = (
    "You are ExamForge by Minallo, writing PART of a DENSE, exam-ready CHEATSHEET "
    "from a student's own course materials. This is an ENGINEERING-DESIGN / "
    "MACHINE-ELEMENTS subject (Grundlagen des Konstruierens, Maschinenelemente, "
    "Konstruktionslehre): a DESIGN-DECISION sheet — design methodology, selection "
    "rules, standards (tolerances/fits), machine-element variants, and ONLY the "
    "strength formulas the material actually states. It is NOT a kinematics "
    "formula sheet and NOT pure vocabulary.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Never invent facts or formulas.\n"
    "\n"
    "OUTPUT: for each `### TOPIC: <name>` block in the context, write EXACTLY one "
    "`## <name>` section, in the same order. Output ONLY these sections — no "
    "document title, no introduction, no `## Sources` list, no closing remarks.\n"
    "\n"
    "EACH section is a tight, scannable design card. Use these bold-lead-in labels "
    "IN THE SOURCE LANGUAGE (German label for a German course), omitting any label "
    "with no grounded content — never write a label with an empty or `N/A` body:\n"
    "- **Kurzdefinition:** one-line definition / core idea.\n"
    "- **Anwenden bei:** when this method / element / rule is used.\n"
    "- **Auswahlkriterien:** the criteria that drive the design choice.\n"
    "- **Wichtige Regeln:** the key design / dimensioning / standards rules.\n"
    "- **Formeln:** ONLY grounded strength/dimensioning formulas, inline as $...$ "
    "with each symbol named once. If the topic has no formula in the context, OMIT "
    "this label entirely — do NOT invent one and do NOT write a kinematics formula.\n"
    "- **Varianten / Arten:** the types/variants (prefer a compact table when the "
    "evidence names 3+).\n"
    "- **Vorteile / Nachteile:** short bullets where relevant.\n"
    "- **Prüfungsfalle:** ONE precise, subject-specific exam trap.\n"
    "\n"
    "USE TABLES for the high-value design comparisons when the evidence supports "
    "them — Passungsarten (Spiel-/Übergangs-/Presspassung), Welle-Nabe-Verbindung "
    "types, Lagerarten (Wälz- vs Gleitlager), Getriebe/Verzahnungsarten, "
    "Konstruktionsphasen, Bewertungsmethoden, Schnappverbindungstypen. KEEP CELLS "
    "SHORT (a few words) so the table fits the column width; never write a full "
    "sentence in a cell, never clip a cell.\n"
    "\n"
    "HARD RULES:\n"
    "- NEVER emit a kinematics / mechanics-coordinate section (Tangential- und "
    "Normalkoordinaten, Reibung und Widerstand as a drag law, Wurfbewegung, "
    "Impuls/Stoß, Drehimpuls) unless the COURSE CONTEXT for THIS topic genuinely "
    "centres on it — those belong to a mechanics course, not a design sheet.\n"
    "- Write formulas ONLY inside $...$; NEVER emit a raw LaTeX table, a "
    "`\\begin{...}` / `cases` / `array` environment, `\\text{...}`, `&` column "
    "separators or `\\\\` row breaks — use a real markdown `| … |` table instead.\n"
    "- Traps and rules must be CONCRETE and subject-specific (e.g. 'Presspassung: "
    "Übermaß sichert Drehmoment, aber erschwert Montage'), never generic.\n"
    "- Match the language of the source material; do not mix English labels into "
    "German content. NEVER use emoji or icon characters.\n"
    "\n"
    "OMIT WEAK SECTIONS — if a topic has no grounded definition, rule or fact you "
    "can state cleanly, DROP its `## ` section rather than padding it.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact of a block in ==double equals== "
    "(yellow). Write `==text==` with NO inner spaces and TWO equals each side. At "
    "most one per block.\n"
    "- Begin a hard warning with `Important:` or `Critical:` (red).\n"
    "- Begin a soft remark with `Note:` (orange).\n"
    "- Wrap a key concept term in {{double braces}} (blue); use sparingly.\n"
    "\n"
    'Return ONLY JSON: {"text":"<markdown for these sections only>"}'
)

# Per-preset overrides for the design writer. Kept light — the base design card
# already carries the shape — and falls back to the reference formats for modes
# not listed here (see _shard_system_prompt).
_PRESET_SECTION_FORMAT_DESIGN = {
    "exam_night": (
        "\n\nDESIGN EXAM-NIGHT FORMAT — OVERRIDES the section shape. A one-page "
        "emergency sheet of only what a student would FORGET. Each `## <name>` "
        "section: the decisive **Auswahlkriterien** / **Wichtige Regeln** (one "
        "line), any grounded **Formel** inline $...$, and one **Prüfungsfalle**. "
        "Drop low-yield topics and anything obvious. No prose."
    ),
    "formula_reference": (
        "\n\nDESIGN QUICK-REFERENCE FORMAT — OVERRIDES the section shape. Lead with "
        "the grounded **Formeln** ($...$, variables named) and the selection / "
        "standards TABLES (Passungen, Welle-Nabe, Lager, Getriebe). Terse rule "
        "bullets only; no prose paragraphs. Never invent a formula to fill space."
    ),
    "open_book_exam": (
        "\n\nDESIGN OPEN-BOOK FORMAT — OVERRIDES the section shape. A fast-lookup "
        "DECISION tool. Each `## <name>` section, with these exact bold labels in "
        "order (omit one only when nothing grounded fits): **Anwenden bei:**, "
        "**Auswahlkriterien:**, **Varianten / Arten:** (a table when 3+), "
        "**Prüfungsfalle:**. Prefer a comparison table for a shared decision."
    ),
}


# Realistic topic density per PAGE for each preset — the scope cap is pages ×
# this. Open-book lookup cards and Deep-Revision blocks take more room (fewer per
# page); Exam Night and Formula Reference are dense (more per page).
_TOPICS_PER_PAGE = {
    "exam_night": 10,
    "open_book_exam": 6,
    "formula_reference": 8,
    "balanced": 7,
    "deep_revision": 5,
    "topic_mastery": 12,
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
    # Scope is bounded by PAGES, not by the preset's ambition: a 2-page sheet must
    # show fewer topics done perfectly, not 22 half-broken ones. Each preset has a
    # realistic topics-per-page density (lookup cards need more room than a dense
    # formula list); detail level nudges it. The gate then drops any section that
    # still comes out thin, so the final sheet is "fewer, clean" by construction.
    per_page = _TOPICS_PER_PAGE.get(preset, 8)
    base["topics"] = max(4, min(_MAX_TOPICS, pages * per_page + detail["topicDelta"]))

    lang = str(s.get("language") or "source").lower()
    if lang not in _VALID_LANGS:
        lang = "source"
    font = _FONT_TO_LAYOUT[font_size] or base["font"]

    # Subject type can be forced via settings; "auto" (the default) means detect
    # it from the evidence at generation time (see _resolve_subject_type). Until
    # then we assume the formula-driven pipeline so a directly-built cfg (tests,
    # callers that never reach generation) keeps the original behaviour.
    subject_type = str(s.get("subjectType") or "auto").lower()
    if subject_type != "auto" and subject_type not in _SUBJECT_TYPES:
        subject_type = "auto"

    return {
        "preset": preset,
        "subjectType": subject_type,
        "formulaDriven": subject_type == "auto" or subject_type in _FORMULA_DRIVEN_TYPES,
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

# Auto-wrap of bare formula lines: the per-preset formats sometimes make the model
# drop the $...$ delimiters, leaving a line of raw LaTeX that renders as plain
# text. A line is treated as a formula (and wrapped in $...$) when it carries a
# math token but is NOT prose — two consecutive ≥3-letter words signal prose and
# veto the wrap, so variable notes ("v: velocity") and sentences are left alone.
_BARE_LINE_RE = re.compile(r"^(\s*(?:[-*]\s+)?)(\S.*?)\s*$")
_MATH_TOKEN_RE = re.compile(r"\\[a-zA-Z]+|[=^_]")
_PROSE_RUN_RE = re.compile(r"[A-Za-z]{3,}\s+[A-Za-z]{3,}")
_NUMBERED_RE = re.compile(r"^\d+[.)]")
# A maximal run of inline LaTeX (a command, then adjacent commands / single
# letters / digits / operators / braced groups) that leaks into prose without
# $...$ — e.g. "v is not tangential unless \dot r = 0". Stops at a 2+ letter word.
_LATEX_FRAG_RE = re.compile(
    r"\\[a-zA-Z]+(?:[ \t]*(?:\\[a-zA-Z]+|[A-Za-z](?![A-Za-z])|[0-9]|[_^=+\-*/(),.]|\{[^}]*\}))*"
)
_MATH_SPAN_RE = re.compile(r"\$\$.+?\$\$|\$[^$\n]+?\$", re.S)


def _wrap_bare_formula_lines(text: str) -> str:
    out: list[str] = []
    for line in text.split("\n"):
        m = _BARE_LINE_RE.match(line)
        if not m:
            out.append(line)
            continue
        prefix, body = m.group(1), m.group(2)
        # Wrap only a CLEAN standalone formula: no existing math, no markdown
        # lead-in, no number prefix or `label:` (those mix prose + math), not prose.
        if (
            "$" in body
            or body[:2] == "**"
            or body[:1] in "#|>"
            or ":" in body
            or _NUMBERED_RE.match(body)
            or not _MATH_TOKEN_RE.search(body)
            or _PROSE_RUN_RE.search(body)
        ):
            out.append(line)
            continue
        out.append(f"{prefix}${body}$")
    return "\n".join(out)


def _wrap_inline_latex_fragments(text: str) -> str:
    """Wrap LaTeX command runs that leak into prose (outside any $...$) so they
    render as math. Existing $...$/$$...$$ spans are left untouched."""
    parts: list[str] = []
    last = 0
    for m in _MATH_SPAN_RE.finditer(text):
        parts.append(_LATEX_FRAG_RE.sub(lambda g: "$" + g.group(0) + "$", text[last:m.start()]))
        parts.append(m.group(0))
        last = m.end()
    parts.append(_LATEX_FRAG_RE.sub(lambda g: "$" + g.group(0) + "$", text[last:]))
    return "".join(parts)


# A mangled highlight closer: `==text!=` (the model wrote `!=` for the closing
# `==`). Repaired to `==text==`. Body has no `=`/newline so it can't span markers.
_BROKEN_HIGHLIGHT_RE = re.compile(r"==([^=\n]+?)!=")


def _repair_highlight_markers(text: str) -> str:
    """Repair/strip broken ==highlight== markers OUTSIDE math spans, per line, so
    a mangled or unpaired `==` never renders as literal text. Math spans (which
    may legitimately contain `==`/`!=`) are left untouched."""
    def _fix_segment(seg: str) -> str:
        seg = _BROKEN_HIGHLIGHT_RE.sub(r"==\1==", seg)
        # An odd count means one marker is unpaired → drop the last lone `==`.
        if seg.count("==") % 2 == 1:
            idx = seg.rfind("==")
            seg = seg[:idx] + seg[idx + 2:]
        return seg

    out: list[str] = []
    for line in text.split("\n"):
        parts: list[str] = []
        last = 0
        for m in _MATH_SPAN_RE.finditer(line):
            parts.append(_fix_segment(line[last:m.start()]))
            parts.append(m.group(0))
            last = m.end()
        parts.append(_fix_segment(line[last:]))
        out.append("".join(parts))
    return "\n".join(out)


# Emoji / pictographic icons the model sometimes uses as bullets (⏳ 🟢 ✅ ❌ 🔧
# 🕐). An academic PDF cheatsheet must be plain, so strip them (+ the emoji
# variation selector). Conservative ranges: pictographs/dingbats/symbols only —
# NOT arrows or general punctuation, which can be meaningful in prose.
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF"   # symbols & pictographs (incl. 🟢 🔧 🕐 supplemental)
    "\U00002600-\U000026FF"    # misc symbols (☀ ⚠ ⛔)
    "\U00002700-\U000027BF"    # dingbats (✅ ✂ ❌ ❗)
    "\U00002B00-\U00002BFF"    # arrows/stars block (⭐ ⬆)
    "\U000023E9-\U000023FA"    # media/clock controls (⏳ ⏰)
    "\U0001F1E6-\U0001F1FF"    # regional indicators (flags)
    "\U0000FE0F]"              # emoji variation selector
)


def _strip_emoji(text: str) -> str:
    return _EMOJI_RE.sub("", text or "")


def _strip_stray_carets(text: str) -> str:
    """Remove `^` that leaks OUTSIDE math spans (the model sometimes wraps prose
    as ``^text^`` attempting superscript, which renders as literal carets). A `^`
    inside a $...$ / $$...$$ span is valid superscript and is left untouched."""
    parts: list[str] = []
    last = 0
    for m in _MATH_SPAN_RE.finditer(text):
        parts.append(text[last:m.start()].replace("^", ""))
        parts.append(m.group(0))
        last = m.end()
    parts.append(text[last:].replace("^", ""))
    return "".join(parts)


# Raw-LaTeX-table / environment leak: when the model emits a `cases`/`array`
# environment (or a hand-built aligned table) WITHOUT a math wrapper, the body
# leaks onto the page as red raw LaTeX — observed in real output as
# "1.0 & \text{Vollwelle} \\ 2.0 bis 3.0 & \text{Torsion}". The legit `\text{…}`
# spans get math-wrapped by the fragment wrapper, but the `&` column separators
# and `\\` row breaks stay raw. We neutralize them to readable plain text so the
# page never shows raw LaTeX (a missing/plain row beats a red one).
_TEXT_CMD_RE = re.compile(r"\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}")
_ENV_CMD_RE = re.compile(r"\\(?:begin|end)\s*\{[^{}]*\}|\\hline\b")


def _clean_latex_text(seg: str) -> str:
    """Strip LaTeX table/environment scaffolding from an out-of-math text segment,
    turning it into readable plain text (`\\text{X}`→X, `&`→' — ', `\\\\`→' ',
    drop `\\begin/\\end`, bare commands and stray braces)."""
    s = _TEXT_CMD_RE.sub(lambda m: m.group(1), seg)
    s = _ENV_CMD_RE.sub("", s)
    s = s.replace("\\\\", " ")               # LaTeX row break
    s = re.sub(r"\\[a-zA-Z]+\*?", "", s)     # remaining bare commands (\nd, \quad)
    s = s.replace("&", " — ")                # column separator
    s = re.sub(r"[{}]", "", s)               # stray braces
    s = re.sub(r"\s*—\s*(?:—\s*)+", " — ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s


def _strip_raw_latex_outside_math(text: str) -> str:
    """Final backstop: neutralize any raw LaTeX that survived OUTSIDE the math
    spans (table/cases scaffolding, a leaked `\\begin{}`, a bare `\\nd`). Real
    `$...$` / `$$...$$` spans are left untouched. Only lines that actually carry a
    raw-LaTeX signal are rewritten, so a lone prose `&` ('R&D') is preserved."""
    out: list[str] = []
    for line in (text or "").split("\n"):
        residue = _strip_math_spans(line)
        if not (re.search(r"\\[a-zA-Z]", residue) or "\\\\" in residue or "\\text" in residue):
            out.append(line)
            continue
        parts: list[str] = []
        last = 0
        for m in _MATH_SPAN_RE.finditer(line):
            parts.append(_clean_latex_text(line[last:m.start()]))
            parts.append(m.group(0))
            last = m.end()
        parts.append(_clean_latex_text(line[last:]))
        out.append("".join(parts))
    return "\n".join(out)


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


# Source-label patterns. A `## Sources` block (heading line that is ONLY the
# sources keyword, through to the next heading); a `Source:`/`Quellen:` line; an
# inline `(file.pdf, p.25)` / `(p. 25)` citation (no `$` inside, so formulas are
# never touched); an echoed `[Source 3]` evidence tag.
_SRC_HEADING_RE = re.compile(
    r"(?ims)^#{1,6}[ \t]*(?:sources?|quellen|references|literatur)(?:[ \t]+used)?[ \t]*$.*?(?=^#{1,6}[ \t]|\Z)"
)
_SRC_LINE_RE = re.compile(r"(?im)^[ \t]*(?:sources?|quellen|references|literatur)[ \t]*:.*$")
_SRC_PAREN_RE = re.compile(
    r"[ \t]*\((?:[^()\n$]*?(?:p{1,2}\.?[ \t]*\d+|S\.[ \t]*\d+)[^()\n$]*?|"
    r"[^()\n$]*?\.(?:pdf|pptx?|docx?|md)[^()\n$]*?)\)",
    re.I,
)
_SRC_BRACKET_RE = re.compile(r"[ \t]*\[[ \t]*source[ \t]*\d+[^\]]*\]", re.I)
# Internal prompt scaffolding the model occasionally echoes as a heading. These
# are guidance labels, never real sections — drop the heading line. (`## Method
# Picker` is a real, wanted section and is deliberately NOT listed.)
_SCAFFOLD_HEADING_RE = re.compile(
    r"(?im)^#{1,6}[ \t]*(?:curated exam traps|expected formula priorities|"
    r"taxonomy[^\n]*|information architecture[^\n]*|spatial layout[^\n]*|"
    r"settings|course context|emphasis markers)[ \t]*:?[ \t]*$\n?"
)


# Any literal "formula omitted"/"not supported"/"unreadable" failure text that
# slipped in (from older output, evidence, or a mangled marker like
# "formulaomitted") — scrubbed so it can never render.
_OMITTED_TEXT_RE = re.compile(
    r"\*?\(?\s*formula\s*omitted[^)\n]*\)?\*?|\bformulaomitted\b", re.I
)
# A bullet/line left holding only a dropped formula: an empty bullet, or a bullet
# whose sole content was a bold label (`- **Velocity:**`) now that the formula is
# gone. Standalone label lines (`**Formulas:**`) are kept — they head real content.
_EMPTY_BULLET_RE = re.compile(r"(?m)^[ \t]*[-*][ \t]*(?:\*\*[^*\n]+\*\*[ \t]*:?[ \t]*)?$\n?")


def _tidy_emptied_lines(text: str) -> str:
    out = _OMITTED_TEXT_RE.sub("", text or "")
    out = _EMPTY_BULLET_RE.sub("", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out


def _strip_source_labels(text: str) -> str:
    out = _SRC_HEADING_RE.sub("", text or "")
    out = _SCAFFOLD_HEADING_RE.sub("", out)
    out = _SRC_LINE_RE.sub("", out)
    out = _SRC_PAREN_RE.sub("", out)
    out = _SRC_BRACKET_RE.sub("", out)
    # Trim bullets left empty once their only content (a citation) is gone.
    out = re.sub(r"(?m)^[ \t]*[-*][ \t]*$\n?", "", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


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
    # 1·-1) strip emoji/icon bullets — an academic PDF must look university-clean.
    cleaned = _strip_emoji(cleaned)

    # 1·0) strip any visible source labels. The sheet must stay clean and
    # uncluttered — grounding is internal-only — so a `## Sources` block, a
    # `Source:`/`Quellen:` line, an inline `(lecture.pdf, p.25)` citation, or an
    # echoed `[Source N]` tag never reaches the rendered/printed cheatsheet.
    cleaned = _strip_source_labels(cleaned)

    # 1a) normalise LaTeX math delimiters to the ``$``/``$$`` the renderer expects.
    # Models intermittently emit ``\(...\)`` / ``\[...\]`` (and OCR'd sources carry
    # them in), which KaTeX-in-markdown does NOT render — they leak as raw text.
    # Done before the odd-``$$`` trim so the converted delimiters balance correctly.
    cleaned = cleaned.replace("\\[", "$$").replace("\\]", "$$")
    cleaned = cleaned.replace("\\(", "$").replace("\\)", "$")

    # 1a·1) drop a lone `$` sitting on its own line. The model sometimes emits a
    # stray opening `$` (e.g. before a `$$` block); it makes the running `$` count
    # ODD, so KaTeX mis-pairs every following `$...$` and the whole block renders as
    # raw text. Removing it is what keeps formula blocks rendering.
    cleaned = re.sub(r"(?m)^[ \t]*\$[ \t]*$\n?", "", cleaned)

    # 1a·2) wrap bare formula lines (model dropped the $...$ under a preset format)
    # so they render as math, not raw text; then wrap LaTeX fragments that leak
    # into prose sentences (e.g. "\dot r" inside a Trap line).
    cleaned = _wrap_bare_formula_lines(cleaned)
    cleaned = _wrap_inline_latex_fragments(cleaned)

    # 1a·3) repair broken ==highlight== markers. The model intermittently mangles
    # the closing `==` (seen as `==text!=`) or leaves it unpaired; either way the
    # raw `==` leaks into the rendered text. Fix the mangled closer, then strip any
    # still-unpaired marker so it never renders literally.
    cleaned = _repair_highlight_markers(cleaned)

    # 1a·4) strip `^...^` carets that leak into prose (model attempts superscript
    # outside math, e.g. `^Hohe Genauigkeit^`); valid `^` inside $...$ is kept.
    cleaned = _strip_stray_carets(cleaned)

    # 1b) a salvaged (token-cap-truncated) sheet can end mid-formula, leaving a
    # dangling unterminated "$$" that would break KaTeX. If the display-delimiter
    # count is odd, drop everything from the last "$$" onward.
    if cleaned.count("$$") % 2 == 1:
        cleaned = cleaned[: cleaned.rfind("$$")].rstrip()

    # 2) malformed formulas: DROP them entirely. A failure marker must never reach
    # the sheet — a missing formula is fine, a printed "(formula omitted)" is not.
    dropped = 0

    def _display_repl(m: "re.Match[str]") -> str:
        nonlocal dropped
        normalized = normalize_formula_text(m.group(1))
        if normalized and _formula_body_ok(normalized):
            return "$$" + normalized + "$$"
        dropped += 1
        return ""

    def _inline_repl(m: "re.Match[str]") -> str:
        nonlocal dropped
        normalized = normalize_formula_text(m.group(1))
        if not normalized:
            dropped += 1
            return ""
        # A span whose whole body is a single unknown control word (e.g. "$\nd$")
        # is not real math — KaTeX renders it as a red error — so drop it instead
        # of letting it reach the page. Known symbols/operators (\theta, \frac, …)
        # are in _LATEX_WORDS and kept.
        lone = re.fullmatch(r"\\([a-zA-Z]+)", normalized.strip())
        if lone and lone.group(1).lower() not in _LATEX_WORDS:
            dropped += 1
            return ""
        return "$" + normalized + "$"

    cleaned = _DISPLAY_FORMULA_RE.sub(_display_repl, cleaned)
    cleaned = _INLINE_FORMULA_RE.sub(_inline_repl, cleaned)
    # Final raw-LaTeX backstop: neutralize table/cases scaffolding (`&`, `\\`,
    # `\text{}`) and any bare command still sitting OUTSIDE a math span, so no raw
    # red LaTeX reaches the rendered/printed sheet.
    cleaned = _strip_raw_latex_outside_math(cleaned)
    cleaned = _tidy_emptied_lines(cleaned)
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
        return ""

    out = _DISPLAY_FORMULA_RE.sub(_repl, text or "")
    return _tidy_emptied_lines(out), removed


# A whole bullet/line whose lead-in is the forced "Formula cluster" label, or
# whose body is just "N/A" — both are formula-template residue on a reference
# topic. Also a label line left with an N/A body (`**Vorteile:** N/A`).
_FORMULA_CLUSTER_LINE_RE = re.compile(
    r"(?im)^[ \t]*[-*]?[ \t]*\**[ \t]*formula\s+cluster\b.*$\n?"
)
_NA_LINE_RE = re.compile(
    r"(?im)^[ \t]*(?:[-*][ \t]*)?(?:\*\*[^*\n]+\*\*[ \t]*:?[ \t]*)?n/?a\.?[ \t]*$\n?"
)


def strip_reference_template_leaks(text: str) -> str:
    """Remove formula-template residue from a REFERENCE sheet: a forced "Formula
    cluster" label, an "N/A" body, and literal escaped newlines. Deterministic
    backstop behind the reference quality gate."""
    out = _LITERAL_NEWLINE_RE.sub("\n", text or "")
    out = _FORMULA_CLUSTER_LINE_RE.sub("", out)
    out = _NA_LINE_RE.sub("", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


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


def _strong_mechanics_hits(names: "list[str | None]") -> int:
    """How many of ``names`` carry an UNAMBIGUOUS mechanics word (word-start
    match, like the alias resolver). Used to decide if the mechanics taxonomy
    should run for this course at all."""
    n = 0
    for raw in names:
        if not raw:
            continue
        key = _topic_key(str(raw))
        if not key:
            continue
        padded = " " + key
        if any(" " + ndl in padded for ndl in _MECHANICS_STRONG_NEEDLES):
            n += 1
    return n


def _course_is_mechanics(names: "list[str | None]") -> bool:
    """True if the course is genuinely mechanics — only then do we apply the
    aggressive mechanics aliasing, formula/trap banks, layout map and method
    picker. Everything else (incl. engineering-design courses that mention
    Normalspannung / Reibung) keeps its real topic names."""
    return _strong_mechanics_hits(names) >= 2


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


# Manufacturing classification topics the extractor splits into several near-
# duplicate skeleton entries ("DIN 8580", "Fertigungsverfahren", "Fertigungs-
# verfahren nach DIN 8580", "Hauptgruppen der Fertigungsverfahren"). They all
# generate the SAME six-group classification table, so the sheet carried the DIN
# table 2-3 times and the extra copy stranded a near-empty page. Collapse them to
# ONE canonical backbone topic, ordered first (DIN 8580 is the spine of the subject).
_DIN_CLASSIFICATION_CANONICAL = "Fertigungsverfahren nach DIN 8580"
_DIN_OVERVIEW_KEYS = frozenset({
    "fertigungsverfahren",
    "hauptgruppen der fertigungsverfahren",
    "fertigungsverfahren hauptgruppen",
    "ueberblick fertigungsverfahren",
    "fertigungsverfahren nach din 8580",
})


def _canonical_classification_topic(name: str) -> str:
    key = _topic_key(name)
    if not key:
        return name
    # Any "DIN 8580" topic, or the generic "Fertigungsverfahren" overview — but
    # NOT a specific family like "Gießverfahren"/"Umformverfahren" (those have a
    # qualifier and are real, distinct sections).
    if "din 8580" in key or "din8580" in key or key in _DIN_OVERVIEW_KEYS:
        return _DIN_CLASSIFICATION_CANONICAL
    return name


def _dedupe_topic_names(names: list[str], *, mechanics: bool = True) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        # Mechanics aliasing only for genuine mechanics courses — otherwise a
        # design/standards course's "Normalspannung"/"Reibung" topics would be
        # rewritten into mechanics section titles. Manufacturing DIN 8580
        # collapsing and mojibake repair still apply to every course.
        base = _canonical_mechanics_topic(name) if mechanics else repair_mojibake(name).strip()
        canonical = _canonical_classification_topic(base)
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

    def _rank(name: str) -> int:
        # DIN 8580 classification is the backbone of a manufacturing sheet → first.
        if name == _DIN_CLASSIFICATION_CANONICAL:
            return -1
        return mechanics_rank.get(name, len(mechanics_rank))

    indexed = list(enumerate(out))
    indexed.sort(key=lambda item: (_rank(item[1]), item[0]))
    return [name for _, name in indexed]


def _topic_names(
    topic_map: list[dict[str, Any]],
    topic_focus: str | None,
    limit: int = _MAX_TOPICS,
    *,
    mechanics: bool = True,
) -> list[str | None]:
    if topic_focus:
        canon = _canonical_mechanics_topic(topic_focus) if mechanics else repair_mojibake(topic_focus).strip()
        return [canon]
    names = [t.get("name") for t in (topic_map or []) if t.get("name")]
    names = _dedupe_topic_names([str(n) for n in names], mechanics=mechanics)
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
        lines.append(f"- {canonical}: " + "; ".join(formulas[:6]))
    if not lines:
        return ""
    return (
        "\n\nCANONICAL FORMULAS PER TOPIC — these formulas BELONG to the named topic. "
        "Put each in THAT section and nowhere else, and prefer them as the core of the "
        "section when the COURSE CONTEXT supports them (it normally does). Do NOT fill a "
        "topic with another topic's formulas (e.g. never put constant-acceleration "
        "formulas under Kartesische Koordinaten):\n"
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
    # The Method Picker is a method-SELECTION aid — central to Open-book/Exam-night,
    # but noise in Formula Reference (pure formulas) and Topic Mastery (one topic).
    if not mechanics_hits or cfg.get("preset") in ("topic_mastery", "formula_reference"):
        return ""
    return (
        "\n\nMETHOD PICKER — ALWAYS make this the FIRST `## Method Picker` section, "
        "rendered as a real markdown table (keep only the rows whose topics appear "
        "in the context):\n"
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
    """Per-shard system prompt: the comprehensive section writer + settings.

    The base writer and per-preset section format switch on the detected subject
    type: formula-driven subjects keep the formula-first contract; everything
    else uses the reference (definition/classification/comparison/Merken) one.
    """
    formula_driven = cfg.get("formulaDriven", True)
    if cfg.get("subjectType") == "engineering_design":
        # Design subjects get their own card; modes not in the design override fall
        # back to the reference formats (memory/comparison shaped, which suit the
        # non-formula design topics well enough).
        base = _SECTION_SYSTEM_DESIGN
        formats = {**_PRESET_SECTION_FORMAT_REFERENCE, **_PRESET_SECTION_FORMAT_DESIGN}
    elif formula_driven:
        base = _SECTION_SYSTEM
        formats = _PRESET_SECTION_FORMAT
    else:
        base = _SECTION_SYSTEM_REFERENCE
        formats = _PRESET_SECTION_FORMAT_REFERENCE
    prompt = (
        base
        + "\n\nSETTINGS:\n"
        + f"- {cfg['langInstruction']}\n"
        + f"- Visual style: {cfg['style']}; keep each line compact for a "
        f"{cfg['columns']}-column sheet.\n"
        + f"- {cfg['purposeInstruction']}"
    )
    prompt += formats.get(str(cfg.get("preset")), "")
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
    corrective: str = "",
) -> "LlmResult | None":
    """Generate the `##` sections for one shard's worth of topics. Thread-safe.

    ``corrective`` is the quality-gate feedback appended on a regeneration pass.
    """
    topics = [label for label, _ in group]
    # ``qualityRepair`` is the Stage-5 whole-document repair instruction; it rides
    # on cfg so it is appended to EVERY shard on the single document-repair pass.
    system = (
        _shard_system_prompt(cfg, topics, with_method_picker=with_method_picker)
        + str(cfg.get("qualityRepair") or "")
        + corrective
    )
    # The formula/trap banks are mechanics-specific; they only help (and only
    # match) formula-driven courses. For reference subjects they no-op anyway,
    # so skip them to keep the prompt clean.
    banks = ""
    if cfg.get("formulaDriven", True) and cfg.get("mechanics", True):
        banks = (
            _formula_bank_guidance([str(t) for t in topics])
            + _trap_guidance([str(t) for t in topics])
        )
    understanding = str(cfg.get("understanding") or "")
    user = (
        (understanding + "\n\n" if understanding else "")
        + "COURSE CONTEXT:\n\n" + _format_section_evidence(group, doc_names) + banks
    )
    try:
        return chat_json(
            system=system, user=user,
            max_tokens=_PER_SHARD_MAX_TOKENS, salvage_key="text",
        )
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet section shard failed (topics=%s)", topics)
        return None


# ── Per-preset quality gate + auto-regeneration ──────────────────────────────
#
# After the parallel pass we score each shard's output against the preset's
# requirements. Only shards that FAIL are regenerated (once, in parallel) with
# corrective feedback — so the extra cost is ~one more shard round at most, which
# keeps the sheet inside the upstream timeout. Deterministic defects (broken
# math, raw-markdown tables, source labels, corrupted symbols) are already
# repaired by sanitize, so the gate targets CONTENT defects a retry can fix.

# Labels a preset's format makes mandatory in (nearly) every section.
_PRESET_REQUIRED_LABEL = {
    "open_book_exam": "use when",
    "deep_revision": "why it matters",
}


def _count_renderable_formulas(text: str) -> int:
    """Formula count after the same bare-line / inline-fragment wrapping sanitize
    applies, so a shard that emitted bare LaTeX isn't scored as formula-free."""
    return _formula_count(_wrap_inline_latex_fragments(_wrap_bare_formula_lines(text or "")))


# ── Formula-bank enforcement + broken-formula gate (Stage 4b) ──────────────────
#
# The model intermittently writes a KNOWN formula as broken prose that renders as
# raw/red LaTeX or as literal italic letters rather than real math:
#   * the English operator WORD instead of the command — "sumM_A" (\sum),
#     "integral r^2 dm" (\int);
#   * a bare LaTeX command left OUTSIDE $...$ — "L_A = \theta" in plain text;
#   * an accent glued to its letter — "Fdvecr" (\vec F \cdot d\vec r).
# For the mechanics topics we have a canonical bank for, this is fully
# recoverable: a gate fails any shard still carrying breakage (so it regenerates
# first), and a deterministic backstop rewrites the section's formulas to the
# canonical set. Only known mechanics topics are touched; everything else is left
# exactly as the model wrote it.

# An English math-operator word glued to a formula ("sumM_A", "integral r"), or an
# accent glued to a single trailing letter ("vecr"/"dvecr"). NOT preceded by a
# letter/backslash, so "\sum"/"\vec" (correct) and "vector" (English) never match.
_PROSE_MATH_WORD_RE = re.compile(
    r"(?<![A-Za-z\\])(?:sum|integral)(?=[A-Za-z]*[_^=\d²³]|[ ]?[A-Za-z]\b)"
    r"|(?<![A-Za-z\\])d?vec(?=[a-z](?![a-z]))"
)
# A command stripped of its backslash and GLUED into letters — survives even inside
# a $...$ span (so it renders as italic letters, not the operator): an accent
# "…vecr" or an operator word "sumM"/"integralr²". Tightened so English words
# ("vector", "summary", "integration", "Summe") do NOT match.
_MANGLED_LATEX_RE = re.compile(
    r"[A-Za-z]vec[a-z](?![a-z])"
    r"|(?<![A-Za-z\\])(?:sum|integral)(?=[A-Z]|[a-z]*[_^\d²³])"
)
# A line "looks like a formula" (so a prose word on it is suspicious) if it carries
# an equals/sub/superscript or a backslash command.
_FORMULA_CONTEXT_RE = re.compile(r"[=_^]|\\[a-zA-Z]")
_GREEK_LETTER_RE = re.compile(r"[Α-ω]")
_LATEX_CMD_RE = re.compile(r"\\[a-zA-Z]{2,}")
_FORMULA_LABEL_RE = re.compile(r"(?im)^\s*\*{0,2}\s*(?:formulas?|formeln?|formula\s+cluster)\b.*$")
_SECTION_SPLIT_RE = re.compile(r"(?m)^(#{1,6}[ \t]+.*)$")


def _strip_math_spans(text: str) -> str:
    return _MATH_SPAN_RE.sub(" ", text or "")


def _broken_formula_reasons(text: str) -> list[str]:
    """Deterministic signs a formula-driven block carries broken formula text that
    renders as raw/red LaTeX or literal operator words rather than real math."""
    if not text:
        return []
    reasons: list[str] = []
    for line in text.splitlines():
        if _FORMULA_CONTEXT_RE.search(line) and _PROSE_MATH_WORD_RE.search(line):
            reasons.append("prose-math-word")
            break
    # Mixed notation on ONE line — a unicode Greek letter AND a raw LaTeX command
    # (e.g. "θ_Ang \theta") — is a reliable corruption signal: the model duplicated
    # a symbol in two notations, which renders as garbled math. Per-line so a clean
    # `\omega` formula next to a prose "angle θ" elsewhere never trips it.
    for line in text.splitlines():
        if _GREEK_LETTER_RE.search(line) and _LATEX_CMD_RE.search(line):
            reasons.append("mixed-notation")
            break
    # A glued operator/accent that survives even inside $...$ ("sumM_A", "Fdvecr").
    if _MANGLED_LATEX_RE.search(text):
        reasons.append("mangled-latex")
    # After the sanitizer's wrapping, a real LaTeX command still sitting OUTSIDE any
    # math span (e.g. a bare "\theta" the wrapper could not pair) renders raw/red.
    outside = _strip_math_spans(_wrap_inline_latex_fragments(_wrap_bare_formula_lines(text)))
    if re.search(r"\\[a-zA-Z]{2,}", outside):
        reasons.append("raw-latex-in-text")
    # A leaked LaTeX table / cases / array environment: `&` column separators or
    # `\\` row breaks (or a literal \begin{}) left outside any math span. Renders
    # as red raw LaTeX, so a shard carrying it should regenerate.
    if "\\\\" in outside or "\\begin" in outside or re.search(r"\S[ \t]+&[ \t]+\S", outside):
        reasons.append("latex-table-leak")
    return reasons


def _norm_formula_key(body: str) -> str:
    """A whitespace/spacing-insensitive key so a formula already present in any
    notation isn't re-injected from the bank."""
    s = formula_to_latexish(body or "").strip().strip("$").strip()
    s = re.sub(r"\\(?:left|right|,|;|!|quad|qquad|;)", "", s)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def _iter_sections(text: str) -> list[tuple[str, str]]:
    """Split markdown into (heading_line, body) pairs. Any preamble before the
    first heading is returned as ("", preamble)."""
    parts = _SECTION_SPLIT_RE.split(text or "")
    out: list[tuple[str, str]] = []
    if parts and parts[0]:
        out.append(("", parts[0]))
    for i in range(1, len(parts), 2):
        out.append((parts[i], parts[i + 1] if i + 1 < len(parts) else ""))
    return out


def _section_formula_keys(body: str) -> set[str]:
    keys: set[str] = set()
    for m in _DISPLAY_FORMULA_RE.finditer(body):
        keys.add(_norm_formula_key(m.group(1)))
    for m in _INLINE_FORMULA_RE.finditer(body):
        keys.add(_norm_formula_key(m.group(1)))
    return keys


def _is_formula_only_line(line: str) -> bool:
    """True if a line is essentially just a formula (a $...$ span or bare LaTeX),
    not a prose line that happens to mention math. Used to swap a bank topic's
    formula lines for the canonical set without touching its prose/conditions."""
    s = line.strip()
    if not s:
        return False
    s = re.sub(r"^[-*]\s+", "", s)                       # bullet
    s = re.sub(r"^\*\*[^*\n]+\*\*\s*:?\s*", "", s).strip()  # bold lead-in label
    if not s:
        return False
    if not re.search(r"\$|[=_^]|\\[a-zA-Z]", s):
        return False
    rest = _strip_math_spans(s)
    rest = re.sub(r"\\[a-zA-Z]+", "", rest)              # drop raw LaTeX command words
    prose = re.findall(r"[A-Za-z]{3,}", rest)
    return len(prose) <= 1


def _bank_section_markdown(canonical: str) -> str:
    """A minimal, clean section built from the canonical bank — used to inject a
    Method-Picker target topic that the model dropped."""
    formulas = _MECHANICS_FORMULA_BANK.get(canonical, ())
    traps = _MECHANICS_TRAP_BANK.get(canonical, ())
    lines = [f"## {canonical}", "", "**Formulas:**"]
    lines += [f"${f}$" for f in formulas]
    if traps:
        lines += ["", "**Watch out:**"]
        lines += [f"- {t}" for t in traps]
    return "\n".join(lines)


# Topics whose bank is the COMPLETE canonical set and which the model habitually
# cross-contaminates (Drehimpuls / rotational-energy formulas leaking into
# Trägheitsmoment, mixed notation in Rotation starrer Körper). For these we replace
# the section's formula lines wholesale with the bank so the topics stay cleanly
# separated; everywhere else enforcement is surgical (keep clean model formulas).
_STRICT_BANK_TOPICS = frozenset({
    "Trägheitsmoment",
    "Drehimpuls",
    "Rotation starrer Körper",
})


# When the user explicitly chose German output, the formula-template section
# labels (hardcoded English in the preset formats) must follow. Only the known
# structural labels are mapped; ``Important:/Critical:/Note:`` emphasis markers are
# left untouched (the renderer keys its red/orange styling off the English words).
_LABEL_DE = {
    "use when": "Anwenden bei",
    "formulas": "Formeln",
    "formula": "Formel",
    "conditions": "Bedingungen",
    "condition": "Bedingung",
    "watch out": "Achtung",
    "special cases": "Sonderfälle",
    "special case": "Sonderfall",
    "variables": "Variablen",
    "concept": "Konzept",
    "trap": "Falle",
    "why it matters": "Warum wichtig",
    "method hint": "Lösungsweg",
    "formula cluster": "Formelsammlung",
}
_BOLD_LABEL_RE = re.compile(r"\*\*([^*\n:]+?):?\*\*")


def localize_section_labels(text: str, lang: str | None) -> str:
    """Translate the known English section labels to German when the user picked
    German output, so labels match the German content. No-op for other languages."""
    if lang != "de" or not text:
        return text

    def _repl(m: "re.Match[str]") -> str:
        de = _LABEL_DE.get(m.group(1).strip().lower())
        return f"**{de}:**" if de else m.group(0)

    return _BOLD_LABEL_RE.sub(_repl, text)


def enforce_formula_bank(text: str, topics: "list[str | None]") -> tuple[str, int]:
    """For sections whose topic has a canonical formula bank: drop the section's
    BROKEN/mangled formula lines and inject any MISSING canonical formula (clean
    $...$). Clean, well-formed formulas the model added are KEPT, and prose /
    conditions / traps are never touched. For _STRICT_BANK_TOPICS the formula lines
    are replaced WHOLESALE with the bank (cross-topic leaks removed). Returns
    (text, changes)."""
    if not text:
        return text, 0
    changes = 0
    rebuilt: list[str] = []
    for head, body in _iter_sections(text):
        if not head:
            rebuilt.append(body)
            continue
        title = re.sub(r"^#{1,6}[ \t]+", "", head).strip()
        canonical = _canonical_mechanics_topic(title)
        bank = _MECHANICS_FORMULA_BANK.get(canonical, ())
        if not bank:
            rebuilt.append(head + body)
            continue
        strict = canonical in _STRICT_BANK_TOPICS
        # 1) drop formula-only lines: broken/mangled always; for strict topics ALL of
        #    them (the bank is re-inserted), which removes cross-topic leaks.
        kept: list[str] = []
        insert_at: "int | None" = None
        dropped = 0
        for ln in body.split("\n"):
            if _is_formula_only_line(ln) and (strict or _broken_formula_reasons(ln)):
                if insert_at is None:
                    insert_at = len(kept)
                dropped += 1
                continue
            kept.append(ln)
        # 2) inject the canonical formulas not already present (strict topics dropped
        #    them all above, so the full bank is re-inserted, in order).
        present = _section_formula_keys("\n".join(kept))
        missing = [f for f in bank if _norm_formula_key(f) not in present]
        if not dropped and not missing:
            rebuilt.append(head + body)
            continue
        if insert_at is None:
            lbl = next((k for k, l in enumerate(kept) if _FORMULA_LABEL_RE.match(l)), None)
            insert_at = (lbl + 1) if lbl is not None else (1 if kept and not kept[0].strip() else 0)
        if missing:
            kept[insert_at:insert_at] = [f"${f}$" for f in missing]
        rebuilt.append(head + "\n".join(kept))
        changes += 1
    return "".join(rebuilt), changes


def ensure_drehimpuls_section(text: str, cfg: dict[str, Any]) -> tuple[str, int]:
    """If the sheet covers rigid-body rotation (Trägheitsmoment or Rotation starrer
    Körper present) but has NO Drehimpuls section, inject a clean bank one — so
    angular momentum is its own block and never folded into Trägheitsmoment."""
    if not (cfg.get("formulaDriven", True) and cfg.get("mechanics", True)) or not text:
        return text, 0
    present = set()
    for head, _ in _iter_sections(text):
        if head:
            present.add(_canonical_mechanics_topic(re.sub(r"^#{1,6}[ \t]+", "", head).strip()))
    has_rotation = bool(present & {"Trägheitsmoment", "Rotation starrer Körper"})
    if not has_rotation or "Drehimpuls" in present:
        return text, 0
    return text.rstrip() + "\n\n" + _bank_section_markdown("Drehimpuls") + "\n", 1


# Method-Picker "Use" cell phrase → the canonical topic it tells the student to
# use. If the picker names a method, the sheet must carry that method's section.
_MP_METHOD_TO_TOPIC: tuple[tuple[str, str], ...] = (
    ("tangential", "Tangential- und Normalkoordinaten"),
    ("polar", "Polarkoordinaten"),
    ("work-energy", "Arbeit, Energie und Leistung"),
    ("impulse-momentum", "Impuls und Stoß"),
)


def ensure_method_picker_targets(
    text: str, topics: "list[str | None]", cfg: dict[str, Any]
) -> tuple[str, int]:
    """If the Method Picker references a method (Polar/Tangential-normal/…) but the
    sheet has no section for it, inject a clean bank section so the picker is never
    a dead end. Returns (text, injected)."""
    if not (cfg.get("formulaDriven", True) and cfg.get("mechanics", True)) or not text:
        return text, 0
    if not re.search(r"(?im)^#{1,6}\s+method\s+picker\b", text):
        return text, 0
    existing: set[str] = set()
    for head, _ in _iter_sections(text):
        if head:
            existing.add(_canonical_mechanics_topic(re.sub(r"^#{1,6}[ \t]+", "", head).strip()))
    low = text.lower()
    additions: list[str] = []
    for needle, canonical in _MP_METHOD_TO_TOPIC:
        if needle not in low or canonical in existing:
            continue
        if canonical not in _MECHANICS_FORMULA_BANK:
            continue
        additions.append(_bank_section_markdown(canonical))
        existing.add(canonical)
    if not additions:
        return text, 0
    return text.rstrip() + "\n\n" + "\n\n".join(additions) + "\n", len(additions)


# Raw-markdown / template-leak artifacts that must NEVER reach a reference sheet
# (all observed in the bad Fertigungstechnik output): a forced "Formula cluster"
# label on a non-formula topic, an "N/A" body, or a literal escaped newline.
_FORMULA_CLUSTER_LEAK_RE = re.compile(r"(?im)^\s*[-*]?\s*\**\s*formula\s+cluster\b")
# An "N/A" value: a standalone line (optionally bulleted / bold-labelled) or one
# following a `label:`. Catches both `**Vorteile:** N/A` and a lone `N/A`.
_NA_BODY_RE = re.compile(
    r"(?im)(?::[ \t]*n/?a\b\.?[ \t]*$|"
    r"^[ \t]*(?:[-*][ \t]*)?(?:\*\*[^*\n]+\*\*[ \t]*:?[ \t]*)?n/?a\b\.?[ \t]*$)"
)
_LITERAL_NEWLINE_RE = re.compile(r"\\n")


def _reference_gate_failures(text: str, cfg: dict[str, Any]) -> list[str]:
    """Content gate for REFERENCE (non-formula) subjects. Unlike the formula
    gate it never demands formulas; it rejects the formula-template leaks and
    demands real memory structure (a definition, table, or labelled fact)."""
    failures: list[str] = []
    low = text.lower()
    if "formula omitted" in low or "formulaomitted" in low:
        failures.append("omitted-marker")
    if _FORMULA_CLUSTER_LEAK_RE.search(text):
        failures.append("formula-cluster-leak")
    if _NA_BODY_RE.search(text):
        failures.append("na-leak")
    if _LITERAL_NEWLINE_RE.search(text):
        failures.append("raw-markdown")
    # Reference/design subjects must never emit a raw LaTeX table/cases/array env
    # (the GdK "1.0 & \\text{Vollwelle} \\\\ …" leak) — use a markdown table instead.
    if any(r in ("latex-table-leak", "raw-latex-in-text") for r in _broken_formula_reasons(text)):
        failures.append("raw-latex")
    titles = re.findall(r"(?im)^#{1,6}\s+(.+?)\s*$", text)
    n_topic = len(titles)
    # Real structure = a markdown table, a bold lead-in label, or a numbered list.
    has_structure = bool(
        re.search(r"(?m)^\s*\|.+\|", text)            # table row
        or re.search(r"\*\*[^*\n]+\*\*", text)        # **Label:** bold lead-in
        or re.search(r"(?m)^\s*\d+[.)]\s+\S", text)   # numbered list
    )
    if n_topic >= 1 and not has_structure:
        failures.append("no-structure")
    return failures


def _shard_gate_failures(text: str, cfg: dict[str, Any], *, expect_method_picker: bool) -> list[str]:
    """Return the content checks a shard's output fails (empty list = pass)."""
    if not (text and text.strip()):
        return ["empty"]
    if not cfg.get("formulaDriven", True):
        return _reference_gate_failures(text, cfg)
    failures: list[str] = []
    if "formula omitted" in text.lower() or "formulaomitted" in text.lower():
        failures.append("omitted-marker")
    if expect_method_picker and not re.search(r"(?im)^#{1,6}\s+method\s+picker\b", text):
        failures.append("missing-method-picker")
    titles = re.findall(r"(?im)^#{1,6}\s+(.+?)\s*$", text)
    topic_sections = [t for t in titles if "method picker" not in t.lower()]
    n_topic = len(topic_sections)
    n_formulas = _count_renderable_formulas(text)
    if n_topic and n_formulas == 0:
        failures.append("no-formulas")
    elif n_topic >= 3 and n_formulas < n_topic // 2:
        failures.append("low-formula-density")
    if _broken_formula_reasons(text):
        failures.append("broken-formula")
    label = _PRESET_REQUIRED_LABEL.get(str(cfg.get("preset")))
    if label and n_topic >= 1 and label not in text.lower():
        failures.append(f"missing-label:{label}")
    return failures


def _corrective_guidance(failures: list[str]) -> str:
    fixes: list[str] = []
    if "missing-method-picker" in failures:
        fixes.append("include the Method Picker as a markdown table as the FIRST section")
    if "no-formulas" in failures or "empty" in failures or "low-formula-density" in failures:
        fixes.append(
            "every section MUST carry its grounded formulas in $...$ — no prose-only "
            "sections; mine the evidence for every formula it supports"
        )
    # Reference-subject fixes.
    if "formula-cluster-leak" in failures or "na-leak" in failures:
        fixes.append(
            "NEVER write a 'Formula cluster' label or 'N/A' — this is a memorization "
            "subject; use definitions, classification/comparison tables, "
            "Vorteile/Nachteile, Merken and a concrete Prüfungsfalle instead"
        )
    if "broken-formula" in failures:
        fixes.append(
            "write EVERY formula as valid KaTeX inside $...$ — use \\sum, \\int, "
            "\\theta, \\omega, \\vec (NEVER the words 'sum'/'integral', a glued "
            "accent like 'vecr', or a bare \\theta sitting in plain text)"
        )
    if "raw-markdown" in failures:
        fixes.append("emit clean markdown with real line breaks — never a literal '\\n'")
    if "raw-latex" in failures:
        fixes.append(
            "NEVER emit a raw LaTeX table or `\\begin{cases}`/`array` environment, "
            "`\\text{...}`, `&` column separators or `\\\\` row breaks — render any "
            "comparison as a real markdown '| … |' table, and put formulas only in $...$"
        )
    if "no-structure" in failures:
        fixes.append(
            "give each section real structure: a one-line definition plus bold "
            "lead-in labels (**Kurzdefinition:**, **Vorteile:** …) or a comparison table"
        )
    for f in failures:
        if f.startswith("missing-label:"):
            fixes.append(f"use the required **{f.split(':', 1)[1].title()}:** label in every section")
    if not fixes:
        return ""
    return (
        "\n\nREGENERATION — your previous attempt FAILED these checks: "
        + ", ".join(failures) + ". Fix ALL of them: " + "; ".join(fixes)
        + ". Use ONLY the COURSE CONTEXT; never invent."
    )


def _shard_text(res: Any) -> str:
    if res is None:
        return ""
    data = res.data if isinstance(res.data, dict) else {}
    return ((data.get("text") if isinstance(data, dict) else "") or "").strip()


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

    # The Method Picker is a mechanics formula-selection aid — never for reference
    # subjects (no mechanics topics to pick), so don't expect/require it there.
    _mp_preset = (
        cfg.get("formulaDriven", True)
        and cfg.get("mechanics", True)
        and str(cfg.get("preset")) not in ("formula_reference", "topic_mastery")
    )

    def _expect_mp(idx: int) -> bool:
        return idx == 0 and not per_pdf and _mp_preset

    results: list[Any] = [None] * len(shards)
    with ThreadPoolExecutor(max_workers=len(shards)) as pool:
        futures = {
            pool.submit(
                _run_one_section_shard,
                cfg=cfg,
                group=shard,
                doc_names=doc_names,
                with_method_picker=_expect_mp(idx),
            ): idx
            for idx, shard in enumerate(shards)
        }
        for fut in as_completed(futures):
            results[futures[fut]] = fut.result()

    # Quality gate: score each shard; regenerate ONLY the failing ones (once, in
    # parallel) with corrective feedback, and keep the better of the two.
    failures = [
        _shard_gate_failures(_shard_text(results[i]), cfg, expect_method_picker=_expect_mp(i))
        for i in range(len(shards))
    ]
    diag["gateFailuresInitial"] = [f for fs in failures for f in fs]
    retry_idxs = [i for i, fs in enumerate(failures) if fs]
    diag["shardsRegenerated"] = 0
    if retry_idxs:
        with ThreadPoolExecutor(max_workers=len(retry_idxs)) as pool:
            futures = {
                pool.submit(
                    _run_one_section_shard,
                    cfg=cfg,
                    group=shards[i],
                    doc_names=doc_names,
                    with_method_picker=_expect_mp(i),
                    corrective=_corrective_guidance(failures[i]),
                ): i
                for i in retry_idxs
            }
            for fut in as_completed(futures):
                i = futures[fut]
                retry_res = fut.result()
                retry_fail = _shard_gate_failures(
                    _shard_text(retry_res), cfg, expect_method_picker=_expect_mp(i)
                )
                # Keep the retry only if it is strictly better (fewer failures, or
                # equal failures but more renderable formulas).
                better = len(retry_fail) < len(failures[i]) or (
                    len(retry_fail) == len(failures[i])
                    and _count_renderable_formulas(_shard_text(retry_res))
                    > _count_renderable_formulas(_shard_text(results[i]))
                )
                if retry_res is not None and better:
                    results[i] = retry_res
                    failures[i] = retry_fail
                    diag["shardsRegenerated"] += 1
    diag["gateFailuresFinal"] = [f for fs in failures for f in fs]

    texts: list[str] = []
    for res in results:
        if res is None:
            continue
        diag["model"] = res.model
        diag["promptTokens"] += res.prompt_tokens or 0
        diag["completionTokens"] += res.completion_tokens or 0
        t = _shard_text(res)
        if t:
            texts.append(t)
    return "\n\n".join(texts), diag


# ── Stage 5: document-level quality hardening ────────────────────────────────
#
# The per-shard gate above catches per-shard defects a SHARD retry can fix, and
# the deterministic cleanup (sanitize/dedup/grounding/bank) repairs mechanical
# breakage. What was still missing was a WHOLE-DOCUMENT verdict: after all the
# shards are stitched and cleaned, is the assembled sheet actually good enough to
# ship — did the requested topics survive, are formulas present where the subject
# demands them, is anything truncated, are the formulas traceable to the source?
# This block answers that with a structured assessment, and if the sheet is below
# threshold it regenerates the WHOLE document exactly once with a repair prompt
# describing what was deficient, then keeps the better of the two. Thresholds are
# deliberately lenient (we already drop weak sections upstream) so a genuinely
# good sheet always passes clean and the costly retry only fires on real defects.

# Overall pass threshold (0-100). Below this the sheet is regenerated once.
_QUALITY_PASS_THRESHOLD = 70
# Source-support (grounding) ratio below which formulas read as poorly traceable
# to the student's own text. Only judged once there are enough display formulas
# to be statistically meaningful (matches the existing citationWarning gate).
_MIN_SOURCE_SUPPORT = 0.6
_GROUNDING_MIN_FORMULAS = 3
# Topic coverage: fraction of the requested/known section labels that must appear
# as a `##` heading in the final sheet. Upstream legitimately DROPS ungrounded
# topics, so this is lenient — it only fires when most of the plan vanished.
_MIN_TOPIC_COVERAGE = 0.5
# A formula-driven sheet with topic sections but (almost) no formulas is broken.
_MIN_FORMULA_SECTION_RATIO = 0.5

# A printed citation in the RAW model output, e.g. "(lecture.pdf, p.4)" or
# "[lecture.pdf p. 12]" — measured before sanitize strips on-page citations.
_RAW_CITATION_RE = re.compile(
    r"\b[\w\-]+\.(?:pdf|pptx?|docx?|txt|md)\b[^)\]\n]{0,40}?\bp\.?\s*\d+",
    re.I,
)


def _heading_titles(text: str) -> list[str]:
    return [t.strip() for t in re.findall(r"(?im)^#{1,6}[ \t]+(.+?)\s*$", text or "")]


def _section_is_empty(body: str) -> bool:
    """True if a section body has no real content (only blank lines / a bare
    label with nothing after it / a leftover dedup marker)."""
    stripped = re.sub(r"\*\(see above\)\*", "", body or "").strip()
    if not stripped:
        return True
    # Strip bullets and bold lead-in labels; if nothing substantive remains it is
    # an empty shell (e.g. "- **Vorteile:**" with no body).
    leftover = re.sub(r"(?m)^[ \t]*[-*][ \t]*", "", stripped)
    leftover = re.sub(r"\*\*[^*\n]+\*\*[ \t]*:?", "", leftover)
    return len(leftover.strip()) < 3


def assess_cheatsheet_quality(
    *,
    text: str,
    raw_text: str,
    topics: list[str | None],
    grounding: dict[str, Any],
    cfg: dict[str, Any],
    dropped_formulas: int,
) -> dict[str, Any]:
    """Whole-document quality verdict over the final, cleaned cheatsheet.

    Returns a structured dict ``{passed, score, flags, checks}`` covering topic
    coverage, source-support (citation/grounding), empty sections, formula or
    definition coverage (per subject type) and malformed/truncated content. This
    is the Stage-5 gate that stops silently shipping a weak sheet: ``passed`` is
    False when ``score`` falls below ``_QUALITY_PASS_THRESHOLD``.
    """
    flags: list[str] = []
    checks: dict[str, Any] = {}
    formula_driven = bool(cfg.get("formulaDriven", True))

    sections = [(h, b) for h, b in _iter_sections(text) if h]
    n_sections = len(sections)

    # 1) Topic coverage — did the requested/known section labels survive? Upstream
    # legitimately omits ungrounded topics, so we only flag when MOST vanished.
    wanted = [t for t in topics if t]
    titles_low = [t.lower() for t in _heading_titles(text)]
    if wanted:
        covered = sum(
            1 for w in wanted
            if any(w.lower() in t or t in w.lower() for t in titles_low)
        )
        coverage = covered / len(wanted)
    else:
        coverage = 1.0 if n_sections else 0.0
        covered = n_sections
    checks["topicCoverage"] = round(coverage, 3)
    if wanted and coverage < _MIN_TOPIC_COVERAGE:
        flags.append("low-topic-coverage")

    # 2) Empty sections — a `##` heading with no real body.
    empty = sum(1 for _h, b in sections if _section_is_empty(b))
    checks["emptySections"] = empty
    if n_sections and empty / n_sections > 0.34:
        flags.append("empty-sections")

    # 3) Source support / citation traceability. On-page citations are stripped by
    # design (Hyperknow style), so the SHIPPED-sheet signal is the mechanical
    # grounding ratio; we ALSO record whether the RAW model output cited sources at
    # all (e.g. "file.pdf, p.N") as a softer diagnostic.
    ratio = grounding.get("ratio")
    total_f = grounding.get("total") or 0
    checks["sourceSupport"] = None if ratio is None else round(float(ratio), 3)
    checks["rawCitationCount"] = len(_RAW_CITATION_RE.findall(raw_text or ""))
    low_support = (
        ratio is not None
        and total_f >= _GROUNDING_MIN_FORMULAS
        and float(ratio) < _MIN_SOURCE_SUPPORT
    )
    if low_support:
        flags.append("low-source-support")

    # 4) Formula / definition coverage. Formula/mechanics subjects must carry real
    # formulas in their sections; reference subjects must instead carry structured
    # definitions (a label, table or definition line) — never be forced to formulas.
    formula_count = _formula_count(text)
    checks["formulaCount"] = formula_count
    if formula_driven:
        sections_with_formula = sum(
            1 for _h, b in sections if _formula_count(b) > 0
        )
        ratio_fs = (sections_with_formula / n_sections) if n_sections else 1.0
        checks["formulaSectionRatio"] = round(ratio_fs, 3)
        if n_sections and formula_count == 0:
            flags.append("no-formulas")
        elif n_sections >= 3 and ratio_fs < _MIN_FORMULA_SECTION_RATIO:
            flags.append("low-formula-coverage")
    else:
        sections_with_def = sum(
            1 for _h, b in sections
            if re.search(r"(?m)\*\*[^*\n]+\*\*|^\s*\|.+\||^\s*\d+[.)]\s+\S", b)
        )
        ratio_ds = (sections_with_def / n_sections) if n_sections else 1.0
        checks["definitionSectionRatio"] = round(ratio_ds, 3)
        if n_sections >= 3 and ratio_ds < _MIN_FORMULA_SECTION_RATIO:
            flags.append("low-definition-coverage")

    # 5) Malformed content — broken markdown/LaTeX or a truncated tail. A high
    # sanitize-drop count means the model emitted a lot of unrenderable formulas.
    broken = _broken_formula_reasons(text)
    checks["brokenFormulaReasons"] = broken
    if broken:
        flags.append("broken-content")
    # Truncation: an unterminated display delimiter, or a body that ends mid-token
    # — a dangling math operator (`=`, `+`, `\frac` …) right after an alphanumeric,
    # i.e. a formula or equation cut off by the token cap. Excludes a trailing `*`
    # / `_` (markdown emphasis) and sheet-ending punctuation, which are not breaks.
    body = (text or "").rstrip()
    truncated = (body.count("$$") % 2 == 1) or (
        len(body) > 80 and bool(re.search(r"(?:\w[=+]|\\[a-zA-Z]+)\s*$", body))
    )
    checks["truncated"] = truncated
    if truncated:
        flags.append("truncated")
    if dropped_formulas >= 3:
        flags.append("many-dropped-formulas")

    # Score: start at 100, subtract per defect class (weighted by severity).
    penalties = {
        "low-topic-coverage": 25,
        "empty-sections": 20,
        "low-source-support": 20,
        "no-formulas": 40,
        "low-formula-coverage": 20,
        "low-definition-coverage": 20,
        "broken-content": 25,
        "truncated": 30,
        "many-dropped-formulas": 12,
    }
    score = 100 - sum(penalties.get(f, 10) for f in flags)
    score = max(0, min(100, score))
    return {
        "passed": score >= _QUALITY_PASS_THRESHOLD,
        "score": score,
        "threshold": _QUALITY_PASS_THRESHOLD,
        "flags": flags,
        "checks": checks,
    }


def _quality_repair_guidance(assessment: dict[str, Any]) -> str:
    """Turn a failing assessment into a corrective instruction appended to every
    shard's system prompt on the single whole-document repair pass."""
    flags = assessment.get("flags", [])
    fixes: list[str] = []
    if "low-topic-coverage" in flags:
        fixes.append(
            "write a `## ` section for EVERY topic you are given that the evidence "
            "supports — do not silently drop most of the requested topics"
        )
    if "empty-sections" in flags:
        fixes.append(
            "never emit a heading with an empty body or a bare label with nothing "
            "after it — either fill the section with grounded content or omit it"
        )
    if "no-formulas" in flags or "low-formula-coverage" in flags:
        fixes.append(
            "each section MUST carry its grounded formulas in $...$ — mine the "
            "evidence for every formula it supports; no prose-only sections"
        )
    if "low-definition-coverage" in flags:
        fixes.append(
            "give each section real structure — a definition line, bold lead-in "
            "labels (**Kurzdefinition:** …) or a comparison table — not loose prose"
        )
    if "low-source-support" in flags:
        fixes.append(
            "use ONLY formulas the COURSE CONTEXT actually states — drop any formula "
            "you cannot trace to the provided evidence; never invent or guess"
        )
    if "broken-content" in flags:
        fixes.append(
            "write EVERY formula as valid KaTeX inside $...$ (\\sum, \\int, \\theta, "
            "\\vec) — never an operator word, a glued accent, or bare LaTeX in prose"
        )
    if "truncated" in flags or "many-dropped-formulas" in flags:
        fixes.append(
            "keep each item to ONE tight line and finish every formula and sentence — "
            "prefer fewer well-formed items over a long, cut-off block"
        )
    if not fixes:
        return ""
    return (
        "\n\nQUALITY REPAIR — the previous draft FAILED these checks: "
        + ", ".join(flags) + ". Fix ALL of them: " + "; ".join(fixes)
        + ". Use ONLY the COURSE CONTEXT; never invent."
    )


def _clean_and_enforce(
    raw_text: str,
    *,
    cfg: dict[str, Any],
    evidence: list[dict[str, Any]],
    covered_labels: list[str],
    topics: list[str | None],
) -> dict[str, Any]:
    """Run the deterministic cleanup + enforcement pipeline on raw section text.

    Factored out of ``generate_cheatsheet`` so the Stage-5 repair retry can reuse
    EXACTLY the same post-processing (sanitize → leak strip → filler → dedup →
    source gate → bank/method-picker enforcement → localize → grounding). Returns
    a bundle of the cleaned text plus every counter the final dict reports.
    """
    text, dropped_formulas = sanitize_cheatsheet_markdown(raw_text)
    if not cfg.get("formulaDriven", True):
        text = strip_reference_template_leaks(text)
    text, filler_notes = remove_generic_filler_notes(text)
    text, deduped = dedup_display_formulas(text)
    text, unsupported_formulas = drop_unsupported_display_formulas(text, evidence)
    bank_repairs = 0
    method_picker_injected = 0
    if cfg.get("formulaDriven", True) and cfg.get("mechanics", True):
        text, bank_repairs = enforce_formula_bank(text, covered_labels)
        text, method_picker_injected = ensure_method_picker_targets(text, topics, cfg)
        text, _drehimpuls_added = ensure_drehimpuls_section(text, cfg)
        method_picker_injected += _drehimpuls_added
    text = localize_section_labels(text, cfg.get("language"))
    grounding = formula_grounding(text, evidence)
    return {
        "text": text,
        "dropped_formulas": dropped_formulas,
        "filler_notes": filler_notes,
        "deduped": deduped,
        "unsupported_formulas": unsupported_formulas,
        "bank_repairs": bank_repairs,
        "method_picker_injected": method_picker_injected,
        "grounding": grounding,
    }


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
    # Decide ONCE, from the raw topic-map names (+ any focus topic), whether the
    # mechanics taxonomy applies. If not (e.g. Grundlagen des Konstruierens), the
    # aggressive aliasing, formula/trap banks, layout map and method picker are all
    # skipped so the course keeps its real topic names and gets no fabricated
    # kinematics formulas.
    raw_topic_names = [str(t.get("name")) for t in (topic_map or []) if t.get("name")]
    if topic_query:
        raw_topic_names.append(topic_query)
    cfg["mechanics"] = _course_is_mechanics(raw_topic_names)
    # Document Understanding Layer: ride the source-type guidance on cfg so every
    # section shard sees it (cheat sheets from an exam vs lecture differ in tone).
    cfg["understanding"] = understanding_block_for_ids(document_ids, user_id=user_id)
    topics = _topic_names(
        topic_map, topic_query, limit=cfg["maxTopics"], mechanics=cfg["mechanics"]
    )

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

    # Subject-aware routing: classify from the student's OWN evidence (unless a
    # subject type was forced in settings) and thread it through cfg so the shard
    # writer, the quality gate and the method-picker logic all switch templates.
    subject_type = _resolve_subject_type(cfg, evidence, topics)
    cfg["subjectType"] = subject_type
    cfg["formulaDriven"] = subject_type in _FORMULA_DRIVEN_TYPES
    log.info("cheatsheet subject type=%s (formulaDriven=%s)", subject_type, cfg["formulaDriven"])

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

    # Deterministic cleanup + enforcement (sanitize → leak strip → filler → dedup
    # → source gate → bank/method-picker → localize → grounding), factored out so
    # the Stage-5 whole-document repair retry can reuse it verbatim.
    bundle = _clean_and_enforce(
        raw_text, cfg=cfg, evidence=evidence,
        covered_labels=covered_labels, topics=topics,
    )

    # ── Stage 5: whole-document quality gate + single repair retry ────────────
    # Assess the assembled, cleaned sheet. If it is below threshold, regenerate the
    # WHOLE document ONCE with a repair prompt naming the deficiencies, re-clean it,
    # and keep whichever scores higher. Capped at exactly one retry for cost/latency.
    assessment = assess_cheatsheet_quality(
        text=bundle["text"], raw_text=raw_text, topics=topics,
        grounding=bundle["grounding"], cfg=cfg, dropped_formulas=bundle["dropped_formulas"],
    )
    repair_attempted = False
    if not assessment["passed"]:
        repair_attempted = True
        log.info(
            "cheatsheet quality below threshold (score=%d, flags=%s) — repairing once",
            assessment["score"], assessment["flags"],
        )
        repair_cfg = dict(cfg)
        repair_cfg["qualityRepair"] = _quality_repair_guidance(assessment)
        try:
            repair_raw, repair_diag = _generate_sections_parallel(
                cfg=repair_cfg, groups=groups, doc_names=merged_names, per_pdf=per_pdf,
            )
        except Exception:  # noqa: BLE001
            log.exception("cheatsheet quality repair pass failed")
            repair_raw, repair_diag = "", {}
        if repair_raw.strip():
            repair_bundle = _clean_and_enforce(
                repair_raw, cfg=cfg, evidence=evidence,
                covered_labels=covered_labels, topics=topics,
            )
            repair_assessment = assess_cheatsheet_quality(
                text=repair_bundle["text"], raw_text=repair_raw, topics=topics,
                grounding=repair_bundle["grounding"], cfg=cfg,
                dropped_formulas=repair_bundle["dropped_formulas"],
            )
            # The repair pass is real spend regardless of whether we keep it, so
            # accumulate its token cost into the diagnostics either way.
            diag["promptTokens"] = (diag.get("promptTokens") or 0) + (repair_diag.get("promptTokens") or 0)
            diag["completionTokens"] = (diag.get("completionTokens") or 0) + (repair_diag.get("completionTokens") or 0)
            diag["shardsRegenerated"] = (
                diag.get("shardsRegenerated", 0) + repair_diag.get("shardsRegenerated", 0)
            )
            # Keep the repair only if it scores strictly higher.
            if repair_assessment["score"] > assessment["score"]:
                raw_text = repair_raw
                bundle = repair_bundle
                assessment = repair_assessment
                if repair_diag.get("model"):
                    diag["model"] = repair_diag["model"]

    text = bundle["text"]
    dropped_formulas = bundle["dropped_formulas"]
    filler_notes = bundle["filler_notes"]
    deduped = bundle["deduped"]
    unsupported_formulas = bundle["unsupported_formulas"]
    bank_repairs = bundle["bank_repairs"]
    method_picker_injected = bundle["method_picker_injected"]
    grounding = bundle["grounding"]
    if dropped_formulas:
        log.info("cheatsheet sanitizer dropped %d malformed formula(s)", dropped_formulas)
    if deduped:
        log.info("cheatsheet dedup removed %d repeated formula(s)", deduped)
    if unsupported_formulas:
        log.info("cheatsheet source gate removed %d unsupported formula(s)", unsupported_formulas)
    if filler_notes:
        log.info("cheatsheet filler filter removed %d generic note(s)", filler_notes)
    if bank_repairs:
        log.info("cheatsheet bank enforcement rewrote %d section(s)", bank_repairs)
    if method_picker_injected:
        log.info("cheatsheet injected %d method-picker target section(s)", method_picker_injected)
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
        "subjectType": subject_type,
        "groundedSources": sources[:20],
        "settings": cfg,
        "grounding": grounding,
        "quality": {
            "evidenceNormalization": evidence_quality.__dict__,
            "droppedMalformedFormulas": dropped_formulas,
            "droppedUnsupportedFormulas": unsupported_formulas,
            "droppedGenericNotes": filler_notes,
            "metrics": metrics,
            "assessment": assessment,
            "repairAttempted": repair_attempted,
            "gate": {
                "failuresBeforeRetry": diag.get("gateFailuresInitial", []),
                "failuresAfterRetry": diag.get("gateFailuresFinal", []),
                "shardsRegenerated": diag.get("shardsRegenerated", 0),
                "bankRepairs": bank_repairs,
                "methodPickerInjected": method_picker_injected,
            },
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
    # Stage 5: if the sheet is STILL below the quality threshold after the single
    # repair retry, surface it honestly via `warning` instead of shipping it
    # silently. Map the structured flags to short, student-facing phrases.
    if not assessment["passed"]:
        _phrase = {
            "low-topic-coverage": "several requested topics are missing",
            "empty-sections": "some sections came out empty",
            "low-source-support": "some formulas could not be traced to your source text",
            "no-formulas": "sections are missing their formulas",
            "low-formula-coverage": "several sections are missing formulas",
            "low-definition-coverage": "several sections lack clear definitions",
            "broken-content": "some formulas may not render correctly",
            "truncated": "the sheet may be cut off",
            "many-dropped-formulas": "several unreadable formulas were dropped",
        }
        issues = [_phrase[f] for f in assessment["flags"] if f in _phrase]
        if issues:
            out["warning"] = (
                "This cheatsheet may be below our quality bar ("
                + "; ".join(issues)
                + "). Review it carefully before relying on it."
            )
    return out


__all__ = (
    "generate_cheatsheet",
    "enforce_formula_bank",
    "ensure_method_picker_targets",
    "ensure_drehimpuls_section",
    "localize_section_labels",
    "sanitize_cheatsheet_markdown",
    "dedup_display_formulas",
    "drop_unsupported_display_formulas",
    "remove_generic_filler_notes",
    "strip_reference_template_leaks",
    "classify_subject_type",
    "normalize_settings",
    "formula_grounding",
    "assess_cheatsheet_quality",
)
