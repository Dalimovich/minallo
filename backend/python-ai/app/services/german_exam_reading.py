"""Shared German Exam Engine — Lesen (reading) module adapter.

Mirrors german_exam_listening.py's pipeline shape exactly (LLM generation ->
deterministic validation+repair -> semantic verification+repair ->
re-validation -> accept, bounded regeneration), but with two deliberate
differences called out during review:

  - Content has no audio/segments concept at all — no TTS, no
    evidenceSegmentIds; evidence (where it exists) points at paragraph or
    section ids instead.
  - text_reconstruction_sentence_matching (lesen_1) semantic item-errors are
    NEVER routed to targeted per-item repair. A "two candidates both fit
    this gap" defect can live in the shared `candidates` array or in the
    surrounding `text`, neither of which repair_items_semantic() can reach
    (it only ever replaces one `questions` entry) — so lesen_1 always falls
    back to a full part regeneration instead of building a new
    candidate/text-level repair path. lesen_2/lesen_3 keep targeted repair
    since their defects are genuinely contained in one `questions` entry.
"""

from __future__ import annotations

import json
import logging
from .gen_timing import ContextThreadPoolExecutor as ThreadPoolExecutor
from time import perf_counter
from typing import Any

from ..config import get_settings

from .german_exam_adaptation import AdaptationInstruction
from .german_exam_profiles import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full as verify_semantic
from .german_exam_semantic_repair import repair_items_semantic
from .german_exam_semantic_verify import SemanticVerificationResult
from .german_exam_validator import ValidationIssue, hard_issues, validate_content
from .llm_json import chat_json

log = logging.getLogger(__name__)

_MAX_ITEM_REPAIR_ATTEMPTS = 2
_MAX_FULL_REGENERATIONS = 2
_MAX_SEMANTIC_REPAIR_ROUNDS = 2

# lesen_1's semantic defects can live outside any single `questions` entry
# (see module docstring) — never attempt targeted item repair for it.
_NO_ITEM_LEVEL_SEMANTIC_REPAIR = frozenset({"text_reconstruction_sentence_matching"})


class ReadingGenerationError(Exception):
    pass


def _adaptation_guidance(instructions: list[AdaptationInstruction]) -> str:
    if not instructions:
        return "No specific weakness data yet — generate balanced, exam-representative content covering the part's normal range of skills."
    lines = ["Content-difficulty guidance (do NOT change item count, task type, option count, or any structural rule):"]
    for instr in instructions:
        lines.append(f"- {instr.direction} {instr.axis.replace('_', ' ')} for content touching: {', '.join(instr.target_tags)}.")
    return "\n".join(lines)


def _base_system_preamble(profile: ExamProfile, part: PartBlueprint) -> str:
    return (
        f"You generate ORIGINAL German reading-exam practice content for {profile.family} "
        f"{profile.variant or ''} ({part.title}), matching the official {part.task_type} task format. "
        "You must NOT copy any real exam content — generate an entirely new, coherent academic or "
        "study-relevant text with the same structure and difficulty. Reply with ONLY valid JSON, no "
        "markdown fences, no commentary."
    )


# ── Lesen 1: text_reconstruction_sentence_matching ──────────────────────────


