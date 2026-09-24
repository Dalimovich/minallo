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
import re
from .gen_timing import ContextThreadPoolExecutor as ThreadPoolExecutor
from time import perf_counter
from typing import Any

from ..config import get_settings

from .german_exam_adaptation import AdaptationInstruction
from .german_exams import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full as verify_semantic
from .german_exam_semantic_repair import repair_items_semantic
from .german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult
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


def word_range(constraints: dict, default_min: int, default_max: int) -> tuple[int, int]:
    """Target word range from a blueprint. Exact bounds (`wordCountMin/Max`) win; where the official
    source only says "circa N" (`wordCountApprox`) the range is N ±10 % — never an invented hard limit."""
    if "wordCountMin" in constraints or "wordCountMax" in constraints:
        return constraints.get("wordCountMin", default_min), constraints.get("wordCountMax", default_max)
    approx = constraints.get("wordCountApprox")
    if approx:
        return round(approx * 0.9), round(approx * 1.1)
    return default_min, default_max


def _base_system_preamble(profile: ExamProfile, part: PartBlueprint) -> str:
    text_kind = (
        "coherent text of the required genre"
        if part.constraints.get("textGenre")
        else "coherent academic or study-relevant text"
    )
    return (
        f"You generate ORIGINAL German reading-exam practice content for {profile.family} "
        f"{profile.variant or ''} ({part.title}), matching the official {part.task_type} task format. "
        f"You must NOT copy any real exam content — generate an entirely new, {text_kind} "
        "with the same structure and difficulty. Reply with ONLY valid JSON, no "
        "markdown fences, no commentary."
    )


def _reconstruction_text_description(part: PartBlueprint, topic: dict[str, str], word_min: int, word_max: int) -> str:
    genre = part.constraints.get("textGenre")
    if not genre:
        return f"one coherent academic/study-relevant text of {word_min}-{word_max} words on the topic '{topic['label']}'"
    total = part.constraints.get("wordCountWithSentencesApprox")
    restored = f" (about {total} words once the removed sentences are restored)" if total else ""
    return (
        f"one coherent original {genre} on the topic '{topic['label']}', {word_min}-{word_max} words for the "
        f"text WITHOUT the removed sentences{restored}"
    )


def _reconstruction_quality_rules(part: PartBlueprint) -> str:
    """Extra gap-design rules, only for blueprints that declare a text genre (Goethe). Kept out of the
    default prompt so exams that never used them (telc) produce exactly the prompt they always did."""
    if not part.constraints.get("textGenre"):
        return ""
    word_min, word_max = word_range(part.constraints, 400, 500)
    return (
        "\n\nLength: models tend to write too little. Write 8 to 10 paragraphs of 55-75 words each, so the "
        f"text WITHOUT the removed sentences has between {word_min} and {word_max} words (aim for about "
        f"{part.constraints.get('wordCountApprox', word_max)}). It must NOT be shorter than {word_min} words."
        "\n\nGap-design rules (the answer must be reasoned from DISCOURSE, not guessed):\n"
        "- Each removed sentence is ONE complete sentence (a statement, a rhetorical question, a "
        "consequence, an example, a concession ...).\n"
        "- TWO-WAY BINDING (the most important rule): every removed sentence must be tied to its own spot by "
        "BOTH neighbours. (a) It points BACK: it contains a reference or connector that only makes sense "
        "after the sentence before it (a demonstrative such as 'dieser Ansatz'/'diese Zahl', a pronoun, "
        "'dabei', 'dennoch', 'im Gegensatz dazu', or a question that the sentence before raises). (b) The "
        "sentence AFTER it picks up something that is introduced ONLY by the removed sentence (a term, "
        "a number, an example, an objection) with 'das', 'dies', 'dieser', 'dort', 'damit' or a connector.\n"
        "- Forbidden: generic summary, moral or filler sentences that could be inserted almost anywhere "
        "('Gerade deshalb braucht es klare Regeln.', 'Anders gesagt: ...', 'Das zeigt, wie komplex das Thema "
        "ist.'). Every removed sentence must carry specific content of THIS article.\n"
        "- Before you output, test each gap: could a second candidate stand in this gap without breaking a "
        "reference, a connector or the logic? If yes, rewrite one of them.\n"
        "- Two gaps must never be adjacent or in the same short stretch of text; spread them across the "
        "whole text and put at least one gap right at the start of a paragraph and one inside a paragraph.\n"
        "- Candidate sentences must NOT share the same opening word or connector pattern, must vary in length "
        "and function, and must be listed in a scrambled order (not in the order of the gaps).\n"
        "- The unused candidates must sound like they belong to this article (same topic, same register) but "
        "each must clearly break for EVERY gap once read carefully: it repeats what the text already says, "
        "contradicts the argument, uses a reference ('dieser', 'sie', 'dort') that has no possible antecedent "
        "at that spot, or belongs to a different line of argument. Never make an unused candidate absurd.\n"
        "- No two candidates may be defensible for the same gap, and no candidate may fit two gaps.\n"
        "- The article must read as one natural, original piece once every correct sentence is restored."
    )


# ── Lesen 1: text_reconstruction_sentence_matching ──────────────────────────


def _prompt_lesen1(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    gap_count = part.constraints.get("gapCount", 6)
    candidate_count = part.constraints.get("candidateCount", 8)
    unused = part.constraints.get("unusedCandidates", 2)
    word_min, word_max = word_range(part.constraints, 400, 500)

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): {_reconstruction_text_description(part, topic, word_min, word_max)}, "
        "split into paragraphs, with "
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
        f"reworded idea is what's needed. Use at least 3 different tags across the {gap_count} items."
        f"{_reconstruction_quality_rules(part)}\n\n"
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


# ── reading_detail_mc3 (Goethe Lesen Teil 2) ────────────────────────────────


