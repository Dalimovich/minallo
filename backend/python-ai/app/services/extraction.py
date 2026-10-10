"""PDF text extraction via pdfminer.six.

Returns one cleaned string per page so the chunker can stamp page_start /
page_end on every chunk. No OCR fallback in v1 — scanned PDFs yield empty
pages and the indexer marks the doc as failed with a clear reason.
"""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

log = logging.getLogger(__name__)


@dataclass
class TextBlock:
    """One text-layer block with its position on the page.

    ``bbox`` is ``(left, top, right, bottom)`` NORMALISED to 0..1 with a
    TOP-LEFT origin — render-independent, so a frontend can draw a highlight
    overlay on a rendered page image without needing the PDF's point size.
    (pdfminer's native coordinates are bottom-left; we flip Y here.)

    Only produced for text-layer pages — scanned / OCR'd pages have no
    reliable text-layer coordinates.
    """

    text: str
    bbox: tuple[float, float, float, float]

    def to_json(self) -> dict[str, object]:
        return {"t": self.text, "bbox": list(self.bbox)}


_WHITESPACE = re.compile(r"[ \t]+")
_MULTI_NEWLINE = re.compile(r"\n{3,}")
# pdfminer emits "(cid:NN)" for glyphs whose font lacks a ToUnicode map —
# common for math symbols (∫ → "(cid:90)", vector arrow → "(cid:126)") and
# ligature fonts. They're noise to every downstream consumer (chunking,
# embeddings, formula detection), so strip them at the source.
_CID_ARTIFACT = re.compile(r"\(cid:\d+\)")


def _clean_page_text(raw: str) -> str:
    """Tidy a single page's text — collapse spaces, normalise newlines.

    Deliberately minimal: aggressive cleaning is the chunker's job.
    """
    if not raw:
        return ""
    # Normalise CRLF, drop NUL bytes (pdfminer occasionally emits them).
    text = raw.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    # Drop unmapped-glyph artifacts like "(cid:90)".
    text = _CID_ARTIFACT.sub("", text)
    # Collapse runs of spaces/tabs (preserves single line breaks).
    text = "\n".join(_WHITESPACE.sub(" ", line).strip() for line in text.split("\n"))
    # Cap any wall of blank lines at 2 newlines = one paragraph break.
    text = _MULTI_NEWLINE.sub("\n\n", text)
    return text.strip()


def _clean_block_text(raw: str) -> str:
    """Collapse one text block to a single tidy line (CID artifacts stripped).

    Block text is for search/citation anchoring, so internal line wraps don't
    matter — a single line keeps it compact in the stored JSON."""
    if not raw:
        return ""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _CID_ARTIFACT.sub("", text)
    return _WHITESPACE.sub(" ", text.replace("\n", " ")).strip()


def _normalise_bbox(
    x0: float, y0: float, x1: float, y1: float, width: float, height: float
) -> tuple[float, float, float, float]:
    """pdfminer bbox (bottom-left origin) → (left, top, right, bottom) in 0..1
    top-left coordinates, clamped and rounded."""
    width = width or 1.0
    height = height or 1.0

    def _clamp(v: float) -> float:
        return round(min(max(v, 0.0), 1.0), 4)

    return (
        _clamp(x0 / width),
        _clamp((height - y1) / height),  # top  (y1 is the upper edge bottom-up)
        _clamp(x1 / width),
        _clamp((height - y0) / height),  # bottom
    )


def extract_pages_text(pdf_bytes: bytes) -> list[str]:
    """Return cleaned text for every page in document order.

    Empty / image-only pages return an empty string in their slot so the
    caller still knows how many pages the PDF has.
    """
    if not pdf_bytes:
        return []

    pages: list[str] = []
    try:
        for page_layout in extract_pages(io.BytesIO(pdf_bytes)):
            parts: list[str] = []
            for element in page_layout:
                if isinstance(element, LTTextContainer):
                    parts.append(element.get_text())
            pages.append(_clean_page_text("".join(parts)))
    except Exception:
        log.exception("pdfminer extract_pages failed")
        raise

    return pages


def extract_pages_with_blocks(
    pdf_bytes: bytes,
) -> tuple[list[str], list[list[TextBlock]]]:
    """Single-pass extraction returning BOTH the per-page cleaned text (exactly
    what ``extract_pages_text`` returns) AND per-page text blocks with
    normalised bounding boxes.

    The indexer uses this so the bbox coordinates come for free from the one
    pdfminer layout pass it already pays for — no second parse. ``page_text``
    here is assembled identically to ``extract_pages_text``; the parity test
    locks them together.
    """
    if not pdf_bytes:
        return [], []

    pages: list[str] = []
    blocks_per_page: list[list[TextBlock]] = []
    try:
        for page_layout in extract_pages(io.BytesIO(pdf_bytes)):
            width = float(getattr(page_layout, "width", 0) or 0)
            height = float(getattr(page_layout, "height", 0) or 0)
            parts: list[str] = []
            blocks: list[TextBlock] = []
            for element in page_layout:
                if not isinstance(element, LTTextContainer):
                    continue
                raw = element.get_text()
                parts.append(raw)
                block_text = _clean_block_text(raw)
                if not block_text:
                    continue
                try:
                    x0, y0, x1, y1 = element.bbox
                    bbox = _normalise_bbox(x0, y0, x1, y1, width, height)
                    blocks.append(TextBlock(block_text, bbox))
                except Exception:  # noqa: BLE001 — never let a bad bbox break text
                    log.debug("skipping block bbox on page %d", len(pages) + 1)
            pages.append(_clean_page_text("".join(parts)))
            blocks_per_page.append(blocks)
    except Exception:
        log.exception("pdfminer extract_pages failed")
        raise

    return pages, blocks_per_page
