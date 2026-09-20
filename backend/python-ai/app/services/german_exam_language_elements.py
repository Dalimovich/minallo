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
from .gen_timing import ContextThreadPoolExecutor as ThreadPoolExecutor
from time import perf_counter
from typing import Any, TypeAlias

from ..config import get_settings

from .german_exam_adaptation import AdaptationInstruction
from .german_exams import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full as verify_semantic
from .german_exam_semantic_repair import repair_items_semantic
from .german_exam_semantic_verify import SemanticVerificationResult
from .german_exam_semantic_chunked import verify_semantic_chunked
from .german_exam_validator import hard_issues, validate_content
from .llm_json import LlmResult, chat_json

log = logging.getLogger(__name__)

# Full-generation retries are now the LAST resort, not the primary repair
# mechanism — each stage below has its own, much cheaper repair path first.
#
# A live acceptance run hit HTTP 524 at 125s: Cloudflare's OWN edge timeout
# (~100-125s) sits in front of this app and is separate from — and shorter
# than — AI_GERMAN_EXAM_GENERATE_UPSTREAM_TIMEOUT_MS (180s). A backend retry
# sequence that would eventually succeed can still get cut off by Cloudflare
# first if it runs long, so these budgets are sized for worst-case wall time
# under that ceiling, not just per-call cost. Trimmed down from an earlier,
# more generous pass once this ceiling was discovered — a typical "needs one
# retry" case still gets a retry; a pathological case that would need all of
# regeneration+repair+item-repair to fully exhaust would have 524'd anyway.
_MAX_STAGE_A_REGENERATIONS = 1
_MAX_PASSAGE_REPAIR_ATTEMPTS = 2
_MAX_MISSING_GAP_REPAIR_ATTEMPTS = 1
# Above this many missing placeholders, the passage is too broken for a
# targeted insertion repair to be worth it (and cheaper than) a full Stage A
# regeneration — observed live misses were 1-2 gaps; this stays well clear
# of that while still excluding a near-total failure (e.g. 15+ missing).
_MAX_MISSING_GAPS_FOR_REPAIR = 5
_MAX_STAGE_B_REGENERATIONS = 1
_MAX_ITEM_REPAIR_ATTEMPTS = 1
# Rounds of PER-GAP repair (only the still-invalid gaps are re-asked; the passage,
# correct answers and every already-valid distractor set stay frozen).
_MAX_TARGETED_REPAIR_ROUNDS = 2
_MAX_SEMANTIC_REPAIR_ROUNDS = 1

_GAP_PLACEHOLDER_RE = re.compile(r"\{\{(g\d+)\}\}")

# ── Stage A works on TAGGED gaps: "{{g5::ist}}" ────────────────────────────
# The gap id and its answer are ONE atomic marker inside the passage, so the
# answer can never drift away from the sentence it belongs to (an independently
# reported answers[] list used to, and a passage rewrite could reword the
# surrounding sentence while the frozen answer stayed put). The tagged passage is
# the single source of truth; the public "{{gN}}" text and answers_by_gap are
# DERIVED from it in _materialize_stage_a_text, only after every Stage A repair.
# The tagged form never leaves Stage A.
_TAGGED_GAP_RE = re.compile(r"\{\{(g\d+)::(.+?)\}\}", re.S)
_ADJACENT_DUPLICATE_MIN_LEN = 5  # content words only: "die die"/"das das" can be valid German


def _extract_tagged_gaps(text: str) -> list[tuple[str, str]]:
    """Tagged gaps in reading order as (gapId, exact answer text)."""
    return [(m.group(1), m.group(2)) for m in _TAGGED_GAP_RE.finditer(text)]


def _count_words_tagged(text: str) -> int:
    """Word count where each COMPLETE tagged marker is ONE word, exactly like the
    public "{{gN}}" placeholder the final validator counts (an answer may be a
    multi-word phrase; its inner spaces must not be counted)."""
    return len(_TAGGED_GAP_RE.sub("X", text).split())


def _has_tagged_gap(text: str) -> bool:
    return _TAGGED_GAP_RE.search(text) is not None


def _tagged_paragraphs(content: Any) -> list[str] | None:
    text = content.get("text") if isinstance(content, dict) else None
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list) or not paragraphs or not all(isinstance(p, str) for p in paragraphs):
        return None
    return paragraphs


def _adjacent_duplicate_gap_ids(text: str) -> list[str]:
    """Gaps whose answer merely repeats the word right before/after the marker
    ("bieten {{g10::bieten}} Studierenden"). Deliberately narrow: only identical,
    longer (content) words, never a German-grammar heuristic."""
    bad: list[str] = []
    for m in _TAGGED_GAP_RE.finditer(text):
        answer = m.group(2).strip().casefold()
        if len(answer) < _ADJACENT_DUPLICATE_MIN_LEN or " " in answer:
            continue
        left = re.findall(r"[\wÄÖÜäöüß]+", text[:m.start()])
        right = re.findall(r"[\wÄÖÜäöüß]+", text[m.end():])
        if (left and left[-1].casefold() == answer) or (right and right[0].casefold() == answer):
            bad.append(m.group(1))
    return bad


def _materialize_stage_a_text(
    text: dict[str, Any], gap_specs: list[dict[str, str]]
) -> tuple[dict[str, Any], dict[str, str]]:
    """The ONLY place answers_by_gap is created for the normal flow: tagged passage in,
    public {{gN}} passage + exact answers out. Requires every expected gap exactly once,
    in reading order; replaces only the complete tagged markers."""
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list) or not all(isinstance(p, str) for p in paragraphs):
        raise LanguageElementsGenerationError("cannot materialize a Stage A passage without string paragraphs")
    expected = [g["gapId"] for g in gap_specs]
    found = _extract_tagged_gaps("\n".join(paragraphs))
    if [gid for gid, _ in found] != expected or any(not ans.strip() for _, ans in found):
        raise LanguageElementsGenerationError("Stage A tagged gaps do not match the expected gaps")
    answers_by_gap = {gid: ans.strip() for gid, ans in found}
    final_paragraphs = [_TAGGED_GAP_RE.sub(lambda m: "{{" + m.group(1) + "}}", p) for p in paragraphs]
    final_text = dict(text)
    final_text["paragraphs"] = final_paragraphs
    return final_text, answers_by_gap


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


def _norm_case_sensitive(value: str) -> str:
    return " ".join(value.strip().split())


def _norm_for_category(category: str | None):
    """Option-equality key by category. Orthography keeps case: capitalization
    IS the contrast there (Allgemeinen / allgemeinen). Grammar and lexicon
    stay case-insensitive."""
    return _norm_case_sensitive if category == "orthography" else _norm


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


# ── Stage A: tagged passage (gap id + answer are one marker) ─────────────────

