"""Shared German Exam Engine — Schreiben (writing) SUBMISSION grading.

Deliberately separate from german_exam_writing.py (task GENERATION) and from
every other module's grading (which is objective right/wrong, computed
client-side by the frontend and merely persisted here). Writing has no
correct-answer key at all — a learner's free-text essay cannot be graded by
the same deterministic-validator + semantic-verifier pipeline used for
generated exercise content, and that pipeline is NEVER run against a
learner's own text (it exists to catch defects in AI-GENERATED objective
items, not to judge prose).

Architecture requirement: there must be exactly ONE underlying writing
evaluator, reused by both generic Writing Coach and this exam mode — never
two parallel grading engines. This module is a thin ADAPTER, not a second
grader: it calls the existing `writing_coach.analyse_writing()` with task context
and maps its 0-100 score axes onto the official telc Schreiben rubric
dimensions (Aufgabengerechtigkeit / Korrektheit / Repertoire / Kommunikative
Gestaltung), producing attempt rows `german_exam_performance.record_attempts()`
already knows how to persist (score_value/max_score_value populated,
first_attempt_correct/final_correct left null — see
german_exam_adaptation.py's docstring for how that feeds weakness
computation).
"""

from __future__ import annotations

from typing import Any

from .german_exams import PartBlueprint, ExamProfile
from .writing_coach import ALLOWED_TASK_TYPES, analyse_writing

# Maps each official telc Schreiben rubric dimension to (a) the
# writing_coach.analyse_writing() score axis it's derived from (None means
# "computed", see _communicative_design below) and (b) the writing-module
# skill tags a per-dimension attempt row carries — these must all be members
# of the schreiben_1 PartBlueprint's allowed_skill_tags (german_exams.py).
_RUBRIC_DIMENSIONS: dict[str, dict[str, Any]] = {
    "task_fulfilment": {"scoreKey": "taskFulfillment", "skillTags": ["task_fulfilment"]},
    "correctness": {"scoreKey": "grammar", "skillTags": ["grammar_accuracy", "orthography"]},
    "repertoire": {"scoreKey": "vocabulary", "skillTags": ["vocabulary_range"]},
    "communicative_design": {"scoreKey": None, "skillTags": ["coherence", "cohesion", "register", "sentence_variety", "argument_structure"]},
}


def _avg(*values: Any) -> float | None:
    present = [v for v in values if isinstance(v, (int, float))]
    return sum(present) / len(present) if present else None


# Maps a rubric dimension NAME (as used by any profile's `grading_dimensions`/
# `criteria_max_points`, e.g. Goethe's task_fulfilment/coherence/vocabulary/structures)
# onto the writing_coach.analyse_writing() score axis it derives from. None means
# "computed" (same avg(structure, style) telc's communicative_design already uses).
# Generic on purpose — adding a new profile with differently-named dimensions only
# needs an entry here, never a new grading function.
_DIMENSION_SCORE_KEYS: dict[str, str | None] = {
    "task_fulfilment": "taskFulfillment",
    "correctness": "grammar",
    "repertoire": "vocabulary",
    "vocabulary": "vocabulary",
    "structures": "grammar",
    "communicative_design": None,
    "coherence": None,
}

# Continuous analyse_writing() 0-100 score -> letter band, evenly spaced quintiles.
# NOT sourced from an official Goethe cut-point table (none is published for continuous
# AI scores) — an explicit, clearly-labeled approximation used only for exam profiles
# whose ScoringSpec declares `band_fractions` (Goethe); telc's existing continuous
# percentage-of-max scoring below is completely unaffected and still used whenever
# `band_fractions` is absent.
_BAND_THRESHOLDS: tuple[tuple[float, str], ...] = ((90, "A"), (75, "B"), (55, "C"), (35, "D"))


def _band_for_score(score: float) -> str:
    for threshold, band in _BAND_THRESHOLDS:
        if score >= threshold:
            return band
    return "E"


def _banded_rubric_score(part: PartBlueprint, dimension_scores: dict[str, float | None]) -> dict[str, Any] | None:
    """Goethe-style banded scoring: each dimension's continuous 0-100 score is
    rounded to a letter band (A..E), then scored as criteria_max_points[dim] *
    WRITING_BAND_FRACTIONS[band] — mirrors the official telc-adjacent 'only the
    printed point values are awarded' rule for the underlying exam. Returns None
    (caller falls back to the continuous percentage method) unless the part's
    ScoringSpec actually declares band_fractions + criteria_max_points."""
    scoring = part.scoring
    if not scoring or not scoring.band_fractions or not scoring.criteria_max_points:
        return None
    per_dimension: dict[str, dict[str, Any]] = {}
    total = 0.0
    for dim, max_points in scoring.criteria_max_points.items():
        value = dimension_scores.get(dim)
        if value is None:
            continue
        band = _band_for_score(value)
        fraction = scoring.band_fractions.get(band, 0.0)
        points = round(max_points * fraction, 1)
        total += points
        per_dimension[dim] = {"rawScore": value, "band": band, "maxPoints": max_points, "points": points}
    if len(per_dimension) != len(scoring.criteria_max_points):
        return None  # not every dimension had a signal — fall back rather than invent one
    return {
        "perDimension": per_dimension,
        "totalPoints": round(total, 1),
        "maxPoints": scoring.max_points,
        "scoringMethod": "banded_rubric_v1_approximate_cutpoints",
    }


