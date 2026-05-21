"""Unit tests for the chunker. No network, no DB."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    import os
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def test_chunk_pages_emits_chunks_in_page_order() -> None:
    from app.services.chunking import chunk_pages

    pages = [
        # page 1 — single paragraph well under the budget
        "Newton's second law states that force equals mass times acceleration. "
        "This is the foundation of classical mechanics. " * 6,
        # page 2 — a heading then a paragraph
        "1.2 Examples\n\nA block of mass 2 kg is pushed with 10 N of force. "
        "Compute its acceleration using F = ma. " * 8,
    ]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=20)

    assert chunks, "expected at least one chunk"
    # Chunks should appear in page order.
    page_starts = [c.page_start for c in chunks]
    assert page_starts == sorted(page_starts)
    # Every chunk should have a real text payload.
    for c in chunks:
        assert c.chunk_text.strip()
        assert c.token_count > 0
        assert 1 <= c.page_start <= 2
        assert c.page_end >= c.page_start


def test_chunk_pages_classifies_examples() -> None:
    from app.services.chunking import chunk_pages

    # Long paragraph mentioning "example" — chunker should tag it.
    pages = [
        "1. Example\n\nExample: Given F = 10 N and m = 2 kg, find the acceleration. "
        "Worked example with numeric values for the student to verify. " * 12
    ]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=20)
    assert chunks
    # The heading was eaten, the paragraph remains; classification should
    # see "example" / "Example:" and tag accordingly.
    assert any(c.chunk_type == "example" for c in chunks)


def test_chunk_pages_handles_empty_input() -> None:
    from app.services.chunking import chunk_pages

    assert chunk_pages([]) == []
    assert chunk_pages(["", "   ", ""]) == []


def test_chunk_pages_respects_target_token_budget() -> None:
    from app.services.chunking import chunk_pages

    # Two long paragraphs on the same page — should split into multiple chunks.
    pages = ["A long paragraph repeated many times. " * 200]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=30)
    assert len(chunks) >= 2
    # No chunk should grossly exceed the budget. Allow some headroom because
    # the chunker only flushes *before* adding the next paragraph.
    for c in chunks:
        assert c.token_count <= 400


# ── Phase 3 Step A — chunker walks Markdown ────────────────────────────────


def test_chunk_pages_accepts_page_markdown_directly() -> None:
    """Indexing passes PageMarkdown to skip the redundant page_to_markdown
    pass. The chunker must walk it without re-converting."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    # NB: use explicit `+` for the concat. Adjacent string literals get
    # compile-time concatenated BEFORE the `* 30` is applied, which would
    # multiply the heading too — a Python gotcha that makes the fixture
    # accidentally produce 30 headings instead of one.
    pages = [
        PageMarkdown(
            page_number=1,
            markdown=(
                "## Newton's Second Law\n\n"
                + ("Force equals mass times acceleration. " * 30)
            ),
            quality="good",
        ),
    ]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=20)
    assert chunks, "expected at least one chunk"
    # The heading sets section_title on the chunk underneath it.
    assert chunks[0].section_title == "Newton's Second Law"
    # Heading body itself is not duplicated into the chunk content (chunker
    # eats heading blocks the same way the raw-text path used to).
    assert "## Newton" not in chunks[0].chunk_text


