"""_coverage_chunk_selection: every selected file must reach the prompt with its
TECHNICAL content, never judged/skipped from a single info/literature slide.
"""
from __future__ import annotations

from app.services.answer_stream import _coverage_chunk_selection, _looks_non_technical
from app.services.retrieval import RetrievedChunk


def _chunk(doc: str, text: str, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=f"{doc}-{score}",
        document_id=doc,
        page_start=1,
        page_end=1,
        text=text,
        score=score,
        similarity=score,
        chunk_type="general",
        section_title=None,
    )


def test_non_technical_detector():
    assert _looks_non_technical("Herzlich willkommen zum StudING Infoabend, QR-Code scannen")
    assert _looks_non_technical("Literaturverzeichnis: Fritz/Schulze, Fertigungstechnik")
    assert not _looks_non_technical("Spritzgießen: Plastifizieren, Einspritzen, Nachdruck")


def test_info_slide_does_not_hide_a_files_technical_chunk():
    # Kapitel_3's highest-scored chunk is its info slide; a technical chunk
    # scores lower. The selection must still surface the technical content so
    # the model doesn't mark the whole file "entfällt".
    chunks = [
        _chunk("k3", "StudING Infoabend — QR-Code zur Anmeldung", 0.9),
        _chunk("k3", "Extrusion und Spritzgießen von Thermoplasten", 0.4),
        _chunk("k42", "DIN 8582: Einteilung nach Spannungszustand, Tiefziehen", 0.5),
    ]
    selected = _coverage_chunk_selection(chunks)
    texts_by_doc: dict[str, list[str]] = {}
    for c in selected:
        texts_by_doc.setdefault(c.document_id, []).append(c.text)
    # Both files represented.
    assert set(texts_by_doc) == {"k3", "k42"}
    # k3's technical chunk is present (not only the info slide).
    assert any("Spritzgießen" in t for t in texts_by_doc["k3"])
    # Technical chunk leads the info slide for k3 (technical-first ordering).
    k3_first = next(c for c in selected if c.document_id == "k3")
    assert "Spritzgießen" in k3_first.text


def test_every_selected_file_is_represented():
    chunks = [_chunk(f"d{i}", f"technical content {i}", 0.5 - i * 0.01) for i in range(6)]
    selected = _coverage_chunk_selection(chunks)
    assert {c.document_id for c in selected} == {f"d{i}" for i in range(6)}