def grade_writing_submission(
    *,
    user_id: str,
    profile: ExamProfile,
    part: PartBlueprint,
    generation_id: str | None,
    writing_coach_task_type: str,
    text: str,
    selected_topic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Grades a learner's Schreiben submission via the SAME evaluator generic
    Writing Coach uses, then maps the result onto the official rubric.
    Returns {analysis, rubric, examResultItems, scoreValue, maxScoreValue}
    — examResultItems is ready to forward verbatim as the `items` array of
    POST /german-exam/results (this module never writes attempts itself;
    see that endpoint's docstring for why attempt-persistence stays in one
    place). Never fabricates a correctness boolean or a score for a
    dimension analyse_writing() couldn't score (e.g. insufficientContext) —
    such a dimension is simply omitted from examResultItems rather than
    given an invented value."""
    task_type = writing_coach_task_type if writing_coach_task_type in ALLOWED_TASK_TYPES else "freier_text"
    profile_level = profile.variant or profile.cefr_level or "C1"

    analysis = analyse_writing(
        user_id=user_id,
        text=text,
        profile_level=profile_level,
        task_type=task_type,
        exam_context={
            "profileId": profile.profile_id,
            "profileVersion": profile.profile_version,
            "partId": part.part_id,
            "targetLevel": profile_level,
            "selectedTopic": selected_topic,
            "gradingDimensions": list(part.grading_dimensions or ()),
            "wordCountMin": part.constraints.get("wordCountMin") or part.constraints.get("wordCountApprox"),
        },
    )

    score = analysis.get("score") or {}
    # Dimension NAMES come from the profile's own blueprint (part.grading_dimensions) when it
    # declares them — e.g. Goethe's task_fulfilment/coherence/vocabulary/structures — falling back to
    # telc's fixed four for profiles that don't (keeps existing telc behaviour byte-for-byte unchanged).
    dims = part.grading_dimensions or tuple(_RUBRIC_DIMENSIONS)
    dimension_scores: dict[str, float | None] = {}
    dimension_skill_tags: dict[str, list[str]] = {}
    for dim in dims:
        spec = _RUBRIC_DIMENSIONS.get(dim)
        score_key = spec["scoreKey"] if spec else _DIMENSION_SCORE_KEYS.get(dim)
        dimension_scores[dim] = score.get(score_key) if score_key else _avg(score.get("structure"), score.get("style"))
        dimension_skill_tags[dim] = spec["skillTags"] if spec else [dim]

    banded = _banded_rubric_score(part, dimension_scores)
    max_points = part.scoring.max_points if part.scoring else 48
    if banded is not None:
        # Goethe-style banded scoring (see _banded_rubric_score) — points, not a 0-100 percentage.
        overall = _avg(*dimension_scores.values())
        exam_score_value = banded["totalPoints"]
        rubric = {
            **{dim: dimension_scores.get(dim) for dim in dims},
            "overall": overall,
            "examScoreValue": exam_score_value,
            "examMaxScoreValue": max_points,
            "banded": banded,
            "scoringMethod": banded["scoringMethod"],
        }
    else:
        # telc's original continuous-percentage method — unchanged.
        complete = all(isinstance(v, (int, float)) for v in dimension_scores.values())
        overall = _avg(*dimension_scores.values()) if complete else None
        exam_score_value = round(overall / 100 * max_points, 1) if overall is not None else None
        rubric = {
            "taskFulfilment": dimension_scores.get("task_fulfilment"),
            "correctness": dimension_scores.get("correctness"),
            "repertoire": dimension_scores.get("repertoire"),
            "communicativeDesign": dimension_scores.get("communicative_design"),
            "overall": overall,
            "examScoreValue": exam_score_value,
            "examMaxScoreValue": max_points,
            "scoringMethod": "writing_coach_dimension_mapping_v1",
        }

    exam_result_items: list[dict[str, Any]] = []
    for dim, dim_score in dimension_scores.items():
        if dim_score is None:
            continue  # analyse_writing() had no signal for this axis — never invent one.
        exam_result_items.append({
            "profileId": profile.profile_id,
            "profileVersion": profile.profile_version,
            "module": "writing",
            "partId": part.part_id,
            "taskType": part.task_type,
            "itemId": f"rubric_{dim}",
            "skillTags": dimension_skill_tags[dim],
            "difficulty": "c1",
            "attemptCount": 1,
            "firstAttemptCorrect": None,
            "finalCorrect": None,
            "hintLevel": None,
            "replayCount": None,
            "transcriptRevealed": None,
            "scoreValue": dim_score,
            "maxScoreValue": 100,
            "metadata": {"generationId": generation_id, "rubricDimension": dim,
                         "rubric": rubric, "selectedTopic": selected_topic},
            "generationId": generation_id,
        })

    return {
        "analysis": analysis,
        "rubric": rubric,
        "examResultItems": exam_result_items,
        "scoreValue": exam_score_value,
        "maxScoreValue": max_points,
    }
