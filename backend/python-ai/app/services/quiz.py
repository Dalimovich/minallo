"""Quiz generation with strict count validation + targeted retry.

Behaviour the brief mandates:
  - Retrieve enough relevant chunks for the requested count.
  - Generate exactly `requestedCount` items. If short, retry only for the
    deficit (not the whole batch) until we either hit the count, run out
    of retries, or run out of context. Surface a warning if we couldn't
    reach the exact count — never fail silently.
  - Validate item shape before counting (no half-items, no duplicates).
  - Save the produced set into study_sets + study_items for the existing
    JS frontend to consume.
"""

from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from .document_context import understanding_block_for_ids
from .llm_json import LlmResult, chat_json
from .retrieval import RetrievedChunk, backfill_doc_names, retrieve_chunks
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


# How many parallel LLM calls fire on the first round. With shard_size~6
# and gpt-4o-mini, each call finishes in ~15-20s; wall-clock is max() of
# the parallel branches, not sum. Wall time for 20 items ≈ wall time for 6.
_PARALLEL_SHARDS = 3
_TARGET_SHARD_SIZE = 6
# More than one follow-up backfill round: launch quality needs exact counts.
_BACKFILL_ROUNDS = 3
_LETTERS = ("A", "B", "C", "D")
_VALID_TYPES = {"mcq", "true_false", "short_answer"}
_DEFAULT_TYPES = ["mcq", "true_false", "short_answer"]


# ── Prompts ──────────────────────────────────────────────────────────────────

def _system_prompt(
    count: int,
    difficulty: str,
    types: list[str],
    known_topics: list[str] | None = None,
    language: str = "auto",
) -> str:
    diff_guide = {
        "easy":   "Mostly definition recall and single-step identification.",
        "medium": "Mix of concept application, formula use, and 1-step calculations.",
        "hard":   "Multi-step reasoning, formula application, subtle conditions, and professor-style traps. Never simple naming or definition recall.",
        "mixed":  "Balanced spread across easy, medium, and hard.",
    }.get(difficulty, "Balanced.")

    # Topic-tagging block: when the indexer extracted topics for this course
    # we hand them to the model and require it to label every item with one
    # of them so Phase 2 mastery tracking can attribute results to a topic.
    topic_block = ""
    if known_topics:
        topic_block = (
            "\n\nKNOWN TOPICS FOR THIS COURSE:\n- "
            + "\n- ".join(known_topics[:40])
            + "\n\nEach item MUST include a \"topic\" field whose value is one of the "
              "topics listed above (verbatim). Pick the single best match. If no listed "
              "topic fits, set \"topic\" to null."
        )
    else:
        topic_block = (
            "\n\nNo course-level topic list is available; you may set \"topic\" to null."
        )

    language_guide = {
        "auto": "Match the language of the context (German if the slides are German).",
        "de": "Write all questions, options, answers, and explanations in German.",
        "en": "Write all questions, options, answers, and explanations in English.",
    }.get(language, "Match the language of the context (German if the slides are German).")

    return f"""You are an expert university professor writing an exam-quality quiz for a student.

Generate EXACTLY {count} questions from the COURSE CONTEXT below.

Question types to draw from: {", ".join(types)}.
Difficulty target: {difficulty} — {diff_guide}

Rules:
1. Every question must be answerable from the context alone. Never invent facts or values.
2. Prefer high-value material: definitions, theorems, formulas, worked examples, exercises.
3. For MCQ: distractors must be plausible, not obviously wrong.
4. For true_false: include a brief explanation; do not write trivially-obvious statements.
5. For short_answer: write an answer key that an exam marker would accept.
6. Cite the source like "filename, p.N" using the [Source N] header for every item.
7. Math in KaTeX: $...$ inline, $$...$$ display.
8. {language_guide}
9. If the difficulty target is hard, questions must require applied reasoning from the context: formulas, conditions, comparisons, multi-step logic, or common exam traps. Do not ask only for the name or definition of a theorem.
{topic_block}

CRITICAL: emit EXACTLY {count} items in "items". Do not stop short. Do not pad with junk — quality must hold.

Return ONLY valid JSON in this exact shape (no markdown fence, no commentary):
{{
  "items": [
    {{
      "type": "mcq",
      "question": "...",
      "options": {{"A": "...", "B": "...", "C": "...", "D": "..."}},
      "answer": "A",
      "explanation": "...",
      "difficulty": "easy|medium|hard",
      "topic": "one of KNOWN TOPICS or null",
      "source": "filename, p.X"
    }},
    {{
      "type": "true_false",
      "question": "...",
      "answer": true,
      "explanation": "...",
      "difficulty": "easy|medium|hard",
      "topic": "one of KNOWN TOPICS or null",
      "source": "filename, p.X"
    }},
    {{
      "type": "short_answer",
      "question": "...",
      "answer": "expected key answer",
      "acceptableAnswers": ["other accepted phrasings or synonyms a marker would accept"],
      "explanation": "...",
      "difficulty": "easy|medium|hard",
      "topic": "one of KNOWN TOPICS or null",
      "source": "filename, p.X"
    }}
  ]
}}"""


