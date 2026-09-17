"""Shared German Exam Engine — module-dispatching generation orchestrator.

`generate_task()` is the single entrypoint every module (listening, reading,
writing, speaking, language_elements) goes through. It resolves the profile
and part blueprint, computes weakness + adaptation plan, picks a topic, then
dispatches to the module-specific adapter. `listening`, `reading`, and
`language_elements` have real adapters; `writing`/`speaking` still raise
NotImplementedError so a bad request fails loudly instead of silently
returning generic content.

The generator NEVER calls TTS — see german_exam_listening.py's module
docstring for why.
"""

from __future__ import annotations

import uuid
from typing import Any

from .german_exam_adaptation import build_adaptation_plan, compute_weakness, instruction_to_dict
from .german_exam_language_elements import generate_language_elements_part
from .german_exam_listening import generate_listening_part
from .german_exam_reading import generate_reading_part
from .german_exam_writing import generate_writing_part
from .german_exam_performance import pick_topic, record_topic_used
from .german_exam_profiles import ExamProfile, GermanExamProfileError, PartBlueprint, get_part, get_profile

# Placeholder topic banks per module.
# Topic is content flavor only; exam structure is untouched by topic choice.
_TOPIC_BANKS: dict[str, list[dict[str, str]]] = {
    "listening": [
        {"topicId": "digitalization_workplace", "label": "Digitalisierung der Arbeitswelt"},
        {"topicId": "urban_mobility", "label": "Stadtplanung und Mobilität"},
        {"topicId": "higher_education_policy", "label": "Hochschulpolitik"},
        {"topicId": "environment_sustainability", "label": "Umwelt und Nachhaltigkeit"},
        {"topicId": "psychology_learning", "label": "Lernpsychologie"},
        {"topicId": "research_innovation", "label": "Forschung und Innovation"},
        {"topicId": "culture_media", "label": "Kultur und Medien"},
        {"topicId": "economics_labour", "label": "Wirtschaft und Arbeitsmarkt"},
    ],
    "reading": [
        {"topicId": "academic_writing_skills", "label": "Wissenschaftliches Schreiben"},
        {"topicId": "university_admission_policy", "label": "Hochschulzulassung"},
        {"topicId": "research_ethics", "label": "Forschungsethik"},
        {"topicId": "digital_learning", "label": "Digitales Lernen"},
        {"topicId": "climate_and_society", "label": "Klimawandel und Gesellschaft"},
        {"topicId": "labour_market_trends", "label": "Trends auf dem Arbeitsmarkt"},
        {"topicId": "science_communication", "label": "Wissenschaftskommunikation"},
        {"topicId": "urban_development", "label": "Stadtentwicklung"},
    ],
    "language_elements": [
        {"topicId": "science_popularization", "label": "Populärwissenschaft"},
        {"topicId": "history_of_technology", "label": "Technikgeschichte"},
        {"topicId": "study_habits", "label": "Lern- und Studiengewohnheiten"},
        {"topicId": "media_literacy", "label": "Medienkompetenz"},
        {"topicId": "environmental_policy", "label": "Umweltpolitik"},
        {"topicId": "workplace_culture", "label": "Arbeitskultur"},
        {"topicId": "public_health", "label": "Öffentliche Gesundheit"},
        {"topicId": "cultural_exchange", "label": "Interkultureller Austausch"},
    ],
    "writing": [
        {"topicId": "student_life_balance", "label": "Studium und Freizeit"},
        {"topicId": "technology_in_education", "label": "Technologie im Studium"},
        {"topicId": "sustainability_on_campus", "label": "Nachhaltigkeit an der Hochschule"},
        {"topicId": "internationalization", "label": "Internationalisierung des Studiums"},
        {"topicId": "work_life_after_graduation", "label": "Berufseinstieg nach dem Studium"},
        {"topicId": "digital_communication", "label": "Digitale Kommunikation"},
        {"topicId": "lifelong_learning", "label": "Lebenslanges Lernen"},
        {"topicId": "social_responsibility", "label": "Gesellschaftliche Verantwortung"},
    ],
}


def _topic_bank(module: str, profile: ExamProfile) -> list[dict[str, str]]:
    del profile  # reserved for exam-specific topic curation later
    return _TOPIC_BANKS.get(module, [])


def _dispatch_module(module: str):
    if module == "listening":
        return _generate_listening
    if module == "reading":
        return _generate_reading
    if module == "language_elements":
        return _generate_language_elements
    if module == "writing":
        return _generate_writing
    if module == "speaking":
        raise NotImplementedError(f"module {module!r} is not implemented yet")
    raise GermanExamProfileError(f"unknown module: {module}")


def _generate_listening(profile: ExamProfile, part: PartBlueprint, plan, topic: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    return generate_listening_part(profile, part, plan, topic)


def _generate_reading(profile: ExamProfile, part: PartBlueprint, plan, topic: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    return generate_reading_part(profile, part, plan, topic)


def _generate_language_elements(profile: ExamProfile, part: PartBlueprint, plan, topic: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    return generate_language_elements_part(profile, part, plan, topic)


def _generate_writing(profile: ExamProfile, part: PartBlueprint, plan, topic: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    return generate_writing_part(profile, part, plan, topic)


def generate_task(
    user_id: str,
    profile_id: str,
    module: str,
    part_id: str,
    mode: str,
    topic_override: str | None = None,
    speculative: bool = False,
) -> dict[str, Any]:
    """`speculative=True` is for prefetch: the caller has generated content
    the learner has not necessarily seen yet, so this must NOT mark the
    chosen topic as used (that only happens once the frontend actually
    applies the result — see `POST /german-exam/consume`). A topic is still
    picked normally (still avoids recent repeats), just not recorded here."""
    profile = get_profile(profile_id)
    part = get_part(profile_id, module, part_id)

    if mode == "exam_simulation":
        # Reserved for a future phase — official blueprint only, no personalization.
        weakness = None
        plan = []
    else:
        weakness = compute_weakness(user_id, profile_id, module)
        plan = build_adaptation_plan(part, profile.variant, weakness)

    if topic_override:
        topic = {"topicId": "custom", "label": topic_override}
    else:
        candidates = _topic_bank(module, profile)
        topic = pick_topic(user_id, profile_id, module, part_id, candidates)

    generation_id = uuid.uuid4().hex

    adapter = _dispatch_module(module)
    content, validation_meta = adapter(profile, part, plan, topic)

    if not speculative:
        record_topic_used(user_id, profile_id, module, part_id, topic["topicId"], generation_id)

    return _envelope(profile, module, part, mode, plan, weakness, topic, content, validation_meta, generation_id)


def _envelope(
    profile: ExamProfile,
    module: str,
    part: PartBlueprint,
    mode: str,
    plan,
    weakness,
    topic: dict[str, str],
    content: dict[str, Any],
    validation_meta: dict[str, Any],
    generation_id: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": "german-exam-v1",
        "generationId": generation_id,
        "exam": {
            "family": profile.family,
            "variant": profile.variant,
            "cefrLevel": profile.cefr_level,
            "profileId": profile.profile_id,
            "profileVersion": profile.profile_version,
        },
        "module": module,
        "part": {
            "id": part.part_id,
            "title": part.title,
            "taskType": part.task_type,
            "approxDurationSeconds": part.approx_duration_seconds,
        },
        "mode": mode,
        "topic": topic,
        "adaptation": {
            "weaknessConfidence": weakness.overall_confidence if weakness else "cold_start",
            "instructionsApplied": [instruction_to_dict(i) for i in plan],
        },
        "content": content,
        "validation": validation_meta,
    }
