"""Pure-function tests for the live workspace context layer."""

from __future__ import annotations

from app.services.workspace_context import (
    ALLOWED_AI_ACTIONS,
    ACTIONS_CONTRACT,
    detect_assistant_mode,
    format_account_block,
    format_workspace_block,
    is_workspace_question,
    match_course_in_text,
    sanitize_page_context,
    workspace_fingerprint,
)


def _snapshot() -> dict:
    return {
        "files": {"count": 7, "recent": ["Mechanik2.pdf", "Uebung_3.pdf"]},
        "quiz": {"count": 3, "recent": ["Kapitel 1"]},
        "flashcards": {"decks": 2, "cards": 42, "recent": ["Definitionen"]},
        "examforge": {"count": 1, "latest": "Probeklausur", "latestScore": 78},
        "cheatsheet": {"count": 1, "recent": ["Formelsammlung"]},
        "deeplearn": {"count": 2, "recent": ["Biegung"]},
    }


# ── format_workspace_block ───────────────────────────────────────────────────

def test_block_contains_real_counts_and_exact_tab_names():
    block = format_workspace_block(_snapshot())
    assert "7 document(s)" in block
    assert "3 quiz(zes)" in block
    assert "2 deck(s), 42 cards" in block
    assert '"Probeklausur" (score 78)' in block
    for tab in ("Files", "Quiz", "Flashcards", "ExamForge", "Cheatsheet", "Deep Learn"):
        assert tab in block
    # The anti-hallucination rule must always ride along.
    assert "NEVER invent" in block


def test_block_includes_location_and_weak_topics():
    block = format_workspace_block(
        _snapshot(),
        page_context={"courseName": "EngMech 2", "activeTab": "quiz"},
        weak_topics=["Torsion", "Knickung"],
    )
    assert 'in the course "EngMech 2"' in block
    assert "on the Quiz tab" in block
    assert "Torsion" in block and "Knickung" in block


def test_block_includes_activity_and_study_stats():
    snap = _snapshot()
    snap["activity"] = {
        "openedFiles": ["Mechanik2.pdf"],
        "aiSessions": 4,
        "lastOpenedAt": "2026-06-11",
    }
    snap["study"] = {"minutes": 412, "streak": 5}
    block = format_workspace_block(snap)
    assert "course last opened 2026-06-11" in block
    assert "4 AI session(s)" in block
    assert '"Mechanik2.pdf"' in block
    assert "412 min total study time, 5-day streak" in block


def test_account_block_lists_real_courses_only():
    block = format_account_block({
        "courses": [
            {"id": "tm2", "name": "TM2", "files": 12},
            {"id": "ft", "name": "Fertigungstechnik", "files": 0},
        ]
    })
    assert '"TM2" (12 file(s) uploaded)' in block
    assert '"Fertigungstechnik" (no files yet)' in block
    assert "never invent" in block
    assert format_account_block(None) == ""
    assert format_account_block({"courses": []}) == ""


def test_account_block_course_chat_variant_drops_generic_chat_caveat():
    snap = {"courses": [{"id": "tm2", "name": "TM2", "files": 12}]}
    course_chat = format_account_block(snap, in_course_chat=True)
    generic = format_account_block(snap)
    assert "this generic chat cannot read" in generic
    assert "this generic chat cannot read" not in course_chat
    assert "never invent" in course_chat


def test_block_empty_when_nothing_known():
    assert format_workspace_block(None) == ""
    assert format_workspace_block(None, page_context={}, weak_topics=[]) == ""


def test_fingerprint_changes_with_data_and_is_stable():
    snap = _snapshot()
    a = workspace_fingerprint(snap)
    b = workspace_fingerprint(snap)
    assert a == b and len(a) == 16
    snap["quiz"]["count"] = 4
    assert workspace_fingerprint(snap) != a
    assert workspace_fingerprint(None) == ""


# ── sanitize_page_context ────────────────────────────────────────────────────