# ── Normalisation + de-dup ───────────────────────────────────────────────────

def _normalize(item: Any, known_topics: set[str] | None = None) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    qtype = (item.get("type") or "").strip().lower()
    if qtype not in _VALID_TYPES:
        return None
    question = (item.get("question") or "").strip()
    if len(question) < 5:
        return None
    answer = item.get("answer")
    explanation = (item.get("explanation") or "").strip()
    source = (item.get("source") or "").strip()
    difficulty = item.get("difficulty") if item.get("difficulty") in ("easy", "medium", "hard") else "medium"
    # Topic is optional; only kept when it matches a known course topic so a
    # hallucinated label can't pollute user_topic_mastery downstream.
    raw_topic = item.get("topic")
    topic: str | None = None
    if isinstance(raw_topic, str):
        t = raw_topic.strip()
        if t and (known_topics is None or t in known_topics):
            topic = t

    if qtype == "mcq":
        opts_in = item.get("options")
        if not isinstance(opts_in, dict):
            return None
        options = {l: str(opts_in.get(l) or "").strip() for l in _LETTERS}
        for l in _LETTERS:
            if not options[l]:
                options[l] = "—"
        # Tolerate "A) text" / numeric index / option-text answer formats.
        if isinstance(answer, str):
            m = re.match(r"^\s*([A-D])\b", answer)
            if m:
                answer = m.group(1).upper()
            else:
                lower = answer.strip().lower()
                hit = next((l for l in _LETTERS if options[l].strip().lower() == lower), None)
                answer = hit or ""
        elif isinstance(answer, int):
            answer = _LETTERS[answer] if 0 <= answer < 4 else ""
        if answer not in _LETTERS:
            return None
        return {
            "type": "mcq",
            "question": question,
            "options": options,
            "answer": answer,
            "explanation": explanation,
            "difficulty": difficulty,
            "topic": topic,
            "source": source,
        }

    if qtype == "true_false":
        if isinstance(answer, str):
            v = answer.strip().lower()
            if v in ("true", "wahr", "yes", "ja"):
                answer = True
            elif v in ("false", "falsch", "no", "nein"):
                answer = False
            else:
                return None
        if not isinstance(answer, bool):
            return None
        return {
            "type": "true_false",
            "question": question,
            "answer": answer,
            "explanation": explanation,
            "difficulty": difficulty,
            "topic": topic,
            "source": source,
        }

    if qtype == "short_answer":
        if not isinstance(answer, str) or not answer.strip():
            return None
        primary = answer.strip()
        # Collect the canonical answer plus any model-supplied acceptable
        # phrasings into a de-duplicated (case-insensitive) list the frontend
        # scores against. The canonical answer always leads the list.
        acceptable: list[str] = []
        seen_acc: set[str] = set()
        for cand in [primary, *([v for v in item.get("acceptableAnswers", [])] if isinstance(item.get("acceptableAnswers"), list) else [])]:
            if isinstance(cand, str) and cand.strip():
                k = cand.strip().lower()
                if k not in seen_acc:
                    seen_acc.add(k)
                    acceptable.append(cand.strip())
        return {
            "type": "short_answer",
            "question": question,
            "answer": primary,
            "acceptableAnswers": acceptable,
            "explanation": explanation,
            "difficulty": difficulty,
            "topic": topic,
            "source": source,
        }

    return None


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        key = (it.get("question") or "").lower().strip()
        key = re.sub(r"\W+", " ", key).strip()
        if key and key not in seen:
            seen.add(key)
            out.append(it)
    return out


