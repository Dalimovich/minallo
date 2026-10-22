"""Task-specific exhaustive processing over canonical active revisions."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..supabase_client import get_supabase
from .document_extraction import requested_chapter_number, resolve_chapter_range
from .index_manifest import CanonicalPage, coverage_result


_BATCH_CHARS = 36_000


def _page_batches(pages: list[dict[str, Any]]) -> list[tuple[str, list[int]]]:
    """Each batch pairs its joined text with the page numbers it covers, so a
    caller can report genuine "processing pages 13-24" progress instead of
    only knowing the final page count once every batch has already run."""
    batches: list[tuple[str, list[int]]] = []
    current: list[str] = []
    current_pages: list[int] = []
    size = 0
    for page in pages:
        part = f"[Page {page['page_number']}]\n{page.get('cleaned_text') or ''}".strip()
        if current and size + len(part) > _BATCH_CHARS:
            batches.append(("\n\n".join(current), current_pages))
            current, current_pages, size = [], [], 0
        current.append(part)
        current_pages.append(int(page["page_number"]))
        size += len(part)
    if current:
        batches.append(("\n\n".join(current), current_pages))
    return batches


def process_full_documents(
    *, user_id: str, course_id: str, question: str, pipeline: str,
    documents: dict[str, dict[str, Any]], manifests: dict[str, list[CanonicalPage]],
    on_batch_progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Map every canonical expected page, then synthesize task-specific output."""
    from ..routers.notes_full import _call_openai  # local import avoids startup coupling

    sb = get_supabase()
    mapped: list[str] = []
    coverage_documents: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    system = (
        "You are Minallo's exhaustive document processor. Use only the supplied "
        "pages. Preserve page citations. Do not claim completeness when a page is missing."
    )
    task_instruction = {
        "summarization": "Summarize all substantive material in this batch without dropping topics.",
        "comparison": "Extract every fact, definition, and contrast needed for the requested comparison.",
        "generation": "Extract all source facts and constraints needed for the requested generated artifact.",
        "synthesis": "Synthesize all material relevant to the request while retaining complete topic coverage.",
        "extraction": "Extract every matching item in this batch verbatim or in a clearly paraphrased "
                      "form, each with its page citation. Do not skip any; do not invent one that is not "
                      "actually present.",
    }.get(pipeline, "Process every page for the user's request.")

    # "all definitions in chapter 2" (QA plan J2): bound the exhaustive scan
    # to just that chapter's pages, found from an explicit "Chapter 2"/
    # "Kapitel 2" text heading. Resolved up front (one pass, page text
    # fetched once per document and reused in the main loop below) so
    # total_expected_pages and every coverage calculation reflect the
    # chapter, never the whole document. A chapter named but not found in
    # EVERY document returns an honest decline instead of silently falling
    # back to scanning the whole document under the chapter's label.
    requested_chapter = requested_chapter_number(question)
    page_rows_by_document: dict[str, list[dict[str, Any]]] = {}
    effective_manifests: dict[str, list[CanonicalPage]] = {}
    chapter_not_found_in: list[str] = []
    for document_id, row in documents.items():
        revision = str(row.get("active_index_revision") or "")
        page_rows = (
            sb.table("document_pages")
            .select("page_number, cleaned_text, index_revision")
            .eq("document_id", document_id).eq("index_revision", revision)
            .order("page_number").execute()
        ).data or []
        page_rows_by_document[document_id] = page_rows
        manifest = manifests[document_id]
        if requested_chapter is None:
            effective_manifests[document_id] = manifest
            continue
        chapter_range = resolve_chapter_range(requested_chapter, page_rows)
        if chapter_range is None:
            chapter_not_found_in.append(str(row.get("file_name") or document_id))
            in_range = lambda _page_number: False  # noqa: E731
        else:
            start_page, end_page = chapter_range
            in_range = lambda page_number, _s=start_page, _e=end_page: _s <= page_number <= _e  # noqa: E731
        effective_manifests[document_id] = [
            page if in_range(page.page_number) else CanonicalPage(
                page_number=page.page_number, source_page_id=page.source_page_id,
                required_for_processing=False, status=page.status,
                exclusion_reason=page.exclusion_reason or "outside_requested_chapter_range",
            )
            for page in manifest
        ]
    if requested_chapter is not None and len(chapter_not_found_in) == len(documents):
        return {
            "answer": (
                f"I couldn't confidently find where chapter {requested_chapter} starts and ends in "
                "this document, so I can't give you a reliably complete list for it. You could ask "
                "for a specific page range instead, or ask me to scan the whole document."
            ),
            "coverageResult": {"documents": [], "complete": False},
            "sources": [],
        }
    total_expected_pages = sum(
        1 for manifest in effective_manifests.values() for page in manifest if page.required_for_processing
    )
    pages_done = 0

    for document_id, row in documents.items():
        revision = str(row.get("active_index_revision") or "")
        manifest = effective_manifests[document_id]
        expected = [page for page in manifest if page.required_for_processing]
        page_rows = page_rows_by_document[document_id]
        by_number = {int(page["page_number"]): page for page in page_rows}
        file_name = str(row.get("file_name") or document_id)
        ordered = [by_number[page.page_number] for page in expected if page.page_number in by_number]
        indexed_ids = [
            page.source_page_id for page in expected if page.page_number in by_number
        ]
        processed_ids: list[str] = []
        doc_coverage = coverage_result(
            document_id=document_id, revision=revision, manifest=manifest,
            processed_page_ids=processed_ids,
            indexed_page_ids=indexed_ids,
        )
        coverage_documents.append(doc_coverage)
        if len(indexed_ids) != len(expected):
            continue
        sources.append({
            "fileName": file_name,
            "pageStart": expected[0].page_number if expected else None,
            "pageEnd": expected[-1].page_number if expected else None,
        })
        for batch_no, (batch, batch_pages) in enumerate(_page_batches(ordered), 1):
            result, _ = _call_openai(
                system,
                f"User request: {question}\nTask: {task_instruction}\n"
                f"Document: {file_name}; batch {batch_no}\n\n{batch}",
                max_tokens=3000,
                user_id=user_id,
            )
            if not isinstance(result, str) or not result.strip():
                # Availability of an input page does not prove its model pass succeeded.
                # Leave these pages unprocessed so the caller exposes coverage recovery.
                continue
            mapped.append(f"## {file_name} — batch {batch_no}\n{result}")
            processed_ids.extend(page.source_page_id for page in expected if page.page_number in batch_pages)
            pages_done += len(batch_pages)
            if on_batch_progress:
                on_batch_progress({
                    "current": pages_done,
                    "total": total_expected_pages,
                    "document_name": file_name,
                    "batch_start_page": batch_pages[0] if batch_pages else None,
                    "batch_end_page": batch_pages[-1] if batch_pages else None,
                })
        doc_coverage.update(coverage_result(
            document_id=document_id, revision=revision, manifest=manifest,
            processed_page_ids=processed_ids, indexed_page_ids=indexed_ids,
        ))

    aggregate_complete = bool(coverage_documents) and all(
        item["complete"] for item in coverage_documents
    )
    if not aggregate_complete:
        return {"answer": "", "coverageResult": {"documents": coverage_documents, "complete": False}, "sources": sources}
    final_prompt = (
        f"User request: {question}\nPipeline: {pipeline}\n"
        "Combine the exhaustive batch results below into one answer. Preserve coverage "
        "of every document and retain page citations.\n\n" + "\n\n".join(mapped)
    )
    answer, _ = _call_openai(system, final_prompt, max_tokens=5000, user_id=user_id)
    answer_text = answer if isinstance(answer, str) else ""
    if chapter_not_found_in and answer_text:
        # Partial case: the chapter was found in at least one document (we
        # wouldn't have reached here otherwise -- see the early return
        # above), but not every one. Disclose the gap rather than silently
        # presenting a list that's complete for SOME of the student's files
        # and missing from others with no indication.
        answer_text = (
            f"(Couldn't confidently locate chapter {requested_chapter} in: "
            f"{', '.join(chapter_not_found_in)} -- the list below may be incomplete for those files.)\n\n"
            + answer_text
        )
    return {
        "answer": answer_text,
        "coverageResult": {"documents": coverage_documents, "complete": bool(answer_text)},
        "sources": sources,
    }
