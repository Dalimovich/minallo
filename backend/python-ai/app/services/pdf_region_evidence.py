"""Authoritative evidence extraction for a user-selected PDF region.

Client text and hashes are hints only.  This module reopens the exact stored
PDF revision, extracts positioned glyphs, renders the selected crop, and
produces a server-owned fingerprint used by generation, verification and
caching.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTContainer

from .storage import download_document_bytes
from .vision_ocr import _render_page_to_png, _try_import_pypdfium2

log = logging.getLogger(__name__)

_NUMBER = r"[+\-−–]?(?:\d+(?:[.,]\d+)?(?:[eE][+\-]?\d+)?|\d*[.,]\d+)"
_CRITICAL_RE = re.compile(
    rf"{_NUMBER}|"
    r"(?<![A-Za-z])(?:m/s|m/min|mm|cm|dm|km|m|µm|μm|nm|kg|g|mg|s|min|h|Hz|N|kN|"
    r"Pa|MPa|GPa|J|W|V|A|rad|°|%|π|alpha|beta|gamma|delta|sigma|tau|omega|phi|rho)"
    r"(?![A-Za-z])|"
    r"(?:[A-Za-zΑ-Ωα-ωµμØø][A-Za-z0-9_²³⁰¹⁴⁵⁶⁷⁸⁹₀-₉]*)",
    re.IGNORECASE,
)
_DIAMETER_RE = re.compile(r"(?:[Øø⌀]|\\varnothing|diam(?:eter)?|durchmesser)", re.IGNORECASE)
_EXERCISE_RE = re.compile(
    r"\b(?:Aufgabe|Übung|Uebung|Question|Exercise|Task)\s*"
    r"(\d+(?:[.,]\d+){0,3}[a-z]?)\b",
    re.IGNORECASE,
)


class RegionEvidenceError(ValueError):
    """A selected region cannot safely be used as evidence."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PdfRegionEvidence:
    document_id: str
    document_revision: str
    page: int
    bbox: tuple[float, float, float, float]
    text: str
    critical_tokens: tuple[str, ...]
    exercise_id: str | None
    crop_sha256: str
    evidence_sha256: str
    text_confidence: float
    region_confidence: float
    client_text_agreement: float | None
    vision_text: str
    vision_confidence: float
    vision_model: str
    vision_cache_hit: bool
    extraction_method: str = "pdf_text_geometry+vision_crop"
    status: str = "verified"

    @property
    def id(self) -> str:
        return f"pdf-region:{self.evidence_sha256[:24]}"

    def prompt_text(self) -> str:
        return self.text.strip()

    def citation(self, file_name: str) -> dict[str, Any]:
        return {
            "index": 0,
            "file_name": file_name,
            "documentId": self.document_id,
            "pageStart": self.page,
            "pageEnd": self.page,
            "pages": str(self.page),
            "section": self.exercise_id,
            "evidenceId": self.id,
            "documentRevision": self.document_revision,
            "bbox": list(self.bbox),
            "confidence": self.region_confidence,
        }

    def provenance(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "document_id": self.document_id,
            "document_revision": self.document_revision,
            "page": self.page,
            "bbox": list(self.bbox),
            "crop_sha256": self.crop_sha256,
            "evidence_sha256": self.evidence_sha256,
            "critical_tokens": list(self.critical_tokens),
            "exercise_id": self.exercise_id,
            "text_confidence": self.text_confidence,
            "region_confidence": self.region_confidence,
            "client_text_agreement": self.client_text_agreement,
            "vision_text_sha256": hashlib.sha256(
                self.vision_text.encode("utf-8")
            ).hexdigest(),
            "vision_confidence": self.vision_confidence,
            "vision_model": self.vision_model,
            "vision_cache_hit": self.vision_cache_hit,
            "extraction_method": self.extraction_method,
        }


@dataclass(frozen=True)
class _Glyph:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float


def _walk_chars(node: Any) -> Iterable[LTChar]:
    if isinstance(node, LTChar):
        yield node
        return
    if isinstance(node, LTContainer):
        for child in node:
            yield from _walk_chars(child)


def _normalise_token(token: str) -> str:
    value = unicodedata.normalize("NFKC", token).strip().lower()
    value = value.replace("−", "-").replace("–", "-").replace("µ", "μ")
    value = re.sub(r"(?<=\d),(?=\d)", ".", value)
    if re.fullmatch(r"[a-zα-ωμø]+(?:_[a-z0-9]+)+", value):
        # A PDF text layer commonly flattens typographic subscripts (`v_c` ->
        # `vc`). This canonical form compares the same glyph sequence without
        # treating an OCR-preserved underscore as a different variable.
        value = value.replace("_", "")
    return value


