"""POST /notes-generate — full port of backend/functions/notes-generate.js.

Handles all four modes the frontend uses:
  - mode='analyze'  → group pages into sections (currently returns an
                     empty list so the frontend falls back to its fixed
                     page-window splits — preserves the existing UX).
  - mode='section'  → notes/summary for one explicit page range,
                     returned as raw markdown (caller merges later).
  - mode='merge'    → merge a list of section markdowns into one note
                     and persist it.
  - mode='generate' → full-document notes/summary in one shot.

Each branch returns the exact JSON shape the frontend (notes-panel.js)
already expects, so the JS handler can be a thin auth+forward shell.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth import require_internal_token
from ..config import get_settings
from ..services.openai_client import get_openai_client
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["notes"], dependencies=[Depends(require_internal_token)])

_MAX_CONTEXT_CHARS = 28_000
_EXAM_MERGE_CONTEXT_CHARS = 56_000
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_METADATA_NOISE = (
    "institut für", "technische universität", "prof.", "dr.-ing.", "wintersemester",
    "sommersemester", "lehrstuhl", "fachgebiet", "vorlesung", "folien", "slides",
    "copyright", "©", "all rights reserved",
)

_EXAM_FINAL_SECTIONS = (
    "Muss-Definitionen",
    "Einteilungen und Klassifikationen",
    "Physikalische Grundlagen / Werkstoffverhalten",
    "Wichtige Formeln",
    "Verfahren und Prozessschritte",
    "Vergleiche",
    "Prüfungsrelevanz",
    "Typische Fehler",
)


# ── Prompt builders ──────────────────────────────────────────────────────────


def _lang_instr(lang: str) -> str:
    if lang == "de":
        return "Schreibe die Antwort auf Deutsch."
    if lang == "en":
        return "Write the answer in English."
    if lang == "bilingual":
        return "Schreibe die Antwort zweisprachig (Deutsch und Englisch)."
    return "Match the language of the source material."


def _math_format_rules() -> str:
    # The Notes/Summary renderer only displays math wrapped in $…$ / $$…$$.
    # Bare LaTeX commands and \[…\] / \(…\) delimiters showed up as raw
    # backslashes for users, so spell the contract out explicitly.
    return """## MATH FORMATTING (STRICT — the renderer ONLY displays delimited math)
- Wrap EVERY mathematical expression in $...$ (inline) or $$...$$ (display). This includes simple ones: variables ($x$, $a_0$), function definitions ($f(x)=\\frac{x}{1+x^2}$), limits, sums, integrals, fractions, roots and Greek letters.
- NEVER write a LaTeX command (\\frac, \\sum, \\lim, \\sqrt, \\in, \\R, \\quad, \\infty, \\varphi, …) outside $...$ — bare commands render as literal backslashes.
- NEVER use \\[ … \\] or \\( … \\) delimiters. Use ONLY $$ … $$ (display) and $ … $ (inline).
- Keep the page citation OUTSIDE the math: write $f(x)=\\frac{x}{1+x^2}$ *(S. 1)*, never $f(x)=\\frac{x}{1+x^2} (S. 1)$."""


def _notes_prompt(lang: str) -> str:
    return f"""You are generating detailed, exam-ready study notes from university lecture PDF slides.

{_lang_instr(lang)}

IGNORE completely: author names, institute names, semester labels, university logos, slide numbers, copyright lines, and any administrative text that is not course content.

CRITICAL RULES:
- Use ONLY the provided PDF text. Do NOT invent facts.
- Be exhaustive — exam-ready, not a high-level summary.
- Every method/process named in the source → ### subsection (what it is, materials, advantages, disadvantages, applications).
- Every definition → quote near-verbatim with a page ref *(S. X)*.
- Every list → reproduce in full.
- Every formula → KaTeX ($...$ or $$...$$), explain every variable + units.

STRUCTURE:
# [Main topic]
## Definitionen / Definitions
## Einteilungen und Normen / Classifications and Standards
## Verfahren / Methods and Processes
## Formeln / Formulas
## Vergleiche / Comparisons
## Prüfungsrelevanz / Exam Focus

Cite page numbers throughout. No filler sentences.

{_math_format_rules()}"""


_DETAIL_ALIASES: dict[str, str] = {
    "brief": "quick",
    "balanced": "detailed",
    "detailed": "detailed",
    "exam": "exam",
    "quick": "quick",
    "beginner": "beginner",
    "flashcard": "flashcard",
}


def _normalize_detail(detail_level: str) -> str:
    return _DETAIL_ALIASES.get(detail_level, "detailed")


def _flashcard_prompt(lang: str) -> str:
    lang_tip = "**Lerntipp:** Der eigentliche Lerninhalt beginnt wahrscheinlich auf den folgenden Seiten." if lang == "de" else "**Study tip:** The actual course content likely starts on the following pages."
    return f"""You generate flashcards from university lecture PDF content.

{_lang_instr(lang)}

FIRST: Determine if the pages contain real study content (definitions, formulas, methods, examples, explanations).

If the pages are content-light (title page, table of contents, organizational info, cover page, lecturer/institute info, empty):
Output ONLY:
<!-- minallo-summary-type: content-light -->
# Flashcards
These pages do not contain enough study content to create useful flashcards. Select pages where the technical content starts.
{lang_tip}

If the pages are mixed-content (some org info + some real content):
Ignore administrative/title information and generate flashcards ONLY from the real study content.
Output:
<!-- minallo-summary-type: mixed-content -->
# Flashcards: [Topic]
(then Q/A pairs from the study content only)

If the pages contain study content:
Output:
<!-- minallo-summary-type: study-content -->
# Flashcards: [Topic]

Q: [question]
A: [answer based ONLY on the PDF content] *(S. X)*

Generate 10-25 Q/A pairs covering:
- Key definitions
- Important formulas (with variable meanings)
- Method steps
- Comparisons
- Exam-relevant facts

Rules:
- Use ONLY the provided PDF content.
- Do NOT create trivial flashcards about professor names, institute info, or administrative details.
- Each answer must be concise (1-3 sentences).
- Include page references in answers.
- Math in KaTeX ($...$ or $$...$$).
- Preserve the professor's terminology exactly."""


