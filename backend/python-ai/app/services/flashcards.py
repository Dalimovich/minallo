"""Flashcard generation with exact-count retry + study-value bias."""

from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from .llm_json import LlmResult, chat_json
from .retrieval import RetrievedChunk, backfill_doc_names, retrieve_chunks
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


# Three parallel shards on round 1, one serial backfill on round 2.
_PARALLEL_SHARDS = 3
_TARGET_SHARD_SIZE = 8
_VALID_DIFFICULTIES = {"easy", "medium", "hard"}


def _difficulty_guide(difficulty: str) -> str:
    return {
        "easy":   "Mostly definitions and single-fact recall.",
        "medium": "Mix of definitions, formula use, and 1-step application.",
        "hard":   "Multi-step reasoning, formula application, subtle conditions, and exam-style traps. Avoid trivial one-word recall.",
        "mixed":  "Balanced spread across easy, medium, and hard.",
    }.get(difficulty, "Balanced.")


def _language_guide(language: str) -> str:
    return {
        "auto": "Match the language of the source material (German if the slides are German).",
        "de": "Write every card front and back in German.",
        "en": "Write every card front and back in English.",
    }.get(language, "Match the language of the source material (German if the slides are German).")


def _system_prompt(count: int, difficulty: str = "medium", language: str = "auto") -> str:
    return f"""You are an expert tutor preparing {count} exam-quality flashcards for a university student.

Generate EXACTLY {count} cards from the COURSE CONTEXT below.

Difficulty target: {difficulty} — {_difficulty_guide(difficulty)}
Language: {_language_guide(language)}

Card types (mix them):
- definition: term → precise definition + notation
- formula: "What is the formula for X?" → formula + meaning of every symbol
- when_to_use: "When do you use method X?" → conditions + reasoning
- method_steps: "How do you solve X step-by-step?" → numbered steps
- common_mistake: typical pitfall → correct approach
- comparison: X vs Y → side-by-side
- mini_exercise: short problem → full worked solution
- notation: professor's symbol → meaning + usage

Rules:
1. Every card must be grounded in the context.
2. Prefer formulas, definitions, theorems, worked examples, common mistakes.
3. Back must be substantial — not a one-word answer.
4. Use the source's notation/terminology.
5. Math in KaTeX: $...$ inline, $$...$$ display.
6. Cite source as "filename, p.N".
7. Match the language of the source material.

CRITICAL: produce EXACTLY {count} items in "items".

Return ONLY valid JSON in this exact shape (no markdown fence, no commentary):
{{
  "items": [
    {{
      "front": "question / term",
      "back":  "answer / explanation",
      "tags":  ["definition", "formula"],
      "difficulty": "easy|medium|hard",
      "source": "filename, p.X"
    }}
  ]
}}"""