def _prompt_stage_a(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> tuple[str, str]:
    item_count = len(gap_specs)
    paragraph_plan = _build_paragraph_plan(gap_specs)
    # Live testing: asking for a per-paragraph WORD count/range (even one
    # deliberately aimed below the true target) produced wildly inconsistent
    # totals (139-447 words against a 320-350 target, in both directions).
    # Asking for a per-paragraph SENTENCE count instead was far more
    # reliably followed and landed in a much tighter, more predictable band
    # (roughly 280-320 words at 4 sentences/paragraph) — models apparently
    # track discrete sentence counts more reliably than a running word tally.
    # 4 lands slightly low rather than high, since an under-320 result is a
    # cheaper/easier ADD repair than cutting an over-350 one.
    _SENTENCES_PER_PARAGRAPH = 4
    category_hint = {
        "grammar": "grammar (a verb form, case ending, connector, preposition, or word-order choice)",
        "lexicon": "lexicon (a collocation, word choice, or word-formation choice)",
        "orthography": "orthography (a spelling, capitalization, or punctuation-sensitive choice)",
    }
    paragraph_lines = []
    for i, chunk in enumerate(paragraph_plan, start=1):
        gap_list = ", ".join(f'"{{{{{g["gapId"]}::answer}}}}"' for g in chunk)
        cat_list = "; ".join(f'{g["gapId"]}: {category_hint[g["category"]]}' for g in chunk)
        paragraph_lines.append(
            f"Paragraph {i}: EXACTLY {_SENTENCES_PER_PARAGRAPH} sentences — no more, no fewer. Must contain "
            f"ALL of these tagged gaps, in this exact order, and NONE of any other paragraph's: {gap_list}."
            f"\n    {cat_list}"
        )
    paragraph_block = "\n\n  ".join(paragraph_lines)
    system = (
        f"You write ORIGINAL German exam-practice passages for {profile.family} {profile.variant or ''}, "
        "matching the official telc Sprachbausteine (cloze) reading-passage style. Do NOT copy real exam "
        "content — write an entirely new, coherent factual, popular-academic, or study-related text. Reply "
        "with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        f"Write EXACTLY {len(paragraph_plan)} paragraphs on the topic '{topic['label']}'. Sentence count per "
        "paragraph is the PRIMARY constraint below — follow it exactly, even if that means being more "
        "concise or more detailed than you otherwise would. The total should land near "
        f"{word_min}-{word_max} words (each tagged gap, e.g. \"{{{{g1::ist}}}}\", counts as ONE word "
        "toward that total, however long its answer is), but getting the sentence count exactly right "
        "matters more than hitting the word count precisely — a later pass will adjust length if needed.\n\n"
        "GAP FORMAT. Write the passage with each gap as ONE tagged marker that contains BOTH the gap id and "
        'the correct answer: "{{gN::answer}}". The answer is the word or short phrase that stands at that '
        "exact spot in the sentence. There is NO separate answer list — the marker IS the answer.\n"
        "THE KEY RULE: if you delete only the marker syntax and leave the answer text in place, the passage "
        "must read as a natural, grammatically correct German text. So the answer inside the marker is "
        "exactly the word(s) that belong there, with the correct form/case/ending, and the words around it "
        "must fit it.\n"
        '  Correct:   "Interkulturelle Kompetenz {{g5::ist}} ein zentraler Baustein."\n'
        '  Incorrect: "Interkulturelle Kompetenz {{g5::ein}} zentraler Baustein."  (the verb is missing; '
        '"ein" is not what stands at that spot)\n'
        '  Incorrect: "Programme bieten {{g10::bieten}} Studierenden Unterstützung."  (the answer repeats a '
        "neighbouring word)\n"
        '  Correct:   "Programme {{g10::bieten}} Studierenden Unterstützung."  or  "Programme bieten '
        '{{g10::den}} Studierenden Unterstützung."\n'
        "Put a marker INSIDE the running sentence, never before/after a word it merely repeats. Each "
        "paragraph below MUST contain every tagged gap listed for it — this is the single most important "
        "structural rule: a paragraph missing a required gap, or containing a gap meant for a different "
        "paragraph, makes the whole response unusable:\n\n"
        f"  {paragraph_block}\n\n"
        "Choose the answer so that it tests what the gap's category names: grammar/connectors/prepositions/"
        "syntax for grammar gaps, word_formation/collocation/lexical_choice for lexicon gaps, a spelling/"
        "capitalization choice for orthography gaps.\n\n"
        "Do NOT invent multiple-choice distractors, do not assign a correctIndex, and do not decide category "
        "counts — those are fixed separately and are not your job.\n\n"
        f"BEFORE YOU OUTPUT: go paragraph by paragraph and check that each of its required tagged gaps is "
        f"literally present — {item_count} tagged gaps total, none missing, none duplicated, none in the wrong "
        f"paragraph, every one written exactly as {{{{gN::answer}}}}. Read each sentence once more with the "
        f"answers in place to confirm it is correct German. Then count every word, each tagged gap as one "
        f"word, and confirm the total is {word_min}-{word_max}.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": ["Erster Absatz ... {{g1::wort}} ...", "Zweiter Absatz ... {{g5::wort}} ..."]}\n'
        "}\n"
    )
    user = f"Generate the passage now. Topic: {topic['label']}."
    return system, user


def _call_stage_a(*, system: str, user: str) -> LlmResult:
    # Deliberately NOT get_settings().german_exam_model (gpt-5.4-mini) — see
    # german_exam_model_stage_a's docstring in config.py. Only Stage A uses
    # the stronger model; Stage B (distractors) and everything else in the
    # German Exam Engine stay on the mini tier, per the evidence that only
    # placeholder placement was unreliable there.
    return chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model_stage_a)


def _passage_word_count(content: dict[str, Any]) -> int:
    """Mirrors german_exam_validator.py's validate_cloze_mc4_language_elements exactly
    (each gap placeholder counts as ONE word). During Stage A the gaps are TAGGED
    ("{{g5::im Hinblick auf}}"), so a complete marker is collapsed to one token first —
    the answer's inner spaces must not be counted; after materialization the public
    "{{gN}}" is one token, so the count is identical."""
    paragraphs = _tagged_paragraphs(content)
    if paragraphs is None:
        return 0
    return sum(_count_words_tagged(str(p)) for p in paragraphs)


def _stage_a_structural_issues(content: dict[str, Any], gap_specs: list[dict[str, str]]) -> list[str]:
    """Structural checks ONLY on the TAGGED Stage A passage (word count is excluded:
    it has its own cheap repair path). The tags themselves prove answer coverage;
    a separately supplied answers list is never consulted."""
    issues: list[str] = []
    expected_ids = [g["gapId"] for g in gap_specs]
    paragraphs = _tagged_paragraphs(content)
    if paragraphs is None:
        return ["text.paragraphs must be a non-empty list of strings"]
    joined = "\n".join(paragraphs)
    found = _extract_tagged_gaps(joined)
    found_ids = [gid for gid, _ in found]
    if found_ids != expected_ids:
        if sorted(found_ids) != sorted(expected_ids) or len(found_ids) != len(set(found_ids)):
            issues.append(f"expected tagged gaps {expected_ids}, found {found_ids}")
        else:
            issues.append(f"tagged gaps present but out of reading order: found {found_ids}")
    # Anything brace-like left once complete tagged markers are removed is malformed:
    # a plain "{{gN}}" (no inline answer), a nested/unterminated marker, a stray brace.
    leftover = _TAGGED_GAP_RE.sub("", joined)
    if "{{" in leftover or "}}" in leftover:
        issues.append("malformed or untagged gap marker present (every gap must be {{gN::answer}})")
    if any(not ans.strip() for _, ans in found) or any("{{" in ans or "}}" in ans for _, ans in found):
        issues.append("every tagged gap must contain a non-empty answer and no nested markers")
    for gid in _adjacent_duplicate_gap_ids(joined):
        issues.append(f"gap {gid}: the answer repeats the neighbouring word")
    return issues


