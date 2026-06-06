"""Phase 9 — math answer format. Tests for ``pick_system_prompt``.

Stubs ``openai`` before importing answer.py so the test doesn't need
the openai SDK installed locally.
"""

from __future__ import annotations

import sys
import types

import pytest

# Stub openai so answer.py imports cleanly.
_fake_openai = types.ModuleType("openai")
_fake_openai.OpenAI = lambda **kwargs: None  # noqa: ARG005
sys.modules.setdefault("openai", _fake_openai)

# Stub supabase + embeddings so retrieval.py (transitively imported by
# query_expansion -> pick_system_prompt) loads without native deps.
_fake_sb = types.ModuleType("app.supabase_client")
_fake_sb.get_supabase = lambda: None
sys.modules.setdefault("app.supabase_client", _fake_sb)
_fake_emb = types.ModuleType("app.services.embeddings")
_fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
sys.modules.setdefault("app.services.embeddings", _fake_emb)

# NOTE: we used to stub `app.config` here so the test would run without
# pydantic. That stub leaked into the rest of the test session — replacing
# `get_settings` with a plain `lambda` — and broke every later test that
# expected `get_settings.cache_clear()` (the real impl is `@lru_cache`).
# pydantic-settings IS available in CI/dev now, and conftest.py seeds the
# required env vars at session start, so the real `app.config` loads fine.

from app.services.answer import (  # noqa: E402
    _SYSTEM_PROMPT_MATH,
    _SYSTEM_PROMPT_PARTIAL,
    _SYSTEM_PROMPT_STRONG,
    _SYSTEM_PROMPT_WEAK,
    _course_material_found_note,
    USER_INTENT_OVERLAY,
    is_app_question,
    _sources_for_answer,
    pick_system_prompt,
)
from app.services.answer_stream import (  # noqa: E402
    _effective_strength_with_open_context,
    _intent_resolution_runtime_overlay,
    _is_deictic_question,
    _problem_solver_overlay,
    _problem_solver_source,
)


# ── weak retrieval always wins, even for math questions ────────────────────


# `pick_system_prompt` returns the chosen base prompt with overlays appended
# (tutor mode, optional weak-topic coaching, and the always-on DIGNITY_OVERLAY).
# The old `is`-identity check broke as soon as ANY overlay was added.
# `startswith` is the right contract: the base template must lead, overlays
# follow.


def test_weak_retrieval_uses_partial_prompt_even_for_math() -> None:
    """Review fix #3: weak-strength retrieval no longer throws chunks
    away. We feed the top 2-3 to the model with the PARTIAL prompt that
    forbids confident solving but encourages "here's what your files
    DO cover" — much more useful than the old "I found nothing" reply."""
    prompt, mode = pick_system_prompt("Solve Aufgabe 1.2", "weak")
    assert prompt.startswith(_SYSTEM_PROMPT_PARTIAL)
    assert mode == "partial"


def test_none_retrieval_uses_weak_prompt() -> None:
    """``none`` strength means no chunks at all — nothing to surface.
    Fall back to the original "I couldn't find this in your files" reply."""
    prompt, mode = pick_system_prompt("Aufgabe 1.2", "none")
    assert prompt.startswith(_SYSTEM_PROMPT_WEAK)
    assert mode == "weak"
    assert "General explanation (not from your course files)" in prompt
    assert "reply 'general'" not in prompt


# ── strong retrieval routes by question type ───────────────────────────────


@pytest.mark.parametrize("q", [
    "Solve Problem 2",
    "Calculate the bending moment when F = 200 N and l = 0.5 m",
    "Derive the formula for cantilever deflection",
    "Prove that sin² + cos² = 1",
    "Aufgabe 1.2",
    "Übung 3 (a)",
    "Give me the formula for shear force",
    "Berechne das Moment",
])
def test_math_question_with_strong_context_uses_math_prompt(q: str) -> None:
    prompt, mode = pick_system_prompt(q, "strong")
    assert prompt.startswith(_SYSTEM_PROMPT_MATH)
    assert mode == "math"


