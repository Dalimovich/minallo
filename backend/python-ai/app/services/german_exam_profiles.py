"""Shared German Exam Engine — profile registry.

One authoritative registry of exam profiles (family + variant), each
containing blueprints for every module (listening, reading, writing,
speaking, language_elements) that exam actually has. This is deliberately
NOT split per-module — Hören, Lesen, Schreiben etc. all read from the same
`GERMAN_EXAM_PROFILES` dict so there is exactly one place an exam's official
structure is defined.

A `constraints` field on a `PartBlueprint` is only ever an official hard rule
when a verified source confirms an exact value. Where a source only confirms
a minimum/range (e.g. telc C1 Hochschule Hören Teil 2's "zwei oder mehr
Menschen"), the constraint key says so explicitly (`speakerCountMin`, not
`speakerCount`) so the validator never enforces an invented exact count.

Phase 1 populates exactly one profile (`telc_c1_hochschule`) with exactly one
module (`listening`, all 3 parts). `reading`/`writing`/`speaking`/
`language_elements` are present as `None` — not implemented yet, not
invented placeholders.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScoringSpec:
    max_points: int
    points_per_correct: int  # generic; task-specific grading may override at scoring time


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


_TELC_C1_HOCHSCHULE_HOEREN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="hv1",
        module="listening",
        title="Globalverstehen",
        task_type="speaker_statement_matching",
        constraints={
            "speakerCount": 8,
            "statementCount": 10,
            "unusedStatements": 2,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "global_main_idea",
            "paraphrase_mapping",
            "speaker_matching",
            "speaker_intention",
            "speaker_opinion",
            "attitude_tone",
        ),
        allowed_adaptations=("paraphrase_distance", "opinion_explicitness", "inference_depth"),
        scoring=ScoringSpec(max_points=8, points_per_correct=1),
        approx_duration_seconds=480,  # ~ 8 min, per official material — audio length, not prep time
    ),
    PartBlueprint(
        part_id="hv2",
        module="listening",
        title="Detailverstehen",
        task_type="sentence_completion_mc3",
        # speakerCount is deliberately NOT a hard "2" — official material describes "zwei oder
        # mehr Menschen" (an interview/discussion), so only a minimum is an official constraint.
        constraints={
            "itemCount": 10,
            "optionCount": 3,
            "speakerCountMin": 2,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "detail_fact",
            "selective_information",
            "numbers_dates",
            "negation_contrast",
            "causal_relationship",
            "implicit_inference",
            "not_stated_distinction",
        ),
        allowed_adaptations=("distractor_proximity", "negation_density"),
        scoring=ScoringSpec(max_points=20, points_per_correct=2),
        approx_duration_seconds=540,  # ~ 9 min
    ),
    PartBlueprint(
        part_id="hv3",
        module="listening",
        title="Informationstransfer",
        task_type="structured_note_completion",
        constraints={
            "itemCount": 10,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "academic_structure",
            "note_taking",
            "detail_fact",
            "numbers_dates",
            "argument_structure",
            "summary_error_detection",
        ),
        allowed_adaptations=("signposting_explicitness", "hierarchy_depth"),
        scoring=ScoringSpec(max_points=20, points_per_correct=2),
        approx_duration_seconds=1200,  # ~ 20 min
    ),
)


# Lesen + Sprachbausteine officially share one 90-minute block; the learner
# may allocate that time freely across parts. This is UI/prep-guide copy,
# not an enforced per-part timer — see PartBlueprint.time_limit_seconds'
# docstring (reserved for future exam-simulation mode).
LESEN_SPRACHBAUSTEINE_SHARED_MINUTES = 90

_TELC_C1_HOCHSCHULE_LESEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="lesen_1",
        module="reading",
        title="Textrekonstruktion",
        task_type="text_reconstruction_sentence_matching",
        constraints={
            "gapCount": 6,
            "candidateCount": 8,
            "unusedCandidates": 2,
            "wordCountMin": 400,
            "wordCountMax": 500,
        },
        allowed_skill_tags=(
            "text_structure",
            "reference_resolution",
            "argument_structure",
            "paraphrase_mapping",
        ),
        allowed_adaptations=("reference_complexity", "distractor_similarity"),
        scoring=ScoringSpec(max_points=12, points_per_correct=2),
    ),
    PartBlueprint(
        part_id="lesen_2",
        module="reading",
        title="Selektives Verstehen",
        task_type="section_statement_matching",
        constraints={
            "sectionCount": 5,
            "statementCount": 6,
            "wordCountMin": 650,
            "wordCountMax": 850,
        },
        allowed_skill_tags=(
            "global_comprehension",
            "selective_information",
            "author_intention",
            "paraphrase_mapping",
            "inference",
            "argument_structure",
        ),
        allowed_adaptations=("paraphrase_distance", "inference_depth"),
        scoring=ScoringSpec(max_points=12, points_per_correct=2),
    ),
    PartBlueprint(
        part_id="lesen_3",
        module="reading",
        title="Detail- und Globalverstehen",
        task_type="detail_tristate_with_global_heading",
        constraints={
            "detailItemCount": 11,
            "globalHeadingItemCount": 1,  # exactly one heading-question item
            "globalHeadingOptionCount": 3,  # that item has exactly 3 heading options
            "wordCountMin": 1000,
            "wordCountMax": 1200,
        },
        allowed_skill_tags=(
            "detail_comprehension",
            "global_comprehension",
            "inference",
            "text_structure",
            "argument_structure",
        ),
        allowed_adaptations=("inference_depth", "argument_complexity", "author_intention_explicitness"),
        scoring=ScoringSpec(max_points=24, points_per_correct=2),
    ),
)


GERMAN_EXAM_PROFILES: dict[str, ExamProfile] = {
    "telc_c1_hochschule": ExamProfile(
        profile_id="telc_c1_hochschule",
        family="telc",
        variant="C1 Hochschule",
        cefr_level="C1",
        legacy_level_values=("C1 Hochschule",),
        source_name="telc Deutsch C1 Hochschule – Handbuch",
        source_reference="telc GmbH official model-test/handbook material for telc Deutsch C1 Hochschule",
        source_version="verified against current telc.net exam-format description",
        verified_at="2026-09-16",
        profile_version=2,
        modules={
            "listening": _TELC_C1_HOCHSCHULE_HOEREN,
            "reading": _TELC_C1_HOCHSCHULE_LESEN,
            "writing": None,
            "speaking": None,
            "language_elements": None,
        },
    ),
}


class GermanExamProfileError(Exception):
    pass


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
