"""AI-Powered Weekly Mission Planner — Phase 1: document study profiles.

The deterministic TypeScript planner (``backend/lib/study-planner.ts``) pairs
files by filename numbers and fills time slots. This module gives the planner
real *study intelligence* about each document: what it teaches, at what depth,
what it presupposes, and how it should be used in a study plan.

To keep planning fast and cheap, each document is profiled **once** with a
single LLM call and cached in ``document_study_profiles``, keyed by the
document's content signature (``document_hash``/``indexed_at``). A profile is
rebuilt only when the document is re-indexed — never on a routine plan load.

Phase 2 (``generate-week``) consumes ``get_or_build_profiles`` to assemble the
weekly roadmap; this module owns only the per-file understanding layer.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .document_intelligence import classify_document
from .llm_json import chat_json
from ..config import get_settings
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# ── Profile contract ─────────────────────────────────────────────────────────
#
# A profile (the value stored in document_study_profiles.profile) is:
#   {
#     "documentId": str,
#     "fileName": str,
#     "documentRole": "lecture"|"exercise"|"solution"|"exam"|"summary"|"formula"|"other",
#     "topicsCovered": [ {"name", "confidence", "pageRange"?, "depth"} ],
#     "prerequisites": [str],
#     "estimatedStudyMinutes": int,
#     "recommendedUse": "learn_first"|"practice_after_lecture"|"check_after_exercise"
#                       |"review"|"exam_practice",
#     "summary": str,
#   }

_VALID_ROLES = {"lecture", "exercise", "solution", "exam", "summary", "formula", "other"}
_VALID_CONFIDENCE = {"confirmed", "high", "medium", "low"}
_VALID_DEPTH = {"intro", "core", "advanced", "exam"}
_VALID_USE = {
    "learn_first",
    "practice_after_lecture",
    "check_after_exercise",
    "review",
    "exam_practice",
}

# Map BOTH type vocabularies onto profile roles, so a missing/low-quality LLM
# read still gets a sane deterministic role. document_intelligence.classify_document
# emits the "*_sheet" vocabulary; documents.source_type uses the short one.
_TYPE_TO_ROLE = {
    # classifier (document_type) vocabulary
    "exercise_sheet": "exercise",
    "solution_sheet": "solution",
    "formula_sheet": "formula",
    "unknown": "other",
    # source_type vocabulary
    "exercise": "exercise",
    "solution": "solution",
    "notes": "summary",
    # shared
    "lecture": "lecture",
    "summary": "summary",
    "exam": "exam",
    "other": "other",
}


def _resolve_fallback_role(doc: dict[str, Any], file_name: str, digest: str) -> str:
    """Deterministic role when the LLM read is missing/unusable. Trusts an
    explicit stored type, else falls back to the filename+content classifier."""
    for key in (doc.get("document_type"), doc.get("source_type")):
        k = (key or "").strip().lower()
        # An explicit, non-default tag is trusted; a bare 'lecture' default is not.
        if k and k != "lecture" and k in _TYPE_TO_ROLE:
            return _TYPE_TO_ROLE[k]
    classified = classify_document(file_name, digest)
    return _TYPE_TO_ROLE.get(classified, "other")

_ROLE_DEFAULT_USE = {
    "lecture": "learn_first",
    "exercise": "practice_after_lecture",
    "solution": "check_after_exercise",
    "exam": "exam_practice",
    "summary": "review",
    "formula": "review",
    "other": "review",
}


def _signature(doc: dict[str, Any]) -> str:
    """Content-identity signature used to detect a stale cached profile."""
    return str(doc.get("document_hash") or doc.get("indexed_at") or doc.get("id") or "")


def _coerce_profile(raw: Any, doc: dict[str, Any], fallback_role: str) -> dict[str, Any]:
    """Validate + normalize the LLM's JSON into the profile contract.

    The planner trusts these fields, so anything malformed is repaired to a safe
    default rather than propagated. Never raises — a bad LLM read degrades to a
    deterministic profile, it does not break plan generation.
    """
    doc_id = str(doc.get("id") or "")
    file_name = str(doc.get("file_name") or "")
    obj = raw if isinstance(raw, dict) else {}

    role = str(obj.get("documentRole") or "").strip().lower()
    if role not in _VALID_ROLES:
        role = fallback_role

    topics_out: list[dict[str, Any]] = []
    raw_topics = obj.get("topicsCovered")
    if isinstance(raw_topics, list):
        for t in raw_topics:
            if not isinstance(t, dict):
                continue
            name = str(t.get("name") or "").strip()
            if not name:
                continue
            conf = str(t.get("confidence") or "medium").strip().lower()
            depth = str(t.get("depth") or "core").strip().lower()
            entry: dict[str, Any] = {
                "name": name[:160],
                "confidence": conf if conf in _VALID_CONFIDENCE else "medium",
                "depth": depth if depth in _VALID_DEPTH else "core",
            }
            page_range = t.get("pageRange")
            if isinstance(page_range, (str, int)) and str(page_range).strip():
                entry["pageRange"] = str(page_range).strip()[:32]
            topics_out.append(entry)
            if len(topics_out) >= 40:
                break

    prereqs_out: list[str] = []
    raw_prereqs = obj.get("prerequisites")
    if isinstance(raw_prereqs, list):
        for p in raw_prereqs:
            s = str(p or "").strip()
            if s:
                prereqs_out.append(s[:160])
            if len(prereqs_out) >= 20:
                break

    try:
        est = int(obj.get("estimatedStudyMinutes"))
    except (TypeError, ValueError):
        est = 0
    if est <= 0:
        # Fall back to a page-count heuristic (~2 min/page, clamped).
        pages = doc.get("page_count") or 0
        est = max(10, min(90, int(pages) * 2)) if pages else 30
    est = max(5, min(180, est))

    use = str(obj.get("recommendedUse") or "").strip().lower()
    if use not in _VALID_USE:
        use = _ROLE_DEFAULT_USE.get(role, "review")

    summary = str(obj.get("summary") or "").strip()[:600]

    return {
        "documentId": doc_id,
        "fileName": file_name,
        "documentRole": role,
        "topicsCovered": topics_out,
        "prerequisites": prereqs_out,
        "estimatedStudyMinutes": est,
        "recommendedUse": use,
        "summary": summary,
    }


def _chunk_digest(chunks: list[dict[str, Any]]) -> str:
    """Compact, LLM-friendly digest of a document's tagged chunks: topic →
    page span + chunk-type mix. Keeps the prompt small (we profile from the
    indexer's structured tags, not the full document text)."""
    by_topic: dict[str, dict[str, Any]] = {}
    for c in chunks:
        topic = (c.get("primary_topic") or "").strip()
        if not topic:
            continue
        agg = by_topic.setdefault(topic, {"pages": set(), "types": Counter()})
        ps, pe = c.get("page_start"), c.get("page_end")
        for p in (ps, pe):
            if isinstance(p, int):
                agg["pages"].add(p)
        ct = c.get("chunk_type")
        if ct:
            agg["types"][ct] += 1

    lines: list[str] = []
    for topic, agg in sorted(by_topic.items(), key=lambda kv: -sum(kv[1]["types"].values())):
        pages = sorted(agg["pages"])
        span = f"p.{pages[0]}-{pages[-1]}" if len(pages) >= 2 else (f"p.{pages[0]}" if pages else "")
        types = ", ".join(f"{k}×{v}" for k, v in agg["types"].most_common(3))
        lines.append(f"- {topic} ({span}; {types})" if span or types else f"- {topic}")
        if len(lines) >= 40:
            break
    return "\n".join(lines)


_PROFILE_SYSTEM = (
    "You are a study-planning analyst. Given a course document's metadata and the "
    "topics its indexed chunks cover, produce a concise STUDY PROFILE describing "
    "what the document teaches and how a student should use it. "
    "Return STRICT JSON only, matching this schema:\n"
    '{"documentRole":"lecture|exercise|solution|exam|summary|formula|other",'
    '"topicsCovered":[{"name":str,"confidence":"confirmed|high|medium|low",'
    '"pageRange":str?,"depth":"intro|core|advanced|exam"}],'
    '"prerequisites":[str],"estimatedStudyMinutes":int,'
    '"recommendedUse":"learn_first|practice_after_lecture|check_after_exercise|review|exam_practice",'
    '"summary":str}\n'
    "Rules: a solution sheet is NEVER an exercise (role=solution, use=check_after_exercise). "
    "Lectures teach (use=learn_first); exercise sheets are practiced after their lecture. "
    "Only list topics the document actually covers. Keep summary under 2 sentences."
)


def build_document_profile(doc: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Build one document's study profile via a single LLM call, with a
    deterministic fallback. Pure w.r.t. the DB — caller persists the result."""
    file_name = str(doc.get("file_name") or "")
    digest = _chunk_digest(chunks)
    # Deterministic role seeds the fallback and gives the LLM a strong prior.
    stored_type = (doc.get("document_type") or doc.get("source_type") or "").strip().lower()
    fallback_role = _resolve_fallback_role(doc, file_name, digest)

    user_prompt = (
        f"File name: {file_name}\n"
        f"Declared type: {stored_type or 'unknown'}\n"
        f"Page count: {doc.get('page_count') or 'unknown'}\n"
        f"Topics covered by indexed chunks:\n{digest or '(no tagged topics)'}\n"
    )

    try:
        settings = get_settings()
        result = chat_json(
            system=_PROFILE_SYSTEM,
            user=user_prompt,
            model=settings.openai_generate_model,
            max_tokens=900,
        )
        return _coerce_profile(result.data, doc, fallback_role)
    except Exception:  # noqa: BLE001
        log.exception("profile LLM failed for document %s; using deterministic fallback", doc.get("id"))
        return _coerce_profile(None, doc, fallback_role)


def get_or_build_profiles(
    user_id: str,
    course_id: str,
    *,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Return study profiles for every ready document in the course, building
    (and caching) any that are missing or stale. ``force`` rebuilds all.

    This is the planner's document-understanding entry point: cheap on repeat
    calls (only re-indexed documents trigger an LLM call)."""
    sb = get_supabase()

    docs = (
        sb.table("documents")
        .select("id, file_name, source_type, document_type, processing_status, page_count, document_hash, indexed_at")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("processing_status", "ready")
        .execute()
    ).data or []
    if not docs:
        return []

    existing_rows = (
        sb.table("document_study_profiles")
        .select("document_id, source_signature, profile")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .execute()
    ).data or []
    cached: dict[str, dict[str, Any]] = {r["document_id"]: r for r in existing_rows}

    # Pull all chunks for the course once, grouped by document, to avoid an N+1.
    chunk_rows = (
        sb.table("document_chunks")
        .select("document_id, primary_topic, page_start, page_end, chunk_type")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .not_.is_("primary_topic", "null")
        .execute()
    ).data or []
    chunks_by_doc: dict[str, list[dict[str, Any]]] = {}
    for c in chunk_rows:
        chunks_by_doc.setdefault(c.get("document_id"), []).append(c)

    settings = get_settings()
    now = datetime.now(timezone.utc).isoformat()
    out: list[dict[str, Any]] = []
    upserts: list[dict[str, Any]] = []

    for doc in docs:
        doc_id = doc["id"]
        sig = _signature(doc)
        prior = cached.get(doc_id)
        if not force and prior and prior.get("source_signature") == sig and isinstance(prior.get("profile"), dict) and prior["profile"]:
            out.append(prior["profile"])
            continue

        profile = build_document_profile(doc, chunks_by_doc.get(doc_id, []))
        out.append(profile)
        upserts.append(
            {
                "user_id": user_id,
                "course_id": course_id,
                "document_id": doc_id,
                "source_signature": sig,
                "profile": profile,
                "model": settings.openai_generate_model,
                "updated_at": now,
            }
        )

    if upserts:
        # on_conflict=document_id → refresh the cached profile in place.
        sb.table("document_study_profiles").upsert(upserts, on_conflict="document_id").execute()
        log.info(
            "study_planner: built %d/%d document profiles for course %s",
            len(upserts), len(docs), course_id,
        )

    return out


# ── Phase 2: AI weekly plan generation ────────────────────────────────────────

_VALID_TASK_TYPES = {
    "study_lecture",
    "continue_lecture",
    "solve_exercise_sheet",
    "check_solution_sheet",
    "repeat_lecture",
    "review_weak_topic",
    "review_completed_exercise",
    "generate_quiz_if_no_exercises",
    "exam_style_practice",
    "pre_exam_review",
}

# Task types that are exercise-execution tasks (the file must be an exercise,
# not a solution sheet). Any solution file assigned here is a planner bug.
_EXERCISE_EXECUTION_TYPES = {"solve_exercise_sheet"}

# Task types whose primary file (lectureFileId) must be lecture-like material.
_LECTURE_STUDY_TYPES = {
    "study_lecture",
    "continue_lecture",
    "repeat_lecture",
    "pre_exam_review",
}

# Document roles that clearly are NOT an exercise sheet. If the LLM assigns a file
# with one of these roles as a solve_exercise_sheet's exerciseFileId, drop the task
# (the classic "solution sheet scheduled as an exercise" bug, plus lecture/exam
# mix-ups). Unknown/empty/"other" roles are allowed — we only act on confident
# role signals so a sparse topic map can't empty the plan.
_NON_EXERCISE_ROLES = {"lecture", "solution", "exam", "summary", "formula"}
# Roles that are clearly not a lecture, used to reject lecture-slot mismatches.
_NON_LECTURE_ROLES = {"exercise", "solution"}

_WEEK_PLAN_SYSTEM = (
    "You are an AI study planner. Given course document profiles, student "
    "progress data, exam dates, and available study time, produce a STRICT JSON "
    "weekly study plan. Return ONLY valid JSON matching this schema exactly:\n"
    '{"weekStartDate":str,"subjectAllocation":[{"courseId":str,"subjectName":str,'
    '"percentage":int,"reason":str}],"tasks":[WeeklyMissionTask],'
    '"possibleMatches":[{"courseId":str,"exerciseFileId":str,"exerciseFileName":str,'
    '"possibleLectureFileId":str,"possibleLectureFileName":str,'
    '"confidence":"medium"|"low","reason":str}]}\n'
    "WeeklyMissionTask fields: id(str), planDate(YYYY-MM-DD), dayIndex(0=Mon..6=Sun), "
    "courseId(str), subjectName(str), taskType(one of: study_lecture|continue_lecture|"
    "solve_exercise_sheet|check_solution_sheet|repeat_lecture|review_weak_topic|"
    "review_completed_exercise|generate_quiz_if_no_exercises|exam_style_practice|"
    "pre_exam_review), lectureFileId(str?), lectureFileName(str?), lectureTopics([str]?), "
    "exerciseFileId(str?), exerciseFileName(str?), solutionFileId(str?), solutionFileName(str?), "
    "relatedLectureFileId(str?), relatedLectureFileName(str?), relatedLectureTopics([str]?), "
    "pageRange(str?), estimatedMinutes(int 5-180), reason(str), status('todo'), "
    "repetitionStage(int?), sourceConfidence('confirmed'|'high'|'medium'|'low').\n"
    "\nPLANNING RULES:\n"
    "1. Only schedule on days provided in dailyAvailabilityMinutes (value > 0).\n"
    "2. planDate = weekStartDate + dayIndex days. dayIndex: 0=Mon,1=Tue,2=Wed,3=Thu,4=Fri,5=Sat,6=Sun.\n"
    "3. Pick the SINGLE best lecture file for a topic (highest depth, recommendedUse=learn_first) "
    "not every file tagged with it. Put medium/low confidence exercise↔lecture matches in "
    "possibleMatches, NOT as scheduled tasks.\n"
    "4. NEVER assign a solution file as an exercise task (solve_exercise_sheet needs exerciseFileId "
    "from a file with role=exercise; check_solution_sheet uses solutionFileId).\n"
    "5. Sequence prerequisites before advanced topics.\n"
    "6. Use generate_quiz_if_no_exercises ONLY when no real exercise or exam file exists.\n"
    "7. As exam_date approaches, ramp up exam_style_practice and pre_exam_review. "
    "Balance theory/practice/review proportions intelligently.\n"
    "8. subjectAllocation percentages must sum to 100.\n"
    "9. Do not exceed dailyAvailabilityMinutes per day. Spread tasks across the "
    "available days — never pile many tasks onto a single day.\n"
    "10. estimatedMinutes must be 5-180 per task.\n"
    "11. check_solution_sheet is a FOLLOW-UP, not a standalone task. Schedule it "
    "ONLY directly after the matching solve_exercise_sheet for the SAME sheet "
    "(same number), and only when that exercise is studied/practised. NEVER emit a "
    "check_solution_sheet for a solution file on its own, and NEVER one per "
    "solution file — a day full of 'Check solutions' tasks is wrong.\n"
    "12. Process a course's numbered lecture/exercise/solution files in natural "
    "order (sheet 1, then 2, then 3 …). Do NOT jump ahead to a later sheet (e.g. "
    "10) before earlier ones are done.\n"
    "13. Prefer studying lectures and solving exercises over checking solutions; a "
    "balanced day is mostly study + practice, with review/solution-checks only "
    "where they follow real prior work."
)


def _parse_week_date(week_start: str, day_index: int) -> str:
    """Return YYYY-MM-DD string for weekStartDate + dayIndex days."""
    base = date.fromisoformat(week_start)
    return (base + timedelta(days=day_index)).isoformat()


def _coerce_task(
    raw: Any,
    week_start: str,
    available_days: set[int],
    roles: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Validate and normalize a single raw LLM task dict.

    Returns None if the task must be dropped (invalid type, no valid day, etc.)
    Never raises.

    ``roles`` maps documentId → documentRole (from the study profiles). When
    provided, it enforces that an exercise task points at an actual exercise file
    and a lecture-study task points at an actual lecture — best-effort: only known,
    conflicting roles cause a drop.
    """
    if not isinstance(raw, dict):
        return None
    roles = roles or {}

    task_type = str(raw.get("taskType") or "").strip().lower()
    if task_type not in _VALID_TASK_TYPES:
        return None

    try:
        day_index = int(raw.get("dayIndex"))
    except (TypeError, ValueError):
        return None
    if day_index not in available_days:
        return None
    if not (0 <= day_index <= 6):
        return None

    course_id = str(raw.get("courseId") or "").strip()
    if not course_id:
        return None

    # Safety: solution file must never become a solve_exercise_sheet task.
    # The rule is enforced here regardless of what the LLM produced.
    exercise_file_id = str(raw.get("exerciseFileId") or "").strip() or None
    solution_file_id = str(raw.get("solutionFileId") or "").strip() or None
    lecture_file_id  = str(raw.get("lectureFileId") or "").strip() or None

    if task_type in _EXERCISE_EXECUTION_TYPES and not exercise_file_id:
        # solve_exercise_sheet without an exercise file is a planner error — drop.
        return None

    # Role enforcement against the document study profiles. Only act on a KNOWN
    # conflicting role so an unindexed / unprofiled file (role unknown) still
    # passes through.
    if task_type in _EXERCISE_EXECUTION_TYPES and exercise_file_id:
        ex_role = roles.get(exercise_file_id, "")
        if ex_role in _NON_EXERCISE_ROLES:
            # e.g. a solution sheet or lecture scheduled as an exercise — drop.
            return None
    if task_type in _LECTURE_STUDY_TYPES and lecture_file_id:
        lec_role = roles.get(lecture_file_id, "")
        if lec_role in _NON_LECTURE_ROLES:
            # e.g. an exercise/solution scheduled as a lecture to study — drop.
            return None

    # The exercise's paired "related lecture" must itself be a lecture. If it's a
    # known non-lecture (exercise/solution), strip the bad link rather than drop
    # the whole exercise task — the exercise can still stand on its own.
    related_lecture_file_id = str(raw.get("relatedLectureFileId") or "").strip() or None
    related_lecture_file_name = str(raw.get("relatedLectureFileName") or "").strip() or None
    if related_lecture_file_id and roles.get(related_lecture_file_id, "") in _NON_LECTURE_ROLES:
        related_lecture_file_id = None
        related_lecture_file_name = None

    try:
        est = int(raw.get("estimatedMinutes"))
    except (TypeError, ValueError):
        est = 30
    est = max(5, min(180, est))

    source_conf = str(raw.get("sourceConfidence") or "high").strip().lower()
    if source_conf not in _VALID_CONFIDENCE:
        source_conf = "high"

    def _str_or_none(v: Any) -> str | None:
        s = str(v or "").strip()
        return s or None

    def _str_list(v: Any) -> list[str] | None:
        if not isinstance(v, list):
            return None
        out = [str(x).strip() for x in v if str(x or "").strip()]
        return out if out else None

    plan_date = _parse_week_date(week_start, day_index)

    coerced: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "planDate": plan_date,
        "dayIndex": day_index,
        "courseId": course_id,
        "subjectName": _str_or_none(raw.get("subjectName")) or course_id,
        "taskType": task_type,
        "estimatedMinutes": est,
        "reason": str(raw.get("reason") or "").strip()[:500] or "AI generated",
        "status": "todo",
        "sourceConfidence": source_conf,
    }

    # Optional fields — include only when present.
    for field, value in [
        ("lectureFileId", lecture_file_id),
        ("lectureFileName", _str_or_none(raw.get("lectureFileName"))),
        ("exerciseFileId", exercise_file_id),
        ("exerciseFileName", _str_or_none(raw.get("exerciseFileName"))),
        ("solutionFileId", solution_file_id),
        ("solutionFileName", _str_or_none(raw.get("solutionFileName"))),
        ("relatedLectureFileId", related_lecture_file_id),
        ("relatedLectureFileName", related_lecture_file_name),
        ("pageRange", _str_or_none(raw.get("pageRange"))),
    ]:
        if value is not None:
            coerced[field] = value

    for list_field in ("lectureTopics", "relatedLectureTopics"):
        lst = _str_list(raw.get(list_field))
        if lst is not None:
            coerced[list_field] = lst

    rep_stage = raw.get("repetitionStage")
    if rep_stage is not None:
        try:
            coerced["repetitionStage"] = int(rep_stage)
        except (TypeError, ValueError):
            pass

    return coerced


def _coerce_possible_match(raw: Any) -> dict[str, Any] | None:
    """Validate a possibleMatch entry. Returns None to discard."""
    if not isinstance(raw, dict):
        return None
    course_id = str(raw.get("courseId") or "").strip()
    ex_id = str(raw.get("exerciseFileId") or "").strip()
    lec_id = str(raw.get("possibleLectureFileId") or "").strip()
    if not course_id or not ex_id or not lec_id:
        return None
    conf = str(raw.get("confidence") or "medium").strip().lower()
    if conf not in ("medium", "low"):
        conf = "medium"
    return {
        "courseId": course_id,
        "exerciseFileId": ex_id,
        "exerciseFileName": str(raw.get("exerciseFileName") or "").strip(),
        "possibleLectureFileId": lec_id,
        "possibleLectureFileName": str(raw.get("possibleLectureFileName") or "").strip(),
        "confidence": conf,
        "reason": str(raw.get("reason") or "").strip()[:300],
    }


def _coerce_subject_allocation(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    course_id = str(raw.get("courseId") or "").strip()
    subject_name = str(raw.get("subjectName") or "").strip()
    if not course_id or not subject_name:
        return None
    try:
        pct = int(raw.get("percentage"))
    except (TypeError, ValueError):
        pct = 0
    return {
        "courseId": course_id,
        "subjectName": subject_name,
        "percentage": max(0, min(100, pct)),
        "reason": str(raw.get("reason") or "").strip()[:300],
    }


def _dedup_best_lecture_per_topic(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Enforce one-best-lecture-per-(course, topic) for study_lecture tasks.

    When the LLM scheduled multiple study_lecture tasks for the same topic in
    the same course, keep only the first one (the planner should order them by
    depth/priority already). Non-lecture tasks and tasks without lectureTopics
    pass through unchanged.
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, Any]] = []
    for task in tasks:
        if task.get("taskType") not in ("study_lecture", "continue_lecture", "repeat_lecture"):
            out.append(task)
            continue
        course_id = task.get("courseId", "")
        topics: list[str] = task.get("lectureTopics") or []
        # Keyed by the first topic name (primary topic) + course.
        primary_topic = topics[0] if topics else task.get("lectureFileId") or ""
        key = (course_id, primary_topic)
        if key in seen and task.get("taskType") == "study_lecture":
            # Duplicate study_lecture for the same primary topic — skip.
            continue
        seen.add(key)
        out.append(task)
    return out


def _days_until_exam(exam_date_str: str | None) -> int | None:
    """Return number of days from today until exam_date, or None."""
    if not exam_date_str:
        return None
    try:
        exam = date.fromisoformat(str(exam_date_str)[:10])
        delta = (exam - date.today()).days
        return delta
    except (ValueError, TypeError):
        return None


def _build_planner_prompt(
    user_id: str,
    week_start: str,
    daily_availability: dict[str, int],
    course_data: list[dict[str, Any]],
    plan_scope: str,
    confirmed_pairings: list[dict[str, str]] | None = None,
    dismissed_pairings: list[dict[str, str]] | None = None,
) -> str:
    """Compose the compact user prompt for the weekly planning LLM call."""
    lines: list[str] = [
        f"Week start: {week_start}",
        f"Plan scope: {plan_scope}",
        "Daily availability (day: minutes):",
    ]
    for day, mins in sorted(daily_availability.items()):
        lines.append(f"  {day}: {mins}")

    # User-decided exercise↔lecture pairings (by document id). These are AUTHORITATIVE:
    # schedule confirmed pairs directly as solve_exercise_sheet tasks (do NOT demote
    # them to possibleMatches), and never propose a dismissed pair in possibleMatches.
    if confirmed_pairings:
        lines.append("")
        lines.append("User-CONFIRMED exercise↔lecture pairings (schedule these directly):")
        for p in confirmed_pairings:
            lines.append(f"  exercise {p.get('exerciseFileId','')} ↔ lecture {p.get('lectureFileId','')}")
    if dismissed_pairings:
        lines.append("")
        lines.append("User-DISMISSED pairings (never suggest these):")
        for p in dismissed_pairings:
            lines.append(f"  exercise {p.get('exerciseFileId','')} ↔ lecture {p.get('lectureFileId','')}")

    lines.append("")
    lines.append("Courses to plan:")

    for cd in course_data:
        course_id = cd["courseId"]
        subject_name = cd.get("subjectName") or course_id
        exam_date = cd.get("examDate")
        days_left = _days_until_exam(exam_date)
        exam_info = f", exam in {days_left} days ({exam_date})" if days_left is not None else ""
        priority = cd.get("priority", "normal")
        lines.append(f"\n[Course: {course_id} | Subject: {subject_name} | Priority: {priority}{exam_info}]")

        profiles: list[dict[str, Any]] = cd.get("profiles", [])
        if profiles:
            lines.append("Documents:")
            for p in profiles:
                doc_id = p.get("documentId", "")
                role = p.get("documentRole", "other")
                use = p.get("recommendedUse", "")
                est = p.get("estimatedStudyMinutes", 0)
                topics = [t.get("name", "") + f"[{t.get('depth','core')}]" for t in (p.get("topicsCovered") or [])[:8]]
                topics_str = ", ".join(topics) if topics else "(none)"
                lines.append(
                    f"  - id={doc_id} file={p.get('fileName','')} role={role} "
                    f"use={use} est={est}min topics: {topics_str}"
                )
                prereqs = p.get("prerequisites") or []
                if prereqs:
                    lines.append(f"    prereqs: {', '.join(prereqs[:5])}")

        topic_states: list[dict[str, Any]] = cd.get("topicStates", [])
        if topic_states:
            lines.append("Topic progress:")
            for ts in topic_states[:20]:
                lines.append(
                    f"  - {ts.get('name','?')}: state={ts.get('progress_state','unknown')}"
                )

    lines.append("\nReturn the weekly plan JSON now.")
    return "\n".join(lines)


_EMPTY_WEEK_PLAN = {
    "subjectAllocation": [],
    "tasks": [],
    "possibleMatches": [],
}


def generate_week_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Generate an AI-powered weekly study plan.

    Takes a payload dict with keys: userId, weekStartDate, planScope,
    courseId (optional), timezone, dailyAvailabilityMinutes, regenerate.

    Returns a dict matching the WeekPlanResponse contract. Never raises —
    on any error returns an empty plan so the TypeScript planner can fall back
    to its deterministic algorithm.
    """
    week_start: str = str(payload.get("weekStartDate") or "")
    try:
        date.fromisoformat(week_start)
    except ValueError:
        log.warning("generate_week_plan: invalid weekStartDate %r", week_start)
        return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

    user_id = str(payload.get("userId") or "")
    plan_scope = str(payload.get("planScope") or "global_week")
    course_id_filter: str | None = payload.get("courseId") or None
    daily_availability: dict[str, int] = payload.get("dailyAvailabilityMinutes") or {}

    # Determine which days have availability.
    day_name_to_index = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6,
        "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
        # numeric keys
        "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
    }
    available_day_indices: set[int] = set()
    for day_key, mins in daily_availability.items():
        try:
            mins_int = int(mins)
        except (TypeError, ValueError):
            continue
        if mins_int <= 0:
            continue
        idx = day_name_to_index.get(str(day_key).lower())
        if idx is not None:
            available_day_indices.add(idx)

    try:
        sb = get_supabase()

        # ── Determine target courses ──────────────────────────────────────────
        if course_id_filter:
            course_ids = [course_id_filter]
        else:
            doc_rows = (
                sb.table("documents")
                .select("course_id")
                .eq("user_id", user_id)
                .eq("processing_status", "ready")
                .execute()
            ).data or []
            course_ids = list({r["course_id"] for r in doc_rows if r.get("course_id")})

        if not course_ids:
            return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

        # For global_week: filter out user-excluded courses.
        if plan_scope == "global_week":
            # Load study_preferences excluded_subjects
            pref_rows = (
                sb.table("study_preferences")
                .select("excluded_subjects")
                .eq("user_id", user_id)
                .execute()
            ).data or []
            excluded_subjects: set[str] = set()
            for pref in pref_rows:
                ex = pref.get("excluded_subjects")
                if isinstance(ex, list):
                    excluded_subjects.update(str(s) for s in ex)
                elif isinstance(ex, str) and ex:
                    excluded_subjects.add(ex)

            # Load student_subject_state user_excluded flags
            state_rows = (
                sb.table("student_subject_state")
                .select("course_id, user_excluded, subject_name")
                .eq("user_id", user_id)
                .execute()
            ).data or []
            excluded_course_ids: set[str] = set()
            for sr in state_rows:
                if sr.get("user_excluded"):
                    excluded_course_ids.add(str(sr["course_id"]))
                if sr.get("subject_name") in excluded_subjects:
                    excluded_course_ids.add(str(sr["course_id"]))

            course_ids = [c for c in course_ids if c not in excluded_course_ids]

        if not course_ids:
            return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

        # ── Load per-course data ──────────────────────────────────────────────
        # Bulk load subject states for all target courses.
        subj_state_rows = (
            sb.table("student_subject_state")
            .select("course_id, subject_name, exam_date, priority, user_priority_override")
            .eq("user_id", user_id)
            .in_("course_id", course_ids)
            .execute()
        ).data or []
        subj_state_by_course: dict[str, dict[str, Any]] = {
            r["course_id"]: r for r in subj_state_rows
        }

        # Bulk load topic states.
        topic_state_rows = (
            sb.table("student_topic_state")
            .select("course_id, topic_id, progress_state")
            .eq("user_id", user_id)
            .in_("course_id", course_ids)
            .execute()
        ).data or []
        topic_states_by_course: dict[str, list[dict[str, Any]]] = {}
        for tr in topic_state_rows:
            cid = tr.get("course_id") or ""
            topic_states_by_course.setdefault(cid, []).append(tr)

        # Bulk load topic names for readable context.
        topic_name_rows = (
            sb.table("course_topics")
            .select("id, course_id, name")
            .eq("user_id", user_id)
            .in_("course_id", course_ids)
            .execute()
        ).data or []
        topic_name_by_id: dict[str, str] = {
            r["id"]: r.get("name", "")
            for r in topic_name_rows
            if isinstance(r, dict) and r.get("id")
        }

        # Build course_data list for the prompt.
        course_data: list[dict[str, Any]] = []
        for cid in course_ids:
            profiles = get_or_build_profiles(user_id, cid)
            ss = subj_state_by_course.get(cid, {})
            ts_raw = topic_states_by_course.get(cid, [])
            # Enrich topic states with names.
            ts_named = [
                {
                    "name": topic_name_by_id.get(ts.get("topic_id", ""), ts.get("topic_id", "")),
                    "progress_state": ts.get("progress_state", "unknown"),
                }
                for ts in ts_raw
            ]
            priority = ss.get("user_priority_override") or ss.get("priority") or "normal"
            course_data.append({
                "courseId": cid,
                "subjectName": ss.get("subject_name") or cid,
                "examDate": ss.get("exam_date"),
                "priority": priority,
                "profiles": profiles,
                "topicStates": ts_named,
            })

        if not any(cd.get("profiles") for cd in course_data):
            # No profiles means no documents were ready — return empty.
            return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

        # ── Call the LLM planner ──────────────────────────────────────────────
        confirmed_pairings = payload.get("confirmedPairings")
        dismissed_pairings = payload.get("dismissedPairings")
        user_prompt = _build_planner_prompt(
            user_id=user_id,
            week_start=week_start,
            daily_availability=daily_availability,
            course_data=course_data,
            plan_scope=plan_scope,
            confirmed_pairings=confirmed_pairings if isinstance(confirmed_pairings, list) else None,
            dismissed_pairings=dismissed_pairings if isinstance(dismissed_pairings, list) else None,
        )

        settings = get_settings()
        result = chat_json(
            system=_WEEK_PLAN_SYSTEM,
            user=user_prompt,
            model=settings.openai_generate_model,
            max_tokens=4000,
        )
        raw_plan: Any = result.data
        if not isinstance(raw_plan, dict):
            log.warning("generate_week_plan: LLM returned non-dict; falling back")
            return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

    except Exception:  # noqa: BLE001
        log.exception("generate_week_plan: error building/calling LLM; returning empty plan")
        return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}

    # ── Validate / coerce the LLM output ─────────────────────────────────────
    try:
        # Subject allocation
        raw_alloc = raw_plan.get("subjectAllocation")
        subject_allocation: list[dict[str, Any]] = []
        if isinstance(raw_alloc, list):
            for item in raw_alloc:
                coerced_alloc = _coerce_subject_allocation(item)
                if coerced_alloc:
                    subject_allocation.append(coerced_alloc)

        # documentId → role and documentId → topic-name set across all planned
        # courses, for task role checks and exercise↔lecture overlap verification.
        doc_roles: dict[str, str] = {}
        doc_topics: dict[str, set[str]] = {}
        for cd in course_data:
            for p in cd.get("profiles", []):
                did = str(p.get("documentId") or "").strip()
                if not did:
                    continue
                doc_roles[did] = str(p.get("documentRole") or "").strip().lower()
                doc_topics[did] = {
                    str(t.get("name") or "").strip().lower()
                    for t in (p.get("topicsCovered") or [])
                    if str(t.get("name") or "").strip()
                }

        # Tasks
        raw_tasks = raw_plan.get("tasks")
        tasks: list[dict[str, Any]] = []
        possible_matches_from_tasks: list[dict[str, Any]] = []

        if isinstance(raw_tasks, list):
            for raw_task in raw_tasks:
                if not isinstance(raw_task, dict):
                    continue

                # Before full coercion: demote uncertain exercise↔lecture matches
                # to possibleMatches rather than scheduling them directly. A match
                # is uncertain when the AI flagged it medium/low, OR when it claims
                # high confidence but the exercise and its paired lecture share no
                # topics in their profiles (a likely mis-pairing the AI over-trusted).
                task_type = str(raw_task.get("taskType") or "").strip().lower()
                src_conf = str(raw_task.get("sourceConfidence") or "high").strip().lower()
                ex_id = str(raw_task.get("exerciseFileId") or "").strip()
                rel_lec_id = str(raw_task.get("relatedLectureFileId") or "").strip()
                # A related "lecture" that is actually an exercise/solution is a
                # bogus pairing — don't surface it as a possibleMatch. Let it fall
                # through; _coerce_task strips the bad link and the exercise can
                # still schedule standalone.
                rel_is_bad_lecture = doc_roles.get(rel_lec_id, "") in _NON_LECTURE_ROLES
                if task_type == "solve_exercise_sheet" and ex_id and rel_lec_id and not rel_is_bad_lecture:
                    uncertain = src_conf in ("medium", "low")
                    no_shared_topics = False
                    if not uncertain:
                        ex_topics = doc_topics.get(ex_id, set())
                        lec_topics = doc_topics.get(rel_lec_id, set())
                        # Only act when we actually know both sides' topics.
                        if ex_topics and lec_topics and ex_topics.isdisjoint(lec_topics):
                            no_shared_topics = True
                    if uncertain or no_shared_topics:
                        pm = _coerce_possible_match({
                            "courseId": raw_task.get("courseId"),
                            "exerciseFileId": ex_id,
                            "exerciseFileName": raw_task.get("exerciseFileName"),
                            "possibleLectureFileId": rel_lec_id,
                            "possibleLectureFileName": raw_task.get("relatedLectureFileName"),
                            # An overlap failure is low confidence regardless of the
                            # AI's self-rating.
                            "confidence": "low" if no_shared_topics else src_conf,
                            "reason": raw_task.get("reason"),
                        })
                        if pm:
                            possible_matches_from_tasks.append(pm)
                        # Do NOT add this task to the scheduled list.
                        continue

                coerced_task = _coerce_task(raw_task, week_start, available_day_indices, doc_roles)
                if coerced_task:
                    tasks.append(coerced_task)

        tasks = _dedup_best_lecture_per_topic(tasks)

        # possibleMatches from LLM + those demoted from tasks
        raw_matches = raw_plan.get("possibleMatches")
        possible_matches: list[dict[str, Any]] = list(possible_matches_from_tasks)
        if isinstance(raw_matches, list):
            for rm in raw_matches:
                pm = _coerce_possible_match(rm)
                if pm:
                    possible_matches.append(pm)

        return {
            "weekStartDate": week_start,
            "subjectAllocation": subject_allocation,
            "tasks": tasks,
            "possibleMatches": possible_matches,
        }

    except Exception:  # noqa: BLE001
        log.exception("generate_week_plan: error coercing LLM output; returning empty plan")
        return {**_EMPTY_WEEK_PLAN, "weekStartDate": week_start}


__all__ = (
    "build_document_profile",
    "generate_week_plan",
    "get_or_build_profiles",
)
