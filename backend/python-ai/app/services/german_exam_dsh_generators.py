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

WS (Strukturen) is the one generator here that does NOT follow the five stages above as written:
it reuses dsh_qualification.qualify_lv_ws() directly for BOTH structural validation (no
blind_solver) and semantic/content validation (a real LLM-backed blind_solver) rather than a
second parallel check, because that function already is this repository's existing,
already-tested answer to "do the generated task and accepted answer families actually
correspond" — reusing it, not rebuilding it, is what "don't build five independent validation
frameworks" means here. WS is also NOT wired into generate_task()'s module dispatch: see
generate_dsh_ws_part's own docstring for the pre-existing engine gap that blocks it.
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
    source_fingerprint,
    validate_hv_content,
    validate_lv_content,
)
from .german_exams.dsh_qualification import qualify_lv_ws
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


def _build_open_answer_items(content: dict[str, Any]) -> list[Any]:
    """Shared by every open-answer DSH generator (HV, LV): walks content["tasks"][].items[] and
    constructs a real OpenAnswerItem per item (see open_answer_item_from_generated for why this
    is required in addition to validate_*_content). Raises DshContentError on the first invalid
    item — the caller's own try/except turns that into a structural-failure regeneration."""
    items_built = []
    for task in content.get("tasks") or ():
        for item in task.get("items") or ():
            items_built.append(open_answer_item_from_generated(item.get("itemId"), task.get("form"), item))
    return items_built


