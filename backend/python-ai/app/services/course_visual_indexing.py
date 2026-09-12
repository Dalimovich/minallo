"""Extract meaningful region crops and persist revision-safe CourseVisual rows."""

from __future__ import annotations

import hashlib
import io
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any

from .embeddings import embed_texts

log = logging.getLogger(__name__)

VISUAL_SCHEMA_VERSION = 1
_CAPTION_RE = re.compile(r"^(?:fig(?:ure)?\.?|abb(?:ildung)?\.?|bild|table|tabelle|diagramm|graph)\s*\d*", re.I)
_TABLE_RE = re.compile(r"\b(table|tabelle|matrix|classification|klassifikation|einteilung)\b", re.I)
_GRAPH_RE = re.compile(r"\b(graph|curve|plot|diagramm|kennlinie|achse|axis)\b", re.I)
_FLOW_RE = re.compile(r"\b(flowchart|ablauf|prozessfolge|workflow|sequence)\b", re.I)
_FORMULA_RE = re.compile(r"(?:[=∑∫√λσμε]|\b(?:formula|equation|formel|gleichung)\b)", re.I)
_WORKED_RE = re.compile(r"\b(worked example|solution|example|beispiel|lösung|rechnung)\b", re.I)
_DECORATIVE_RE = re.compile(r"\b(university|universität|institute|institut|copyright|www\.|page \d+|seite \d+)\b", re.I)


