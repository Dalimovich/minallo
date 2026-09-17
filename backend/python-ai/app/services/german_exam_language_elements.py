"""Shared German Exam Engine — Sprachbausteine (language elements) module adapter.

Constraint-decomposed pipeline (2026-09-17 rework). The original design asked
one LLM call to simultaneously satisfy every hard constraint of the part at
once: a 320-350 word passage, exactly 22 gap placeholders, exactly 22 MCQ
items with 4 distinct options and a correctIndex each, and an exact
grammar/lexicon/orthography split summing to 22. A production smoke run
found gpt-5.4-mini reliably missing at least one of those simultaneously
(444/524/804-word passages, a run with zero gaps, wrong category splits) even
across several full regenerations — the model was being asked to count and
enforce a dozen things a computer does exactly and for free, and every
failure threw away the whole (expensive) generation.

This version has the backend own everything deterministic and only asks the
LLM for the two things a computer can't do: writing natural German prose, and
writing plausible wrong answers.

  1. The backend picks the category for all 22 gaps up front (_CATEGORY_PLAN,
     interleaved by _build_gap_specs so it doesn't read as "all grammar, then
     all lexicon").
  2. Stage A asks the LLM for ONLY the passage + the correct answer per gap
     (no distractors, no correctIndex, no category counting). A word-count
     miss gets a cheap in-place passage rewrite instead of a full
     regeneration; only a structurally broken passage (wrong/missing/
     duplicate placeholders, missing answers) triggers a full Stage A retry.
  3. Stage B asks the LLM for ONLY three wrong options per gap, given the
     already-correct passage and answers. The backend inserts the correct
     answer, shuffles, and computes correctIndex itself — the model never
     manages an index. A bad gap's distractors get repaired individually
     (mirrors german_exam_reading.py's item-level repair), never forcing a
     full Stage A or Stage B redo for one bad item.
  4. The existing deterministic validator (german_exam_validator.py) and
     semantic verifier still run, unchanged, as the final authority over the
     assembled content — this file only changed how content gets built, not
     what "valid" means or the content shape the frontend receives.
"""

from __future__ import annotations

import json
import logging
import random
import re
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter
from typing import Any

from ..config import get_settings

from .german_exam_adaptation import AdaptationInstruction
from .german_exam_profiles import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full as verify_semantic
from .german_exam_semantic_repair import repair_items_semantic
from .german_exam_semantic_verify import SemanticVerificationResult
from .german_exam_validator import hard_issues, validate_content
from .llm_json import LlmResult, chat_json

log = logging.getLogger(__name__)

# Full-generation retries are now the LAST resort, not the primary repair
# mechanism — each stage below has its own, much cheaper repair path first.
_MAX_STAGE_A_REGENERATIONS = 2
_MAX_PASSAGE_REPAIR_ATTEMPTS = 2
_MAX_STAGE_B_REGENERATIONS = 2
_MAX_ITEM_REPAIR_ATTEMPTS = 2
_MAX_SEMANTIC_REPAIR_ROUNDS = 2

_GAP_PLACEHOLDER_RE = re.compile(r"\{\{(g\d+)\}\}")


class LanguageElementsGenerationError(Exception):
    pass


# Backend-owned category allocation — one fixed, exam-representative split,
# safely inside telc_c1_hochschule's sprachbausteine_1 blueprint ranges
# (grammar 12-16, lexicon 4-8, orthography 1-4, summing to itemCount=22).
# The LLM is never asked to choose or count these.
_CATEGORY_PLAN: tuple[tuple[str, int], ...] = (("grammar", 14), ("lexicon", 6), ("orthography", 2))

# Every part.allowed_skill_tags value is assigned to exactly one category,
# matching the categories' own definitions (grammar: verb forms/cases/
# connectors/prepositions/syntax; lexicon: collocations/word choice/word
# formation; orthography: spelling/capitalization/punctuation — the only
# tag left for it in the controlled vocabulary is "register").
_CATEGORY_SKILL_TAGS: dict[str, tuple[str, ...]] = {
    "grammar": ("grammar", "connectors", "prepositions", "syntax"),
    "lexicon": ("word_formation", "collocation", "lexical_choice"),
    "orthography": ("register",),
}


