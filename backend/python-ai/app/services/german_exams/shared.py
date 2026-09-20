"""Generic German Exam Engine types shared by every exam profile.

These are engine concepts, not exam facts: an exam's own structure lives in
its dedicated profile file (one exam = one file) in this package. Nothing exam
specific belongs here.

A `constraints` field on a `PartBlueprint` is only ever an official hard rule
when a verified source confirms an exact value. Where a source only confirms
a minimum/range, the constraint key says so explicitly (`speakerCountMin`, not
`speakerCount`) so the validator never enforces an invented exact count.
"""

from __future__ import annotations

from dataclasses import dataclass


class GermanExamProfileError(Exception):
    pass


@dataclass(frozen=True)
class ScoringSpec:
    max_points: int
    points_per_correct: int | None  # None for productive skills


@dataclass(frozen=True)
class PartBlueprint:
    part_id: str  # "hv1" — unique within (profile, module)
    module: str  # "listening" | "reading" | "writing" | "speaking" | "language_elements"
    title: str  # "Globalverstehen"
    task_type: str  # dispatch key for validator/generator/frontend-renderer — NOT exam-specific
    constraints: dict  # verified-official fields only; unconfirmed values are "min"/"preferred" hints
    allowed_skill_tags: tuple[str, ...]
    allowed_adaptations: tuple[str, ...]  # axes the adaptation planner may target for this part
    scoring: ScoringSpec | None = None  # official point value, once verified; None if unverified
    grading_dimensions: tuple[str, ...] | None = None  # writing/speaking only
    approx_duration_seconds: int | None = None  # audio/part length per official material — NOT prep time
    time_limit_seconds: int | None = None  # reserved for future exam-simulation mode, unused in Phase 1


@dataclass(frozen=True)
class ExamProfile:
    profile_id: str  # "telc_c1_hochschule" — stable internal id, never displayed
    family: str  # "telc"
    variant: str | None  # "C1 Hochschule" — the exam's own variant label, distinct from CEFR
    cefr_level: str | None  # "C1" — true CEFR level; None where the exam has no single CEFR equivalent
    legacy_level_values: tuple[str, ...]  # exact onboarding german_level string(s) this profile matches
    source_name: str
    source_reference: str  # citation/URL for the verified official material
    source_version: str  # edition/printing identifier of that material
    verified_at: str  # ISO date this profile's structure was last checked against source_reference
    profile_version: int  # bump on any structural change
    modules: dict[str, tuple[PartBlueprint, ...] | None]  # module -> parts, or None if not yet implemented

