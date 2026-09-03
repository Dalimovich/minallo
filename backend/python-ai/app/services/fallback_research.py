"""Targeted external verification for unresolved course-request items."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .multi_item_retrieval import EvidenceStatus, MultiItemRetrievalResult
from .web_answer import generate_web_answer

_WEB_REQUIRED_RE = re.compile(
    r"\b(?:din\s*\d+|iso\s*\d+|standard|norm(?:en)?|latest|current|today|"
    r"aktuell|gesetz|regulation|software\s+version)\b",
    re.IGNORECASE,
)
_NO_EXTERNAL_FALLBACK = {"strict_course", "selected_files_only"}


@dataclass(frozen=True)
class ItemWebResearch:
    item_id: str
    answer: str
    sources: tuple[dict[str, str], ...] = ()


@dataclass
class FallbackResearchResult:
    items: list[ItemWebResearch] = field(default_factory=list)

    @property
    def sources(self) -> list[dict[str, str]]:
        seen: set[str] = set()
        result: list[dict[str, str]] = []
        for item in self.items:
            for source in item.sources:
                url = source.get("url", "")
                if url and url not in seen:
                    seen.add(url)
                    result.append(source)
        return result

    def prompt_overlay(self) -> str:
        if not self.items:
            return ""
        lines = [
            "\n\nVERIFIED EXTERNAL FALLBACK MATERIAL:",
            "Use this only for its matching unresolved item. Label it 'Source basis: External verification'.",
            "Never attach course [Source N] citations to these external claims.",
        ]
        for item in self.items:
            urls = ", ".join(source.get("url", "") for source in item.sources)
            lines.append(f"- {item.item_id}: {item.answer} | URLs: {urls}")
        return "\n".join(lines)


def research_unresolved_items(
    result: MultiItemRetrievalResult,
    *,
    grounding_policy: str,
    researcher: Callable[..., dict[str, Any]] = generate_web_answer,
) -> FallbackResearchResult:
    """Web-verify only unresolved items whose subject requires authority/currentness."""
    if grounding_policy in _NO_EXTERNAL_FALLBACK:
        return FallbackResearchResult()
    items_by_id = {item.id: item for item in result.manifest.requested_items}
    researched: list[ItemWebResearch] = []
    for evidence in result.evidence:
        if evidence.status is EvidenceStatus.SUPPORTED:
            continue
        item = items_by_id[evidence.item_id]
        if not _WEB_REQUIRED_RE.search(item.original_text):
            continue
        response = researcher(
            item.original_text,
            query=item.original_text,
            max_tokens=700,
        )
        answer = str(response.get("answer") or "").strip()
        sources = tuple(response.get("webSources") or ())
        if answer and sources:
            researched.append(ItemWebResearch(item.id, answer, sources))
    return FallbackResearchResult(researched)


__all__ = (
    "FallbackResearchResult",
    "ItemWebResearch",
    "research_unresolved_items",
)