def test_chunk_pages_keeps_display_math_atomic() -> None:
    """A ``$$ ... $$`` block must end up entirely inside a single chunk —
    never split across chunks. Critical because the verifier matches whole
    formulas against retrieved chunk text; a torn formula loses grounding."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    formula = "$$\n\\delta_S = \\frac{L_S}{A_S \\cdot E_S}\n$$"
    md = (
        "## Schraubennachgiebigkeit\n\n"
        + ("Vor der Formel kommt erklärender Fließtext. " * 25)
        + "\n\n"
        + formula
        + "\n\n"
        + ("Nach der Formel folgt weiterer Fließtext. " * 25)
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=120, overlap_tokens=20)
    assert chunks
    # Find the chunk containing the formula — it must contain the WHOLE
    # ``$$ ... $$`` block, not a torn-in-half version.
    formula_chunks = [c for c in chunks if "\\delta_S" in c.chunk_text]
    assert formula_chunks, "expected the formula to land in some chunk"
    for c in formula_chunks:
        assert c.chunk_text.count("$$") % 2 == 0, "formula fences must be balanced"
        assert "\\frac{L_S}{A_S \\cdot E_S}" in c.chunk_text


def test_chunk_pages_heading_forces_flush() -> None:
    """A heading mid-page must trigger a flush so the previous content doesn't
    leak under the new section_title."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Erste Sektion\n\n"
        + ("Inhalt der ersten Sektion. " * 20)
        + "\n\n## Zweite Sektion\n\n"
        + ("Inhalt der zweiten Sektion. " * 20)
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=400, overlap_tokens=20)
    titles = [c.section_title for c in chunks]
    assert "Erste Sektion" in titles
    assert "Zweite Sektion" in titles


# ── Phase 3 Step B — atomic formula companion chunks ───────────────────────


