"""DSH content generators — one per Teilprüfung, each bound to the official task contract already
established in german_exams/dsh.py and german_exams/dsh_content_model.py.

Every generator follows the same five explicit stages (never merged, never skipped):
  1. GENERATION      — one chat_json call, prompted from the part's own OFFICIAL constraints only.
  2. STRUCTURAL VALIDATION — dsh_content_model's existing validate_*_content() (shape, length,
     official task forms/input kinds) PLUS open_answer_item_from_generated() per item (the
     deeper per-item rules: duplicate point ids, non-positive points, points vs max_points).
  3. SEMANTIC/CONTENT VALIDATION — an INDEPENDENT second chat_json call that re-checks
     answerability/ambiguity/no-outside-knowledge against the text alone, never trusting the
     first call's own content points as ground truth (mirrors german_exam_media_tasks.py's own
     generate-then-independently-audit shape).
  4. REPAIR — bounded full-regeneration only (no targeted per-item repair yet): simpler, and this
     is a first build with no live qualification data yet showing targeted repair is needed (the
     same reasoning Sprachbausteine's repair started from before it grew more targeted).
  5. ACCEPT / REJECT — raises DshGenerationError rather than ever returning content that failed
     either validation stage once the regeneration budget is exhausted.

Why NOT german_exam_validator.py's validate_content()/hard_issues()/repair_items_semantic()
pipeline every other module uses: those return list[ValidationIssue] for a flat content["questions"]
shape; dsh_content_model's validators raise DshContentError for a nested content["tasks"][].items[]
shape instead — an intentional, already-tested, audit-approved contract (see
audit/dsh/IMPLEMENTATION_AUDIT.md's R-table) that this module does not change. Retrofitting either
side to match the other would rewrite tested code just to force a shared pipeline; using
dsh_content_model's own validators directly, with one consistent repair/audit shape across every
DSH generator, satisfies "don't build five independent validation frameworks" without that rewrite.

Availability is untouched by this module: nothing here ever sets a part's `available`. A
generator succeeding is necessary, not sufficient, for availability — see each part's own
PartBlueprint and the frozen availability-allowlist test.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from ..config import get_settings
from .german_exam_adaptation import AdaptationInstruction
from .german_exams import ExamProfile, PartBlueprint
from .german_exams.dsh_content_model import (
    DshContentError,
    open_answer_item_from_generated,
    validate_lv_content,
)
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_REGENERATIONS = 2


class DshGenerationError(Exception):
    pass


# ---- LV (Leseverstehen) ---------------------------------------------------------------------
# DECISION (not an official count — the MPO states none): 8 "questions"-form items is a
# reasonable density for a 4,500-6,000 character text, matching the item density this engine
# already uses for similarly-sized texts elsewhere (e.g. TestDaF's reading_detail_mc3).
_LV_ITEM_COUNT = 8

_LV_GENERATION_SHAPE = {
    "sourceId": "<a short stable id, e.g. a slug>",
    "source": {"text": f"ORIGINAL German academic text, {{min}}-{{max}} characters with spaces"},
    "tasks": [{
        "form": "questions",
        "items": [{
            "itemId": "q1", "question": "an open comprehension question answerable from the text alone",
            "requiredPoints": [{"pointId": "p1", "description": "one idea the answer must contain, in your own words", "points": 1}],
            "gradingNotes": "optional note for a future human/AI grader",
        }],
    }],
}


def _lv_generation_prompt(part: PartBlueprint, topic: dict[str, str]) -> tuple[str, str]:
    c = part.constraints
    shape = json.dumps(_LV_GENERATION_SHAPE, ensure_ascii=False)
    system = (
        "Generate ONE DSH (Deutsche Sprachprüfung für den Hochschulzugang) Leseverstehen (LV) "
        "reading-comprehension task in German, for the official 'questions' task form.\n\n"
        f"The text must be ORIGINAL, {c['textCharsMin']}-{c['textCharsMax']} characters including "
        f"spaces, and {c['textCharacter'].replace('_', ' ')}. It must require NO specialist "
        "knowledge beyond general academic literacy — a non-specialist, academically literate "
        "reader must be able to understand it from the text alone.\n\n"
        f"Produce exactly {_LV_ITEM_COUNT} open comprehension questions (task form \"questions\"). "
        "Each question must be answerable from the text ALONE, with exactly ONE defensible reading "
        "— never ambiguous, never requiring information the text does not state, never answerable "
        "from outside/world knowledge instead of the text. For each question, give the required "
        "content point(s) a correct answer must contain (as idea descriptions, NOT exact quotes — "
        "content-level paraphrase is fine; these are graded on content only, never on language). "
        "A question may have one required point (worth 1-2 points) or two (each worth 1 point, "
        "summing to the question's max — but do not set maxPoints explicitly, it is derived from "
        "the points you give).\n\n"
        f"Topic: {topic.get('label', '')}. Never mention being an AI or that this is a generated "
        "exercise within the text itself.\n\n"
        f"Return JSON only, in exactly this shape: {shape}"
    )
    user = json.dumps({"topic": topic}, ensure_ascii=False)
    return system, user


def _lv_audit_prompt(content: dict[str, Any]) -> tuple[str, str]:
    text = content["source"]["text"]
    items = [
        {
            "itemId": item["itemId"], "question": item["question"],
            "claimedPoints": [p["description"] for p in item["requiredPoints"]],
        }
        for task in content["tasks"] for item in task["items"]
    ]
    system = (
        "You are an INDEPENDENT reviewer auditing a DSH Leseverstehen reading-comprehension task. "
        "You are given the source text and, per question, the content points its own answer key "
        "claims are required — treat those claims as UNVERIFIED, not as ground truth; judge "
        "everything against the text alone. For each question verify: (a) it is answerable from "
        "the text alone, with no outside/world knowledge needed; (b) it has exactly ONE defensible "
        "reading, never two equally valid interpretations; (c) EVERY claimed content point is "
        "actually, genuinely stated or clearly implied by the text — flag any claimed point the "
        "text does not actually support. Also flag if the text itself requires specialist "
        "knowledge beyond general academic literacy, or is not a coherent, natural, original text.\n\n"
        'Return JSON only: {"items": [{"itemId": "q1", "answerableFromTextAlone": true, '
        '"singleDefensibleReading": true, "unsupportedPointDescriptions": []}, ...], '
        '"textRequiresSpecialistKnowledge": false, "textIsCoherent": true}'
    )
    user = json.dumps({"text": text, "items": items}, ensure_ascii=False)
    return system, user


def _audit_passed(audit: Any, expected_item_ids: set[str]) -> tuple[bool, str]:
    if not isinstance(audit, dict):
        return False, "audit response was not a JSON object"
    if audit.get("textRequiresSpecialistKnowledge") is True:
        return False, "text requires specialist knowledge"
    if audit.get("textIsCoherent") is False:
        return False, "text is not coherent/original"
    items = audit.get("items")
    if not isinstance(items, list):
        return False, "audit has no items array"
    seen: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            return False, "audit item is not an object"
        item_id = entry.get("itemId")
        if item_id not in expected_item_ids:
            return False, f"audit referenced unknown item {item_id!r}"
        seen.add(item_id)
        if entry.get("answerableFromTextAlone") is not True:
            return False, f"{item_id}: not answerable from the text alone"
        if entry.get("singleDefensibleReading") is not True:
            return False, f"{item_id}: ambiguous (more than one defensible reading)"
        unsupported = entry.get("unsupportedPointDescriptions") or []
        if unsupported:
            return False, f"{item_id}: unsupported content point(s) {unsupported!r}"
    if seen != expected_item_ids:
        return False, f"audit did not cover every item (missing {expected_item_ids - seen!r})"
    return True, ""


def generate_dsh_lv_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    *, provider: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). See module docstring for the 5-stage pipeline."""
    call = provider or chat_json
    last_error = ""
    for attempt in range(_MAX_REGENERATIONS + 1):
        # 1. GENERATION
        system, user = _lv_generation_prompt(part, topic)
        result = call(system=system, user=user, model=part.constraints.get("generationModel") or get_settings().german_exam_model, max_tokens=6000)
        content = result.data if isinstance(result.data, dict) else {}
        if not content.get("sourceId"):
            content["sourceId"] = f"dsh-lv-{uuid.uuid4().hex[:12]}"

        # 2. STRUCTURAL VALIDATION
        try:
            validate_lv_content(content, part)
            items_built = []
            for task in content.get("tasks") or ():
                for item in task.get("items") or ():
                    items_built.append(open_answer_item_from_generated(item.get("itemId"), task.get("form"), item))
            ids = [i.item_id for i in items_built]
            if len(ids) != _LV_ITEM_COUNT:
                raise DshContentError(f"expected {_LV_ITEM_COUNT} items, got {len(ids)}")
            if len(set(ids)) != len(ids):
                raise DshContentError("duplicate item ids")
        except DshContentError as exc:
            last_error = f"structural: {exc}"
            log.info("dsh_lv_generation structural_failure attempt=%s error=%s", attempt, last_error)
            continue

        # 3. SEMANTIC/CONTENT VALIDATION
        audit_system, audit_user = _lv_audit_prompt(content)
        audit_result = call(system=audit_system, user=audit_user, model=part.constraints.get("verifierModel") or get_settings().german_exam_model, max_tokens=3000)
        passed, reason = _audit_passed(audit_result.data, set(ids))
        if not passed:
            last_error = f"semantic: {reason}"
            log.info("dsh_lv_generation semantic_failure attempt=%s error=%s", attempt, last_error)
            continue

        # 5. ACCEPT
        return content, {
            "deterministicPassed": True, "semanticPassed": True, "regenerationCount": attempt,
            "liveQualificationRequired": True,
        }
    raise DshGenerationError(f"could not produce a valid DSH LV part after {_MAX_REGENERATIONS} regenerations: {last_error}")
