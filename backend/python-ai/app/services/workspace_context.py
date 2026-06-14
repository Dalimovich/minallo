"""Live workspace context — the AI's view of the student's real Minallo data.

Three knowledge layers feed every answer:

  1. Static product knowledge  → ``MINALLO_APP_CONTEXT`` (answer.py): what each
     Minallo page and course tab IS.
  2. Live workspace knowledge  → THIS MODULE: what the authenticated student
     actually HAS (files, quizzes, flashcard decks, ExamForge exams,
     cheatsheets, Deep Learn sessions) and WHERE they currently are in the UI.
  3. Document knowledge        → RAG retrieval (retrieval.py): the actual
     course content.

The snapshot is fetched server-side with the service role, scoped by the
JWT-verified ``user_id`` — the client never supplies workspace numbers, so a
tampered request can't inject another user's data or inflated counts. The
client only sends UI facts that exist nowhere else (current page, active
course tab), which are sanitised here.

Everything is best-effort: a failed query degrades to an absent section, and
the prompt block tells the model to treat missing data as "not visible yet"
rather than inventing it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Any

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# The six course tabs as they appear in the UI. The model must use these exact
# names; the frontend action router maps them back to data-course-tab values.
COURSE_TABS = ("Files", "Quiz", "Flashcards", "ExamForge", "Cheatsheet", "Deep Learn")
_TAB_KEYS = {"files", "quiz", "flashcards", "examforge", "cheatsheet", "deeplearn"}
_TAB_LABELS = {
    "files": "Files",
    "quiz": "Quiz",
    "flashcards": "Flashcards",
    "examforge": "ExamForge",
    "cheatsheet": "Cheatsheet",
    "deeplearn": "Deep Learn",
}

# Actions the model may offer as clickable buttons (```minallo-actions``` block).
# Must stay in sync with the frontend allowlist in ai-markdown.ts.
ALLOWED_AI_ACTIONS = (
    "open_files",
    "open_quiz",
    "open_flashcards",
    "open_examforge",
    "open_cheatsheet",
    "open_deep_learn",
    "generate_quiz",
    "generate_flashcards",
    "generate_cheatsheet",
    "generate_examforge_exam",
    "start_deeplearn",
    "create_study_plan",
    "review_weak_topics",
)

# Snapshot TTL: workspace counts change on user actions (upload, generate),
# not per message — 120s keeps the per-message cost at ~zero while staying
# fresh enough that "I found 3 quizzes" is never minutes stale.
_SNAPSHOT_TTL_SECONDS = 120
_snapshot_cache: dict[tuple[str, str], tuple[float, dict[str, Any] | None]] = {}


def _names(rows: list[dict[str, Any]], key: str, limit: int) -> list[str]:
    out: list[str] = []
    for r in rows:
        v = (r.get(key) or "").strip()
        if v:
            out.append(v[:80])
        if len(out) >= limit:
            break
    return out


def fetch_workspace_snapshot(user_id: str, course_id: str) -> dict[str, Any] | None:
    """Per-course snapshot of the student's real study material.

    Returns ``None`` when nothing could be fetched (the prompt then simply
    omits the live-workspace section). All queries are user-scoped.
    """
    if not user_id or not course_id:
        return None
    cache_key = (user_id, course_id)
    hit = _snapshot_cache.get(cache_key)
    now = time.time()
    if hit and now - hit[0] < _SNAPSHOT_TTL_SECONDS:
        return hit[1]

    sb = get_supabase()
    snapshot: dict[str, Any] = {}
    try:
        docs = (
            sb.table("documents")
            .select("file_name", count="exact")
            .eq("user_id", user_id).eq("course_id", course_id)
            .order("created_at", desc=True).limit(8)
            .execute()
        )
        snapshot["files"] = {
            "count": docs.count if docs.count is not None else len(docs.data or []),
            "recent": _names(docs.data or [], "file_name", 8),
        }
    except Exception:
        log.exception("workspace snapshot: documents query failed")

    try:
        sets = (
            sb.table("study_sets")
            .select("tool, name, item_count")
            .eq("user_id", user_id).eq("course_id", course_id)
            .order("created_at", desc=True).limit(100)
            .execute()
        )
        quizzes = [r for r in (sets.data or []) if r.get("tool") == "quiz"]
        decks = [r for r in (sets.data or []) if r.get("tool") == "flashcards"]
        snapshot["quiz"] = {"count": len(quizzes), "recent": _names(quizzes, "name", 5)}
        snapshot["flashcards"] = {
            "decks": len(decks),
            "cards": sum(int(r.get("item_count") or 0) for r in decks),
            "recent": _names(decks, "name", 5),
        }
    except Exception:
        log.exception("workspace snapshot: study_sets query failed")

    try:
        exams = (
            sb.table("exam_sessions")
            .select("title, score, status")
            .eq("user_id", user_id).eq("course_id", course_id)
            .order("created_at", desc=True).limit(20)
            .execute()
        )
        rows = exams.data or []
        latest = rows[0] if rows else None
        snapshot["examforge"] = {
            "count": len(rows),
            "latest": (latest.get("title") or "").strip()[:80] if latest else None,
            "latestScore": latest.get("score") if latest else None,
        }
    except Exception:
        log.exception("workspace snapshot: exam_sessions query failed")

    try:
        notes = (
            sb.table("notes")
            .select("title, type")
            .eq("user_id", user_id).eq("course_id", course_id)
            .in_("type", ["cheatsheet", "deep_learn"])
            .order("created_at", desc=True).limit(50)
            .execute()
        )
        sheets = [r for r in (notes.data or []) if r.get("type") == "cheatsheet"]
        sessions = [r for r in (notes.data or []) if r.get("type") == "deep_learn"]
        snapshot["cheatsheet"] = {"count": len(sheets), "recent": _names(sheets, "title", 3)}
        snapshot["deeplearn"] = {"count": len(sessions), "recent": _names(sessions, "title", 3)}
    except Exception:
        log.exception("workspace snapshot: notes query failed")

    # Recent activity in this course + account-level study stats (Study Lounge).
    try:
        prog = (
            sb.table("course_progress")
            .select("opened_files, ai_sessions, last_opened_at")
            .eq("user_id", user_id).eq("course_id", course_id)
            .limit(1)
            .execute()
        )
        row = (prog.data or [None])[0]
        if row:
            opened = row.get("opened_files")
            opened_list = opened if isinstance(opened, list) else []
            snapshot["activity"] = {
                "openedFiles": [str(f)[:80] for f in opened_list[-5:]],
                "aiSessions": int(row.get("ai_sessions") or 0),
                "lastOpenedAt": (str(row.get("last_opened_at") or "")[:10] or None),
            }
    except Exception:
        log.exception("workspace snapshot: course_progress query failed")

    try:
        lounge = (
            sb.table("study_lounge_stats")
            .select("study_minutes, streak")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        row = (lounge.data or [None])[0]
        if row:
            snapshot["study"] = {
                "minutes": int(row.get("study_minutes") or 0),
                "streak": int(row.get("streak") or 0),
            }
    except Exception:
        log.exception("workspace snapshot: study_lounge_stats query failed")

    result = snapshot or None
    _snapshot_cache[cache_key] = (now, result)
    # Keep the in-process cache bounded.
    if len(_snapshot_cache) > 2000:
        _snapshot_cache.clear()
    return result


def workspace_fingerprint(snapshot: dict[str, Any] | None) -> str:
    """Short stable hash of the snapshot for the answer-cache key, so a cached
    "you have 3 quizzes" answer dies the moment a 4th quiz appears."""
    if not snapshot:
        return ""
    serial = json.dumps(snapshot, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(serial.encode("utf-8")).hexdigest()[:16]


def sanitize_page_context(raw: dict[str, Any] | None) -> dict[str, str]:
    """Clamp + validate the client-sent UI location. Only facts the server
    cannot know (which page/tab is on screen) are accepted, and only as short
    plain strings — nothing here is trusted as workspace data."""
    if not raw or not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    page = str(raw.get("page") or "").strip()[:40]
    if re.fullmatch(r"[a-z0-9_-]{1,40}", page or ""):
        out["page"] = page
    tab = str(raw.get("activeTab") or "").strip().lower()
    if tab in _TAB_KEYS:
        out["activeTab"] = tab
    course_name = str(raw.get("courseName") or "").strip()[:120]
    if course_name:
        out["courseName"] = course_name
    doc_title = str(raw.get("documentTitle") or "").strip()[:160]
    if doc_title:
        out["documentTitle"] = doc_title
    return out


def _section_line(label: str, text: str) -> str:
    return f"- {label}: {text}"


def format_workspace_block(
    snapshot: dict[str, Any] | None,
    *,
    page_context: dict[str, str] | None = None,
    weak_topics: list[str] | None = None,
    course_name: str | None = None,
) -> str:
    """The LIVE WORKSPACE prompt section. Returns "" when there is nothing
    real to say (no snapshot, no location, no weak topics).

    ``course_name`` labels whose data the counts are — set when the student
    asked about a specific course by name, so the model attributes the
    numbers to that course rather than the one currently on screen."""
    if not snapshot and not page_context and not weak_topics:
        return ""

    lines: list[str] = [
        "",
        "═══════════════════════════════════════════════════════════════════",
        "LIVE WORKSPACE — THIS STUDENT'S REAL COURSE DATA (server-fetched)",
        "═══════════════════════════════════════════════════════════════════",
        "Course tabs: Files · Quiz · Flashcards · ExamForge · Cheatsheet · Deep Learn",
        "(always use these exact tab names)",
        "",
    ]
    if course_name and snapshot:
        lines.append(
            f'- All counts below are for the course "{course_name}" — '
            "the course the student asked about."
        )

    if snapshot:
        files = snapshot.get("files")
        if files is not None:
            recent = ", ".join(f'"{n}"' for n in files.get("recent") or [])
            lines.append(_section_line(
                "Files",
                f"{files.get('count', 0)} document(s)" + (f". Recent: {recent}" if recent else ""),
            ))
        quiz = snapshot.get("quiz")
        if quiz is not None:
            names = ", ".join(f'"{n}"' for n in quiz.get("recent") or [])
            lines.append(_section_line(
                "Quiz",
                f"{quiz.get('count', 0)} quiz(zes)" + (f" — {names}" if names else ""),
            ))
        fc = snapshot.get("flashcards")
        if fc is not None:
            lines.append(_section_line(
                "Flashcards",
                f"{fc.get('decks', 0)} deck(s), {fc.get('cards', 0)} cards total",
            ))
        ef = snapshot.get("examforge")
        if ef is not None:
            latest = ef.get("latest")
            score = ef.get("latestScore")
            extra = ""
            if latest:
                extra = f' — latest: "{latest}"' + (f" (score {score})" if score is not None else "")
            lines.append(_section_line("ExamForge", f"{ef.get('count', 0)} exam(s)" + extra))
        cs = snapshot.get("cheatsheet")
        if cs is not None:
            names = ", ".join(f'"{n}"' for n in cs.get("recent") or [])
            lines.append(_section_line(
                "Cheatsheet",
                f"{cs.get('count', 0)} cheatsheet(s)" + (f" — {names}" if names else ""),
            ))
        dl = snapshot.get("deeplearn")
        if dl is not None:
            names = ", ".join(f'"{n}"' for n in dl.get("recent") or [])
            lines.append(_section_line(
                "Deep Learn",
                f"{dl.get('count', 0)} session(s)" + (f" — {names}" if names else ""),
            ))

    if snapshot:
        act = snapshot.get("activity")
        if act:
            bits: list[str] = []
            if act.get("lastOpenedAt"):
                bits.append(f"course last opened {act['lastOpenedAt']}")
            if act.get("aiSessions"):
                bits.append(f"{act['aiSessions']} AI session(s)")
            opened = act.get("openedFiles") or []
            if opened:
                bits.append("recently opened: " + ", ".join(f'"{n}"' for n in opened[-3:]))
            if bits:
                lines.append(_section_line("Recent activity", "; ".join(bits)))
        study = snapshot.get("study")
        if study and (study.get("minutes") or study.get("streak")):
            lines.append(_section_line(
                "Study stats (whole account)",
                f"{study.get('minutes', 0)} min total study time, "
                f"{study.get('streak', 0)}-day streak",
            ))

    if weak_topics:
        lines.append(_section_line(
            "Weak topics (lowest mastery first)",
            ", ".join(t[:60] for t in weak_topics[:6]),
        ))

    pc = page_context or {}
    location_bits: list[str] = []
    if pc.get("courseName"):
        location_bits.append(f'in the course "{pc["courseName"]}"')
    if pc.get("activeTab"):
        location_bits.append(f'on the {_TAB_LABELS[pc["activeTab"]]} tab')
    if pc.get("documentTitle"):
        location_bits.append(f'reading "{pc["documentTitle"]}"')
    if not location_bits and pc.get("page"):
        location_bits.append(f'on the {pc["page"]} page')
    if location_bits:
        lines.append("- Student location right now: " + ", ".join(location_bits))

    lines += [
        "",
        "WORKSPACE RULES:",
        "1. The counts and names above are the ONLY workspace facts. Use them",
        "   (with real numbers) when the student asks what exists in this",
        "   course, what they can do, or what to study next.",
        "2. A count of 0 (or a missing section) means it does not exist yet:",
        '   say "I cannot see any … in this course yet" and suggest creating',
        "   one. NEVER invent files, quizzes, decks, exams, cheatsheets, or",
        "   Deep Learn sessions.",
        "3. Refer to course sections by their exact tab names: Files, Quiz,",
        "   Flashcards, ExamForge, Cheatsheet, Deep Learn.",
    ]
    return "\n".join(lines)


# ── Assistant-mode detection ─────────────────────────────────────────────────
#
# The user never picks a mode; cheap regexes route the message. Only the modes
# that change the ANSWER STRUCTURE are detected here — "assistant" (app/product
# questions) and "document expert" (default grounded RAG) are already separate
# paths in the pipeline.

_EXAM_COACH_RE = re.compile(
    r"\b("
    r"prepare\s+(me\s+)?for\s+(the\s+|this\s+|my\s+)?(exam|test|klausur|prüfung|pruefung)|"
    r"exam\s+(prep|preparation|plan|strategy)|"
    r"study\s+plan|revision\s+plan|lernplan|"
    r"what\s+should\s+i\s+(study|learn|revise|review)(\s+next)?|"
    r"was\s+soll(te)?\s+ich\s+(als\s+nächstes\s+)?(lernen|wiederholen)|"
    r"prüfungsvorbereitung|pruefungsvorbereitung|klausurvorbereitung|"
    r"how\s+(do|should)\s+i\s+(prepare|revise|study)\s+for"
    r")\b",
    re.IGNORECASE,
)

_TUTOR_RE = re.compile(
    r"\b("
    r"teach\s+me|tutor\s+me|like\s+a\s+tutor|"
    r"step\s*[- ]?by\s*[- ]?step|schritt\s+für\s+schritt|schritt\s+fuer\s+schritt|"
    r"bring\s+mir\s+.{0,40}\s+bei|erkläre?\s+mir\s+.{0,60}\s+wie\s+ein\s+tutor|"
    r"explain\s+.{0,60}\s+like\s+(a\s+tutor|i'?m\s+(five|5|new))|"
    r"walk\s+me\s+through"
    r")\b",
    re.IGNORECASE,
)


def detect_assistant_mode(question: str) -> str | None:
    """'exam_coach' | 'tutor' | None. Exam coach wins when both match — a
    "teach me, I have an exam" message needs the plan, not just the lesson."""
    if not question:
        return None
    q = question.strip()
    if len(q) > 600:
        return None
    if _EXAM_COACH_RE.search(q):
        return "exam_coach"
    if _TUTOR_RE.search(q):
        return "tutor"
    return None


# Questions about the student's OWN workspace ("my flashcards", "which quizzes
# did I complete", "what can I do in this course"). These are answered from the
# live workspace block — course-document retrieval would only pull irrelevant
# lecture chunks, exactly like app questions.
_WORKSPACE_QUESTION_RE = re.compile(
    r"\b("
    r"my\s+(files?|documents?|pdfs?|flashcards?|decks?|quiz(zes)?|exams?|"
    r"cheat\s*-?\s*sheets?|progress|weak\s+topics?|study\s+(time|progress)|sessions?)|"
    r"meine?n?\s+(dateien|dokumente|karteikarten|quizz?e|prüfungen|pruefungen|"
    r"spickzettel|fortschritt|schwächen|schwaechen)|"
    r"which\s+(quiz(zes)?|exams?|topics?|flashcards?)\s+(did|have)\s+i|"
    r"welche\s+(quizz?e|themen|prüfungen|pruefungen|dateien|dokumente|"
    r"karteikarten|spickzettel|cheat\s*-?\s*sheets?|kurse)\s+hab(e)?\s+ich|"
    r"what\s+can\s+i\s+do\s+(in|with)\s+(this|the|my)\s+course|"
    r"was\s+kann\s+ich\s+(in|mit)\s+(diesem|dem)\s+kurs|"
    r"what('?s| is)\s+(inside|in)\s+(this|the|my)\s+(course|folder)|"
    r"which\s+topics?\s+am\s+i\s+weak|what\s+are\s+my\s+weak|"
    # "what/which/how many <tool items or courses> do I have …" — inventory
    # questions about the student's own material. Answered from the workspace
    # and account snapshots — RAG retrieval would only pull lecture chunks and
    # invent an inventory.
    r"(what|which|how\s+many)\s+(files?|documents?|pdfs?|quiz(zes)?|"
    r"flashcards?|(flashcard\s+)?decks?|exams?|cheat\s*-?\s*sheets?|"
    r"summaries|notes?|deep\s*-?\s*learn\s+sessions?|courses?)\s+"
    r"(do|did|does|have|has|am|are|can)\s+i|"
    r"my\s+courses|list\s+(all\s+(of\s+)?)?my\s+courses?|"
    r"courses?\s+(in|inside|on)\s+(my|the|this)\s+(account|website|app|site|platform|sidebar)|"
    r"meine\s+kurse|wie\s+viele\s+(kurse|dateien|karteikarten|quizz?e|spickzettel)"
    r")\b",
    re.IGNORECASE,
)


def is_workspace_question(question: str) -> bool:
    """True when the question is about the student's own Minallo material or
    progress rather than the academic content itself."""
    if not question:
        return False
    q = question.strip()
    if len(q) > 500:
        return False
    return bool(_WORKSPACE_QUESTION_RE.search(q))


# ── Answer-structure overlays ────────────────────────────────────────────────

TUTOR_STRUCTURE_OVERLAY = """

