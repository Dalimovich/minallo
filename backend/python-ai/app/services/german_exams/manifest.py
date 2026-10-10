"""Serializable exam-profile manifest: the single contract the frontend builds
the exam workspace from (modules, parts, timings, scoring summary). Derived
from the profile file, never a second copy of the structure."""

from __future__ import annotations

from typing import Any

from .shared import DeliveryPolicy, ExamProfile, ModuleSpec, PartBlueprint, ScoringSpec
from .task_types import is_task_type_implemented

MANIFEST_SCHEMA_VERSION = "german-exam-manifest-v1"

_DEFAULT_MODULE_LABELS = {
    "reading": "Lesen",
    "listening": "Hören",
    "language_elements": "Sprachbausteine",
    "writing": "Schreiben",
    "speaking": "Sprechen",
}


def _scoring(spec: ScoringSpec | None) -> dict[str, Any] | None:
    if spec is None:
        return None
    return {
        "mode": spec.resolved_mode,
        "maxPoints": spec.max_points,
        "passPoints": spec.pass_points,
        "pointsPerCorrect": spec.points_per_correct,
    }


def _part(part: PartBlueprint) -> dict[str, Any]:
    return {
        "id": part.part_id,
        "title": part.title,
        "taskType": part.task_type,
        "constraints": part.constraints,
        "scoring": _scoring(part.scoring),
        "gradingDimensions": list(part.grading_dimensions) if part.grading_dimensions else None,
        "implemented": bool(part.available and is_task_type_implemented(part.task_type)),
    }


def _delivery_policy(policy: DeliveryPolicy | None) -> dict[str, Any] | None:
    if policy is None:
        return None
    return {
        "fixedTaskOrder": policy.fixed_task_order,
        "backNavigationAllowed": policy.back_navigation_allowed,
        "additionalUnscoredTrialTasks": policy.additional_unscored_trial_tasks,
    }


def module_order(profile: ExamProfile) -> list[str]:
    ordered = [m for m in (profile.module_specs or {}) if profile.modules.get(m)]
    ordered += [m for m, parts in profile.modules.items() if parts and m not in ordered]
    return ordered


def build_manifest(profile: ExamProfile) -> dict[str, Any]:
    modules = []
    for module in module_order(profile):
        parts = profile.modules[module] or ()
        spec: ModuleSpec | None = (profile.module_specs or {}).get(module)
        entry = {
            "id": module,
            "label": spec.label if spec else _DEFAULT_MODULE_LABELS.get(module, module),
            "durationSeconds": spec.duration_seconds if spec else None,
            "preparationSeconds": spec.preparation_seconds if spec else None,
            "note": spec.note if spec else None,
            "scoring": _scoring(spec.scoring) if spec else None,
            "parts": [_part(p) for p in parts],
        }
        if spec and spec.code:
            entry["code"] = spec.code
        modules.append(entry)
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "profileId": profile.profile_id,
        "profileVersion": profile.profile_version,
        "displayName": profile.display_name or profile.profile_id,
        "family": profile.family,
        "variant": profile.variant,
        "cefrLevel": profile.cefr_level,
        "deliveryPolicy": _delivery_policy(profile.delivery_policy),
        "modules": modules,
    }
    if profile.result_model is not None:
        manifest["resultModel"] = profile.result_model
    if profile.presentation is not None:
        manifest["presentation"] = profile.presentation
    return manifest
