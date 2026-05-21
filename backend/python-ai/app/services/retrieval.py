"""Retrieve relevant chunks for a question, with study-value reranking.

Calls the existing `match_chunks_hybrid` RPC (vector + BM25, document
filter aware) and then reranks results by the same study-value heuristics
the JS pipeline already uses: source-type weight, official-material
boost, section-title hints, and text-shape hints (formulas, numbered
lists, "common mistake" markers, etc.).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from ..supabase_client import get_supabase
from .embeddings import embed_texts

log = logging.getLogger(__name__)


# ── Study-value scoring ──────────────────────────────────────────────────────

# Mirror of backend/lib/study-pipeline.js — kept consistent on purpose so a
# given user's chunk ordering is stable across the JS → Python migration.
_SOURCE_BASE = {
    "solution": 0.20,
    "exercise": 0.18,
    "lecture":  0.14,
    "exam":     0.16,
    "notes":    0.08,
    "summary":  0.06,
    "other":    0.0,
}

_HIGH_VALUE_KEYWORDS = (
    "aufgabe", "übung", "übungen", "beispiel", "beispiele", "lösung", "lösungen",
    "definition", "satz", "sätze", "theorem", "formel", "formeln", "formelzettel",
    "formelsammlung", "zusammenfassung", "prüfung", "klausur", "exercise", "example",
    "solution", "formula", "proof", "method", "algorithm", "procedure",
    "wichtig", "merke", "hinweis", "note", "tip", "exam", "summary", "cheatsheet",
)

_FORMULA_TOKEN_RE = re.compile(r"[=≈∑∫∂√π]|\b[a-z]_?\{?[a-z0-9]\}?\s*=")
_NUMBERED_LIST_RE = re.compile(r"^\s*\d+[\.\)]", re.MULTILINE)
_MISTAKE_RE = re.compile(r"fehler|mistake|achtung|attention|nicht verwechseln|do not|never|always", re.I)
_TOC_RE = re.compile(r"^\s*\d+\s*\.{3,}", re.MULTILINE)

# Phase 6 ranking constants.
# The previous +0.25 active-doc boost was larger than the typical similarity
# spread (~0.10-0.35), so chunks from the open doc swamped top-K even when
# another doc held the actual answer. Drop to a tie-breaker level — enough
# to win when similarity is comparable, but not enough to override a
# materially more relevant chunk from a different document.
# Was 0.10 — far too small to pull the open PDF into the top-K when other
# docs win on raw vector similarity. A real session showed AG_9.1 (the open
# file) completely absent from the top 12 while two old Klausur PDFs took
# every slot. The active doc is where the user's question is rooted; it
# should dominate ranking unless there is a strong reason not to.
_ACTIVE_DOC_BOOST = 1.00      # chunks from the doc the user is reading
_PREFERRED_DOC_BOOST = 0.20   # chunks from the user-selected document set (when used as a hint, not a filter)
_QUALITY_PENALTY_WEAK = 0.15
_QUALITY_PENALTY_FAILED = 0.30

# Phase 8 ranking constants. Starting points per plan-v2 lines 168-184.
# Tune against the math eval fixture (tests/fixtures/math_eval_cases.json).
_EXERCISE_MATCH_BOOST = 0.20      # chunk text contains the exercise number from the query
_DOC_TYPE_MATCH_BOOST = 0.15      # document_type matches the inferred question intent
_UNIT_MATCH_BOOST = 0.15          # a unit/symbol from the query appears in the chunk
_NEIGHBOUR_BOOST = 0.10           # chunk is on ±1 page from a top-scoring chunk in the same doc
_FILENAME_MATCH_BOOST = 0.10      # file_name contains a meaningful query token
_GENERIC_CHUNK_PENALTY = 0.20     # short, low-info chunk
_NO_QUERY_TERM_PENALTY = 0.30     # chunk doesn't contain any meaningful query token

# Phase 8 helpers — token filtering for "meaningful query term" checks.
_STOPWORDS = frozenset({
    # EN
    "the","a","an","of","to","in","on","for","with","is","are","be","by","at",
    "this","that","these","those","it","its","what","why","how","when","where",
    "i","you","we","they","me","my","our","your","please","do","does","did","can",
    "could","would","should","will","shall","not","no","yes","and","or","but","if",
    "as","so","than","then","into","from","about","explain","tell","show","give",
    # DE
    "der","die","das","den","dem","des","ein","eine","einen","einer","eines","und",
    "oder","aber","wenn","dann","ist","sind","war","waren","sein","mit","von","zu",
    "im","in","an","am","auf","für","fur","über","uber","unter","bei","aus","nach",
    "wie","was","wo","wer","wann","warum","bitte","welcher","welche","welches",
    "nicht","kein","keine","ja","nein","mir","dir","ihm","ihr","wir","ihr","sie",
})
_TOKEN_RE = re.compile(r"[a-zA-ZäöüÄÖÜß]+")

# Document-type intent table — maps question signal → expected doc_type.
# Used by the "+0.15 matching document type for question" boost.
_INTENT_KEYWORDS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("lösung", "loesung", "musterlösung", "solution", "answer", "musterloesung"),
     "solution_sheet"),
    (("aufgabe", "übung", "uebung", "exercise", "problem", "task"),
     "exercise_sheet"),
    (("formel", "formula", "equation", "gleichung", "theorem", "satz"),
     "formula_sheet"),
    (("klausur", "exam", "prüfung", "pruefung", "midterm", "final"),
     "exam"),
    (("zusammenfassung", "summary", "recap", "key takeaways"),
     "summary"),
)

# Exercise-ref regex: "Aufgabe 1.2", "Exercise 3 (a)", "Problem 4.1.2",
# "Übung 2 b", "Übungsaufgabe 9.1". Compound forms (Übungsaufgabe /
# Uebungsaufgabe) listed first so the alternation grabs them whole rather
# than stopping after the prefix and failing the digit lookahead.
# Subpart is captured ONLY when it's delimited: parens around it, or a single
# letter followed by whitespace / end-of-string / punctuation. This stops
# "Aufgabe 1.2 please" from being read as "1.2 (p)".
_EXERCISE_QUERY_RE = re.compile(
    r"\b(?:übungsaufgabe|uebungsaufgabe|aufgabe|übung|uebung|exercise|problem|task|beispiel)\s+"
    r"(\d+(?:\.\d+){0,3})"
    r"(?:\s*\(([a-zA-Z])\)|\s+([a-zA-Z])(?=\s|[\.\,\?\!\:]|$))?",
    re.IGNORECASE,
)


def _section_score(section_title: str | None) -> float:
    if not section_title:
        return 0.0
    lower = section_title.lower()
    return 0.20 if any(kw in lower for kw in _HIGH_VALUE_KEYWORDS) else 0.0


def _text_study_score(text: str) -> float:
    if not text:
        return 0.0
    score = 0.0
    lower = text.lower()
    if _FORMULA_TOKEN_RE.search(text):
        score += 0.15
    if _NUMBERED_LIST_RE.search(text):
        score += 0.08
    for kw in _HIGH_VALUE_KEYWORDS:
        if kw in lower:
            score += 0.06
    if _MISTAKE_RE.search(text):
        score += 0.08
    if _TOC_RE.search(text):
        score -= 0.20
    if len(text.strip().split("\n")) < 3 and len(text.strip()) < 80:
        score -= 0.15
    return score


def _meaningful_tokens(text: str) -> set[str]:
    """Lowercase, stopword-filtered, ≥3-char tokens. Used both to extract
    query-specific terms and to score chunk overlap with them."""
    if not text:
        return set()
    return {
        t.lower()
        for t in _TOKEN_RE.findall(text)
        if len(t) >= 3 and t.lower() not in _STOPWORDS
    }


def infer_question_intent(question: str) -> str | None:
    """Map a question to the document_type most likely to contain the
    answer. Returns None when the signal is weak — better to leave the
    Phase 8 doc-type boost dormant than to misroute generic questions.
    """
    if not question:
        return None
    lower = question.lower()
    # Walk the intent table; first match wins. Order matters (solution
    # before exercise so "Lösung von Aufgabe 1" picks solution_sheet).
    for needles, doc_type in _INTENT_KEYWORDS:
        if any(n in lower for n in needles):
            return doc_type
    return None


def _is_generic_chunk(text: str) -> bool:
    """Short, low-info chunks (≤ 120 chars, fewer than 2 meaningful
    tokens) are penalised so they don't crowd out specific answers."""
    if not text:
        return True
    stripped = text.strip()
    if len(stripped) <= 120 and len(_meaningful_tokens(stripped)) < 2:
        return True
    return False


