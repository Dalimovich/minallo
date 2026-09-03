"""Task-specific exhaustive processing over canonical active revisions."""

from __future__ import annotations

from typing import Any

from ..supabase_client import get_supabase
from .index_manifest import CanonicalPage, coverage_result


_BATCH_CHARS = 36_000


def _page_batches(pages: list[dict[str, Any]]) -> list[str]:
    batches: list[str] = []
    current: list[str] = []
    size = 0
    for page in pages:
        part = f"[Page {page['page_number']}]\n{page.get('cleaned_text') or ''}".strip()
        if current and size + len(part) > _BATCH_CHARS:
            batches.append("\n\n".join(current))
            current, size = [], 0
        current.append(part)
        size += len(part)
    if current:
        batches.append("\n\n".join(current))
    return batches


def process_full_documents(
    *, user_id: str, course_id: str, question: str, pipeline: str,
    documents: dict[str, dict[str, Any]], manifests: dict[str, list[CanonicalPage]],
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
    }.get(pipeline, "Process every page for the user's request.")

    for document_id, row in documents.items():
        revision = str(row.get("active_index_revision") or "")
        manifest = manifests[document_id]
        expected = [page for page in manifest if page.required_for_processing]
        page_rows = (
            sb.table("document_pages")
            .select("page_number, cleaned_text, index_revision")
            .eq("document_id", document_id).eq("index_revision", revision)
            .order("page_number").execute()
        ).data or []
        by_number = {int(page["page_number"]): page for page in page_rows}
        ordered = [by_number[page.page_number] for page in expected if page.page_number in by_number]
        processed_ids = [
            page.source_page_id for page in expected if page.page_number in by_number
        ]
        doc_coverage = coverage_result(
            document_id=document_id, revision=revision, manifest=manifest,
            processed_page_ids=processed_ids,
            indexed_page_ids=processed_ids,
        )
        coverage_documents.append(doc_coverage)
        if not doc_coverage["complete"]:
            continue
        file_name = str(row.get("file_name") or document_id)
        sources.append({
            "fileName": file_name,
            "pageStart": expected[0].page_number if expected else None,
            "pageEnd": expected[-1].page_number if expected else None,
        })
        for batch_no, batch in enumerate(_page_batches(ordered), 1):
            result, _ = _call_openai(
                system,
                f"User request: {question}\nTask: {task_instruction}\n"
                f"Document: {file_name}; batch {batch_no}\n\n{batch}",
                max_tokens=3000,
                user_id=user_id,
            )
            mapped.append(f"## {file_name} — batch {batch_no}\n{result}")

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
    return {
        "answer": answer,
        "coverageResult": {"documents": coverage_documents, "complete": True},
        "sources": sources,
    }