def test_sources_fallback_keeps_context_visible_when_citations_missing() -> None:
    from types import SimpleNamespace

    chunks = [
        SimpleNamespace(
            document_id="doc1",
            page_start=8,
            page_end=8,
            section_title="Schraubenberechnung",
            chunk_type="formula",
            similarity=0.61,
        )
    ]

    sources = _sources_for_answer("Die Formel lautet delta = l / EA.", chunks, {"doc1": "Lecture.pdf"})

    assert sources == [{
        "index": 1,
        "documentId": "doc1",
        "fileName": "Lecture.pdf",
        "pageStart": 8,
        "pageEnd": 8,
        "sectionTitle": "Schraubenberechnung",
        "chunkType": "formula",
        "similarity": 0.61,
    }]


@pytest.mark.parametrize("q", [
    "Summarize chapter 2",
    "Who wrote this lecture?",
    "Explain in plain English",
    "What is the main idea?",
])
def test_non_math_question_with_strong_context_uses_strong_prompt(q: str) -> None:
    prompt, mode = pick_system_prompt(q, "strong")
    assert prompt.startswith(_SYSTEM_PROMPT_STRONG)
    assert mode == "strong"


# ── math prompt contract — must mention every section the template requires ─


def test_math_prompt_contains_required_sections() -> None:
    body = _SYSTEM_PROMPT_MATH
    # The "Sources used" preamble was removed — citations are now inline,
    # not listed up-front. The remaining sections are still mandatory.
    for heading in (
        "Given", "Required", "Formula",
        "Substitution", "Calculation", "Unit check", "Final answer",
        "Confidence",
    ):
        assert heading in body, f"math prompt missing required section: {heading}"


def test_math_prompt_mentions_verification_states() -> None:
    body = _SYSTEM_PROMPT_MATH
    for label in ("Verified", "Partially verified", "Missing context"):
        assert label in body, f"math prompt missing verification label: {label}"


def test_math_prompt_forbids_invention() -> None:
    body = _SYSTEM_PROMPT_MATH.lower()
    # The anti-hallucination clause must survive future edits.
    assert "do not invent" in body


def test_math_prompt_allows_universal_geometry() -> None:
    # Regression: the model must be allowed to compute a circle/annulus area
    # from a given diameter — that is universal maths, not a course-specific
    # formula. Previously `A = π·d²/4` was in the BANNED list, which made the
    # model refuse to compute A_3 from a given d_3 and bail with "Missing
    # context" even after finding the correct compliance formula.
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "universal mathematics is always allowed" in body
    assert "area of a circle" in body
    # It must actively instruct deriving the area from a given diameter.
    assert "diameter is given" in body or "from the given diameter" in body


def test_math_prompt_forbids_inventing_missing_lengths() -> None:
    # Regression: the model abused the universal-geometry carve-out to invent
    # a clamping length (l_K = 0.5*d) and label it "standard geometry". Rule
    # 1b must forbid guessing inputs that must be read from the figure/text.
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "boundary on rule 1a" in body
    assert "keep it symbolic" in body
    assert "rule of thumb" in body


def test_math_prompt_reserves_missing_context_for_absent_formula() -> None:
    # Having the formula but lacking some numeric inputs must be
    # "Partially verified", not "Missing context".
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "having the formula but lacking some numeric inputs is not" in body


def test_all_prompts_include_exact_intent_overlay() -> None:
    prompt, _mode = pick_system_prompt("solve it", "none")
    assert USER_INTENT_OVERLAY in prompt
    assert "Do not replace it with a nearby task" in prompt
    assert "ask ONE concrete" in prompt


def test_math_prompt_requires_kinematics_phase_check() -> None:
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "identify the phases" in body
    assert "braking phase" in body
    assert "total constraint" in body
    assert "entire shaft/track length as free fall" in body


def test_math_prompt_requires_piecewise_kinematics_continuity() -> None:
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "piecewise kinematics continuity check" in body
    assert "never reset velocity to zero at an internal boundary" in body
    assert "horizontal current/force acts only in one stated region" in body
    assert "apply the horizontal acceleration only during the time spent in that region" in body
    assert "second vertical segment must start with the velocity gained" in body


def test_math_prompt_allows_complete_kinematics_general_formula_fallback() -> None:
    body = _SYSTEM_PROMPT_MATH.lower()
    assert "complete elementary kinematics" in body
    assert "standard constant-acceleration equations" in body
    assert "continue through substitution, calculation, unit check, and final answer" in body
    assert "do not use \"missing context\" for a complete elementary constant-acceleration problem" in body