def _normalize(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    front = (item.get("front") or "").strip()
    back = (item.get("back") or "").strip()
    if len(front) < 3 or len(back) < 3:
        return None
    difficulty = item.get("difficulty") if item.get("difficulty") in _VALID_DIFFICULTIES else "medium"
    tags = item.get("tags")
    if not isinstance(tags, list):
        tags = []
    tags = [str(t).strip() for t in tags if str(t).strip()]
    return {
        "front": front,
        "back": back,
        "tags": tags,
        "difficulty": difficulty,
        "source": (item.get("source") or "").strip(),
    }


def _context_block(chunks: list[RetrievedChunk], doc_names: dict[str, str]) -> str:
    parts: list[str] = []
    for i, c in enumerate(chunks, 1):
        file_name = doc_names.get(c.document_id, "Unknown")
        pages = (
            f"p.{c.page_start}"
            if c.page_start and c.page_start == c.page_end
            else (f"pp.{c.page_start}-{c.page_end}" if c.page_start and c.page_end else "no-page")
        )
        head = f"[Source {i}] {file_name}, {pages}"
        if c.section_title:
            head += f"\nSection: {c.section_title}"
        parts.append(f"{head}\n{c.text}")
    return "\n\n---\n\n".join(parts)


def _source_payload(c: RetrievedChunk, doc_names: dict[str, str]) -> dict[str, Any]:
    return {
        "fileName": doc_names.get(c.document_id, "Unknown"),
        "pageStart": c.page_start,
        "pageEnd": c.page_end,
        "chunkId": c.chunk_id,
        "sectionTitle": c.section_title,
    }


def _run_one_flashcard_shard(
    *, shard_count: int, context: str, already_taken: list[str],
    diversity_hint: str | None = None,
    difficulty: str = "medium", language: str = "auto",
) -> LlmResult | None:
    avoid = ""
    if already_taken:
        avoid = "\n\nDO NOT repeat or paraphrase these card fronts:\n" + "\n".join(
            "- " + f[:140] for f in already_taken[:30]
        )
    diversity = ""
    if diversity_hint:
        diversity = f"\n\nFor this batch specifically: focus on {diversity_hint}."
    # Per-shard completion budget. 8 cards × 350 tok ≈ 2800; round up.
    max_completion = min(4000, 700 + shard_count * 350)
    try:
        return chat_json(
            system=_system_prompt(shard_count, difficulty, language) + avoid + diversity,
            user="COURSE CONTEXT:\n\n" + context,
            max_tokens=max_completion,
        )
    except Exception:
        log.exception("flashcards shard LLM call failed (shard_count=%s)", shard_count)
        return None


def generate_flashcards(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    requested_count: int,
    doc_names: dict[str, str],
    difficulty: str = "medium",
    language: str | None = None,
    seen_items: list[str] | None = None,
) -> dict[str, Any]:
    # Capped at 24 thanks to parallel shards. Each shard runs in ~15-20s, all
    # three together wall-clock ~20-25s — comfortably under Netlify's 30s.
    requested = max(1, min(int(requested_count or 1), 24))
    diff = difficulty if difficulty in ("easy", "medium", "hard", "mixed") else "medium"
    lang = (language or "auto").strip().lower()
    if lang not in ("auto", "de", "en"):
        lang = "auto"
    # Card fronts the learner already saw — feed the avoid-list and pre-seed
    # the dedupe set so generation doesn't repeat them.
    seen_avoid = [s.strip() for s in (seen_items or []) if isinstance(s, str) and s.strip()][:100]

    chunks = retrieve_chunks(
        user_id=user_id, course_id=course_id,
        query="definitions formulas theorems examples exercises common mistakes important concepts",
        document_ids=document_ids,
        top_k=max(20, requested * 2),
    )
    # Review-2 finding #5: course-wide flashcards (no documentIds) had
    # empty doc_names → every source labelled "Unknown". Backfill from
    # the chunk set so source-of-truth filenames make it through.
    backfill_doc_names(chunks, doc_names)
    if not chunks:
        return {
            "requestedCount": requested,
            "actualCount": 0,
            "cards": [],
            "warning": "No relevant material found in the selected documents.",
        }

    context = _context_block(chunks, doc_names)
    collected: list[dict[str, Any]] = []
    seen_fronts: set[str] = set()
    for s in seen_avoid:
        k = re.sub(r"\W+", " ", s.lower()).strip()
        if k:
            seen_fronts.add(k)
    diagnostics: dict[str, Any] = {"prompt_tokens": 0, "completion_tokens": 0, "model": None}

    # ── Round 1: parallel shards with diversity hints ────────────────────────
    shard_count = min(_PARALLEL_SHARDS, max(1, (requested + _TARGET_SHARD_SIZE - 1) // _TARGET_SHARD_SIZE))
    base = requested // shard_count
    remainder = requested % shard_count
    shard_sizes = [base + (1 if i < remainder else 0) + 1 for i in range(shard_count)]
    diversity_hints = [
        "definitions, theorems, and named results",
        "worked examples, mini-exercises, and step-by-step methods",
        "formulas, notation, and common mistakes",
    ]

    with ThreadPoolExecutor(max_workers=shard_count) as pool:
        futures = [
            pool.submit(
                _run_one_flashcard_shard,
                shard_count=shard_sizes[i],
                context=context,
                already_taken=seen_avoid,
                diversity_hint=diversity_hints[i % len(diversity_hints)],
                difficulty=diff,
                language=lang,
            )
            for i in range(shard_count)
        ]
        shard_results = [f.result() for f in futures]

    for res in shard_results:
        if res is None:
            continue
        diagnostics["model"] = res.model
        diagnostics["prompt_tokens"] += res.prompt_tokens or 0
        diagnostics["completion_tokens"] += res.completion_tokens or 0
        raw_items = res.data.get("items") if isinstance(res.data, dict) else None
        if not isinstance(raw_items, list):
            continue
        for raw in raw_items:
            if len(collected) >= requested:
                break
            norm = _normalize(raw)
            if not norm:
                continue
            key = re.sub(r"\W+", " ", norm["front"].lower()).strip()
            if not key or key in seen_fronts:
                continue
            seen_fronts.add(key)
            collected.append(norm)

    # ── Round 2: one serial backfill if dedup left us short ──────────────────
    if len(collected) < requested:
        backfill = _run_one_flashcard_shard(
            shard_count=requested - len(collected) + 2,
            context=context,
            already_taken=seen_avoid + [c.get("front") or "" for c in collected],
            diversity_hint="anything important not yet covered",
            difficulty=diff,
            language=lang,
        )
        if backfill is not None:
            diagnostics["prompt_tokens"] += backfill.prompt_tokens or 0
            diagnostics["completion_tokens"] += backfill.completion_tokens or 0
            raw_items = backfill.data.get("items") if isinstance(backfill.data, dict) else None
            if isinstance(raw_items, list):
                for raw in raw_items:
                    if len(collected) >= requested:
                        break
                    norm = _normalize(raw)
                    if not norm:
                        continue
                    key = re.sub(r"\W+", " ", norm["front"].lower()).strip()
                    if not key or key in seen_fronts:
                        continue
                    seen_fronts.add(key)
                    collected.append(norm)

    collected = collected[:requested]
    result: dict[str, Any] = {
        "requestedCount": requested,
        "actualCount": len(collected),
        "cards": collected,
        "groundedSources": [_source_payload(c, doc_names) for c in chunks[:8]],
        "model": diagnostics["model"],
        "promptTokens": diagnostics["prompt_tokens"],
        "completionTokens": diagnostics["completion_tokens"],
    }
    if len(collected) < requested:
        result["warning"] = (
            f"Only {len(collected)} strong flashcards could be created from the selected "
            f"document context (requested {requested})."
        )
    return result


def save_flashcard_set(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    name: str,
    cards: list[dict[str, Any]],
) -> str | None:
    if not cards:
        return None
    sb = get_supabase()
    try:
        set_row = sb.table("study_sets").insert({
            "user_id":      user_id,
            "course_id":    course_id,
            "tool":         "flashcards",
            "name":         name[:120],
            "document_ids": document_ids or None,
            "item_count":   len(cards),
            "updated_at":   datetime.now(timezone.utc).isoformat(),
        }).execute()
        set_id = set_row.data[0]["id"]
        item_rows = [
            {
                "set_id":    set_id,
                "user_id":   user_id,
                "position":  idx,
                "item_data": card,
                "source":    card.get("source"),
                "difficulty": card.get("difficulty"),
            }
            for idx, card in enumerate(cards)
        ]
        sb.table("study_items").insert(item_rows).execute()
        return set_id
    except Exception:
        log.exception("save_flashcard_set failed")
        return None