def test_chunk_pages_emits_formula_companion_chunk() -> None:
    """Each ``$$ ... $$`` block must produce a small companion chunk tagged
    ``chunk_type='formula'`` in addition to its place inside the parent
    context chunk. The companion is what powers exact-formula retrieval —
    big lecture chunks vector-rank poorly for ``what's the formula for X?``
    queries."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    # NB: prose must avoid the word "Formel"/"formula" — `_classify_chunk`
    # matches that keyword in chunk content and would otherwise tag the
    # surrounding context chunks as ``chunk_type='formula'`` too, breaking
    # the count-by-type assertion below. The point of this test is the
    # companion chunk, not the broader classifier behaviour.
    formula = "$$\n\\delta_S = \\frac{L_S}{A_S \\cdot E_S}\n$$"
    md = (
        "## Schraubennachgiebigkeit\n\n"
        + ("Vorbereitender erklärender Text vor dem Ausdruck. " * 20)
        + "\n\n"
        + formula
        + "\n\n"
        + ("Anschließender erklärender Text nach dem Ausdruck. " * 20)
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=400, overlap_tokens=20)

    formula_chunks = [c for c in chunks if c.chunk_type == "formula"]
    assert len(formula_chunks) == 1, "expected exactly one formula companion"
    fc = formula_chunks[0]
    assert "\\delta_S" in fc.chunk_text
    assert "## Schraubennachgiebigkeit" in fc.chunk_text, \
        "companion should carry the section heading so embedding has context"
    assert fc.section_title == "Schraubennachgiebigkeit"
    assert fc.page_start == fc.page_end == 1

    # Parent context chunk must STILL carry the formula — the companion is
    # additive, not a replacement.
    parent_chunks = [c for c in chunks if c.chunk_type != "formula"]
    assert any("\\delta_S" in c.chunk_text for c in parent_chunks), \
        "formula must remain inside the parent context chunk too"


def test_chunk_pages_one_companion_per_formula() -> None:
    """Two formulas on the same page → two companion chunks."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Schraubenverbindung\n\n"
        + "Erklärender Text. "
        + "\n\n$$\n\\delta_S = \\frac{L_S}{A_S \\cdot E_S}\n$$\n\n"
        + "Weiterer Text. "
        + "\n\n$$\n\\delta_P = \\frac{L_P}{A_P \\cdot E_P}\n$$\n\n"
        + "Abschluss. "
    )
    pages = [PageMarkdown(page_number=3, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=400, overlap_tokens=20)

    formula_chunks = [c for c in chunks if c.chunk_type == "formula"]
    assert len(formula_chunks) == 2
    assert all(c.page_start == 3 and c.page_end == 3 for c in formula_chunks)
    assert any("\\delta_S" in c.chunk_text for c in formula_chunks)
    assert any("\\delta_P" in c.chunk_text for c in formula_chunks)


def test_chunk_pages_companion_inherits_section_title_from_latest_heading() -> None:
    """A formula under a sub-heading must be tagged with that sub-heading,
    not whatever was set earlier on the page."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Erste Sektion\n\n"
        + "Inhalt der ersten Sektion. "
        + "\n\n## Zweite Sektion\n\n"
        + "Inhalt der zweiten Sektion. "
        + "\n\n$$\n\\tau = F / A\n$$\n"
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=400, overlap_tokens=20)

    formula_chunks = [c for c in chunks if c.chunk_type == "formula"]
    assert len(formula_chunks) == 1
    assert formula_chunks[0].section_title == "Zweite Sektion"


# ── Phase 3 Step C — exercise no-split regions ──────────────────────────────


def test_chunk_pages_keeps_long_exercise_as_one_chunk() -> None:
    """An exercise body that runs well over target_tokens must still emit as
    a single chunk. Ripping a long statement at the 700th token leaves both
    halves missing parts of the question, which is the exact pathology
    Phase 3 Step C exists to fix."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    long_body = ("Eine sehr ausführlich beschriebene Aufgabenstellung. " * 80)
    md = (
        "## Aufgabe 9.1 a)\n\n"
        + long_body
        + "\n\n## Nächstes Kapitel\n\n"
        + "Etwas anderes Thema. " * 20
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=20)

    exercise_chunks = [c for c in chunks if c.section_title == "Aufgabe 9.1 a)"]
    assert len(exercise_chunks) == 1, (
        f"expected exactly one chunk under 'Aufgabe 9.1 a)', got "
        f"{len(exercise_chunks)} (token sizes: {[c.token_count for c in exercise_chunks]})"
    )
    ex = exercise_chunks[0]
    assert ex.token_count > 200, "no-split region should exceed target_tokens"
    # Both ends of the statement must be present (no ripping mid-statement).
    assert ex.chunk_text.count("Eine sehr ausführlich beschriebene Aufgabenstellung.") >= 70


def test_chunk_pages_exercise_region_closes_at_next_heading() -> None:
    """Once a non-exercise heading appears, the no-split mode must turn off
    so subsequent prose still gets normal size-budget chunking."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Aufgabe 3\n\n"
        + ("Aufgabentext. " * 40)
        + "\n\n## Theoriekapitel\n\n"
        + ("Weiterer ausführlicher Theorietext. " * 80)
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=150, overlap_tokens=20)

    theory_chunks = [c for c in chunks if c.section_title == "Theoriekapitel"]
    assert len(theory_chunks) >= 2, (
        f"Theoriekapitel should split into multiple chunks once the exercise "
        f"region has closed (got {len(theory_chunks)}, sizes "
        f"{[c.token_count for c in theory_chunks]})"
    )


def test_chunk_pages_back_to_back_exercises_each_get_own_chunk() -> None:
    """Two exercise headings in a row produce two exercise chunks — the
    second exercise heading both closes the previous no-split region AND
    opens a new one."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Aufgabe 1\n\n"
        + ("Erste Aufgabe Text. " * 50)
        + "\n\n## Aufgabe 2\n\n"
        + ("Zweite Aufgabe Text. " * 50)
    )
    pages = [PageMarkdown(page_number=2, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=100, overlap_tokens=20)

    titles = [c.section_title for c in chunks]
    assert "Aufgabe 1" in titles
    assert "Aufgabe 2" in titles
    a1 = [c for c in chunks if c.section_title == "Aufgabe 1"]
    a2 = [c for c in chunks if c.section_title == "Aufgabe 2"]
    assert len(a1) == 1, f"Aufgabe 1 should be one chunk, got {len(a1)}"
    assert len(a2) == 1, f"Aufgabe 2 should be one chunk, got {len(a2)}"
    # Neither exercise should bleed into the other.
    assert "Zweite Aufgabe" not in a1[0].chunk_text
    assert "Erste Aufgabe" not in a2[0].chunk_text


# ── Phase 3 Step D — chunks carry exercise identifiers ─────────────────────


def test_chunk_pages_stamps_exercise_identifiers_on_exercise_chunks() -> None:
    """Chunks emitted inside an exercise no-split region must carry the
    parsed (exercise_number, subpart). Indexing uses these to resolve the
    document_exercises FK before insert."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    # Lecture body must clear min_chunk_tokens=80 or flush() drops it and
    # the assertion below has nothing to inspect.
    md = (
        "## Aufgabe 9.1 a)\n\n"
        + ("Statement body. " * 30)
        + "\n\n## Theoriekapitel\n\n"
        + ("Etwas ausführlicherer Vorlesungstext für das Theoriekapitel. " * 30)
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=200, overlap_tokens=20)

    ex_chunks = [c for c in chunks if c.section_title == "Aufgabe 9.1 a)"]
    assert ex_chunks, "expected an exercise chunk"
    for c in ex_chunks:
        assert c.exercise_number == "9.1"
        assert c.exercise_subpart == "a"

    lecture_chunks = [c for c in chunks if c.section_title == "Theoriekapitel"]
    assert lecture_chunks, "expected a lecture chunk"
    for c in lecture_chunks:
        assert c.exercise_number is None
        assert c.exercise_subpart is None


def test_chunk_pages_formula_companion_inside_exercise_carries_identifiers() -> None:
    """A formula companion emitted while inside an exercise region must
    carry the same (exercise_number, subpart) so it joins the same
    document_exercises row as the surrounding statement chunk."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    md = (
        "## Aufgabe 9.1\n\n"
        + "Vorbereitender Text. " * 5
        + "\n\n$$\n\\tau = F / A\n$$\n\n"
        + "Abschließender Text. " * 5
    )
    pages = [PageMarkdown(page_number=1, markdown=md, quality="good")]
    chunks = chunk_pages(pages, target_tokens=400, overlap_tokens=20)

    formula_chunks = [c for c in chunks if c.chunk_type == "formula"]
    assert len(formula_chunks) == 1
    fc = formula_chunks[0]
    assert fc.exercise_number == "9.1"
    assert fc.exercise_subpart is None  # no subpart in "Aufgabe 9.1"