def _standard_section_instructions() -> str:
    return """## CONTENT-TYPE DETECTION (internal — do NOT output the classification)

Before choosing sections, silently classify the material as one of:

- **math-heavy**: formulas, derivations, solved examples, calculation methods dominate.
  Examples: Mathematics, Mechanics, Statistics, Physics calculations, Circuits, Thermodynamics.
- **concept-light-math**: definitions, classifications, process descriptions, but small
  calculations or parameters may appear.
  Examples: Fertigungstechnik, Materials Science, Manufacturing, Chemistry theory, Economics concepts.
- **no-math**: purely conceptual — no formulas. Understanding, comparing, arguing, explaining.
  Examples: History, Law, Political Science, Literature, Philosophy, Management, Languages.
- **balanced**: both conceptual theory AND formulas/calculations are central.
  Examples: Physics, Economics, Chemistry, Engineering Science, Finance, Data Science.

## SECTION TEMPLATES — use the one matching the detected type

### IF math-heavy:
OMIT sections that would be empty:
- Topic Overview (1-2 sentences: what this is about)
- Core Definitions (key terms, cited)
- Main Formulas / Theorems (KaTeX, meaning of each, conditions for use)
- When to Use Which Formula (decision guide: "If … → use …")
- Important Derivation Idea (if relevant — the intuition, not the full proof)
- Common Traps (sign errors, unit confusion, wrong formula choice)
- Mini Solved Example (one compact worked example showing the method)
- Exam-Style Checklist (what to know cold)
- Source Pages

### IF concept-light-math:
OMIT sections that would be empty:
- Simple Definition (core term defined clearly)
- Course Classification (where this fits in the broader topic)
- Main Categories (all groups, subcategories — list completely)
- Important Details from Sources (key facts, properties, DIN norms, parameters)
- Comparison Table (markdown table: Type | Principle | Application | Advantage | Disadvantage)
- Selection Criteria (how to choose the right method/process for a scenario)
- Typical Applications (real-world use cases from the material)
- Exam Traps (confusing similar terms, wrong classifications)
- Quick Revision List (the key points to memorize)

Do NOT write "No formula found". Use the concept sections above instead.

### IF no-math:
OMIT sections that would be empty:
- Main Point (one sentence capturing the core idea)
- Key Terms (term + definition pairs, cited)
- Background / Context (historical, legal, social, theoretical context)
- Main Arguments or Ideas (the 3-6 most important ideas)
- Important Relationships (cause-effect, comparisons, connections)
- Comparison Table (if useful — viewpoints, theories, rules side by side)
- Typical Exam Question (a realistic question inferred from the material)
- Short Model Answer (how to structure the answer)
- What to Memorize (key terms, dates, names, rules)

For no-math subjects, the summary should help the student explain and write, not calculate.

### IF balanced:
OMIT sections that would be empty:
- Concept Overview (what the topic is about and why it matters)
- Key Definitions (core terms, cited)
- Important Formulas (KaTeX, with meaning of each variable)
- When Formulas Apply (conditions and decision guide)
- Concept-to-Formula Connection (how the theory leads to the formula)
- Example Calculation (one compact worked example)
- Interpretation (what the result means, typical values, edge cases)
- Common Mistakes (both conceptual and calculation errors)
- Exam Checklist (concepts + formulas + interpretation patterns)

The key for balanced summaries: Meaning → Formula → Calculation → Interpretation."""


