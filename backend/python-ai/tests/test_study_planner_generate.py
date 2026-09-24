"""Unit tests for the Phase 2 AI weekly-plan generation helpers.

Pure functions only — no Supabase, no LLM, no network. The tests cover:
  - malformed task list is coerced (invalid taskType dropped, solution file
    never becomes solve_exercise_sheet, estimatedMinutes clamped)
  - medium/low confidence exercise↔lecture match becomes a possibleMatch,
    not a scheduled task
  - one-best-lecture dedup per (course, topic)
  - _coerce_task / _coerce_possible_match / _coerce_subject_allocation helpers
  - generate_week_plan returns empty plan on LLM failure (no raises)

conftest.py stubs out env vars so the real app.config is importable.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.services.study_planner import (
    _coerce_possible_match,
    _coerce_subject_allocation,
    _coerce_task,
    _dedup_best_lecture_per_topic,
    _parse_week_date,
    generate_week_plan,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

_WEEK_START = "2025-06-09"  # a Monday
_ALL_DAYS = {0, 1, 2, 3, 4, 5, 6}
_WEEKDAY_DAYS = {0, 1, 2, 3, 4}

_VALID_TASK = {
    "taskType": "study_lecture",
    "dayIndex": 0,
    "courseId": "course-abc",
    "subjectName": "Mechanics",
    "lectureFileId": "file-111",
    "lectureFileName": "Lecture01.pdf",
    "lectureTopics": ["Kinematics"],
    "estimatedMinutes": 45,
    "reason": "Start with fundamentals",
    "sourceConfidence": "confirmed",
}


# ── _parse_week_date ──────────────────────────────────────────────────────────

def test_parse_week_date_monday():
    assert _parse_week_date("2025-06-09", 0) == "2025-06-09"


def test_parse_week_date_sunday():
    assert _parse_week_date("2025-06-09", 6) == "2025-06-15"


def test_parse_week_date_wednesday():
    assert _parse_week_date("2025-06-09", 2) == "2025-06-11"


# ── _coerce_task ──────────────────────────────────────────────────────────────

def test_coerce_task_valid_passes_through():
    t = _coerce_task(_VALID_TASK, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["taskType"] == "study_lecture"
    assert t["planDate"] == "2025-06-09"
    assert t["dayIndex"] == 0
    assert t["status"] == "todo"
    assert t["estimatedMinutes"] == 45
    # Fresh UUID assigned.
    import uuid
    uuid.UUID(t["id"])  # must not raise


def test_coerce_task_invalid_tasktype_dropped():
    raw = {**_VALID_TASK, "taskType": "teleport_to_exam"}
    assert _coerce_task(raw, _WEEK_START, _ALL_DAYS) is None


def test_coerce_task_day_not_in_available_dropped():
    raw = {**_VALID_TASK, "dayIndex": 5}  # Saturday
    assert _coerce_task(raw, _WEEK_START, _WEEKDAY_DAYS) is None


def test_coerce_task_day_in_available_passes():
    raw = {**_VALID_TASK, "dayIndex": 4}  # Friday
    t = _coerce_task(raw, _WEEK_START, _WEEKDAY_DAYS)
    assert t is not None
    assert t["dayIndex"] == 4
    assert t["planDate"] == "2025-06-13"


def test_coerce_task_clamps_estimated_minutes_too_high():
    raw = {**_VALID_TASK, "estimatedMinutes": 9999}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["estimatedMinutes"] == 180


def test_coerce_task_clamps_estimated_minutes_too_low():
    raw = {**_VALID_TASK, "estimatedMinutes": -5}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["estimatedMinutes"] == 5


def test_coerce_task_clamps_estimated_minutes_zero():
    raw = {**_VALID_TASK, "estimatedMinutes": 0}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["estimatedMinutes"] == 5


def test_coerce_task_invalid_source_confidence_defaults_to_high():
    raw = {**_VALID_TASK, "sourceConfidence": "ultra_certain"}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["sourceConfidence"] == "high"


def test_coerce_task_valid_source_confidences():
    for conf in ("confirmed", "high", "medium", "low"):
        raw = {**_VALID_TASK, "sourceConfidence": conf}
        t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
        assert t is not None
        assert t["sourceConfidence"] == conf


def test_coerce_task_missing_course_id_dropped():
    raw = {**_VALID_TASK, "courseId": ""}
    assert _coerce_task(raw, _WEEK_START, _ALL_DAYS) is None


def test_coerce_task_non_dict_dropped():
    assert _coerce_task("not a dict", _WEEK_START, _ALL_DAYS) is None
    assert _coerce_task(None, _WEEK_START, _ALL_DAYS) is None
    assert _coerce_task(42, _WEEK_START, _ALL_DAYS) is None


def test_coerce_task_status_always_todo():
    raw = {**_VALID_TASK, "status": "done"}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["status"] == "todo"


# ── solution-file safety ──────────────────────────────────────────────────────

def test_coerce_task_solve_exercise_without_exercise_file_dropped():
    """solve_exercise_sheet requires exerciseFileId — dropping protects against
    a solution file being silently treated as an exercise."""
    raw = {
        "taskType": "solve_exercise_sheet",
        "dayIndex": 0,
        "courseId": "course-abc",
        "subjectName": "Mechanics",
        # No exerciseFileId — caller only passed a solutionFileId by mistake.
        "solutionFileId": "sol-111",
        "solutionFileName": "Solution01.pdf",
        "estimatedMinutes": 60,
        "reason": "Practice",
        "sourceConfidence": "confirmed",
    }
    # Must be dropped (no exerciseFileId).
    assert _coerce_task(raw, _WEEK_START, _ALL_DAYS) is None


def test_coerce_task_check_solution_sheet_passes_with_solution_id():
    raw = {
        "taskType": "check_solution_sheet",
        "dayIndex": 1,
        "courseId": "course-abc",
        "subjectName": "Mechanics",
        "solutionFileId": "sol-111",
        "solutionFileName": "Solution01.pdf",
        "estimatedMinutes": 30,
        "reason": "Review answers",
        "sourceConfidence": "confirmed",
    }
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS)
    assert t is not None
    assert t["taskType"] == "check_solution_sheet"
    assert t["solutionFileId"] == "sol-111"


# ── medium/low exercise match → possibleMatch ─────────────────────────────────

def test_generate_week_plan_demotes_medium_confidence_exercise_to_possible_match():
    """An exercise task with sourceConfidence='medium' and a relatedLectureFileId
    must land in possibleMatches, NOT in the tasks list."""
    medium_exercise_task = {
        "taskType": "solve_exercise_sheet",
        "dayIndex": 1,
        "courseId": "course-abc",
        "subjectName": "Mechanics",
        "exerciseFileId": "ex-222",
        "exerciseFileName": "Exercise02.pdf",
        "relatedLectureFileId": "lec-111",
        "relatedLectureFileName": "Lecture01.pdf",
        "estimatedMinutes": 60,
        "reason": "Not sure which lecture matches",
        "sourceConfidence": "medium",
    }
    confirmed_task = {
        "taskType": "study_lecture",
        "dayIndex": 0,
        "courseId": "course-abc",
        "subjectName": "Mechanics",
        "lectureFileId": "lec-111",
        "lectureFileName": "Lecture01.pdf",
        "lectureTopics": ["Kinematics"],
        "estimatedMinutes": 45,
        "reason": "Learn first",
        "sourceConfidence": "confirmed",
    }
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [
            {"courseId": "course-abc", "subjectName": "Mechanics", "percentage": 100, "reason": "Only course"}
        ],
        "tasks": [confirmed_task, medium_exercise_task],
        "possibleMatches": [],
    }

    fake_profiles = [
        {
            "documentId": "lec-111",
            "fileName": "Lecture01.pdf",
            "documentRole": "lecture",
            "topicsCovered": [{"name": "Kinematics", "confidence": "confirmed", "depth": "core"}],
            "prerequisites": [],
            "estimatedStudyMinutes": 45,
            "recommendedUse": "learn_first",
            "summary": "Intro to Kinematics",
        }
    ]

    mock_llm_result = MagicMock()
    mock_llm_result.data = llm_response

    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", return_value=mock_llm_result),
        patch("app.services.study_planner.get_or_build_profiles", return_value=fake_profiles),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)

        plan = generate_week_plan({
            "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-abc",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"monday": 90, "tuesday": 90},
            "regenerate": False,
        })

    # The medium-confidence exercise task must NOT appear in tasks.
    exercise_tasks = [t for t in plan["tasks"] if t.get("exerciseFileId") == "ex-222"]
    assert not exercise_tasks, "medium-confidence exercise task must not appear in tasks"

    # It must appear in possibleMatches.
    pm_exercise_ids = [pm["exerciseFileId"] for pm in plan["possibleMatches"]]
    assert "ex-222" in pm_exercise_ids, "ex-222 must be in possibleMatches"

    pm = next(pm for pm in plan["possibleMatches"] if pm["exerciseFileId"] == "ex-222")
    assert pm["confidence"] in ("medium", "low")
    assert pm["possibleLectureFileId"] == "lec-111"


def test_generate_week_plan_demotes_low_confidence_exercise_to_possible_match():
    """Same as above but sourceConfidence='low'."""
    low_exercise_task = {
        "taskType": "solve_exercise_sheet",
        "dayIndex": 2,
        "courseId": "course-xyz",
        "subjectName": "Thermodynamics",
        "exerciseFileId": "ex-333",
        "exerciseFileName": "Exercise03.pdf",
        "relatedLectureFileId": "lec-333",
        "relatedLectureFileName": "Lecture03.pdf",
        "estimatedMinutes": 60,
        "reason": "Weak match",
        "sourceConfidence": "low",
    }
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [low_exercise_task],
        "possibleMatches": [],
    }
    mock_llm_result = MagicMock()
    mock_llm_result.data = llm_response

    fake_profiles = [
        {
            "documentId": "lec-333",
            "fileName": "Lecture03.pdf",
            "documentRole": "lecture",
            "topicsCovered": [],
            "prerequisites": [],
            "estimatedStudyMinutes": 40,
            "recommendedUse": "learn_first",
            "summary": "",
        }
    ]

    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", return_value=mock_llm_result),
        patch("app.services.study_planner.get_or_build_profiles", return_value=fake_profiles),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)

        plan = generate_week_plan({
            "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-xyz",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"0": 90, "1": 90, "2": 90},
            "regenerate": False,
        })

    exercise_tasks = [t for t in plan["tasks"] if t.get("exerciseFileId") == "ex-333"]
    assert not exercise_tasks, "low-confidence exercise task must not appear in tasks"
    pm_exercise_ids = [pm["exerciseFileId"] for pm in plan["possibleMatches"]]
    assert "ex-333" in pm_exercise_ids


# ── _dedup_best_lecture_per_topic ─────────────────────────────────────────────

def test_dedup_keeps_first_study_lecture_per_topic():
    tasks = [
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-2",  # duplicate primary topic
            "lectureTopics": ["Kinematics"],
            "dayIndex": 1, "planDate": "2025-06-10",
        },
    ]
    result = _dedup_best_lecture_per_topic(tasks)
    assert len(result) == 1
    assert result[0]["lectureFileId"] == "lec-1"


def test_dedup_allows_different_topics():
    tasks = [
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-2",
            "lectureTopics": ["Dynamics"],  # different topic
            "dayIndex": 1, "planDate": "2025-06-10",
        },
    ]
    result = _dedup_best_lecture_per_topic(tasks)
    assert len(result) == 2


def test_dedup_allows_same_topic_different_course():
    tasks = [
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
        {
            "taskType": "study_lecture",
            "courseId": "course-xyz",  # different course
            "lectureFileId": "lec-99",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
    ]
    result = _dedup_best_lecture_per_topic(tasks)
    assert len(result) == 2


def test_dedup_passes_through_non_lecture_tasks():
    tasks = [
        {
            "taskType": "solve_exercise_sheet",
            "courseId": "course-abc",
            "exerciseFileId": "ex-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
        {
            "taskType": "check_solution_sheet",
            "courseId": "course-abc",
            "solutionFileId": "sol-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 1, "planDate": "2025-06-10",
        },
    ]
    result = _dedup_best_lecture_per_topic(tasks)
    assert len(result) == 2


def test_dedup_repeat_lecture_not_deduplicated():
    """repeat_lecture uses the same key logic but is a revision — we allow it
    even when study_lecture already ran (different taskType, same seen key)."""
    tasks = [
        {
            "taskType": "study_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 0, "planDate": "2025-06-09",
        },
        {
            "taskType": "repeat_lecture",
            "courseId": "course-abc",
            "lectureFileId": "lec-1",
            "lectureTopics": ["Kinematics"],
            "dayIndex": 4, "planDate": "2025-06-13",
        },
    ]
    result = _dedup_best_lecture_per_topic(tasks)
    # repeat_lecture is not deduplicated (only study_lecture is dropped).
    assert len(result) == 2


# ── _coerce_possible_match ────────────────────────────────────────────────────

def test_coerce_possible_match_valid():
    raw = {
        "courseId": "course-abc",
        "exerciseFileId": "ex-1",
        "exerciseFileName": "Ex01.pdf",
        "possibleLectureFileId": "lec-1",
        "possibleLectureFileName": "Lec01.pdf",
        "confidence": "medium",
        "reason": "Filename heuristic only",
    }
    pm = _coerce_possible_match(raw)
    assert pm is not None
    assert pm["confidence"] == "medium"
    assert pm["exerciseFileId"] == "ex-1"
    assert pm["possibleLectureFileId"] == "lec-1"


def test_coerce_possible_match_invalid_confidence_defaults_to_medium():
    raw = {
        "courseId": "course-abc",
        "exerciseFileId": "ex-1",
        "exerciseFileName": "Ex01.pdf",
        "possibleLectureFileId": "lec-1",
        "possibleLectureFileName": "Lec01.pdf",
        "confidence": "confirmed",  # only medium/low are valid
        "reason": "high confidence should still be represented",
    }
    pm = _coerce_possible_match(raw)
    assert pm is not None
    assert pm["confidence"] == "medium"


def test_coerce_possible_match_missing_fields_returns_none():
    # Missing exerciseFileId.
    assert _coerce_possible_match({"courseId": "x", "possibleLectureFileId": "y"}) is None
    # Missing possibleLectureFileId.
    assert _coerce_possible_match({"courseId": "x", "exerciseFileId": "y"}) is None
    # Non-dict.
    assert _coerce_possible_match("string") is None
    assert _coerce_possible_match(None) is None


# ── _coerce_subject_allocation ────────────────────────────────────────────────

def test_coerce_subject_allocation_valid():
    raw = {"courseId": "course-abc", "subjectName": "Mechanics", "percentage": 60, "reason": "Hard exam"}
    sa = _coerce_subject_allocation(raw)
    assert sa is not None
    assert sa["percentage"] == 60
    assert sa["courseId"] == "course-abc"


def test_coerce_subject_allocation_clamps_percentage():
    raw = {"courseId": "x", "subjectName": "Y", "percentage": 150, "reason": ""}
    sa = _coerce_subject_allocation(raw)
    assert sa is not None
    assert sa["percentage"] == 100


def test_coerce_subject_allocation_missing_required_returns_none():
    assert _coerce_subject_allocation({"subjectName": "Y", "percentage": 50}) is None
    assert _coerce_subject_allocation({"courseId": "x", "percentage": 50}) is None


# ── generate_week_plan error handling ─────────────────────────────────────────

def test_generate_week_plan_returns_empty_on_llm_failure():
    """If the LLM call raises, generate_week_plan must not raise itself."""
    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", side_effect=RuntimeError("LLM down")),
        patch("app.services.study_planner.get_or_build_profiles", return_value=[
            {
                "documentId": "lec-1",
                "fileName": "Lec01.pdf",
                "documentRole": "lecture",
                "topicsCovered": [],
                "prerequisites": [],
                "estimatedStudyMinutes": 30,
                "recommendedUse": "learn_first",
                "summary": "",
            }
        ]),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)

        plan = generate_week_plan({
            "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-abc",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"monday": 90},
            "regenerate": False,
        })

    assert plan["tasks"] == []
    assert plan["weekStartDate"] == _WEEK_START


def test_generate_week_plan_returns_empty_on_invalid_week_start():
    plan = generate_week_plan({
        "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "weekStartDate": "not-a-date",
        "planScope": "global_week",
        "courseId": None,
        "timezone": "UTC",
        "dailyAvailabilityMinutes": {},
        "regenerate": False,
    })
    assert plan["tasks"] == []
    assert plan["subjectAllocation"] == []
    assert plan["possibleMatches"] == []


def test_generate_week_plan_invalid_tasktype_dropped_in_pipeline():
    """Full integration of the coercion pipeline: invalid taskType is dropped."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [
            {
                "taskType": "teleport_to_exam",  # invalid
                "dayIndex": 0,
                "courseId": "course-abc",
                "subjectName": "Mechanics",
                "estimatedMinutes": 30,
                "reason": "bad",
                "sourceConfidence": "confirmed",
            },
            {  # valid task
                "taskType": "study_lecture",
                "dayIndex": 0,
                "courseId": "course-abc",
                "subjectName": "Mechanics",
                "lectureFileId": "lec-1",
                "lectureFileName": "Lec01.pdf",
                "lectureTopics": ["Kinematics"],
                "estimatedMinutes": 45,
                "reason": "Teach it",
                "sourceConfidence": "confirmed",
            },
        ],
        "possibleMatches": [],
    }
    mock_llm_result = MagicMock()
    mock_llm_result.data = llm_response

    fake_profiles = [
        {
            "documentId": "lec-1",
            "fileName": "Lec01.pdf",
            "documentRole": "lecture",
            "topicsCovered": [],
            "prerequisites": [],
            "estimatedStudyMinutes": 45,
            "recommendedUse": "learn_first",
            "summary": "",
        }
    ]

    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", return_value=mock_llm_result),
        patch("app.services.study_planner.get_or_build_profiles", return_value=fake_profiles),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)

        plan = generate_week_plan({
            "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-abc",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"monday": 90},
            "regenerate": False,
        })

    # Only the valid study_lecture task should be present.
    assert len(plan["tasks"]) == 1
    assert plan["tasks"][0]["taskType"] == "study_lecture"