def _validate_category_plan(part: PartBlueprint) -> None:
    item_count = part.constraints.get("itemCount", 22)
    total = sum(n for _, n in _CATEGORY_PLAN)
    if total != item_count:
        raise LanguageElementsGenerationError(f"category plan totals {total}, expected itemCount {item_count}")
    bounds = {
        "grammar": (part.constraints.get("grammarCountMin", 12), part.constraints.get("grammarCountMax", 16)),
        "lexicon": (part.constraints.get("lexicalCountMin", 4), part.constraints.get("lexicalCountMax", 8)),
        "orthography": (part.constraints.get("orthographyCountMin", 1), part.constraints.get("orthographyCountMax", 4)),
    }
    for category, count in _CATEGORY_PLAN:
        lo, hi = bounds[category]
        if not (lo <= count <= hi):
            raise LanguageElementsGenerationError(
                f"category plan {category}={count} falls outside blueprint range {lo}-{hi}"
            )


def _build_gap_specs(item_count: int) -> list[dict[str, str]]:
    """Interleaves _CATEGORY_PLAN's categories across item_count gap
    positions (each category's slots spread evenly across the full range via
    midpoint placement) so the passage doesn't read as one block per
    category. Returns specs in reading order g1..g{item_count}."""
    total = sum(n for _, n in _CATEGORY_PLAN)
    if total != item_count:
        raise LanguageElementsGenerationError(f"category plan totals {total}, expected {item_count}")
    positioned: list[tuple[float, str]] = []
    for category, count in _CATEGORY_PLAN:
        for i in range(count):
            positioned.append(((i + 0.5) * item_count / count, category))
    positioned.sort(key=lambda pair: pair[0])
    return [
        {"gapId": f"g{i + 1}", "questionId": f"q{i + 1}", "category": category}
        for i, (_, category) in enumerate(positioned)
    ]


def _norm(value: str) -> str:
    return " ".join(value.strip().casefold().split())


_STAGE_A_PARAGRAPH_COUNT = 6


def _build_paragraph_plan(
    gap_specs: list[dict[str, str]], paragraph_count: int = _STAGE_A_PARAGRAPH_COUNT
) -> list[list[dict[str, str]]]:
    """Splits gap_specs (already in reading order) into paragraph_count
    roughly-even chunks. A live run found the model reliably WRITES a
    normal-length, coherent passage but only sprinkles as many gaps as felt
    natural (7 of 22) when just handed one flat list of 22 target positions
    — then fabricated the remaining answers with no matching placeholder in
    the text at all. Requiring a small, concrete checklist per paragraph
    ("this specific paragraph must contain exactly these 3-4 gaps") is a
    far more tractable constraint than "scatter 22 markers somewhere across
    the whole passage and don't lose count"."""
    n = len(gap_specs)
    base, extra = divmod(n, paragraph_count)
    chunks: list[list[dict[str, str]]] = []
    start = 0
    for i in range(paragraph_count):
        size = base + (1 if i < extra else 0)
        chunks.append(gap_specs[start:start + size])
        start += size
    return chunks


def _adaptation_guidance(instructions: list[AdaptationInstruction]) -> str:
    if not instructions:
        return "No specific weakness data yet — write balanced, exam-representative C1 content."
    lines = ["Content-difficulty guidance (do NOT change gap count, word count, or any structural rule):"]
    for instr in instructions:
        lines.append(f"- {instr.direction} {instr.axis.replace('_', ' ')} for content touching: {', '.join(instr.target_tags)}.")
    return "\n".join(lines)


# ── Stage A: passage + correct answers only ─────────────────────────────────