# Units the query-overlap boost knows about. Matching tokens here in
# both the query and a chunk is strong evidence the chunk is the answer.
_KNOWN_UNITS = re.compile(
    r"\b(?:m|cm|mm|km|kg|g|n|nm|kn|pa|kpa|mpa|gpa|j|kj|w|kw|s|ms|hz|"
    r"khz|a|ma|v|mv|kv|c|k|rad|deg|°c|°f|°)\b",
    re.IGNORECASE,
)


def _query_units(question: str) -> set[str]:
    if not question:
        return set()
    return {m.group(0).lower() for m in _KNOWN_UNITS.finditer(question)}


def _study_score(
    chunk: dict[str, Any],
    *,
    active_document_id: str | None = None,
    preferred_document_ids: set[str] | None = None,
    quality_by_doc_page: dict[tuple[str, int], str] | None = None,
    # Phase 8 context — all optional so legacy callers still work.
    question_intent: str | None = None,
    query_tokens: set[str] | None = None,
    query_units: set[str] | None = None,
    exercise_number: str | None = None,
    doc_meta: dict[str, dict[str, str | None]] | None = None,
) -> float:
    similarity = chunk.get("similarity") or 0.0
    source = chunk.get("source_type") or "other"
    official = bool(chunk.get("is_official"))
    score = (
        similarity
        + _SOURCE_BASE.get(source, 0.0)
        + (0.08 if official else 0.0)
        + _section_score(chunk.get("section_title"))
        + _text_study_score(chunk.get("chunk_text") or "")
    )
    doc_id = chunk.get("document_id")
    chunk_text = chunk.get("chunk_text") or ""

    # Phase 6: active & preferred doc boosts.
    if active_document_id and doc_id == active_document_id:
        score += _ACTIVE_DOC_BOOST
    if preferred_document_ids and doc_id in preferred_document_ids:
        score += _PREFERRED_DOC_BOOST

    # Phase 1: penalise chunks that originated from weak/failed extraction pages.
    if quality_by_doc_page and doc_id:
        page = chunk.get("page_start")
        if isinstance(page, int):
            quality = quality_by_doc_page.get((doc_id, page))
            if quality == "weak":
                score -= _QUALITY_PENALTY_WEAK
            elif quality == "failed":
                score -= _QUALITY_PENALTY_FAILED

    # ── Phase 8 ─────────────────────────────────────────────────────────────

    doc_meta_row = doc_meta.get(doc_id) if (doc_meta and doc_id) else None

    # +0.20: chunk text mentions the exact exercise number from the query.
    if exercise_number and exercise_number in chunk_text:
        score += _EXERCISE_MATCH_BOOST

    # +0.15: document_type matches inferred question intent.
    if question_intent and doc_meta_row:
        if doc_meta_row.get("document_type") == question_intent:
            score += _DOC_TYPE_MATCH_BOOST

    # +0.15: a unit from the query appears in the chunk (strong signal for
    # numerical/engineering questions).
    if query_units:
        chunk_lower = chunk_text.lower()
        if any(u in chunk_lower for u in query_units):
            score += _UNIT_MATCH_BOOST

    # +0.10: file_name shares a meaningful token with the query.
    if query_tokens and doc_meta_row:
        fn = (doc_meta_row.get("file_name") or "").lower()
        if fn and any(tok in fn for tok in query_tokens):
            score += _FILENAME_MATCH_BOOST

    # -0.20: chunk is short and low-info.
    if _is_generic_chunk(chunk_text):
        score -= _GENERIC_CHUNK_PENALTY

    # -0.30: chunk doesn't contain ANY meaningful query token (BM25 already
    # filtered hard, but this catches embedding-only matches that are
    # topically adjacent rather than on-point).
    if query_tokens:
        chunk_tokens = _meaningful_tokens(chunk_text)
        if not (chunk_tokens & query_tokens):
            score -= _NO_QUERY_TERM_PENALTY

    return score