def _prompt_lesen1(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    gap_count = part.constraints.get("gapCount", 6)
    candidate_count = part.constraints.get("candidateCount", 8)
    unused = part.constraints.get("unusedCandidates", 2)
    word_min = part.constraints.get("wordCountMin", 400)
    word_max = part.constraints.get("wordCountMax", 500)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one coherent academic/study-relevant text of "
        f"{word_min}-{word_max} words on the topic '{topic['label']}', split into paragraphs, with "
        f"exactly {gap_count} gaps marked inline in the paragraph text as the literal placeholder "
        '"{{gapId}}" (e.g. "{{g1}}") at the point a sentence was removed. Then exactly '
        f"{candidate_count} candidate sentences, of which exactly {gap_count} correctly fill exactly one "
        f"gap each (a bijection — no gap gets two candidates, no candidate fills two gaps) and exactly "
        f"{unused} are never correct for any gap. The correct fit for each gap must depend on discourse "
        "structure, reference resolution (pronouns/articles pointing back or forward), connectors, and "
        "logical progression — NOT on topic keyword overlap alone; a reader must be able to reconstruct "
        "the text by reasoning about cohesion. The two unused candidates must remain plausible-sounding on "
        "the topic (not absurd or unrelated) so they function as real distractors, but must not actually "
        "fit any gap grammatically or logically once checked carefully.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: use "
        "reference_resolution when the gap hinges on a pronoun/article pointing to specific prior/later "
        "content, text_structure when it's about paragraph-level organization, argument_structure when "
        "it's about how a claim/counterclaim/example connects, paraphrase_mapping when recognizing a "
        "reworded idea is what's needed. Use at least 3 different tags across the 6 items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "text": {\n'
        '    "title": "...",\n'
        '    "paragraphs": ["Erster Absatz ... {{g1}} ... weiter.", "Zweiter Absatz ... {{g2}} ..."],\n'
        f'    "gaps": [{{"gapId": "g1"}}, {{"gapId": "g2"}}, ...] // exactly {gap_count} entries\n'
        "  },\n"
        f'  "candidates": [{{"candidateId": "c1", "text": "..."}}, ...] // exactly {candidate_count} entries\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "gapId": "g1", "correctCandidateId": "c4",\n'
        '     "skillTags": ["reference_resolution"], "difficulty": "c1"},\n'
        '    ...\n'
        f'  ] // exactly {gap_count} entries, one per gap\n'
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


# ── Lesen 2: section_statement_matching ─────────────────────────────────────


def _prompt_lesen2(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    section_count = part.constraints.get("sectionCount", 5)
    statement_count = part.constraints.get("statementCount", 6)
    word_min = part.constraints.get("wordCountMin", 650)
    word_max = part.constraints.get("wordCountMax", 850)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one coherent academic/study-relevant text of "
        f"{word_min}-{word_max} words on the topic '{topic['label']}', divided into exactly "
        f"{section_count} labeled sections (sectionId 'a'..'{chr(ord('a') + section_count - 1)}'). Then "
        f"exactly {statement_count} statements, each mapping to exactly ONE section that genuinely "
        "supports it. A single section MAY legitimately be the correct match for more than one "
        "statement — that is allowed and expected, not an error. Statements must test more than keyword "
        "overlap: they should ask what the author criticizes, regrets, emphasizes, explains, recommends, "
        "or contrasts, or require selective information retrieval, paraphrase mapping, or inference — not "
        "be answerable by scanning for a repeated word.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: use "
        "selective_information when it's about locating one specific fact/detail, author_intention when "
        "it's about what the author does rhetorically (criticize/recommend/contrast/etc.), "
        "paraphrase_mapping when the statement rewords the section's content, inference when it requires "
        "reading between the lines, argument_structure when it's about how a claim relates to its support, "
        "global_comprehension when it needs the section's overall gist. Use at least 3 different tags "
        f"across the {statement_count} items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "sections": [{"sectionId": "a", "text": "..."}, ...] // exactly '
        f'{section_count} entries\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "statement": "...", "correctSectionId": "c",\n'
        '     "skillTags": ["author_intention"], "difficulty": "c1"},\n'
        '    ...\n'
        f'  ] // exactly {statement_count} entries\n'
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


# ── Lesen 3: detail_tristate_with_global_heading ────────────────────────────


def _prompt_lesen3(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    detail_count = part.constraints.get("detailItemCount", 11)
    heading_options = part.constraints.get("globalHeadingOptionCount", 3)
    word_min = part.constraints.get("wordCountMin", 1000)
    word_max = part.constraints.get("wordCountMax", 1200)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one longer coherent academic/study-relevant text of "
        f"{word_min}-{word_max} words on the topic '{topic['label']}', split into paragraphs each with a "
        'stable "paragraphId" (p1, p2, ...). Then exactly '
        f"{detail_count} detail items (kind: \"detail\"), in the ORDER the relevant information appears "
        "in the text, each a statement with a tristate.answer that is exactly one of:\n"
        "  - richtig: the text SUPPORTS the statement\n"
        "  - falsch: the text actively CONTRADICTS the statement\n"
        "  - nicht_im_text: the text neither supports nor contradicts it — the statement is simply absent, "
        "not proven false\n"
        "This distinction matters enormously: do not label a merely-absent statement as falsch, and do not "
        "label an actually-contradicted statement as nicht_im_text. Include a genuine mix of all three "
        "answers across the items (not mostly one value). For richtig/falsch items, "
        "tristate.evidenceParagraphIds must list the paragraphId(s) that support or contradict the "
        "statement. For a genuine nicht_im_text item there is no positive evidence paragraph proving "
        "absence — set tristate.evidenceParagraphIds to an empty array rather than inventing one.\n\n"
        f"Then exactly ONE additional item (kind: \"global_heading\") with a heading.options array of "
        f"exactly {heading_options} candidate headings/titles and heading.correctHeadingId naming the ONE "
        "heading that best summarizes the text AS A WHOLE (not just one section/paragraph). The other "
        f"{heading_options - 1} options should each plausibly describe a PART of the text or a slightly "
        "too-narrow/too-broad framing, so they are real distractors, but neither should be an equally good "
        "global summary.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item: use "
        "detail_comprehension for items needing a specific fact check, inference for items requiring "
        "reading between the lines, text_structure/argument_structure where the item hinges on how the "
        "text is organized or how a claim is supported, global_comprehension for the heading item. Use at "
        f"least 3 different tags across the {detail_count + 1} items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly (the skillTags below are illustrative, not literal — pick tags that "
        "actually fit each item per the guidance above):\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": [{"paragraphId": "p1", "text": "..."}, ...]},\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "kind": "detail", "statement": "...",\n'
        '     "tristate": {"answer": "richtig", "evidenceParagraphIds": ["p3"]},\n'
        '     "skillTags": ["detail_comprehension"], "difficulty": "c1"},\n'
        '    ... (10 more detail items, in text order, exactly one of which uses "nicht_im_text" '
        'with evidenceParagraphIds: []) ,\n'
        '    {"questionId": "q12", "kind": "global_heading",\n'
        '     "heading": {"options": [{"headingId": "h1", "text": "..."}, {"headingId": "h2", "text": "..."}, '
        '{"headingId": "h3", "text": "..."}], "correctHeadingId": "h2"},\n'
        '     "skillTags": ["global_comprehension"], "difficulty": "c1"}\n'
        f"  ] // exactly {detail_count} \"detail\" items followed by exactly 1 \"global_heading\" item\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


_PROMPT_BUILDERS = {
    "text_reconstruction_sentence_matching": _prompt_lesen1,
    "section_statement_matching": _prompt_lesen2,
    "detail_tristate_with_global_heading": _prompt_lesen3,
}


def _repair_prompt(part: PartBlueprint, content: dict[str, Any], issue: ValidationIssue) -> tuple[str, str]:
    system = (
        f"You are repairing ONE invalid item in a generated German reading exercise "
        f"({part.task_type}). The item with questionId={issue.item_id!r} failed validation: "
        f"{issue.message}. Return ONLY a JSON object for the corrected single question item, in the "
        "exact same shape as the other items in the 'questions' array of the original content. Do not "
        "change its questionId. Reply with ONLY valid JSON, no markdown fences, no commentary."
    )
    user = f"Original content for context:\n{json.dumps(content, ensure_ascii=False)}\n\nFix item {issue.item_id!r}."
    return system, user


def _repair_items(part: PartBlueprint, content: dict[str, Any], issues: list[ValidationIssue]) -> dict[str, Any]:
    """Deterministic, structural per-item repair — unrelated to semantic
    repair. Identical shape to german_exam_listening.py's version (already
    task_type/module agnostic)."""
    by_item: dict[str, ValidationIssue] = {}
    for issue in issues:
        if issue.item_id and issue.hard:
            by_item[issue.item_id] = issue

    if not by_item:
        return content

    questions_by_id = {q.get("questionId"): q for q in content.get("questions") or []}

    def _fix_one(item_id: str, issue: ValidationIssue) -> tuple[str, dict[str, Any] | None]:
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _repair_prompt(part, content, issue)
                result = chat_json(system=system, user=user, max_tokens=800, model=get_settings().german_exam_model)
                fixed = result.data
                if isinstance(fixed, dict) and fixed.get("questionId") == item_id:
                    return item_id, fixed
            except Exception:  # noqa: BLE001
                log.warning("repair attempt failed for item %s", item_id, exc_info=True)
        return item_id, None

    with ThreadPoolExecutor(max_workers=min(4, len(by_item))) as pool:
        results = list(pool.map(lambda kv: _fix_one(kv[0], kv[1]), by_item.items()))

    for item_id, fixed in results:
        if fixed is not None:
            questions_by_id[item_id] = fixed

    content = dict(content)
    content["questions"] = [
        questions_by_id.get(q.get("questionId"), q) for q in content.get("questions") or []
    ]
    return content


def _postprocess(part: PartBlueprint, content: dict[str, Any]) -> dict[str, Any]:
    # No evidence postprocessors needed for reading — evidence is
    # LLM-supplied (paragraph ids), like Hören's HV2/HV3. Kept for
    # pipeline-shape parity with generate_listening_part.
    return content


def _semantic_phase(part: PartBlueprint, content: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Same shape as german_exam_listening.py's _semantic_phase, with one
    addition: for lesen_1, item-level semantic errors are treated like a
    part-wide error (stop immediately, caller falls back to full
    regeneration) instead of being sent to repair_items_semantic() — see
    module docstring."""
    started = perf_counter()
    verification_count = 0
    repair_count = 0
    issues_resolved: list[dict[str, str]] = []
    issue_counts: dict[str, int] = {}

    def record_findings(result: SemanticVerificationResult) -> None:
        findings = list(result.part_wide_issues)
        findings.extend(issue for item in result.items for issue in item.issues)
        for issue in findings:
            issue_counts[issue.code] = issue_counts.get(issue.code, 0) + 1

    def check() -> SemanticVerificationResult:
        nonlocal verification_count
        result: SemanticVerificationResult | None = None
        for attempt in range(2):
            result = verify_semantic(part, content)
            record_findings(result)
            verification_count += 1
            findings = list(result.part_wide_issues) + [issue for item in result.items for issue in item.issues]
            if not any(issue.code == "VERIFIER_RESPONSE_INVALID" for issue in findings):
                return result
        assert result is not None
        return result

    result = check()

    for _round in range(_MAX_SEMANTIC_REPAIR_ROUNDS):
        part_wide_errors = result.part_wide_error_issues()
        item_errors = result.item_error_issues()
        if not part_wide_errors and not item_errors:
            break
        if any(issue.code == "VERIFIER_RESPONSE_INVALID" for issues in item_errors.values() for issue in issues):
            break
        if part_wide_errors:
            break
        if part.task_type in _NO_ITEM_LEVEL_SEMANTIC_REPAIR:
            # lesen_1: an item-level semantic error may actually live in the
            # shared candidates array or the surrounding text — not
            # repairable at item level. Stop here; caller falls back to a
            # full regeneration.
            break

        content, resolved = repair_items_semantic(part, content, item_errors)
        repair_count += len(item_errors)
        issues_resolved.extend(resolved)
        content = _postprocess(part, content)

        if hard_issues(validate_content(part, content)):
            log.warning("semantic repair for part %s broke deterministic structure — abandoning item-level repair", part.part_id)
            break

        result = check()

    passed = result.passed and not hard_issues(validate_content(part, content))
    meta = {
        "passed": passed,
        "verificationCount": verification_count,
        "repairCount": repair_count,
        "issuesResolved": issues_resolved if passed else [],
        "issueCounts": issue_counts,
        "durationMs": round((perf_counter() - started) * 1000),
    }
    return content, meta, passed


def generate_reading_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). Pipeline: LLM generation ->
    deterministic validation (+ targeted repair) -> semantic verification
    (+ targeted repair, except lesen_1 which always regenerates on semantic
    item errors) -> deterministic re-validation -> semantic re-verification
    -> accept. Raises ReadingGenerationError rather than ever returning
    known-invalid content once the regeneration budget is exhausted."""
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise ReadingGenerationError(f"no prompt builder for task_type {part.task_type!r}")

    last_issues: list[ValidationIssue] = []
    last_semantic: dict[str, Any] | None = None
    semantic_totals = {"verificationCount": 0, "repairCount": 0, "durationMs": 0}
    total_det_repairs = 0
    total_issue_counts: dict[str, int] = {}

    for regeneration in range(_MAX_FULL_REGENERATIONS + 1):
        system, user = builder(profile, part, plan, topic)
        result = chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model)
        content = result.data if isinstance(result.data, dict) else {}
        content = _postprocess(part, content)

        issues = validate_content(part, content)
        h_issues = hard_issues(issues)

        part_level = [i for i in h_issues if i.item_id is None]
        if part_level and regeneration < _MAX_FULL_REGENERATIONS:
            last_issues = h_issues
            continue

        item_level = [i for i in h_issues if i.item_id is not None]
        det_repair_count = 0
        if item_level:
            content = _repair_items(part, content, item_level)
            content = _postprocess(part, content)
            det_repair_count = len(item_level)
            total_det_repairs += det_repair_count
            issues = validate_content(part, content)
            h_issues = hard_issues(issues)

        if h_issues:
            last_issues = h_issues
            if regeneration < _MAX_FULL_REGENERATIONS:
                continue
            raise ReadingGenerationError(
                f"could not produce a deterministically valid {part.task_type} part after "
                f"{_MAX_FULL_REGENERATIONS} regenerations: "
                + "; ".join(f"{i.item_id}: {i.message}" for i in last_issues)
            )

        content, semantic_meta, semantic_ok = _semantic_phase(part, content)
        for key in semantic_totals:
            semantic_totals[key] += semantic_meta[key]
        for code, count in semantic_meta["issueCounts"].items():
            total_issue_counts[code] = total_issue_counts.get(code, 0) + count
        log.info("german_exam_semantic part=%s regeneration=%s passed=%s verificationCount=%s repairCount=%s issueCounts=%s",
                 part.part_id, regeneration, semantic_ok, semantic_meta["verificationCount"], semantic_meta["repairCount"], semantic_meta["issueCounts"])
        if semantic_ok:
            semantic_meta.update(semantic_totals)
            semantic_meta["issueCounts"] = total_issue_counts
            semantic_meta["regenerationCount"] = regeneration
            return content, {
                "deterministicPassed": True,
                "deterministicRepairCount": total_det_repairs,
                "semantic": semantic_meta,
            }

        last_semantic = semantic_meta
        if regeneration < _MAX_FULL_REGENERATIONS:
            continue
        raise ReadingGenerationError(
            f"could not produce semantically valid {part.task_type} content after "
            f"{_MAX_FULL_REGENERATIONS} regenerations: {last_semantic}"
        )

    raise ReadingGenerationError(f"unreachable: exhausted regeneration budget for {part.task_type!r}")