def _prompt_reading_detail_mc3(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    item_count = part.constraints.get("itemCount", 7)
    option_count = part.constraints.get("optionCount", 3)
    word_min, word_max = word_range(part.constraints, 600, 750)
    genre = part.constraints.get("textGenre") or "informational article"
    follow_order = part.constraints.get("itemsFollowTextOrder")

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one original {genre} on the topic '{topic['label']}', "
        f"{word_min}-{word_max} words, split into 8 to 10 paragraphs with stable ids (p1, p2, ...). Models tend "
        f"to write too little: each paragraph should have 65-90 words and the whole text must NOT be shorter "
        f"than {word_min} words. Then exactly {item_count} multiple-choice items, each with a question or "
        f"sentence stem and exactly {option_count} options, exactly one of which is correct."
        + (" The items must follow the ORDER of the text (each item's evidence is at or after the previous item's)." if follow_order else "")
        + "\n\nItem design — test real comprehension, not phrase matching:\n"
        "- Mix the item types across the set: a detail that must be located and understood; the relationship "
        "between two facts (cause, condition, contrast, consequence); what the AUTHOR reasons, criticises or "
        "concludes; what follows implicitly from a passage; which option correctly rephrases a statement; "
        "the purpose of an example.\n"
        "- The correct option must be a PARAPHRASE of the text. Never reuse a run of seven or more consecutive "
        "words from the text in the correct option, and do not let the stem quote the text either.\n"
        "- Each wrong option must be plausible and arise from the text: a true detail attached to the wrong "
        "thing, a partial truth, a wrong cause/effect or wrong attribution, a distorted or over-generalised "
        "paraphrase, or something from a nearby passage that does not answer THIS question. Never an absurd "
        "option, never one decidable from general knowledge alone, never one that is ALSO supported by the "
        "text. Never use options like 'alle genannten' or 'keine der Aussagen'.\n"
        "- The three options of an item must have the same grammatical form and similar length; the correct "
        "one must not be systematically the longest or the most detailed.\n"
        "- Do not try to balance the position of the correct option; the application scrambles the options.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item, and use at least 4 "
        f"different tags across the {item_count} items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Every item lists evidenceParagraphIds: the paragraph id(s) that decide the answer.\n\n"
        "Output JSON shape exactly (skillTags illustrative):\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": [{"paragraphId": "p1", "text": "..."}, ...]},\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["detail_comprehension"], "difficulty": "c1",\n'
        '     "mc3": {"stem": "...", "options": ["...", "...", "..."], "correctIndex": 1,\n'
        '             "evidenceParagraphIds": ["p2"]}},\n'
        "    ...\n"
        f"  ] // exactly {item_count} items\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


# ── reading_multiple_choice (Digital TestDaF Lesen 3) ───────────────────────


def _prompt_reading_multiple_choice(profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]) -> tuple[str, str]:
    item_count = part.constraints["itemCount"]
    option_count = part.constraints["optionCount"]
    word_min, word_max = (part.constraints["generationWordCountMin"], part.constraints["generationWordCountMax"])
    genre = part.constraints.get("textGenre") or "informational article"
    follow_order = part.constraints.get("itemsFollowTextOrder")

    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one original {genre} on the topic '{topic['label']}', "
        f"{word_min}-{word_max} words, split into {part.constraints['generationParagraphCount']} paragraphs "
        f"with stable ids (p1, p2, ...). The whole text must NOT be shorter "
        f"than {word_min} words. Then exactly {item_count} multiple-choice items, each with a question or "
        f"sentence stem and exactly {option_count} options, exactly one of which is correct."
        + (" The items must follow the ORDER of the text (each item's evidence is at or after the previous item's), except a global-scope item refers to the whole article." if follow_order else "")
        + "\n\nItem design — test real comprehension, not phrase matching:\n"
        "- Mix the item types across the set: a detail that must be located and understood; the relationship "
        "between two facts (cause, condition, contrast, consequence); what the AUTHOR reasons, criticises or "
        "concludes; what follows implicitly from a passage; which option correctly rephrases a statement; "
        "the purpose of an example.\n"
        "- The correct option must be a PARAPHRASE of the text. Never reuse a run of seven or more consecutive "
        "words from the text in the correct option, and do not let the stem quote the text either.\n"
        "- Each wrong option must be plausible and arise from the text: a true detail attached to the wrong "
        "thing, a partial truth, a wrong cause/effect or wrong attribution, a distorted or over-generalised "
        "paraphrase, or something from a nearby passage that does not answer THIS question. Never an absurd "
        "option, never one decidable from general knowledge alone, never one that is ALSO supported by the "
        "text. Never use options like 'alle genannten' or 'keine der Aussagen'.\n"
        "- A distractor must differ from a text-supported proposition in ONE subtle respect (scope, "
        "attribution, causal direction, timing, or inference). Do not make every wrong answer an extreme "
        "claim using always, only, all, never, automatically, or a blanket rejection. Global-purpose "
        "distractors must describe real secondary emphases of THIS text, not unrelated genres or topics. "
        "Silently test every option against the full paragraph: no two options may be synonymous or "
        "both entailments. Supply concrete mechanisms, qualifications and competing explanations in the "
        "article so questions cannot be solved from generic common sense.\n"
        "- All options of an item must have the same grammatical form and similar length; the correct "
        "one must not be systematically the longest or the most detailed.\n"
        "- Do not try to balance the position of the correct option; the application scrambles the options.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item, and use at least 4 "
        f"different tags across the {item_count} items.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        f"Reading register and difficulty: {part.constraints['readingRegister']}.\n"
        f"Question design: {part.constraints['questionStyle']}.\n"
        f"Per-question scope in order: {part.constraints['questionScopes']}.\n"
        "For scope pN cite only that paragraph; for scope global cite all paragraphs.\n"
        "Every item lists evidenceParagraphIds: the paragraph id(s) that decide the answer.\n\n"
        "Output JSON shape exactly (skillTags illustrative):\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": [{"paragraphId": "p1", "text": "..."}, ...]},\n'
        '  "questions": [\n'
        '    {"questionId": "q1", "skillTags": ["detail_comprehension"], "difficulty": "c1",\n'
        f'     "mc3": {{"stem": "...", "options": {json.dumps(["..."] * option_count)}, "correctIndex": 1,\n'
        '             "evidenceParagraphIds": ["p2"]}},\n'
        "    ...\n"
        f"  ] // exactly {item_count} items\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


def _option_holder(question: Any) -> dict[str, Any] | None:
    """The dict that carries `options` + `correctIndex`: `mc3` for comprehension items, the item itself for cloze gaps."""
    if not isinstance(question, dict):
        return None
    mc3 = question.get("mc3")
    if isinstance(mc3, dict) and isinstance(mc3.get("options"), list):
        return mc3
    if isinstance(question.get("options"), list):
        return question
    return None