# ── Public surface ───────────────────────────────────────────────────────────


@dataclass
class RetrievedChunk:
    chunk_id: str
    document_id: str
    page_start: int | None
    page_end: int | None
    text: str
    score: float
    similarity: float
    chunk_type: str
    section_title: str | None

    def to_api(self) -> dict[str, Any]:
        return {
            "chunkId": self.chunk_id,
            "documentId": self.document_id,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "text": self.text,
            "score": round(self.score, 4),
            "similarity": round(self.similarity, 4),
            "chunkType": self.chunk_type,
            "sectionTitle": self.section_title,
        }


_DEFAULT_CANDIDATES = 60
_MIN_SIMILARITY = 0.10


def retrieve_chunks(
    *,
    user_id: str,
    course_id: str,
    query: str,
    document_ids: list[str] | None = None,
    active_document_id: str | None = None,
    top_k: int = 12,
    min_similarity: float = _MIN_SIMILARITY,
) -> list[RetrievedChunk]:
    """Return up to top_k chunks for the question, reranked by study value.

    `document_ids` is still a hard filter when set. `active_document_id` adds
    a +0.25 ranking boost without filtering, so the active doc wins ties but
    course-wide retrieval still surfaces supporting material from other docs.
    """
    if not query.strip():
        return []

    embedding = embed_texts([query])[0]
    sb = get_supabase()

    # Phase 7: expand the BM25 side for math questions (exercise refs,
    # formula keywords, …). Vector side keeps the original question so
    # semantic similarity isn't diluted.
    # Local import: query_expansion imports from this module for the
    # exercise-reference detector, so a top-level import would cycle.
    from .query_expansion import expand_query  # noqa: WPS433
    expanded = expand_query(query)

    # Format the vector the way pgvector expects from RPC: "[v1,v2,...]" string.
    payload: dict[str, Any] = {
        "p_user_id":     user_id,
        "p_course_id":   course_id,
        "p_embedding":   "[" + ",".join(f"{v:.7f}" for v in embedding) + "]",
        "p_query":       expanded.text,
        "p_match_count": _DEFAULT_CANDIDATES,
        "p_threshold":   min_similarity,
    }
    if document_ids:
        payload["p_document_ids"] = list(document_ids)

    try:
        resp = sb.rpc("match_chunks_hybrid", payload).execute()
    except Exception:
        log.exception("match_chunks_hybrid failed")
        return []

    rows: list[dict[str, Any]] = resp.data or []

    # If the document filter returned nothing, try once more without it as a
    # safety net — same behaviour the JS pipeline already had.
    if not rows and document_ids:
        payload.pop("p_document_ids", None)
        try:
            resp = sb.rpc("match_chunks_hybrid", payload).execute()
            rows = [
                r for r in (resp.data or [])
                if r.get("document_id") in set(document_ids)
            ]
        except Exception:
            log.exception("match_chunks_hybrid (fallback) failed")
            rows = []

    if not rows:
        return []

    # Look up extraction_quality for the (document_id, page_start) pairs we
    # actually got back, so the ranker can downweight chunks from weak pages.
    # Best-effort: a query failure leaves the map empty and we score without it.
    quality_map = _load_page_qualities(sb, rows)

    # Phase 8: load document_type + file_name for the candidate docs so the
    # ranker can apply doc-type-match and filename-match boosts.
    doc_meta = _load_doc_metadata(sb, [r.get("document_id") for r in rows if r.get("document_id")])

    preferred = set(document_ids) if document_ids else None
    question_intent = infer_question_intent(query)
    query_tokens = _meaningful_tokens(query)
    query_units = _query_units(query)
    ex_ref = find_exercise_reference(query)
    exercise_number = ex_ref[0] if ex_ref else None

    # Rerank by study value
    ranked: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        ranked.append((
            _study_score(
                row,
                active_document_id=active_document_id,
                preferred_document_ids=preferred,
                quality_by_doc_page=quality_map,
                question_intent=question_intent,
                query_tokens=query_tokens,
                query_units=query_units,
                exercise_number=exercise_number,
                doc_meta=doc_meta,
            ),
            row,
        ))
    ranked.sort(key=lambda pair: pair[0], reverse=True)

    # Phase 8: one-shot neighbour boost on the post-sort list.
    ranked = _apply_neighbour_boost(ranked)

    chosen = ranked[: max(top_k, 1)]

    # Fetch chunk_type for each in one batch — RPC predates the new column.
    chunk_ids = [r["id"] for _, r in chosen if r.get("id")]
    type_map: dict[str, str] = {}
    if chunk_ids:
        try:
            ct_resp = (
                sb.table("document_chunks")
                .select("id, chunk_type")
                .in_("id", chunk_ids)
                .execute()
            )
            for ct in ct_resp.data or []:
                type_map[ct["id"]] = ct.get("chunk_type") or "general"
        except Exception:
            log.exception("chunk_type lookup failed; defaulting to 'general'")

    return [
        RetrievedChunk(
            chunk_id=row["id"],
            document_id=row["document_id"],
            page_start=row.get("page_start"),
            page_end=row.get("page_end"),
            text=row.get("chunk_text") or "",
            score=score,
            similarity=row.get("similarity") or 0.0,
            chunk_type=type_map.get(row["id"], "general"),
            section_title=row.get("section_title"),
        )
        for score, row in chosen
    ]


