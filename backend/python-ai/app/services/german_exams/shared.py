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


# ScoringSpec.mode values.
SCORING_FIXED_PER_ITEM = "fixed_per_item"  # points = raw_correct * points_per_correct
SCORING_LOOKUP_TABLE = "lookup_table"  # points = official raw -> result table (no arithmetic)
SCORING_RUBRIC = "rubric"  # productive skills, graded against criteria


@dataclass(frozen=True)
class ScoringSpec:
    """How a part or module is scored. Backward compatible: the original
    two-field form `ScoringSpec(max_points=..., points_per_correct=...)` still
    means fixed-per-item (or rubric when points_per_correct is None), so
    every existing exam profile is unchanged."""

    max_points: int
    points_per_correct: int | None = None  # None for productive skills / lookup tables
    mode: str | None = None  # None -> derived from points_per_correct (see resolved_mode)
    pass_points: int | None = None
    # lookup_table only: index = number of raw items correct, value = official result points.
    raw_item_count: int | None = None
    raw_to_result_points: tuple[int, ...] | None = None
    # rubric only: official max points per criterion / band fractions (A..E), when verified.
    criteria_max_points: dict[str, int] | None = None
    band_fractions: dict[str, float] | None = None

    @property
    def resolved_mode(self) -> str:
        if self.mode is not None:
            return self.mode
        return SCORING_FIXED_PER_ITEM if self.points_per_correct is not None else SCORING_RUBRIC

    def __post_init__(self) -> None:
        if self.resolved_mode != SCORING_LOOKUP_TABLE:
            return
        table = self.raw_to_result_points
        if self.raw_item_count is None or table is None:
            raise ValueError("lookup_table scoring needs raw_item_count and raw_to_result_points")
        if len(table) != self.raw_item_count + 1:
            raise ValueError("raw_to_result_points must have one entry per raw score 0..raw_item_count")
        if table[0] != 0 or table[-1] != self.max_points:
            raise ValueError("lookup table must map 0 -> 0 and raw_item_count -> max_points")
        if any(b < a for a, b in zip(table, table[1:])):
            raise ValueError("lookup table must be non-decreasing")
        if self.points_per_correct is not None:
            raise ValueError("lookup_table scoring must not also set points_per_correct")


@dataclass(frozen=True)
class DeliveryPolicy:
    """How a full-exam simulation must be delivered — engine concepts, driven entirely by
    each profile's own facts. None of these are invented here: a profile that sets one sets
    it from its own verified source (see e.g. testdaf_digital.py's DELIVERY_METADATA)."""

    fixed_task_order: bool = False
    back_navigation_allowed: bool = True
    # True when the official exam includes additional trial tasks that are NOT scored and
    # NOT reproduced by this implementation — a full-exam simulation only ever covers the
    # scored core described by `modules`, never fabricates the trial tasks themselves.
    additional_unscored_trial_tasks: bool = False


@dataclass(frozen=True)
class ModuleSpec:
    """Module-level facts (label, timing, module scoring) that are not a
    property of any single part. Optional per module: a module without a
    ModuleSpec falls back to the default label and no timing."""

    label: str  # learner-facing module name, e.g. "Lesen"
    duration_seconds: int | None = None  # official module duration, when verified
    preparation_seconds: int | None = None  # official preparation time (speaking), when verified
    scoring: ScoringSpec | None = None  # module-level scoring (e.g. raw->100 lookup), when verified
    note: str | None = None


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
    # False while the part is part of the official exam structure but Minallo cannot generate
    # it yet: it shows in the exam navigation, generation fails cleanly (501), and it is never
    # served by another exam's implementation. Flip to True in the exam's own profile file.
    # Fail closed: a part is unavailable unless its profile explicitly opts in after qualification.
    available: bool = False


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
    # Learner-facing exam name (e.g. "Goethe-Zertifikat C1") and per-module facts.
    # The ORDER of module_specs is the order the exam navigation shows modules in;
    # modules without a spec follow in `modules` order.
    display_name: str | None = None
    module_specs: dict[str, ModuleSpec] | None = None
    # module -> topic candidates ({"topicId", "label"}). Topics change content flavour only, never
    # structure. None -> the engine's default topic banks (currently telc-oriented).
    topic_banks: dict[str, tuple[dict[str, str], ...]] | None = None
    # Full-exam-simulation delivery rules; None means "free navigation, no module timer" —
    # unchanged behaviour for every profile that has not opted into a timed simulation.
    delivery_policy: DeliveryPolicy | None = None