def critical_tokens(text: str) -> tuple[str, ...]:
    formatting_tokens = {"text", "mathrm", "mathbf", "mathit", "operatorname"}
    tokens = [
        token
        for token in (
            _normalise_token(match.group(0))
            for match in _CRITICAL_RE.finditer(text or "")
        )
        if token not in formatting_tokens
    ]
    if _DIAMETER_RE.search(text or ""):
        tokens.append("diameter")
    exercise = _EXERCISE_RE.search(text or "")
    if exercise:
        tokens.append(f"exercise:{_normalise_token(exercise.group(1))}")
    return tuple(tokens)


def canonical_pdf_bbox(
    bbox: tuple[float, float, float, float],
    page_rotation: int = 0,
) -> tuple[float, float, float, float]:
    """Map normalized browser coordinates on a rotated page back to PDF space."""
    left, top, right, bottom = bbox
    rotation = page_rotation % 360
    if rotation == 0:
        mapped = (left, top, right, bottom)
    elif rotation == 90:
        mapped = (top, 1 - right, bottom, 1 - left)
    elif rotation == 180:
        mapped = (1 - right, 1 - bottom, 1 - left, 1 - top)
    elif rotation == 270:
        mapped = (1 - bottom, left, 1 - top, right)
    else:
        raise RegionEvidenceError(
            "invalid_region", "PDF page rotation must be a multiple of 90"
        )
    return tuple(round(max(0.0, min(1.0, value)), 8) for value in mapped)


def _token_agreement(expected: tuple[str, ...], observed: tuple[str, ...]) -> float:
    if not expected and not observed:
        return 1.0
    if not expected or not observed:
        return 0.0
    # Preserve multiplicity: repeated values can be meaningful in formulas.
    remaining = list(observed)
    matches = 0
    for token in expected:
        if token in remaining:
            remaining.remove(token)
            matches += 1
    return matches / max(len(expected), len(observed))


def _extract_region_text(
    pdf_bytes: bytes,
    page_number: int,
    bbox: tuple[float, float, float, float],
) -> tuple[str, float]:
    page_layout = None
    for index, layout in enumerate(extract_pages(io.BytesIO(pdf_bytes))):
        if index == page_number - 1:
            page_layout = layout
            break
    if page_layout is None:
        raise RegionEvidenceError("page_not_found", "selected PDF page does not exist")

    width = float(getattr(page_layout, "width", 0) or 0)
    height = float(getattr(page_layout, "height", 0) or 0)
    if width <= 0 or height <= 0:
        raise RegionEvidenceError("invalid_pdf_geometry", "PDF page geometry is unavailable")

    left, top, right, bottom = bbox
    # A small tolerance captures glyph edges and superscripts without pulling
    # neighbouring answer choices into a narrow selection.
    pad_x = min(0.008, max(0.0015, (right - left) * 0.04))
    pad_y = min(0.008, max(0.0015, (bottom - top) * 0.08))
    left, top = max(0.0, left - pad_x), max(0.0, top - pad_y)
    right, bottom = min(1.0, right + pad_x), min(1.0, bottom + pad_y)

    glyphs: list[_Glyph] = []
    for char in _walk_chars(page_layout):
        value = char.get_text()
        if not value or value.isspace():
            continue
        x0, y0, x1, y1 = (float(v) for v in char.bbox)
        glyph = _Glyph(value, x0 / width, (height - y1) / height, x1 / width, (height - y0) / height)
        centre_x = (glyph.x0 + glyph.x1) / 2
        centre_y = (glyph.top + glyph.bottom) / 2
        if left <= centre_x <= right and top <= centre_y <= bottom:
            glyphs.append(glyph)
    if not glyphs:
        raise RegionEvidenceError("region_unreadable", "no PDF text was found in the selected region")

    glyphs.sort(key=lambda item: (round(item.top, 3), item.x0))
    lines: list[list[_Glyph]] = []
    for glyph in glyphs:
        if not lines:
            lines.append([glyph])
            continue
        current_y = sum(item.top for item in lines[-1]) / len(lines[-1])
        if abs(glyph.top - current_y) > max(0.006, (glyph.bottom - glyph.top) * 0.7):
            lines.append([glyph])
        else:
            lines[-1].append(glyph)

    rendered_lines: list[str] = []
    for line in lines:
        line.sort(key=lambda item: item.x0)
        parts: list[str] = []
        prior: _Glyph | None = None
        for glyph in line:
            if prior and glyph.x0 - prior.x1 > max(0.0025, (prior.x1 - prior.x0) * 0.35):
                parts.append(" ")
            parts.append(glyph.text)
            prior = glyph
        rendered_lines.append("".join(parts).strip())
    text = "\n".join(line for line in rendered_lines if line).strip()
    readable = sum(ch.isalnum() or ch in ".,:+-−=/%°µμØøπ²³_()" for ch in text)
    confidence = min(0.99, max(0.0, readable / max(1, len(text))))
    return text, confidence


