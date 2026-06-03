"""Phase 12 — vision OCR fallback. Tests the pure-Python pieces:

  * select_pages_needing_ocr — page-quality bucketing
  * pages_via_vision — no-op behavior when the feature flag is off or
    optional deps are missing.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import patch

import pytest

# Stand-in Settings shape used by the patch(...) blocks below. Previously
# this also got pushed into ``sys.modules['app.config']`` so it became the
# session-wide get_settings — which leaked into every later test that
# expected the real ``@lru_cache``-wrapped function. Now it's only a plain
# class scoped to this file; conftest.py sets the env vars the real
# ``app.config`` needs for tests that import it for real.


class _FakeSettings:
    vision_ocr_enabled = False
    vision_ocr_model = "gpt-test-vision"
    vision_ocr_max_pages = 20
    vision_ocr_render_dpi = 150
    openai_api_key = "test"
    # Mathpix routing defaults — overridden per-test below.
    mathpix_routing = "off"
    mathpix_app_id = None
    mathpix_app_key = None


from app.services.vision_ocr import (  # noqa: E402
    choose_ocr_provider,
    pages_via_vision,
    select_pages_needing_ocr,
)


# ── select_pages_needing_ocr ────────────────────────────────────────────────


def test_select_flags_empty_pages() -> None:
    pages = ["full page of academic prose " * 20, "", "more academic prose " * 20]
    assert select_pages_needing_ocr(pages) == [1]


def test_select_flags_low_letter_pages() -> None:
    full = "ipsum lorem dolor sit amet " * 15  # plenty of letters
    short = "abc"
    assert select_pages_needing_ocr([full, short, full]) == [1]


def test_select_returns_empty_for_all_good() -> None:
    full = "ipsum lorem dolor sit amet " * 15
    assert select_pages_needing_ocr([full, full, full]) == []


def test_select_handles_empty_input() -> None:
    assert select_pages_needing_ocr([]) == []


# ── pages_via_vision graceful-degradation ───────────────────────────────────


def test_pages_via_vision_noop_when_flag_off() -> None:
    # Patch our own settings into the module under test so this test is
    # order-independent (other test files may install their own fake
    # app.config first).
    with patch("app.services.vision_ocr.get_settings", lambda: _FakeSettings()):
        assert pages_via_vision(b"%PDF-fake", [0, 1, 2]) == {}


def test_pages_via_vision_noop_when_no_pypdfium2() -> None:
    class FlagOnSettings(_FakeSettings):
        vision_ocr_enabled = True

    with patch("app.services.vision_ocr.get_settings", lambda: FlagOnSettings()), \
         patch("app.services.vision_ocr._try_import_pypdfium2", lambda: None):
        assert pages_via_vision(b"%PDF-fake", [0]) == {}


def test_pages_via_vision_noop_when_no_openai() -> None:
    class FlagOnSettings(_FakeSettings):
        vision_ocr_enabled = True

    fake_pdfium = object()  # truthy stand-in
    with patch("app.services.vision_ocr.get_settings", lambda: FlagOnSettings()), \
         patch("app.services.vision_ocr._try_import_pypdfium2", lambda: fake_pdfium), \
         patch("app.services.vision_ocr._try_import_openai", lambda: None):
        assert pages_via_vision(b"%PDF-fake", [0]) == {}


def test_pages_via_vision_noop_when_no_indices() -> None:
    class FlagOnSettings(_FakeSettings):
        vision_ocr_enabled = True

    with patch("app.services.vision_ocr.get_settings", lambda: FlagOnSettings()):
        assert pages_via_vision(b"%PDF-fake", []) == {}


def test_pages_via_vision_respects_max_pages_cap() -> None:
    """Ensures the cap logic doesn't crash; we don't need real rendering
    to verify the slice happens. Rendering failure returns {}."""
    class CappedSettings(_FakeSettings):
        vision_ocr_enabled = True
        vision_ocr_max_pages = 2

    # Render always fails → empty output, but no crash on long input.
    with patch("app.services.vision_ocr.get_settings", lambda: CappedSettings()), \
         patch("app.services.vision_ocr._try_import_pypdfium2", lambda: object()), \
         patch("app.services.vision_ocr._try_import_openai", lambda: (lambda **kw: None)), \
         patch("app.services.vision_ocr._render_page_to_png", lambda *a, **kw: None):
        result = pages_via_vision(b"%PDF-fake", list(range(50)))
        assert result == {}


# ── Outer markdown code-fence stripping ────────────────────────────────────


def test_strip_outer_code_fence_removes_markdown_wrapper() -> None:
    """Vision models reliably wrap their answer in a ```markdown ...```
    fence even though the system prompt asks for raw Markdown. Without
    stripping, downstream parsing sees the whole page as one code-block
    line and never recognises the ``## `` heading or the ``$$`` math
    inside (exactly what happened to AG_9.1 page 16)."""
    from app.services.vision_ocr import _strip_outer_code_fence

    fenced = "```markdown\n## b)\n$$ F_A = 2756.75 \\, N $$\n```"
    stripped = _strip_outer_code_fence(fenced)
    assert stripped.startswith("## b)")
    assert "$$ F_A" in stripped
    assert "```" not in stripped


def test_strip_outer_code_fence_handles_bare_md_fence() -> None:
    """The ```md alias is also common — strip it the same way."""
    from app.services.vision_ocr import _strip_outer_code_fence

    fenced = "```md\nplain content\n```"
    assert _strip_outer_code_fence(fenced) == "plain content"


def test_strip_outer_code_fence_is_noop_for_bare_markdown() -> None:
    """Real markdown without an outer fence must pass through unchanged so
    we don't lose inline ``` code-blocks the user actually wants."""
    from app.services.vision_ocr import _strip_outer_code_fence

    bare = "## Heading\n\nSome prose.\n\n```python\nprint('hi')\n```\n"
    assert _strip_outer_code_fence(bare) == bare


def test_strip_outer_code_fence_handles_empty() -> None:
    from app.services.vision_ocr import _strip_outer_code_fence

    assert _strip_outer_code_fence("") == ""


# ── Structurally-garbled detection ──────────────────────────────────────────


def test_jumbled_formula_sheet_is_flagged_for_ocr() -> None:
    """The Formelzettel page 8 case: 1474 characters of text — passes the
    letter-count check — but pdfminer dumped the two-column table out of
    reading order, collapsing fractions and separating formulas from
    their German labels. Must trigger vision OCR retry."""
    from app.services.vision_ocr import _looks_structurally_garbled, select_pages_needing_ocr

    # Real chunk text from GdK_F2026_Formelzettel_IK-IFL.pdf page 8 after
    # NFKC normalisation, abbreviated to the formula-dense portion.
    jumbled = (
        "Schraubenberechnung / bolt calculation "
        "FZ = fZ δS + δP n δS = δK + ∑ δi + δG + δM i=1 "
        "δK = ′ lK ES ⋅ AN ′ = 0,5 ⋅ d lK ′ = 0,4 ⋅ d lK "
        "δi = li ES ⋅ Ai δG = 0,5 ⋅ d ES ⋅ A3 δM = lM EM ⋅ AN "
        "Vorspannkraftverlust / loss of preload "
        "Elastische Schraubennachgiebigkeit / elastic resilience of the bolt "
        "Nachgiebigkeit des Schraubenkopfes / resilience of the bolt head "
        "Sechskantschrauben / hexagon head bolt "
        "lM = 0,4 ⋅ d, EM = ES lM = 0,33 ⋅ d, EM = EP "
        "δP = lK EP ⋅ Aers"
    )
    assert _looks_structurally_garbled(jumbled)
    # And from the indexer's POV, this page index should be flagged.
    assert 0 in select_pages_needing_ocr([jumbled])


def test_clean_formula_sheet_is_not_flagged() -> None:
    """The same formulas in clean form (fractions intact, one formula per
    line) must NOT be flagged — pdfminer got the layout right and a
    re-OCR would just waste tokens."""
    from app.services.vision_ocr import _looks_structurally_garbled

    clean = (
        "Schraubenberechnung / bolt calculation\n"
        "FZ = fZ / (δS + δP)\n"
        "δS = δK + Σδi + δG + δM\n"
        "δK = l'K / (ES · AN)\n"
        "δi = li / (ES · Ai)\n"
        "δG = (0,5 · d) / (ES · A3)\n"
        "δM = lM / (EM · AN)\n"
        "δP = lK / (EP · Aers)\n"
    )
    assert not _looks_structurally_garbled(clean)


def test_plain_prose_with_one_formula_is_not_flagged() -> None:
    """A lecture page with a single ``F = ma`` style equation embedded in
    prose must NOT trigger vision OCR. Most of the corpus looks like this
    and OCR'ing it would burn cost for no benefit."""
    from app.services.vision_ocr import _looks_structurally_garbled

    prose = (
        "Die Schubspannung in einer Schweißnaht ergibt sich aus der "
        "wirkenden Kraft F geteilt durch die wirksame Querschnittsfläche A "
        "der Naht. Daraus folgt direkt die Beziehung τ = F / A. Diese gilt "
        "unter der Annahme idealisierter, gleichmäßig verteilter Belastung "
        "über die Naht und konstanter Materialeigenschaften. In der Praxis "
        "weichen die Bedingungen davon ab, weshalb in der Regel ein "
        "zusätzlicher Sicherheitsfaktor berücksichtigt wird."
    )
    assert not _looks_structurally_garbled(prose)