def _missing_gap_ids(content: dict[str, Any], gap_specs: list[dict[str, str]]) -> list[str] | None:
    """Returns the missing gapIds (in expected order) if the passage's ONLY tagged-gap
    problem is that some are missing — every gap that IS present is a real, distinct,
    correctly-ordered, well-formed tagged gap. Returns None for any other kind of
    malformation (duplicates, extras, out-of-order, untagged markers), which isn't safe
    to patch by insertion alone and must fall back to a full Stage A regeneration."""
    paragraphs = _tagged_paragraphs(content)
    if paragraphs is None:
        return None
    joined = "\n".join(paragraphs)
    leftover = _TAGGED_GAP_RE.sub("", joined)
    if "{{" in leftover or "}}" in leftover:
        return None
    found = _extract_tagged_gaps(joined)
    found_ids = [gid for gid, _ in found]
    if any(not ans.strip() for _, ans in found):
        return None
    expected_ids = [g["gapId"] for g in gap_specs]
    if len(found_ids) != len(set(found_ids)):
        return None  # a duplicate — not a simple "missing" case
    expected_set = set(expected_ids)
    if any(gid not in expected_set for gid in found_ids):
        return None  # an unknown gap — not a simple "missing" case
    # found_ids must also preserve relative reading order among themselves
    if [gid for gid in expected_ids if gid in found_ids] != found_ids:
        return None
    missing = [gid for gid in expected_ids if gid not in set(found_ids)]
    return missing or None


def _prompt_missing_gap_repair(
    gap_specs_by_id: dict[str, dict[str, str]], text: dict[str, Any], missing_ids: list[str]
) -> tuple[str, str]:
    lines = "\n".join(
        f'  {{"gapId": "{gid}", "category": "{gap_specs_by_id[gid]["category"]}"}}' for gid in missing_ids
    )
    system = (
        "You are fixing a German Sprachbausteine passage that is missing some of its required tagged gaps. "
        "Every gap is ONE marker containing both its id and its correct answer, written {{gN::answer}}. "
        f"Insert EXACTLY these {len(missing_ids)} missing tagged gaps somewhere natural in the existing text, "
        "each at a point where the answer is the word or short phrase that really stands there, and each "
        "testing the given category. Put the answer INSIDE the marker. Do NOT change, move, or renumber any "
        "tagged gap that is already present — every existing marker, including its answer, must stay "
        "character-for-character identical — and do not otherwise reword the passage beyond what's needed to "
        "fit each new gap in naturally. With the marker syntax removed and the answer left in place, the text "
        "must be natural, correct German; the answer must not just repeat a neighbouring word:\n"
        f"{lines}\n\n"
        "Category meanings: grammar = a verb form/case ending/connector/preposition/word-order choice; "
        "lexicon = a collocation/word choice/word-formation choice; orthography = a spelling/capitalization/"
        "punctuation-sensitive choice.\n\n"
        "Reply with ONLY valid JSON, no markdown fences, no commentary, shape exactly:\n"
        '{"text": {"title": "...", "paragraphs": [...]}}'
    )
    user = f"Passage to fix (missing {missing_ids}):\n{json.dumps(text, ensure_ascii=False)}"
    return system, user


def _call_missing_gap_repair(*, system: str, user: str) -> LlmResult:
    # Same stronger tier as _call_stage_a — this patches a Stage A passage
    # and needs the same "keep every existing placeholder exactly where it
    # is" reliability that motivated the switch in the first place.
    return chat_json(system=system, user=user, max_tokens=2000, model=get_settings().german_exam_model_stage_a)


def _repair_missing_gaps(
    content: dict[str, Any], gap_specs: list[dict[str, str]], missing_ids: list[str]
) -> dict[str, Any] | None:
    """Inserts only the missing placeholders into an otherwise-good passage,
    reusing the rest of the (expensive) Stage A output instead of discarding
    it for a full regeneration — mirrors the same "repair narrowly" idea as
    _repair_passage_word_count and Stage B's per-item repair. Returns the
    merged, re-validated content, or None if the repair attempt didn't fully
    fix it (caller falls back to full Stage A regeneration)."""
    gap_specs_by_id = {g["gapId"]: g for g in gap_specs}
    system, user = _prompt_missing_gap_repair(gap_specs_by_id, content["text"], missing_ids)
    try:
        result = _call_missing_gap_repair(system=system, user=user)
        data = result.data if isinstance(result.data, dict) else None
    except Exception:  # noqa: BLE001
        log.warning("Sprachbausteine missing-gap repair attempt failed", exc_info=True)
        return None
    if not isinstance(data, dict):
        return None
    fixed_text = data.get("text")
    if not isinstance(fixed_text, dict):
        return None

    candidate = {"text": fixed_text}
    if _stage_a_structural_issues(candidate, gap_specs):
        return None
    # The gaps that were already present must survive byte-for-byte (id AND answer);
    # the new gaps' answers come from their own markers, nothing else.
    before = dict(_extract_tagged_gaps("\n".join(_tagged_paragraphs(content) or [])))
    after = dict(_extract_tagged_gaps("\n".join(_tagged_paragraphs(candidate) or [])))
    if any(after.get(gid) != answer for gid, answer in before.items()):
        return None
    return candidate


def _single_duplicate_gap(content: dict[str, Any], gap_specs: list[dict[str, str]]) -> tuple[str, int] | None:
    """(gapId, paragraphIndex) when Stage A's ONLY tagged-gap problem is exactly one gap id that
    appears exactly twice, both in the same paragraph, and dropping either occurrence yields the
    expected reading order. Anything else (a second duplicate, a missing or unknown id, a stray/
    malformed marker, empty answers, occurrences in different paragraphs, out-of-order gaps) returns
    None and takes the normal full Stage A regeneration. Which occurrence is the natural one is NOT
    decided here (or anywhere in Python)."""
    paragraphs = _tagged_paragraphs(content)
    if paragraphs is None:
        return None
    joined = "\n".join(paragraphs)
    leftover = _TAGGED_GAP_RE.sub("", joined)
    if "{{" in leftover or "}}" in leftover:
        return None
    found = _extract_tagged_gaps(joined)
    if any(not ans.strip() or "{{" in ans or "}}" in ans for _, ans in found):
        return None
    ids = [gid for gid, _ in found]
    expected_ids = [g["gapId"] for g in gap_specs]
    expected_set = set(expected_ids)
    if any(gid not in expected_set for gid in ids):
        return None
    duplicated = sorted({gid for gid in ids if ids.count(gid) > 1})
    if len(duplicated) != 1 or ids.count(duplicated[0]) != 2:
        return None
    dup = duplicated[0]
    if any(ids.count(gid) != 1 for gid in expected_ids if gid != dup):
        return None  # a missing gap (or any other non-single count)
    first = ids.index(dup)
    second = ids.index(dup, first + 1)
    without_first = ids[:first] + ids[first + 1:]
    without_second = ids[:second] + ids[second + 1:]
    if expected_ids not in (without_first, without_second):
        return None  # the non-duplicate gaps are not in reading order around it
    holders = [pi for pi, para in enumerate(paragraphs) if any(gid == dup for gid, _ in _extract_tagged_gaps(para))]
    if len(holders) != 1:
        return None
    return dup, holders[0]


