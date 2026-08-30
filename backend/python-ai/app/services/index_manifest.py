"""Canonical active-revision page manifests and exhaustive coverage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


_VALID_STATUSES = {"indexed", "semantic_empty", "filtered", "failed"}


@dataclass(frozen=True)
class CanonicalPage:
    page_number: int
    source_page_id: str
    required_for_processing: bool
    status: str
    exclusion_reason: str | None = None


def validate_page_manifest(rows: list[dict[str, Any]], *, physical_page_count: int) -> list[CanonicalPage]:
    pages = [CanonicalPage(
        page_number=int(row.get("page_number") or 0),
        source_page_id=str(row.get("source_page_id") or ""),
        required_for_processing=bool(row.get("required_for_processing", True)),
        status=str(row.get("status") or ""),
        exclusion_reason=(str(row.get("exclusion_reason")) if row.get("exclusion_reason") else None),
    ) for row in rows]
    numbers = [page.page_number for page in pages]
    if physical_page_count < 1 or sorted(numbers) != list(range(1, physical_page_count + 1)):
        raise ValueError("canonical page manifest must account for every physical page exactly once")
    if len({page.source_page_id for page in pages}) != len(pages) or any(not page.source_page_id for page in pages):
        raise ValueError("canonical page manifest contains duplicate or missing source page ids")
    for page in pages:
        if page.status not in _VALID_STATUSES:
            raise ValueError("canonical page manifest contains an invalid status")
        if page.status == "filtered" and (page.required_for_processing or not page.exclusion_reason):
            raise ValueError("filtered pages require an exclusion reason and cannot be required")
        if page.status == "failed":
            raise ValueError("failed pages prevent an index revision becoming ready")
    return pages


def coverage_result(
    *, document_id: str, revision: str, manifest: list[CanonicalPage],
    processed_page_ids: list[str], indexed_page_ids: list[str] | None = None,
) -> dict[str, Any]:
    expected_ids = [page.source_page_id for page in manifest if page.required_for_processing]
    processed = list(dict.fromkeys(processed_page_ids))
    indexed = set(indexed_page_ids or expected_ids)
    expected_set = set(expected_ids)
    processed_set = set(processed)
    failed_pages = [
        page.page_number for page in manifest
        if page.required_for_processing and page.source_page_id not in processed_set
    ]
    return {
        "documentId": document_id,
        "revision": revision,
        "expectedPageIds": expected_ids,
        "expectedPages": len(expected_ids),
        "indexedPages": len(expected_set & indexed),
        "processedPageIds": processed,
        "processedPages": len(expected_set & processed_set),
        "failedPages": failed_pages,
        "excludedPages": [
            {"pageNumber": page.page_number, "reason": page.exclusion_reason}
            for page in manifest if not page.required_for_processing
        ],
        "complete": expected_set == processed_set,
    }

