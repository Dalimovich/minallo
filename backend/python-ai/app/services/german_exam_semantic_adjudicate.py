"""Shared German Exam Engine — targeted HV2/HV3 semantic adjudication.

Phase 2.5b's stability measurement found the main semantic verifier
(german_exam_semantic_verify.py) is reliable on HV1 but not on HV2/HV3: on
real, non-injected content, a known genuine defect passed as clean on 20%
of repeated runs, and clean content was falsely flagged on 20% of runs
(see scripts/GERMAN_EXAM_SEMANTIC_QA.md, "Phase 2.5b"). Running the SAME
whole-part verifier twice and rejecting on either complaint was explicitly
rejected as the fix: since false positives were also measured, that would
just make good content get rejected more often, not make the pipeline more
accurate.

Instead this module gives every HV2/HV3 item a SECOND, much narrower
opinion: one batched-per-part call that returns ONLY concrete factual
observations (which options are supported, which are implausible, whether
a field duplicates another) — never a free-text issue code or a pass/fail
verdict. Python (not the model) derives the issue code from that factual
audit, mirroring the audit-first design german_exam_semantic_verify.py
already uses (_apply_audits). This call ALWAYS runs for every HV2/HV3 item
regardless of what the first pass found — the failure mode this fixes
(clean-pass on a real defect) can only be caught by asking again
independently, not by only double-checking things the first pass already
flagged.

Its result REPLACES the first pass's per-item passed/issues for HV2/HV3
(see verify_semantic_full() in german_exam_semantic_gate.py) — a first-pass
flag this adjudicator does not corroborate does not block acceptance, and a
first-pass clean verdict this adjudicator contradicts does. Part-wide
issues (INSUFFICIENT_SOURCE_CONTENT, PART_WIDE_INCOHERENCE) are untouched
here — this module only judges individual items.

HV1 has no adjudicator here at all — Phase 2.5b measured it as stable (0
verdict flips across 15 repeated runs on real content), so a second pass
there would only add cost/latency without fixing a real problem.

Feature-name for usage tracking is this module's own name
(german_exam_semantic_adjudicate) — distinct from both
german_exam_semantic_verify and german_exam_semantic_repair.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import get_settings
from .german_exam_profiles import PartBlueprint
from .german_exam_semantic_verify import SemanticIssue
from .llm_json import chat_json

log = logging.getLogger(__name__)


def _content_payload(content: dict[str, Any]) -> str:
    segments = [{key: segment.get(key) for key in ("id", "speakerId", "spokenText")}
                for segment in content.get("segments") or []]
    return json.dumps({"segments": segments, "questions": content.get("questions") or []}, ensure_ascii=False)


def _adjudicate_prompt_hv2(content: dict[str, Any]) -> tuple[str, str]:
    system = (
        "You are an INDEPENDENT fact-checker for a German listening multiple-choice item "
        "(sentence_completion_mc3). You do NOT decide pass/fail or output an issue code — you only report "
        "concrete factual observations about each item's three options, strictly from the supplied "
        "transcript. Never use outside/world knowledge. Do not request or output hidden reasoning/"
        "chain-of-thought — factual fields only. Reply with ONLY valid JSON, no markdown, no commentary.\n\n"
        "For EACH item, report:\n"
        '- "supportedOptionIndexes": every option index (0, 1, 2) the transcript actually supports as '
        "correct, independent of which one the item itself marks correct — this should almost always be a "
        "single index, but list more than one if the transcript genuinely supports two options equally.\n"
        '- "implausibleDistractorIndexes": every WRONG option index that is absurd, unrelated to the '
        "dialogue, or rejectable by pure general knowledge without having heard the audio at all — not "
        "merely wrong, but implausible as something a listener could ever mistake for correct.\n"
        '- "answerableFromTranscript": false only if the stem asks for information the transcript never '
        "states at all.\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "items": [\n'
        '    {"questionId": "q1", "supportedOptionIndexes": [1], "implausibleDistractorIndexes": [],\n'
        '     "answerableFromTranscript": true}\n'
        "  ]\n"
        "}\n"
        "Include EVERY item id from the supplied content."
    )
    return system, _content_payload(content)


def _adjudicate_prompt_hv3(content: dict[str, Any]) -> tuple[str, str]:
    system = (
        "You are an INDEPENDENT fact-checker for a German listening note-completion item "
        "(structured_note_completion). You do NOT decide pass/fail or output an issue code — you only "
        "report concrete factual observations about each field, strictly from the supplied transcript. "
        "Never use outside/world knowledge. Do not request or output hidden reasoning/chain-of-thought — "
        "factual fields only. Reply with ONLY valid JSON, no markdown, no commentary.\n\n"
        "For EACH item, report:\n"
        '- "answerSupported": true only if note.correctFill is directly stated/supported by the lecture.\n'
        '- "alternativeValidAnswers": any OTHER short phrasing the lecture equally supports for this field '
        "that a literal-string-match grader would unfairly reject (empty if correctFill is the only "
        "reasonable answer).\n"
        '- "duplicateWithItemIds": every OTHER item id in this part asking for the same underlying fact.\n'
        '- "noteworthyInformation": false if this field is filler/trivial rather than a real point from the '
        "lecture.\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "items": [\n'
        '    {"questionId": "q1", "answerSupported": true, "alternativeValidAnswers": [],\n'
        '     "duplicateWithItemIds": [], "noteworthyInformation": true}\n'
        "  ]\n"
        "}\n"
        "Include EVERY item id from the supplied content."
    )
    return system, _content_payload(content)


_PROMPT_BUILDERS = {
    "sentence_completion_mc3": _adjudicate_prompt_hv2,
    "structured_note_completion": _adjudicate_prompt_hv3,
}


def _schema_hv2(content: dict[str, Any]) -> dict[str, Any]:
    ids = [q["questionId"] for q in content["questions"]]
    idx = {"type": "integer", "minimum": 0, "maximum": 2}
    item = {
        "type": "object",
        "properties": {
            "questionId": {"type": "string", "enum": ids},
            "supportedOptionIndexes": {"type": "array", "items": idx},
            "implausibleDistractorIndexes": {"type": "array", "items": idx},
            "answerableFromTranscript": {"type": "boolean"},
        },
        "required": ["questionId", "supportedOptionIndexes", "implausibleDistractorIndexes", "answerableFromTranscript"],
        "additionalProperties": False,
    }
    return {"type": "object", "properties": {"items": {"type": "array", "items": item}},
            "required": ["items"], "additionalProperties": False}


def _schema_hv3(content: dict[str, Any]) -> dict[str, Any]:
    ids = [q["questionId"] for q in content["questions"]]
    strings = {"type": "array", "items": {"type": "string"}}
    item = {
        "type": "object",
        "properties": {
            "questionId": {"type": "string", "enum": ids},
            "answerSupported": {"type": "boolean"},
            "alternativeValidAnswers": strings,
            "duplicateWithItemIds": {"type": "array", "items": {"type": "string", "enum": ids}},
            "noteworthyInformation": {"type": "boolean"},
        },
        "required": ["questionId", "answerSupported", "alternativeValidAnswers", "duplicateWithItemIds", "noteworthyInformation"],
        "additionalProperties": False,
    }
    return {"type": "object", "properties": {"items": {"type": "array", "items": item}},
            "required": ["items"], "additionalProperties": False}


_SCHEMA_BUILDERS = {
    "sentence_completion_mc3": _schema_hv2,
    "structured_note_completion": _schema_hv3,
}


def _derive_hv2(question: dict[str, Any], audit: Any) -> list[SemanticIssue]:
    if not isinstance(audit, dict):
        return [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Malformed adjudication audit")]
    correct_index = question["mc3"]["correctIndex"]
    supported = audit.get("supportedOptionIndexes")
    implausible = audit.get("implausibleDistractorIndexes")
    answerable = audit.get("answerableFromTranscript")
    if (not isinstance(supported, list) or any(type(v) is not int or not 0 <= v <= 2 for v in supported)
            or not isinstance(implausible, list) or any(type(v) is not int or not 0 <= v <= 2 for v in implausible)
            or type(answerable) is not bool):
        return [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Malformed adjudication audit")]
    supported_set, implausible_set = set(supported), set(implausible)
    if correct_index in implausible_set:
        # Self-contradictory: the marked-correct option can't also be an
        # implausible WRONG option. Fail closed rather than guess intent.
        return [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Adjudication audit is self-contradictory")]
    issues: list[SemanticIssue] = []
    if not answerable:
        issues.append(SemanticIssue("QUESTION_NOT_ANSWERABLE", "error", "Adjudicator: not answerable from transcript"))
    if correct_index not in supported_set:
        issues.append(SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "Adjudicator: correct option unsupported"))
    if len(supported_set) > 1:
        issues.append(SemanticIssue("MULTIPLE_DEFENSIBLE_ANSWERS", "error", "Adjudicator: more than one option supported",
                                     evidence={"optionIndexes": sorted(supported_set)}))
    if implausible_set:
        issues.append(SemanticIssue("IMPLAUSIBLE_DISTRACTOR", "error", "Adjudicator: implausible distractor present",
                                     evidence={"optionIndexes": sorted(implausible_set)}))
    return issues


def _derive_hv3(item_id: str, questions: dict[str, Any], audit: Any) -> list[SemanticIssue]:
    if not isinstance(audit, dict):
        return [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Malformed adjudication audit")]
    supported = audit.get("answerSupported")
    alternatives = audit.get("alternativeValidAnswers")
    duplicates = audit.get("duplicateWithItemIds")
    noteworthy = audit.get("noteworthyInformation")
    if (type(supported) is not bool or not isinstance(alternatives, list)
            or any(not isinstance(v, str) for v in alternatives)
            or not isinstance(duplicates, list)
            or any(not isinstance(v, str) or v not in questions or v == item_id for v in duplicates)
            or type(noteworthy) is not bool):
        return [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Malformed adjudication audit")]
    issues: list[SemanticIssue] = []
    if not supported:
        issues.append(SemanticIssue("UNSUPPORTED_CORRECT_ANSWER", "error", "Adjudicator: answer unsupported"))
    if not noteworthy:
        issues.append(SemanticIssue("TRIVIAL_ITEM", "error", "Adjudicator: not noteworthy"))
    if alternatives:
        issues.append(SemanticIssue("MULTIPLE_DEFENSIBLE_ANSWERS", "error", "Adjudicator: alternative valid answers exist"))
    if duplicates:
        issues.append(SemanticIssue("DUPLICATE_INFORMATION", "error", "Adjudicator: duplicates another field",
                                     evidence={"questionIds": duplicates}))
    return issues


def adjudicate_items(part: PartBlueprint, content: dict[str, Any], expected_ids: set[str]) -> dict[str, list[SemanticIssue]] | None:
    """Returns questionId -> its adjudicated issues (empty list = clean) for
    every expected item, or None if this task_type has no adjudicator (HV1).
    Fails closed: any parse problem, an omitted item, or the call itself
    failing produces VERIFIER_RESPONSE_INVALID for the affected item(s) —
    never silently skips adjudication and falls back to "accept"."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        return None
    schema_builder = _SCHEMA_BUILDERS[part.task_type]
    system, user = builder(content)
    questions = {q["questionId"]: q for q in content["questions"]}

    try:
        model = get_settings().german_exam_model
        result = chat_json(system=system, user=user, max_tokens=6000,
                            model=model, json_schema=schema_builder(content),
                            reasoning_effort="medium" if model.startswith("gpt-5") else None)
        data = result.data
    except Exception:
        log.warning("Semantic adjudicator call failed", exc_info=True)
        data = None

    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {item_id: [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Adjudicator call failed or response malformed")]
                for item_id in expected_ids}

    raw_by_id: dict[str, Any] = {
        raw["questionId"]: raw for raw in data["items"]
        if isinstance(raw, dict) and isinstance(raw.get("questionId"), str)
    }

    out: dict[str, list[SemanticIssue]] = {}
    for item_id in expected_ids:
        raw = raw_by_id.get(item_id)
        if raw is None:
            out[item_id] = [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Adjudicator omitted this item")]
            continue
        if part.task_type == "sentence_completion_mc3":
            out[item_id] = _derive_hv2(questions[item_id], raw)
        else:
            out[item_id] = _derive_hv3(item_id, questions, raw)
    return out
