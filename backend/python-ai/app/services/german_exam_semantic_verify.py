"""Shared German Exam Engine — semantic (content-quality) verification.

The deterministic validator (german_exam_validator.py) proves the SHAPE is
right: exact counts, ids resolve, tags are from the controlled vocabulary.
It cannot judge whether the CONTENT is defensible — whether the intended
answer is actually supported by the transcript, whether a distractor is
merely plausible-looking or genuinely absurd, whether two options are both
arguably correct. That is this module's job.

This is NOT another generator. It is given already deterministically-valid
content and judges it, using ONLY the supplied transcript as ground truth —
never "fixing" an answer with outside/world knowledge (see VERIFY_PROMPT
preambles). One batched chat_json() call per part (not one per item):
part-wide judgments (duplicate HV3 fields, HV1 speaker distinctness,
overall coherence) need cross-item context that per-item calls wouldn't have,
and it's dramatically cheaper.

Feature-name for usage tracking is derived automatically by chat_json()'s
_caller_feature() from THIS module's name (see llm_json.py) — so every call
from here is recorded as feature="german_exam_semantic_verify" without
threading a label through. Repair calls live in a separate module
(german_exam_semantic_repair.py) specifically so their usage is tracked
under a different feature name.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from ..config import get_settings

from .german_exams import PartBlueprint
from .llm_json import chat_json

log = logging.getLogger(__name__)

# Controlled vocabulary — the verifier must never invent a code outside this
# set. Unrecognized output blocks acceptance.
SEMANTIC_ISSUE_CODES = frozenset(
    {
        "UNSUPPORTED_CORRECT_ANSWER",
        "MULTIPLE_DEFENSIBLE_ANSWERS",
        "AMBIGUOUS_MAPPING",
        "IMPLAUSIBLE_DISTRACTOR",
        "DISTRACTOR_ACCIDENTALLY_CORRECT",
        "QUESTION_NOT_ANSWERABLE",
        "ANSWER_EXPOSED_IN_PROMPT",
        "PARAPHRASE_TOO_LITERAL",
        "EVIDENCE_TOO_WEAK",
        "DUPLICATE_INFORMATION",
        "TRIVIAL_ITEM",
        "OFF_LEVEL_CONTENT",
        "WRONG_REGISTER",
        "PART_WIDE_INCOHERENCE",
        # Task-specific addition (section 13): a part-wide "the source
        # material itself doesn't support 10 items" signal, distinct from
        # PART_WIDE_INCOHERENCE (which is about the topic hanging together,
        # not about there being enough of it).
        "INSUFFICIENT_SOURCE_CONTENT",
        "VERIFIER_RESPONSE_INVALID",
        # Reading-only: the generated richtig/falsch/nicht_im_text label (or
        # the global-heading verdict) doesn't match what the text actually
        # supports — distinct from UNSUPPORTED_CORRECT_ANSWER, which assumes
        # a single correct option among distractors rather than a 3-way
        # ground-truth classification per statement.
        "TRISTATE_VERDICT_MISMATCH",
    }
)

# Issues whose fix is "repair this one item" vs "the transcript/part itself
# is the problem" (see german_exam_listening.py's pipeline: item-level ->
# targeted repair, part-wide -> full regeneration).
_PART_WIDE_ONLY_CODES = frozenset({"PART_WIDE_INCOHERENCE", "INSUFFICIENT_SOURCE_CONTENT"})


@dataclass
class SemanticIssue:
    code: str
    severity: str  # "error" | "warning" — only "error" blocks acceptance/triggers repair
    message: str
    evidence: dict[str, Any] = field(default_factory=dict)  # e.g. {"segmentIds": [...], "optionIndexes": [...]}


@dataclass
class ItemSemanticResult:
    item_id: str
    passed: bool
    issues: list[SemanticIssue] = field(default_factory=list)


@dataclass
class SemanticVerificationResult:
    passed: bool
    part_wide_issues: list[SemanticIssue] = field(default_factory=list)
    items: list[ItemSemanticResult] = field(default_factory=list)
    # Token counts of the call that produced this result (diagnostics only).
    usage: dict[str, int] | None = None
    # True only when the chunked verifier has exhausted its own bounded fallback: the
    # caller must not restart the whole verification (see german_exam_semantic_chunked).
    terminal_verifier_failure: bool = False

    def item_error_issues(self) -> dict[str, list[SemanticIssue]]:
        """questionId -> its error-severity issues, for items that failed.
        Warnings are informational only — they don't block acceptance or
        trigger repair."""
        out: dict[str, list[SemanticIssue]] = {}
        for item in self.items:
            errors = [i for i in item.issues if i.severity == "error"]
            if errors:
                out[item.item_id] = errors
        return out

    def part_wide_error_issues(self) -> list[SemanticIssue]:
        return [i for i in self.part_wide_issues if i.severity == "error"]


def _base_verifier_preamble(part: PartBlueprint) -> str:
    return (
        "You are an INDEPENDENT exam-item verifier for a German listening exercise "
        f"({part.task_type}). You must NOT improve, rewrite, or complete the exercise. Judge ONLY "
        "whether each intended answer is uniquely supported by the supplied transcript, and whether "
        "distractors/wrong options are plausible-but-wrong (not absurd, not accidentally correct). "
        "Judge answerability STRICTLY from the supplied transcript text — never use outside/world "
        "knowledge to decide whether an answer is correct; if the transcript doesn't state it, the "
        "item is unsupported even if the fact happens to be true in reality. Do not request or output "
        "hidden reasoning/chain-of-thought — give only a concise issue code, one-sentence message, and "
        "evidence references. Reply with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        f"Allowed issue codes — you MUST only use codes from this exact list, never invent new ones: "
        f"{sorted(SEMANTIC_ISSUE_CODES)}.\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "passed": false,\n'
        '  "partWideIssues": [{"code": "PART_WIDE_INCOHERENCE", "severity": "error", "message": "...", "evidence": {}}],\n'
        '  "items": [\n'
        '    {"questionId": "q4", "passed": false, "issues": [\n'
        '      {"code": "AMBIGUOUS_MAPPING", "severity": "error", "message": "...",\n'
        '       "evidence": {"segmentIds": ["s3", "s6"]}}\n'
        "    ]},\n"
        '    {"questionId": "q1", "passed": true, "issues": []}\n'
        "  ]\n"
        "}\n"
        "Include EVERY item id from the supplied content in the items array, even ones with no issues "
        '(passed: true, issues: []). severity is "error" (blocks acceptance) or "warning" (informational, '
        "does not block acceptance). Set an item's passed to true exactly when it has no error issues. "
        "Set overall passed to true exactly when all items pass and no part-wide error exists. "
        "A warning alone must not set either passed flag to false."
    )


def _content_payload(content: dict[str, Any]) -> str:
    # Display summaries can omit or contradict what the listener hears.
    segments = [{key: segment.get(key) for key in ("id", "speakerId", "spokenText")}
                for segment in content.get("segments") or []]
    return json.dumps({"segments": segments, "questions": content.get("questions") or []}, ensure_ascii=False)


def _verify_prompt_hv1(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is speaker_statement_matching (telc-style Globalverstehen). For each non-distractor "
        "item verify: (A) the speaker named in matching.correctSpeakerId genuinely supports the "
        "statement's meaning; (B) no OTHER speaker supports the statement equally well (if two speakers "
        "could plausibly match, use AMBIGUOUS_MAPPING with evidence.segmentIds listing both candidate "
        "speakers' segments). Compare each mapped statement against ALL eight speakers, including "
        "identical or synonymous viewpoints. Merely sharing a topic is not ambiguity. "
        "(C) the statement paraphrases the speaker's wording rather than quoting it "
        "almost verbatim (PARAPHRASE_TOO_LITERAL); (D) the statement captures the speaker's MAIN point, "
        "not a minor incidental detail (TRIVIAL_ITEM). For the distractor items (isDistractor: true) "
        "verify: (E) the statement does not actually match any speaker well enough to be a reasonable "
        "correct answer (DISTRACTOR_ACCIDENTALLY_CORRECT if it does); (F) the statement is still "
        "plausible/topic-relevant, not absurd or unrelated (IMPLAUSIBLE_DISTRACTOR). A distractor is "
        "SUPPOSED to be unsupported: do not flag its lack of support or contradiction as an error. "
        "Part-wide: flag "
        "PART_WIDE_INCOHERENCE if the 8 speakers don't express genuinely different viewpoints on a "
        "coherent shared topic, or if the content isn't C1-Hochschule-appropriate in register/complexity."
    )
    user = _content_payload(content)
    return system, user


def _verify_prompt_hv2(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is sentence_completion_mc3 (telc-style Detailverstehen). For each item verify: (A) the "
        "option at mc3.correctIndex is clearly supported by the dialogue (UNSUPPORTED_CORRECT_ANSWER if "
        "not); (B) exactly one option is defensible as correct — if a second option could also reasonably "
        "be argued correct, use MULTIPLE_DEFENSIBLE_ANSWERS with evidence.optionIndexes listing both; (C) "
        "the two wrong options are plausible — each should plausibly arise from a nearby fact, a partially "
        "true detail, reversed causality, something a DIFFERENT speaker said, or a negation/contrast "
        "confusion; (D) reject any option that is absurd, unrelated to the dialogue, or rejectable by pure "
        "general knowledge without having heard the audio at all — use IMPLAUSIBLE_DISTRACTOR (this is "
        "exactly the class of error the phrase 'abolish all intersections' represents: a wrong option with "
        "no connection to anything actually said); (E) if a 'wrong' option is actually just as supported "
        "as the marked correct one, use DISTRACTOR_ACCIDENTALLY_CORRECT; (F) QUESTION_NOT_ANSWERABLE if the "
        "stem requires information genuinely absent from the transcript. Part-wide: PART_WIDE_INCOHERENCE "
        "if items don't roughly follow the chronological order of the dialogue, or the dialogue itself "
        "doesn't hang together as one coherent conversation."
    )
    user = _content_payload(content)
    return system, user


def _verify_prompt_hv3(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is structured_note_completion (telc-style Informationstransfer). For each field verify: "
        "(A) note.correctFill is directly stated/supported by the lecture (UNSUPPORTED_CORRECT_ANSWER if "
        "not); (B) the requested information is genuinely note-worthy — a real point from the lecture, not "
        "filler (TRIVIAL_ITEM); (C) the answer is concise enough for a note-completion field, not a full "
        "sentence; (D) the field is semantically distinct from every OTHER field in this part — if two "
        "fields ask for the same underlying point in different words, flag BOTH with DUPLICATE_INFORMATION "
        "and reference each other's questionId in evidence; (E) there isn't another equally valid answer "
        "the automatic grader (which does a fairly literal string match) would unfairly reject — flag with "
        "MULTIPLE_DEFENSIBLE_ANSWERS if the correctFill wording is unnecessarily narrow when the lecture "
        "supports an equally valid alternative phrasing. Part-wide: INSUFFICIENT_SOURCE_CONTENT if the "
        "lecture genuinely does not contain 10 distinct informational points (i.e. the padding problem — "
        "some fields exist only because the count had to reach 10, not because the lecture said 10 "
        "different things); PART_WIDE_INCOHERENCE if the outline doesn't represent the lecture's actual "
        "structure/hierarchy coherently."
    )
    user = _content_payload(content)
    return system, user


# ── Lesen (reading) verify prompts ──────────────────────────────────────
# Reading content has no "segments" — build the payload directly from each
# task type's own shape instead of reusing _content_payload().


def _verify_prompt_lesen1(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is text_reconstruction_sentence_matching (telc-style Lesen Teil 1, Textrekonstruktion). "
        "You are given the full text with numbered gaps and 8 candidate sentences. For each gap-mapping "
        "item verify: (A) the candidate named in correctCandidateId genuinely fits the gap grammatically "
        "AND logically (discourse structure, reference resolution, connectors, logical progression) — "
        "UNSUPPORTED_CORRECT_ANSWER if not; (B) no OTHER candidate fits that same gap equally well — if a "
        "second candidate could also plausibly fill it, use AMBIGUOUS_MAPPING with evidence.questionIds "
        "listing the gap's questionId. Compare each gap against ALL 8 candidates, not just the marked one. "
        "The two unused candidates are supposed to be unsupported for every gap — do not flag that. "
        "Part-wide: PART_WIDE_INCOHERENCE if the text doesn't read as one coherent original text once "
        "correctly reconstructed, or isn't C1-Hochschule-appropriate academic register."
    )
    text = content.get("text") or {}
    payload = {
        "text": {"title": text.get("title"), "paragraphs": text.get("paragraphs"), "gaps": text.get("gaps")},
        "candidates": content.get("candidates") or [],
        "questions": content.get("questions") or [],
    }
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


def _verify_prompt_lesen2(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is section_statement_matching (telc-style Lesen Teil 2, Selektives Verstehen). For each "
        "statement verify: (A) the section named in correctSectionId genuinely supports the statement's "
        "meaning based on selective information, author intention, paraphrase, inference, or argument "
        "structure — not superficial keyword overlap — UNSUPPORTED_CORRECT_ANSWER if not; (B) no OTHER "
        "section supports the statement equally well — if a second section could also plausibly match, use "
        "AMBIGUOUS_MAPPING with evidence.questionIds listing the statement's questionId. A section may "
        "legitimately support more than one statement — that alone is not ambiguity; ambiguity is when ONE "
        "statement is equally supported by TWO OR MORE sections. Part-wide: PART_WIDE_INCOHERENCE if the "
        "5 sections don't form one coherent text, or the register isn't C1-Hochschule-appropriate."
    )
    payload = {"sections": content.get("sections") or [], "questions": content.get("questions") or []}
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


def _verify_prompt_lesen3(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is detail_tristate_with_global_heading (telc-style Lesen Teil 3, Detail- und "
        "Globalverstehen). Judge STRICTLY from the supplied text only. Each item has a 'kind': "
        "'detail' items carry a tristate.answer that must be exactly one of richtig (text SUPPORTS the "
        "statement), falsch (text CONTRADICTS the statement), or nicht_im_text (text neither supports nor "
        "contradicts it — the statement is simply absent, not proven false). Verify the labeled answer is "
        "the correct one of these three for each detail item — use TRISTATE_VERDICT_MISMATCH if not. A "
        "common generation error is labeling a merely-absent statement as falsch instead of nicht_im_text, "
        "or labeling an actually-contradicted statement as nicht_im_text — check this distinction "
        "carefully. The single 'global_heading' item names a correctHeadingId among exactly 3 heading "
        "options: verify that heading is the single BEST summary of the ENTIRE text (not just one section) "
        "and that no other of the 3 options is an equally good global summary — use "
        "UNSUPPORTED_CORRECT_ANSWER if the marked heading doesn't fit, or AMBIGUOUS_MAPPING if a second "
        "heading is equally defensible as a global summary. Part-wide: PART_WIDE_INCOHERENCE if the text "
        "doesn't hang together as one coherent long text, or isn't C1-Hochschule-appropriate."
    )
    payload = {"text": content.get("text") or {}, "questions": content.get("questions") or []}
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


def _verify_prompt_sprachbausteine(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = _base_verifier_preamble(part) + (
        "\n\nThis is cloze_mc4_language_elements (telc-style Sprachbausteine). You are given the full text "
        "with numbered gaps and, per item, that item's own 4 options (options are per-item, not a shared "
        "pool). For each item verify: (A) the option at correctIndex genuinely fits the gap grammatically "
        "AND semantically in context — UNSUPPORTED_CORRECT_ANSWER if not; (B) no OTHER option among that "
        "item's own 4 also fits the gap equally well — if a second option could also plausibly fill it, use "
        "MULTIPLE_DEFENSIBLE_ANSWERS with evidence.optionIndexes listing both; (C) the three wrong options "
        "are genuinely plausible C1-level near-misses (a wrong case/ending, a confusable preposition, a "
        "near-synonym with a register/collocation problem, a plausible misspelling) rather than absurd or "
        "trivially eliminable — IMPLAUSIBLE_DISTRACTOR if an option is nonsensical or unrelated to the "
        "sentence; (D) reject an item that is answerable by pattern-matching alone without real C1 grammar/"
        "lexical/orthography knowledge — TRIVIAL_ITEM. Do not flag a mislabeled category (grammar/lexicon/"
        "orthography) by itself as an error unless it also makes the item too easy for C1 (in which case use "
        "TRIVIAL_ITEM) — a pure category-tag mismatch with a genuinely sound answer/distractors is not "
        "grounds for rejection. Part-wide: flag "
        "PART_WIDE_INCOHERENCE if the text doesn't read as one coherent original text, or isn't "
        "C1-Hochschule-appropriate academic/study-relevant register once the gaps are correctly filled."
    )
    text = content.get("text") or {}
    payload = {
        "text": {"title": text.get("title"), "paragraphs": text.get("paragraphs"), "gaps": text.get("gaps")},
        "questions": content.get("questions") or [],
    }
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


# ── Schreiben (writing) verify prompt ────────────────────────────────────
# Deliberately does NOT reuse _base_verifier_preamble() — that preamble's
# framing ("each intended answer is uniquely supported by the supplied
# transcript", "distractors/wrong options") describes OBJECTIVE-answer exam
# items and is simply false for a writing task, which has no correct answer,
# transcript, or distractors at all. This verifies task QUALITY only (is it
# answerable, clear, distinct, C1-appropriate, free of a leaked model
# answer) — it is NEVER run against a learner's own submitted essay, which
# german_exam_writing_grading.py sends to the existing Writing Coach
# evaluator instead. Reuses the same controlled issue-code vocabulary, JSON
# response shape, and generic duplicate-detection audit as every other task
# type, just with accurate instructions for what's actually being judged.
def _verify_prompt_schreiben(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = (
        "You are an INDEPENDENT quality reviewer for a GENERATED German writing-exam TASK "
        f"({part.task_type}, telc-style Schreiben). You are given exactly 2 generated topics the learner "
        "will choose between — there is NO correct answer, model solution, transcript, or distractor to "
        "judge; you are reviewing the TASK PROMPT itself, never a learner's response (that is graded "
        "separately, by a different system, against the learner's own submitted text). You must NOT "
        "improve, rewrite, or complete either topic. Do not request or output hidden reasoning/"
        "chain-of-thought — give only a concise issue code, one-sentence message, and evidence references. "
        "Reply with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        f"Allowed issue codes — you MUST only use codes from this exact list, never invent new ones: "
        f"{sorted(SEMANTIC_ISSUE_CODES)}.\n\n"
        "For each topic verify: (A) it is answerable by a C1 Hochschule candidate using general academic/"
        "study-related knowledge only, with clear, internally consistent, non-contradictory instructions "
        "about what to produce — use QUESTION_NOT_ANSWERABLE if it requires niche specialist/professional "
        "knowledge most candidates wouldn't have, or if the instructions are ambiguous or contradict "
        "themselves; (B) the register and subject matter fit C1 Hochschule academic/study-relevant writing "
        "— use OFF_LEVEL_CONTENT if it reads as a lower-level or non-academic everyday-life topic; (C) "
        "nothing in the prompt is or resembles a model answer, example response, or content a candidate "
        "could copy instead of writing their own text — use ANSWER_EXPOSED_IN_PROMPT if so. Also fill "
        "audit.duplicateItemIds with the OTHER topic's questionId if the two topics are not genuinely "
        "distinct (near-identical framing, the same underlying question restated, or one trivially "
        "subsumed by the other) — this uses DUPLICATE_INFORMATION, exactly like a duplicate detection "
        "elsewhere in this system. Part-wide: use PART_WIDE_INCOHERENCE if NEITHER topic is genuinely "
        "suitable for a ~350-word C1 Hochschule Schreiben response.\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "passed": false,\n'
        '  "partWideIssues": [{"code": "PART_WIDE_INCOHERENCE", "severity": "error", "message": "...", "evidence": {}}],\n'
        '  "items": [\n'
        '    {"questionId": "a", "audit": {"duplicateItemIds": []}, "passed": true, "issues": []},\n'
        '    {"questionId": "b", "audit": {"duplicateItemIds": ["a"]}, "passed": false, "issues": [\n'
        '      {"code": "DUPLICATE_INFORMATION", "severity": "error", "message": "...", "evidence": {}}\n'
        "    ]}\n"
        "  ]\n"
        "}\n"
        "Include EVERY topic's questionId from the supplied content in the items array, even ones with no "
        'issues (passed: true, issues: []). severity is "error" (blocks acceptance) or "warning" '
        "(informational, does not block acceptance). Set an item's passed to true exactly when it has no "
        "error issues. Set overall passed to true exactly when all items pass and no part-wide error "
        "exists. A warning alone must not set either passed flag to false."
    )
    system += (" Both supplied statements MUST represent distinguishable, contrasting, reasonably "
               "discussable positions, not paraphrases. Instructions MUST require engagement with BOTH "
               "positions; flag QUESTION_NOT_ANSWERABLE otherwise. Neither needs specialist knowledge. "
               "Set audit.contrastingStatements and audit.engagesBothStatements explicitly; false blocks acceptance.")
    payload = {"topics": content.get("questions") or []}
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


def _verify_prompt_speaking(part: PartBlueprint, content: dict[str, Any]) -> tuple[str, str]:
    system = (
        "Review GENERATED telc C1 Hochschule speaking TASKS only, never grade learner speech. "
        "Return the prescribed JSON verdict with every questionId and audit.duplicateItemIds. "
        "There is no correct answer. Flag QUESTION_NOT_ANSWERABLE for specialist knowledge or unclear instructions; "
        "OFF_LEVEL_CONTENT for unsuitable C1 content; ANSWER_EXPOSED_IN_PROMPT for model solutions. "
        "Presentation: two genuinely distinct university/study/general-academic topics, answerable without "
        "specialist knowledge in approximately three minutes, with introduction, structure and conclusion. "
        "Discussion: an understandable, genuinely debatable generated statement with no single correct answer; "
        "guiding points support interpretation, stance, reasons/examples and response to partner arguments. "
        "Do not accept fabricated attribution to a real person. Duplicate presentation choices must list the "
        "other questionId in duplicateItemIds. All deficiencies are errors that block acceptance. "
        f"Allowed issue codes: {sorted(SEMANTIC_ISSUE_CODES)}. "
        'Return {"passed":boolean,"partWideIssues":[],"items":[{"questionId":"...",'
        '"audit":{"duplicateItemIds":[]},"passed":boolean,"issues":[]}]}. '
        "Each issue has code, severity, message and evidence."
    )
    return system, json.dumps(content, ensure_ascii=False)


_VERIFY_PROMPT_BUILDERS = {
    "presentation_summary_followup": _verify_prompt_speaking,
    "quote_guided_discussion": _verify_prompt_speaking,
    "speaker_statement_matching": _verify_prompt_hv1,
    "sentence_completion_mc3": _verify_prompt_hv2,
    "structured_note_completion": _verify_prompt_hv3,
    "text_reconstruction_sentence_matching": _verify_prompt_lesen1,
    "section_statement_matching": _verify_prompt_lesen2,
    "detail_tristate_with_global_heading": _verify_prompt_lesen3,
    "cloze_mc4_language_elements": _verify_prompt_sprachbausteine,
    "choice_long_form_writing": _verify_prompt_schreiben,
}


def _parse_issue(raw: Any) -> SemanticIssue | None:
    if not isinstance(raw, dict):
        return SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Invalid issue object")
    code = raw.get("code")
    if not isinstance(code, str) or code not in SEMANTIC_ISSUE_CODES:
        log.warning("semantic verifier returned an unknown issue code")
        return SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "Unknown issue code")
    severity = raw.get("severity") if raw.get("severity") in ("error", "warning") else "error"
    message = str(raw.get("message") or "")[:500]  # concise judgment only, not chain-of-thought
    supplied = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    evidence = {}
    for key in ("segmentIds", "questionIds", "optionIndexes"):
        values = supplied.get(key)
        if isinstance(values, list):
            if key == "optionIndexes":
                evidence[key] = [value for value in values[:20] if type(value) is int and 0 <= value < 10]
            else:
                evidence[key] = [value[:100] for value in values[:20] if isinstance(value, str)]
    return SemanticIssue(code=code, severity=severity, message=message, evidence=evidence)


def _parse_result(data: Any, expected_item_ids: set[str]) -> SemanticVerificationResult:
    def invalid() -> SemanticVerificationResult:
        return SemanticVerificationResult(False, [SemanticIssue(
            "VERIFIER_RESPONSE_INVALID", "error", "Incomplete or inconsistent verifier response"
        )])

    if (not isinstance(data, dict) or type(data.get("passed")) is not bool
            or not isinstance(data.get("partWideIssues"), list)
            or not isinstance(data.get("items"), list)):
        return invalid()
    part_wide = [i for i in (_parse_issue(r) for r in (data.get("partWideIssues") or [])) if i is not None]

    items: list[ItemSemanticResult] = []
    seen_ids: set[str] = set()
    for raw_item in data.get("items") or []:
        if not isinstance(raw_item, dict):
            return invalid()
        item_id = raw_item.get("questionId")
        if (not isinstance(item_id, str) or item_id not in expected_item_ids
                or item_id in seen_ids or type(raw_item.get("passed")) is not bool
                or not isinstance(raw_item.get("issues"), list)):
            return invalid()
        seen_ids.add(item_id)
        issues = [i for i in (_parse_issue(r) for r in (raw_item.get("issues") or [])) if i is not None]
        passed = not any(i.severity == "error" for i in issues)
        if not raw_item["passed"] and passed:
            return invalid()
        part_wide.extend(i for i in issues if is_part_wide_only(i))
        items.append(ItemSemanticResult(item_id=item_id, passed=passed, issues=issues))

    # Any expected item the model silently omitted is treated as unverified
    # (fail closed), not as an implicit pass.
    missing = expected_item_ids - seen_ids
    for item_id in missing:
        items.append(ItemSemanticResult(
            item_id=item_id, passed=False,
            issues=[SemanticIssue(code="VERIFIER_RESPONSE_INVALID", severity="error", message="semantic verifier omitted this item from its response")],
        ))

    # A cross-item defect with explicit affected IDs still permits item repair.
    source_issues = []
    for issue in part_wide:
        targets = issue.evidence.get("questionIds", [])
        if (not is_part_wide_only(issue) and targets
                and all(target in seen_ids for target in targets)):
            for item in items:
                if item.item_id in targets and not any(i.code == issue.code for i in item.issues):
                    item.issues.append(issue)
                    item.passed = not any(i.severity == "error" for i in item.issues)
        else:
            source_issues.append(issue)
    part_wide = source_issues

    overall_passed = not any(i.severity == "error" for i in part_wide) and all(item.passed for item in items)
    if not data["passed"] and overall_passed:
        return invalid()
    return SemanticVerificationResult(passed=overall_passed, part_wide_issues=part_wide, items=items)


def _object_schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _verification_schema(part: PartBlueprint, content: dict[str, Any]) -> dict[str, Any]:
    strings = {"type": "array", "items": {"type": "string"}}
    issue = _object_schema({
        "code": {"type": "string", "enum": sorted(SEMANTIC_ISSUE_CODES)},
        "severity": {"type": "string", "enum": ["error", "warning"]},
        "message": {"type": "string"},
        "evidence": _object_schema({"segmentIds": strings, "questionIds": strings,
                                    "optionIndexes": {"type": "array", "items": {"type": "integer"}}}),
    })
    if part.task_type == "choice_long_form_writing":
        audit = _object_schema({"duplicateItemIds": strings, "contrastingStatements": {"type": "boolean"}, "engagesBothStatements": {"type": "boolean"}})
    elif part.task_type == "speaker_statement_matching":
        audit = _object_schema({"supportedSpeakerIds": strings, "plausible": {"type": "boolean"}})
    elif part.task_type == "sentence_completion_mc3":
        audit = _object_schema({"optionVerdicts": {"type": "array", "items": {
            "type": "string", "enum": ["supported", "plausible_wrong", "implausible_wrong"]}}})
    elif part.task_type == "structured_note_completion":
        audit = _object_schema({"duplicateItemIds": strings})
    elif part.task_type == "text_reconstruction_sentence_matching":
        audit = _object_schema({"bestCandidateId": {"type": ["string", "null"]}, "tiedCandidateIds": strings})
    elif part.task_type == "section_statement_matching":
        audit = _object_schema({"supportingSectionIds": strings})
    elif part.task_type == "detail_tristate_with_global_heading":
        audit = _object_schema({
            "trueVerdict": {"type": ["string", "null"], "enum": ["richtig", "falsch", "nicht_im_text", None]},
            "bestHeadingId": {"type": ["string", "null"]},
            "tiedHeadingIds": strings,
        })
    elif part.task_type == "cloze_mc4_language_elements":
        audit = _object_schema({"optionVerdicts": {"type": "array", "items": {
            "type": "string", "enum": ["supported", "plausible_wrong", "implausible_wrong"]}}})
    else:
        audit = _object_schema({"duplicateItemIds": strings})
    issues = {"type": "array", "items": issue}
    item = _object_schema({"questionId": {"type": "string", "enum": [q["questionId"] for q in content["questions"]]},
                           "audit": audit, "passed": {"type": "boolean"}, "issues": issues})
    return _object_schema({"passed": {"type": "boolean"}, "partWideIssues": issues,
                           "items": {"type": "array", "items": item}})


def _apply_audits(result: SemanticVerificationResult, data: dict, part: PartBlueprint, content: dict) -> SemanticVerificationResult:
    supplied_items = data.get("items")
    if not isinstance(supplied_items, list):
        return _parse_result(None, set())
    raw_items = {item["questionId"]: item for item in supplied_items
                 if isinstance(item, dict) and isinstance(item.get("questionId"), str)}
    questions = {q["questionId"]: q for q in content["questions"]}
    speakers = {s["speakerId"] for s in content.get("segments") or []}
    for item in result.items:
        audit = raw_items.get(item.item_id, {}).get("audit", {})
        if not isinstance(audit, dict):
            audit = {}
        question = questions[item.item_id]
        code = None
        if part.task_type == "choice_long_form_writing":
            for criterion in ("contrastingStatements", "engagesBothStatements"):
                if audit.get(criterion) is not True:
                    item.issues.append(SemanticIssue("QUESTION_NOT_ANSWERABLE", "error", f"Writing input failed {criterion}"))
        if part.task_type == "speaker_statement_matching":
            values = audit.get("supportedSpeakerIds")
            if not isinstance(values, list) or any(not isinstance(v, str) or v not in speakers for v in values):
                code = "VERIFIER_RESPONSE_INVALID"
            elif question["matching"].get("isDistractor"):
                if type(audit.get("plausible")) is not bool:
                    code = "VERIFIER_RESPONSE_INVALID"
                elif values:
                    code = "DISTRACTOR_ACCIDENTALLY_CORRECT"
                elif not audit["plausible"]:
                    code = "IMPLAUSIBLE_DISTRACTOR"
            elif question["matching"]["correctSpeakerId"] not in values:
                code = "UNSUPPORTED_CORRECT_ANSWER"
            elif len(set(values)) > 1:
                code = "AMBIGUOUS_MAPPING"
        elif part.task_type == "sentence_completion_mc3":
            values = audit.get("optionVerdicts")
            if (not isinstance(values, list) or len(values) != 3
                    or any(v not in ("supported", "plausible_wrong", "implausible_wrong") for v in values)):
                code = "VERIFIER_RESPONSE_INVALID"
            elif "implausible_wrong" in values:
                code = "IMPLAUSIBLE_DISTRACTOR"
            elif values.count("supported") > 1:
                code = "MULTIPLE_DEFENSIBLE_ANSWERS"
            elif values[question["mc3"]["correctIndex"]] != "supported":
                code = "UNSUPPORTED_CORRECT_ANSWER"
        elif part.task_type == "cloze_mc4_language_elements":
            values = audit.get("optionVerdicts")
            if (not isinstance(values, list) or len(values) != 4
                    or any(v not in ("supported", "plausible_wrong", "implausible_wrong") for v in values)):
                code = "VERIFIER_RESPONSE_INVALID"
            elif "implausible_wrong" in values:
                code = "IMPLAUSIBLE_DISTRACTOR"
            elif values.count("supported") > 1:
                code = "MULTIPLE_DEFENSIBLE_ANSWERS"
            elif values[question["correctIndex"]] != "supported":
                code = "UNSUPPORTED_CORRECT_ANSWER"
        elif part.task_type == "text_reconstruction_sentence_matching":
            best = audit.get("bestCandidateId")
            tied = audit.get("tiedCandidateIds")
            if not isinstance(tied, list) or any(not isinstance(v, str) for v in tied):
                code = "VERIFIER_RESPONSE_INVALID"
            elif not isinstance(best, str):
                code = "VERIFIER_RESPONSE_INVALID"
            elif best != question.get("correctCandidateId"):
                code = "UNSUPPORTED_CORRECT_ANSWER"
            elif tied:
                code = "AMBIGUOUS_MAPPING"
        elif part.task_type == "section_statement_matching":
            values = audit.get("supportingSectionIds")
            if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
                code = "VERIFIER_RESPONSE_INVALID"
            elif question.get("correctSectionId") not in values:
                code = "UNSUPPORTED_CORRECT_ANSWER"
            elif len(set(values)) > 1:
                code = "AMBIGUOUS_MAPPING"
        elif part.task_type == "detail_tristate_with_global_heading":
            kind = question.get("kind")
            if kind == "detail":
                true_verdict = audit.get("trueVerdict")
                if true_verdict not in ("richtig", "falsch", "nicht_im_text"):
                    code = "VERIFIER_RESPONSE_INVALID"
                elif true_verdict != (question.get("tristate") or {}).get("answer"):
                    code = "TRISTATE_VERDICT_MISMATCH"
            elif kind == "global_heading":
                best = audit.get("bestHeadingId")
                tied = audit.get("tiedHeadingIds")
                if not isinstance(best, str) or not isinstance(tied, list) or any(not isinstance(v, str) for v in tied):
                    code = "VERIFIER_RESPONSE_INVALID"
                elif best != (question.get("heading") or {}).get("correctHeadingId"):
                    code = "UNSUPPORTED_CORRECT_ANSWER"
                elif tied:
                    code = "AMBIGUOUS_MAPPING"
            else:
                code = "VERIFIER_RESPONSE_INVALID"
        else:
            values = audit.get("duplicateItemIds")
            if not isinstance(values, list) or any(not isinstance(v, str) or v not in questions or v == item.item_id for v in values):
                code = "VERIFIER_RESPONSE_INVALID"
            elif values:
                code = "DUPLICATE_INFORMATION"
        if code and not any(issue.code == code for issue in item.issues):
            item.issues.append(SemanticIssue(code, "error", "Explicit item audit failed this criterion"))
        item.passed = not any(issue.severity == "error" for issue in item.issues)
    result.passed = result.passed and all(item.passed for item in result.items)
    return result


def verify_semantic(part: PartBlueprint, content: dict[str, Any], *, max_tokens: int | None = None) -> SemanticVerificationResult:
    """One batched call for the whole part. Deliberately does NOT receive the
    adaptation plan or topic-selection rationale — the verifier judges the
    frozen content on its own merits, not biased by why it was generated."""
    if part.task_type == "quote_guided_discussion":
        content = {"questions": [{"questionId": "discussion", **content}]}
    builder = _VERIFY_PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        return SemanticVerificationResult(
            passed=False,
            part_wide_issues=[SemanticIssue(code="PART_WIDE_INCOHERENCE", severity="error", message=f"no semantic verifier for task_type {part.task_type!r}")],
        )
    expected_ids = {q.get("questionId") for q in (content.get("questions") or []) if q.get("questionId")}
    system, user = builder(part, content)
    system += "\nJudge C1 Hochschule level and academic register."
    if part.module == "listening":
        system += " Validate evidenceSegmentIds against spokenText."
    system += "\nFor EVERY item fill its audit before its verdict. "
    if part.task_type == "speaker_statement_matching":
        system += (
            "HV1 supportedSpeakerIds lists EVERY speaker whose full statement supports the written "
            "proposition (empty for a valid distractor). If two speakers express the same supported view, "
            "list BOTH IDs even when only one is keyed correct. HV1 plausible is true for reasonable "
            "topic-related positions, false for absurd straw-man claims such as prohibiting every "
            "alternative to private cars in a sustainability debate. Being false or contradicted by "
            "speakers does NOT by itself make a distractor implausible. "
        )
    elif part.task_type == "sentence_completion_mc3":
        system += (
            "HV2 optionVerdicts classifies EACH of the three options in order: supported, plausible_wrong, "
            "or implausible_wrong. An absurd option is implausible_wrong even if the correct answer is "
            "clear. Judge the complete stem-plus-option, including negative stems. Plausible wrong options "
            "must reflect a concrete nearby detail or a reasonable misinterpretation, not an invented "
            "policy contrary to the entire premise of the discussion. "
        )
    elif part.task_type == "structured_note_completion":
        system += (
            "HV3 duplicateItemIds lists ALL other fields requesting the same fact. Check every pair, "
            "including identical fields. "
        )
    elif part.task_type == "text_reconstruction_sentence_matching":
        system += (
            "bestCandidateId is whichever of the 8 candidates (not just the keyed one) genuinely fits this "
            "gap best; tiedCandidateIds lists every OTHER candidate that fits equally well (empty if the "
            "keyed candidate is the unique best fit). Consider grammar, connectors, and logical progression "
            "with the surrounding paragraphs, not just topical relevance. "
        )
    elif part.task_type == "section_statement_matching":
        system += (
            "supportingSectionIds lists EVERY section (not just the keyed one) that genuinely supports the "
            "statement's meaning. A section may legitimately support more than one statement — that alone "
            "is not ambiguity. "
        )
    elif part.task_type == "detail_tristate_with_global_heading":
        system += (
            "For a 'detail' item, trueVerdict is your own independent classification of the statement as "
            "richtig (text supports it), falsch (text contradicts it), or nicht_im_text (text neither "
            "supports nor contradicts it — merely absent); leave bestHeadingId/tiedHeadingIds null/empty. "
            "For the 'global_heading' item, bestHeadingId is whichever of the 3 options best summarizes the "
            "WHOLE text, tiedHeadingIds lists any other option that is an equally good global summary "
            "(not just a good detail-level description); leave trueVerdict null. "
        )
    elif part.task_type == "cloze_mc4_language_elements":
        system += (
            "Sprachbausteine optionVerdicts classifies EACH of the item's own 4 options in order: supported, "
            "plausible_wrong, or implausible_wrong. A wrong option is implausible_wrong only if it is "
            "nonsensical/unrelated in context, not merely wrong — a real C1-level near-miss (wrong case, "
            "confusable preposition, near-synonym with a collocation/register problem, plausible misspelling) "
            "is plausible_wrong, not implausible_wrong. "
        )
    elif part.task_type == "choice_long_form_writing":
        system += (
            "Schreiben duplicateItemIds lists the OTHER topic's questionId if the two topics are not "
            "genuinely distinct (near-identical framing, the same underlying question restated, or one "
            "trivially subsumed by the other) — empty otherwise. There is no correct answer to verify for "
            "this task type; do not use UNSUPPORTED_CORRECT_ANSWER or AMBIGUOUS_MAPPING here. "
        )
    system += "Use the appropriate issue codes for audit failures. Return concise judgments only, not explanations of your reasoning process."
    user = json.dumps({"blueprint": {"taskType": part.task_type, "constraints": part.constraints}}, ensure_ascii=False) + "\n" + user
    try:
        model = get_settings().german_exam_model
        # german_exam_model defaults to a gpt-5-class reasoning model, whose
        # hidden reasoning tokens are drawn from the SAME max_completion_tokens
        # budget as the visible JSON (see llm_json._token_limit_param). A flat
        # 10000 was sized for smaller item counts; Sprachbausteine's 22-item
        # cloze verification asks for 4 optionVerdicts per item (88 total, the
        # largest judgment payload of any task type here) and was observed
        # live truncating mid-JSON (VERIFIER_RESPONSE_INVALID) under that same
        # fixed budget. Scale by item count instead of raising it globally —
        # unchanged (10000 floor) for every task type with <=15 items.
        item_count = len(content.get("questions") or [])
        verify_max_tokens = max_tokens if max_tokens is not None else max(10000, 6000 + item_count * 400)
        result = chat_json(system=system, user=user, max_tokens=verify_max_tokens,
                           model=model, json_schema=_verification_schema(part, content),
                           reasoning_effort="medium" if model.startswith("gpt-5") else None)
    except Exception:
        log.warning("Semantic verifier call failed", exc_info=True)
        return _parse_result(None, expected_ids)
    parsed = _parse_result(result.data, expected_ids)
    final = _apply_audits(parsed, result.data, part, content) if isinstance(result.data, dict) else parsed
    final.usage = {"completionTokens": int(result.completion_tokens or 0),
                   "reasoningTokens": int(getattr(result, "reasoning_tokens", 0) or 0)}
    return final


def is_part_wide_only(issue: SemanticIssue) -> bool:
    return issue.code in _PART_WIDE_ONLY_CODES