def _prompt_duplicate_gap_repair(
    gap_spec: dict[str, str], paragraph: str, occurrences: list[str]
) -> tuple[str, str]:
    gap_id = gap_spec["gapId"]
    system = (
        f"This German Sprachbausteine paragraph contains the tagged gap {gap_id} TWICE (current answers: "
        f"{json.dumps(occurrences, ensure_ascii=False)}); exactly one is allowed. Rewrite ONLY this paragraph "
        f"so that exactly one grammatically natural {{{{{gap_id}::answer}}}} remains (category: "
        f"{gap_spec['category']}); the other place becomes ordinary words with no marker. Preserve every other "
        "tagged marker in the paragraph character-for-character and exactly once, in the same order. Do not "
        "add, remove, renumber or modify any other gap. Preserve the paragraph's meaning and approximate "
        "length. With every marker syntax removed and its answer left in place the paragraph must be natural, "
        "correct German, and no answer may just repeat a neighbouring word.\n\n"
        "Reply with ONLY valid JSON, no markdown fences, no commentary, shape exactly: "
        '{"paragraph": "..."}'
    )
    user = f"Paragraph to rewrite:\n{json.dumps(paragraph, ensure_ascii=False)}"
    return system, user


def _call_duplicate_gap_repair(*, system: str, user: str) -> LlmResult:
    # Same stronger tier as _call_stage_a / _call_missing_gap_repair: it patches a Stage A passage.
    return chat_json(system=system, user=user, max_tokens=1500, model=get_settings().german_exam_model_stage_a)


def _repair_duplicate_gap(
    content: dict[str, Any], gap_specs: list[dict[str, str]], gap_id: str, paragraph_index: int
) -> dict[str, Any] | None:
    """ONE Stage-A-model call on the affected paragraph only. Returns the re-validated content, or
    None (caller does the normal full regeneration) if the call fails or ANY check below fails."""
    paragraphs = list(_tagged_paragraphs(content) or [])
    spec = next(g for g in gap_specs if g["gapId"] == gap_id)
    original = paragraphs[paragraph_index]
    occurrences = [ans for gid, ans in _extract_tagged_gaps(original) if gid == gap_id]
    system, user = _prompt_duplicate_gap_repair(spec, original, occurrences)
    try:
        result = _call_duplicate_gap_repair(system=system, user=user)
        data = result.data if isinstance(result.data, dict) else None
    except Exception:  # noqa: BLE001
        log.warning("Sprachbausteine duplicate-gap repair attempt failed", exc_info=True)
        return None
    fixed = data.get("paragraph") if data else None
    if not isinstance(fixed, str) or not fixed.strip():
        return None

    # Every OTHER marker in the paragraph survives byte-for-byte (id, answer, order).
    others_before = [(g, a) for g, a in _extract_tagged_gaps(original) if g != gap_id]
    others_after = [(g, a) for g, a in _extract_tagged_gaps(fixed) if g != gap_id]
    if others_before != others_after:
        return None
    new_paragraphs = list(paragraphs)
    new_paragraphs[paragraph_index] = fixed
    text = dict(content["text"])
    text["paragraphs"] = new_paragraphs
    candidate = {**content, "text": text}
    # Full Stage A structural validation: exactly one gN, all gaps once and in order, no stray braces,
    # no adjacent-duplicate answers. Word count is NOT judged here: the existing word-count repair
    # path runs right after (no second length system).
    if _stage_a_structural_issues(candidate, gap_specs):
        return None
    return candidate


def _prompt_passage_repair(
    gap_specs: list[dict[str, str]], text: dict[str, Any], word_min: int, word_max: int, current_count: int
) -> tuple[str, str]:
    target = (word_min + word_max) // 2
    delta = current_count - target
    direction = (
        f"CUT roughly {delta} words, no more (remove a clause or short sentence, not just trim a word here "
        f"and there — but stop once you're within {word_min}-{word_max}, do not keep cutting past it)"
        if delta > 0 else
        f"ADD roughly {-delta} words, no more (a short sentence or clause, not just padding individual "
        f"words — but stop once you're within {word_min}-{word_max}, do not keep adding past it)"
    )
    system = (
        "You are rewriting a German Sprachbausteine passage that is structurally valid but has the wrong "
        f"word count. It is currently {current_count} words; the target is {word_min}-{word_max} (aim for "
        f"about {target}), so you must {direction}. Overshooting past the target range in the opposite "
        "direction is just as wrong as not fixing it at all. Preserve: the title and topic, "
        f"all {len(gap_specs)} tagged gaps \"{{{{gN::answer}}}}\" exactly once each in the same reading order, "
        "and natural paragraph breaks. Every tagged gap must stay COMPLETE and UNCHANGED: keep its id and its "
        "inline answer character-for-character (never shorten it to {{gN}}, never edit the answer, never "
        "move it into a sentence where that answer would no longer be correct). When you read a sentence, "
        "treat the answer inside the marker as the actual text at that spot, and keep the words around it "
        "grammatically correct for THAT answer. Reply with ONLY valid JSON, no markdown fences, no "
        'commentary, in the exact same {"text": {"title", "paragraphs"}} shape as the input. Each '
        "tagged gap counts as ONE word toward the target, however long its answer is.\n\n"
        "BEFORE YOU OUTPUT, count the new total (placeholders included) and confirm it is within "
        f"{word_min}-{word_max}; if not, adjust again and recount."
    )
    user = f"Passage to rewrite:\n{json.dumps(text, ensure_ascii=False)}"
    return system, user


def _call_passage_repair(*, system: str, user: str) -> LlmResult:
    # Same stronger tier as _call_stage_a — see that function's comment.
    return chat_json(system=system, user=user, max_tokens=4000, model=get_settings().german_exam_model_stage_a)


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _split_sentences(paragraph: str) -> list[str]:
    # A tagged answer such as "{{g3::z. B.}}" holds sentence punctuation; shield each
    # complete marker so a sentence break can never fall inside one.
    shielded: list[str] = []

    def _shield(m: re.Match[str]) -> str:
        shielded.append(m.group(0))
        return f"\x00{len(shielded) - 1}\x00"

    text = _TAGGED_GAP_RE.sub(_shield, paragraph.strip())
    parts = [s for s in _SENTENCE_SPLIT_RE.split(text) if s]
    return [re.sub(r"\x00(\d+)\x00", lambda m: shielded[int(m.group(1))], p) for p in parts]


