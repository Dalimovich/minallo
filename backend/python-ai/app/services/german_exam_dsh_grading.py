"""DSH HV/LV learner-answer grading — the first real consumer of
dsh_content_model.score_content_item with an actual learner answer, not a
referenceAnswer/errorfulVariant fixture.

Deliberately NOT german_exams/dsh_qualification.py's qualify_open_tasks(): that function
audits GENERATED CONTENT quality (is the reference answer well-formed, does an empty answer
score 0 under the matcher, are language errors ignored) via an injected content_matcher — it
never sees a real learner's own answer and never will. This module answers a different
question: "does THIS learner answer satisfy the intended content requirement?" Both consumers
share the exact same contracts on purpose (dsh_qualification.ContentMatcher,
dsh_content_model.score_content_item/OpenAnswerItem/ContentPoint) because those contracts are
already proven, provider-agnostic, and exam-specific-assumption-free — reusing them here is not
a new scoring model, only a new caller.

llm_content_matcher() below is the first REAL (LLM-backed) implementation of ContentMatcher.
Every other content_matcher in this repository (tests/dsh_golden_content.py's fakes,
test_german_exam_dsh_offline_qualification.py's keyword_matcher/lenient_matcher/etc.) is a
scripted stand-in used to prove the qualification gates' own logic; none of them, and nothing
else anywhere in this codebase, has ever called a model to decide which content points an
answer covers. This is genuinely new capability, not a rewiring of something that already
worked — see this module's own tests for the mocked-vs-live distinction (no OpenAI credentials
are available in this environment, so none of this has been executed against a real model).

Scope boundary (see grade_dsh_open_answer_part's own docstring): this module stops at RAW,
within-part point totals. It does NOT convert those into dsh.WRITTEN_MAX_POINTS' official
200/200/100/200 scale, and nothing here calls german_exams.dsh_result. No official or
secondary source in this repository establishes how a raw item/content-point total for one
HV or LV text converts into that scale (only the OVERALL §5(3) HV:LV:WS:TP=2:2:1:2 ratio and
the §5(6) 57/67/82% thresholds are sourced) — inventing that conversion here would be exactly
the kind of invented per-question weighting this phase was told not to introduce.

CONFIRMED, not merely assumed (dedicated evidence phase, re-fetched the cited source directly
rather than trusting the repository's own earlier summary of it): the MPO's own text is entirely
percentage-based ("mindestens 57 % der gestellten Anforderungen" — a share of requirements met,
weighted 2:2:1:2) and never mentions a point total at all; "200/200/100/200 = 700" is Uni
Duisburg-Essen's own institutional grading convention (dsh.py's SECONDARY label), and that page
states only each component's MAXIMUM and the point-equivalents of the 57/67/82 % thresholds
against the 700 total (399/469/574 — pure arithmetic of percent * 700, already covered by
dsh_result.py's own boundary tests) — it does not state how many raw points the underlying
HV/LV sub-tests actually have, nor any formula for converting a raw score into the 200 figure.
No source anywhere converts a raw, per-generation-variable item/content-point total (which is
what grade_dsh_open_answer_part produces, since different generations have different numbers of
items) into that or any fixed scale. The conclusion is CONVERSION NOT ESTABLISHED, not CODE GAP:
the missing piece is authoritative evidence, not an unwritten function.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from fractions import Fraction
from typing import Any

from ..config import get_settings
from .german_exams.dsh_content_model import (
    ContentPoint,
    OpenAnswerItem,
    open_answer_item_from_generated,
    score_content_item,
)
from .german_exams.dsh_qualification import ContentMatcher
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_MATCHER_ATTEMPTS = 3


class DshGradingError(Exception):
    pass


def _content_matcher_prompt(question: str, answer: str, points: Sequence[ContentPoint]) -> tuple[str, str]:
    system = (
        "You are grading a German-language exam answer on CONTENT ONLY. Decide which of the "
        "listed content points the answer expresses in substance, regardless of grammar, "
        "spelling, word order, or style — never penalise or reward language quality here. A "
        "content point counts as covered if the answer conveys that idea, including via any "
        "listed accepted alternative phrasing or an equivalent paraphrase. An empty, irrelevant, "
        "or off-topic answer covers no content point. Always respond in the required JSON shape."
    )
    points_block = "\n".join(
        f'- id="{p.point_id}": {p.description}'
        + (f" (accepted alternatives: {'; '.join(p.alternatives)})" if p.alternatives else "")
        for p in points
    )
    user = (
        f"Question: {question}\n\n"
        f"Learner answer:\n{answer or '(empty)'}\n\n"
        f"Content points:\n{points_block}\n\n"
        'Return JSON: {"matchedPointIds": ["<id>", ...]} — only ids from the list above, '
        "only ids the answer actually, substantively covers."
    )
    return system, user


def llm_content_matcher(
    question: str, answer: str, points: Sequence[ContentPoint], *, provider: Any = None,
) -> set[str]:
    """Real implementation of dsh_qualification.ContentMatcher's contract:
    Callable[[str, str, Sequence[ContentPoint]], set[str]]. NEVER used by
    qualify_open_tasks/qualify_lv_ws/qualify_tp (those stay provider-agnostic and are exercised
    only against scripted fakes) — this is the grading-time matcher a real learner answer reaches.

    Filters its own output against the known point ids before returning: a hallucinated id would
    otherwise make score_content_item raise DshContentError and fail a learner's whole grading
    request over a model glitch, which is worse than silently treating an unrecognised id as "not
    matched"."""
    known_ids = {p.point_id for p in points}
    if not known_ids:
        return set()
    call = provider or chat_json
    system, user = _content_matcher_prompt(question, answer, points)
    last_error = "no attempt made"
    for attempt in range(_MAX_MATCHER_ATTEMPTS):
        result = call(system=system, user=user, model=get_settings().german_exam_model, max_tokens=500)
        raw = result.data if isinstance(result.data, dict) else None
        matched = raw.get("matchedPointIds") if isinstance(raw, dict) else None
        if isinstance(matched, list) and all(isinstance(m, str) for m in matched):
            return {m for m in matched if m in known_ids}
        last_error = f"attempt {attempt + 1}: malformed matcher response {raw!r}"
        log.warning("llm_content_matcher: %s", last_error)
    raise DshGradingError(f"content matcher failed to return a usable response: {last_error}")


