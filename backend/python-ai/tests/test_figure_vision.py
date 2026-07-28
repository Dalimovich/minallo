"""Tests for answer-time figure vision: rendering exercise/figure page images
so the tutor can read dimensions straight off the drawing.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import answer_stream as ast  # noqa: E402
from app.services import vision_ocr as vo  # noqa: E402
from app.services.retrieval import RetrievedChunk  # noqa: E402


def _chunk(cid, doc, page, ctype="text", synthetic=False):
    return RetrievedChunk(
        chunk_id=cid, document_id=doc, page_start=page, page_end=page,
        text="x", score=1.0, similarity=0.5, chunk_type=ctype,
        section_title=None, is_synthetic=synthetic,
    )


class _Res:
    def __init__(self, data):
        self.data = data


class _Q:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *a, **k):
        return self

    def in_(self, *a, **k):
        return self

    def execute(self):
        return _Res(self._rows)


class _SB:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        return _Q(self._rows)


def _patch_render_ok(monkeypatch, rows):
    monkeypatch.setenv("MINALLO_FIGURE_VISION", "1")
    monkeypatch.setattr(ast, "get_supabase", lambda: _SB(rows))
    monkeypatch.setattr(ast, "download_document_bytes", lambda sp: b"%PDF-fake")
    monkeypatch.setattr(vo, "_try_import_pypdfium2", lambda: object())
    monkeypatch.setattr(vo, "_render_page_to_png", lambda pdfium, b, idx, dpi: b"PNGDATA-" + str(idx).encode())


def test_attaches_exercise_figure_page(monkeypatch):
    rows = [{"id": "d1", "storage_path": "course/d1.pdf"}]
    _patch_render_ok(monkeypatch, rows)
    chunks = [_chunk("c1", "d1", 3, "exercise")]
    parts = ast._figure_page_image_parts(chunks, max_images=2)
    assert len(parts) == 1
    assert parts[0]["type"] == "image_url"
    assert parts[0]["image_url"]["url"].startswith("data:image/png;base64,")


def test_prefers_figure_chunks_and_dedups_pages(monkeypatch):
    rows = [{"id": "d1", "storage_path": "course/d1.pdf"}]
    _patch_render_ok(monkeypatch, rows)
    rendered: list[int] = []
    monkeypatch.setattr(vo, "_render_page_to_png",
                        lambda pdfium, b, idx, dpi: (rendered.append(idx) or b"PNG"))
    chunks = [
        _chunk("c1", "d1", 1, "text"),       # plain text page 1
        _chunk("c2", "d1", 5, "exercise"),   # figure/exercise page 5 — preferred
        _chunk("c3", "d1", 5, "diagram"),    # same page 5 — deduped
    ]
    parts = ast._figure_page_image_parts(chunks, max_images=1)
    assert len(parts) == 1
    # figure/exercise page (5 → 0-based 4) rendered first, not text page 1
    assert rendered == [4]


def test_multi_page_exercise_renders_both_ends(monkeypatch):
    # A "pp.1-3" exercise chunk: statement on page 1, figure on page 3.
    # Both ends should be rendered (0-based 0 and 2), capped at max_images.
    rows = [{"id": "d1", "storage_path": "course/d1.pdf"}]
    _patch_render_ok(monkeypatch, rows)
    rendered: list[int] = []
    monkeypatch.setattr(vo, "_render_page_to_png",
                        lambda pdfium, b, idx, dpi: (rendered.append(idx) or b"PNG"))
    chunk = RetrievedChunk(
        chunk_id="c1", document_id="d1", page_start=1, page_end=3,
        text="x", score=1.0, similarity=0.5, chunk_type="exercise",
        section_title=None,
    )
    parts = ast._figure_page_image_parts([chunk], max_images=2)
    assert len(parts) == 2
    assert rendered == [0, 2]


def test_skips_synthetic_and_pageless(monkeypatch):
    rows = [{"id": "d1", "storage_path": "course/d1.pdf"}]
    _patch_render_ok(monkeypatch, rows)
    chunks = [
        _chunk("s1", "__open__", 2, "exercise"),       # synthetic-ish doc id
        _chunk("s2", "d1", None, "exercise"),          # no page
        _chunk("s3", "d1", 2, "exercise", synthetic=True),  # synthetic
    ]
    assert ast._figure_page_image_parts(chunks, max_images=2) == []


def test_disabled_via_env(monkeypatch):
    rows = [{"id": "d1", "storage_path": "course/d1.pdf"}]
    _patch_render_ok(monkeypatch, rows)
    monkeypatch.setenv("MINALLO_FIGURE_VISION", "0")
    chunks = [_chunk("c1", "d1", 3, "exercise")]
    assert ast._figure_page_image_parts(chunks, max_images=2) == []


def test_no_storage_path_yields_nothing(monkeypatch):
    _patch_render_ok(monkeypatch, rows=[{"id": "d1", "storage_path": None}])
    chunks = [_chunk("c1", "d1", 3, "exercise")]
    assert ast._figure_page_image_parts(chunks, max_images=2) == []