def _trim_passage_deterministic(
    content: dict[str, Any], gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> dict[str, Any] | None:
    """Brings an over-length passage back into range by dropping whole
    sentences that contain no placeholder — no LLM call, so it's free and
    instant, and it's tried before spending another paid repair attempt.
    Never touches a sentence containing a "{{gapId}}" (that would risk
    losing a gap or its surrounding grammatical fit). Returns None if
    there isn't enough removable, non-gap text to reach word_max without
    dropping below word_min — caller falls back to the LLM-based repair in
    that case."""
    text = content.get("text") if isinstance(content, dict) else None
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    if not isinstance(paragraphs, list) or not paragraphs or not all(isinstance(p, str) for p in paragraphs):
        return None

    total = sum(_count_words_tagged(p) for p in paragraphs)
    if total <= word_max:
        return content

    split_paragraphs = [_split_sentences(p) for p in paragraphs]
    removable: list[tuple[int, int, int]] = []  # (paragraph idx, sentence idx, word count)
    for pi, sentences in enumerate(split_paragraphs):
        for si, sentence in enumerate(sentences):
            if not _has_tagged_gap(sentence):  # a sentence holding ANY gap is never removable
                removable.append((pi, si, _count_words_tagged(sentence)))
    removable.sort(key=lambda item: item[2], reverse=True)

    removed: set[tuple[int, int]] = set()
    for pi, si, word_count in removable:
        if total <= word_max:
            break
        if total - word_count < word_min:
            continue
        removed.add((pi, si))
        total -= word_count

    if total > word_max or total < word_min:
        return None

    new_paragraphs = [
        " ".join(s for si, s in enumerate(sentences) if (pi, si) not in removed)
        for pi, sentences in enumerate(split_paragraphs)
    ]
    new_paragraphs = [p for p in new_paragraphs if p.strip()]

    candidate = dict(content)
    candidate["text"] = dict(text)
    candidate["text"]["paragraphs"] = new_paragraphs
    if _stage_a_structural_issues(candidate, gap_specs):
        return None
    return candidate


def _repair_passage_word_count(
    content: dict[str, Any], gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> dict[str, Any]:
    """Only called on a structurally sound passage whose word count is out
    of range — never discards the (already-valid) answers, only rewrites
    text.paragraphs, and only accepts a rewrite that stays structurally
    sound (same placeholders, same order). Tries the free deterministic
    sentence-trim first (both up front and after each LLM rewrite, since an
    LLM rewrite can itself overshoot) before spending a paid repair call."""
    current = content
    word_count = _passage_word_count(current)
    if word_count > word_max:
        trimmed = _trim_passage_deterministic(current, gap_specs, word_min, word_max)
        if trimmed is not None:
            return trimmed
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
            candidate = {"text": fixed_text}
            # A rewrite is only accepted if every tagged gap survived EXACTLY (id and inline
            # answer): prose may change, a gap and its answer may not.
            same_gaps = _extract_tagged_gaps("\n".join(_tagged_paragraphs(candidate) or [])) == \
                _extract_tagged_gaps("\n".join(_tagged_paragraphs(current) or []))
            if same_gaps and not _stage_a_structural_issues(candidate, gap_specs):
                current = candidate
                word_count = _passage_word_count(current)
                if word_count > word_max:
                    trimmed = _trim_passage_deterministic(current, gap_specs, word_min, word_max)
                    if trimmed is not None:
                        return trimmed
    return current


def _fill_gaps(sentence: str, answers_by_gap: dict[str, str], keep: str | None = None) -> str:
    """Replaces every {{gN}} placeholder with its known answer, except `keep`."""
    return _GAP_PLACEHOLDER_RE.sub(
        lambda m: m.group(0) if m.group(1) == keep else answers_by_gap.get(m.group(1), m.group(0)), sentence
    )


def _build_gap_context(
    text: dict[str, Any], gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str]
) -> dict[str, dict[str, Any]]:
    """Builds a local-context window per gap from the FINAL (word-count-
    repaired) Stage A passage: the exact sentence containing the gap, that
    same sentence with the correct answer inserted, its immediate neighbors,
    and the paragraph index. Stage B and item repair use this so distractors
    are written against the real sentence they'll be judged in, instead of
    blind (category + correct answer alone) — see this module's docstring
    on why that mismatch was producing semantic-verifier rejections
    (IMPLAUSIBLE_DISTRACTOR, UNSUPPORTED_CORRECT_ANSWER,
    MULTIPLE_DEFENSIBLE_ANSWERS) that then had to be caught downstream by
    the much more expensive full-passage semantic repair pass."""
    paragraphs = text.get("paragraphs") if isinstance(text, dict) else None
    paragraphs = paragraphs if isinstance(paragraphs, list) else []
    context_by_gap: dict[str, dict[str, Any]] = {}
    for pi, paragraph in enumerate(paragraphs):
        sentences = _split_sentences(str(paragraph))
        for si, sentence in enumerate(sentences):
            for match in _GAP_PLACEHOLDER_RE.finditer(sentence):
                gap_id = match.group(1)
                if gap_id not in answers_by_gap:
                    continue
                with_answer = _fill_gaps(sentence, answers_by_gap)
                # Only THIS gap stays a slot; a second gap in the same sentence
                # is shown filled with its known answer.
                with_target_gap = _fill_gaps(sentence, answers_by_gap, keep=gap_id)
                previous_sentence = sentences[si - 1] if si > 0 else None
                next_sentence = sentences[si + 1] if si + 1 < len(sentences) else None
                context_by_gap[gap_id] = {
                    "gapId": gap_id,
                    "paragraphIndex": pi,
                    "sentenceWithGap": sentence,
                    "sentenceWithTargetGap": with_target_gap,
                    "sentenceWithCorrectAnswer": with_answer,
                    # Neighbours carry no raw {{gN}} placeholders either.
                    "previousSentence": _fill_gaps(previous_sentence, answers_by_gap) if previous_sentence else None,
                    "nextSentence": _fill_gaps(next_sentence, answers_by_gap) if next_sentence else None,
                }
    # Fallback for any gap whose sentence-split placement failed to match
    # (should not happen post structural-validation, but Stage B must never
    # receive a gap with no context at all).
    for g in gap_specs:
        gap_id = g["gapId"]
        if gap_id not in context_by_gap:
            context_by_gap[gap_id] = {
                "gapId": gap_id, "paragraphIndex": None,
                "sentenceWithGap": f"{{{{{gap_id}}}}}",
                "sentenceWithTargetGap": f"{{{{{gap_id}}}}}",
                "sentenceWithCorrectAnswer": answers_by_gap.get(gap_id, ""),
                "previousSentence": None, "nextSentence": None,
            }
    return context_by_gap


def _run_stage_a(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str],
    gap_specs: list[dict[str, str]], word_min: int, word_max: int
) -> tuple[dict[str, Any], dict[str, str], dict[str, Any]]:
    last_issues: list[str] = []
    duplicate_repairs = 0
    for regeneration in range(_MAX_STAGE_A_REGENERATIONS + 1):
        system, user = _prompt_stage_a(profile, part, plan, topic, gap_specs, word_min, word_max)
        result = _call_stage_a(system=system, user=user)
        content = result.data if isinstance(result.data, dict) else {}

        structural_issues = _stage_a_structural_issues(content, gap_specs)
        if structural_issues:
            missing_ids = _missing_gap_ids(content, gap_specs)
            if missing_ids and len(missing_ids) <= _MAX_MISSING_GAPS_FOR_REPAIR:
                for _repair_attempt in range(_MAX_MISSING_GAP_REPAIR_ATTEMPTS):
                    repaired = _repair_missing_gaps(content, gap_specs, missing_ids)
                    if repaired is not None:
                        content = repaired
                        structural_issues = []
                        break
                    missing_ids = _missing_gap_ids(content, gap_specs) or missing_ids
            else:
                # One narrow shape only: exactly one duplicated gap id, nothing else wrong. One repair
                # call per Stage A output; a failed repair falls through to full regeneration.
                duplicate = _single_duplicate_gap(content, gap_specs)
                if duplicate is not None:
                    repaired = _repair_duplicate_gap(content, gap_specs, *duplicate)
                    if repaired is not None:
                        content = repaired
                        structural_issues = []
                        duplicate_repairs += 1

        if not structural_issues:
            content = _repair_passage_word_count(content, gap_specs, word_min, word_max)
            word_count = _passage_word_count(content)
            if word_min <= word_count <= word_max:
                # Every repair is finished: only NOW derive the public {{gN}} passage and the
                # answers, both from the tagged text itself (no separate answer mapping).
                final_text, answers_by_gap = _materialize_stage_a_text(content["text"], gap_specs)
                return final_text, answers_by_gap, {"regenerationCount": regeneration, "duplicateGapRepairCount": duplicate_repairs}
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