def test_page_context_sanitises_and_validates():
    out = sanitize_page_context({
        "page": "pdf-viewer",
        "activeTab": "ExamForge",          # case-normalised
        "courseName": "  EngMech 2  ",
        "documentTitle": "x" * 999,
        "unknown": "dropped",
    })
    assert out["page"] == "pdf-viewer"
    assert out["activeTab"] == "examforge"
    assert out["courseName"] == "EngMech 2"
    assert len(out["documentTitle"]) == 160
    assert "unknown" not in out


def test_page_context_rejects_bad_values():
    out = sanitize_page_context({"page": "<script>", "activeTab": "not-a-tab"})
    assert "page" not in out and "activeTab" not in out
    assert sanitize_page_context(None) == {}
    assert sanitize_page_context("nope") == {}  # type: ignore[arg-type]


# ── mode + workspace-question detection ──────────────────────────────────────

def test_exam_coach_detection():
    assert detect_assistant_mode("Prepare me for the exam") == "exam_coach"
    assert detect_assistant_mode("can you make me a study plan?") == "exam_coach"
    assert detect_assistant_mode("What should I study next?") == "exam_coach"
    assert detect_assistant_mode("Wie bereite ich mich auf die Klausur vor? Prüfungsvorbereitung bitte") == "exam_coach"


def test_tutor_detection():
    assert detect_assistant_mode("teach me eigenvalues step by step") in ("tutor", "exam_coach")
    assert detect_assistant_mode("walk me through this derivation") == "tutor"
    assert detect_assistant_mode("Erkläre es Schritt für Schritt") == "tutor"


def test_plain_content_questions_have_no_mode():
    assert detect_assistant_mode("What is the shear stress in Aufgabe 3?") is None
    assert detect_assistant_mode("") is None


def test_workspace_question_detection():
    assert is_workspace_question("Where are my flashcards?")
    assert is_workspace_question("Which quizzes did I complete?")
    assert is_workspace_question("What can I do in this course?")
    assert is_workspace_question("which topics am I weak in?")
    assert not is_workspace_question("What is the moment of inertia of a beam?")
    assert not is_workspace_question("")


def test_course_list_questions_are_workspace_questions():
    # The exact phrasings from the 2026-06-12 bug report: these used to fall
    # into the auto-mode default (course-files RAG) and the model invented
    # a course list from retrieved lecture chunks.
    assert is_workspace_question("what courses do I have inside the website?")
    assert is_workspace_question("I meant inside the tab courses, what courses do I have listed there?")
    assert is_workspace_question("Which courses do I have?")
    assert is_workspace_question("how many courses do I have?")
    assert is_workspace_question("list my courses")
    assert is_workspace_question("what are my courses?")
    assert is_workspace_question("welche Kurse habe ich?")
    assert is_workspace_question("zeig mir meine Kurse")
    # Academic questions that merely mention a course must stay on RAG.
    assert not is_workspace_question("Which course topics are covered in chapter 3?")
    assert not is_workspace_question("summarize the course introduction lecture")


def test_tool_inventory_questions_are_workspace_questions():
    # The 2026-06-12 follow-up bug: "what cheatsheets do I have in Technische
    # Mechanik 2" fell through to RAG, found no anchor, and got a generic
    # navigation answer instead of the real cheatsheet list.
    assert is_workspace_question("what cheatsheets do I have in Technische Mechanik 2")
    assert is_workspace_question("what cheat sheets do I have?")
    assert is_workspace_question("which flashcard decks do I have?")
    assert is_workspace_question("how many quizzes do I have in this course?")
    assert is_workspace_question("what files do I have in TM2?")
    assert is_workspace_question("welche Spickzettel habe ich?")
    assert is_workspace_question("wie viele Karteikarten habe ich?")
    # Content questions about those topics must stay on RAG.
    assert not is_workspace_question("what does the cheatsheet say about torsion?")
    assert not is_workspace_question("explain exercise 3 from the quiz")


