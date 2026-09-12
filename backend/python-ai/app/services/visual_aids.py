"""Trusted visual-aid selection for teaching answers.

Course context always wins.  Web results come only from Wikimedia Commons'
API, carry attribution/licence metadata, and are omitted on any uncertainty or
provider failure.  The LLM never supplies an image URL.
"""

from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .embeddings import embed_query
from .learning_recommendation import ExplanationPlan
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_SAFE_HOSTS = {"commons.wikimedia.org", "upload.wikimedia.org"}
_PRIVATE_TOKEN_RE = re.compile(r"(?:\.pdf\b|[0-9a-f]{8}-[0-9a-f-]{27,}|[/\\])", re.IGNORECASE)


@dataclass(frozen=True)
class VisualContext:
    document_id: str | None = None
    document_revision: str | None = None
    page_number: int | None = None
    selected_region: dict[str, Any] | None = None
    page_image_available: bool = False


@dataclass(frozen=True)
class VisualRetrievalRequest:
    user_id: str
    course_id: str
    topic: str
    question: str
    current_document_id: str | None = None
    current_page: int | None = None
    selected_region: dict[str, Any] | None = None
    preferred_types: tuple[str, ...] = ()
    max_results: int = 3


def _safe_url(value: str) -> str | None:
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in _SAFE_HOSTS:
        return None
    return value


def _clean(value: Any) -> str:
    return re.sub(r"<[^>]+>", "", html.unescape(str(value or ""))).strip()


def _web_query(topic: str) -> str:
    clean = _PRIVATE_TOKEN_RE.sub(" ", topic)
    clean = re.sub(r"\s+", " ", clean).strip()[:140]
    return f"{clean} diagram schematic educational"


def _wikimedia_visuals(topic: str, limit: int = 2) -> list[dict[str, Any]]:
    if not topic or _PRIVATE_TOKEN_RE.search(topic):
        return []
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": _web_query(topic),
        "gsrnamespace": "6",
        "gsrlimit": str(max(1, min(limit * 4, 12))),
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime|size",
        "iiurlwidth": "900",
        "format": "json",
        "formatversion": "2",
        "origin": "*",
    }
    request = Request(
        "https://commons.wikimedia.org/w/api.php?" + urlencode(params),
        headers={"User-Agent": "MinalloEducationalVisuals/1.0"},
    )
    try:
        with urlopen(request, timeout=3.5) as response:
            payload = json.loads(response.read(1_500_000).decode("utf-8"))
    except Exception:
        log.info("wikimedia visual lookup unavailable", exc_info=True)
        return []
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in payload.get("query", {}).get("pages", []) if isinstance(payload, dict) else []:
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        mime = str(info.get("mime") or "")
        thumb = _safe_url(str(info.get("thumburl") or ""))
        source = _safe_url(str(info.get("descriptionurl") or ""))
        if not thumb or not source or not mime.startswith("image/") or mime == "image/svg+xml":
            continue
        licence = _clean((meta.get("LicenseShortName") or {}).get("value"))
        usage = _clean((meta.get("UsageTerms") or {}).get("value"))
        if not licence and not usage:
            continue
        canonical = str(page.get("pageid") or thumb)
        if canonical in seen:
            continue
        seen.add(canonical)
        title = _clean(page.get("title")).removeprefix("File:")
        description = _clean((meta.get("ImageDescription") or {}).get("value"))
        results.append(
            {
                "sourceType": "web",
                "id": f"wikimedia-{canonical}",
                "topic": topic,
                "title": title or topic,
                "altText": description[:240] or f"Educational visual related to {topic}",
                "explanation": f"External visual example for understanding {topic}.",
                "thumbnailUrl": thumb,
                "sourcePageUrl": source,
                "provider": "Wikimedia Commons",
                "creator": _clean((meta.get("Artist") or {}).get("value")) or None,
                "licence": licence or usage,
                "licenceUrl": _safe_url(str((meta.get("LicenseUrl") or {}).get("value") or "")),
                "safeToDisplay": True,
                "educationalRelevance": 0.7,
            }
        )
        if len(results) >= limit:
            break
    return results


def _signed_thumbnail(sb: Any, path: str) -> str | None:
    if not path:
        return None
    try:
        result = sb.storage.from_("course-visuals").create_signed_url(path, 900)
    except Exception:
        return None
    if isinstance(result, dict):
        return str(result.get("signedURL") or result.get("signedUrl") or "") or None
    return None


def _word_overlap(left: str, right: str) -> float:
    left_words = set(re.findall(r"[a-zäöüß]{4,}", left.lower()))
    right_words = set(re.findall(r"[a-zäöüß]{4,}", right.lower()))
    return len(left_words & right_words) / max(1, len(left_words))