def _prompt_stage_a(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> tuple[str, str]:
    item_count = len(gap_specs)
    paragraph_plan = _build_paragraph_plan(gap_specs)
    per_para_min = max(1, word_min // len(paragraph_plan))
    per_para_max = -(-word_max // len(paragraph_plan))  # ceil
    category_hint = {
        "grammar": "grammar (a verb form, case ending, connector, preposition, or word-order choice)",
        "lexicon": "lexicon (a collocation, word choice, or word-formation choice)",
        "orthography": "orthography (a spelling, capitalization, or punctuation-sensitive choice)",
    }
    paragraph_lines = []
    for i, chunk in enumerate(paragraph_plan, start=1):
        gap_list = ", ".join(f'"{{{{{g["gapId"]}}}}}"' for g in chunk)
        cat_list = "; ".join(f'{g["gapId"]}: {category_hint[g["category"]]}' for g in chunk)
        paragraph_lines.append(
            f"Paragraph {i} (~{per_para_min}-{per_para_max} words): must contain ALL of these placeholders, "
            f"in this exact order, and NONE of any other paragraph's: {gap_list}.\n    {cat_list}"
        )
    paragraph_block = "\n\n  ".join(paragraph_lines)
    system = (
        f"You write ORIGINAL German exam-practice passages for {profile.family} {profile.variant or ''}, "
        "matching the official telc Sprachbausteine (cloze) reading-passage style. Do NOT copy real exam "
        "content — write an entirely new, coherent factual, popular-academic, or study-related text. Reply "
        "with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        f"Write EXACTLY {len(paragraph_plan)} paragraphs on the topic '{topic['label']}', totalling "
        f"{word_min}-{word_max} words (each placeholder token, e.g. \"{{{{g1}}}}\", counts as ONE word "
        "toward that total, same as any other word). Each paragraph below MUST contain every placeholder "
        "listed for it — this is the single most important rule: a paragraph missing even one of its "
        "required placeholders, or containing a placeholder meant for a different paragraph, makes the "
        "whole response unusable. Remove one word or short phrase from the running text at each position "
        'and replace it inline with the literal placeholder "{{gapId}}":\n\n'
        f"  {paragraph_block}\n\n"
        "For each gap, report the single correct word/phrase you removed (exactly as it must be reinserted "
        "to make the sentence correct) and 1-2 skillTags describing why that gap tests what it tests: "
        "grammar/connectors/prepositions/syntax for grammar gaps, word_formation/collocation/lexical_choice "
        "for lexicon gaps, register for orthography gaps.\n\n"
        "Do NOT invent multiple-choice distractors, do not assign a correctIndex, and do not decide category "
        "counts — those are fixed separately and are not your job.\n\n"
        f"BEFORE YOU OUTPUT: go paragraph by paragraph and check off each of its required placeholders is "
        f"literally present (search for each \"{{{{gapId}}}}\" string) — {item_count} placeholders total, "
        f"none missing, none duplicated, none in the wrong paragraph. Then count every word INCLUDING each "
        f"placeholder token as one word and confirm the total is {word_min}-{word_max}.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": ["Erster Absatz ... {{g1}} ...", "Zweiter Absatz ... {{g5}} ..."]},\n'
        '  "answers": [\n'
        '    {"gapId": "g1", "answer": "...", "skillTags": ["..."]},\n'
        "    ...\n"
        f'  ] // exactly {item_count} entries, one per gap, in gap order\n'
        "}\n"
    )
    user = f"Generate the passage now. Topic: {topic['label']}."
    return system, user


def _call_stage_a(*, system: str, user: str) -> LlmResult:
    # gpt-5.4-mini bills hidden reasoning tokens against max_completion_tokens
    # (see llm_json._token_limit_param) — a live run truncated at 13/22
    # placeholders under 3500. Match this codebase's established budget for
    # comparably-sized structured generation (german_exam_reading.py /
    # german_exam_listening.py's main generation calls both use 6000).
    return chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model)


def _passage_word_count(content: dict[str, Any]) -> int:
    """Deliberately mirrors german_exam_validator.py's
    validate_cloze_mc4_language_elements exactly (sum of str(p).split() over
    paragraphs, NOT stripping "{{gapId}}" placeholders first) — that
    validator is the final authority this pipeline must satisfy, and each
    placeholder token counts as one word there. Counting differently here
    would silently target a different word-count window than what actually
    gets checked at the end."""
    text = content.get("text") if isinstance(content, dict) else None
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list):
        return 0
    return sum(len(str(p).split()) for p in paragraphs)