def test_value_list_without_math_signal_is_not_flagged() -> None:
    """A page of measured values (``Wert 1 = 5 mm. Wert 2 = …``) has many
    ``=`` and few ``/`` — but no Greek letters or formula operators — so
    it shouldn't be confused for a garbled formula sheet."""
    from app.services.vision_ocr import _looks_structurally_garbled

    values = (
        "Wert 1 = 0,5 mm. Wert 2 = 1,0 mm. Wert 3 = 2,0 mm. "
        "Wert 4 = 3,5 mm. Wert 5 = 5,0 mm. Wert 6 = 7,5 mm. "
        "Wert 7 = 10,0 mm. Wert 8 = 12,5 mm. Wert 9 = 15,0 mm."
    )
    assert not _looks_structurally_garbled(values)


def test_empty_or_tiny_text_is_not_flagged_by_garble_check() -> None:
    """Short pages fall through to the letter-count branch instead. The
    structural-garble heuristic refuses to make a call on < 200 chars."""
    from app.services.vision_ocr import _looks_structurally_garbled

    assert not _looks_structurally_garbled("")
    assert not _looks_structurally_garbled("F = ma")
    assert not _looks_structurally_garbled("δK = ′ lK ES ⋅ AN")  # too short alone


def test_select_pages_needing_ocr_combines_both_signals() -> None:
    """Verify the indexer-facing helper catches both failure modes:
    image-heavy / scanned (letter-starved) AND structurally-garbled."""
    from app.services.vision_ocr import select_pages_needing_ocr

    scanned = ""  # PDF extracted nothing — scanned page
    # Clean prose needs ≥80 letters to clear the original letter-count
    # check, otherwise the test isn't actually exercising the garble path.
    clean_prose = (
        "Newton's second law relates force, mass, and acceleration. "
        "In its simplest form, F = ma. This equation underlies most of "
        "classical mechanics and is taught in every introductory physics "
        "course around the world."
    )
    garbled = (
        "δK = ′ lK ES ⋅ AN ′ = 0,5 ⋅ d lK ′ = 0,4 ⋅ d lK "
        "δi = li ES ⋅ Ai δG = 0,5 ⋅ d ES ⋅ A3 δM = lM EM ⋅ AN "
        "δP = lK EP ⋅ Aers FZ = fZ δS + δP "
        "Elastische Schraubennachgiebigkeit Nachgiebigkeit des Schraubenkopfes"
    )

    flagged = select_pages_needing_ocr([scanned, clean_prose, garbled])
    assert 0 in flagged   # letter-starved
    assert 1 not in flagged  # clean
    assert 2 in flagged   # structurally garbled