def _run_open_answer_pipeline(
    *, label: str, part: PartBlueprint, item_count: int, call: Any,
    generation_prompt: Any, audit_prompt: Any, structural_validate: Any,
    gen_max_tokens: int, audit_max_tokens: int, source_id_field: str | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Shared 5-stage pipeline for every DSH open-answer generator (HV, LV — both produce the
    SAME content["tasks"][].items[] shape with OpenAnswerItem/ContentPoint content points, just
    with a different top-level text field and different official constraints). Each caller
    supplies its own generation/audit prompt builders and structural validator; this function
    owns only the orchestration (generate -> validate -> audit -> bounded regenerate -> accept),
    so that shape never has to be duplicated per generator."""
    last_error = ""
    for attempt in range(_MAX_REGENERATIONS + 1):
        # 1. GENERATION
        system, user = generation_prompt()
        result = call(system=system, user=user, model=part.constraints.get("generationModel") or get_settings().german_exam_model, max_tokens=gen_max_tokens)
        content = result.data if isinstance(result.data, dict) else {}
        if source_id_field and not content.get(source_id_field):
            content[source_id_field] = f"dsh-{label}-{uuid.uuid4().hex[:12]}"

        # 2. STRUCTURAL VALIDATION
        try:
            structural_validate(content, part)
            items_built = _build_open_answer_items(content)
            ids = [i.item_id for i in items_built]
            if len(ids) != item_count:
                raise DshContentError(f"expected {item_count} items, got {len(ids)}")
            if len(set(ids)) != len(ids):
                raise DshContentError("duplicate item ids")
        except DshContentError as exc:
            last_error = f"structural: {exc}"
            log.info("dsh_%s_generation structural_failure attempt=%s error=%s", label, attempt, last_error)
            continue

        # 3. SEMANTIC/CONTENT VALIDATION
        audit_system, audit_user = audit_prompt(content)
        audit_result = call(system=audit_system, user=audit_user, model=part.constraints.get("verifierModel") or get_settings().german_exam_model, max_tokens=audit_max_tokens)
        passed, reason = _audit_passed(audit_result.data, set(ids))
        if not passed:
            last_error = f"semantic: {reason}"
            log.info("dsh_%s_generation semantic_failure attempt=%s error=%s", label, attempt, last_error)
            continue

        # 5. ACCEPT
        return content, {
            "deterministicPassed": True, "semanticPassed": True, "regenerationCount": attempt,
            "liveQualificationRequired": True,
        }
    raise DshGenerationError(f"could not produce a valid DSH {label.upper()} part after {_MAX_REGENERATIONS} regenerations: {last_error}")


def generate_dsh_lv_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    *, provider: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). See module docstring for the 5-stage pipeline."""
    return _run_open_answer_pipeline(
        label="lv", part=part, item_count=_LV_ITEM_COUNT, call=provider or chat_json,
        generation_prompt=lambda: _lv_generation_prompt(part, topic),
        audit_prompt=_lv_audit_prompt, structural_validate=validate_lv_content,
        gen_max_tokens=6000, audit_max_tokens=3000, source_id_field="sourceId",
    )


# ---- HV (Hörverstehen) ----------------------------------------------------------------------
# CONTENT ONLY — no audio anywhere in this generator's output, deliberately. Audio synthesis,
# the two-play delivery timing (dsh_hv_playback.py) and synchronization/segment metadata are ALL
# separate concerns this generator does not touch, exactly mirroring german_exam_listening.py's
# own "Returns CONTENT ONLY — no TTS call" rule for every other exam's Hören. A structurally and
# semantically valid lectureText + tasks here is necessary, not sufficient, for a real HV task:
# without real, qualified audio this remains a structurally complete generator for a
# media-backed task that stays unavailable (see the module docstring's own availability note).

# DECISION (not an official count): 8 items, same density reasoning as LV's own item count —
# the MPO states none for HV either.
_HV_ITEM_COUNT = 8

_HV_GENERATION_SHAPE = {
    "lectureText": f"ORIGINAL German lecture/seminar-talk transcript, {{min}}-{{max}} characters with spaces",
    "tasks": [{
        "form": "questions",
        "items": [{
            "itemId": "q1", "question": "an open comprehension question answerable from the lecture alone",
            "requiredPoints": [{"pointId": "p1", "description": "one idea the answer must contain, in your own words", "points": 1}],
            "gradingNotes": "optional note for a future human/AI grader",
        }],
    }],
}


def _hv_generation_prompt(part: PartBlueprint, topic: dict[str, str]) -> tuple[str, str]:
    c = part.constraints
    shape = json.dumps(_HV_GENERATION_SHAPE, ensure_ascii=False)
    system = (
        "Generate ONE DSH (Deutsche Sprachprüfung für den Hochschulzugang) Hörverstehen (HV) "
        "listening-comprehension task in German, written as the TRANSCRIPT of a spoken academic "
        f"lecture or seminar talk ({c['communicativeSituation'].replace('_', ' ')}) — write it as "
        "natural SPOKEN academic German (the way a lecturer actually talks: signposting phrases, "
        "spoken-register connectors, not a written article), for the official 'questions' task "
        "form.\n\n"
        f"The transcript must be ORIGINAL, {c['lectureCharsMin']}-{c['lectureCharsMax']} "
        "characters including spaces (measuring the transcript text, not an audio duration — none "
        "is specified), and require NO specialist knowledge beyond general academic literacy — a "
        "non-specialist, academically literate listener must be able to follow it from the "
        "transcript alone.\n\n"
        f"Produce exactly {_HV_ITEM_COUNT} open comprehension questions (task form \"questions\"). "
        "Each question must be answerable from the transcript ALONE, with exactly ONE defensible "
        "reading — never ambiguous, never requiring information the transcript does not state, "
        "never answerable from outside/world knowledge instead of the transcript. For each "
        "question, give the required content point(s) a correct answer must contain (as idea "
        "descriptions, NOT exact quotes — content-level paraphrase is fine; these are graded on "
        "content only, never on language).\n\n"
        f"Topic: {topic.get('label', '')}. Never mention being an AI or that this is a generated "
        "exercise within the transcript itself.\n\n"
        f"Return JSON only, in exactly this shape: {shape}"
    )
    user = json.dumps({"topic": topic}, ensure_ascii=False)
    return system, user


def _hv_audit_prompt(content: dict[str, Any]) -> tuple[str, str]:
    text = content["lectureText"]
    items = [
        {
            "itemId": item["itemId"], "question": item["question"],
            "claimedPoints": [p["description"] for p in item["requiredPoints"]],
        }
        for task in content["tasks"] for item in task["items"]
    ]
    system = (
        "You are an INDEPENDENT reviewer auditing a DSH Hörverstehen listening-comprehension "
        "task's TRANSCRIPT (you are given the transcript text, not audio — judge from it exactly "
        "as a listener who heard the lecture would). You are given the transcript and, per "
        "question, the content points its own answer key claims are required — treat those claims "
        "as UNVERIFIED, not as ground truth; judge everything against the transcript alone. For "
        "each question verify: (a) it is answerable from the transcript alone, with no outside/"
        "world knowledge needed; (b) it has exactly ONE defensible reading, never two equally "
        "valid interpretations; (c) EVERY claimed content point is actually, genuinely stated or "
        "clearly implied by the transcript — flag any claimed point the transcript does not "
        "actually support. Also flag if the transcript itself requires specialist knowledge "
        "beyond general academic literacy, or does not read as a coherent, natural, original "
        "spoken lecture/seminar talk.\n\n"
        'Return JSON only: {"items": [{"itemId": "q1", "answerableFromTextAlone": true, '
        '"singleDefensibleReading": true, "unsupportedPointDescriptions": []}, ...], '
        '"textRequiresSpecialistKnowledge": false, "textIsCoherent": true}'
    )
    user = json.dumps({"transcript": text, "items": items}, ensure_ascii=False)
    return system, user


def generate_dsh_hv_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    *, provider: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). content has NO audio field anywhere — see this
    section's own header comment for why that is deliberate, not an oversight."""
    return _run_open_answer_pipeline(
        label="hv", part=part, item_count=_HV_ITEM_COUNT, call=provider or chat_json,
        generation_prompt=lambda: _hv_generation_prompt(part, topic),
        audit_prompt=_hv_audit_prompt, structural_validate=validate_hv_content,
        gen_max_tokens=6500, audit_max_tokens=3000, source_id_field=None,
    )


