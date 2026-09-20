"""German Exam Engine exam profiles: one exam = one file, assembled by registry.py."""

from .registry import (
    GERMAN_EXAM_PROFILES,
    get_part,
    get_profile,
    list_parts,
    resolve_profile_id,
)
from .manifest import build_manifest
from .shared import ExamProfile, GermanExamProfileError, ModuleSpec, PartBlueprint, ScoringSpec

__all__ = [
    "GERMAN_EXAM_PROFILES",
    "ExamProfile",
    "GermanExamProfileError",
    "ModuleSpec",
    "PartBlueprint",
    "ScoringSpec",
    "build_manifest",
    "get_part",
    "get_profile",
    "list_parts",
    "resolve_profile_id",
]