def _exam_section_instructions() -> str:
    return """## EXAM SUMMARY MODE — COMPLETENESS IS CRITICAL

You must extract ALL exam-relevant concepts from EVERY page in the provided text.
Do NOT skip pages. Do NOT pick only a few topics. Scan the ENTIRE provided text systematically.

Target length: up to ~4000 words. Be as thorough as needed to cover every exam-relevant concept.
Only infer exam relevance from emphasis in the PDF, repeated concepts, definitions, formulas,
examples, or explicitly marked learning goals. Do NOT invent exam questions from outside knowledge.

## STEP 1: CLASSIFY THE CONTENT TYPE (internal — do NOT output the classification)

Before choosing a structure, silently classify the material as one of:

- **math-problem-solving**: The material is dominated by formulas, derivations, solved examples,
  calculation methods, proofs, or exercise patterns. Examples: Mathematics, Mechanics, Statistics,
  Physics calculations, Signals & Systems.

- **technical-conceptual**: The material mixes engineering knowledge (definitions, DIN norms,
  classifications, process descriptions, material properties) with technical formulas. Examples:
  Fertigungstechnik, Werkstoffkunde, Konstruktionslehre, Thermodynamik.

- **memorization-heavy**: The material is dominated by definitions, classifications, lists, facts,
  comparisons, legal rules, or descriptive theory with few or no calculations. Examples: Biology,
  Law, Medicine theory, Business/Management, History.

- **mixed**: The material contains roughly equal parts of the above.

## STEP 2: USE THE MATCHING STRUCTURE

### IF math-problem-solving:
Use these sections — OMIT any that would be empty:

## 1. Kernformeln (Core Formulas)
Every formula from the PDF in KaTeX, grouped by topic. For each formula: what it computes,
meaning of every variable with units, and under which conditions it applies.

## 2. Wann welche Formel? (When to Use Each Formula)
Decision guide: for each formula, state the typical problem setup that requires it.
Use a compact "If … → use …" format.

## 3. Standard-Lösungsmethoden (Standard Solving Methods)
Step-by-step procedures for the main problem types in the PDF. Number each step.
Include which formula to apply at each step and what to check.

## 4. Typische Aufgabentypen (Typical Exercise Types)
List the exercise patterns that appear in the PDF or can be inferred from the formulas and examples.
For each: one-line description of the setup, which method applies, and what the expected result looks like.

## 5. Mini-Rechenbeispiele (Mini Solved Examples)
Reproduce solved examples from the PDF. If no full example exists but a formula is demonstrated
with numbers, show that. Do NOT invent examples — only use what the PDF provides.

## 6. Typische Fehler (Common Mistakes)
Calculation traps: sign errors, unit confusion, wrong formula choice, forgetting boundary conditions.
Infer ONLY from the material.

## 7. Prüfungs-Checkliste (Exam Checklist)
The 10-15 things to know cold: key formulas, method steps, definitions, special cases.

### IF memorization-heavy:
Use these sections — OMIT any that would be empty:

## 1. Muss-Definitionen (Must-Know Definitions)
Every formal definition, quoted near-verbatim with page references.

## 2. Einteilungen und Klassifikationen (Classifications)
Every classification, taxonomy, or categorization. List all categories completely.

## 3. Wichtige Konzepte (Key Concepts)
Core ideas, principles, theories, and their relationships. Explain each concisely.

## 4. Vergleiche (Comparisons)
Differences and similarities between concepts, methods, or categories. Use markdown tables.

## 5. Beispiele aus der Vorlesung (Lecture Examples)
Examples used in the PDF to illustrate concepts. Cite pages.

## 6. Prüfungsrelevante Fakten (Exam-Relevant Facts)
Facts, numbers, properties, or rules the student must memorize. Bullet list format.

## 7. Typische Prüfungsfragen (Typical Exam Questions)
Questions that can be inferred from the material. Do NOT invent questions from outside knowledge.

## 8. Typische Fehler (Common Mistakes)
Confusing similar terms, wrong classifications, incomplete lists. Infer ONLY from the material.

## 9. Mini-Zusammenfassung (Mini Recap)
3-5 memory-friendly sentences capturing the most critical points.

### IF technical-conceptual:
Use these sections — OMIT any that would be empty:

## 1. Muss-Definitionen (Must-Know Definitions)
Every formal definition in the PDF, quoted near-verbatim with page references.
Include DIN/norm definitions, technical terms, and key distinctions.
Start with the most fundamental definition of the chapter topic.

## 2. Einteilungen und Klassifikationen (Classifications & Tables)
Every classification scheme, taxonomy, or categorization from the PDF.
List all categories and subcategories completely.

## 3. Physikalische Grundlagen (Physical Mechanisms)
Physical principles, material properties, deformation behavior, crystal structures,
microstructural phenomena — anything that explains WHY processes work.

## 4. Wichtige Formeln (Important Formulas)
Every formula from the PDF. For each: the formula in KaTeX, meaning of every variable with units,
and when/how to apply it.

## 5. Was die Formeln bedeuten (What the Formulas Mean)
Practical interpretation: what changes when a variable increases? What are typical values?
Connect formulas to the physical concepts from section 3.

## 6. Verfahren und Prozessschritte (Methods and Process Steps)
Every named method or process with: what it is, how it works, advantages, disadvantages, applications.

## 7. Vergleiche (Exam-Relevant Comparisons)
Comparisons between methods, materials, processes, or concepts. Use markdown tables.
Reproduce table structures faithfully — keep all original columns and values.

## 8. Typische Fehler (Common Mistakes)
Confusing similar terms, wrong column values in tables (e.g. slip planes vs. total slip systems),
mixing up related formulas, forgetting conservation laws. Infer from the material.

## 9. Mini-Zusammenfassung (Mini Recap)
3-5 sentences: the most important things to remember for the exam.

### IF mixed:
Combine elements from the above templates. Use technical-conceptual as the base structure,
but add "Standard-Lösungsmethoden" and "Typische Aufgabentypen" sections if the material
contains calculation methods or exercises.

## COVERAGE TRANSPARENCY
After your content-type marker, output a brief coverage line:
> **Abgedeckte Seiten:** S. X–Y (von Z Seiten im Dokument).
If the provided text does NOT cover the entire PDF, add:
> Wichtige Themen ab S. [first uncovered page] (z. B. [topic names if inferable from headings/ToC]) sind in diesem Bereich nicht enthalten.
Only name topics you can actually see mentioned in a table of contents, chapter heading, or cross-reference within the provided text. Do NOT guess or invent topic names.

## TABULAR DATA PRECISION
When reproducing tables from the PDF (e.g. crystal structures, material properties):
- Copy every column header exactly as it appears in the source.
- Do NOT merge or rename columns. If the PDF has separate columns for "Bevorzugte Gleitebenen",
  "Gleitrichtungen", and "Gleitsystemanzahl", reproduce all three — do not collapse them into fewer columns.
- Cross-check each cell value against the [S. X] source page. A number that belongs to one column
  must not be placed under a different column header."""


def _summary_prompt(lang: str, detail_level: str) -> str:
    level = _normalize_detail(detail_level)

    if level == "flashcard":
        return _flashcard_prompt(lang)

    detail_map = {
        "quick": "Target length: up to ~700 words. Only the most important ideas. Stay shorter if the pages contain limited content.",
        "detailed": "Target length: usually 1000–2000 words for content-rich selections. Stay shorter if the pages contain limited content.",
        "exam": None,  # handled separately below
        "beginner": "Target length: up to ~1500 words. Explain in simple language as if to a first-year student. You may add very basic clarifying explanations, but do NOT introduce new facts, formulas, examples, or concepts that are not supported by the PDF.",
    }
    detail_instr = detail_map.get(level, detail_map["detailed"])

    lang_tip_light = "**Lerntipp:** Der eigentliche Lerninhalt beginnt wahrscheinlich auf den folgenden Seiten." if lang == "de" else "**Study tip:** The actual course content likely starts on the following pages."

    return f"""You are a study assistant generating summaries from university lecture PDF content.

{_lang_instr(lang)}

## OUTPUT FORMAT RULE
Your FIRST line of output MUST be exactly one of these HTML comments (nothing before it):
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

## CONTENT CLASSIFICATION (internal decision — do NOT output a classification section)
Determine if the selected pages are:
- content-light: title page, cover, table of contents, lecturer/institute info, empty page, chapter heading only, organizational page
- study-content: definitions, formulas, methods, examples, explanations, diagrams, comparisons
- mixed-content: some organizational info combined with some real technical content

## IF CONTENT-LIGHT:
Output this compact format only:
<!-- minallo-summary-type: content-light -->
# [Document/Chapter Name]
These pages contain organizational/introductory information: [list what is visible].
No technical study content is present on these pages.
{lang_tip_light}

Do NOT create empty sections. Keep it to 3-5 lines maximum.

## IF STUDY-CONTENT OR MIXED-CONTENT:
{detail_instr if detail_instr else ""}

{"" if level == "exam" else "If mixed-content, begin with one brief Context line about the organizational info, then proceed with study content."}

{_exam_section_instructions() if level == "exam" else _standard_section_instructions()}

## RULES:
- Use ONLY the provided PDF content. Do NOT invent definitions, formulas, examples, or exam relevance.
- Preserve the professor's terminology exactly.
- Cite page numbers: *(S. X)*. Be precise — verify each page number matches the [S. X] markers in the provided text. Do NOT guess page numbers.
- If a section would be empty, OMIT it entirely — never write "keine vorhanden" or similar.
- Math in KaTeX ($...$ or $$...$$). Use proper subscripts and superscripts: write $k_f$, $A_0$, $A_1$, $l_0$, $l_1$, $\\varphi$, $\\varepsilon$ — never write plain kf, A0, A1.
- Prefer $\\varphi = \\ln(1+\\varepsilon) = \\ln\\left(\\frac{{l_1}}{{l_0}}\\right)$ when the source discusses logarithmic strain / Umformgrad.
- Tables with markdown for comparisons.
- Do NOT force the full template on content-light pages.
- If mixed-content, begin with one brief "Context" line about the organizational info, then focus on study content.

{_math_format_rules()}"""