_CATEGORY_DISTRACTOR_RULES = {
    "grammar": (
        "wrong case/ending, wrong verb form, a plausible-but-wrong preposition, wrong connector, or a "
        "locally plausible but incorrect syntax form. Avoid random unrelated words."
    ),
    "lexicon": (
        "a near-synonym that does not collocate here, a word in the wrong register, a semantically nearby "
        "word used incorrectly, or a wrong word-formation choice."
    ),
    "orthography": (
        "a realistic spelling variant, a capitalization error, or a punctuation-sensitive variant where "
        "applicable. If the intended contrast is capitalization, a distractor that differs from the correct "
        "form only by capitalization is valid and desirable (e.g. Allgemeinen / allgemeinen, Arbeiten / "
        "arbeiten, Neues / neues). Do not replace a capitalization task entirely with random endings or "
        "invented spellings (e.g. Arbeitenen, Arbeits) unless that form is genuinely plausible in the exact slot."
    ),
}

# Shared by Stage B and item repair so both see the same slot and obey the same rule.
_SUBSTITUTION_RULE = (
    "Every distractor must be directly substitutable into sentenceWithTargetGap (replacing the {{gN}} slot) "
    "without adding, removing or repeating any surrounding word. Before you output each distractor, "
    "substitute it into the slot and check the result: reject options that create defects such as 'zu zu "
    "erfüllen', 'zu entgegenzukommen', 'sich sich überlegen', a wrong finite/non-finite form, or a wrong "
    "required ending caused by the surrounding words."
)


def _gap_frame(gap_spec: dict[str, str], correct_answer: str, ctx: dict[str, Any]) -> dict[str, Any]:
    """The exact blank frame for one gap. sentenceWithTargetGap contains ONLY this gap as a placeholder."""
    return {
        "gapId": gap_spec["gapId"],
        "category": gap_spec["category"],
        "correctAnswer": correct_answer,
        "sentenceWithTargetGap": ctx.get("sentenceWithTargetGap") or ctx.get("sentenceWithGap"),
        "sentenceWithCorrectAnswer": ctx.get("sentenceWithCorrectAnswer"),
        "previousSentence": ctx.get("previousSentence"),
        "nextSentence": ctx.get("nextSentence"),
    }


def _prompt_stage_b(
    profile: ExamProfile, part: PartBlueprint, gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str],
    gap_context_by_id: dict[str, dict[str, Any]]
) -> tuple[str, str]:
    item_count = len(gap_specs)
    lines = []
    for g in gap_specs:
        gap_id = g["gapId"]
        frame = {"questionId": g["questionId"], **_gap_frame(g, answers_by_gap[gap_id], gap_context_by_id[gap_id])}
        lines.append("  " + json.dumps(frame, ensure_ascii=False))
    gap_block = "\n".join(lines)
    category_rules = "\n".join(f"- {cat}: prefer {rule}" for cat, rule in _CATEGORY_DISTRACTOR_RULES.items())
    system = (
        f"You write multiple-choice distractors for a German Sprachbausteine (cloze) exercise, "
        f"{profile.family} {profile.variant or ''}, C1 level. For each gap below you get the exact blank "
        "frame: sentenceWithTargetGap (the slot is marked {{gN}}; any other gap in that sentence is already "
        "filled in), sentenceWithCorrectAnswer, and the neighbouring sentences. The correct answer is fixed "
        "and came from the passage itself; do not change it, and do not invent distractors from the correct "
        "answer alone. Read the frame and write THREE wrong options that "
        "look locally plausible enough to tempt a C1 learner IN THAT EXACT CONTEXT, but each must fail for "
        "ONE identifiable grammatical, lexical, collocational, register, or orthographic reason in that "
        "context — never trivial, absurd, or obviously wrong on sight, and never differing from the correct "
        "answer only in an unrelated word. Each wrong option must differ from the correct answer and from "
        "each other. "
        f"{_SUBSTITUTION_RULE}\n"
        "Category-specific guidance:\n"
        f"{category_rules}\n\n"
        "Reply with ONLY valid JSON, no markdown fences, no commentary.\n\n"
        "Gaps:\n"
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


# Strict structured output: exactly three named distractor fields per gap, so the
# option COUNT cannot be wrong. The backend still owns the correct answer,
# insertion, shuffle and correctIndex; _wrong_options_reason checks uniqueness.
_DISTRACTOR_FIELDS = ("distractor1", "distractor2", "distractor3")
_STAGE_B_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["questionId", "gapId", *_DISTRACTOR_FIELDS, "skillTags"],
        "properties": {
            "questionId": {"type": "string"}, "gapId": {"type": "string"},
            **{f: {"type": "string"} for f in _DISTRACTOR_FIELDS},
            "skillTags": {"type": "array", "items": {"type": "string"}},
        },
    }}},
}
_ITEM_REPAIR_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": [*_DISTRACTOR_FIELDS, "skillTags"],
    "properties": {**{f: {"type": "string"} for f in _DISTRACTOR_FIELDS},
                   "skillTags": {"type": "array", "items": {"type": "string"}}},
}


def _with_wrong_options(entry: Any) -> Any:
    """distractor1..3 -> the wrongOptions list the rest of the pipeline uses."""
    if isinstance(entry, dict) and "wrongOptions" not in entry and all(f in entry for f in _DISTRACTOR_FIELDS):
        out = {k: v for k, v in entry.items() if k not in _DISTRACTOR_FIELDS}
        out["wrongOptions"] = [entry[f] for f in _DISTRACTOR_FIELDS]
        return out
    return entry


def _call_stage_b(*, system: str, user: str) -> LlmResult:
    result = chat_json(system=system, user=user, max_tokens=6000, model=get_settings().german_exam_model,
                       json_schema=_STAGE_B_SCHEMA)
    if isinstance(result.data, dict) and isinstance(result.data.get("items"), list):
        result.data = {**result.data, "items": [_with_wrong_options(it) for it in result.data["items"]]}
    return result


def _stage_b_issues(payload: dict[str, Any], gap_specs: list[dict[str, str]]) -> list[str]:
    items = payload.get("items") if isinstance(payload, dict) else None
    expected_ids = {g["gapId"] for g in gap_specs}
    if not isinstance(items, list) or len(items) != len(gap_specs):
        return [f"expected {len(gap_specs)} distractor sets, got {len(items) if isinstance(items, list) else 0}"]
    found_ids = {it.get("gapId") for it in items if isinstance(it, dict)}
    if found_ids != expected_ids or len(items) != len(found_ids):
        return ["distractor sets must cover every gap exactly once"]
    return []


def _wrong_options_reason(item: Any, correct_answer: str, category: str | None = None) -> str | None:
    """Content-free reason code why a gap's distractor set is unusable, else None.
    Equality is case-insensitive except for orthography (see _norm_for_category)."""
    wrong = item.get("wrongOptions") if isinstance(item, dict) else None
    if not isinstance(wrong, list):
        return "missing_options"
    if len(wrong) != 3:
        return "wrong_option_count"
    if not all(isinstance(w, str) and w.strip() for w in wrong):
        return "empty_option"
    norm = _norm_for_category(category)
    normalized = [norm(w) for w in wrong]
    if len(set(normalized)) != 3:
        return "duplicate_option"
    if norm(correct_answer) in normalized:
        return "equals_correct_answer"
    return None


