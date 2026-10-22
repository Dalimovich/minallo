"""Shared German Exam Engine — weakness computation and adaptation planning.

Two pure concerns, kept separate:

  compute_weakness()      — reads `german_exam_attempts` (I/O), turns raw
                             attempt rows into a per-skill-tag weakness score.
  build_adaptation_plan()  — pure function (no I/O): turns a WeaknessReport
                             into a structured instruction list, constrained
                             to the part blueprint's `allowed_adaptations` so
                             it can never ask for a different item count,
                             task type, or option count.

Correctness signal is three-way, not a flat is_correct boolean, for
OBJECTIVE (right/wrong) items:
  - unaided-first-try correct  (first_attempt_correct, hint_level=0,
    not transcript_revealed)         -> strongest positive signal
  - correct after assistance   (final_correct but hints/transcript/retries
    were used)                        -> partial credit
  - still incorrect after retry (not final_correct)  -> weakest signal
`replay_count` is a softer secondary signal layered on top.

PRODUCTIVE-skill items (writing/speaking) have no correctness at all —
first_attempt_correct and final_correct are always None for them (see
german_exam_writing_grading.py). For those rows, _attempt_score() falls back
to the rubric-derived score_value/max_score_value ratio instead of treating
"no boolean" as automatically wrong — this is the ONLY path by which a
productive-skill attempt feeds the same per-skill-tag weighted average an
objective item does, so weakness computation and build_adaptation_plan()
need no separate productive-skill code path at all.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..supabase_client import get_supabase

_MIN_ATTEMPTS_FOR_SIGNAL = 3
_RECENCY_HALF_LIFE_DAYS = 21.0


@dataclass
class TagWeakness:
    tag: str
    score: float  # 0.0 (very weak) .. 1.0 (strong) — higher is better
    n_attempts: int
    confidence: str  # "cold_start" | "low" | "medium" | "high"


@dataclass
class WeaknessReport:
    tags: dict[str, TagWeakness] = field(default_factory=dict)
    overall_confidence: str = "cold_start"

    def weakest(self, limit: int) -> list[TagWeakness]:
        eligible = [t for t in self.tags.values() if t.confidence != "cold_start"]
        return sorted(eligible, key=lambda t: t.score)[:limit]


@dataclass
class AdaptationInstruction:
    axis: str
    direction: str  # "increase" | "decrease"
    target_tags: list[str]


def _attempt_score(row: dict) -> float:
    """Per-attempt correctness score in [0, 1], richer than a boolean.

    A row with BOTH correctness fields null is a productive-skill (writing/
    speaking) attempt — score comes from its rubric-derived score_value/
    max_score_value ratio instead. A row with null correctness but no score
    info either (shouldn't happen once german_exam_writing_grading.py only
    ever submits items it has a real dimension score for) falls back to 0.0,
    the same conservative default an objective wrong answer gets."""
    if row.get("first_attempt_correct") is None and row.get("final_correct") is None:
        score_value = row.get("score_value")
        max_score_value = row.get("max_score_value")
        if isinstance(score_value, (int, float)) and isinstance(max_score_value, (int, float)) and max_score_value > 0:
            return max(0.0, min(1.0, score_value / max_score_value))
        return 0.0
    if row.get("first_attempt_correct") and row.get("hint_level", 0) == 0 and not row.get("transcript_revealed"):
        return 1.0
    if row.get("final_correct"):
        return 0.6  # correct after assistance — partial credit
    return 0.0  # still incorrect after retry


def _recency_weight(attempted_at: str | None) -> float:
    if not attempted_at:
        return 1.0
    try:
        ts = datetime.fromisoformat(attempted_at.replace("Z", "+00:00"))
    except ValueError:
        return 1.0
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0)
    return math.pow(0.5, age_days / _RECENCY_HALF_LIFE_DAYS)


def _confidence_for(n_attempts: int) -> str:
    if n_attempts < _MIN_ATTEMPTS_FOR_SIGNAL:
        return "cold_start"
    if n_attempts < 6:
        return "low"
    if n_attempts < 12:
        return "medium"
    return "high"


def compute_weakness(user_id: str, profile_id: str, module: str) -> WeaknessReport:
    sb = get_supabase()
    resp = (
        sb.table("german_exam_attempts")
        .select(
            "skill_tags, first_attempt_correct, final_correct, hint_level, replay_count, "
            "transcript_revealed, attempted_at, score_value, max_score_value"
        )
        .eq("user_id", user_id)
        .eq("profile_id", profile_id)
        .eq("module", module)
        .order("attempted_at", desc=True)
        .limit(500)
        .execute()
    )
    rows = resp.data or []

    per_tag_weighted: dict[str, float] = {}
    per_tag_weight_sum: dict[str, float] = {}
    per_tag_count: dict[str, int] = {}

    for row in rows:
        weight = _recency_weight(row.get("attempted_at"))
        score = _attempt_score(row)
        # Softer secondary signal: excessive replay slightly discounts the score,
        # a single replay is normal listening behaviour and not penalised.
        replay = row.get("replay_count") or 0
        if replay > 1:
            score = max(0.0, score - 0.05 * min(replay - 1, 4))
        for tag in row.get("skill_tags") or []:
            per_tag_weighted[tag] = per_tag_weighted.get(tag, 0.0) + score * weight
            per_tag_weight_sum[tag] = per_tag_weight_sum.get(tag, 0.0) + weight
            per_tag_count[tag] = per_tag_count.get(tag, 0) + 1

    report = WeaknessReport()
    for tag, weighted_sum in per_tag_weighted.items():
        n = per_tag_count[tag]
        denom = per_tag_weight_sum[tag] or 1.0
        report.tags[tag] = TagWeakness(
            tag=tag,
            score=weighted_sum / denom,
            n_attempts=n,
            confidence=_confidence_for(n),
        )

    if not report.tags:
        report.overall_confidence = "cold_start"
    else:
        confidences = [t.confidence for t in report.tags.values()]
        if any(c == "high" for c in confidences):
            report.overall_confidence = "high"
        elif any(c == "medium" for c in confidences):
            report.overall_confidence = "medium"
        elif any(c == "low" for c in confidences):
            report.overall_confidence = "low"
        else:
            report.overall_confidence = "cold_start"
    return report


# Maps an adaptation axis to the direction that targets weakness (i.e. makes
# the skill harder to avoid, not easier) — the planner only ever emits the
# "make it harder on the weak skill" direction, never the reverse.
_WEAKNESS_DIRECTION: dict[str, str] = {
    "paraphrase_distance": "increase",
    "opinion_explicitness": "decrease",  # less explicit opinion cues = harder for speaker_opinion weakness
    "inference_depth": "increase",
    "distractor_proximity": "increase",
    "negation_density": "increase",
    "signposting_explicitness": "decrease",
    "hierarchy_depth": "increase",
    "reference_complexity": "increase",
    "distractor_similarity": "increase",
    "argument_complexity": "increase",
    "author_intention_explicitness": "decrease",  # less explicit intention cues = harder for author_intention weakness
    "lexical_specificity": "increase",
    "grammar_complexity": "increase",
    "register_challenge": "increase",
    "cohesion_demand": "increase",
    "task_fulfilment_complexity": "increase",
    "required_spontaneity": "increase",
    "counterargument_pressure": "increase",
    "followup_complexity": "increase",
}

# Which skill tags each adaptation axis is meant to exercise, so the planner
# can pick axes whose target tags overlap the part's weak tags.
_AXIS_TARGET_TAGS: dict[str, tuple[str, ...]] = {
    "paraphrase_distance": ("paraphrase_mapping", "speaker_matching"),
    "opinion_explicitness": ("speaker_opinion", "attitude_tone"),
    "inference_depth": ("implicit_inference", "inference"),
    "distractor_proximity": ("detail_fact", "negation_contrast"),
    "negation_density": ("negation_contrast",),
    "signposting_explicitness": ("academic_structure",),
    "hierarchy_depth": ("note_taking", "argument_structure"),
    "reference_complexity": ("reference_resolution",),
    "distractor_similarity": ("argument_structure", "text_structure"),
    "argument_complexity": ("argument_structure", "argumentation"),
    "author_intention_explicitness": ("author_intention",),
    "lexical_specificity": ("collocation", "lexical_choice", "word_formation"),
    "grammar_complexity": ("grammar", "syntax", "prepositions", "connectors"),
    "register_challenge": ("register",),
    "cohesion_demand": ("cohesion", "coherence"),
    "task_fulfilment_complexity": ("task_fulfilment",),
    "required_spontaneity": ("fluency", "interaction"),
    "counterargument_pressure": ("response_to_partner", "argumentation"),
    "followup_complexity": ("interaction", "response_to_partner", "task_fulfilment"),
}

_TOP_WEAK_TAG_LIMIT = 3


def build_adaptation_plan(
    part_blueprint, target_level: str | None, weakness_report: WeaknessReport
) -> list[AdaptationInstruction]:
    """Pure function — no I/O. Only ever emits instructions whose `axis` is a
    member of `part_blueprint.allowed_adaptations`, so the planner cannot
    structurally affect item count, task type, or option count. Cold start
    (no attempts, or every tag below the attempt threshold) yields an empty
    plan — balanced generation, no invented weaknesses."""
    del target_level  # reserved for future level-aware phrasing of the same axes

    weakest = weakness_report.weakest(_TOP_WEAK_TAG_LIMIT)
    if not weakest:
        return []

    weak_tag_names = {t.tag for t in weakest}
    instructions: list[AdaptationInstruction] = []
    for axis in part_blueprint.allowed_adaptations:
        axis_tags = set(_AXIS_TARGET_TAGS.get(axis, ()))
        overlap = sorted(axis_tags & weak_tag_names)
        if not overlap:
            continue
        direction = _WEAKNESS_DIRECTION.get(axis, "increase")
        instructions.append(AdaptationInstruction(axis=axis, direction=direction, target_tags=overlap))

    return instructions


def instruction_to_dict(instr: AdaptationInstruction) -> dict:
    return {"axis": instr.axis, "direction": instr.direction, "targetTags": instr.target_tags}