def _exam_page_group_instructions(page_ref: str) -> str:
    sections = "\n".join(f"{i + 1}. {name}" for i, name in enumerate(_EXAM_FINAL_SECTIONS))
    return f"""You are generating an EXAM summary for ONE specific page group from a university lecture PDF.

{page_ref} is the full allowed source range for this section. Cover ONLY this range, but cover it completely.

Scan every provided [S. X] marker. Do not skip central theory pages in favor of examples.

Silently classify the content as math-problem-solving, technical-conceptual, memorization-heavy, or mixed
(see the content-type definitions in the main exam instructions). Adapt which categories you extract:
- For math-problem-solving: focus on formulas, solving methods, exercise types, worked examples.
- For technical-conceptual: focus on definitions, classifications, physical mechanisms, formulas, processes.
- For memorization-heavy: focus on definitions, classifications, facts, comparisons, lecture examples.

Extract page-local exam material for these general categories (adapt naming to content type):
{sections}

Rules:
- Cite pages only from explicit [S. X] markers in the provided text. Never guess or shift page references.
- Preserve exact page references for examples, definitions, formulas, diagrams, and classifications.
- Quote Muss-Definitionen near-verbatim when the source gives a definition.
- Capture DIN/norm classifications completely when present.
- Include all domain-specific content: material behavior, crystal structures, process parameters, calculation methods,
  derivation steps, exercise patterns — whatever the content type demands.
- When reproducing tables: copy every column header exactly as in the source. Do NOT merge columns.
  If the source has separate columns for e.g. "Bevorzugte Gleitebenen", "Gleitrichtungen", and
  "Gleitsystemanzahl", reproduce all three with their correct per-row values.
- Add Typische Fehler only when a trap can be inferred from the source content.
- Math in KaTeX. Use clean subscripts: $k_f$, $A_1$, $l_1$, $l_0$, $\\varphi$, $\\varepsilon$; never plain kf, A1, l1, l0.
- Prefer $\\varphi = \\ln(1+\\varepsilon) = \\ln\\left(\\frac{{l_1}}{{l_0}}\\right)$ when the source discusses logarithmic strain / Umformgrad.
- Omit empty headings, but do not omit real content."""


def _section_prompt(lang: str, page_start: int | None, page_end: int | None, tool: str, detail_level: str = "detailed") -> str:
    if page_start is not None:
        page_ref = f"Seite {page_start}" if page_start == page_end else f"Seiten {page_start}–{page_end}"
    else:
        page_ref = "diesem Abschnitt"
    if tool == "summary":
        if _normalize_detail(detail_level) == "exam":
            return f"""{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

{_exam_page_group_instructions(page_ref)}

If the pages are content-light (title, cover, ToC, org info, empty): output a brief 2-3 line note about what is on the page. Do NOT create empty study sections.

{_math_format_rules()}"""
        return f"""You are generating a study summary for ONE specific page group from a university lecture PDF.

{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

Cover what is on {page_ref} only. Do NOT introduce surrounding chapter context.

If the pages are content-light (title, cover, ToC, org info, empty): output a brief 2-3 line note about what is on the page. Do NOT create empty study sections.

If the pages contain study content:
- Quote definitions near-verbatim with *(S. X)*.
- Reproduce every list in full.
- KaTeX for formulas.
- OMIT sections that would be empty — never write "keine vorhanden".
- No filler. Every bullet must add information.

{_math_format_rules()}"""
    return f"""You are generating detailed study notes for ONE specific page group from a university lecture PDF.

{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

If the pages are content-light (title, cover, ToC, org info, empty): output a brief 2-3 line note. Do NOT create empty study sections.

If the pages contain study content:
Extract everything worth studying from {page_ref}. For each named method create a ### subsection with what/advantages/disadvantages/applications. Quote definitions verbatim. KaTeX formulas. Cite *(S. X)* throughout. OMIT sections that would be empty.

{_math_format_rules()}"""


