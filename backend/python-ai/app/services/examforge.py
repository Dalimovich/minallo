"""ExamForge generation and grading."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from . import mastery
from .learning_agent import get_course_topic_map, retrieve_learning_context
from .llm_json import chat_json
from .quiz import _fetch_course_topics, generate_quiz
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


_LETTERS = ("A", "B", "C", "D")
_VALID_TYPES = {"mcq", "true_false", "short_answer"}


def _option_array(options: Any) -> list[str]:
    if isinstance(options, list):
        return [str(x or "") for x in options[:4]]
    if isinstance(options, dict):
        return [str(options.get(letter) or "") for letter in _LETTERS]
    return []


def _source_page(source: str | None) -> str | None:
    if not source:
        return None
    parts = [p.strip() for p in source.split(",")]
    return parts[-1] if len(parts) > 1 else None


def _source_doc(source: str | None) -> str | None:
    if not source:
        return None
    return source.split(",")[0].strip() or None


def _normalise_question(row: dict[str, Any], question_id: str | None = None) -> dict[str, Any]:
    qtype = str(row.get("type") or "mcq").strip().lower()
    if qtype not in _VALID_TYPES:
        qtype = "mcq"
    options = _option_array(row.get("options"))
    answer = row.get("answer")
    if qtype == "mcq":
        if isinstance(answer, int) and 0 <= answer < len(_LETTERS):
            answer = _LETTERS[answer]
        answer = str(answer or "").strip().upper()[:1]
        if answer not in _LETTERS:
            answer = "A"
    elif qtype == "true_false":
        options = ["True", "False"]
        if isinstance(answer, bool):
            answer = "true" if answer else "false"
        else:
            answer = str(answer or "").strip().lower()
            answer = "true" if answer in ("true", "wahr", "yes", "ja") else "false"
    else:
        options = []
        answer = str(answer or "").strip()
    source = row.get("source")
    return {
        "id": question_id,
        "type": qtype,
        "question": row.get("question") or "",
        "options": options,
        "answer": answer,
        "explanation": row.get("explanation") or "",
        "difficulty": row.get("difficulty") or "medium",
        "topic": row.get("topic"),
        "points": int(row.get("points") or 1),
        "source": source,
        "sources": [{
            "fileName": _source_doc(source),
            "pages": _source_page(source),
        }] if source else [],
        "validation": {
            "status": row.get("validation_status") or "grounded",
            "score": row.get("validation_score") or 1,
        },
    }


# ── Phase 3: grounded, blueprint-driven generation ────────────────────────────

_EXAMFORGE_SYSTEM = (
    "You are ExamForge by Minallo, generating a university practice exam.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Do not use outside knowledge.\n"
    "\n"
    "Rules:\n"
    "- Follow the per-question plan (type, topic, difficulty) as closely as the "
    "context allows.\n"
    "- Every question MUST be answerable from the context and MUST cite the chunk "
    "id(s) it is based on in \"source_chunk_ids\" (copy the <id> from the "
    "[chunk:<id> ...] tags) and the page number(s) in \"source_pages\".\n"
    "- If the context cannot support a planned question, replace it with one the "
    "context DOES support (same type), still cited. Never invent unsupported "
    "facts and never cite a chunk id that is not present in the context.\n"
    "- mcq: exactly 4 options; \"answer\" is the correct option LETTER (A-D). "
    "Wrong options must be plausible (common student mistakes), never jokes.\n"
    "- true_false: \"answer\" is \"true\" or \"false\".\n"
    "- short_answer: no options; \"answer\" is a concise model answer and "
    "\"explanation\" is the grading rubric.\n"
    "- Match the course/professor style when exercise-style context is present.\n"
    "\n"
    "Return ONLY JSON:\n"
    '{"questions":[{"question_type":"mcq|true_false|short_answer","topic":"",'
    '"difficulty":"easy|medium|hard","points":1,"question":"","options":["","","",""],'
    '"answer":"","explanation":"","source_chunk_ids":[],"source_pages":[]}]}'
)


def _build_blueprint(
    *,
    topic_map: list[dict[str, Any]],
    requested: int,
    types: list[str],
    difficulty: str,
    topic_focus: str | None,
) -> list[dict[str, Any]]:
    """Distribute the requested questions across topics + types.

    Topics come from the importance-ranked course topic map (so high-importance
    topics are covered first); an explicit ``topic_focus`` overrides the map.
    Deterministic — unit tested.
    """
    if topic_focus:
        topics: list[str | None] = [topic_focus]
    else:
        topics = [t.get("name") for t in (topic_map or []) if t.get("name")] or [None]
    diff_cycle = ["easy", "medium", "hard"] if difficulty == "mixed" else [difficulty]
    return [
        {
            "topic": topics[i % len(topics)],
            "question_type": types[i % len(types)],
            "difficulty": diff_cycle[i % len(diff_cycle)],
        }
        for i in range(requested)
    ]


def _pool_evidence(
    *, user_id: str, course_id: str, blueprint: list[dict[str, Any]], document_ids: list[str] | None
) -> list[dict[str, Any]]:
    """Retrieve a deduped evidence pool for the blueprint's topics via the
    Learning Agent's purpose-aware retrieval (purpose=exam_generation)."""
    distinct: list[str | None] = []
    for b in blueprint:
        t = b.get("topic")
        if t and t not in distinct:
            distinct.append(t)
    distinct = distinct[:5] or [None]
    seen: set[str] = set()
    pooled: list[dict[str, Any]] = []
    for t in distinct:
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=t,
                query=(t or "key concepts, definitions, formulas, exercises"),
                document_ids=document_ids or None,
                purpose="exam_generation",
                top_k=8,
            )
        except Exception:  # noqa: BLE001
            log.exception("examforge evidence retrieval failed (topic=%s)", t)
            chunks = []
        for c in chunks:
            cid = c.get("chunkId")
            if cid and cid not in seen:
                seen.add(cid)
                pooled.append(c)
    return pooled[:24]