def balance_option_positions(content: dict[str, Any]) -> dict[str, Any]:
    """Deterministically move each item's correct option to a balanced, seeded position (LLMs put the
    key in the middle far too often). Only swaps two options inside one item; text and keys stay consistent."""
    questions = content.get("questions")
    if not isinstance(questions, list) or not questions:
        return content
    import copy
    import hashlib
    import random

    seed = hashlib.sha256(json.dumps(questions, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    rng = random.Random(seed)
    width = 3
    for q in questions:
        holder = _option_holder(q)
        if holder is not None:
            width = len(holder["options"]) or 3
            break
    targets = [i % width for i in range(len(questions))]
    rng.shuffle(targets)
    out = copy.deepcopy(content)
    for q, target in zip(out["questions"], targets):
        holder = _option_holder(q)
        if holder is None:
            continue
        idx = holder.get("correctIndex")
        options = holder["options"]
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < len(options) and target < len(options):
            options[idx], options[target] = options[target], options[idx]
            holder["correctIndex"] = target
    return out


# ── multi_author_statement_matching_with_none (Goethe Lesen Teil 4) ──────────


def _prompt_multi_author_statement_matching(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[str, str]:
    author_count = part.constraints.get("authorCount", 3)
    statement_count = part.constraints.get("statementCount", 7)
    unmatched = part.constraints.get("unmatchedStatements", 2)
    approx = part.constraints.get("wordCountApprox", 430)
    per_author = round(approx / author_count)
    ids = [chr(ord("a") + i) for i in range(author_count)]
    matched = statement_count - unmatched
    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): {author_count} short opinion texts by {author_count} DIFFERENT authors "
        f"(authorId {', '.join(repr(i) for i in ids)}) on the topic '{topic['label']}', about {per_author} words each "
        f"({approx} words in total). The authors must clearly differ in stance and reasoning, write in their own voice "
        "and register (for example a forum post, a reader letter, a short column), and each argues from a concrete "
        "position. Then exactly "
        f"{statement_count} statements. {matched} statements are each asserted by exactly ONE author and NO other author; "
        f"{unmatched} statements are asserted by NO author (correctAuthorId 'none'). A 'none' statement must be plausible "
        "for the topic and touch things the authors discuss, but no author states or clearly implies it (it may be an "
        "overgeneralisation, a reversal, or an aspect nobody raises) — never a statement that one author actually makes "
        "in other words.\n\n"
        "Rules for the statements: each statement paraphrases what an author expresses (an opinion, reason, "
        "concession, recommendation or attitude); it must NOT reuse the author's own wording (no run of 6 or more "
        "consecutive words) and must not be decidable by spotting one keyword. Every author must be the answer to "
        "at least one statement. For each matched statement give evidenceQuote: a verbatim excerpt of 4-14 words "
        "copied exactly from the named author's text that supports it, and which appears in NO other author's text. "
        "For 'none' statements set evidenceQuote to an empty string.\n\n"
        "IMPORTANT — choose skillTags per item, do not copy one tag for every item; use at least 3 different tags.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "text": {"title": "...", "authors": [{"authorId": "a", "name": "...", "text": "..."}, ...]} // exactly '
        f"{author_count} authors\n"
        '  "questions": [\n'
        '    {"questionId": "q1", "statement": "...", "correctAuthorId": "a" (or "b"/"c"/"none"),\n'
        '     "evidenceQuote": "...", "skillTags": ["author_intention"], "difficulty": "c1"},\n'
        "    ...\n"
        f"  ] // exactly {statement_count} entries\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user



# ── contextual_cloze_mc4 (Goethe Lesen Teil 1) ──────────────────────────────


def _prompt_contextual_cloze_mc4(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> tuple[str, str]:
    gap_count = part.constraints.get("gapCount", 8)
    example = part.constraints.get("exampleGapCount", 0)
    option_count = part.constraints.get("optionCount", 4)
    approx = part.constraints.get("wordCountApprox", 320)
    gap_ids = ([" {{g0}}"] if example else []) + [f"{{{{g{i}}}}}" for i in range(1, gap_count + 1)]
    system = _base_system_preamble(profile, part) + (
        f"\n\nTask structure (IMMUTABLE): one coherent, natural expository text of about {approx} words on the topic "
        f"'{topic['label']}', written for an educated general readership. Replace {gap_count + example} single words or short "
        f"fixed phrases by the literal placeholders {', '.join(p.strip() for p in gap_ids)} (each EXACTLY once, in this reading order, "
        "spread across the whole text). "
        + ("{{g0}} is the solved EXAMPLE: it is given a full item like the others, and it should be one of the easier gaps. " if example else "")
        + f"Every gap is answered by an item with exactly {option_count} options and one correct answer.\n\n"
        "The gaps must test how the WORDING fits the CONTEXT of the whole sentence and the surrounding sentences at C1 level: "
        "precise lexical choice and collocation, connectors and text-cohesive words, a word the argument requires, fixed "
        "expressions, register. Every wrong option is a real word of the same word class and form that fits the immediate "
        "grammar of the gap but is wrong for the meaning or the collocation in THIS text; exactly one option is defensible. "
        "Never use a synonym that could also be correct, and never a wrong option that is absurd or of a different word class "
        "(no giveaways by grammar alone). Do not gap words whose only alternatives are equally acceptable.\n\n"
        "IMPORTANT — the correct answer must sit in a different position across items: do not keep it mostly in the same slot. "
        "Choose skillTags per item and use at least 3 different tags.\n\n"
        f"{_adaptation_guidance(plan)}\n\n"
        "Output JSON shape exactly:\n"
        "{\n"
        '  "text": {"title": "...", "paragraphs": ["... {{g0}} ...", "..."]},\n'
        + ('  "example": {"gapId": "g0", "options": ["...", "...", "...", "..."], "correctIndex": 0},\n' if example else "")
        + '  "questions": [\n'
        '    {"questionId": "q1", "gapId": "g1", "options": ["...", "...", "...", "..."], "correctIndex": 2,\n'
        '     "skillTags": ["paraphrase_mapping"], "difficulty": "c1"},\n'
        "    ...\n"
        f"  ] // exactly {gap_count} entries for g1..g{gap_count}\n"
        "}\n"
        f"skillTags must only use values from this list: {sorted(part.allowed_skill_tags)}."
    )
    user = f"Generate the content now. Topic: {topic['label']}."
    return system, user


def _generate_mc_article_then_items(profile: ExamProfile, part: PartBlueprint, topic: dict[str, str]) -> dict[str, Any]:
    """Separate source writing from close-reading item design; blueprint owns policy.

    Writer option notes force concrete text-based distractors but are discarded:
    the independent verifier receives only the article and the learner items.
    """
    c = part.constraints
    source_system = _base_system_preamble(profile, part) + (
        f" Write only an original {c['textGenre']} on {topic['label']}. "
        f"Use {c['generationParagraphCount']} paragraphs, IDs p1, p2, ...; "
        f"{c['generationWordCountMin']}-{c['generationWordCountMax']} words total. "
        f"Register: {c['readingRegister']}. "
        "Each paragraph must advance a distinct point with concrete mechanisms, qualifications, "
        "and at least two related but distinguishable facts. Avoid a generic advantages/disadvantages "
        "essay whose conclusion is simply 'it depends'. Use an informative opening, a specific tension "
        "or surprising finding, and an argued conclusion. Do not invent citations or precise study "
        "statistics. Explain specialist terms in context. Do not write questions yet. "
        'Return {"title":"...", "paragraphs":[{"paragraphId":"p1","text":"..."}, ...]}.'
    )
    article = chat_json(system=source_system, user="Write the article now.",
                        model=c["sourceModel"], max_tokens=c["sourceMaxTokens"]).data
    item_system = (
        "Design a demanding German reading comprehension exercise from the supplied finished article. "
        "Do NOT rewrite or change the article. Return JSON only. "
        f"Create {c['itemCount']} questions in sequence q1..q{c['itemCount']}, each with exactly "
        f"{c['optionCount']} options and one correctIndex. "
        f"Question scopes in order: {c['questionScopes']}. Scope pN means use that paragraph ONLY; "
        "global means the communicative purpose of the whole article. "
        f"Question styles: {c['questionStyle']}. Register: {c['readingRegister']}. "
        "For each distractor FIRST identify a real detail in the article, THEN change just one relation "
        "(cause, agent, condition, scope, sequence, or the author's aim). All choices must sound like "
        "credible claims from this very article. Avoid options about missing topics, ridiculous behavior, "
        "blanket dismissal of the article's premise, or obvious common-sense falsehoods. Do not sprinkle "
        "only/always/never/automatically into wrong answers: these shortcuts destroy the exercise. "
        "Global distractors should elevate a real subordinate argument into the article's main purpose. "
        "Keep options parallel and similar in specificity and length. No two options may be defensible "
        "answers, even if one is a shorter or less precise paraphrase of the other. "
        "Correct answers must be paraphrases, never copying seven consecutive article words. "
        "Use explicit paragraph references in scoped stems. "
        f"Allowed skillTags: {list(part.allowed_skill_tags)}; use diverse tags. "
        "For each question also provide optionChecks: one short editorial note per option citing "
        "the concrete source detail and why this choice answers the stem or misrepresents that detail. "
        "If you cannot cite a real source detail for a distractor, replace that distractor before replying. "
        "These are concise evidence annotations, not a reasoning transcript. "
        'Return {"questions":[{"questionId":"q1","skillTags":["detail_comprehension"],'
        '"difficulty":"c1","mc3":{"stem":"...","options":[...],"correctIndex":0,'
        '"evidenceParagraphIds":["p1"]},"optionChecks":["...", ...]}, ...]}. '
        "For global questions evidenceParagraphIds lists every paragraph."
    )
    result = chat_json(system=item_system, user=json.dumps(article, ensure_ascii=False),
                       model=c["generationModel"], max_tokens=c["generationMaxTokens"],
                       reasoning_effort=c["generationReasoningEffort"]).data
    questions = result.get("questions", []) if isinstance(result, dict) else []
    for question in questions if isinstance(questions, list) else []:
        if isinstance(question, dict):
            question.pop("optionChecks", None)
    return {"text": article, "questions": questions}


_PROMPT_BUILDERS = {
    "reading_detail_mc3": _prompt_reading_detail_mc3,
    "reading_multiple_choice": _prompt_reading_multiple_choice,
    "multi_author_statement_matching_with_none": _prompt_multi_author_statement_matching,
    "contextual_cloze_mc4": _prompt_contextual_cloze_mc4,
    "text_reconstruction_sentence_matching": _prompt_lesen1,
    "section_statement_matching": _prompt_lesen2,
    "detail_tristate_with_global_heading": _prompt_lesen3,
}


# ── text_reconstruction, article-first generation (blueprint `generationMode`) ───
#
# Single-shot generation asks one call to write the article AND eight discourse-bound removable
# sentences AND distractors at once; measured live it produced ambiguous or loosely bound gaps most
# of the time. The article-first mode splits the work: (1) write ONE coherent article as addressable
# sentences, (2) choose which sentences to remove and write the distractors, (3) assemble the gaps
# deterministically. The restored text is coherent by construction and placeholder integrity cannot
# be wrong. The semantic verifier still judges the result.

_RECONSTRUCTION_TAGS = ("reference_resolution", "text_structure", "argument_structure", "paraphrase_mapping")


def _article_prompt(profile: ExamProfile, part: PartBlueprint, topic: dict[str, str]) -> tuple[str, str]:
    total = part.constraints.get("wordCountWithSentencesApprox") or part.constraints.get("wordCountApprox", 600)
    low, high = round(total * 0.9), round(total * 1.1)
    genre = part.constraints.get("textGenre", "press article")
    gap_count = part.constraints.get("gapCount", 8)
    system = _base_system_preamble(profile, part) + (
        f"\n\nWrite ONE original {genre} in German on the topic '{topic['label']}'. Length: {low}-{high} words in "
        "total. Models write far too little, so follow this arithmetic exactly: 11 paragraphs of 5 sentences "
        "(55 sentences), every sentence 14 to 22 words long (full, information-rich sentences with subordinate "
        "clauses — never short ones). Register: natural C1 press German with an argumentative line (thesis, "
        "examples, objections, concessions, consequences).\n"
        "The text must be tightly COHESIVE, because sentences will later be removed and the reader must "
        "restore them from context: use demonstratives and pronouns that point to the previous sentence "
        "('dieser Ansatz', 'diese Zahl', 'dabei', 'damit'), connectors that express a specific relation "
        "('allerdings', 'dennoch', 'im Gegenzug', 'deshalb', 'zudem'), rhetorical questions that the next "
        "sentence answers, and terms that are introduced in one sentence and picked up in the next. Avoid "
        "generic filler sentences. Every sentence must be a single complete sentence.\n\n"
        f"While writing, DESIGN exactly {gap_count} ANCHOR sentences: sentences that will later be removed from "
        "the text as gaps. Write each anchor so that it is firmly bound to its spot by BOTH neighbours: it points "
        "back with a demonstrative/pronoun/connector that only works after the previous sentence (or answers a "
        "question the previous sentence raises), and the NEXT sentence picks up a term, number, example or "
        "objection that only the anchor introduces. Give the anchors different functions (example, consequence, "
        "concession, definition, rhetorical question, contrast, evaluation ...) so that no two could swap "
        "places. Anchors: never the first sentence of the article, never two consecutive sentences, spread "
        "over the first, middle and last third of the text.\n"
        'Output JSON exactly: {"title": "...", "paragraphs": [["Satz 1.", "Satz 2.", ...], ["..."]], '
        '"anchors": [{"paragraph": 2, "sentence": 3, "function": "example", "skillTag": "reference_resolution"}, '
        f"... exactly {gap_count} entries]}} — every paragraph is an array of its sentences as separate strings; "
        "paragraph and sentence numbers are 1-based positions in that array; skillTag is one of "
        f"{list(_RECONSTRUCTION_TAGS)}."
    )
    return system, f"Write the article now. Topic: {topic['label']}."


def _anchors_to_removed(article: dict[str, Any], paragraphs: list[list[str]], numbered: list[tuple[str, str]]) -> list[dict[str, Any]] | None:
    """Translate the writer's (paragraph, sentence) anchors into sentence ids; None if malformed."""
    anchors = article.get("anchors")
    if not isinstance(anchors, list):
        return None
    starts, total = [], 0
    for para in paragraphs:
        starts.append(total)
        total += len(para)
    removed: list[dict[str, Any]] = []
    for a in anchors:
        try:
            p, sn = int(a["paragraph"]), int(a["sentence"])
            if not 1 <= p <= len(paragraphs) or not 1 <= sn <= len(paragraphs[p - 1]):
                return None
            removed.append({"id": numbered[starts[p - 1] + sn - 1][0], "function": a.get("function"), "skillTag": a.get("skillTag")})
        except (KeyError, TypeError, ValueError):
            return None
    return removed


def _distractor_prompt(part: PartBlueprint, numbered: list[tuple[str, str]], removed_ids: list[str]) -> tuple[str, str]:
    unused = part.constraints.get("unusedCandidates", 2)
    gap_count = part.constraints.get("gapCount", 8)
    lines = "\n".join(
        f"{sid}: {'[REMOVED — becomes a gap] ' if sid in removed_ids else ''}{text}" for sid, text in numbered
    )
    system = (
        "You finish a German C1 sentence-reconstruction exercise. The article below has numbered sentences; the "
        f"{gap_count} sentences marked [REMOVED] become gaps. Write exactly {unused} DISTRACTOR sentences. Each must "
        "be ONE complete sentence in the same register and on the topic, so it sounds as if it belongs to the "
        f"article — but it must be UNAMBIGUOUSLY unable to fit any of the {gap_count} gaps. Generic on-topic "
        "sentences ('Auch in anderen Bereichen ...', 'Zudem spielt ... eine Rolle') are NOT acceptable: a reader "
        "could place them almost anywhere. Each distractor MUST fail for a hard, checkable reason, one of:\n"
        "  (a) DANGLING REFERENCE: it contains a demonstrative or pronoun phrase ('diese Studie', 'dieser "
        "Vorschlag', 'jene Regelung', 'dort') whose antecedent appears NOWHERE in the article, so it cannot "
        "follow any sentence; or\n"
        "  (b) CONTRADICTION: it states the opposite of a concrete claim the article makes elsewhere, so it "
        "cannot stand in any gap without breaking the argument.\n"
        "Use one of each if possible. It must make a DIFFERENT claim from every removed sentence (no paraphrase, "
        "no shared key terms with them) and must never be absurd. In breaksBecause name the reason "
        "('dangling reference: ...' or 'contradiction: ...'). Reply with ONLY valid JSON: "
        f'{{"distractors": [{{"text": "...", "breaksBecause": "..."}}, ... exactly {unused} entries]}}'
    )
    return system, lines


def _selection_prompt(part: PartBlueprint, article: dict[str, Any], numbered: list[tuple[str, str]]) -> tuple[str, str]:
    gap_count = part.constraints.get("gapCount", 8)
    unused = part.constraints.get("unusedCandidates", 2)
    lines = "\n".join(f"{sid}: {text}" for sid, text in numbered)
    system = (
        "You prepare a German C1 sentence-reconstruction exercise from an existing article whose sentences are "
        f"numbered. Choose exactly {gap_count} sentences to REMOVE (they become the gaps), and write exactly "
        f"{unused} DISTRACTOR sentences. Reply with ONLY valid JSON, no fences, no commentary.\n\n"
        "Rules for the removed sentences:\n"
        "- Never remove the first sentence of the article, and never two consecutive sentences. Spread them "
        "over the whole article (some in the first third, some in the middle, some in the last third).\n"
        "- Choose sentences that are firmly BOUND to their place: the removed sentence points back to the one "
        "before it (a demonstrative, pronoun or connector that only works there, or it answers a question "
        "raised there), and the sentence after it picks up something only the removed sentence introduced. "
        "Never choose a generic sentence that could stand almost anywhere.\n"
        "- The removed sentences must differ in function (example, consequence, concession, definition, "
        "rhetorical question, contrast, evaluation ...) so that no two of them could swap places.\n"
        "- For each, give its skillTag: one of "
        f"{list(_RECONSTRUCTION_TAGS)} — whichever describes what the reader must use to place it.\n\n"
        f"Rules for the {unused} distractors: each must be ONE complete sentence in the same register and on "
        "the topic of the article, so it sounds as if it belongs — but it must clearly not fit ANY of the "
        f"{gap_count} gaps once read carefully: it repeats what the text already says, contradicts the "
        "argument, has a reference ('dieser', 'sie', 'dort') without a possible antecedent, or belongs to a "
        "different line of argument. It must not paraphrase any removed sentence and must not reuse the "
        "hook words of a removed sentence. Never make it absurd.\n\n"
        'Output JSON exactly: {"removed": [{"id": "s7", "function": "example", "skillTag": "reference_resolution"}, '
        f'... exactly {gap_count} entries], "distractors": [{{"text": "...", "breaksBecause": "..."}}, ... exactly '
        f"{unused} entries]}}"
    )
    return system, f"Article title: {article.get('title', '')}\n\nSentences:\n{lines}"


def _content_words(text: str) -> set[str]:
    """Lower-cased words of 5+ letters with a crude 4-letter stem, so 'Dialog'/'Dialogs' and
    'ersetzen'/'ersetzt' overlap. Only used to detect near-paraphrases between two sentences."""
    return {w[:5] for w in re.findall(r"[a-zäöüß]{5,}", text.lower())}


def near_paraphrase(a: str, b: str, threshold: float = 0.45) -> bool:
    """True when `a` reuses at least `threshold` of its content words in `b` (or vice versa)."""
    wa, wb = _content_words(a), _content_words(b)
    if not wa or not wb:
        return False
    shared = len(wa & wb)
    return shared / len(wa) >= threshold or shared / len(wb) >= threshold


def _check_selection(
    selection: Any, order: list[str], gap_count: int, unused: int, texts: dict[str, str] | None = None
) -> list[str]:
    problems: list[str] = []
    if not isinstance(selection, dict):
        return ["selection is not an object"]
    removed = selection.get("removed")
    distractors = selection.get("distractors")
    if not isinstance(removed, list) or len(removed) != gap_count:
        return [f"need exactly {gap_count} removed sentences"]
    ids = [r.get("id") if isinstance(r, dict) else None for r in removed]
    if any(i not in order for i in ids) or len(set(ids)) != len(ids):
        return ["removed ids must be distinct ids from the numbered sentences"]
    positions = sorted(order.index(i) for i in ids)
    if positions[0] == 0:
        problems.append("the first sentence must not be removed")
    if any(b - a < 2 for a, b in zip(positions, positions[1:])):
        problems.append("two consecutive sentences were removed")
    third = len(order) / 3
    if not (any(p < third for p in positions) and any(third <= p < 2 * third for p in positions) and any(p >= 2 * third for p in positions)):
        problems.append("removed sentences must be spread over all three thirds of the article")
    if not isinstance(distractors, list) or len(distractors) != unused or any(
        not isinstance(d, dict) or not isinstance(d.get("text"), str) or not d["text"].strip() for d in distractors
    ):
        problems.append(f"need exactly {unused} distractors with text")
    elif texts:
        for d in distractors:
            for rid in ids:
                if near_paraphrase(d["text"], texts[rid]):
                    problems.append(
                        f"a distractor is a near-paraphrase of removed sentence {rid} and could fit its gap; "
                        "write a distractor with a different claim and different key terms"
                    )
                    break
    return problems


def _assemble_reconstruction(part: PartBlueprint, article: dict[str, Any], numbered: list[tuple[str, str]], selection: dict[str, Any]) -> dict[str, Any]:
    removed = {r["id"]: r for r in selection["removed"]}
    text_by_id = dict(numbered)
    gap_of: dict[str, str] = {}
    paragraphs_out: list[str] = []
    counter = 0
    idx = 0
    for paragraph in article["paragraphs"]:
        parts: list[str] = []
        for _sentence in paragraph:
            sid = numbered[idx][0]
            idx += 1
            if sid in removed:
                counter += 1
                gap_of[sid] = f"g{counter}"
                parts.append("{{" + gap_of[sid] + "}}")
            else:
                parts.append(text_by_id[sid].strip())
        paragraphs_out.append(" ".join(parts))
    correct = [{"text": text_by_id[sid].strip(), "gapId": gap_of[sid], "tag": removed[sid].get("skillTag")} for sid in gap_of]
    wrong = [{"text": d["text"].strip()} for d in selection["distractors"]]
    ordered = correct + wrong
    candidates = [{"candidateId": f"c{i + 1}", "text": c["text"]} for i, c in enumerate(ordered)]
    questions = []
    for i, c in enumerate(correct):
        tag = c["tag"] if c["tag"] in _RECONSTRUCTION_TAGS and c["tag"] in part.allowed_skill_tags else "text_structure"
        questions.append({"questionId": f"q{i + 1}", "gapId": c["gapId"], "correctCandidateId": f"c{i + 1}",
                          "skillTags": [tag], "difficulty": "c1"})
    return {
        "text": {"title": article.get("title", ""), "paragraphs": paragraphs_out,
                 "gaps": [{"gapId": c["gapId"]} for c in correct]},
        "candidates": candidates,
        "questions": questions,
    }


def _generate_reconstruction_article_first(
    profile: ExamProfile, part: PartBlueprint, plan: list[AdaptationInstruction], topic: dict[str, str]
) -> dict[str, Any]:
    """Returns assembled content, or {} when a stage failed (the caller's regeneration loop retries)."""
    del plan  # adaptation guidance does not apply to article-first reconstruction yet
    gap_count = part.constraints.get("gapCount", 8)
    unused = part.constraints.get("unusedCandidates", 2)
    system, user = _article_prompt(profile, part, topic)
    settings = get_settings()
    writer = settings.german_exam_model if part.constraints.get("articleModel") == "primary" else settings.german_exam_model_stage_a
    article = chat_json(system=system, user=user, max_tokens=12000, model=writer,
                        reasoning_effort="medium" if writer.startswith("gpt-5") else None).data
    paragraphs = article.get("paragraphs") if isinstance(article, dict) else None
    if (not isinstance(paragraphs, list) or not paragraphs
            or any(not isinstance(p, list) or not p or any(not isinstance(s, str) or not s.strip() for s in p) for p in paragraphs)):
        log.warning("article-first: article stage returned an invalid shape")
        return {}
    numbered: list[tuple[str, str]] = []
    for paragraph in paragraphs:
        for sentence in paragraph:
            numbered.append((f"s{len(numbered) + 1}", sentence))
    total_words = sum(len(t.split()) for _sid, t in numbered)
    target = part.constraints.get("wordCountWithSentencesApprox") or part.constraints.get("wordCountApprox", 600)
    if not round(target * 0.75) <= total_words <= round(target * 1.3) or len(numbered) < gap_count * 3:
        log.warning("article-first: article has %s words / %s sentences — rejecting", total_words, len(numbered))
        return {}

    order = [sid for sid, _t in numbered]
    texts = dict(numbered)

    # Preferred path: the writer authored the anchors. Only the distractors are still missing.
    anchored = _anchors_to_removed(article, paragraphs, numbered)
    if anchored is not None:
        stub = {"removed": anchored, "distractors": [{"text": "x"}] * unused}
        if not _check_selection(stub, order, gap_count, unused):
            removed_ids = [r["id"] for r in anchored]
            system, user = _distractor_prompt(part, numbered, removed_ids)
            for _attempt in range(2):
                data = chat_json(system=system, user=user, max_tokens=1500, model=settings.german_exam_model).data
                selection = {"removed": anchored, "distractors": data.get("distractors") if isinstance(data, dict) else None}
                problems = _check_selection(selection, order, gap_count, unused, texts)
                if not problems:
                    return _assemble_reconstruction(part, article, numbered, selection)
                log.info("article-first: distractors rejected (%s)", problems)
                user += "\n\nYour previous answer was rejected: " + "; ".join(problems) + ". Fix exactly this."
        else:
            log.info("article-first: authored anchors violate the layout rules — falling back to selection")

    # Fallback: choose the removable sentences after the fact.
    system, user = _selection_prompt(part, article, numbered)
    selection: Any = None
    for _attempt in range(2):
        selection = chat_json(system=system, user=user, max_tokens=3000, model=settings.german_exam_model).data
        problems = _check_selection(selection, order, gap_count, unused, dict(numbered))
        if not problems:
            return _assemble_reconstruction(part, article, numbered, selection)
        log.info("article-first: selection rejected (%s)", problems)
        user += "\n\nYour previous answer was rejected: " + "; ".join(problems) + ". Fix exactly this."
    return {}


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
    if "presentation" in part.constraints:
        from copy import deepcopy
        content["presentation"] = deepcopy(part.constraints["presentation"])
    if part.constraints.get("balanceOptionPositions"):
        content = balance_option_positions(content)
    # No evidence postprocessors needed for reading — evidence is
    # LLM-supplied (paragraph ids), like Hören's HV2/HV3. Kept for
    # pipeline-shape parity with generate_listening_part.
    if part.constraints.get("shuffleCandidates"):
        content = shuffle_candidates(content)
    if part.constraints.get("balanceOptionPositions"):
        content = balance_option_positions(content)
    return content


def shuffle_candidates(content: dict[str, Any]) -> dict[str, Any]:
    """Deterministically scramble the candidate ORDER (ids, texts and keys are untouched) so the
    answer is never readable off the gap order. Seeded from the content so re-running is stable."""
    candidates = content.get("candidates")
    if not isinstance(candidates, list) or len(candidates) < 2:
        return content
    import hashlib
    import random

    seed = hashlib.sha256(json.dumps(candidates, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    shuffled = list(candidates)
    random.Random(seed).shuffle(shuffled)
    out = dict(content)
    out["candidates"] = shuffled
    return out


def _blind_solve(part: PartBlueprint, content: dict[str, Any]) -> SemanticVerificationResult:
    """Independent 'learner' pass: a solver that does NOT see the key must find the assignment and name
    any other candidate that could also fit a gap. Ambiguity that the key-aware verifier rationalises
    away (e.g. a distractor that paraphrases a correct sentence) shows up here as a mismatch or an
    `alsoFits` entry — exactly what a real candidate would trip over."""
    gap_count = part.constraints.get("gapCount", 8)
    unused = part.constraints.get("unusedCandidates", 2)
    questions = content.get("questions") or []
    text = content.get("text") or {}
    system = (
        "You are a strong German C1 learner solving a sentence-insertion exercise. The text has numbered gaps "
        f"(placeholders like {{{{g1}}}}); there are {gap_count + unused} candidate sentences: exactly "
        f"{gap_count} belong in the gaps (one each), {unused} belong nowhere. Decide by grammar, reference "
        "words, connectors and the logic of the argument. For EVERY gap give the best candidate id and "
        "'alsoFits': the ids of any OTHER candidates that could also be inserted there without breaking a "
        "reference, a connector or the logic (be honest and strict: list a candidate only if it is a real "
        "alternative). Also list the candidates that belong nowhere and judge each of those: 'plausible' if it "
        "is a sensible German sentence that simply does not fit any gap, 'absurd' if it is self-contradictory, "
        "meaningless, vague to the point of saying nothing, or clearly unrelated to the article. Reply with ONLY "
        'valid JSON: {"assignments": [{"gapId": "g1", "candidateId": "c3", "alsoFits": []}, ...], '
        '"unused": ["c1", "c9"], "unusedAssessment": [{"candidateId": "c1", "verdict": "plausible"}, ...]}'
    )
    payload = {"paragraphs": text.get("paragraphs"), "candidates": content.get("candidates")}
    result = None
    for _attempt in range(2):
        try:
            result = chat_json(system=system, user=json.dumps(payload, ensure_ascii=False), max_tokens=12000,
                               model=get_settings().german_exam_model,
                               reasoning_effort="medium" if get_settings().german_exam_model.startswith("gpt-5") else None)
        except Exception:  # noqa: BLE001
            log.warning("blind-solve call failed", exc_info=True)
            continue
        if isinstance(result.data, dict) and isinstance(result.data.get("assignments"), list):
            break
        result = None
    gap_of_question = {q["gapId"]: q for q in questions}
    if result is None:
        return SemanticVerificationResult(
            passed=False,
            part_wide_issues=[SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", "blind solver returned no usable answer")],
        )
    assigned = {a.get("gapId"): a for a in result.data["assignments"] if isinstance(a, dict)}
    items: list[ItemSemanticResult] = []
    for q in questions:
        a = assigned.get(q["gapId"]) or {}
        issues: list[SemanticIssue] = []
        also = [c for c in (a.get("alsoFits") or []) if isinstance(c, str)]
        if a.get("candidateId") != q["correctCandidateId"]:
            issues.append(SemanticIssue(
                "UNSUPPORTED_CORRECT_ANSWER", "error",
                f"an independent solver chose {a.get('candidateId')!r}, not the keyed {q['correctCandidateId']!r}",
                {"questionIds": [q["questionId"]], "confusedWith": [a.get("candidateId")] + also}))
        elif also:
            issues.append(SemanticIssue(
                "AMBIGUOUS_MAPPING", "error", f"an independent solver found {also} also fits this gap",
                {"questionIds": [q["questionId"]], "confusedWith": also}))
        items.append(ItemSemanticResult(q["questionId"], not issues, issues))
    del gap_of_question
    key_ids = {q["correctCandidateId"] for q in questions}
    part_wide: list[SemanticIssue] = []
    for verdict in result.data.get("unusedAssessment") or []:
        if isinstance(verdict, dict) and verdict.get("verdict") == "absurd" and verdict.get("candidateId") not in key_ids:
            part_wide.append(SemanticIssue(
                "IMPLAUSIBLE_DISTRACTOR", "error",
                f"unused candidate {verdict.get('candidateId')!r} is absurd, meaningless or unrelated"))
    return SemanticVerificationResult(passed=all(i.passed for i in items) and not part_wide, part_wide_issues=part_wide, items=items)


_SENTENCE_AFTER = re.compile(r"\{\{(\w+)\}\}\s*([^.!?]*[.!?])")


def _repair_reconstruction(
    part: PartBlueprint, content: dict[str, Any], item_errors: dict[str, list[SemanticIssue]]
) -> tuple[dict[str, Any], bool]:
    """Solver-guided repair: for every gap the blind solver confused, the writer rewrites the removed
    sentence AND the sentence right after the gap so the pair can only belong there; a distractor that
    was mistaken for a correct sentence is replaced too. Returns (content, changed). Never raises."""
    import copy

    del part
    questions = {q["questionId"]: q for q in content.get("questions") or []}
    candidates = {c["candidateId"]: c for c in content.get("candidates") or []}
    keys = {q["correctCandidateId"] for q in questions.values()}
    problems = []
    replace_distractors: set[str] = set()
    for qid, issues in item_errors.items():
        q = questions.get(qid)
        if q is None:
            continue
        confused = sorted({c for i in issues for c in (i.evidence.get("confusedWith") or []) if c in candidates})
        replace_distractors.update(c for c in confused if c not in keys)
        problems.append({
            "gapId": q["gapId"],
            "currentGapSentence": candidates[q["correctCandidateId"]]["text"],
            "wasConfusedWith": [candidates[c]["text"] for c in confused],
        })
    if not problems:
        return content, False

    restored = "\n".join(content["text"]["paragraphs"])
    for q in questions.values():
        restored = restored.replace(
            "{{" + q["gapId"] + "}}", "[[" + q["gapId"] + ": " + candidates[q["correctCandidateId"]]["text"] + "]]"
        )
    system = (
        "You repair a German C1 sentence-reconstruction exercise. In the restored article below the sentences in "
        "[[gN: ...]] are the gap sentences. An independent solver confused some of them with other sentences. "
        "For EACH listed problem gap, rewrite (1) the gap sentence and (2) the sentence that comes directly after "
        "it, so that the pair is firmly bound to this spot and cannot be confused with the listed sentences: the "
        "gap sentence must point back with a demonstrative/pronoun/connector that only works right after the "
        "sentence before it, carry specific content, and the following sentence must take up a term or claim that "
        "ONLY the gap sentence introduces. Keep the topic, register and the gap sentence's function; change "
        "nothing else. Each is ONE complete sentence."
        + (
            " Also write a replacement for each sentence listed under replaceDistractors: it must fail for a hard "
            "reason (a reference with no antecedent anywhere in the article, or a contradiction of a concrete "
            "claim of the article) and must not resemble any gap sentence."
            if replace_distractors else ""
        )
        + ' Reply with ONLY valid JSON: {"rewrites": [{"gapId": "g2", "gapSentence": "...", "nextSentence": "..."}], '
        '"newDistractors": [{"replaces": "<old distractor text>", "text": "..."}]}'
    )
    user = json.dumps({
        "restoredArticle": restored,
        "problems": problems,
        "replaceDistractors": [candidates[c]["text"] for c in sorted(replace_distractors)],
    }, ensure_ascii=False)
    try:
        data = chat_json(system=system, user=user, max_tokens=3000, model=get_settings().german_exam_model_stage_a).data
    except Exception:  # noqa: BLE001
        log.warning("solver-guided repair call failed", exc_info=True)
        return content, False
    if not isinstance(data, dict) or not isinstance(data.get("rewrites"), list):
        return content, False

    out = copy.deepcopy(content)
    out_cands = {c["candidateId"]: c for c in out["candidates"]}
    gap_to_q = {q["gapId"]: q for q in questions.values()}
    changed = False
    for rw in data["rewrites"]:
        if not isinstance(rw, dict) or rw.get("gapId") not in gap_to_q:
            continue
        new_gap, new_next = rw.get("gapSentence"), rw.get("nextSentence")
        if not (isinstance(new_gap, str) and new_gap.strip() and isinstance(new_next, str) and new_next.strip()):
            continue
        gap_id = rw["gapId"]
        matched = False
        for i, para in enumerate(out["text"]["paragraphs"]):
            m = _SENTENCE_AFTER.search(para)
            while m and m.group(1) != gap_id:
                m = _SENTENCE_AFTER.search(para, m.end())
            if m:
                out["text"]["paragraphs"][i] = para[: m.start(2)] + new_next.strip() + para[m.end(2):]
                matched = True
                break
        if matched:
            out_cands[gap_to_q[gap_id]["correctCandidateId"]]["text"] = new_gap.strip()
            changed = True
    for nd in data.get("newDistractors") or []:
        if isinstance(nd, dict) and isinstance(nd.get("text"), str) and nd["text"].strip():
            for cid in replace_distractors:
                if out_cands[cid]["text"] == nd.get("replaces"):
                    out_cands[cid]["text"] = nd["text"].strip()
                    changed = True
    return out, changed


def _verify(part: PartBlueprint, content: dict[str, Any]) -> SemanticVerificationResult:
    """One semantic verification. Blueprints with many gaps x candidates opt into the chunked verifier
    (`verifier: {"chunks": N, "chunkMaxTokens": T}`): a single call spends its whole reasoning budget
    and returns truncated JSON, so the gaps are verified as N parallel chunks, each against ALL candidates.
    `blindSolve: True` adds the independent solver pass (see _blind_solve) once the verifier has passed."""
    cfg = part.constraints.get("verifier")
    if not cfg:
        return verify_semantic(part, content)
    from .german_exam_semantic_chunked import verify_semantic_chunked

    if cfg.get("blindSolve"):
        # The solver is the strictest and cheapest gate, so it runs first: a failing attempt is
        # rejected without paying for the chunked verifier.
        solved = _blind_solve(part, content)
        if not solved.passed:
            return solved
    return verify_semantic_chunked(
        part, content, verify_semantic, primary_chunks=cfg["chunks"], min_items=cfg.get("minItems", cfg["chunks"]),
        cap=cfg["chunkMaxTokens"],
    )


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
            result = _verify(part, content)
            record_findings(result)
            verification_count += 1
            findings = list(result.part_wide_issues) + [issue for item in result.items for issue in item.issues]
            if result.terminal_verifier_failure:
                return result  # the chunked verifier already spent its one bounded fallback
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
            # full regeneration — unless the blueprint opts into solver-guided repair, which
            # rewrites exactly the sentences the blind solver confused (see _repair_reconstruction).
            if not part.constraints.get("solverRepair"):
                break
            content, changed = _repair_reconstruction(part, content, item_errors)
            if not changed:
                break
            repair_count += len(item_errors)
            content = _postprocess(part, content)
            if hard_issues(validate_content(part, content)):
                log.warning("solver-guided repair broke deterministic structure — abandoning repair")
                break
            result = check()
            continue

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
    from .german_exam_objective import SELECTION_TYPES, generate_selection
    if part.task_type in SELECTION_TYPES:
        return generate_selection(profile, part, plan, topic)
    builder = _PROMPT_BUILDERS.get(part.task_type)
    if builder is None:
        raise ReadingGenerationError(f"no prompt builder for task_type {part.task_type!r}")

    last_issues: list[ValidationIssue] = []
    last_semantic: dict[str, Any] | None = None
    semantic_totals = {"verificationCount": 0, "repairCount": 0, "durationMs": 0}
    total_det_repairs = 0
    total_issue_counts: dict[str, int] = {}

    for regeneration in range(_MAX_FULL_REGENERATIONS + 1):
        if part.constraints.get("generationMode") == "article_first":
            content = _generate_reconstruction_article_first(profile, part, plan, topic)
        elif part.constraints.get("generationMode") == "article_then_items":
            content = _generate_mc_article_then_items(profile, part, topic)
        else:
            system, user = builder(profile, part, plan, topic)
            result = chat_json(system=system, user=user, max_tokens=part.constraints.get("generationMaxTokens", 6000), model=part.constraints.get("generationModel") or get_settings().german_exam_model, **({"reasoning_effort": part.constraints["generationReasoningEffort"]} if part.constraints.get("generationReasoningEffort") else {}))
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