def _exam_merge_prompt(lang: str) -> str:
    return f"""You are merging multiple page-group EXAM summaries into one complete final exam summary.

{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

Choose based on the merged result:
- If ALL partial summaries are content-light, use content-light and output one compact summary.
- If some are content-light and others contain study content, use mixed-content. Include only brief context for content-light parts and focus on study content.
- If all contain study content, use study-content.

## CONTENT-TYPE-ADAPTIVE STRUCTURE

Before choosing the final structure, silently classify the merged content as one of:
- **math-problem-solving**: dominated by formulas, derivations, solved examples, calculation methods.
- **technical-conceptual**: engineering knowledge (definitions, DIN norms, classifications, processes) mixed with formulas.
- **memorization-heavy**: definitions, classifications, lists, facts, comparisons, descriptive theory.
- **mixed**: roughly equal parts.

Then use the matching template from the exam section instructions:
- math-problem-solving → Kernformeln, Wann welche Formel, Standard-Lösungsmethoden, Typische Aufgabentypen, Mini-Rechenbeispiele, Typische Fehler, Prüfungs-Checkliste
- technical-conceptual → Muss-Definitionen, Einteilungen, Physikalische Grundlagen, Wichtige Formeln, Was die Formeln bedeuten, Verfahren, Vergleiche, Typische Fehler, Mini-Zusammenfassung
- memorization-heavy → Muss-Definitionen, Einteilungen, Wichtige Konzepte, Vergleiche, Vorlesungsbeispiele, Prüfungsrelevante Fakten, Typische Prüfungsfragen, Typische Fehler, Mini-Zusammenfassung
- mixed → technical-conceptual base + Standard-Lösungsmethoden and Typische Aufgabentypen if calculation content exists

OMIT sections that would be empty.

Coverage rules:
- Preserve exam-relevant content from EVERY input section. Do not drop middle pages or later page ranges.
- Remove exact duplicates only. Consolidate repeated ideas, but keep unique details and page refs.
- Cite pages only when the input already has *(S. X)* or an explicit section page range. Never guess page numbers.
- Do not move page references between concepts. If examples are on S. 6, keep S. 6.
- Preserve all formal definitions, DIN classifications, lists, formulas, diagrams, and comparisons.
- Preserve table structures faithfully — keep all original columns and their correct per-row values. Do NOT merge or rename columns from the source.
- Keep formulas in clean KaTeX with engineering subscripts: $k_f$, $A_1$, $l_1$, $l_0$, $\\varphi$, $\\varepsilon$.
- Prefer $\\varphi = \\ln(1+\\varepsilon) = \\ln\\left(\\frac{{l_1}}{{l_0}}\\right)$ when the source supports it.
- Add Typische Fehler that follow from the source, for example confusing $\\varphi$ with $\\varepsilon$, confusing the number of slip planes with total slip systems, or forgetting Volumenkonstanz, but do not invent unrelated traps.
- Omit a final heading only if no input section contains any real content for it.
- Remove all partial <!-- minallo-summary-type: ... --> markers and output exactly ONE marker first.
- Do NOT invent new information.

Coverage transparency:
- After the content-type marker, output a coverage line:
  > **Abgedeckte Seiten:** S. X–Y (von Z Seiten im Dokument).
  Use the page ranges from the input section headers to determine X–Y. If total pages is unknown, omit "von Z".
- If the merged content clearly does not cover the entire PDF (e.g. early pages only, or a table of contents mentions topics not found in any input section), add:
  > Wichtige Themen ab S. [first uncovered page] (z. B. [topic names visible in ToC/headings]) sind in diesem Bereich nicht enthalten.
  Only name topics that appear in a table of contents, chapter heading, or cross-reference within the input. Do NOT guess.

{_math_format_rules()}"""


def _merge_prompt(lang: str, tool: str, detail_level: str = "detailed") -> str:
    if tool == "summary":
        if _normalize_detail(detail_level) == "exam":
            return _exam_merge_prompt(lang)
        return f"""You are merging multiple section summaries into one final study summary.

{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

Choose based on the merged result:
- If ALL partial summaries are content-light → use content-light and output one compact summary.
- If some are content-light and others contain study content → use mixed-content. Include only a brief context line for the content-light parts and focus on the real study content.
- If all contain study content → use study-content.

Rules:
- Remove all partial <!-- minallo-summary-type: ... --> markers from the input sections. Output exactly ONE marker as the first line.
- Preserve ALL content. Remove only exact duplicates.
- Keep every page reference *(S. X)*.
- Preserve ALL formulas and definitions exactly as written.
- Group related content under ## headings.
- OMIT sections that would be empty — do NOT create empty headings.
- End with a ## Prüfungsrelevanz section with the 5–10 most exam-relevant points (only if study content exists).
- Do NOT invent new information.

{_math_format_rules()}"""
    return f"""You are merging multiple section notes into one final structured study note.

{_lang_instr(lang)}

Your FIRST line of output MUST be exactly one of:
<!-- minallo-summary-type: content-light -->
<!-- minallo-summary-type: study-content -->
<!-- minallo-summary-type: mixed-content -->

Choose based on the merged result:
- If ALL partial summaries are content-light → use content-light and output one compact note.
- If some are content-light and others contain study content → use mixed-content.
- If all contain study content → use study-content.

Rules:
- Remove all partial <!-- minallo-summary-type: ... --> markers from the input sections. Output exactly ONE marker as the first line.
- Preserve ALL content from ALL sections — do not aggressively shorten.
- Remove exact duplicates only.
- Keep every page reference *(S. X)*.
- Preserve ALL formulas and definitions exactly as written.
- Group by topic under ## headings.
- Every method/process keeps its own ### subsection.
- OMIT sections that would be empty.
- End with ## Prüfungsrelevanz (only if study content exists).
- Do NOT invent new information.

{_math_format_rules()}"""


# ── DB helpers ───────────────────────────────────────────────────────────────


def _is_metadata_chunk(text: str | None) -> bool:
    if not text or len(text) > 400:
        return False
    lower = text.lower()
    hits = sum(1 for t in _METADATA_NOISE if t in lower)
    return hits >= 2


def _verify_document_owner(user_id: str, course_id: str, document_id: str | None) -> None:
    if not document_id:
        return
    if not _UUID_RE.match(document_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="documentId must be a UUID")
    if not _UUID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    sb = get_supabase()
    result = (
        sb.table("documents")
        .select("id, user_id, course_id")
        .eq("id", document_id)
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .limit(1)
        .execute()
    )
    if not (result.data or []):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")


def _fetch_chunks(
    user_id: str, course_id: str, document_id: str,
    page_start: int | None, page_end: int | None,
) -> list[dict[str, Any]]:
    sb = get_supabase()
    q = (
        sb.table("document_chunks")
        .select("chunk_text, page_start, page_end, section_title, source_type")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("document_id", document_id)
        .order("page_start")
        .order("id")
        .limit(150 if (page_start is None and page_end is None) else 80)
    )
    if page_end is not None:
        q = q.lte("page_start", page_end)
    if page_start is not None:
        q = q.gte("page_end", page_start)
    rows = (q.execute().data) or []
    return [r for r in rows if not _is_metadata_chunk(r.get("chunk_text"))]


def _build_context(chunks: list[dict[str, Any]], file_name: str | None) -> tuple[str, list[dict[str, Any]]]:
    if not chunks:
        return "", []
    ctx = f"QUELLE: {file_name or 'PDF'}\n\n"
    chars = 0
    sources: list[dict[str, Any]] = []
    for c in chunks:
        ps, pe = c.get("page_start"), c.get("page_end")
        page_ref = ""
        if ps is not None:
            page_ref = f"[S. {ps}{('–' + str(pe)) if pe and pe != ps else ''}]"
        section = f"[{c['section_title']}] " if c.get("section_title") else ""
        line = f"{section}{page_ref}\n{c.get('chunk_text', '')}\n\n"
        if chars + len(line) > _MAX_CONTEXT_CHARS:
            break
        ctx += line
        chars += len(line)
        sources.append({"page_start": ps, "page_end": pe})
    return ctx, sources