def _wrong_options_valid(item: dict[str, Any], correct_answer: str, category: str | None = None) -> bool:
    return _wrong_options_reason(item, correct_answer, category) is None  # 3 distinct wrong options, none equal to the correct answer


def _record_gap_outcome(gap_id: str, category: str, reason: str | None, round_no: int, resolved: bool,
                        initial_reason: str | None = None) -> None:
    """Safe per-gap diagnostics (ids, category, reason codes; never passage or answer text).

    ``reason`` is the validation reason of the repair CANDIDATE returned in this round
    (None when it passed); ``initialReason`` is why the gap needed repair at all."""
    from . import gen_timing  # noqa: WPS433
    timer = gen_timing.current()
    if timer is not None:
        timer.add_validation({"stage": "sprachbausteine_stage_b", "gapId": gap_id, "category": category,
                              "reason": reason, "initialReason": initial_reason,
                              "repairRound": round_no, "resolved": resolved})


def _prompt_item_repair(
    gap_spec: dict[str, str], correct_answer: str, context: dict[str, Any],
    prior_wrong_options: list[str] | None, reason: str | None
) -> tuple[str, str]:
    frame = _gap_frame(gap_spec, correct_answer, context)
    rule = _CATEGORY_DISTRACTOR_RULES.get(gap_spec["category"], "")
    prior_line = (
        f"\n\nThe previous attempt {json.dumps(prior_wrong_options, ensure_ascii=False)} was rejected"
        f"{f' ({reason})' if reason else ''} — do not repeat it."
        if prior_wrong_options else ""
    )
    system = (
        "You are fixing ONE gap's multiple-choice distractors in a German Sprachbausteine exercise. The "
        "correct answer for this gap is already fixed and came from the passage itself — do not change it, "
        "and do not invent distractors from the correct answer alone. Here is the exact blank frame "
        "(sentenceWithTargetGap marks the slot as {{gN}}; any other gap in that sentence is already filled "
        f"in): {json.dumps(frame, ensure_ascii=False)}. "
        "Provide exactly THREE wrong options (distractors), each different from the correct answer and from "
        "each other, that look locally plausible enough to tempt a C1 learner IN THAT EXACT CONTEXT but "
        f"each fail for one identifiable reason there. {_SUBSTITUTION_RULE} "
        f"Category guidance: prefer {rule}"
        f"{prior_line}\n\n"
        "Reply with ONLY a JSON object, no markdown fences, no commentary, shape exactly: "
        '{"wrongOptions": ["...", "...", "..."], "skillTags": ["..."]}.'
    )
    user = f"Gap category: {gap_spec['category']}. Fix the distractors now."
    return system, user


def _call_item_repair(*, system: str, user: str) -> LlmResult:
    result = chat_json(system=system, user=user, max_tokens=800, model=get_settings().german_exam_model,
                       json_schema=_ITEM_REPAIR_SCHEMA)
    result.data = _with_wrong_options(result.data)
    return result


def _repair_stage_b_items(
    gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str], items_by_gap: dict[str, dict[str, Any]],
    gap_context_by_id: dict[str, dict[str, Any]], round_no: int = 1,
    rejected: dict[str, tuple[list[Any] | None, str]] | None = None
) -> tuple[dict[str, dict[str, Any]], int, list[str]]:
    """Deterministic, per-item repair — mirrors german_exam_reading.py's
    _repair_items shape. Never touches the passage or any other item.
    Returns (items_by_gap, repaired_count, unresolved_gap_ids).

    ``rejected`` carries, per gap, the previous round's REJECTED repair candidate and its
    own validation reason, so the next round repairs that candidate (not the original item).
    Invalid candidates are never written into ``items_by_gap``; only a candidate that passes
    validation becomes the accepted item."""
    rejected = rejected if rejected is not None else {}
    spec_by_gap = {g["gapId"]: g for g in gap_specs}
    # Every gap the plan expects, so a gap the model omitted is repaired like any other.
    bad_reason = {
        g["gapId"]: _wrong_options_reason(items_by_gap.get(g["gapId"]), answers_by_gap[g["gapId"]], g["category"])
        for g in gap_specs
    }
    bad_gap_ids = [gid for gid, reason in bad_reason.items() if reason]
    if not bad_gap_ids:
        return items_by_gap, 0, []

    # (gap_id, accepted candidate | None, candidate's OWN wrongOptions, candidate's OWN reason)
    _Outcome: TypeAlias = tuple[str, "dict[str, Any] | None", "list[Any] | None", "str | None"]

    def _fix_one(gap_id: str) -> _Outcome:
        carried = rejected.get(gap_id)
        if carried is not None:
            # Round >= 2: repair the candidate that was just rejected, told its actual reason.
            prior_wrong, reason = carried
        else:
            prior_item = items_by_gap.get(gap_id)
            prior_wrong = prior_item.get("wrongOptions") if isinstance(prior_item, dict) else None
            prior_wrong = prior_wrong if isinstance(prior_wrong, list) else None
            reason = bad_reason.get(gap_id) if prior_wrong else None
        candidate_wrong: list[Any] | None = None
        candidate_reason: str | None = "repair_call_error"
        for _attempt in range(_MAX_ITEM_REPAIR_ATTEMPTS):
            try:
                system, user = _prompt_item_repair(
                    spec_by_gap[gap_id], answers_by_gap[gap_id], gap_context_by_id[gap_id], prior_wrong, reason
                )
                result = _call_item_repair(system=system, user=user)
                fixed = result.data
                # Validate the candidate ITSELF: its reason is what gets recorded and carried.
                candidate_reason = _wrong_options_reason(
                    fixed, answers_by_gap[gap_id], spec_by_gap[gap_id]["category"])
                if isinstance(fixed, dict) and isinstance(fixed.get("wrongOptions"), list):
                    candidate_wrong = fixed["wrongOptions"]
                if candidate_reason is None:
                    return gap_id, fixed, candidate_wrong, None
            except Exception:  # noqa: BLE001
                log.warning("Sprachbausteine item repair failed for gap %s", gap_id, exc_info=True)
                candidate_reason = "repair_call_error"
        return gap_id, None, candidate_wrong, candidate_reason

    with ThreadPoolExecutor(max_workers=min(4, len(bad_gap_ids))) as pool:
        results = list(pool.map(_fix_one, bad_gap_ids))

    unresolved: list[str] = []
    repaired = 0
    for gap_id, fixed, candidate_wrong, candidate_reason in results:
        _record_gap_outcome(gap_id, spec_by_gap[gap_id]["category"], candidate_reason, round_no,
                            fixed is not None, initial_reason=bad_reason.get(gap_id))
        if fixed is not None:
            items_by_gap[gap_id] = fixed
            rejected.pop(gap_id, None)
            repaired += 1
        else:
            # Kept OUT of items_by_gap; only fed to the next round as repair context.
            if candidate_wrong is not None and candidate_reason:
                rejected[gap_id] = (candidate_wrong, candidate_reason)
            unresolved.append(gap_id)
    return items_by_gap, repaired, unresolved


