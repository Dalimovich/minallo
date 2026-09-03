"""Stage 4 — deterministic analyze-mode page grouping in notes_full.

`_group_pages` is pure (chunk metadata in → section page ranges out, no LLM), so
these tests exercise it directly: heading boundaries when headings exist, stable
page windows otherwise, oversized-section splitting, the too-many-groups fallback,
and effectivePages reporting.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433

    get_settings.cache_clear()


def _row(ps: int, pe: int, title: str | None = None) -> dict:
    return {"page_start": ps, "page_end": pe, "section_title": title}


def test_empty_rows_return_no_groups() -> None:
    from app.routers import notes_full

    groups, effective = notes_full._group_pages([])
    assert groups == []
    assert effective is None


def test_groups_follow_heading_boundaries() -> None:
    from app.routers import notes_full

    rows = [
        _row(1, 1, "Intro"),
        _row(2, 2, "Intro"),
        _row(3, 3, "Methods"),
        _row(4, 4, "Methods"),
        _row(5, 5, "Results"),
    ]
    groups, effective = notes_full._group_pages(rows)

    assert [g["title"] for g in groups] == ["Intro", "Methods", "Results"]
    assert groups[0]["pageStart"] == 1 and groups[0]["pageEnd"] == 2
    assert groups[1]["pageStart"] == 3 and groups[1]["pageEnd"] == 4
    assert groups[2]["pageStart"] == 5 and groups[2]["pageEnd"] == 5
    assert effective == 5


def test_untitled_chunks_extend_current_section() -> None:
    from app.routers import notes_full

    rows = [
        _row(1, 1, "Intro"),
        _row(2, 2, None),       # inherits Intro
        _row(3, 3, "Methods"),
        _row(4, 4, None),       # inherits Methods
    ]
    groups, _ = notes_full._group_pages(rows)

    assert [g["title"] for g in groups] == ["Intro", "Methods"]
    assert groups[0]["pageEnd"] == 2
    assert groups[1]["pageEnd"] == 4


def test_no_headings_uses_stable_page_windows() -> None:
    from app.routers import notes_full

    # 12 untitled pages → window size 5 (matches notes-panel `_groupSize`).
    rows = [_row(p, p) for p in range(1, 13)]
    groups, effective = notes_full._group_pages(rows)

    assert all(g["title"] is None for g in groups)
    assert (groups[0]["pageStart"], groups[0]["pageEnd"]) == (1, 5)
    assert (groups[1]["pageStart"], groups[1]["pageEnd"]) == (6, 10)
    assert (groups[2]["pageStart"], groups[2]["pageEnd"]) == (11, 12)
    assert effective == 12


def test_single_repeated_heading_is_not_structure() -> None:
    from app.routers import notes_full

    # Only one distinct title across the doc → treated as no headings.
    rows = [_row(p, p, "Vorlesung") for p in range(1, 8)]
    groups, _ = notes_full._group_pages(rows)

    assert all(g["title"] is None for g in groups)
    # 7 pages → window size 3.
    assert (groups[0]["pageStart"], groups[0]["pageEnd"]) == (1, 3)


def test_oversized_heading_section_is_split_into_windows() -> None:
    from app.routers import notes_full

    rows = [_row(p, p, "BigChapter") for p in range(1, 16)]
    rows.append(_row(16, 16, "Outro"))  # 2nd distinct heading → heading mode on
    groups, _ = notes_full._group_pages(rows)

    big = [g for g in groups if g["title"] == "BigChapter"]
    # 15 pages split into <= _MAX_GROUP_PAGES (6) windows → 3 sub-groups.
    assert len(big) == 3
    assert all((g["pageEnd"] - g["pageStart"] + 1) <= notes_full._MAX_GROUP_PAGES for g in big)
    assert big[0]["pageStart"] == 1
    assert big[-1]["pageEnd"] == 15


def test_too_many_heading_groups_falls_back_to_windows() -> None:
    from app.routers import notes_full

    # 30 distinct one-page headings would exceed _MAX_GROUPS → page windows.
    rows = [_row(p, p, f"Slide {p}") for p in range(1, 31)]
    groups, _ = notes_full._group_pages(rows)

    assert all(g["title"] is None for g in groups)
    assert len(groups) <= notes_full._MAX_GROUPS


def test_range_clamps_grouping_but_effective_is_whole_doc() -> None:
    from app.routers import notes_full

    rows = [_row(p, p) for p in range(1, 21)]
    groups, effective = notes_full._group_pages(rows, range_start=5, range_end=10)

    assert effective == 20  # whole-document page count, not clamped
    assert groups[0]["pageStart"] == 5
    assert groups[-1]["pageEnd"] == 10


def test_full_doc_path_returns_groups_and_effective(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end through the analyze branch with a stubbed DB fetch."""
    from app.routers import notes_full

    rows = [
        _row(1, 1, "A"), _row(2, 2, "A"),
        _row(3, 3, "B"), _row(4, 4, "B"),
    ]
    monkeypatch.setattr(notes_full, "_fetch_page_structure", lambda *a, **k: rows)
    monkeypatch.setattr(notes_full, "_verify_document_owner", lambda *a, **k: None)

    payload = notes_full.NotesGenerateRequest(
        userId="11111111-1111-1111-1111-111111111111",
        courseId="22222222-2222-2222-2222-222222222222",
        documentId="33333333-3333-3333-3333-333333333333",
        tool="summary",
        mode="analyze",
        pageRange={"start": 1, "end": 4},
    )
    out = notes_full.notes_generate(payload)

    assert [g["title"] for g in out["groups"]] == ["A", "B"]
    assert out["effectivePages"] == 4
