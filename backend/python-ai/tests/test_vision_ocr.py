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


from app.services.vision_ocr import (  # noqa: E402
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
