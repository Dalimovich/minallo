"""Stage 6 (Daily Mission validation) tests for the AI weekly planner.

Covers the trust boundary for exercise↔lecture pairings:
  - role validation: an exercise must not be paired to another exercise or to a
    solution file; a lecture-study task's lecture target must be a real lecture.
  - student_exercise_pairings is authoritative: a DISMISSED pair never reappears
    as a possibleMatch; a CONFIRMED pair is scheduled, not re-suggested.
  - files without topic mappings are reported in unmappedFiles.

Pure functions only — Supabase + LLM are mocked, no network.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.services.study_planner import (
    _coerce_task,
    _decided_pairing_keys,
    _pairing_key,
    generate_week_plan,
)

from test_study_planner_generate import _make_sb_return_empty  # reuse helper

_WEEK_START = "2025-06-09"  # a Monday
_ALL_DAYS = {0, 1, 2, 3, 4, 5, 6}
_USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


# ── Role validation in _coerce_task ───────────────────────────────────────────

def test_coerce_task_exercise_paired_to_solution_is_dropped():
    """solve_exercise_sheet whose exerciseFileId is actually a SOLUTION file
    (exercise↔solution) must be rejected."""
    raw = {
        "taskType": "solve_exercise_sheet",
        "dayIndex": 0,
        "courseId": "course-abc",
        "exerciseFileId": "sol-1",  # role=solution → invalid as an exercise
        "estimatedMinutes": 30,
        "reason": "x",
        "sourceConfidence": "high",
    }
    roles = {"sol-1": "solution"}
    assert _coerce_task(raw, _WEEK_START, _ALL_DAYS, roles) is None


def test_coerce_task_exercise_paired_to_another_exercise_strips_related_link():
    """An exercise whose relatedLectureFileId is ANOTHER exercise (exercise↔
    exercise) keeps the exercise task but strips the bogus 'lecture' link."""
    raw = {
        "taskType": "solve_exercise_sheet",
        "dayIndex": 0,
        "courseId": "course-abc",
        "exerciseFileId": "ex-1",
        "relatedLectureFileId": "ex-2",  # another exercise, not a lecture
        "relatedLectureFileName": "Exercise02.pdf",
        "estimatedMinutes": 30,
        "reason": "x",
        "sourceConfidence": "high",
    }
    roles = {"ex-1": "exercise", "ex-2": "exercise"}
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS, roles)
    assert t is not None
    # The exercise task survives, but the invalid related-lecture link is gone.
    assert t.get("relatedLectureFileId") is None
    assert "relatedLectureFileName" not in t


def test_coerce_task_lecture_study_target_must_be_lecture():
    """study_lecture whose lectureFileId is a known non-lecture (exercise) is
    rejected."""
    raw = {
        "taskType": "study_lecture",
        "dayIndex": 0,
        "courseId": "course-abc",
        "lectureFileId": "ex-1",  # role=exercise → invalid as a lecture
        "lectureFileName": "Exercise01.pdf",
        "estimatedMinutes": 30,
        "reason": "x",
        "sourceConfidence": "high",
    }
    roles = {"ex-1": "exercise"}
    assert _coerce_task(raw, _WEEK_START, _ALL_DAYS, roles) is None


def test_coerce_task_lecture_target_unknown_role_passes():
    """An unprofiled/unknown lecture file (role unknown) still passes — only a
    KNOWN conflicting role causes a drop."""
    raw = {
        "taskType": "study_lecture",
        "dayIndex": 0,
        "courseId": "course-abc",
        "lectureFileId": "mystery-1",
        "lectureFileName": "Notes.pdf",
        "estimatedMinutes": 30,
        "reason": "x",
        "sourceConfidence": "high",
    }
    t = _coerce_task(raw, _WEEK_START, _ALL_DAYS, {})
    assert t is not None
    assert t["lectureFileId"] == "mystery-1"


# ── pairing-key helpers ───────────────────────────────────────────────────────

def test_decided_pairing_keys_builds_set():
    keys = _decided_pairing_keys([
        {"exerciseFileId": "ex-1", "lectureFileId": "lec-1"},
        {"exerciseFileId": "ex-2", "lectureFileId": "lec-2"},
        {"exerciseFileId": "", "lectureFileId": "lec-3"},  # incomplete → skipped
        "garbage",                                         # non-dict → skipped
    ])
    assert keys == {_pairing_key("ex-1", "lec-1"), _pairing_key("ex-2", "lec-2")}


def test_decided_pairing_keys_tolerates_non_list():
    assert _decided_pairing_keys(None) == set()
    assert _decided_pairing_keys("nope") == set()


# ── dismissed/confirmed enforcement end-to-end ────────────────────────────────

def _run_plan(llm_response, profiles, *, payload_extra=None):
    mock_llm_result = MagicMock()
    mock_llm_result.data = llm_response
    with (
        patch("app.services.study_planner.get_supabase") as mock_sb,
        patch("app.services.study_planner.chat_json", return_value=mock_llm_result),
        patch("app.services.study_planner.get_or_build_profiles", return_value=profiles),
    ):
        sb = MagicMock()
        mock_sb.return_value = sb
        _make_sb_return_empty(sb)
        payload = {
            "userId": _USER,
            "weekStartDate": _WEEK_START,
            "planScope": "course_week",
            "courseId": "course-abc",
            "timezone": "UTC",
            "dailyAvailabilityMinutes": {"monday": 120, "tuesday": 120, "wednesday": 120},
            "regenerate": False,
        }
        if payload_extra:
            payload.update(payload_extra)
        return generate_week_plan(payload)


def test_dismissed_pair_never_resuggested_as_possible_match():
    """A possibleMatch the LLM emits for a pair the user already DISMISSED must
    be filtered out."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [
            {
                "courseId": "course-abc",
                "exerciseFileId": "ex-1",
                "exerciseFileName": "Ex01.pdf",
                "possibleLectureFileId": "lec-1",
                "possibleLectureFileName": "Lec01.pdf",
                "confidence": "low",
                "reason": "filename heuristic",
            }
        ],
    }
    profiles = [
        {
            "documentId": "lec-1", "fileName": "Lec01.pdf", "documentRole": "lecture",
            "topicsCovered": [{"name": "Kinematics", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 40,
            "recommendedUse": "learn_first", "summary": "",
        },
        {
            "documentId": "ex-1", "fileName": "Ex01.pdf", "documentRole": "exercise",
            "topicsCovered": [{"name": "Kinematics", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 25,
            "recommendedUse": "practice_after_lecture", "summary": "",
        },
    ]
    plan = _run_plan(
        llm_response, profiles,
        payload_extra={"dismissedPairings": [{"exerciseFileId": "ex-1", "lectureFileId": "lec-1"}]},
    )
    assert plan["possibleMatches"] == [], "dismissed pair must not be re-suggested"


def test_confirmed_pair_not_resuggested_as_possible_match():
    """A confirmed pair the LLM re-proposes as a possibleMatch is suppressed (it
    is already scheduled as a real task)."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [
            {
                "courseId": "course-abc",
                "exerciseFileId": "ex-1",
                "exerciseFileName": "Ex01.pdf",
                "possibleLectureFileId": "lec-1",
                "possibleLectureFileName": "Lec01.pdf",
                "confidence": "medium",
                "reason": "re-proposed",
            }
        ],
    }
    profiles = [
        {
            "documentId": "lec-1", "fileName": "Lec01.pdf", "documentRole": "lecture",
            "topicsCovered": [{"name": "K", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 40,
            "recommendedUse": "learn_first", "summary": "",
        },
        {
            "documentId": "ex-1", "fileName": "Ex01.pdf", "documentRole": "exercise",
            "topicsCovered": [{"name": "K", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 25,
            "recommendedUse": "practice_after_lecture", "summary": "",
        },
    ]
    plan = _run_plan(
        llm_response, profiles,
        payload_extra={"confirmedPairings": [{"exerciseFileId": "ex-1", "lectureFileId": "lec-1"}]},
    )
    assert plan["possibleMatches"] == [], "confirmed pair must not appear as a suggestion"


def test_possible_match_with_non_lecture_target_is_dropped():
    """A possibleMatch whose target file is a known SOLUTION (not a lecture) is
    invalid and must be dropped, not surfaced for the user to confirm."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [
            {
                "courseId": "course-abc",
                "exerciseFileId": "ex-1",
                "exerciseFileName": "Ex01.pdf",
                "possibleLectureFileId": "sol-1",  # a solution, not a lecture
                "possibleLectureFileName": "Sol01.pdf",
                "confidence": "low",
                "reason": "bad target",
            }
        ],
    }
    profiles = [
        {
            "documentId": "sol-1", "fileName": "Sol01.pdf", "documentRole": "solution",
            "topicsCovered": [{"name": "K", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 15,
            "recommendedUse": "check_after_exercise", "summary": "",
        },
        {
            "documentId": "ex-1", "fileName": "Ex01.pdf", "documentRole": "exercise",
            "topicsCovered": [{"name": "K", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 25,
            "recommendedUse": "practice_after_lecture", "summary": "",
        },
    ]
    plan = _run_plan(llm_response, profiles)
    assert plan["possibleMatches"] == [], "non-lecture target must be dropped"


def test_self_pair_possible_match_is_dropped():
    """exerciseFileId == possibleLectureFileId is nonsense and must be dropped."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [
            {
                "courseId": "course-abc",
                "exerciseFileId": "x-1",
                "exerciseFileName": "X.pdf",
                "possibleLectureFileId": "x-1",
                "possibleLectureFileName": "X.pdf",
                "confidence": "low",
                "reason": "self",
            }
        ],
    }
    profiles = [
        {
            "documentId": "x-1", "fileName": "X.pdf", "documentRole": "exercise",
            "topicsCovered": [{"name": "K", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 25,
            "recommendedUse": "practice_after_lecture", "summary": "",
        },
    ]
    plan = _run_plan(llm_response, profiles)
    assert plan["possibleMatches"] == []


# ── unmapped-files reporting ──────────────────────────────────────────────────

def test_unmapped_files_reported_when_no_topics():
    """A profiled file with an empty topicsCovered list is reported in
    unmappedFiles (it can't participate in spaced repetition)."""
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [],
    }
    profiles = [
        {
            "documentId": "lec-1", "fileName": "Lec01.pdf", "documentRole": "lecture",
            "topicsCovered": [{"name": "Kinematics", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 40,
            "recommendedUse": "learn_first", "summary": "",
        },
        {
            "documentId": "orphan-1", "fileName": "Random.pdf", "documentRole": "other",
            "topicsCovered": [],  # NO topics → unmapped
            "prerequisites": [], "estimatedStudyMinutes": 30,
            "recommendedUse": "review", "summary": "",
        },
    ]
    plan = _run_plan(llm_response, profiles)
    unmapped_ids = [u["fileId"] for u in plan["unmappedFiles"]]
    assert "orphan-1" in unmapped_ids
    assert "lec-1" not in unmapped_ids
    orphan = next(u for u in plan["unmappedFiles"] if u["fileId"] == "orphan-1")
    assert orphan["fileName"] == "Random.pdf"
    assert orphan["courseId"] == "course-abc"
    assert orphan["reason"]


def test_unmapped_files_empty_when_all_mapped():
    llm_response = {
        "weekStartDate": _WEEK_START,
        "subjectAllocation": [],
        "tasks": [],
        "possibleMatches": [],
    }
    profiles = [
        {
            "documentId": "lec-1", "fileName": "Lec01.pdf", "documentRole": "lecture",
            "topicsCovered": [{"name": "Kinematics", "confidence": "high", "depth": "core"}],
            "prerequisites": [], "estimatedStudyMinutes": 40,
            "recommendedUse": "learn_first", "summary": "",
        },
    ]
    plan = _run_plan(llm_response, profiles)
    assert plan["unmappedFiles"] == []