def grade_dsh_open_answer_item(
    item: OpenAnswerItem, learner_answer: str, *, matcher: ContentMatcher | None = None,
) -> dict[str, Any]:
    """The one learner-answer grading entry point for a single HV/LV item. Pure composition of
    already-proven pieces (score_content_item + a ContentMatcher) — no new scoring model."""
    match = matcher or llm_content_matcher
    all_points = item.required_points + item.optional_points
    matched_ids = match(item.question, learner_answer or "", all_points)
    points = score_content_item(item, matched_ids)
    return {
        "itemId": item.item_id,
        "points": points,
        "maxPoints": item.max_points,
        "matchedPointIds": sorted(matched_ids),
    }


def grade_dsh_open_answer_part(
    content: Mapping[str, Any], learner_answers: Mapping[str, str], *, matcher: ContentMatcher | None = None,
) -> dict[str, Any]:
    """Grades every item in one already-generated HV/LV `content` dict (the exact shape
    generate_dsh_hv_part/generate_dsh_lv_part produce) against the given per-item learner
    answers. Raises DshContentError via open_answer_item_from_generated if `content` is
    malformed (e.g. an item missing requiredPoints) — the same validation every generator
    already relies on, not a new check.

    Returns RAW, within-part totals ONLY (see module docstring for why the official DSH
    200-point scale is deliberately not produced here)."""
    items: list[dict[str, Any]] = []
    for task in content.get("tasks") or ():
        for raw in task.get("items") or ():
            item = open_answer_item_from_generated(raw["itemId"], task["form"], raw)
            items.append(grade_dsh_open_answer_item(item, learner_answers.get(item.item_id, ""), matcher=matcher))
    raw_total = sum((i["points"] for i in items), Fraction(0))
    raw_max = sum((i["maxPoints"] for i in items), Fraction(0))
    return {
        "kind": "dsh_open_answer_part_raw_result",
        "items": items,
        "rawPoints": raw_total,
        "rawMaxPoints": raw_max,
        "percent": round(float(raw_total * 100 / raw_max), 2) if raw_max else None,
        # Deliberately not dsh.WRITTEN_MAX_POINTS-scaled — see module docstring.
        "officialScale": None,
    }