def test_math_prompt_documents_interactive_missing_input() -> None:
    body = _SYSTEM_PROMPT_MATH
    low = body.lower()
    # The interactive input contract must be documented.
    assert "minallo-input" in body
    assert "requestId" in body
    assert "interactive missing input" in low
    # Fast-stop: only the minimal setup, then the block, then stop.
    assert "reaches the input quickly" in low or "show only the" in low
    # The blocked-on-input confidence string the frontend keys off.
    assert "partially verified — awaiting user input" in low
    # A missing FORMULA must NOT become an input request.
    assert "must not emit a `minallo-input` block" in low


def test_strong_prompt_warns_against_single_phase_braking_error() -> None:
    body = _SYSTEM_PROMPT_STRONG.lower()
    assert "separate motion phases" in body
    assert "full shaft/track length" in body
    assert "l=x_1+x_2" in body


def test_deictic_visible_math_problem_can_use_math_prompt() -> None:
    from app.services.answer import pick_system_prompt

    chunks = [
        _mk_chunk(
            "Problem 1: An object is dropped in a vacuum fall shaft. "
            "Given: l = 200 m, a = -50g, v = 0 m/s. "
            "Determine the maximum possible test time t1 and distance x1.",
            chunk_type="exercise",
            similarity=0.99,
        )
    ]

    prompt, mode = pick_system_prompt("answer the first problem in this pdf", "strong", chunks)

    assert mode == "math"
    assert prompt.startswith(_SYSTEM_PROMPT_MATH)


@pytest.mark.parametrize("q", [
    "answer the first problem",
    "solve it",
    "calculate it",
    "answer it",
])
def test_visible_problem_followups_count_as_deictic(q: str) -> None:
    assert _is_deictic_question(q)


@pytest.mark.parametrize("q", [
    "answer the first problem",
    "solve it",
])
def test_visible_problem_context_routes_to_math_prompt(q: str) -> None:
    chunks = [
        _mk_chunk(
            "Problem 1: A ball is thrown vertically. Given: m = 2 kg, "
            "h = 3 m, v_0 = 4 m/s. Determine the impact velocity v. "
            "Use energy conservation: 1/2 m v_0^2 + m g h = 1/2 m v^2.",
            chunk_type="exercise",
            similarity=1.0,
        )
    ]

    prompt, mode = pick_system_prompt(q, "strong", chunks)

    assert mode == "math"
    assert prompt.startswith(_SYSTEM_PROMPT_MATH)


def test_deictic_without_context_must_clarify_not_guess() -> None:
    overlay = _intent_resolution_runtime_overlay(
        "solve it",
        has_visible_context=False,
        has_history=False,
        active_file_name=None,
    )

    assert "Do not guess" in overlay
    assert "Which file/page or exercise number" in overlay


def test_deictic_with_visible_context_binds_to_source_zero() -> None:
    overlay = _intent_resolution_runtime_overlay(
        "answer the first problem",
        has_visible_context=True,
        has_history=False,
        active_file_name="Seminar.pdf",
    )

    assert "Resolve it to [Source 0]" in overlay
    assert "Seminar.pdf" in overlay
    assert "must not replace the visible problem" in overlay


def test_problem_solver_full_solution_requires_final_arithmetic() -> None:
    """The full-solution overlay must not let the model stop at method steps.

    This locks the behavior behind the user's complaint: when they ask for a
    rechnerische/finale Loesung, the model must compute if possible, or name
    the exact missing inputs instead of giving generic formulas again.
    """
    body = _problem_solver_overlay("solve", {}).lower()
    assert "finish the computation" in body
    assert "carry out the arithmetic" in body
    assert "boxed final answer" in body
    assert "exact missing quantities" in body
    assert "mach weiter" in body
    assert "rechnerisch" in body


def test_problem_solver_input_is_primary_source() -> None:
    problem = "A cat follows r(phi)=R phi/pi and a mouse runs at speed a."

    assert _problem_solver_source({"problem": problem, "mode": "solve"}) == problem

    body = _problem_solver_overlay("solve", {"problem": problem}).lower()
    assert "[source 0]" in body
    assert "problem statement" in body
    assert "primary source of truth" in body
    assert "different retrieved exercise" in body
    assert "uploaded course source" in body
    assert "[source 1]" in body
    assert "equation-copying is strict" in body
    assert "do not turn" in body
    assert "new variable `p`" in body
    assert "method-only placeholders" in body