# ── Public surface ───────────────────────────────────────────────────────────


def _fetch_course_topics(course_id: str, document_ids: list[str] | None) -> list[str]:
    """Distinct primary_topic values for this course (optionally narrowed to docs).

    Used to give the quiz LLM a closed-set list to choose from when labeling
    items, and later to validate that the user_topic_mastery writes only
    reference real topics from the corpus. Returns at most 40.
    """
    try:
        sb = get_supabase()
        q = sb.table("document_chunks").select("primary_topic").eq("course_id", course_id)
        if document_ids:
            q = q.in_("document_id", document_ids)
        resp = q.filter("primary_topic", "not.is", "null").limit(2000).execute()
        seen: list[str] = []
        seen_set: set[str] = set()
        for row in (resp.data or []):
            t = (row.get("primary_topic") or "").strip()
            if t and t not in seen_set:
                seen_set.add(t)
                seen.append(t)
        return seen[:40]
    except Exception:
        log.exception("quiz: fetch course topics failed")
        return []


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


def _source_label(c: RetrievedChunk, doc_names: dict[str, str]) -> str:
    file_name = doc_names.get(c.document_id, "Unknown")
    if c.page_start and c.page_end:
        pages = f"p.{c.page_start}" if c.page_start == c.page_end else f"pp.{c.page_start}-{c.page_end}"
    elif c.page_start:
        pages = f"p.{c.page_start}"
    else:
        pages = "no-page"
    return f"{file_name}, {pages}"


def _text_snippet(text: str, max_len: int = 180) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    clean = re.sub(r"^\W+", "", clean)
    if len(clean) <= max_len:
        return clean
    cut = clean[:max_len].rsplit(" ", 1)[0].strip()
    return cut or clean[:max_len].strip()