def _format_evidence(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> str:
    out: list[str] = []
    for c in chunks:
        cid = c.get("chunkId")
        if not cid:
            continue
        dn = doc_names.get(c.get("documentId") or "") or "source"
        pg = c.get("pageStart")
        text = (c.get("text") or "").strip().replace("\r", " ")
        if len(text) > 900:
            text = text[:900] + " …"
        out.append(f"[chunk:{cid} | {dn}" + (f" p.{pg}" if pg else "") + f"]\n{text}")
    return "\n\n".join(out)


def _grounded_questions(
    *,
    blueprint: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    doc_names: dict[str, str],
    diff: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """One grounded generation call. Returns (normalised questions, meta).

    Questions are validated LOCALLY: a question is ``grounded`` when it cites at
    least one chunk id we actually supplied; otherwise ``ungrounded`` (kept but
    flagged). Full LLM validation (verify_answer) is the async Phase 3b step.
    """
    valid_ids = {c.get("chunkId") for c in evidence if c.get("chunkId")}
    cid_meta: dict[str, tuple[str | None, Any]] = {}
    for c in evidence:
        cid = c.get("chunkId")
        if cid:
            cid_meta[cid] = (doc_names.get(c.get("documentId") or "") or None, c.get("pageStart"))

    plan = "\n".join(
        f"{i + 1}. type={b['question_type']} topic={b.get('topic') or 'any'} difficulty={b['difficulty']}"
        for i, b in enumerate(blueprint)
    )
    user = (
        "COURSE CONTEXT (each block tagged [chunk:<id> | <doc> p.<page>]):\n\n"
        + _format_evidence(evidence, doc_names)
        + "\n\nGENERATE these questions:\n"
        + plan
    )
    meta: dict[str, Any] = {"model": None, "promptTokens": None, "completionTokens": None}
    try:
        res = chat_json(system=_EXAMFORGE_SYSTEM, user=user, max_tokens=3500)
    except Exception:  # noqa: BLE001
        log.exception("examforge grounded generation failed")
        return [], meta
    meta = {"model": res.model, "promptTokens": res.prompt_tokens, "completionTokens": res.completion_tokens}
    data = res.data if isinstance(res.data, dict) else {}
    raw_qs = data.get("questions") if isinstance(data.get("questions"), list) else []

    out: list[dict[str, Any]] = []
    for raw in raw_qs:
        if not isinstance(raw, dict):
            continue
        cited = [str(x) for x in (raw.get("source_chunk_ids") or []) if str(x) in valid_ids]
        source: str | None = None
        pages: list[str] = []
        if cited:
            dn, pg = cid_meta.get(cited[0], (None, None))
            if dn:
                source = str(dn) + (f", {pg}" if pg else "")
            pages = [str(cid_meta[c][1]) for c in cited if cid_meta.get(c) and cid_meta[c][1] is not None]
        q = _normalise_question({
            "type": raw.get("question_type") or raw.get("type"),
            "question": raw.get("question"),
            "options": raw.get("options"),
            "answer": raw.get("answer") if raw.get("answer") is not None else raw.get("correct_answer"),
            "explanation": raw.get("explanation"),
            "difficulty": raw.get("difficulty") or diff,
            "topic": raw.get("topic"),
            "points": raw.get("points") or 1,
            "source": source,
            "validation_status": "grounded" if cited else "ungrounded",
            "validation_score": 1 if cited else 0.4,
        })
        if not str(q.get("question") or "").strip():
            continue
        q["source_chunk_ids"] = cited
        q["source_pages_list"] = pages
        out.append(q)
    return out, meta


def generate_examforge(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    requested_count: int,
    difficulty: str,
    topic: str | None,
    question_types: list[str] | None,
    doc_names: dict[str, str],
) -> dict[str, Any]:
    requested = max(1, min(int(requested_count or 6), 20))
    diff = difficulty if difficulty in ("easy", "medium", "hard", "mixed") else "medium"
    topic_query = (topic or "").strip()
    types = [t for t in (question_types or ["mcq", "true_false", "short_answer"]) if t in _VALID_TYPES]
    if not types:
        types = ["mcq", "true_false", "short_answer"]

    # Phase 3: try grounded, blueprint-driven generation first. Falls back to the
    # quiz-based generator when there is no retrievable evidence or generation
    # produced nothing — so behaviour never regresses below the old path.
    meta: dict[str, Any] = {"model": None, "promptTokens": None, "completionTokens": None}
    warning: str | None = None
    grounded_used = False
    grounded_sources: list[dict[str, Any]] = []
    try:
        topic_map = get_course_topic_map(user_id, course_id)
    except Exception:  # noqa: BLE001
        log.exception("examforge: topic map read failed")
        topic_map = []
    blueprint = _build_blueprint(
        topic_map=topic_map, requested=requested, types=types, difficulty=diff,
        topic_focus=topic_query or None,
    )
    evidence = _pool_evidence(
        user_id=user_id, course_id=course_id, blueprint=blueprint, document_ids=document_ids,
    )
    questions: list[dict[str, Any]] = []
    if evidence:
        questions, meta = _grounded_questions(
            blueprint=blueprint, evidence=evidence, doc_names=doc_names, diff=diff,
        )
        grounded_used = bool(questions)
        if grounded_used:
            seen_docs: set[str] = set()
            for c in evidence:
                dn = doc_names.get(c.get("documentId") or "")
                if dn and dn not in seen_docs:
                    seen_docs.add(dn)
                    grounded_sources.append({"fileName": dn})

    if not questions:
        quiz_out = generate_quiz(
            user_id=user_id,
            course_id=course_id,
            document_ids=document_ids,
            requested_count=requested,
            difficulty=diff,
            question_types=types,
            doc_names=doc_names,
        )
        questions = [_normalise_question(q) for q in quiz_out.get("questions", [])]
        warning = quiz_out.get("warning")
        grounded_sources = quiz_out.get("groundedSources", [])
        meta = {
            "model": quiz_out.get("model"),
            "promptTokens": quiz_out.get("promptTokens"),
            "completionTokens": quiz_out.get("completionTokens"),
        }

    sb = get_supabase()
    session_id: str | None = None
    saved_questions: list[dict[str, Any]] = questions
    if questions:
        try:
            session_resp = sb.table("exam_sessions").insert({
                "user_id": user_id,
                "course_id": course_id,
                "title": topic_query or "ExamForge",
                "difficulty": diff,
                "question_count": len(questions),
                "question_types": types,
                "source_document_ids": document_ids or None,
                "topic": topic_query or None,
                "status": "ready",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).execute()
            session_id = session_resp.data[0]["id"]
            question_rows = []
            for idx, q in enumerate(questions):
                src = (q.get("sources") or [{}])[0] if isinstance(q.get("sources"), list) else {}
                pages = q.get("source_pages_list") or ([src.get("pages")] if src.get("pages") else None)
                chunk_ids = q.get("source_chunk_ids") or None
                val = q.get("validation") or {}
                question_rows.append({
                    "exam_session_id": session_id,
                    "user_id": user_id,
                    "position": idx,
                    "question_type": q["type"],
                    "topic": q.get("topic"),
                    "difficulty": q.get("difficulty") or diff,
                    "points": q.get("points") or 1,
                    "question_text": q["question"],
                    "options": q.get("options") or [],
                    "correct_answer": str(q.get("answer") or ""),
                    "explanation": q.get("explanation") or "",
                    "source_chunk_ids": chunk_ids,
                    "source_document_names": [src.get("fileName")] if src.get("fileName") else None,
                    "source_pages": pages,
                    "validation_status": val.get("status") or "grounded",
                    "validation_score": val.get("score") if val.get("score") is not None else 1,
                })
            saved_resp = sb.table("exam_questions").insert(question_rows).execute()
            saved_rows = saved_resp.data or []
            if saved_rows:
                saved_questions = [
                    {**questions[idx], "id": row.get("id")}
                    for idx, row in enumerate(saved_rows)
                    if idx < len(questions)
                ]
        except Exception:
            log.exception("examforge persistence failed")

    topics = _fetch_course_topics(course_id, document_ids)
    return {
        "sessionId": session_id,
        "title": topic_query or "ExamForge",
        "requestedCount": requested,
        "actualCount": len(saved_questions),
        "questions": saved_questions,
        "topicMap": [{"name": t} for t in topics[:24]],
        "grounded": grounded_used,
        "groundedSources": grounded_sources,
        "warning": warning,
        "model": meta.get("model"),
        "promptTokens": meta.get("promptTokens"),
        "completionTokens": meta.get("completionTokens"),
    }


def grade_examforge_answer(
    *,
    user_id: str,
    exam_session_id: str,
    exam_question_id: str,
    user_answer: str,
) -> dict[str, Any]:
    sb = get_supabase()
    q_resp = (
        sb.table("exam_questions")
        .select("id, exam_session_id, user_id, question_type, question_text, correct_answer, explanation, points, topic")
        .eq("id", exam_question_id)
        .eq("exam_session_id", exam_session_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = q_resp.data or []
    if not rows:
        return {"ok": False, "error": "question not found"}
    q = rows[0]
    qtype = str(q.get("question_type") or "mcq")
    submitted = (user_answer or "").strip()
    correct = str(q.get("correct_answer") or "").strip()
    max_points = float(q.get("points") or 1)
    if qtype == "short_answer":
        graded = _grade_short_answer(
            question=str(q.get("question_text") or ""),
            expected=correct,
            submitted=submitted,
            explanation=str(q.get("explanation") or ""),
            max_points=max_points,
        )
        is_correct = bool(graded["isCorrect"])
        score = float(graded["score"])
        feedback = str(graded["feedback"])
    elif qtype == "true_false":
        norm_submitted = submitted.lower()
        norm_correct = correct.lower()
        is_correct = norm_submitted == norm_correct
        score = max_points if is_correct else 0.0
        feedback = "Correct." if is_correct else "Not quite. " + (q.get("explanation") or "")
    else:
        norm_submitted = submitted.upper()[:1]
        norm_correct = correct.upper()[:1]
        is_correct = norm_submitted == norm_correct
        score = max_points if is_correct else 0.0
        feedback = "Correct." if is_correct else "Not quite. " + (q.get("explanation") or "")
    try:
        sb.table("exam_answers").insert({
            "exam_question_id": exam_question_id,
            "exam_session_id": exam_session_id,
            "user_id": user_id,
            "user_answer": submitted,
            "is_correct": is_correct,
            "score": score,
            "feedback": feedback,
        }).execute()
    except Exception:
        log.exception("examforge answer save failed")

    # Phase 3: feed the graded attempt into the shared topic-mastery table so
    # exam performance surfaces the same weak topics as quizzes (grade →
    # mastery). Best-effort; failures here never affect the grade response.
    topic = q.get("topic")
    if topic:
        try:
            sess = (
                sb.table("exam_sessions")
                .select("course_id")
                .eq("id", exam_session_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            course_id = ((sess.data or [{}])[0] or {}).get("course_id")
            if course_id:
                mastery.record_course_topic_attempt(
                    user_id=user_id, course_id=course_id, topic=topic, correct=is_correct,
                )
        except Exception:
            log.exception("examforge mastery record failed")

    return {
        "ok": True,
        "isCorrect": is_correct,
        "score": score,
        "correctAnswer": correct,
        "feedback": feedback,
    }


def _simple_text_similarity(a: str, b: str) -> float:
    a_words = set(re.findall(r"[a-zA-Z0-9_]+", a.lower()))
    b_words = set(re.findall(r"[a-zA-Z0-9_]+", b.lower()))
    if not a_words or not b_words:
        return 0.0
    return len(a_words & b_words) / max(1, len(b_words))


def _grade_short_answer(
    *,
    question: str,
    expected: str,
    submitted: str,
    explanation: str,
    max_points: float,
) -> dict[str, Any]:
    if not submitted.strip():
        return {"isCorrect": False, "score": 0.0, "feedback": "No answer was submitted."}
    system = """You are grading a short university exam answer.

Return ONLY JSON:
{"score": 0.0-1.0, "isCorrect": true|false, "feedback": "one concise sentence"}

Grade by meaning, not exact wording. Be fair but strict. The submitted answer must be supported by the expected answer/rubric."""
    user = (
        "Question:\n" + question +
        "\n\nExpected answer:\n" + expected +
        "\n\nRubric/explanation:\n" + explanation +
        "\n\nStudent answer:\n" + submitted
    )
    try:
        res = chat_json(system=system, user=user, max_tokens=350)
        data = res.data if isinstance(res.data, dict) else {}
        ratio = float(data.get("score", 0))
        ratio = max(0.0, min(1.0, ratio))
        return {
            "isCorrect": bool(data.get("isCorrect")) or ratio >= 0.7,
            "score": round(ratio * max_points, 3),
            "feedback": str(data.get("feedback") or "Graded against the expected answer."),
        }
    except Exception:
        log.exception("examforge short-answer grading failed")
        ratio = _simple_text_similarity(submitted, expected)
        return {
            "isCorrect": ratio >= 0.7,
            "score": round(min(1.0, ratio) * max_points, 3),
            "feedback": "Graded by keyword overlap because AI grading was unavailable.",
        }
