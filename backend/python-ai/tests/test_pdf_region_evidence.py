from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

import pytest

from app.services import pdf_region_evidence as evidence
from app.services.region_ocr import RegionOcrResult, _region_confidence

_BUILDER_PATH = Path(__file__).parent / "fixtures" / "public_eval" / "build_public_pdf.py"
_SPEC = importlib.util.spec_from_file_location("minallo_public_pdf_builder", _BUILDER_PATH)
assert _SPEC and _SPEC.loader
_BUILDER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_BUILDER)
build_pdf = _BUILDER.build_pdf


def test_short_region_recognition_is_not_marked_weak_for_length() -> None:
    confidence, needs_review = _region_confidence("11")
    assert confidence >= 0.9
    assert needs_review is False


def test_region_recognition_marks_explicit_uncertainty_for_review() -> None:
    confidence, needs_review = _region_confidence("[unclear] 10 or 11")
    assert confidence < 0.9
    assert needs_review is True


def _pdf() -> bytes:
    return build_pdf([
        (72, 700, 16, "Exercise 13.11"),
        (72, 670, 16, "Cutting speed vc = 580 m/min"),
        (72, 640, 14, "Diameter D = 40 mm"),
    ])


def _document(pdf: bytes) -> dict[str, str]:
    return {
        "id": "00000000-0000-4000-8000-000000000001",
        "storage_path": "synthetic/evidence.pdf",
        "document_hash": hashlib.sha256(pdf).hexdigest(),
        "user_id": "00000000-0000-4000-8000-000000000010",
        "course_id": "public-eval",
    }


def _recognize_580(**_kwargs) -> RegionOcrResult:
    return RegionOcrResult(
        text="Cutting speed vc = 580 m/min",
        confidence=0.97,
        status="complete",
        cache_hit=False,
        model="deterministic-eval",
    )


def test_real_pdf_region_extracts_580_not_560(monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = _pdf()
    monkeypatch.setattr(evidence, "download_document_bytes", lambda _path: pdf)

    result = evidence.verify_pdf_region(
        document=_document(pdf),
        page=1,
        # PDF y=670 at 16pt maps to approximately top=0.134.
        bbox=(0.10, 0.125, 0.48, 0.165),
        claimed_revision=hashlib.sha256(pdf).hexdigest(),
        client_text=None,
        vision_recognizer=_recognize_580,
    )

    assert "580 m/min" in result.text
    assert "560" not in result.text
    assert "580" in result.critical_tokens
    assert "m/min" in result.critical_tokens
    assert result.crop_sha256
    assert result.region_confidence >= 0.75


def test_client_560_cannot_override_pdf_580(monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = _pdf()
    monkeypatch.setattr(evidence, "download_document_bytes", lambda _path: pdf)

    with pytest.raises(evidence.RegionEvidenceError) as caught:
        evidence.verify_pdf_region(
            document=_document(pdf),
            page=1,
            bbox=(0.10, 0.125, 0.48, 0.165),
            claimed_revision=hashlib.sha256(pdf).hexdigest(),
            client_text="Cutting speed vc = 560 m/min",
            vision_recognizer=_recognize_580,
        )
    assert caught.value.code == "critical_token_mismatch"


def test_stale_revision_is_rejected_before_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf = _pdf()
    monkeypatch.setattr(evidence, "download_document_bytes", lambda _path: pdf)
    with pytest.raises(evidence.RegionEvidenceError) as caught:
        evidence.verify_pdf_region(
            document=_document(pdf),
            page=1,
            bbox=(0.10, 0.125, 0.48, 0.165),
            claimed_revision="0" * 64,
            client_text=None,
            vision_recognizer=_recognize_580,
        )
    assert caught.value.code == "stale_selection"


def test_crop_recognition_disagreement_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf = _pdf()
    monkeypatch.setattr(evidence, "download_document_bytes", lambda _path: pdf)
    with pytest.raises(evidence.RegionEvidenceError) as caught:
        evidence.verify_pdf_region(
            document=_document(pdf),
            page=1,
            bbox=(0.10, 0.125, 0.48, 0.165),
            claimed_revision=hashlib.sha256(pdf).hexdigest(),
            client_text=None,
            vision_recognizer=lambda **_: RegionOcrResult(
                text="Cutting speed vc = 560 m/min",
                confidence=0.97,
                status="complete",
                cache_hit=False,
                model="deterministic-eval",
            ),
        )
    assert caught.value.code == "critical_token_disagreement"


def test_public_corpus_has_no_private_identifiers() -> None:
    corpus = Path(__file__).parent / "fixtures" / "public_eval"
    private_markers = ("TODO_COURSE", "matrikelnummer", "unknown.pdf")
    for path in corpus.glob("*"):
        if path.suffix.lower() in {".md", ".py", ".json", ".txt"}:
            text = path.read_text(encoding="utf-8").lower()
            assert not any(marker.lower() in text for marker in private_markers)


def test_rotated_browser_bbox_maps_back_to_pdf_coordinates() -> None:
    assert evidence.canonical_pdf_bbox((0.10, 0.20, 0.40, 0.50), 90) == (
        0.20, 0.60, 0.50, 0.90
    )
    assert evidence.canonical_pdf_bbox((0.10, 0.20, 0.40, 0.50), 180) == (
        0.60, 0.50, 0.90, 0.80
    )