# ── ANALYZE: deterministic page grouping (no LLM) ────────────────────────────
#
# The frontend's analyze step asks the backend to split a document into section
# groups, then generates+merges one section at a time. We do this WITHOUT an LLM
# call: we group from the indexed chunk metadata (page_start/page_end/
# section_title). When real headings exist we follow those natural boundaries;
# otherwise we fall back to stable fixed page windows. This keeps long/full-
# document summaries comprehensive (every page is covered by some group) while
# adding zero latency/token cost to the analyze step.

_MAX_GROUPS = 14          # cap section calls so huge docs don't fan out unbounded
_MAX_GROUP_PAGES = 6      # split an oversized heading-section into page windows


def _group_size(page_count: int) -> int:
    # Mirrors notes-panel.js `_groupSize` so backend + fallback behave alike.
    if page_count <= 3:
        return max(1, page_count)
    if page_count <= 10:
        return 3
    return 5


def _fetch_page_structure(user_id: str, course_id: str, document_id: str) -> list[dict[str, Any]]:
    sb = get_supabase()
    rows = (
        sb.table("document_chunks")
        .select("page_start, page_end, section_title")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("document_id", document_id)
        .order("page_start")
        .order("id")
        .limit(2000)
        .execute()
        .data
    ) or []
    return rows


def _group_pages(
    rows: list[dict[str, Any]],
    range_start: int | None = None,
    range_end: int | None = None,
) -> tuple[list[dict[str, Any]], int | None]:
    """Group indexed chunk metadata into section page ranges.

    Returns ``(groups, effective_pages)`` where each group is
    ``{"title", "pageStart", "pageEnd"}``. ``effective_pages`` is the highest
    page seen across the whole document (NOT clamped to the requested range), so
    the frontend can report coverage. Grouping itself is clamped to
    ``[range_start, range_end]`` when those are given.
    """
    pages: list[tuple[int, int, str]] = []
    for r in rows:
        ps = r.get("page_start")
        if ps is None:
            continue
        pe = r.get("page_end")
        title = (r.get("section_title") or "").strip()
        pages.append((int(ps), int(pe) if pe is not None else int(ps), title))
    if not pages:
        return [], None

    pages.sort(key=lambda x: (x[0], x[1]))
    min_page = min(p[0] for p in pages)
    effective = max(p[1] for p in pages)
    lo = range_start if range_start is not None else min_page
    hi = range_end if range_end is not None else effective
    if hi < lo:
        lo, hi = min_page, effective

    # Use natural heading boundaries only when there are at least two distinct
    # section titles — a single repeated chapter title carries no structure.
    distinct = {t for _, _, t in pages if t}
    groups: list[tuple[str | None, int, int]] = []

    if len(distinct) >= 2:
        cur_title: str | None = None
        cur_start: int | None = None
        cur_end: int | None = None
        for ps, pe, title in pages:
            if pe < lo or ps > hi:
                continue
            ps, pe = max(ps, lo), min(pe, hi)
            if cur_start is None:
                cur_title, cur_start, cur_end = (title or None), ps, pe
                continue
            # A new non-empty heading starts a new group; untitled chunks extend
            # the current section.
            if title and title != cur_title:
                groups.append((cur_title, cur_start, cur_end))
                cur_title, cur_start, cur_end = title, ps, pe
            else:
                cur_end = max(cur_end or pe, pe)
        if cur_start is not None:
            groups.append((cur_title, cur_start, cur_end))

        # Split any section that grew too large into bounded page windows.
        bounded: list[tuple[str | None, int, int]] = []
        for title, s, e in groups:
            if e - s + 1 > _MAX_GROUP_PAGES:
                p = s
                while p <= e:
                    bounded.append((title, p, min(p + _MAX_GROUP_PAGES - 1, e)))
                    p += _MAX_GROUP_PAGES
            else:
                bounded.append((title, s, e))
        groups = bounded

    # Fall back to stable page windows when there are no usable headings, or so
    # many heading groups that we'd fan out into too many section calls.
    if not groups or len(groups) > _MAX_GROUPS:
        groups = []
        gs = _group_size(hi - lo + 1)
        p = lo
        while p <= hi:
            groups.append((None, p, min(p + gs - 1, hi)))
            p += gs

    out = [{"title": t, "pageStart": s, "pageEnd": e} for t, s, e in groups]
    return out, effective


def _call_openai(system_prompt: str, user_message: str, max_tokens: int = 4000) -> str:
    settings = get_settings()
    client = get_openai_client()
    from ..services.llm_json import _token_limit_param
    token_param = _token_limit_param(settings.openai_generate_model_strong, max_tokens)
    resp = client.chat.completions.create(
        model=settings.openai_generate_model_strong,
        **token_param,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
    )
    from ..services.usage_meter import record_usage, usage_from_response  # noqa: WPS433
    record_usage(
        feature="notes_full",
        model=settings.openai_generate_model_strong,
        **usage_from_response(resp),
    )
    text = (resp.choices[0].message.content if resp.choices and resp.choices[0].message else "") or ""
    return text.strip()


def _batch_texts(parts: list[str], max_chars: int) -> list[str]:
    batches: list[str] = []
    current: list[str] = []
    current_len = 0
    for part in parts:
        part_len = len(part) + 2
        if current and current_len + part_len > max_chars:
            batches.append("\n\n".join(current))
            current = []
            current_len = 0
        current.append(part)
        current_len += part_len
    if current:
        batches.append("\n\n".join(current))
    return batches


def _merge_with_staging(
    system_prompt: str,
    instruction: str,
    parts: list[str],
    max_chars: int,
    max_tokens: int,
    depth: int = 0,
) -> str:
    batches = _batch_texts(parts, max_chars)
    if len(batches) <= 1 or depth >= 3:
        return _call_openai(system_prompt, instruction + "\n\n".join(batches), max_tokens=max_tokens)

    intermediate_parts: list[str] = []
    for i, batch in enumerate(batches):
        intermediate = _call_openai(
            system_prompt,
            (
                "Intermediate merge pass. Preserve all unique exam-relevant content and page references "
                f"from batch {i + 1} of {len(batches)}.\n\n"
                + instruction
                + batch
            ),
            max_tokens=max_tokens,
        )
        intermediate_parts.append(f"=== INTERMEDIATE MERGE {i + 1} ===\n\n{intermediate}")

    return _merge_with_staging(system_prompt, instruction, intermediate_parts, max_chars, max_tokens, depth + 1)