def _stage_a_structural_issues(content: dict[str, Any], gap_specs: list[dict[str, str]]) -> list[str]:
    """Structural checks ONLY (placeholder bijection/order, answer coverage)
    — deliberately excludes word count, which gets its own cheap repair path
    instead of forcing a full regeneration."""
    issues: list[str] = []
    expected_ids = [g["gapId"] for g in gap_specs]
    text = content.get("text") if isinstance(content, dict) else None
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list) or not paragraphs or not all(isinstance(p, str) for p in paragraphs):
        issues.append("text.paragraphs must be a non-empty list of strings")
        paragraphs = []
    joined = "\n".join(str(p) for p in paragraphs)
    found_ids = _GAP_PLACEHOLDER_RE.findall(joined)
    if found_ids != expected_ids:
        if sorted(found_ids) != sorted(expected_ids) or len(found_ids) != len(set(found_ids)):
            issues.append(f"expected placeholders {expected_ids}, found {found_ids}")
        else:
            issues.append(f"placeholders present but out of reading order: found {found_ids}")

    answers = content.get("answers") if isinstance(content, dict) else None
    if not isinstance(answers, list) or len(answers) != len(gap_specs):
        issues.append(f"expected {len(gap_specs)} answers, got {len(answers) if isinstance(answers, list) else 0}")
    else:
        answer_gap_ids = [a.get("gapId") for a in answers if isinstance(a, dict)]
        if set(answer_gap_ids) != set(expected_ids) or len(answer_gap_ids) != len(set(answer_gap_ids)):
            issues.append("answers must cover every gap exactly once")
        if not all(isinstance(a, dict) and isinstance(a.get("answer"), str) and a.get("answer", "").strip() for a in answers):
            issues.append("every answer must be a non-empty string")
    return issues


def _prompt_passage_repair(
    gap_specs: list[dict[str, str]], text: dict[str, Any], word_min: int, word_max: int, current_count: int
) -> tuple[str, str]:
    target = (word_min + word_max) // 2
    delta = current_count - target
    direction = (
        f"CUT roughly {delta} words (remove whole clauses/sentences, not just trim a word here and there — "
        "a small nip-and-tuck is not enough)" if delta > 0 else
        f"ADD roughly {-delta} words (a new sentence or clause, not just padding individual words)"
    )
    system = (
        "You are rewriting a German Sprachbausteine passage that is structurally valid but has the wrong "
        f"word count. It is currently {current_count} words; the target is {word_min}-{word_max} (aim for "
        f"about {target}), so you must {direction}. Preserve: the title and topic, "
        f"all {len(gap_specs)} placeholders \"{{{{gapId}}}}\" exactly once each in the same reading order, "
        "the meaning and grammatical fit immediately around every gap (the existing correct answers must "
        "remain correct), and natural paragraph breaks. Reply with ONLY valid JSON, no markdown fences, no "
        'commentary, in the exact same {"text": {"title", "paragraphs"}} shape as the input. Each '
        "placeholder token counts as one word toward the target, same as any other word.\n\n"
        "BEFORE YOU OUTPUT, count the new total (placeholders included) and confirm it is within "
        f"{word_min}-{word_max}; if not, cut or add more and recount."
    )
    user = f"Passage to rewrite:\n{json.dumps(text, ensure_ascii=False)}"
    return system, user


def _call_passage_repair(*, system: str, user: str) -> LlmResult:
    return chat_json(system=system, user=user, max_tokens=4000, model=get_settings().german_exam_model)