# ── choose_ocr_provider (Mathpix routing) ──────────────────────────────────


def _provider_with(settings_cls, file_name, pages, bad_idx) -> str:
    with patch("app.services.vision_ocr.get_settings", lambda: settings_cls()):
        return choose_ocr_provider(file_name, pages, bad_idx)


def test_routing_off_always_openai() -> None:
    """routing='off' never picks Mathpix, even with credentials + a formula
    sheet name."""
    class S(_FakeSettings):
        mathpix_routing = "off"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    assert _provider_with(S, "Formelzettel.pdf", ["x = y " * 10], [0]) == "openai"


def test_routing_always_picks_mathpix_with_credentials() -> None:
    class S(_FakeSettings):
        mathpix_routing = "always"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    assert _provider_with(S, "lecture.pdf", ["plain prose"], [0]) == "mathpix"


def test_routing_always_falls_back_to_openai_without_credentials() -> None:
    """Mathpix requested but credentials missing → must not silently no-op;
    fall back to OpenAI vision."""
    class S(_FakeSettings):
        mathpix_routing = "always"
        mathpix_app_id = None
        mathpix_app_key = None

    assert _provider_with(S, "lecture.pdf", ["plain prose"], [0]) == "openai"


def test_formulasheet_only_matches_by_filename() -> None:
    class S(_FakeSettings):
        mathpix_routing = "formulasheet_only"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    # Filename hint wins even when the page text is empty (scanned sheet).
    assert _provider_with(S, "GdK_Formelzettel.pdf", [""], [0]) == "mathpix"
    assert _provider_with(S, "Formula_Sheet.pdf", [""], [0]) == "mathpix"


def test_formulasheet_only_matches_by_equation_density() -> None:
    """No filename hint, but the OCR'd pages are equation-dense → Mathpix."""
    class S(_FakeSettings):
        mathpix_routing = "formulasheet_only"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    dense = "a = b = c = d = e = f = g = h = i = j"  # 9 `=`
    assert _provider_with(S, "anhang.pdf", [dense], [0]) == "mathpix"


def test_formulasheet_only_skips_plain_lecture() -> None:
    """No filename hint and sparse equations → stays on OpenAI vision."""
    class S(_FakeSettings):
        mathpix_routing = "formulasheet_only"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    prose = "Eine Vorlesungsfolie mit nur einer Gleichung F = ma im Text."
    assert _provider_with(S, "vorlesung_03.pdf", [prose], [0]) == "openai"


def test_formulasheet_only_empty_pages_without_name_hint_use_openai() -> None:
    """Scanned page (empty text) with no formula-sheet filename: we have no
    signal it's formula-heavy, so don't pay Mathpix — use OpenAI vision."""
    class S(_FakeSettings):
        mathpix_routing = "formulasheet_only"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    assert _provider_with(S, "scan_001.pdf", [""], [0]) == "openai"


def test_unknown_routing_value_defaults_to_openai() -> None:
    class S(_FakeSettings):
        mathpix_routing = "bogus"
        mathpix_app_id = "id"
        mathpix_app_key = "key"

    assert _provider_with(S, "Formelzettel.pdf", ["a = b = c = d = e = f = g = h = i"], [0]) == "openai"