TUTOR MODE — the student asked to be taught. Structure the answer as a lesson:
1. Simple explanation — the core idea in 2-3 plain sentences.
2. Example — one concrete worked example (from the course context when available).
3. Step-by-step breakdown — numbered steps, one idea per step.
4. Quick check — end with ONE short understanding-check question ("Quick check: …?").
5. Suggested next action — one sentence naming a Minallo tool by its exact tab
   name (e.g. "Start a Deep Learn session on this topic" or "Generate
   Flashcards to review it").
Guide, don't dump: keep each part short rather than writing one long essay.
"""

EXAM_COACH_OVERLAY = """

EXAM COACH MODE — the student asked for exam preparation / what to study next.
Structure the answer as a plan grounded in the LIVE WORKSPACE data:
1. What exists — name the real material (file/quiz/deck/exam counts from the
   live workspace; never invented).
2. What's done & weak — completed work and weak topics, when known.
3. Suggested study order — a numbered plan using the recommended tool order:
   Files → Cheatsheet → Deep Learn → Flashcards → Quiz → ExamForge.
   Skip steps whose material doesn't exist yet — suggest generating it instead.
4. Keep it actionable: each step says what to do in which tab, in one line.
"""

# ── Account-level workspace (for the generic /chat path, no course scope) ───
#
# The standalone Chatbot often runs with no course selected. This block gives
# it the student's real course list (from profiles.courses) with per-course
# document counts, so "which courses do I have" / "where should I ask about X"
# get grounded answers instead of guesses.

_account_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def fetch_account_snapshot(user_id: str) -> dict[str, Any] | None:
    if not user_id:
        return None
    hit = _account_cache.get(user_id)
    now = time.time()
    if hit and now - hit[0] < _SNAPSHOT_TTL_SECONDS:
        return hit[1]

    sb = get_supabase()
    snapshot: dict[str, Any] | None = None
    try:
        prof = (
            sb.table("profiles").select("courses").eq("id", user_id).limit(1).execute()
        )
        courses_json = (prof.data or [{}])[0].get("courses") if prof.data else None

        doc_counts: dict[str, int] = {}
        try:
            docs = (
                sb.table("documents")
                .select("course_id")
                .eq("user_id", user_id)
                .limit(2000)
                .execute()
            )
            for r in docs.data or []:
                cid = str(r.get("course_id") or "")
                if cid:
                    doc_counts[cid] = doc_counts.get(cid, 0) + 1
        except Exception:
            log.exception("account snapshot: documents query failed")

        courses: list[dict[str, Any]] = []
        if isinstance(courses_json, dict):
            for sem_courses in courses_json.values():
                if not isinstance(sem_courses, list):
                    continue
                for c in sem_courses:
                    if not isinstance(c, dict):
                        continue
                    cid = str(c.get("id") or "").strip()
                    name = str(c.get("name") or c.get("short") or "").strip()
                    if not name:
                        continue
                    courses.append({
                        "id": cid,
                        "name": name[:80],
                        # The abbreviation students actually type ("TM2") —
                        # kept for match_course_in_text, not shown in prompts.
                        "short": str(c.get("short") or "").strip()[:20],
                        "files": doc_counts.get(cid, 0),
                    })
                    if len(courses) >= 20:
                        break
                if len(courses) >= 20:
                    break
        if courses:
            snapshot = {"courses": courses}
    except Exception:
        log.exception("account snapshot failed")

    _account_cache[user_id] = (now, snapshot)
    if len(_account_cache) > 2000:
        _account_cache.clear()
    return snapshot


def match_course_in_text(snapshot: dict[str, Any] | None, text: str) -> dict[str, Any] | None:
    """Best-effort: the account-snapshot course whose name (or short code)
    appears in ``text``. Longest match wins, so "Technische Mechanik 2" beats
    a sibling "Technische Mechanik". ``None`` when nothing matches — the
    caller then stays on the active course."""
    if not snapshot or not snapshot.get("courses") or not text:
        return None
    t = " ".join(text.lower().split())
    best: dict[str, Any] | None = None
    best_len = 0
    for c in snapshot["courses"]:
        for key in ("name", "short"):
            v = " ".join(str(c.get(key) or "").lower().split())
            # ≥3 chars and not embedded in a longer word ("TM2" must not
            # match inside "atm2x"); names are short so re.escape is cheap.
            if len(v) >= 3 and len(v) > best_len and re.search(
                rf"(?<![a-z0-9]){re.escape(v)}(?![a-z0-9])", t
            ):
                best, best_len = c, len(v)
    return best


def format_account_block(snapshot: dict[str, Any] | None, *, in_course_chat: bool = False) -> str:
    """Compact course-list block. "" when unknown.

    ``in_course_chat`` switches the trailing guidance: the generic chatbot
    cannot read course files unless attached, while the course-scoped
    ``/ask-stream`` surface can — telling the model otherwise there would
    make it refuse questions it can actually answer.
    """
    if not snapshot or not snapshot.get("courses"):
        return ""
    course_lines = [
        f'- "{c["name"]}"' + (f" ({c['files']} file(s) uploaded)" if c.get("files") else " (no files yet)")
        for c in snapshot["courses"]
    ]
    if in_course_chat:
        guidance = (
            "For another course's content, suggest opening that course "
            "(sidebar → Courses) and asking the AI there."
        )
    else:
        guidance = (
            "For questions about a specific course's content, suggest "
            "opening that course (sidebar → Courses) and asking the AI there, or "
            "importing its files into this chat — this generic chat cannot read "
            "course files unless they are attached."
        )
    return (
        "\n\n"
        "MINALLO ACCOUNT WORKSPACE — this student's real courses (server-fetched):\n"
        + "\n".join(course_lines) + "\n"
        "Rules: these are the ONLY courses that exist — never invent others. "
        "When the student asks what courses they have, list these names exactly. "
        "Each course has six tabs: Files, Quiz, Flashcards, ExamForge, Cheatsheet, "
        "Deep Learn. " + guidance
    )


# Contract for clickable action buttons. Mirrored by the frontend renderer
# (ai-markdown.ts `minallo-actions` block) — keep the JSON shape and the
# action ids in sync with ALLOWED_AI_ACTIONS.
ACTIONS_CONTRACT = """

ACTION BUTTONS — when (and only when) a concrete next step inside Minallo would
help, you may end the answer with ONE fenced block of clickable actions:

```minallo-actions
{"actions":[{"action":"generate_flashcards","label":"Generate flashcards"}]}
```

Rules:
- Allowed action ids ONLY: open_files, open_quiz, open_flashcards,
  open_examforge, open_cheatsheet, open_deep_learn, generate_quiz,
  generate_flashcards, generate_cheatsheet, generate_examforge_exam,
  start_deeplearn, create_study_plan, review_weak_topics.
- At most 3 actions. Labels ≤ 40 chars, in the student's language.
- The block must be the LAST thing in the answer, after the prose.
- Never emit the block for pure content questions that need no follow-up.
"""
