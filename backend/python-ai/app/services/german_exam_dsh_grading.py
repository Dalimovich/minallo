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