def _repair_passage_word_count(
    content: dict[str, Any], gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> dict[str, Any]:
    """Only called on a structurally sound passage whose word count is out
    of range — never discards the (already-valid) answers, only rewrites
    text.paragraphs, and only accepts a rewrite that stays structurally
    sound (same placeholders, same order)."""
    current = content
    for _attempt in range(_MAX_PASSAGE_REPAIR_ATTEMPTS):
        word_count = _passage_word_count(current)
        if word_min <= word_count <= word_max:
            return current
        system, user = _prompt_passage_repair(gap_specs, current["text"], word_min, word_max, word_count)
        try:
            result = _call_passage_repair(system=system, user=user)
            fixed_text = result.data.get("text") if isinstance(result.data, dict) else None
        except Exception:  # noqa: BLE001
            log.warning("Sprachbausteine passage word-count repair attempt failed", exc_info=True)
            fixed_text = None
        if isinstance(fixed_text, dict):
            candidate = dict(current)
            candidate["text"] = fixed_text
            if not _stage_a_structural_issues(candidate, gap_specs):
                current = candidate
    return current


def _run_stage_a(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> tuple[dict[str, Any], dict[str, str], dict[str, Any]]:
    last_issues: list[str] = []
    for regeneration in range(_MAX_STAGE_A_REGENERATIONS + 1):
        system, user = _prompt_stage_a(profile, part, plan, topic, gap_specs, word_min, word_max)
        result = _call_stage_a(system=system, user=user)
        content = result.data if isinstance(result.data, dict) else {}

        structural_issues = _stage_a_structural_issues(content, gap_specs)
        if not structural_issues:
            content = _repair_passage_word_count(content, gap_specs, word_min, word_max)
            word_count = _passage_word_count(content)
            if word_min <= word_count <= word_max:
                answers_by_gap = {a["gapId"]: a["answer"] for a in content["answers"]}
                return content["text"], answers_by_gap, {"regenerationCount": regeneration}
            structural_issues = [f"word count still {word_count} after repair, expected {word_min}-{word_max}"]

        last_issues = structural_issues
        if regeneration < _MAX_STAGE_A_REGENERATIONS:
            continue
        raise LanguageElementsGenerationError(
            f"could not produce a valid Sprachbausteine passage after {_MAX_STAGE_A_REGENERATIONS} "
            "regenerations: " + "; ".join(last_issues)
        )
    raise LanguageElementsGenerationError("unreachable: exhausted Stage A regeneration budget")


# ── Stage B: distractors only, backend owns correctIndex/category ──────────

def _prompt_stage_b(
    profile: ExamProfile, part: PartBlueprint, gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str]
) -> tuple[str, str]:
    item_count = len(gap_specs)
    lines = [
        f'  {{"gapId": "{g["gapId"]}", "questionId": "{g["questionId"]}", "category": "{g["category"]}", '
        f'"correctAnswer": {json.dumps(answers_by_gap[g["gapId"]], ensure_ascii=False)}}}'
        for g in gap_specs
    ]
    gap_block = "\n".join(lines)
    system = (
        f"You write multiple-choice distractors for a German Sprachbausteine (cloze) exercise, "
        f"{profile.family} {profile.variant or ''}, C1 level. For each gap below you are given the CORRECT "
        "answer already placed in the passage — do not change it. Provide exactly THREE wrong options "
        "(distractors) per gap: genuinely plausible for a C1 learner — real near-misses (a wrong case "
        "ending, a confusable preposition, a near-synonym with a different register or collocation, a "
        "plausible misspelling for orthography gaps) — never trivial, absurd, or obviously wrong on sight; "
        "avoid options that differ only in an unrelated word. Each wrong option must differ from the correct "
        "answer and from each other. Reply with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        "Gaps (category tells you what kind of distractor to write):\n"
        f"{gap_block}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "items": [\n'
        '    {"questionId": "q1", "gapId": "g1", "wrongOptions": ["...", "...", "..."], "skillTags": ["..."]},\n'
        "    ...\n"
        f'  ] // exactly {item_count} entries, one per gap, any order\n'
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = "Generate the distractors now."
    return system, user


def _call_stage_b(*, system: str, user: str) -> LlmResult:
    return chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model)


def _stage_b_issues(payload: dict[str, Any], gap_specs: list[dict[str, str]]) -> list[str]:
    items = payload.get("items") if isinstance(payload, dict) else None
    expected_ids = {g["gapId"] for g in gap_specs}
    if not isinstance(items, list) or len(items) != len(gap_specs):
        return [f"expected {len(gap_specs)} distractor sets, got {len(items) if isinstance(items, list) else 0}"]
    found_ids = {it.get("gapId") for it in items if isinstance(it, dict)}
    if found_ids != expected_ids or len(items) != len(found_ids):
        return ["distractor sets must cover every gap exactly once"]
    return []


def _wrong_options_valid(item: dict[str, Any], correct_answer: str) -> bool:
    wrong = item.get("wrongOptions") if isinstance(item, dict) else None
    if not isinstance(wrong, list) or len(wrong) != 3:
        return False
    if not all(isinstance(w, str) and w.strip() for w in wrong):
        return False
    normalized = {_norm(w) for w in wrong}
    normalized.add(_norm(correct_answer))
    return len(normalized) == 4  # 3 distinct wrong options + the correct answer, all different


def _prompt_item_repair(gap_spec: dict[str, str], correct_answer: str) -> tuple[str, str]:
    system = (
        "You are fixing ONE gap's multiple-choice distractors in a German Sprachbausteine exercise. The "
        f"correct answer for this gap is already fixed ({correct_answer!r}) — do not change it. Provide "
        "exactly THREE wrong options (distractors), each different from the correct answer and from each "
        "other, genuinely plausible for a C1 learner (a wrong case ending, a confusable preposition, a "
        "near-synonym with a different register or collocation, a plausible misspelling), never trivial or "
        "absurd. Reply with ONLY a JSON object, no markdown fences, no commentary, shape exactly: "
        '{"wrongOptions": ["...", "...", "..."], "skillTags": ["..."]}.'
    )
    user = f"Gap category: {gap_spec['category']}. Fix the distractors now."
    return system, user


def _call_item_repair(*, system: str, user: str) -> LlmResult:
    return chat_json(system=system, user=user, max_tokens=800, model=get_settings().german_exam_model)


def _repair_stage_b_items(
    gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str], items_by_gap: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], int, list[str]]:
    """Deterministic, per-item repair — mirrors german_exam_reading.py's
    _repair_items shape. Never touches the passage or any other item.
    Returns (items_by_gap, repaired_count, unresolved_gap_ids)."""
    spec_by_gap = {g["gapId"]: g for g in gap_specs}
    bad_gap_ids = [
        gid for gid, item in items_by_gap.items()
        if not _wrong_options_valid(item, answers_by_gap[gid])
    ]
    if not bad_gap_ids:
        return items_by_gap, 0, []

    def _fix_one(gap_id: str) -> tuple[str, dict[str, Any] | None]:
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _prompt_item_repair(spec_by_gap[gap_id], answers_by_gap[gap_id])
                result = _call_item_repair(system=system, user=user)
                fixed = result.data
                if isinstance(fixed, dict) and _wrong_options_valid(fixed, answers_by_gap[gap_id]):
                    return gap_id, fixed
            except Exception:  # noqa: BLE001
                log.warning("Sprachbausteine item repair failed for gap %s", gap_id, exc_info=True)
        return gap_id, None

    with ThreadPoolExecutor(max_workers=min(4, len(bad_gap_ids))) as pool:
        results = list(pool.map(_fix_one, bad_gap_ids))

    unresolved: list[str] = []
    repaired = 0
    for gap_id, fixed in results:
        if fixed is not None:
            items_by_gap[gap_id] = fixed
            repaired += 1
        else:
            unresolved.append(gap_id)
    return items_by_gap, repaired, unresolved