def test_generate_week_plan_estimatedminutes_clamped_in_pipeline():
    """Full pipeline coercion clamps estimatedMinutes."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [
            {
                "taskType": "study_lecture",
                "dayIndex": 0,
                "courseId": "course-abc",
                "subjectName": "Mechanics",
                "lectureFileId": "lec-1",
                "lectureFileName": "Lec01.pdf",
                "lectureTopics": ["Kinematics"],
                "estimatedMinutes": 5000,   # way too high → must be clamped to 180
                "reason": "Too long",
                "sourceConfidence": "confirmed",
            }
        ],
        "possibleMatches": [],
    }
    mock_llm_result = MagicMock()
    mock_llm_result.data = llm_response

    fake_profiles = [
        {
            "documentId": "lec-1",
            "fileName": "Lec01.pdf",
            "documentRole": "lecture",
            "topicsCovered": [],
            "prerequisites": [],
            "estimatedStudyMinutes": 45,
            "recommendedUse": "learn_first",
            "summary": "",
        }
    ]

    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", return_value=mock_llm_result),
        patch("app.services.study_planner.get_or_build_profiles", return_value=fake_profiles),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)

        plan = generate_week_plan({
            "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-abc",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"monday": 90},
            "regenerate": False,
        })

    assert len(plan["tasks"]) == 1
    assert plan["tasks"][0]["estimatedMinutes"] == 180


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_table_chain(data: list | None = None) -> MagicMock:
    """Return a self-referential Supabase query chain mock.

    Every filter method (.select, .eq, .in_, etc.) returns the same chain so
    any sequence of chained calls terminates at .execute() which returns a mock
    with .data = data (default []) and .count = len(data).
    """
    rows = data if data is not None else []
    result = MagicMock()
    result.data = rows
    result.count = len(rows)

    chain = MagicMock()
    chain.execute.return_value = result

    for attr in ("select", "eq", "neq", "in_", "not_", "is_", "insert", "upsert",
                 "update", "delete", "limit", "order", "gte", "lte", "gt", "lt",
                 "ilike", "like", "contains", "match"):
        getattr(chain, attr).return_value = chain

    chain.not_.return_value = chain
    chain.return_value = chain
    return chain


def _make_sb_return_empty(sb: MagicMock) -> None:
    """Set up the Supabase mock so every table returns empty data by default.

    Uses side_effect on sb.table() to return an independent per-table chain,
    so overriding one table's chain in a test does not poison other tables.
    """
    _table_chains: dict[str, MagicMock] = {}

    def _table_side_effect(table_name: str) -> MagicMock:
        if table_name not in _table_chains:
            _table_chains[table_name] = _make_table_chain([])
        return _table_chains[table_name]

    sb.table.side_effect = _table_side_effect
    # Expose the per-table registry so tests can override specific tables.
    sb._table_chains = _table_chains