# ---- Answer-key protection (what a learner-facing payload may contain) -----------------------
_LEARNER_SAFE_ITEM_KEYS = ("itemId", "question")


def strip_answer_key_for_learner(content: Mapping[str, Any]) -> dict[str, Any]:
    """Returns a copy of generated HV/LV content (german_exam_dsh_generators.py's own output
    shape) with every answer-key field removed from every item: requiredPoints, optionalPoints,
    referenceAnswer, errorfulVariant, gradingNotes. Only itemId/question survive per item; the
    lecture/source text is kept as-is (it is the task's source material, not an answer key).

    Why this exists: generate_dsh_lv_part/generate_dsh_hv_part's raw output — the exact dict
    german_exam_generator.py's _envelope() would otherwise embed verbatim into a learner-facing
    response — carries requiredPoints[].description and referenceAnswer on every item, i.e. the
    literal graded answer. This is what app/routers/german_exam.py's dsh_lv_hv_generate_endpoint
    returns as `content`.

    RESOLVED (as of app/services/german_exam_dsh_practice_state.py): the earlier version of this
    docstring recorded that the full answer key still reached the browser via a `gradingContent`
    field in the same response, because nothing held it server-side between generate and grade.
    That gap is closed — the full content (via minimal_grading_content() below) is now written to
    public.dsh_lv_hv_practice_generations at generate time and claimed back server-side at grade
    time (german_exam_dsh_practice_state.claim_generation_for_grading); the browser receives only
    this function's output, under `content`, plus an opaque `generationId` it cannot forge its way
    around (ownership + expiry + one-time-use are enforced by that module's atomic claim). Nothing
    answer-key-shaped is ever sent to or held by the browser for this flow now."""
    stripped_tasks = []
    for task in content.get("tasks") or ():
        stripped_items = [
            {key: item[key] for key in _LEARNER_SAFE_ITEM_KEYS if key in item}
            for item in task.get("items") or ()
            if isinstance(item, Mapping)
        ]
        stripped_tasks.append({**{k: v for k, v in task.items() if k != "items"}, "items": stripped_items})
    return {**{k: v for k, v in content.items() if k != "tasks"}, "tasks": stripped_tasks}


# ---- Server-side grading state (what gets stored, never sent to the browser) ------------------
_GRADING_ESSENTIAL_ITEM_KEYS = ("itemId", "question", "maxPoints", "requiredPoints", "optionalPoints", "gradingNotes", "assessLanguage")


def minimal_grading_content(content: Mapping[str, Any]) -> dict[str, Any]:
    """Returns a copy of generated HV/LV content holding ONLY what grading actually consumes —
    the inverse selection to strip_answer_key_for_learner: per item, question/maxPoints/
    requiredPoints/optionalPoints/gradingNotes/assessLanguage survive (exactly the keys
    open_answer_item_from_generated reads); referenceAnswer and errorfulVariant do NOT (confirmed
    by reading open_answer_item_from_generated/grade_dsh_open_answer_item: neither is ever read
    during grading — they exist only for generate_dsh_lv_part/generate_dsh_hv_part's own
    generation-quality audit, qualify_open_tasks). The lecture/source text and sourceId are also
    dropped: grade_dsh_open_answer_part never reads content['source']/['lectureText']/['sourceId']
    either — the ContentMatcher is given question+answer+points, never the source text.

    This, not the full generated content, is what app/services/german_exam_dsh_practice_state.
    create_generation() persists — the smallest payload that can still reach score_content_item
    with everything it needs and nothing it doesn't."""
    tasks = []
    for task in content.get("tasks") or ():
        items = [
            {key: item[key] for key in _GRADING_ESSENTIAL_ITEM_KEYS if key in item}
            for item in task.get("items") or ()
            if isinstance(item, Mapping)
        ]
        tasks.append({"form": task.get("form"), "items": items})
    return {"tasks": tasks}