# ── Page-quality lookup ──────────────────────────────────────────────────────


def _load_doc_metadata(sb, doc_ids: list[str]) -> dict[str, dict[str, str | None]]:
    """For each unique document_id, fetch (document_type, file_name).
    Best-effort: returns {} on any DB failure so ranking degrades to the
    Phase 6 behaviour rather than crashing."""
    if not doc_ids:
        return {}
    try:
        resp = (
            sb.table("documents")
            .select("id, document_type, file_name")
            .in_("id", list(set(doc_ids)))
            .execute()
        )
    except Exception:
        log.exception("documents metadata lookup failed")
        return {}
    out: dict[str, dict[str, str | None]] = {}
    for r in resp.data or []:
        out[r["id"]] = {
            "document_type": r.get("document_type"),
            "file_name":     r.get("file_name"),
        }
    return out


def _apply_neighbour_boost(
    ranked: list[tuple[float, dict[str, Any]]],
    *,
    top_n: int = 5,
) -> list[tuple[float, dict[str, Any]]]:
    """Boost any chunk on the same document within ±1 page of a top-N
    chunk. Idea: when one chunk is clearly relevant, its immediate
    neighbours probably continue the answer (formula → derivation,
    statement → solution). Applied once, not iteratively."""
    if len(ranked) < 2:
        return ranked

    anchors: set[tuple[str, int]] = set()
    for score, row in ranked[:top_n]:
        doc_id = row.get("document_id")
        page = row.get("page_start")
        if doc_id and isinstance(page, int):
            anchors.add((doc_id, page))
    if not anchors:
        return ranked

    boosted: list[tuple[float, dict[str, Any]]] = []
    for score, row in ranked:
        doc_id = row.get("document_id")
        page = row.get("page_start")
        if doc_id and isinstance(page, int):
            already_anchor = (doc_id, page) in anchors
            if not already_anchor:
                if (doc_id, page - 1) in anchors or (doc_id, page + 1) in anchors:
                    score += _NEIGHBOUR_BOOST
        boosted.append((score, row))
    boosted.sort(key=lambda pair: pair[0], reverse=True)
    return boosted


