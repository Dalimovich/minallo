"""Phase 3 — read/write helpers for user_topic_mastery.

Reads power the "coaching note" the answer-pipeline injects into the
system prompt when a student asks a question that may touch a topic they
have previously struggled with. Writes power the Schreibtrainer →
mastery unification: every high-severity, actual-error feedback item
turns into one incorrect attempt on a German grammar topic so writing
weaknesses and course-quiz weaknesses live in one table.

Schema reference: supabase/migrations/20260520_000001_user_topic_mastery.sql
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# Mastery is unreliable on tiny attempt counts. Only surface a topic as a
# "weak topic" if it has been practiced at least this many times.
_MIN_ATTEMPTS_FOR_WEAK = 2
# Below this smoothed-correct ratio the student is meaningfully shaky.
_WEAK_THRESHOLD = 0.6
# Hard limit — never inject more than three topics into the prompt or the
# coaching note becomes noise.
_MAX_WEAK_TOPICS = 3

# Sentinel course_id for non-course-scoped tracks (Schreibtrainer).
WRITING_COACH_COURSE_ID = "_writing_coach"


def fetch_weak_topics(
    user_id: str,
    course_id: str,
    *,
    threshold: float = _WEAK_THRESHOLD,
    min_attempts: int = _MIN_ATTEMPTS_FOR_WEAK,
    limit: int = _MAX_WEAK_TOPICS,
) -> list[str]:
    """Return the names of topics the student is currently weakest at.

    Sorted ascending by mastery_score so the weakest topic is first. Best
    effort: any DB error returns an empty list — the answer pipeline must
    not block on a coaching feature.
    """
    if not user_id or not course_id:
        return []
    try:
        sb = get_supabase()
        resp = (
            sb.table("user_topic_mastery")
            .select("topic, mastery_score, attempts")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .lt("mastery_score", threshold)
            .gte("attempts", min_attempts)
            .order("mastery_score")
            .limit(limit)
            .execute()
        )
        rows = resp.data or []
    except Exception:
        log.exception("fetch_weak_topics failed (returning [])")
        return []
    return [str(r.get("topic")) for r in rows if r.get("topic")]


def record_writing_weakness(
    user_id: str,
    weak_categories: list[str],
    clean_categories: list[str] | None = None,
) -> None:
    """Upsert mastery rows for Schreibtrainer weaknesses.

    Treats each unique weak grammar/style category in this submission as
    one incorrect attempt, and (optionally) each strength category as a
    correct attempt. Bypasses the quiz-attempt topic validation because
    the writing-coach lives outside the document_chunks corpus.

    Topics are namespaced ``german:<category>`` to avoid colliding with
    course quiz topics if the dashboard ever surfaces both side-by-side.
    """
    if not user_id:
        return
    deltas: dict[str, dict[str, int]] = {}
    for raw in (weak_categories or []):
        cat = (raw or "").strip()
        if not cat:
            continue
        key = "german:" + cat
        d = deltas.setdefault(key, {"attempts": 0, "correct": 0})
        d["attempts"] += 1
    for raw in (clean_categories or []):
        cat = (raw or "").strip()
        if not cat:
            continue
        key = "german:" + cat
        d = deltas.setdefault(key, {"attempts": 0, "correct": 0})
        d["attempts"] += 1
        d["correct"] += 1
    if not deltas:
        return
    try:
        sb = get_supabase()
        # Fetch existing rows so we can add to the running totals.
        topics = list(deltas.keys())
        resp = (
            sb.table("user_topic_mastery")
            .select("topic, attempts, correct")
            .eq("user_id", user_id)
            .eq("course_id", WRITING_COACH_COURSE_ID)
            .in_("topic", topics)
            .execute()
        )
        existing = {r["topic"]: r for r in (resp.data or [])}
        now_iso = datetime.now(timezone.utc).isoformat()
        rows = []
        for topic, d in deltas.items():
            prev = existing.get(topic) or {}
            attempts = int(prev.get("attempts") or 0) + d["attempts"]
            correct = int(prev.get("correct") or 0) + d["correct"]
            # Laplace smoothing — mirrors backend/functions/ai-quiz-attempt.ts.
            mastery = (correct + 1) / (attempts + 2) if attempts > 0 else 0.0
            rows.append({
                "user_id": user_id,
                "course_id": WRITING_COACH_COURSE_ID,
                "topic": topic,
                "attempts": attempts,
                "correct": correct,
                "mastery_score": mastery,
                "last_practiced_at": now_iso,
                "updated_at": now_iso,
            })
        sb.table("user_topic_mastery").upsert(rows, on_conflict="user_id,course_id,topic").execute()
    except Exception:
        log.exception("record_writing_weakness upsert failed (ignored)")


def _is_known_course_topic(sb, course_id: str, topic: str) -> bool:
    """True when ``topic`` is an actual ``primary_topic`` for the course.

    Anti-pollution gate — mirrors ai-quiz-attempt.ts: only topics that exist
    in the course's own chunks may write to ``user_topic_mastery``, so an
    LLM-paraphrased exam topic can't fork a near-duplicate mastery row.
    """
    resp = (
        sb.table("document_chunks")
        .select("id")
        .eq("course_id", course_id)
        .eq("primary_topic", topic)
        .limit(1)
        .execute()
    )
    return bool(resp.data)


def record_course_topic_attempt(
    user_id: str,
    course_id: str,
    topic: str,
    correct: bool,
) -> None:
    """Record one graded attempt against a course topic's mastery.

    The server-side counterpart to ai-quiz-attempt.ts: ExamForge grades
    answers in the Python service, so it writes mastery here rather than via
    the edge function. Validates the topic (anti-pollution), then upserts the
    running totals with the same Laplace smoothing the edge function uses so
    quiz- and exam-derived mastery stay on one consistent scale.

    Best-effort: any DB error is swallowed — grading must never fail on a
    mastery write.
    """
    topic = (topic or "").strip()
    if not user_id or not course_id or not topic:
        return
    try:
        sb = get_supabase()
        if not _is_known_course_topic(sb, course_id, topic):
            log.info(
                "record_course_topic_attempt: %r not a known topic in course %s — skipping",
                topic, course_id,
            )
            return
        resp = (
            sb.table("user_topic_mastery")
            .select("attempts, correct")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .eq("topic", topic)
            .limit(1)
            .execute()
        )
        prev = (resp.data or [{}])[0] if resp.data else {}
        attempts = int(prev.get("attempts") or 0) + 1
        correct_n = int(prev.get("correct") or 0) + (1 if correct else 0)
        # Laplace smoothing — mirrors backend/functions/ai-quiz-attempt.ts.
        mastery = (correct_n + 1) / (attempts + 2)
        now_iso = datetime.now(timezone.utc).isoformat()
        sb.table("user_topic_mastery").upsert({
            "user_id": user_id,
            "course_id": course_id,
            "topic": topic,
            "attempts": attempts,
            "correct": correct_n,
            "mastery_score": mastery,
            "last_practiced_at": now_iso,
            "updated_at": now_iso,
        }, on_conflict="user_id,course_id,topic").execute()
    except Exception:
        log.exception("record_course_topic_attempt failed (ignored)")


def coaching_overlay(weak_topics: list[str]) -> str:
    """Return the system-prompt block that nudges the tutor about prior practice-focus topics.

    The phrasing is deliberately subtle and subject to the Student-Dignity
    rules in answer.py:DIGNITY_OVERLAY. We do not surface the student's
    history to them — the model uses it as private context to reinforce a
    rule when it's genuinely relevant. The note is explicitly framed around
    topics-to-strengthen, never around the student being "weak" or "behind".
    """
    if not weak_topics:
        return ""
    topics_list = ", ".join(weak_topics)
    return (
        "\n\nPRIVATE COACHING NOTE — do not echo, quote, paraphrase, or describe this note to the student.\n"
        f"Topics currently on this student's practice-focus list: {topics_list}.\n"
        "If — and ONLY if — the current question touches one of these topics, briefly "
        "reinforce the underlying rule, sign convention, or definition once while "
        "answering, in the same natural voice you'd use with any student. "
        "Acceptable example: \"Note the sign convention here — that's a common detail to double-check.\" "
        "FORBIDDEN, no matter what: phrasings like \"I see you struggled with X\", "
        "\"you keep failing at X\", \"this is one of your weak areas\", or anything else "
        "that frames the student as weak / behind / failing / a known underperformer. "
        "Speak about the skill or the step, never about the student's track record. "
        "If the question does not touch any of these topics, ignore this note entirely."
    )
