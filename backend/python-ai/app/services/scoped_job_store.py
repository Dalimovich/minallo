"""Supabase persistence for exhaustive document jobs and immutable manifests."""

from __future__ import annotations

import logging
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from .scoped_extraction import (
    DiscoveryStatus,
    DetectedHeading,
    ManifestPromotionResult,
    RequestScopeManifest,
    ScopeItem,
    ScopeItemStatus,
    ScopedJobState,
    ScopedRequestSpec,
    finalise_scoped_job,
    manifest_quality,
    promote_manifest,
)
from ..supabase_client import get_supabase


log = logging.getLogger(__name__)
EXTRACTOR_SCHEMA_VERSION = "scoped-v1"


def _one(response: Any) -> dict[str, Any] | None:
    rows = getattr(response, "data", None) or []
    if isinstance(rows, dict):
        return dict(rows)
    return dict(rows[0]) if rows else None


def _item_from_row(row: dict[str, Any]) -> ScopeItem:
    return ScopeItem(
        id=str(row["id"]),
        stable_key=str(row["stable_key"]),
        document_id=str(row.get("document_id") or ""),
        document_revision_id=str(row.get("document_revision_id") or ""),
        item_number=row.get("item_number"),
        label=str(row.get("label") or ""),
        block_type=str(row.get("block_type") or "exam_question"),
        section_number=row.get("section_number"),
        section_title=row.get("section_title"),
        page_start=row.get("page_start"),
        page_end=row.get("page_end"),
        document_order=int(row.get("document_order") or 0),
        parent_id=row.get("parent_id"),
        source_block_ids=list(row.get("source_block_ids") or []),
        previous_stable_keys=list(row.get("previous_stable_keys") or []),
        status=ScopeItemStatus(str(row.get("status") or "discovered")),
        attempts=int(row.get("attempts") or 0),
        error_code=row.get("error_code"),
        error_message=row.get("error_message"),
    )


def _manifest_from_rows(
    row: dict[str, Any], item_rows: list[dict[str, Any]],
) -> RequestScopeManifest:
    items: list[ScopeItem] = []
    for item_row in item_rows:
        enriched = {
            **item_row,
            "document_id": row["document_id"],
            "document_revision_id": row["document_revision_id"],
        }
        items.append(_item_from_row(enriched))
    return RequestScopeManifest(
        id=str(row["id"]),
        job_id=str(row["job_id"]),
        document_revision_id=str(row["document_revision_id"]),
        discovery_status=DiscoveryStatus(str(row["discovery_status"])),
        manifest_sealed=bool(row.get("manifest_sealed")),
        manifest_verified=bool(row.get("verified")),
        included_section_numbers=list(row.get("included_section_numbers") or []),
        excluded_section_numbers=list(row.get("excluded_section_numbers") or []),
        question_pages=[int(page) for page in (row.get("question_pages") or [])],
        items=items,
        source_fingerprint=str(row.get("source_fingerprint") or ""),
        scope_fingerprint=str(row.get("scope_fingerprint") or ""),
        extractor_schema_version=str(row.get("extractor_schema_version") or ""),
        out_of_scope_items_rejected=list(row.get("out_of_scope_items_rejected") or []),
        detected_headings=[DetectedHeading(**heading) for heading in (
            (row.get("structure") or {}).get("detected_headings") or []
        )],
        version=int(row.get("version") or 1),
    )


def load_active_manifest(
    *, user_id: str, document_id: str, document_revision_id: str,
    canonical_target: str, source_fingerprint: str,
) -> RequestScopeManifest | None:
    sb = get_supabase()
    response = (
        sb.table("request_scope_manifests")
        .select("*")
        .eq("document_id", document_id)
        .eq("document_revision_id", document_revision_id)
        .eq("canonical_target", canonical_target)
        .eq("source_fingerprint", source_fingerprint)
        .eq("extractor_schema_version", EXTRACTOR_SCHEMA_VERSION)
        .eq("active", True)
        .limit(1)
        .execute()
    )
    row = _one(response)
    if not row:
        log.info("manifest_cache_miss document=%s target=%s", document_id, canonical_target)
        return None
    job = _one(
        sb.table("complete_document_jobs").select("user_id").eq("id", row["job_id"])
        .eq("user_id", user_id).limit(1).execute()
    )
    if not job:
        return None
    item_rows = (
        sb.table("request_scope_items").select("*")
        .eq("manifest_id", row["id"]).order("document_order").execute().data or []
    )
    log.info("manifest_cache_hit document=%s target=%s manifest=%s", document_id, canonical_target, row["id"])
    return _manifest_from_rows(row, list(item_rows))


