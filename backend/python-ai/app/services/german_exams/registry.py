"""German Exam Engine — profile registry.

Only assembles the per-exam profile files in this package and answers lookups.
No exam-specific structure belongs here: to add an exam, create its own
`<exam>.py` file and register it below.
"""

from __future__ import annotations

from .shared import ExamProfile, GermanExamProfileError, PartBlueprint
from .telc_c1_hochschule import TELC_C1_HOCHSCHULE

_ALL_PROFILES: tuple[ExamProfile, ...] = (TELC_C1_HOCHSCHULE,)

GERMAN_EXAM_PROFILES: dict[str, ExamProfile] = {p.profile_id: p for p in _ALL_PROFILES}


def get_profile(profile_id: str) -> ExamProfile:
    profile = GERMAN_EXAM_PROFILES.get(profile_id)
    if profile is None:
        raise GermanExamProfileError(f"unknown exam profile: {profile_id}")
    return profile


def list_parts(profile_id: str, module: str) -> tuple[PartBlueprint, ...]:
    profile = get_profile(profile_id)
    parts = profile.modules.get(module)
    if parts is None:
        raise GermanExamProfileError(f"module {module!r} is not implemented for profile {profile_id!r}")
    return parts


def get_part(profile_id: str, module: str, part_id: str) -> PartBlueprint:
    for part in list_parts(profile_id, module):
        if part.part_id == part_id:
            return part
    raise GermanExamProfileError(f"unknown part {part_id!r} for {profile_id!r}/{module!r}")


def resolve_profile_id(family: str, german_level: str) -> str | None:
    """Backward-compat resolution from the legacy `(german_test, german_level)`
    onboarding fields to a canonical profile id. Returns None when no
    unambiguous profile matches (caller falls back to static content)."""
    family_norm = (family or "").strip().lower()
    level_norm = (german_level or "").strip()
    matches = [
        p
        for p in GERMAN_EXAM_PROFILES.values()
        if p.family.lower() == family_norm and level_norm in p.legacy_level_values
    ]
    if len(matches) == 1:
        return matches[0].profile_id
    return None