def _run_stage_b(
    profile: ExamProfile, part: PartBlueprint, gap_specs: list[dict[str, str]], answers_by_gap: dict[str, str],
    gap_context_by_id: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    expected_ids = {g["gapId"] for g in gap_specs}
    last_issues: list[str] = []
    item_repair_total = 0
    for regeneration in range(_MAX_STAGE_B_REGENERATIONS + 1):
        system, user = _prompt_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id)
        try:
            result = _call_stage_b(system=system, user=user)
            payload = result.data if isinstance(result.data, dict) else {}
        except Exception:  # noqa: BLE001 - failed/unparseable Stage B call takes the same bounded regeneration as an empty result
            log.warning("Sprachbausteine Stage B call failed", exc_info=True)
            payload = {}
        raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
        items_by_gap: dict[str, dict[str, Any]] = {}
        for it in raw_items:
            gid = it.get("gapId") if isinstance(it, dict) else None
            if gid in expected_ids and gid not in items_by_gap:
                items_by_gap[gid] = it
        if not items_by_gap:
            # Nothing usable came back at all: the only case for another FULL Stage B call.
            last_issues = ["no usable distractor sets returned"]
            if regeneration < _MAX_STAGE_B_REGENERATIONS:
                continue
            raise LanguageElementsGenerationError(
                f"could not produce valid Sprachbausteine distractors after {_MAX_STAGE_B_REGENERATIONS} "
                "regenerations: " + "; ".join(last_issues)
            )

        # Repair ONLY the gaps that are missing/invalid. The passage, the correct
        # answers and every already-valid distractor set stay frozen, so one bad
        # gap no longer doubles the whole Stage B cost.
        unresolved: list[str] = []
        rejected: dict[str, tuple[list[Any] | None, str]] = {}
        for round_no in range(1, _MAX_TARGETED_REPAIR_ROUNDS + 1):
            items_by_gap, repaired, unresolved = _repair_stage_b_items(
                gap_specs, answers_by_gap, items_by_gap, gap_context_by_id, round_no, rejected
            )
            item_repair_total += repaired
            if not unresolved:
                return items_by_gap, {"regenerationCount": regeneration, "itemRepairCount": item_repair_total}
        raise LanguageElementsGenerationError(
            "could not produce valid Sprachbausteine distractors after per-gap repair: "
            + "; ".join(f"gap {gid} distractors still invalid" for gid in unresolved)
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


def _unsupported_correct_answer_only(part: PartBlueprint, item_errors: dict[str, list[Any]]) -> dict[str, list[Any]]:
    """For Sprachbausteine, splits out items whose ONLY finding is
    UNSUPPORTED_CORRECT_ANSWER. That correct answer came from Stage A — the
    passage was written around it — and _constrain_repair now freezes it
    unconditionally, so sending these to repair_items_semantic can never
    actually resolve the issue (Stage B repair owns distractors only, never
    the correct answer). Excluding them here means one fewer doomed
    repair+reverify round-trip: they surface as a hard failure (the caller
    raises, the frontend shows Retry, a fresh Stage A runs) instead of
    silently burning the single repair-round budget on something it
    structurally cannot fix — directly targets the "Stage B -> verifier ->
    repair -> verifier -> 524" latency spiral."""
    if part.task_type != "cloze_mc4_language_elements":
        return item_errors
    return {
        item_id: issues for item_id, issues in item_errors.items()
        if not (issues and all(i.code == "UNSUPPORTED_CORRECT_ANSWER" for i in issues))
    }


_FINDING_CATEGORIES = ("grammar", "lexicon", "orthography")
_PART_WIDE_BUCKET = "part_wide"


def _new_category_counts() -> dict[str, dict[str, int]]:
    return {**{c: {} for c in _FINDING_CATEGORIES}, _PART_WIDE_BUCKET: {}}


def _aggregate_findings(
    result: SemanticVerificationResult, content: dict[str, Any],
    counts_by_category: dict[str, dict[str, int]], item_findings: list[dict[str, Any]], verification_no: int,
) -> None:
    """Content-free semantic diagnostics by gap category (S7a). Category comes from the assembled
    questions, so the generic verifier stays unaware of TELC categories. Part-wide findings get
    their own bucket, never a category. No passage, answer or option text is recorded."""
    question_meta = {
        q.get("questionId"): (q.get("gapId"), q.get("category"))
        for q in (content.get("questions") or []) if isinstance(q, dict)
    }
    for issue in result.part_wide_issues:
        bucket = counts_by_category[_PART_WIDE_BUCKET]
        bucket[issue.code] = bucket.get(issue.code, 0) + 1
    for item in result.items:
        if not item.issues:
            continue
        gap_id, category = question_meta.get(item.item_id, (None, None))
        bucket = counts_by_category.setdefault(category if category in _FINDING_CATEGORIES else "unknown", {})
        for issue in item.issues:
            bucket[issue.code] = bucket.get(issue.code, 0) + 1
        item_findings.append({
            "verification": verification_no, "questionId": item.item_id, "gapId": gap_id,
            "category": category, "issueCodes": sorted({i.code for i in item.issues}),
        })


def _verify_part(part: PartBlueprint, content: dict[str, Any]) -> SemanticVerificationResult:
    """Sprachbausteine's 22-item verification runs as bounded concurrent chunks (8/7/7) through the
    unchanged verify_semantic: same model, prompt, schema and reasoning effort. Only the transport
    differs (a single 22-item call let hidden reasoning consume the whole budget and return nothing)."""
    if part.task_type == "cloze_mc4_language_elements":
        return verify_semantic_chunked(part, content, verify_semantic)
    return verify_semantic(part, content)


def _semantic_phase(part: PartBlueprint, content: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Unchanged from the monolithic version — every item-level semantic
    error here IS eligible for targeted repair (no task_type is excluded),
    since a Sprachbausteine defect always lives entirely inside one item's
    own options/correctIndex/category. The one exception is
    UNSUPPORTED_CORRECT_ANSWER for Sprachbausteine — see
    _unsupported_correct_answer_only()."""
    started = perf_counter()
    verification_count = 0
    repair_count = 0
    issues_resolved: list[dict[str, str]] = []
    issue_counts: dict[str, int] = {}

    counts_by_category = _new_category_counts()
    item_findings: list[dict[str, Any]] = []

    def record_findings(result: SemanticVerificationResult) -> None:
        findings = list(result.part_wide_issues)
        findings.extend(issue for item in result.items for issue in item.issues)
        for issue in findings:
            issue_counts[issue.code] = issue_counts.get(issue.code, 0) + 1
        _aggregate_findings(result, content, counts_by_category, item_findings, verification_count)

    def check() -> SemanticVerificationResult:
        # ONE verification per check. The chunk wrapper owns the single bounded structural fallback;
        # restarting the whole verification here would re-run every chunk and defeat that bound.
        nonlocal verification_count
        result = _verify_part(part, content)
        verification_count += 1
        record_findings(result)
        return result

    result = check()

    for _round in range(_MAX_SEMANTIC_REPAIR_ROUNDS):
        part_wide_errors = result.part_wide_error_issues()
        item_errors = result.item_error_issues()
        if not part_wide_errors and not item_errors:
            break
        if result.terminal_verifier_failure:
            break
        if any(issue.code == "VERIFIER_RESPONSE_INVALID" for issues in item_errors.values() for issue in issues):
            break
        if part_wide_errors:
            break

        repairable_errors = _unsupported_correct_answer_only(part, item_errors)
        if not repairable_errors:
            break

        content, resolved = repair_items_semantic(part, content, repairable_errors)
        repair_count += len(repairable_errors)
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
        "issueCountsByCategory": counts_by_category,
        "itemFindings": item_findings,
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
    gap_context_by_id = _build_gap_context(text, gap_specs, answers_by_gap)
    items_by_gap, stage_b_meta = _run_stage_b(profile, part, gap_specs, answers_by_gap, gap_context_by_id)

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