def test_course_material_found_note_names_retrieved_sources() -> None:
    from types import SimpleNamespace

    chunk = SimpleNamespace(
        document_id="doc1",
        page_start=4,
        page_end=4,
        chunk_type="lecture",
        section_title="Kinematics",
    )

    note = _course_material_found_note([chunk], {"doc1": "EngMec2 Lecture.pdf"})

    assert note.startswith("### Course material found")
    assert "[Source 1]" in note
    assert "EngMec2 Lecture.pdf, p.4" in note
    assert "Kinematics" in note
    assert "notation, method, and explanation" in note


def test_open_context_only_promotes_when_request_targets_visible_page() -> None:
    """Visible PDF text should not make every broad question look strong.

    The caller now decides whether the open context is actually relevant
    (deictic question or Problem Solver). This keeps random visible text from
    masking weak retrieval for broad course questions.
    """
    assert _effective_strength_with_open_context("weak", should_promote=False) == "weak"
    assert _effective_strength_with_open_context("weak", should_promote=True) == "strong"


def test_prompt_contains_minallo_navigation_context() -> None:
    prompt, _ = pick_system_prompt("Where do I manage my subscription?", "none")
    assert "MINALLO APP CONTEXT" in prompt
    assert "minallo.de" in prompt
    assert "Subscription" in prompt
    assert "Courses" in prompt
    assert "UPLOAD A DOCUMENT" in prompt


@pytest.mark.parametrize("q", [
    "How can I upload a doc?",
    "What features does Minallo have?",
    "Where do I manage my subscription?",
    "Is there a game room in Minallo?",
    "Wie kann ich ein PDF hochladen?",
])
def test_app_questions_are_detected(q: str) -> None:
    assert is_app_question(q)


@pytest.mark.parametrize("q", [
    "Is there a formula for shear stress?",
    "Is there a solution for Aufgabe 9.1 in the PDF?",
])
def test_academic_is_there_questions_are_not_app_support(q: str) -> None:
    assert not is_app_question(q)


# ── Review fix #7 — RetrievalCompleteness ─────────────────────────────────


def _mk_chunk(text: str, chunk_type: str = "general", similarity: float = 0.6) -> object:
    """Minimal chunk shim — assess_retrieval_completeness reads `.text`
    via getattr, so a simple namespace object is enough."""
    from types import SimpleNamespace
    return SimpleNamespace(text=text, chunk_type=chunk_type, similarity=similarity)


def test_completeness_empty_or_none_is_all_false() -> None:
    from app.services.answer import assess_retrieval_completeness
    r = assess_retrieval_completeness(None)
    assert r.has_exercise_statement is False
    assert r.has_formula is False
    assert r.has_given_values is False
    assert r.has_solution_or_method is False
    assert r.is_complete_for_math is False


def test_completeness_full_exercise_chunk_is_complete_for_math() -> None:
    """A typical exercise statement chunk has the words, the formula,
    and several `symbol = number` patterns — all three signals fire."""
    from app.services.answer import assess_retrieval_completeness
    text = (
        "Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit. "
        "Gegeben: F = 200 N, l = 0,5 m, E = 210000 N/mm², "
        "A = 100 mm². "
        "Die Formel lautet δ = l / (A · E)."
    )
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_exercise_statement
    assert r.has_formula
    assert r.has_given_values
    assert r.is_complete_for_math


def test_completeness_formula_only_chunk_misses_statement_and_givens() -> None:
    """A Formelzettel page has formulas but no exercise statement and
    no instance-level givens — should NOT be marked complete enough for
    the rigid math template alone."""
    from app.services.answer import assess_retrieval_completeness
    text = "δ_K = l_K / (E_S · A_N)  δ_G = 0.5 · d / (E_S · A_3)"
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_formula
    assert not r.has_exercise_statement
    assert not r.has_given_values
    assert not r.is_complete_for_math


def test_completeness_statement_only_chunk_misses_formula() -> None:
    """An exercise sheet that defines the task but doesn't print the
    formula is also incomplete — needs a separate formula chunk."""
    from app.services.answer import assess_retrieval_completeness
    text = (
        "Übungsaufgabe 9.1: Berechnen Sie die Nachgiebigkeit "
        "der Schraubenverbindung."
    )
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_exercise_statement
    assert not r.has_formula
    assert not r.is_complete_for_math


