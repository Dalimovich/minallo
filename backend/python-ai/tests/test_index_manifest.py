import pytest

from app.services.index_manifest import coverage_result, validate_page_manifest


def _row(page: int, status: str = "indexed", required: bool = True, reason=None):
    return {
        "page_number": page,
        "source_page_id": f"r1:{page}",
        "required_for_processing": required,
        "status": status,
        "exclusion_reason": reason,
    }


def test_manifest_requires_every_physical_page_exactly_once() -> None:
    with pytest.raises(ValueError):
        validate_page_manifest([_row(1), _row(3)], physical_page_count=3)


def test_failed_page_prevents_ready_manifest() -> None:
    with pytest.raises(ValueError):
        validate_page_manifest([_row(1), _row(2, "failed")], physical_page_count=2)


def test_coverage_requires_exact_expected_processed_set() -> None:
    manifest = validate_page_manifest([
        _row(1), _row(2), _row(3, "filtered", False, "versioned-policy:test"),
    ], physical_page_count=3)
    partial = coverage_result(
        document_id="A", revision="r1", manifest=manifest,
        processed_page_ids=["r1:1"],
    )
    assert partial["expectedPages"] == 2
    assert partial["failedPages"] == [2]
    assert partial["complete"] is False
    complete = coverage_result(
        document_id="A", revision="r1", manifest=manifest,
        processed_page_ids=["r1:1", "r1:2"],
    )
    assert complete["complete"] is True