_TITLE_RE = re.compile(r"^#\s+(.+)", re.MULTILINE)


def _extract_title(markdown: str, fallback: str) -> str:
    m = _TITLE_RE.search(markdown or "")
    if not m:
        return fallback
    return re.sub(r"[*_`]", "", m.group(1)).strip() or fallback


def _save_note(
    user_id: str, course_id: str, document_id: str | None, title: str, type_: str,
    markdown: str, sources: list[dict[str, Any]],
    filter_start: int | None, filter_end: int | None,
) -> str | None:
    if not (markdown or "").strip():
        return None
    sb = get_supabase()
    try:
        row = sb.table("notes").insert({
            "user_id":           user_id,
            "course_id":         course_id,
            "document_id":       document_id,
            "title":             title[:180] or "Untitled",
            "type":              type_,
            "content_markdown":  markdown,
            "source_page_start": filter_start,
            "source_page_end":   filter_end,
            "updated_at":        datetime.now(timezone.utc).isoformat(),
        }).execute()
        note_id = row.data[0]["id"] if row.data else None
        if note_id and document_id and sources:
            src_rows = [
                {
                    "note_id":     note_id,
                    "document_id": document_id,
                    "page_start":  s.get("page_start"),
                    "page_end":    s.get("page_end"),
                }
                for s in sources if s.get("page_start") is not None
            ]
            if src_rows:
                try:
                    sb.table("note_sources").insert(src_rows).execute()
                except Exception:
                    log.exception("note_sources insert failed (non-fatal)")
        return note_id
    except Exception:
        log.exception("save_note failed")
        return None


# ── Request schema ───────────────────────────────────────────────────────────


class NotesGenerateRequest(BaseModel):
    userId: str
    courseId: str
    documentId: str | None = None
    tool: str  # 'notes' | 'summary'
    mode: str = "generate"  # 'generate' | 'section' | 'merge' | 'analyze'
    scope: str = "document"  # 'page' | 'section' | 'range' | 'document'
    fileName: str | None = None
    pdfText: str | None = None
    language: str = "same_as_source"
    detailLevel: str = "balanced"
    currentPage: int | None = None
    pageRange: dict[str, Any] | None = None
    topicTitle: str | None = None
    sections: list[dict[str, Any]] | None = None
    effectivePages: int | None = None
    title: str | None = None


# ── Endpoint ─────────────────────────────────────────────────────────────────