def load_question_unit_ranges(
    *, user_id: str, document_id: str, document_revision_id: str,
) -> dict[str, dict[str, Any]]:
    """Return persisted structural spans keyed by semantic question number."""
    rows = (
        get_supabase().table("document_logical_units")
        .select("question_number,page_start,page_end,stable_block_id,parent_question")
        .eq("user_id", user_id).eq("document_id", document_id)
        .eq("document_revision_id", document_revision_id)
        .in_("block_type", ["exam_question", "exam_subquestion"])
        .order("document_order").execute().data or []
    )
    return {
        str(row.get("question_number")): dict(row)
        for row in rows if row.get("question_number")
    }


def create_or_resume_job(
    *, user_id: str, course_id: str, document_id: str,
    document_revision_id: str, source_fingerprint: str, request_text: str,
    spec: ScopedRequestSpec,
    conversation_id: str | None = None, user_message_id: str | None = None,
    assistant_message_id: str | None = None, request_id: str | None = None,
) -> dict[str, Any]:
    sb = get_supabase()
    existing = _one(
        sb.table("complete_document_jobs").select("*")
        .eq("user_id", user_id).eq("course_id", course_id)
        .eq("canonical_target", spec.canonical_target)
        .eq("source_fingerprint", source_fingerprint)
        .contains("document_ids", [document_id])
        .order("updated_at", desc=True).limit(1).execute()
    )
    if existing and str(existing.get("status")) not in {"failed", "failed_terminal", "superseded"}:
        if conversation_id and assistant_message_id and request_id:
            bind_job_to_tutor_turn(
                job_id=str(existing["id"]), user_id=user_id,
                conversation_id=conversation_id, user_message_id=user_message_id or "",
                assistant_message_id=assistant_message_id, request_id=request_id,
            )
        emit_job_event(
            job_id=str(existing["id"]), event_key="job.resumed",
            event_type="scoped_job_resumed", payload={"status": existing.get("status")},
        )
        return existing
    payload = {
        "user_id": user_id,
        "course_id": course_id,
        "document_ids": [document_id],
        "document_revision_ids": [document_revision_id],
        "request_text": request_text,
        "canonical_target": spec.canonical_target,
        "retrieval_mode": spec.retrieval_mode.value,
        "coverage_intent": spec.coverage_intent.value,
        "include_answers": spec.include_answers,
        "include_explanations": spec.include_explanations,
        "source_fingerprint": source_fingerprint,
        "status": "discovering",
        "discovery_status": DiscoveryStatus.PENDING.value,
    }
    row = _one(sb.table("complete_document_jobs").insert(payload).execute())
    if not row:
        raise RuntimeError("scoped job insert returned no row")
    emit_job_event(
        job_id=str(row["id"]), event_key="job.created",
        event_type="scoped_job_created",
        payload={"retrieval_mode": spec.retrieval_mode.value, "canonical_target": spec.canonical_target},
    )
    if conversation_id and assistant_message_id and request_id:
        bind_job_to_tutor_turn(
            job_id=str(row["id"]), user_id=user_id,
            conversation_id=conversation_id, user_message_id=user_message_id or "",
            assistant_message_id=assistant_message_id, request_id=request_id,
        )
    return row


def bind_job_to_tutor_turn(
    *, job_id: str, user_id: str, conversation_id: str,
    user_message_id: str, assistant_message_id: str, request_id: str,
) -> None:
    """Atomically expose the durable scoped job to refresh/reconnect clients."""
    get_supabase().rpc("bind_scoped_job_to_tutor_turn", {
        "p_job_id": job_id, "p_user_id": user_id,
        "p_request_id": request_id, "p_conversation_id": conversation_id,
        "p_user_message_id": user_message_id,
        "p_assistant_message_id": assistant_message_id,
    }).execute()
    log.info(
        "assistant_job_binding_persisted job_id=%s request_id=%s assistant_message_id=%s",
        job_id, request_id, assistant_message_id,
    )