def retrieve_course_visuals(request: VisualRetrievalRequest) -> list[dict[str, Any]]:
    """Dedicated vector visual search with active-revision and relevance guards."""
    if not request.user_id or not request.course_id or not request.topic:
        return []
    sb = get_supabase()
    try:
        response = sb.rpc("match_course_visuals", {
            "p_user_id": request.user_id,
            "p_course_id": request.course_id,
            "p_document_revision": "",
            "p_query_embedding": embed_query(f"{request.topic}\n{request.question}"),
            "p_limit": min(30, max(8, request.max_results * 5)),
        }).execute()
        rows = response.data or []
    except Exception:
        log.info("course visual search unavailable", exc_info=True)
        return []
    ranked: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        description = " ".join(str(row.get(key) or "") for key in (
            "caption", "visual_description", "nearby_text", "section_title",
        ))
        overlap = _word_overlap(request.topic, description)
        semantic = float(row.get("similarity") or 0)
        quality = float(row.get("quality_score") or 0)
        current_doc = str(row.get("document_id") or "") == str(request.current_document_id or "")
        distance = (
            abs(int(row.get("page_number") or 0) - int(request.current_page or 0))
            if current_doc and request.current_page else 99
        )
        score = semantic * 0.46 + overlap * 0.28 + quality * 0.12
        if current_doc: score += 0.08
        if distance == 0: score += 0.18
        elif distance <= 3: score += 0.05
        if request.preferred_types and row.get("visual_type") in request.preferred_types:
            score += 0.05
        if score < (0.48 if distance == 0 else 0.58) or quality < 0.55:
            continue
        thumbnail = _signed_thumbnail(sb, str(row.get("thumbnail_path") or ""))
        if thumbnail:
            ranked.append((score, {**row, "_thumbnail": thumbnail}))
    ranked.sort(key=lambda item: item[0], reverse=True)
    output: list[dict[str, Any]] = []
    seen_regions: set[tuple[str, int, str]] = set()
    seen_hashes: set[str] = set()
    for score, row in ranked:
        region = row.get("bounding_box") or {}
        region_key = (
            str(row.get("document_id") or ""), int(row.get("page_number") or 0),
            json.dumps(region, sort_keys=True),
        )
        image_hash = str(row.get("perceptual_hash") or "")
        if region_key in seen_regions or (image_hash and image_hash in seen_hashes):
            continue
        seen_regions.add(region_key)
        if image_hash: seen_hashes.add(image_hash)
        title = str(row.get("caption") or row.get("section_title") or request.topic)
        output.append({
            "sourceType": "course_file", "visualId": str(row.get("id")),
            "documentId": str(row.get("document_id")),
            "documentRevision": str(row.get("document_revision")),
            "pageNumber": int(row.get("page_number") or 1), "boundingBox": region,
            "visualType": str(row.get("visual_type") or "unknown"), "title": title,
            "altText": str(row.get("visual_description") or title)[:300],
            "explanation": f"This course visual supports the explanation of {request.topic}.",
            "thumbnailUrl": row["_thumbnail"],
            "thumbnailEndpoint": f"/course-visuals/{row.get('id')}/thumbnail",
            "sourceEndpoint": f"/course-visuals/{row.get('id')}/source",
            "displayMode": "inline", "educationalRelevance": round(score, 4),
        })
        if len(output) >= request.max_results:
            break
    return output


def select_visual_aids(
    plan: ExplanationPlan,
    *,
    context: VisualContext,
    user_id: str | None = None,
    course_id: str | None = None,
    question: str = "",
) -> list[dict[str, Any]]:
    if not plan.include_visual_aids:
        return []
    if context.document_id and context.selected_region:
        region = context.selected_region
        return [
            {
                "sourceType": "course_file",
                "visualId": str(
                    region.get("id") or f"page-{context.document_id}-{context.page_number or 1}"
                ),
                "documentId": context.document_id,
                "documentRevision": context.document_revision or "",
                "pageNumber": context.page_number or int(region.get("page") or 1),
                "boundingBox": {
                    key: region[key] for key in ("x", "y", "width", "height") if key in region
                }
                or None,
                "title": f"Visual from your course: {plan.topic}",
                "altText": f"Course visual used to explain {plan.topic}",
                "explanation": "This selected course visual is the primary visual evidence for the explanation.",
                "displayMode": "open_in_pdf",
            }
        ]
    if user_id and course_id:
        course_visuals = retrieve_course_visuals(VisualRetrievalRequest(
            user_id=user_id, course_id=course_id, topic=plan.topic,
            question=question, current_document_id=context.document_id,
            current_page=context.page_number,
            preferred_types=("diagram", "graph", "table", "flowchart", "formula_region"),
            max_results=2,
        ))
        if course_visuals:
            return course_visuals
    if context.document_id and context.page_image_available:
        return [{
            "sourceType": "course_file",
            "visualId": f"page-{context.document_id}-{context.page_number or 1}",
            "documentId": context.document_id,
            "documentRevision": context.document_revision or "",
            "pageNumber": context.page_number or 1,
            "boundingBox": None,
            "title": f"Visual from your current course page: {plan.topic}",
            "altText": f"Current PDF page used to explain {plan.topic}",
            "explanation": "The current course page is used before any external visual.",
            "displayMode": "open_in_pdf",
        }]
    return _wikimedia_visuals(plan.topic)


__all__ = (
    "VisualContext", "VisualRetrievalRequest", "retrieve_course_visuals",
    "select_visual_aids",
)