# ---- WS (Wissenschaftssprachliche Strukturen) -----------------------------------------------
# NOT wired into generate_task()'s module dispatch. WS must bind to the SAME LV text the learner
# already saw in the reading module for this same exam attempt (OFFICIAL §5(4)/§10(4)2d) — but
# generate_task() generates one part at a time and has no concept of "this part's sibling part's
# already-generated content" to supply that LV text automatically. That is a pre-existing,
# already-documented engine gap (audit/dsh/IMPLEMENTATION_AUDIT.md section 5: "a 'shared LV+WS
# 90-minute block' needs a delivery concept the engine does not have"), not something invented
# around here. This function is the pure, directly-testable piece instead: given an ALREADY-VALID
# LV content dict (e.g. generate_dsh_lv_part's own output), produce a WS bundle bound to it.

# DECISION (not an official count): 6 items — the MPO states none for WS either.
_WS_ITEM_COUNT = 6

_WS_GENERATION_SHAPE = {
    "items": [{
        "itemId": "w1", "form": "completion", "category": "syntactic",
        "sourceSentence": "<EXACT verbatim sentence copied character-for-character from the given text>",
        "prompt": "the sentence as the learner sees it (a gap for 'completion', or the transformation "
                  "instruction + original for 'paraphrase'/'transformation'/'complex_structure_comprehension') "
                  "— must NOT already contain the answer",
        "families": [{"familyId": "f1", "accepted": ["weil", "da"], "note": "optional: why these are interchangeable"}],
        "maxPoints": 1,
    }],
}


def _ws_generation_prompt(lv_text: str, ws_part: PartBlueprint) -> tuple[str, str]:
    c = ws_part.constraints
    shape = json.dumps(_WS_GENERATION_SHAPE, ensure_ascii=False)
    system = (
        "Generate DSH (Deutsche Sprachprüfung für den Hochschulzugang) Wissenschaftssprachliche "
        "Strukturen (WS) items, bound to the GIVEN German academic text (the SAME text a learner "
        "already read for Leseverstehen in this same exam). WS is graded on LINGUISTIC "
        "CORRECTNESS only, never content.\n\n"
        f"Produce exactly {_WS_ITEM_COUNT} items. Every item MUST: (1) quote an EXACT, VERBATIM "
        "sentence from the given text as sourceSentence — copy it character-for-character, never "
        f"paraphrase or alter it; (2) use one of these official task forms: {list(c['taskForms'])}; "
        "(3) use one of these official structure categories: "
        f"{list(c['structureCategories'])}; (4) give a prompt that does NOT already contain the "
        "answer; (5) give one or more answer families, where EVERY family is a group of "
        "genuinely interchangeable, linguistically correct answers — include EVERY common correct "
        "variant you can think of in some family; never omit an equally correct alternative, and "
        "never include an incorrect one.\n\n"
        f"Return JSON only, in exactly this shape: {shape}"
    )
    user = json.dumps({"text": lv_text}, ensure_ascii=False)
    return system, user


def _llm_blind_solver(call: Any, model: str) -> Any:
    """A BlindSolver (dsh_qualification.py's injectable judgement type) backed by a real model
    call: solves a WS item from ONLY what qualify_lv_ws's own `hidden` set leaves visible
    (itemId/form/category/prompt/maxPoints — never families, sourceSentence or sourceSpan), the
    same information a real candidate who has not seen the key would have."""

    def solve(blind_item: Any) -> str:
        system = (
            "Solve ONE German language-structure exercise (DSH Wissenschaftssprachliche "
            "Strukturen). You are given only the task form, category and prompt — the source "
            "text and answer key are not shown to you, exactly like a real candidate solving this "
            "item fresh. Give the single best completion or transformed sentence.\n\n"
            'Return JSON only: {"answer": "your completion or transformed sentence, nothing else"}'
        )
        user = json.dumps({k: blind_item.get(k) for k in ("form", "category", "prompt")}, ensure_ascii=False)
        result = call(system=system, user=user, model=model, max_tokens=200)
        data = result.data if isinstance(result.data, dict) else {}
        return str(data.get("answer") or "")

    return solve