@dataclass(frozen=True)
class VisualRegion:
    page_number: int
    visual_type: str
    bbox: dict[str, float]
    caption: str
    nearby_text: str
    section_title: str | None
    labels: list[str]
    topics: list[str]
    description: str
    quality: float


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _bbox(raw: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    left, top, right, bottom = (float(value) for value in raw)
    if right <= left or bottom <= top:
        return None
    return _clamp(left), _clamp(top), _clamp(right), _clamp(bottom)


def _visual_type(text: str) -> str:
    if _TABLE_RE.search(text): return "table"
    if _GRAPH_RE.search(text): return "graph"
    if _FLOW_RE.search(text): return "flowchart"
    if _WORKED_RE.search(text): return "worked_example"
    if _FORMULA_RE.search(text): return "formula_region"
    return "diagram"


def _topics(text: str) -> list[str]:
    candidates = re.findall(r"\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9-]{3,}(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9-]{3,}){0,3}", text)
    return list(dict.fromkeys(item.strip() for item in candidates if not _DECORATIVE_RE.search(item)))[:8]


def detect_visual_regions(
    pages: list[str],
    page_blocks: list[list[Any]],
    page_sections: list[str | None] | None = None,
) -> list[VisualRegion]:
    regions: list[VisualRegion] = []
    for page_index, blocks in enumerate(page_blocks):
        page_text = pages[page_index] if page_index < len(pages) else ""
        section = page_sections[page_index] if page_sections and page_index < len(page_sections) else None
        for block in blocks or []:
            text = str(getattr(block, "text", None) or getattr(block, "t", None) or (block.get("t") if isinstance(block, dict) else "") or "").strip()
            raw_box = getattr(block, "bbox", None) or (block.get("bbox") if isinstance(block, dict) else None)
            box = _bbox(raw_box)
            if not text or not box or _DECORATIVE_RE.search(text) or len(text) > 700:
                continue
            left, top, right, bottom = box
            is_caption = bool(_CAPTION_RE.search(text))
            is_structured = bool(_TABLE_RE.search(text) or _GRAPH_RE.search(text) or _FLOW_RE.search(text) or _WORKED_RE.search(text))
            is_formula = bool(_FORMULA_RE.search(text) and len(text) < 300)
            if not (is_caption or is_structured or is_formula):
                continue
            if bottom < 0.07 or top > 0.93:
                continue
            if is_caption:
                crop_top, crop_bottom = max(0.04, top - 0.48), min(0.96, bottom + 0.05)
                crop_left, crop_right = max(0.02, left - 0.08), min(0.98, right + 0.08)
            else:
                crop_top, crop_bottom = max(0.04, top - 0.07), min(0.96, bottom + 0.07)
                crop_left, crop_right = max(0.02, left - 0.05), min(0.98, right + 0.05)
            if (crop_right - crop_left) * (crop_bottom - crop_top) < 0.025:
                continue
            nearby = page_text[max(0, page_text.find(text) - 350):page_text.find(text) + len(text) + 500] if text in page_text else text
            topic_values = _topics(" ".join(filter(None, [section, text, nearby])))
            description = "; ".join(filter(None, [section, text, nearby[:500]]))[:1200]
            regions.append(VisualRegion(
                page_number=page_index + 1,
                visual_type=_visual_type(text),
                bbox={"x": crop_left, "y": crop_top, "width": crop_right - crop_left, "height": crop_bottom - crop_top},
                caption=text if is_caption else "",
                nearby_text=nearby[:1200],
                section_title=section,
                labels=topic_values[:6],
                topics=topic_values,
                description=description,
                quality=0.86 if is_caption else 0.72,
            ))
    unique: dict[tuple[int, str], VisualRegion] = {}
    for region in regions:
        key = (region.page_number, hashlib.sha256(str(sorted(region.bbox.items())).encode()).hexdigest()[:16])
        unique.setdefault(key, region)
    return list(unique.values())[:80]


def _crop_bytes(pdf_bytes: bytes, region: VisualRegion) -> tuple[bytes, str]:
    import pypdfium2 as pdfium
    from PIL import Image
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        page = pdf[region.page_number - 1]
        image = page.render(scale=1.7).to_pil().convert("RGB")
        box = region.bbox
        crop = image.crop((
            int(box["x"] * image.width), int(box["y"] * image.height),
            int((box["x"] + box["width"]) * image.width),
            int((box["y"] + box["height"]) * image.height),
        ))
        crop.thumbnail((1200, 900), Image.Resampling.LANCZOS)
        gray = crop.resize((8, 8)).convert("L")
        pixels = list(gray.getdata())
        average = sum(pixels) / max(1, len(pixels))
        perceptual_hash = f"{sum((1 << idx) for idx, value in enumerate(pixels) if value >= average):016x}"
        output = io.BytesIO()
        crop.save(output, format="WEBP", quality=84, method=4)
        return output.getvalue(), perceptual_hash
    finally:
        pdf.close()


def index_course_visuals(
    *, sb: Any, pdf_bytes: bytes, user_id: str, course_id: str,
    document_id: str, document_revision: str, pages: list[str],
    page_blocks: list[list[Any]], page_sections: list[str | None] | None = None,
) -> int:
    regions = detect_visual_regions(pages, page_blocks, page_sections)
    sb.table("course_visuals").delete().eq("document_id", document_id).neq("document_revision", document_revision).execute()
    if not regions:
        return 0
    embeddings = embed_texts([region.description for region in regions])
    rows = []
    for region, embedding in zip(regions, embeddings):
        visual_id = str(uuid.uuid4())
        region_hash = hashlib.sha256(
            f"{region.page_number}:{sorted(region.bbox.items())}:{region.caption}".encode()
        ).hexdigest()
        image_bytes, perceptual_hash = _crop_bytes(pdf_bytes, region)
        path = f"{user_id}/{course_id}/{document_id}/{document_revision}/{visual_id}.webp"
        sb.storage.from_("course-visuals").upload(path, image_bytes, {"content-type": "image/webp", "upsert": "true"})
        rows.append({
            "id": visual_id, "user_id": user_id, "course_id": course_id,
            "document_id": document_id, "document_revision": document_revision,
            "page_number": region.page_number, "visual_type": region.visual_type,
            "bounding_box": region.bbox, "caption": region.caption or None,
            "nearby_text": region.nearby_text, "section_title": region.section_title,
            "detected_labels": region.labels, "detected_topics": region.topics,
            "ocr_text": region.nearby_text if region.visual_type in {"formula_region", "table"} else None,
            "visual_description": region.description, "quality_score": region.quality,
            "relevance_embedding": embedding, "storage_path": path,
            "thumbnail_path": path, "perceptual_hash": perceptual_hash,
            "region_hash": region_hash, "extraction_schema_version": VISUAL_SCHEMA_VERSION,
        })
    if rows:
        sb.table("course_visuals").upsert(rows, on_conflict="document_id,document_revision,page_number,region_hash").execute()
    return len(rows)


__all__ = ("VISUAL_SCHEMA_VERSION", "VisualRegion", "detect_visual_regions", "index_course_visuals")