def _load_page_qualities(sb, rows: list[dict[str, Any]]) -> dict[tuple[str, int], str]:
    """For the (document_id, page_start) pairs in `rows`, fetch the matching
    extraction_quality from document_pages. Returns {} on any query failure.
    """
    pairs: set[tuple[str, int]] = set()
    for row in rows:
        doc_id = row.get("document_id")
        page = row.get("page_start")
        if doc_id and isinstance(page, int):
            pairs.add((doc_id, page))
    if not pairs:
        return {}
    doc_ids = list({doc for doc, _ in pairs})
    pages = list({page for _, page in pairs})
    try:
        resp = (
            sb.table("document_pages")
            .select("document_id, page_number, extraction_quality")
            .in_("document_id", doc_ids)
            .in_("page_number", pages)
            .execute()
        )
    except Exception:
        log.exception("document_pages extraction_quality lookup failed")
        return {}
    out: dict[tuple[str, int], str] = {}
    for r in resp.data or []:
        q = r.get("extraction_quality")
        if q:
            out[(r["document_id"], r["page_number"])] = q
    return out


# ── Exact-match exercise lookup (Phase 5/6) ─────────────────────────────────


@dataclass
class ExerciseHit:
    """A direct hit on a document_exercises row — surfaces ahead of vector
    retrieval when the user's query references an exercise by number.
    """

    document_id: str
    exercise_number: str
    subpart: str | None
    page_start: int
    page_end: int
    statement_markdown: str
    solution_markdown: str | None

    def to_api(self) -> dict[str, Any]:
        return {
            "documentId": self.document_id,
            "exerciseNumber": self.exercise_number,
            "subpart": self.subpart,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "statementMarkdown": self.statement_markdown,
            "solutionMarkdown": self.solution_markdown,
        }