def generate_dsh_ws_part(
    lv_part: PartBlueprint, lv_content: dict[str, Any], ws_part: PartBlueprint,
    plan: list[AdaptationInstruction], topic: dict[str, str], *, provider: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (ws_content, validation_meta). See this section's header comment for why this is
    not wired into generate_task() and takes lv_content as an explicit parameter instead.

    Pipeline: generation -> GROUND every claimed sourceSentence in the actual LV text ourselves
    (exact substring search, never trusting the model's own character-offset arithmetic) ->
    dsh_qualification.qualify_lv_ws() with no blind_solver (structural: source binding, official
    form/category, key-not-leaked-in-prompt) -> the SAME function again with a real LLM-backed
    blind_solver (semantic: does an independent solver who never saw the key agree with every
    family?) -> bounded full-regeneration repair -> accept/DshGenerationError."""
    call = provider or chat_json
    lv_text = lv_content["source"]["text"]
    last_error = ""
    for attempt in range(_MAX_REGENERATIONS + 1):
        # 1. GENERATION
        system, user = _ws_generation_prompt(lv_text, ws_part)
        result = call(system=system, user=user, model=ws_part.constraints.get("generationModel") or get_settings().german_exam_model, max_tokens=4000)
        raw = result.data if isinstance(result.data, dict) else {}
        raw_items = raw.get("items") if isinstance(raw.get("items"), list) else []

        # 2a. GROUNDING — deterministic, never LLM arithmetic
        try:
            items: list[dict[str, Any]] = []
            seen_ids: set[str] = set()
            for raw_item in raw_items:
                if not isinstance(raw_item, dict):
                    raise DshContentError("item must be an object")
                item_id = raw_item.get("itemId")
                if not isinstance(item_id, str) or not item_id or item_id in seen_ids:
                    raise DshContentError("item id is missing, empty or duplicated")
                seen_ids.add(item_id)
                sentence = raw_item.get("sourceSentence")
                if not isinstance(sentence, str) or not sentence.strip():
                    raise DshContentError(f"{item_id}: sourceSentence must be a non-empty string")
                if lv_text.count(sentence) != 1:
                    raise DshContentError(f"{item_id}: sourceSentence is not found exactly once in the LV text")
                start = lv_text.index(sentence)
                items.append({**raw_item, "sourceSpan": {"start": start, "end": start + len(sentence)}})
            if len(items) != _WS_ITEM_COUNT:
                raise DshContentError(f"expected {_WS_ITEM_COUNT} items, got {len(items)}")
        except DshContentError as exc:
            last_error = f"grounding: {exc}"
            log.info("dsh_ws_generation grounding_failure attempt=%s error=%s", attempt, last_error)
            continue

        ws_content = {
            "sourceRef": {"sourceId": lv_content["sourceId"], "sha256": source_fingerprint(lv_text)},
            "items": items,
        }

        # 2b. STRUCTURAL VALIDATION — reused, not rebuilt (see module docstring)
        structural = qualify_lv_ws(lv_content, ws_content, lv_part, ws_part)
        if structural.failed:
            last_error = f"structural: {structural.failed}"
            log.info("dsh_ws_generation structural_failure attempt=%s error=%s", attempt, last_error)
            continue

        # 3. SEMANTIC/CONTENT VALIDATION — the central WS risk this function exists to guard
        # against: an independent blind solver, never the generator's own families as ground truth.
        verifier_model = ws_part.constraints.get("verifierModel") or get_settings().german_exam_model
        audited = qualify_lv_ws(lv_content, ws_content, lv_part, ws_part, blind_solver=_llm_blind_solver(call, verifier_model))
        if audited.failed:
            last_error = f"semantic: {audited.failed}"
            log.info("dsh_ws_generation semantic_failure attempt=%s error=%s", attempt, last_error)
            continue

        # 5. ACCEPT
        return ws_content, {
            "deterministicPassed": True, "semanticPassed": True, "regenerationCount": attempt,
            "liveQualificationRequired": True,
        }
    raise DshGenerationError(f"could not produce a valid DSH WS part after {_MAX_REGENERATIONS} regenerations: {last_error}")