def _render_crop(
    pdf_bytes: bytes,
    page_number: int,
    bbox: tuple[float, float, float, float],
) -> bytes:
    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        raise RegionEvidenceError("renderer_unavailable", "server PDF renderer is unavailable")
    png = _render_page_to_png(pdfium, pdf_bytes, page_number - 1, 220)
    if not png:
        raise RegionEvidenceError("render_failed", "selected PDF page could not be rendered")
    try:
        from PIL import Image

        with Image.open(io.BytesIO(png)) as image:
            left, top, right, bottom = bbox
            x0, y0 = int(left * image.width), int(top * image.height)
            x1, y1 = int(right * image.width), int(bottom * image.height)
            margin_x = max(3, int(image.width * 0.004))
            margin_y = max(3, int(image.height * 0.004))
            crop = image.crop((
                max(0, x0 - margin_x),
                max(0, y0 - margin_y),
                min(image.width, x1 + margin_x),
                min(image.height, y1 + margin_y),
            ))
            if crop.width < 4 or crop.height < 4:
                raise RegionEvidenceError("region_too_small", "selected PDF region is too small")
            output = io.BytesIO()
            crop.convert("RGB").save(output, format="PNG", optimize=True)
            return output.getvalue()
    except RegionEvidenceError:
        raise
    except Exception as exc:
        raise RegionEvidenceError("crop_failed", "selected PDF crop could not be produced") from exc