def find_exercise_reference(query: str) -> tuple[str, str | None] | None:
    """If the user's query references an exercise by number, return
    (exercise_number, subpart). Otherwise None.
    """
    if not query:
        return None
    m = _EXERCISE_QUERY_RE.search(query)
    if not m:
        return None
    subpart = m.group(2) or m.group(3) or ""  # bracket form vs isolated letter
    return (m.group(1), subpart.lower() or None)


def retrieve_exercise_block(
    *,
    user_id: str,
    course_id: str,
    query: str,
    document_ids: list[str] | None = None,
    active_document_id: str | None = None,
) -> ExerciseHit | None:
    """Look up the exercise block referenced in the query, if any.

    Search order (first hit wins):
      1. active document (when set)
      2. user-selected documents (when set)
      3. anywhere in the course
    """
    ref = find_exercise_reference(query)
    if not ref:
        return None
    exercise_number, subpart = ref
    sb = get_supabase()

    def _select(doc_filter: list[str] | None) -> ExerciseHit | None:
        try:
            q = (
                sb.table("document_exercises")
                .select(
                    "document_id, exercise_number, subpart, page_start, page_end, "
                    "statement_markdown, solution_markdown"
                )
                .eq("user_id", user_id)
                .eq("course_id", course_id)
                .eq("exercise_number", exercise_number)
            )
            if doc_filter:
                q = q.in_("document_id", doc_filter)
            if subpart:
                q = q.eq("subpart", subpart)
            resp = q.limit(1).execute()
        except Exception:
            log.exception("document_exercises lookup failed")
            return None
        rows = resp.data or []
        if not rows:
            return None
        r = rows[0]
        return ExerciseHit(
            document_id=r["document_id"],
            exercise_number=r["exercise_number"],
            subpart=r.get("subpart"),
            page_start=r["page_start"],
            page_end=r["page_end"],
            statement_markdown=r.get("statement_markdown") or "",
            solution_markdown=r.get("solution_markdown"),
        )

    if active_document_id:
        hit = _select([active_document_id])
        if hit:
            return hit
    if document_ids:
        hit = _select(document_ids)
        if hit:
            return hit
    return _select(None)


# ── Exact-match formula lookup ──────────────────────────────────────────────


@dataclass
class FormulaHit:
    """A direct hit on a document_formulas row. Surfaces ahead of vector
    retrieval when the user's query references a named formula or symbol —
    the analogue of ExerciseHit for formulas. Prepended to chunks so the
    answerer sees the canonical formula before any similarity-based context.
    """

    document_id: str
    formula_name: str | None
    formula_markdown: str
    symbols: list[str]
    page_number: int

    def to_api(self) -> dict[str, Any]:
        return {
            "documentId":       self.document_id,
            "formulaName":      self.formula_name,
            "formulaMarkdown":  self.formula_markdown,
            "symbols":          self.symbols,
            "pageNumber":       self.page_number,
        }