def test_match_course_in_text():
    snap = {"courses": [
        {"id": "tm", "name": "Technische Mechanik", "short": "TM1", "files": 3},
        {"id": "tm2", "name": "Technische Mechanik 2", "short": "TM2", "files": 12},
        {"id": "im", "name": "Ingenieurmathematik", "short": "", "files": 5},
    ]}
    # Longest match wins: "Technische Mechanik 2" beats "Technische Mechanik".
    assert match_course_in_text(snap, "what cheatsheets do I have in Technische Mechanik 2?")["id"] == "tm2"
    assert match_course_in_text(snap, "show my files in technische mechanik")["id"] == "tm"
    # Short codes match on word boundaries only.
    assert match_course_in_text(snap, "how many quizzes in TM2?")["id"] == "tm2"
    assert match_course_in_text(snap, "the atm2x sensor datasheet") is None
    assert match_course_in_text(snap, "what courses do I have?") is None
    assert match_course_in_text(None, "TM2") is None
    assert match_course_in_text(snap, "") is None


def test_workspace_block_course_name_label():
    labelled = format_workspace_block(_snapshot(), course_name="Technische Mechanik 2")
    assert 'for the course "Technische Mechanik 2"' in labelled
    plain = format_workspace_block(_snapshot())
    assert "the course the student asked about" not in plain
    # No snapshot → no label either (never attribute absent data to a course).
    assert format_workspace_block(None, course_name="TM2") == ""


class _FakeQuery:
    def __init__(self, table: str, rows: list, calls: dict):
        self._table, self._rows, self._calls = table, rows, calls

    def select(self, cols, **_kw):
        self._calls.setdefault(self._table, {})["select"] = cols
        return self

    def eq(self, *_a):
        return self

    def in_(self, col, vals):
        self._calls.setdefault(self._table, {})["in"] = (col, list(vals))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, _n):
        return self

    def execute(self):
        result = type("R", (), {})()
        result.data = self._rows
        result.count = len(self._rows)
        return result


class _FakeSupabase:
    def __init__(self, rows_by_table: dict, calls: dict):
        self._rows, self._calls = rows_by_table, calls

    def table(self, name: str):
        return _FakeQuery(name, self._rows.get(name, []), self._calls)


def test_snapshot_notes_query_uses_type_column(monkeypatch):
    # Regression: the notes column is `type` (012_notes.sql), not `note_type`.
    # The wrong name made the query raise on every request, so the cheatsheet/
    # Deep Learn sections silently vanished from all snapshots and the model
    # invented cheatsheet inventories.
    import app.services.workspace_context as wc
    calls: dict = {}
    fake = _FakeSupabase({
        "notes": [
            {"title": "Course Cheatsheet", "type": "cheatsheet"},
            {"title": "Lesson 1", "type": "deep_learn"},
        ],
    }, calls)
    monkeypatch.setattr(wc, "get_supabase", lambda: fake)
    snap = wc.fetch_workspace_snapshot("user-type-col-test", "course-type-col-test")
    assert snap is not None
    assert snap["cheatsheet"] == {"count": 1, "recent": ["Course Cheatsheet"]}
    assert snap["deeplearn"] == {"count": 1, "recent": ["Lesson 1"]}
    assert "note_type" not in (calls["notes"].get("select") or "")
    assert calls["notes"]["in"][0] == "type"


def test_actions_contract_only_names_allowed_actions():
    # Every action id mentioned in the contract text must be allowlisted —
    # the frontend renderer drops anything else silently.
    import re
    mentioned = set(re.findall(r"\b(open_[a-z_]+|generate_[a-z_]+|start_[a-z_]+|create_[a-z_]+|review_[a-z_]+)\b", ACTIONS_CONTRACT))
    assert mentioned <= set(ALLOWED_AI_ACTIONS)
    assert "generate_flashcards" in mentioned