@router.post("/notes-generate")
def notes_generate(payload: NotesGenerateRequest) -> dict[str, Any]:
    if payload.tool not in ("notes", "summary"):
        raise HTTPException(status_code=400, detail="tool must be notes or summary")
    if payload.mode not in ("generate", "section", "merge", "analyze"):
        raise HTTPException(status_code=400, detail="mode is invalid")
    if payload.scope not in ("document", "page", "section", "range"):
        raise HTTPException(status_code=400, detail="scope is invalid")
    _verify_document_owner(payload.userId, payload.courseId, payload.documentId)

    # ── ANALYZE: deterministic page grouping from indexed chunk metadata ────
    # No LLM call — group by natural heading boundaries when present, else stable
    # page windows. On any failure return empty groups so the frontend falls back
    # to its own fixed-page splits (preserves the old UX).
    if payload.mode == "analyze":
        if not payload.documentId:
            return {"groups": [], "effectivePages": None}
        rng = payload.pageRange or {}
        r_start = int(rng["start"]) if rng.get("start") is not None else None
        r_end = int(rng["end"]) if rng.get("end") is not None else None
        try:
            rows = _fetch_page_structure(payload.userId, payload.courseId, payload.documentId)
        except Exception:
            log.exception("analyze fetch_page_structure failed")
            return {"groups": [], "effectivePages": None}
        groups, effective = _group_pages(rows, r_start, r_end)
        return {"groups": groups, "effectivePages": effective}

    # ── MERGE ───────────────────────────────────────────────────────────────
    if payload.mode == "merge":
        sections = payload.sections or []
        if not sections:
            raise HTTPException(status_code=400, detail="sections required for merge mode")
        combined_parts = []
        for i, s in enumerate(sections):
            hdr = (
                f"=== SECTION {i+1}: Seiten {s.get('pageStart')}–{s.get('pageEnd')} ==="
                if s.get("pageStart") is not None else f"=== SECTION {i+1} ==="
            )
            if s.get("title"):
                hdr += f" — {s['title']}"
            combined_parts.append(hdr + "\n\n" + (s.get("markdown") or ""))
        combined = "\n\n".join(combined_parts)
        instruction = (
            "Merge these section summaries into one final structured study summary:\n\n"
            if payload.tool == "summary"
            else "Merge these section notes into one final study note:\n\n"
        )
        try:
            is_exam_summary = payload.tool == "summary" and _normalize_detail(payload.detailLevel) == "exam"
            merge_tokens = 8000 if is_exam_summary else 5000
            system_prompt = _merge_prompt(payload.language, payload.tool, payload.detailLevel)
            max_chars = _EXAM_MERGE_CONTEXT_CHARS if is_exam_summary else _MAX_CONTEXT_CHARS
            if len(combined) > max_chars:
                merged = _merge_with_staging(
                    system_prompt,
                    instruction,
                    combined_parts,
                    max_chars,
                    merge_tokens,
                )
            else:
                merged = _call_openai(system_prompt, instruction + combined, max_tokens=merge_tokens)
        except Exception as e:  # noqa: BLE001
            log.exception("merge LLM failed")
            return {"error": f"Merge failed: {e}"}
        fallback_title = (payload.fileName or "Notizen") + " — " + ("Zusammenfassung" if payload.tool == "summary" else "Notizen")
        title = _extract_title(merged, fallback_title)
        merge_sources: list[dict[str, Any]] = []
        for s in sections:
            if s.get("pageStart") is not None:
                merge_sources.append({"page_start": s.get("pageStart"), "page_end": s.get("pageEnd")})
        filter_start = sections[0].get("pageStart") if sections else None
        filter_end = sections[-1].get("pageEnd") if sections else None
        note_id = _save_note(
            payload.userId, payload.courseId, payload.documentId, title, payload.tool,
            merged, merge_sources, filter_start, filter_end,
        )
        return {"note": {"id": note_id, "title": title, "type": payload.tool, "content_markdown": merged, "sources": merge_sources}}

    # ── SECTION ─────────────────────────────────────────────────────────────
    if payload.mode == "section":
        sec_start = int(payload.pageRange["start"]) if payload.pageRange and payload.pageRange.get("start") is not None else None
        sec_end   = int(payload.pageRange["end"])   if payload.pageRange and payload.pageRange.get("end")   is not None else None
        chunks: list[dict[str, Any]] = []
        if payload.documentId:
            try:
                chunks = _fetch_chunks(payload.userId, payload.courseId, payload.documentId, sec_start, sec_end)
            except Exception:
                log.exception("section fetch_chunks failed")
        if chunks:
            context, _src = _build_context(chunks, payload.fileName)
        elif payload.pdfText and len(payload.pdfText.strip()) > 50:
            context = f"QUELLE: {payload.fileName or 'PDF'}\n\n" + payload.pdfText[:_MAX_CONTEXT_CHARS]
        else:
            return {"markdown": "", "pageStart": sec_start, "pageEnd": sec_end, "empty": True}
        instr = (
            f"Erstelle eine Zusammenfassung NUR für diesen Abschnitt (S. {sec_start}–{sec_end})."
            if payload.tool == "summary"
            else "Erstelle detaillierte Lernnotizen NUR für diesen Abschnitt."
        )
        sys_p = _section_prompt(payload.language, sec_start, sec_end, payload.tool, payload.detailLevel)
        sec_tokens = 4000 if _normalize_detail(payload.detailLevel) == "exam" else 2500
        try:
            md = _call_openai(sys_p, f"PDF-INHALT (Seiten {sec_start}–{sec_end}):\n\n{context}\n\n{instr}", max_tokens=sec_tokens)
        except Exception as e:  # noqa: BLE001
            log.exception("section LLM failed")
            return {"error": f"Section generation failed: {e}"}
        return {"markdown": md, "pageStart": sec_start, "pageEnd": sec_end}

    # ── GENERATE (default) ──────────────────────────────────────────────────
    filter_start: int | None = None
    filter_end:   int | None = None
    if payload.scope != "document":
        cp = payload.currentPage
        if payload.scope == "page" and cp is not None:
            filter_start = cp
            filter_end = cp
        elif payload.scope == "section" and cp is not None:
            filter_start = max(1, cp - 1)
            filter_end = cp + 1
        elif payload.scope == "range" and payload.pageRange:
            filter_start = int(payload.pageRange["start"]) if payload.pageRange.get("start") is not None else None
            filter_end   = int(payload.pageRange["end"])   if payload.pageRange.get("end")   is not None else None

    chunks: list[dict[str, Any]] = []
    context = ""
    sources: list[dict[str, Any]] = []

    if payload.documentId:
        try:
            chunks = _fetch_chunks(payload.userId, payload.courseId, payload.documentId, filter_start, filter_end)
        except Exception:
            log.exception("generate fetch_chunks failed")
        if chunks:
            context, sources = _build_context(chunks, payload.fileName)

    if not context:
        if payload.pdfText and len(payload.pdfText.strip()) > 100:
            context = f"QUELLE: {payload.fileName or 'PDF'}\n\n" + payload.pdfText[:_MAX_CONTEXT_CHARS]
        else:
            return {
                "error": (
                    "Diese Datei wird noch indiziert. Bitte warte kurz und versuche es erneut."
                    if payload.documentId else "Kein Inhalt verfügbar. Öffne zuerst ein PDF."
                ),
                "indexing": bool(payload.documentId),
            }

    system_prompt = (
        _summary_prompt(payload.language, payload.detailLevel)
        if payload.tool == "summary"
        else _notes_prompt(payload.language)
    )
    page_hint = ""
    if filter_start is not None:
        page_hint = "\n\nFOKUS: " + (
            f"Seite {filter_start}" if filter_start == filter_end else f"Seiten {filter_start}–{filter_end}"
        ) + " des PDFs. Verwende NUR Inhalte aus diesem Seitenbereich."
    if payload.tool == "summary" and _normalize_detail(payload.detailLevel) == "exam":
        total_hint = ""
        if payload.effectivePages:
            total_hint = f" Das Dokument hat insgesamt {payload.effectivePages} Seiten."
        instr = (
            "Erstelle eine vollständige Prüfungszusammenfassung aus dem obigen Text. "
            "Gehe JEDE Seite systematisch durch. Erfasse ALLE Definitionen, DIN-Klassifikationen, "
            "Formeln, Verfahren, Werkstoffeigenschaften, Diagramme und Vergleiche. "
            "Überspringe KEINE Seite und KEIN Konzept."
            + total_hint
        )
    elif payload.tool == "summary":
        instr = (
            "Erstelle eine studentengerechte Zusammenfassung aus dem obigen Text. "
            "Halte dich strikt an den Seitenbereich. Erfasse alle wichtigen Definitionen, Formeln, Listen, Prozesse und Vergleiche."
        )
    else:
        instr = "Erstelle detaillierte Lernnotizen aus dem obigen Text. Erfasse ALLE Definitionen, Listen, Formeln und Prozessschritte."
    user_message = f"PDF-INHALT:\n\n{context}{page_hint}\n\n{instr}"

    gen_tokens = 8000 if (payload.tool == "summary" and _normalize_detail(payload.detailLevel) == "exam") else 6000
    try:
        markdown = _call_openai(system_prompt, user_message, max_tokens=gen_tokens)
    except Exception as e:  # noqa: BLE001
        log.exception("notes LLM failed")
        return {"error": f"KI-Generierung fehlgeschlagen: {e}"}

    page_label = ""
    if filter_start is not None:
        page_label = f" — S. {filter_start}" + (f"–{filter_end}" if filter_end and filter_end != filter_start else "")
    fallback_title = (
        (payload.fileName or "Notizen").replace(".pdf", "") + page_label
        + " — " + ("Zusammenfassung" if payload.tool == "summary" else "Notizen")
    )
    title = _extract_title(markdown, fallback_title)
    note_id = _save_note(
        payload.userId, payload.courseId, payload.documentId, title, payload.tool,
        markdown, sources, filter_start, filter_end,
    )
    return {"note": {"id": note_id, "title": title, "type": payload.tool, "content_markdown": markdown, "sources": sources}}