# Keywords that *imply* a formula question. Matching one is necessary
# (otherwise every question fires a formula lookup) but not sufficient —
# we still need a meaningful query token or symbol to match against.
_FORMULA_INTENT_KEYWORDS = (
    "formel", "formula", "gleichung", "equation", "satz", "theorem",
    "moment", "spannung", "kraft", "energie", "leistung", "ableitung",
    "integral", "taylor", "fourier", "matrix", "vektor", "betrag",
)


def find_formula_intent(query: str) -> set[str]:
    """Return the meaningful tokens from the query when it looks like a
    formula question. Empty set = don't bother hitting document_formulas.
    """
    if not query:
        return set()
    lower = query.lower()
    if not any(kw in lower for kw in _FORMULA_INTENT_KEYWORDS):
        return set()
    return _meaningful_tokens(query)


def retrieve_formula_block(
    *,
    user_id: str,
    course_id: str,
    query: str,
    document_ids: list[str] | None = None,
    active_document_id: str | None = None,
    max_hits: int = 3,
) -> list[FormulaHit]:
    """Look up canonical formulas matching the query.

    Match heuristic (cheap, no embeddings):
      - formula_name ILIKE any meaningful query token, OR
      - any element of symbols[] equals a query token (case-insensitive)

    Search order: active document → selected documents → whole course.
    Returns up to max_hits formulas, de-duplicated by (document_id, page).
    Returns [] when the query has no formula intent or no rows match.
    """
    tokens = find_formula_intent(query)
    if not tokens:
        return []
    sb = get_supabase()

    # Two narrow queries (name-match + symbols-overlap), merged in Python.
    # Avoids brittle PostgREST `or=` compound filters with commas inside
    # ilike patterns and array literals — and keeps the SQL trivially safe.
    select_cols = (
        "document_id, formula_name, formula_markdown, symbols, page_number"
    )
    name_tokens = [t for t in tokens if len(t) >= 4]
    symbol_tokens = list(tokens)

    def _base(doc_filter: list[str] | None):
        q = (
            sb.table("document_formulas")
            .select(select_cols)
            .eq("user_id", user_id)
            .eq("course_id", course_id)
        )
        if doc_filter:
            q = q.in_("document_id", doc_filter)
        return q

    def _select(doc_filter: list[str] | None) -> list[FormulaHit]:
        rows: list[dict] = []
        # 1) formula_name ILIKE any meaningful token
        for tok in name_tokens:
            try:
                resp = _base(doc_filter).ilike(
                    "formula_name", f"%{tok}%",
                ).limit(max_hits).execute()
                rows.extend(resp.data or [])
            except Exception:
                log.exception("document_formulas name lookup failed")
        # 2) symbols overlap with query tokens (text[] cs)
        if symbol_tokens:
            try:
                resp = _base(doc_filter).overlaps(
                    "symbols", symbol_tokens,
                ).limit(max_hits).execute()
                rows.extend(resp.data or [])
            except Exception:
                log.exception("document_formulas symbols lookup failed")

        # De-duplicate by (document_id, page_number) preserving first occurrence.
        seen_local: set[tuple[str, int]] = set()
        out: list[FormulaHit] = []
        for r in rows:
            key = (r["document_id"], r["page_number"])
            if key in seen_local:
                continue
            seen_local.add(key)
            out.append(FormulaHit(
                document_id=r["document_id"],
                formula_name=r.get("formula_name"),
                formula_markdown=r.get("formula_markdown") or "",
                symbols=list(r.get("symbols") or []),
                page_number=r["page_number"],
            ))
            if len(out) >= max_hits:
                break
        return out

    seen: set[tuple[str, int]] = set()
    hits: list[FormulaHit] = []

    def _push(new_hits: list[FormulaHit]) -> None:
        for h in new_hits:
            key = (h.document_id, h.page_number)
            if key in seen:
                continue
            seen.add(key)
            hits.append(h)

    if active_document_id:
        _push(_select([active_document_id]))
    if document_ids and len(hits) < max_hits:
        _push(_select(document_ids))
    if len(hits) < max_hits:
        _push(_select(None))

    return hits[:max_hits]