def _run_stage_b(
    profile: ExamProfile, part: PartBlueprint, gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    last_issues: list[str] = []
    item_repair_total = 0
    for regeneration in range(_MAX_STAGE_B_REGENERATIONS + 1):
        system, user = _prompt_stage_b(profile, part, gap_specs, answers_by_gap)
        result = _call_stage_b(system=system, user=user)
        payload = result.data if isinstance(result.data, dict) else {}

        issues = _stage_b_issues(payload, gap_specs)
        if not issues:
            items_by_gap = {it["gapId"]: it for it in payload["items"]}
            items_by_gap, repaired, unresolved = _repair_stage_b_items(gap_specs, answers_by_gap, items_by_gap)
            item_repair_total += repaired
            if not unresolved:
                return items_by_gap, {"regenerationCount": regeneration, "itemRepairCount": item_repair_total}
            issues = [f"gap {gid} distractors still invalid after item-level repair" for gid in unresolved]

        last_issues = issues
        if regeneration < _MAX_STAGE_B_REGENERATIONS:
            continue
        raise LanguageElementsGenerationError(
            f"could not produce valid Sprachbausteine distractors after {_MAX_STAGE_B_REGENERATIONS} "
            "regenerations: " + "; ".join(last_issues)
        )
    raise LanguageElementsGenerationError("unreachable: exhausted Stage B regeneration budget")


# ── Assembly: backend computes correctIndex, injects category, shuffles ────

def _assemble_content(
    gap_specs: list[dict[str, str]], text: dict[str, Any], answers_by_gap: dict[str, str],
    items_by_gap: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    gaps = [{"gapId": g["gapId"]} for g in gap_specs]
    questions: list[dict[str, Any]] = []
    for g in gap_specs:
        gap_id = g["gapId"]
        category = g["category"]
        correct = answers_by_gap[gap_id]
        item = items_by_gap[gap_id]
        options = list(item["wrongOptions"]) + [correct]
        random.shuffle(options)
        correct_index = options.index(correct)
        eligible = _CATEGORY_SKILL_TAGS[category]
        tags = [t for t in (item.get("skillTags") or []) if t in eligible]
        if not tags:
            tags = [eligible[0]]
        questions.append({
            "questionId": g["questionId"], "gapId": gap_id, "options": options, "correctIndex": correct_index,
            "category": category, "skillTags": tags, "difficulty": "c1",
        })
    return {
        "text": {"title": text.get("title", ""), "paragraphs": text.get("paragraphs"), "gaps": gaps},
        "questions": questions,
    }


def _postprocess(part: PartBlueprint, content: dict[str, Any]) -> dict[str, Any]:
    return content


def _semantic_phase(part: PartBlueprint, content: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Unchanged from the monolithic version — every item-level semantic
    error here IS eligible for targeted repair (no task_type is excluded),
    since a Sprachbausteine defect always lives entirely inside one item's
    own options/correctIndex/category."""
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


def generate_language_elements_part(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (content, validation_meta). Constraint-decomposed pipeline:
    backend builds the gap/category plan -> Stage A (passage + answers, with
    cheap in-place word-count repair) -> Stage B (distractors only, with
    per-item repair) -> backend assembly (correctIndex/category/shuffle) ->
    existing deterministic validator (final authority, unchanged) -> existing
    semantic verifier (unchanged). Raises LanguageElementsGenerationError
    rather than ever returning known-invalid content once a stage's bounded
    retry budget is exhausted."""
    if part.task_type != "cloze_mc4_language_elements":
        raise LanguageElementsGenerationError(f"no pipeline for task_type {part.task_type!r}")

    _validate_category_plan(part)
    item_count = part.constraints.get("itemCount", 22)
    word_min = part.constraints.get("wordCountMin", 320)
    word_max = part.constraints.get("wordCountMax", 350)
    gap_specs = _build_gap_specs(item_count)

    text, answers_by_gap, stage_a_meta = _run_stage_a(profile, part, plan, topic, gap_specs, word_min, word_max)
    items_by_gap, stage_b_meta = _run_stage_b(profile, part, gap_specs, answers_by_gap)

    content = _assemble_content(gap_specs, text, answers_by_gap, items_by_gap)
    content = _postprocess(part, content)

    issues = validate_content(part, content)
    h_issues = hard_issues(issues)
    if h_issues:
        # Should be rare-to-never given the backend now owns every structural
        # constraint — but content assembled from valid parts is still never
        # trusted blindly. Surface loudly rather than silently accept it.
        raise LanguageElementsGenerationError(
            "assembled content failed final validation despite constraint-decomposed generation: "
            + "; ".join(f"{i.item_id}: {i.message}" for i in h_issues)
        )

    content, semantic_meta, semantic_ok = _semantic_phase(part, content)
    semantic_meta["stageA"] = stage_a_meta
    semantic_meta["stageB"] = stage_b_meta
    log.info(
        "german_exam_semantic part=%s stageA=%s stageB=%s passed=%s verificationCount=%s repairCount=%s issueCounts=%s",
        part.part_id, stage_a_meta, stage_b_meta, semantic_ok, semantic_meta["verificationCount"],
        semantic_meta["repairCount"], semantic_meta["issueCounts"]
    )
    if not semantic_ok:
        raise LanguageElementsGenerationError(
            f"could not produce semantically valid {part.task_type} content: {semantic_meta}"
        )

    return content, {
        "deterministicPassed": True,
        "deterministicRepairCount": stage_b_meta.get("itemRepairCount", 0),
        "semantic": semantic_meta,
    }