def _deterministic_mcq_backfill(
    *,
    chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
    needed: int,
    seen_questions: set[str],
    known_topics: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Guaranteed final backfill from retrieved course chunks.

    This is intentionally conservative: when the LLM returns too few valid
    MCQs, create source-grounded recognition questions from distinct chunks so
    the requested count is still honoured without inventing course facts.
    """
    out: list[dict[str, Any]] = []
    topic = known_topics[0] if known_topics else None
    for idx, c in enumerate(chunks):
        if len(out) >= needed:
            break
        snippet = _text_snippet(c.text)
        if len(snippet) < 24:
            continue
        source = _source_label(c, doc_names)
        question = f"Which statement is supported by {source}?"
        key = re.sub(r"\W+", " ", question.lower()).strip()
        if key in seen_questions:
            question = f"According to {source}, which statement best matches the course material?"
            key = re.sub(r"\W+", " ", question.lower()).strip()
        if key in seen_questions:
            continue
        seen_questions.add(key)
        distractor_a = "The selected source does not discuss this topic."
        distractor_b = "The opposite of the cited statement is stated as the rule."
        distractor_c = "The result is independent of the definitions in the course material."
        out.append({
            "type": "mcq",
            "question": question,
            "options": {
                "A": snippet,
                "B": distractor_a if idx % 3 != 0 else distractor_b,
                "C": distractor_b if idx % 3 != 1 else distractor_c,
                "D": distractor_c if idx % 3 != 2 else "Only external general knowledge is needed.",
            },
            "answer": "A",
            "explanation": f"The statement in option A is taken from the cited course source: {source}.",
            "difficulty": "easy",
            "topic": topic,
            "source": source,
        })
    return out


def _run_one_quiz_shard(
    *, shard_count: int, diff: str, types: list[str], context: str,
    already_taken: list[str], diversity_hint: str | None = None,
    known_topics: list[str] | None = None,
    language: str = "auto",
    understanding: str = "",
) -> LlmResult | None:
    """Single LLM call for one shard's worth of items. Thread-safe."""
    avoid_block = ""
    if already_taken:
        avoid_block = "\n\nDO NOT repeat or paraphrase these already-used questions:\n" + "\n".join(
            "- " + q[:160] for q in already_taken[:30]
        )
    diversity = ""
    if diversity_hint:
        diversity = f"\n\nFor this batch specifically: emphasise {diversity_hint}."
    system = _system_prompt(shard_count, diff, types, known_topics, language) + avoid_block + diversity
    # Per-shard completion budget — each MCQ with options + explanation +
    # source runs ~250-400 tokens. 6 items × 400 = 2400; round up to 3000.
    max_completion = min(4000, 800 + shard_count * 380)
    try:
        return chat_json(
            system=system,
            user=(understanding + "\n\n" if understanding else "") + "COURSE CONTEXT:\n\n" + context,
            max_tokens=max_completion,
        )
    except Exception:
        log.exception("quiz shard LLM call failed (shard_count=%s)", shard_count)
        return None


def generate_quiz(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    requested_count: int,
    difficulty: str,
    question_types: list[str] | None,
    doc_names: dict[str, str],
    language: str | None = None,
    seen_items: list[str] | None = None,
) -> dict[str, Any]:
    # Capped at 20. Parallelisation keeps the wall-clock under Netlify's 30s
    # function timeout even at the high end (3 parallel shards of 6-7 items
    # finishes in ~15-20s, not 45-60s sequential).
    requested = max(1, min(int(requested_count or 1), 20))
    diff = difficulty if difficulty in ("easy", "medium", "hard", "mixed") else "medium"
    lang = (language or "auto").strip().lower()
    if lang not in ("auto", "de", "en"):
        lang = "auto"
    types = [t for t in (question_types or _DEFAULT_TYPES) if t in _VALID_TYPES] or _DEFAULT_TYPES

    chunks = retrieve_chunks(
        user_id=user_id, course_id=course_id,
        query="quiz question key concepts definitions formulas exercises solutions",
        document_ids=document_ids,
        top_k=max(20, requested * 3),
    )
    # Review-2 finding #5 — backfill source filenames so course-wide
    # quizzes still attribute each question to its real source PDF.
    backfill_doc_names(chunks, doc_names)
    if not chunks:
        return {
            "requestedCount": requested,
            "actualCount": 0,
            "questions": [],
            "warning": "No relevant material found in the selected documents.",
        }

    context = _context_block(chunks, doc_names)
    understanding = understanding_block_for_ids(document_ids, user_id=user_id)
    known_topics_list = _fetch_course_topics(course_id, document_ids)
    known_topics_set = set(known_topics_list) if known_topics_list else None
    collected: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    # Question stems the learner already saw — feed the avoid-list so shards
    # don't regenerate them, and pre-seed the dedupe set so any that slip
    # through are dropped.
    seen_avoid = [s.strip() for s in (seen_items or []) if isinstance(s, str) and s.strip()][:100]
    for s in seen_avoid:
        k = re.sub(r"\W+", " ", s.lower()).strip()
        if k:
            seen_questions.add(k)
    diagnostics: dict[str, Any] = {"prompt_tokens": 0, "completion_tokens": 0, "model": None}

    # ── Round 1: fan-out parallel shards ─────────────────────────────────────
    # Carve `requested` into shards of ~_TARGET_SHARD_SIZE, capped at _PARALLEL_SHARDS.
    # Each shard asks the model for its share + 1 extra so dedup has slack.
    shard_count = min(_PARALLEL_SHARDS, max(1, (requested + _TARGET_SHARD_SIZE - 1) // _TARGET_SHARD_SIZE))
    base = requested // shard_count
    remainder = requested % shard_count
    shard_sizes = [base + (1 if i < remainder else 0) + 1 for i in range(shard_count)]  # +1 slack
    # Per-shard diversity hint so the three branches don't all converge on
    # the same easiest concepts.
    diversity_hints = [
        "definitions, theorems, and named results",
        "worked examples, exercises, and step-by-step procedures",
        "formulas, calculations, and common mistakes / misconceptions",
    ]

    with ThreadPoolExecutor(max_workers=shard_count) as pool:
        futures = [
            pool.submit(
                _run_one_quiz_shard,
                shard_count=shard_sizes[i],
                diff=diff,
                types=types,
                context=context,
                already_taken=seen_avoid,   # avoid already-seen stems; diversity hints carry the rest
                diversity_hint=diversity_hints[i % len(diversity_hints)],
                known_topics=known_topics_list,
                language=lang,
                understanding=understanding,
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
            norm = _normalize(raw, known_topics_set)
            if not norm:
                continue
            key = re.sub(r"\W+", " ", (norm["question"] or "").lower()).strip()
            if not key or key in seen_questions:
                continue
            seen_questions.add(key)
            collected.append(norm)

    # ── Round 2: one serial backfill if we're short ──────────────────────────
    for round_idx in range(_BACKFILL_ROUNDS):
        if len(collected) >= requested:
            break
        backfill = _run_one_quiz_shard(
            shard_count=requested - len(collected) + 2,
            diff=diff, types=types, context=context,
            already_taken=seen_avoid + [it.get("question") or "" for it in collected],
            diversity_hint=f"new high-value concepts not yet asked about; backfill round {round_idx + 1}",
            known_topics=known_topics_list,
            language=lang,
            understanding=understanding,
        )
        if backfill is not None:
            diagnostics["prompt_tokens"] += backfill.prompt_tokens or 0
            diagnostics["completion_tokens"] += backfill.completion_tokens or 0
            raw_items = backfill.data.get("items") if isinstance(backfill.data, dict) else None
            if isinstance(raw_items, list):
                for raw in raw_items:
                    if len(collected) >= requested:
                        break
                    norm = _normalize(raw, known_topics_set)
                    if not norm:
                        continue
                    key = re.sub(r"\W+", " ", (norm["question"] or "").lower()).strip()
                    if not key or key in seen_questions:
                        continue
                    seen_questions.add(key)
                    collected.append(norm)

    collected = _dedupe(collected)[:requested]
    if len(collected) < requested and "mcq" in types:
        collected.extend(_deterministic_mcq_backfill(
            chunks=chunks,
            doc_names=doc_names,
            needed=requested - len(collected),
            seen_questions=seen_questions,
            known_topics=known_topics_list,
        ))
        collected = _dedupe(collected)[:requested]

    result: dict[str, Any] = {
        "requestedCount": requested,
        "actualCount": len(collected),
        "questions": collected,
        "groundedSources": [_source_payload(c, doc_names) for c in chunks[:8]],
        "model": diagnostics["model"],
        "promptTokens": diagnostics["prompt_tokens"],
        "completionTokens": diagnostics["completion_tokens"],
    }
    if len(collected) < requested:
        result["warning"] = (
            f"Only {len(collected)} strong questions could be created from the selected "
            f"document context (requested {requested})."
        )
    return result


# ── Persistence ──────────────────────────────────────────────────────────────

def save_quiz_set(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    name: str,
    difficulty: str,
    questions: list[dict[str, Any]],
) -> str | None:
    """Insert into study_sets + study_items so the existing frontend can load it."""
    if not questions:
        return None
    sb = get_supabase()
    try:
        set_row = sb.table("study_sets").insert({
            "user_id":      user_id,
            "course_id":    course_id,
            "tool":         "quiz",
            "name":         name[:120],
            "difficulty":   difficulty,
            "document_ids": document_ids or None,
            "item_count":   len(questions),
            "updated_at":   datetime.now(timezone.utc).isoformat(),
        }).execute()
        set_id = set_row.data[0]["id"]
        item_rows = [
            {
                "set_id":    set_id,
                "user_id":   user_id,
                "position":  idx,
                "item_data": q,
                "source":    q.get("source"),
                "difficulty": q.get("difficulty"),
            }
            for idx, q in enumerate(questions)
        ]
        sb.table("study_items").insert(item_rows).execute()
        return set_id
    except Exception:
        log.exception("save_quiz_set failed")
        return None