def test_parse_exercise_heading_extracts_number_and_subpart() -> None:
    """Lock the parsing contract `indexing._replace_chunks` joins on."""
    from app.services.chunking import _parse_exercise_heading

    assert _parse_exercise_heading("Aufgabe 9.1 a)") == ("9.1", "a")
    assert _parse_exercise_heading("Aufgabe 9.1 A)") == ("9.1", "a")  # lowercased
    assert _parse_exercise_heading("Übung 3") == ("3", None)
    assert _parse_exercise_heading("Exercise 4.1.2") == ("4.1.2", None)
    assert _parse_exercise_heading("Beispiel 2 b") == ("2", "b")
    assert _parse_exercise_heading("Theoriekapitel") == (None, None)
    assert _parse_exercise_heading("") == (None, None)


def test_is_exercise_heading_pattern_matches() -> None:
    """Lock in the patterns the no-split region opens for. Skipping any of
    these would silently put exercise bodies back under token-budget rules."""
    from app.services.chunking import _is_exercise_heading

    assert _is_exercise_heading("Aufgabe 1.2")
    assert _is_exercise_heading("Aufgabe 9.1 a)")
    assert _is_exercise_heading("Übung 3.1")
    assert _is_exercise_heading("Exercise 4")
    assert _is_exercise_heading("Problem 12.3.1")
    assert _is_exercise_heading("Beispiel 2")
    # Should NOT match plain prose or other section headings.
    assert not _is_exercise_heading("Theoriekapitel")
    assert not _is_exercise_heading("Schubspannungsnachweis")
    assert not _is_exercise_heading("Aufgaben sind wichtig")  # no number → not a label


def test_chunk_pages_skips_unclear_pages() -> None:
    """Pages whose markdown is ``[unclear]`` (Phase-2 graded ``failed``) must
    not produce chunks. Indexing relies on the chunker to drop them so the
    retrieval index doesn't pull garbage."""
    from app.services.chunking import chunk_pages
    from app.services.markdown_indexing import PageMarkdown

    pages = [
        PageMarkdown(page_number=1, markdown="[unclear]", quality="failed"),
        PageMarkdown(
            page_number=2,
            markdown="Real content on this page. " * 40,
            quality="good",
        ),
    ]
    chunks = chunk_pages(pages, target_tokens=200)
    assert chunks
    assert all(c.page_start >= 2 for c in chunks)