def emit_job_event(
    *, job_id: str, event_key: str, event_type: str, payload: dict[str, Any],
) -> dict[str, Any] | None:
    event_id = str(uuid.uuid5(uuid.UUID(job_id), event_key))
    row = _one(get_supabase().table("scope_job_events").upsert({
        "event_id": event_id,
        "job_id": job_id,
        "event_key": event_key,
        "event_type": event_type,
        "payload": payload,
    }, on_conflict="job_id,event_key").execute())
    return row


def mark_job_discovery(job_id: str, status: DiscoveryStatus) -> None:
    get_supabase().table("complete_document_jobs").update({
        "status": "discovering" if status is DiscoveryStatus.RUNNING else status.value,
        "discovery_status": status.value,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", job_id).execute()
    emit_job_event(
        job_id=job_id,
        event_key=f"discovery.{status.value}",
        event_type=f"scope.discovery.{status.value}",
        payload={"discovery_status": status.value},
    )


def persist_structural_checkpoint(
    *, job_id: str, document_revision_id: str, pages_total: int,
    pages_inspected: list[int], unresolved_pages: list[int] | None = None,
    text_pages_inspected: list[int] | None = None,
    ocr_pages_inspected: list[int] | None = None,
    visual_pages_inspected: list[int] | None = None,
    detected_headings: list[dict[str, Any]] | None = None,
    included_sections: list[str] | None = None,
    excluded_sections: list[str] | None = None,
    remaining_visual_pages: list[int] | None = None,
    candidate_manifest_version: int | None = None,
    current_stage: str = "structural_discovery",
) -> None:
    """Persist bounded structural progress independently of answer prose."""
    checkpoint_id = str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"{job_id}:structural:{','.join(map(str, sorted(set(pages_inspected))))}",
    ))
    existing_row = _one(
        get_supabase().table("complete_document_jobs")
        .select("structural_checkpoint").eq("id", job_id).limit(1).execute()
    )
    existing = dict((existing_row or {}).get("structural_checkpoint") or {})
    checkpoint = {
        **existing,
        "checkpointId": checkpoint_id,
        "documentRevisionId": document_revision_id,
        "pagesTotal": pages_total,
        "pagesInspected": sorted(set(pages_inspected)),
        "unresolvedPages": sorted(set(unresolved_pages or [])),
        "textPagesInspected": sorted(set(text_pages_inspected or existing.get("textPagesInspected") or [])),
        "ocrPagesInspected": sorted(set(ocr_pages_inspected or existing.get("ocrPagesInspected") or [])),
        "visualPagesInspected": sorted(set(visual_pages_inspected or existing.get("visualPagesInspected") or [])),
        "detectedHeadings": detected_headings if detected_headings is not None else list(existing.get("detectedHeadings") or []),
        "includedSections": included_sections if included_sections is not None else list(existing.get("includedSections") or []),
        "excludedSections": excluded_sections if excluded_sections is not None else list(existing.get("excludedSections") or []),
        "remainingVisualPages": sorted(set(remaining_visual_pages or existing.get("remainingVisualPages") or [])),
        "candidateManifestVersion": candidate_manifest_version or existing.get("candidateManifestVersion") or 1,
        "currentStage": current_stage,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    get_supabase().table("complete_document_jobs").update({
        "checkpoint_id": checkpoint_id,
        "structural_checkpoint": checkpoint,
        "current_stage": current_stage,
        "last_checkpoint_at": checkpoint["updatedAt"],
        "updated_at": checkpoint["updatedAt"],
    }).eq("id", job_id).execute()
    emit_job_event(
        job_id=job_id,
        event_key=f"structural.checkpoint.{checkpoint_id}",
        event_type="structural_checkpoint_saved",
        payload={"checkpoint_id": checkpoint_id, "pages_inspected": len(checkpoint["pagesInspected"])},
    )


def persist_manifest_candidate(
    *, user_id: str, document_id: str, canonical_target: str,
    candidate: RequestScopeManifest,
) -> ManifestPromotionResult:
    """Write a candidate separately and atomically activate it after validation."""
    existing = load_active_manifest(
        user_id=user_id,
        document_id=document_id,
        document_revision_id=candidate.document_revision_id,
        canonical_target=canonical_target,
        source_fingerprint=candidate.source_fingerprint,
    )
    promotion = promote_manifest(existing, candidate)
    quality = manifest_quality(candidate)
    manifest_id = candidate.id or str(uuid.uuid4())
    candidate.id = manifest_id
    sb = get_supabase()
    row = {
        "id": manifest_id,
        "job_id": candidate.job_id,
        "document_id": document_id,
        "document_revision_id": candidate.document_revision_id,
        "canonical_target": canonical_target,
        "discovery_status": candidate.discovery_status.value,
        "manifest_sealed": candidate.manifest_sealed,
        "verified": not promotion.candidate_rejected,
        "included_section_numbers": candidate.included_section_numbers,
        "excluded_section_numbers": candidate.excluded_section_numbers,
        "question_pages": candidate.question_pages,
        "source_fingerprint": candidate.source_fingerprint,
        "scope_fingerprint": candidate.scope_fingerprint,
        "extractor_schema_version": candidate.extractor_schema_version,
        "out_of_scope_items_rejected": candidate.out_of_scope_items_rejected,
        "quality": asdict(quality),
        "structure": {
            "detected_headings": [asdict(heading) for heading in candidate.detected_headings],
        },
        "version": candidate.version,
        "active": False,
    }
    sb.table("request_scope_manifests").insert(row).execute()
    item_rows = [{
        "id": item.id,
        "manifest_id": manifest_id,
        "stable_key": item.stable_key,
        "previous_stable_keys": item.previous_stable_keys,
        "item_number": item.item_number,
        "label": item.label,
        "block_type": item.block_type,
        "section_number": item.section_number,
        "section_title": item.section_title,
        "page_start": item.page_start,
        "page_end": item.page_end,
        "document_order": item.document_order,
        "parent_id": item.parent_id,
        "source_block_ids": item.source_block_ids,
        "status": item.status.value,
        "attempts": item.attempts,
        "error_code": item.error_code,
        "error_message": item.error_message,
    } for item in candidate.items]
    for start in range(0, len(item_rows), 100):
        sb.table("request_scope_items").insert(item_rows[start:start + 100]).execute()
    if promotion.candidate_rejected:
        emit_job_event(
            job_id=candidate.job_id, event_key=f"manifest.rejected.{manifest_id}",
            event_type="manifest_candidate_rejected",
            payload={"manifest_id": manifest_id, "reason": promotion.reason},
        )
        if (
            promotion.reason and "regression" in promotion.reason
        ) or promotion.reason == "same_revision_lost_ids":
            emit_job_event(
                job_id=candidate.job_id, event_key=f"manifest.regression.{manifest_id}",
                event_type="manifest_regression_prevented",
                payload={"manifest_id": manifest_id, "reason": promotion.reason},
            )
        return promotion
    sb.rpc("activate_scope_manifest", {"p_candidate_id": manifest_id}).execute()
    emit_job_event(
        job_id=candidate.job_id, event_key=f"manifest.promoted.{manifest_id}",
        event_type="manifest_promoted",
        payload={"manifest_id": manifest_id, "discovered_ids": candidate.discovered_ids},
    )
    return ManifestPromotionResult(candidate, False)


def persist_item_state(
    *, job_id: str, manifest_id: str, item: ScopeItem,
    result: dict[str, Any] | None = None, answer_checkpoint: dict[str, Any] | None = None,
) -> None:
    get_supabase().table("request_scope_items").update({
        "status": item.status.value,
        "attempts": item.attempts,
        "error_code": item.error_code,
        "error_message": item.error_message,
        "result": result,
        "answer_checkpoint": answer_checkpoint or {},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("manifest_id", manifest_id).eq("stable_key", item.stable_key).execute()
    emit_job_event(
        job_id=job_id,
        event_key=f"item.{item.stable_key}.{item.status.value}.{item.attempts}",
        event_type=f"scope.item.{item.status.value}",
        payload={"stable_key": item.stable_key, "item_number": item.item_number},
    )


def persist_job_state(job_id: str, state: ScopedJobState) -> None:
    status = (
        "answers_verified" if state.all_answers_verified else
        "processing_finished" if state.processing_finished else
        "processing" if state.discovery_complete else
        "discovering"
    )


def persist_scoped_result(
    *, job_id: str, final_text: str, learning_journey: dict[str, Any] | None,
    sources: list[dict[str, Any]], answer_mode: str,
) -> None:
    """Save enough presentation state to restore a result missed while offline."""
    now = datetime.now(timezone.utc).isoformat()
    get_supabase().table("complete_document_jobs").update({
        "final_text": final_text,
        "result_payload": {
            "learningJourney": learning_journey,
            "sources": sources,
            "answerMode": answer_mode,
        },
        "updated_at": now,
    }).eq("id", job_id).execute()
    get_supabase().table("complete_document_jobs").update({
        "status": status,
        "discovery_status": state.discovery_status.value,
        "discovered_count": state.discovered_count,
        "pending_count": state.pending_count,
        "processing_count": state.processing_count,
        "answered_count": state.answered_count,
        "unresolved_count": state.unresolved_count,
        "failed_count": state.failed_count,
        "last_checkpoint_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": (
            datetime.now(timezone.utc).isoformat() if state.processing_finished else None
        ),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", job_id).execute()
    event_type = (
        "scope.answers.verified" if state.all_answers_verified else
        "scope.processing.finished" if state.processing_finished else
        "scope.progress"
    )
    emit_job_event(
        job_id=job_id,
        event_key=f"state.{state.answered_count}.{state.unresolved_count}.{state.failed_count}.{state.pending_count}.{state.processing_count}",
        event_type=event_type,
        payload={
            "manifest_sealed": state.manifest_sealed,
            "discovery_complete": state.discovery_complete,
            "processing_finished": state.processing_finished,
            "all_answers_verified": state.all_answers_verified,
            "discovered_count": state.discovered_count,
            "pending_count": state.pending_count,
            "processing_count": state.processing_count,
            "answered_count": state.answered_count,
            "unresolved_count": state.unresolved_count,
            "failed_count": state.failed_count,
        },
    )


def load_job_snapshot(*, user_id: str, job_id: str) -> dict[str, Any] | None:
    sb = get_supabase()
    job = _one(
        sb.table("complete_document_jobs").select("*")
        .eq("id", job_id).eq("user_id", user_id).limit(1).execute()
    )
    if not job:
        return None
    manifest_id = job.get("manifest_id")
    manifest_row = None
    item_rows: list[dict[str, Any]] = []
    if manifest_id:
        manifest_row = _one(
            sb.table("request_scope_manifests").select("*")
            .eq("id", manifest_id).limit(1).execute()
        )
        item_rows = list(
            sb.table("request_scope_items").select(
                "id,stable_key,item_number,status,attempts,error_code,result,answer_checkpoint,document_order"
            ).eq("manifest_id", manifest_id).order("document_order").execute().data or []
        )
    events = list(
        sb.table("scope_job_events").select("event_id,event_key,event_type,payload,created_at")
        .eq("job_id", job_id).order("created_at").execute().data or []
    )
    return {
        "jobId": job_id,
        "manifestId": manifest_id,
        "status": job.get("status"),
        "discoveryStatus": job.get("discovery_status"),
        "manifestSealed": bool(manifest_row and manifest_row.get("manifest_sealed")),
        "discoveryComplete": bool(
            manifest_row and manifest_row.get("discovery_status") == "complete"
            and manifest_row.get("manifest_sealed")
        ),
        "processingFinished": job.get("status") in {"processing_finished", "answers_verified"},
        "allAnswersVerified": job.get("status") == "answers_verified",
        "discoveredCount": int(job.get("discovered_count") or 0),
        "pendingCount": int(job.get("pending_count") or 0),
        "processingCount": int(job.get("processing_count") or 0),
        "answeredCount": int(job.get("answered_count") or 0),
        "unresolvedCount": int(job.get("unresolved_count") or 0),
        "failedCount": int(job.get("failed_count") or 0),
        "scopeFingerprint": manifest_row.get("scope_fingerprint") if manifest_row else None,
        "includedSectionNumbers": (
            list(manifest_row.get("included_section_numbers") or []) if manifest_row else []
        ),
        "excludedSectionNumbers": (
            list(manifest_row.get("excluded_section_numbers") or []) if manifest_row else []
        ),
        "questionPages": list(manifest_row.get("question_pages") or []) if manifest_row else [],
        "items": item_rows,
        "events": events,
        "checkpointId": job.get("checkpoint_id"),
        "checkpoint": dict(job.get("structural_checkpoint") or {}),
        "requestId": job.get("request_id"),
        "assistantMessageId": job.get("assistant_message_id"),
        "documentRevisionIds": list(job.get("document_revision_ids") or []),
        "finalText": job.get("final_text"),
        "learningJourney": dict(job.get("result_payload") or {}).get("learningJourney"),
        "sources": list(dict(job.get("result_payload") or {}).get("sources") or []),
        "answerMode": dict(job.get("result_payload") or {}).get("answerMode"),
    }
