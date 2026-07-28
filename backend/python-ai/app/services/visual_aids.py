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

from .learning_recommendation import ExplanationPlan

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


def select_visual_aids(
    plan: ExplanationPlan,
    *,
    context: VisualContext,
) -> list[dict[str, Any]]:
    if not plan.include_visual_aids:
        return []
    if context.document_id and (context.selected_region or context.page_image_available):
        region = context.selected_region or {}
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
    return _wikimedia_visuals(plan.topic)


__all__ = ("VisualContext", "select_visual_aids")