def verify_pdf_region(
    *,
    document: dict[str, Any],
    page: int,
    bbox: tuple[float, float, float, float],
    claimed_revision: str | None,
    client_text: str | None,
    page_rotation: int = 0,
    vision_recognizer: Any | None = None,
) -> PdfRegionEvidence:
    """Return verified server-owned evidence or fail closed."""
    if page < 1:
        raise RegionEvidenceError("page_not_found", "selected PDF page does not exist")
    if len(bbox) != 4:
        raise RegionEvidenceError("invalid_region", "selected PDF coordinates are invalid")
    left, top, right, bottom = (float(value) for value in bbox)
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
        raise RegionEvidenceError("invalid_region", "selected PDF coordinates are invalid")
    storage_path = str(document.get("storage_path") or "")
    if not storage_path:
        raise RegionEvidenceError("document_unavailable", "stored PDF is unavailable")
    pdf_bytes = download_document_bytes(storage_path)
    actual_revision = hashlib.sha256(pdf_bytes).hexdigest()
    row_revision = str(document.get("document_hash") or "")
    if row_revision and row_revision != actual_revision:
        raise RegionEvidenceError("document_replaced", "stored PDF changed after indexing")
    if claimed_revision and claimed_revision != actual_revision:
        raise RegionEvidenceError("stale_selection", "PDF selection belongs to an older revision")

    canonical_bbox = canonical_pdf_bbox(
        (left, top, right, bottom),
        page_rotation,
    )
    pdf_text, text_confidence = _extract_region_text(pdf_bytes, page, canonical_bbox)
    crop = _render_crop(pdf_bytes, page, canonical_bbox)
    crop_sha256 = hashlib.sha256(crop).hexdigest()
    pdf_tokens = critical_tokens(pdf_text)
    client_agreement: float | None = None
    if client_text and client_text.strip():
        client_tokens = critical_tokens(client_text)
        client_agreement = _token_agreement(pdf_tokens, client_tokens)
        if pdf_tokens and client_agreement < 1.0:
            raise RegionEvidenceError(
                "critical_token_mismatch",
                "browser text disagrees with the stored PDF selection",
            )
        normalised_pdf = re.sub(r"\s+", " ", pdf_text).strip().casefold()
        normalised_client = re.sub(r"\s+", " ", client_text).strip().casefold()
        if not pdf_tokens and normalised_client not in normalised_pdf and normalised_pdf not in normalised_client:
            raise RegionEvidenceError(
                "selection_text_mismatch",
                "browser text disagrees with the stored PDF selection",
            )

    using_persistent_recognizer = vision_recognizer is None
    if using_persistent_recognizer:
        from .region_ocr import recognize_region

        vision_recognizer = recognize_region
    region_key = hashlib.sha256(
        ",".join(f"{value:.6f}" for value in canonical_bbox).encode("ascii")
    ).hexdigest()
    try:
        vision = vision_recognizer(
            user_id=str(document.get("user_id") or ""),
            course_id=str(document.get("course_id") or ""),
            document_id=str(document.get("id") or ""),
            document_revision=actual_revision,
            index_revision=str(document.get("active_index_revision") or ""),
            page_number=page,
            region_key=region_key,
            crop_sha256=crop_sha256,
            crop_png=crop,
            render_dpi=220,
        )
    except Exception as exc:
        code = str(getattr(exc, "code", "") or "region_ocr_failed")
        raise RegionEvidenceError(code, "selected PDF crop could not be verified") from exc

    vision_text = str(getattr(vision, "text", "") or "").strip()
    vision_tokens = critical_tokens(vision_text)
    token_agreement = _token_agreement(pdf_tokens, vision_tokens)
    pdf_numbers = tuple(_normalise_token(value) for value in re.findall(_NUMBER, pdf_text))
    vision_numbers = tuple(_normalise_token(value) for value in re.findall(_NUMBER, vision_text))
    disagreement = {
        "pdf_numbers": list(pdf_numbers),
        "vision_numbers": list(vision_numbers),
        "token_agreement": round(token_agreement, 4),
    }
    if using_persistent_recognizer:
        try:
            from .region_ocr import store_region_comparison

            store_region_comparison(
                user_id=str(document.get("user_id") or ""),
                document_id=str(document.get("id") or ""),
                document_revision=actual_revision,
                index_revision=str(document.get("active_index_revision") or ""),
                page_number=page,
                region_key=region_key,
                render_dpi=220,
                model=str(getattr(vision, "model", "") or ""),
                critical_tokens=vision_tokens,
                disagreement=disagreement,
            )
        except Exception:
            # Recognition remains usable; comparison metadata persistence is
            # diagnostic and must not trigger a second paid OCR call.
            log.warning("Could not persist region OCR comparison metadata", exc_info=True)
    if pdf_numbers != vision_numbers or token_agreement < 0.65:
        raise RegionEvidenceError(
            "critical_token_disagreement",
            "PDF text and crop recognition disagree on critical tokens",
        )

    # Text-layer extraction and an independent crop recognition must agree.
    # Weak glyph recovery is never promoted to Source 0.
    vision_confidence = float(getattr(vision, "confidence", 0) or 0)
    region_confidence = min(text_confidence, vision_confidence, 0.98)
    if region_confidence < 0.75 or not pdf_text.strip():
        raise RegionEvidenceError("region_unreadable", "selected PDF region is ambiguous")
    exercise = _EXERCISE_RE.search(pdf_text)
    evidence_material = "|".join((
        str(document.get("id") or ""),
        actual_revision,
        str(page),
        ",".join(f"{value:.6f}" for value in canonical_bbox),
        crop_sha256,
        pdf_text,
    ))
    evidence_sha256 = hashlib.sha256(evidence_material.encode("utf-8")).hexdigest()
    return PdfRegionEvidence(
        document_id=str(document.get("id") or ""),
        document_revision=actual_revision,
        page=page,
        bbox=canonical_bbox,
        text=pdf_text,
        critical_tokens=pdf_tokens,
        exercise_id=exercise.group(1).replace(",", ".") if exercise else None,
        crop_sha256=crop_sha256,
        evidence_sha256=evidence_sha256,
        text_confidence=text_confidence,
        region_confidence=region_confidence,
        client_text_agreement=client_agreement,
        vision_text=vision_text,
        vision_confidence=vision_confidence,
        vision_model=str(getattr(vision, "model", "") or ""),
        vision_cache_hit=bool(getattr(vision, "cache_hit", False)),
    )


__all__ = [
    "PdfRegionEvidence",
    "RegionEvidenceError",
    "canonical_pdf_bbox",
    "critical_tokens",
    "verify_pdf_region",
]