def test_completeness_combines_across_chunks() -> None:
    """The three signals can come from DIFFERENT chunks — that's the
    normal RAG case: one chunk has the exercise, another has the
    formula, a third has the given values."""
    from app.services.answer import assess_retrieval_completeness
    chunks = [
        _mk_chunk("Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit."),
        _mk_chunk("δ_K = l_K / (E_S · A_N)"),
        _mk_chunk("Gegeben: F = 12500 N, E_S = 210000 N/mm², d = 24 mm."),
    ]
    r = assess_retrieval_completeness(chunks)
    assert r.is_complete_for_math


def test_complete_exact_match_context_counts_as_strong() -> None:
    """Synthetic exact-match chunks should not be forced into PARTIAL mode
    when they already contain enough material to answer."""
    from types import SimpleNamespace
    from app.services.answer import _context_strength

    chunks = [
        SimpleNamespace(
            text="Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit.",
            chunk_type="exercise",
            similarity=1.0,
            is_synthetic=True,
        ),
        SimpleNamespace(
            text="Formel: delta = l / (A * E).",
            chunk_type="formula",
            similarity=1.0,
            is_synthetic=True,
        ),
        SimpleNamespace(
            text="Gegeben: l = 0,5 m, A = 100 mm^2, E = 210000 N/mm^2.",
            chunk_type="exercise",
            similarity=1.0,
            is_synthetic=True,
        ),
    ]

    assert _context_strength(chunks) == "strong"


def test_completeness_to_api_shape() -> None:
    """The API shape must match what answer_stream / ask responses
    expose — locked in so a future refactor doesn't silently drop a
    field the frontend / debug UI relies on."""
    from app.services.answer import RetrievalCompleteness
    r = RetrievalCompleteness(True, True, True, False)
    api = r.to_api()
    assert api == {
        "hasExerciseStatement":  True,
        "hasFormula":            True,
        "hasGivenValues":        True,
        "hasSolutionOrMethod":   False,
        "isCompleteForMath":     True,
    }


def test_math_template_skips_when_no_figure_and_no_text_givens() -> None:
    """``pick_system_prompt`` should fall back to the STRONG (explanatory)
    prompt — not the rigid MATH worksheet — when retrieval is strong but a
    NON-figure chunk lacks given values. There are neither text givens nor a
    figure to read them from, so the Substitution section would be
    placeholders. (Figure-bearing exercises whose givens live in the drawing
    are handled separately — see test_figure_borne_givens_still_enter_math_mode.)"""
    from app.services.answer import pick_system_prompt
    chunks = [
        _mk_chunk(
            "Übung 1.2: δ = l / (A·E)",
            chunk_type="lecture",      # NOT a figure-bearing type
            similarity=0.5,
        ),
    ]
    # Strong retrieval, no givens, no figure chunk → no MATH template.
    prompt, mode = pick_system_prompt("Berechne δ", "strong", chunks)
    assert mode == "strong"
    # Full completeness: exercise anchor + formula + explicit text givens → MATH.
    chunks = [
        _mk_chunk("Übung 1.2: δ = l / (A·E)", chunk_type="exercise", similarity=0.5),
        _mk_chunk("Gegeben: l = 0,5 m, A = 100 mm², E = 210000 N/mm²"),
    ]
    prompt, mode = pick_system_prompt("Berechne δ", "strong", chunks)
    assert mode == "math"


def test_figure_borne_givens_still_enter_math_mode() -> None:
    """AG-9.1-style exercises put their given VALUES in the DRAWING, so no
    `symbol = number` patterns appear in the OCR text and has_given_values
    stays False. As long as the statement + a formula + a figure/exercise
    chunk are present, the worksheet template must still fire so the page
    bitmap gets attached and the model can read the dimensions off the
    figure. Otherwise the figure is withheld for lack of the very givens
    that live only in the figure (the circular bug)."""
    from app.services.answer import pick_system_prompt, assess_retrieval_completeness
    chunks = [
        _mk_chunk(
            "Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit der Schraubenverbindung.",
            chunk_type="exercise",
            similarity=0.5,  # strong-similarity exercise anchor
        ),
        _mk_chunk("δ = l / (A·E)", chunk_type="formula", similarity=0.4),
    ]
    # Sanity: the text-based completeness check does NOT consider this ready
    # (the givens are in the figure, not the text).
    assert assess_retrieval_completeness(chunks).is_complete_for_math is False
    # But the figure/exercise chunk presence makes it math-ready anyway.
    prompt, mode = pick_system_prompt("Berechne die Nachgiebigkeit", "strong", chunks)
    assert mode == "math"
