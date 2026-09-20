"""German Exam Engine exam profiles: one exam = one file, assembled by registry.py."""

from .registry import (
    GERMAN_EXAM_PROFILES,
    get_part,
    get_profile,
    list_parts,
    resolve_profile_id,
)
from .shared import ExamProfile, GermanExamProfileError, PartBlueprint, ScoringSpec

__all__ = [
    "GERMAN_EXAM_PROFILES",
    "ExamProfile",
    "GermanExamProfileError",
    "PartBlueprint",
    "ScoringSpec",
    "get_part",
    "get_profile",
    "list_parts",
    "resolve_profile_id",
]
