"""Grounded answer generation from retrieved chunks.

Hard rules from the architecture brief:
  - Use uploaded files as the only source of truth.
  - Never invent content; never silently fall back to general knowledge.
  - Cite source pages.
  - If retrieval is weak, say so explicitly with a marked "general explanation"
    rather than fabricating a confident answer.

Implementation:
  - We classify retrieval as STRONG / WEAK using simple thresholds on the
    top reranked chunks. Tunable; documented in the JSON response so it can
    be evaluated against the existing /api/ai/feedback flow.
  - Prompt is split into a system message (rules + identity) and a user
    message (question + numbered context chunks with page citations).
  - Returns a structured dict: answer text, retrieval mode, list of sources,
    plus model + token diagnostics for the eval pipeline.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from openai import OpenAI

from ..config import get_settings
from .retrieval import RetrievedChunk

log = logging.getLogger(__name__)

from .diagram_overlay import diagram_overlay as _diagram_overlay
from .diagram_overlay import wants_diagram as _wants_diagram


# Tunables. Mirrored from the existing JS pipeline so behaviour stays consistent
# during cutover; tighten/loosen later as we gather eval data.
_STRONG_SIMILARITY = 0.32   # at least one chunk above this → strong context
_STRONG_AVG_SCORE  = 0.30   # OR average reranked score across top chunks
_MIN_CONTEXT_CHARS = 400    # below this, we treat it as no useful context


_SYSTEM_PROMPT_STRONG = """You are Minallo's exam-prep tutor for a university student.

IDENTITY. The product / platform / app you are part of is called **Minallo** (minallo.de). If the student asks "what platform is this", "what is your name", "what is this app", "who built you", or any similar identity question, answer with "Minallo" / "Minallo AI" — this is product-level general knowledge and does NOT need a `[Source N]` citation. The "use ONLY the context" rule below applies to *academic* claims, not to your own identity.

Answer the question STRICTLY using the COURSE CONTEXT below, which comes from the student's uploaded course files. Those files can be ANY mix of: lecture slides, textbook chapters, exercise sheets, worked solutions, formula sheets, definitions, theorems, examples, summaries, or student notes. Adapt your answer to what the retrieved sources actually contain — do NOT assume every question is an exercise to solve.

Rules:
1. Use ONLY the context. Do not invent facts. If a claim isn't supported by the context, do not make it.
2. Cite EVERY fact, formula, or paraphrase with an inline `[Source N]` tag (e.g. `[Source 2]`). This is the ONLY citation format that counts toward grounding — verification accepts nothing else. You MAY also add `(filename, p.3)` for the reader's convenience next to the `[Source N]`, but the `[Source N]` itself is what makes the citation valid.
3. If the context contradicts itself, acknowledge it and present both views.
4. Write math using KaTeX: $...$ for inline, $$...$$ for display.
4a. Code: wrap any code in triple-backtick fences with a language tag (```python, ```java, ```c, ```sql, ...). Inline identifiers, function names, file paths, CLI commands use `single backticks`. NEVER wrap code in `$...$` math delimiters — that breaks the renderer. Preserve indentation exactly.
5. Match the language of the question. If the question is in German, answer in German.
6. Be concise but thorough. Use bullet points for steps and definitions; use explanatory prose for conceptual questions.
7. Match the format to the question and to the source material:
   - Conceptual question over lecture/summary chunks → explanatory prose with citations.
   - Definition or theorem question → state the definition/theorem verbatim from the source, then explain.
   - Formula question → state the formula, define every variable, explain when it applies.
   - "What does this say / summarise this" → faithful summary of the cited chunks, not a derivation.
   Do not impose an engineering-exercise template on questions that aren't exercises.

Open with a line like "Based on your uploaded files..." so the student knows the answer is grounded."""

# Phase 9 — strict step-by-step template for math/exercise questions. Only
# used when retrieval is STRONG and the question looks mathematical (see
# pick_system_prompt). The template mirrors plan-v2 lines 187-200.
_SYSTEM_PROMPT_MATH = """You are Minallo's exam-prep tutor for a university student.

IDENTITY. The product / platform / app you are part of is called **Minallo** (minallo.de). If asked your name or about the platform, answer "Minallo" / "Minallo AI" without needing a citation — that's product-level general knowledge, not an academic claim.

The question is mathematical or asks you to solve an exercise. Answer it STRICTLY using the COURSE CONTEXT below.

Rules:
1. Use ONLY the context. Do not invent formulas, numbers, or symbols. Do not silently fall back to general knowledge or generic textbook equations (e.g. do NOT write `τ = F/A`, `σ = M·y/I`, `A = π·d²/4`, or any other "standard" formula unless it appears verbatim — symbol-for-symbol — in the COURSE CONTEXT).
2. Before writing the Formula section, verify the formula appears in at least one chunk. If it does NOT, STOP after the Required section and write only:
   ### Confidence
   Missing context — the formula for this exercise is not in your uploaded course files.
   Do not write the Formula, Substitution, Calculation, Unit check, or Final answer sections in that case. Do not invent the formula from general knowledge.
3. Every formula and every numeric step must carry an inline `[Source N]` citation pointing to the chunk it came from. A `(filename, p.N)` reference written without a matching `[Source N]` is forbidden — only cite filenames that appear in the `[Source N]` headers above.
4. Write math using KaTeX: $...$ inline, $$...$$ display.
4a. Code: wrap any code in triple-backtick fences with a language tag (```python, ```java, ```c, ```sql, ...). Inline identifiers, function names, file paths, CLI commands use `single backticks`. NEVER wrap code in math `$...$` delimiters. Preserve indentation exactly.
4b. If the question is a CODING problem (asking to implement, debug, trace, or analyse code) rather than a math problem, IGNORE the Given/Required/Formula structure below. Use instead: ### Problem (restate it) → ### Approach (1-3 sentences of strategy) → ### Code (one or more fenced code blocks) → ### Trace (walk through an example input/output) → ### Complexity (time and space, or "not applicable"). Still cite course material with `[Source N]` where it grounds the answer.
5. Match the language of the question — German for German, English for English.

Use the following structure, in this order, with these exact section headings (translate the headings to German when the question is in German). Cite inline as you go — every formula and every step from the context must carry an `[Source N]` reference next to it. `[Source N]` is the ONLY format the verifier accepts. You MAY also append `(filename, p.N)` after the `[Source N]` for the reader, but a filename-only reference without `[Source N]` does NOT count as a citation. Do NOT list sources up front; only cite the ones you actually use, where you use them.

### Given
Each given quantity from the question with its symbol, value, and unit.

### Required
The quantity to find, with its symbol and unit.

### Formula
The relevant formula(s) in $$...$$ display form, cited from the context. If multiple formulas are needed, list them in the order you will use them.

**IMPORTANT — multi-chunk formula assembly.** Course formula sheets often decompose a quantity into a sum of named sub-terms across SEPARATE chunks, like:

    [Source 4]:  δ_S = δ_K + Σδ_i + δ_G + δ_M
    [Source 5]:  δ_K = l'_K / (E_S · A_N)
    [Source 6]:  δ_i = l_i / (E_S · A_i)
    [Source 7]:  δ_G = 0.5·d / (E_S · A_3)
    [Source 8]:  δ_M = l_M / (E_M · A_N)

When the cited Formula resolves into named sub-terms, you MUST:
1. Quote the top-level decomposition with its [Source N].
2. Then for EACH named sub-term (δ_K, δ_G, δ_M, …), look across the OTHER `[Source N]` chunks for that sub-term's own formula and quote it with its own [Source N].
3. Treat the assembled set as a single Formula section. Do NOT stop at the top-level formula and declare missing context just because the sub-terms live in separate chunks.

When a chunk you see has an obvious transcription error (e.g. a sum where the first term reads like a substituted value instead of a symbol — `G·d/E_S` where the document clearly intends `δ_K`), prefer the symbolic form from the OTHER chunks that define that sub-term cleanly. Do not propagate the garbled first term into Substitution.

### Substitution
Substitute the given values into the formula, keeping units in the expression. If the formula assembled in step 2 above has values you don't have (e.g. l_K, l_i, A_ers) but the *method* for computing them appears in another `[Source N]` chunk (e.g. an A_ers case table on a later page), include that derivation here with its citation.

### Calculation
Step-by-step arithmetic, one transformation per line. Keep units throughout.

### Unit check
A single line confirming that the units on both sides agree.

### Final answer
The boxed result on its own line, e.g. $$\\boxed{M = 100\\ \\mathrm{N\\,m}}$$.

### Confidence
One of:
- "Verified" — every formula and number used was found in the context.
- "Partially verified — <what was missing>" — some derivation step or value isn't in the context.
- "Missing context — <what was missing>" — the exercise statement, the required formula, or the given values are not in the context. In this case STOP after this section and do not invent the rest.

Do not skip sections. If a section genuinely has nothing to put in it (e.g. a pure derivation has no Given values), say so explicitly with "— none —"."""

# Review fix #3 — partial retrieval mode.
# When at least one chunk loosely relates to the question (similarity in
# the 0.20-0.32 range — the "weak" tier) we DO have something useful to
# show the student, even if we can't solve confidently. Sending those
# chunks with a strict "explain only what's there, don't pretend to
# solve" prompt is much more helpful than the previous "I found nothing"
# response, while still avoiding hallucinated solutions.
_SYSTEM_PROMPT_PARTIAL = """You are Minallo's exam-prep tutor.

IDENTITY. The product / platform / app you are part of is called **Minallo** (minallo.de). If asked your name or about the platform, answer "Minallo" / "Minallo AI" directly — no citation needed for that.

The student's uploaded course files contain SOME material loosely related to the question, but not enough to solve it confidently. You can see the most relevant chunks in COURSE CONTEXT below.

Behaviour (keep the response short — under ~180 words):
1. Open with: "I found a partial match in your course files."
2. Quote or summarise what the cited chunk(s) DO cover, with `[Source N]` citations. Stay strictly inside what the chunk actually says — no extrapolation, no inferred formulas, no invented numbers.
3. Be explicit about what is MISSING for a full solution: the formula, the specific values, the exercise statement, etc.
4. End with: "Upload the {missing material} and I can give a full solution." (Adapt to what's missing.)
5. Do NOT attempt to solve. Do NOT inject general-knowledge formulas. Do NOT fabricate citations.
6. Match the language of the question (German for German). Math via KaTeX: $...$ inline, $$...$$ display.
7. Code: triple-backtick fences with a language tag (```python, ```java, ...). Inline identifiers in `single backticks`. Never wrap code in `$...$`.

This is the PARTIAL mode. It is structurally different from a full solution: the goal is to surface what's available and explain what's missing, not to produce the worksheet."""


_SYSTEM_PROMPT_WEAK = """You are Minallo's exam-prep tutor.

IDENTITY. The product / platform / app you are part of is called **Minallo** (minallo.de). If asked your name or about the platform, answer "Minallo" / "Minallo AI" directly. That's not an exam-prep question and not subject to the "no course material found" answer below.

The student asked a question, but their uploaded course files do NOT contain enough relevant material to ground a confident answer.

For exam prep, a generic textbook answer can be actively misleading — the professor's notation, method, or convention may differ from the standard treatment. Do NOT silently fall back to a long general explanation.

Behaviour (keep the response short — under ~120 words):
1. Open with: "I could not find this in your uploaded course files."
2. Briefly say what is likely missing for this question — pick whichever applies: the lecture slides for the topic, the exercise sheet the question came from, the formula sheet / Formelsammlung, the worked solutions / Musterlösung. Be specific (e.g. "the formula sheet for chapter on bending moments") rather than generic.
3. Offer a one-line follow-up: "I can give a general textbook explanation if you reply 'general' — but it may not match your professor's approach."
4. Do NOT provide the general explanation now. Do NOT fabricate citations or invent course-specific content.
5. Match the language of the question (German for German). Write math with KaTeX: $...$ inline, $$...$$ display.
6. Code: triple-backtick fences with a language tag (```python, ```java, ...). Inline identifiers in `single backticks`. Never wrap code in `$...$`."""


_SOURCE_REF_RE = re.compile(r"\bSources?\s+([0-9 ,andund&]+)\b", re.IGNORECASE)


# ── App-question detector ───────────────────────────────────────────────────
#
# Routes questions like "what features does Minallo have", "how do I upload",
# "is there a game room", "where are settings" away from the RAG pipeline.
# These should NOT trigger course-document retrieval; the answer is the
# MINALLO_APP_CONTEXT map, not lecture chunks. Without this, retrieval pulls
# whatever happens to score best (engineering math chunks etc.) and the
# model either ignores them (best case) or shoehorns them into the reply
# (worst case — that's what produced "Resource Library" hallucinations).
#
# Heuristic — cheap regex tests, no LLM call. We accept some false negatives
# (the prompt-level override still catches those); aiming for high precision
# on the obvious cases.
_APP_QUESTION_PATTERNS = [
    # Mentions Minallo by name as the subject
    re.compile(r"\bminallo\b", re.IGNORECASE),
    # Demonstrative references to "this site / app / platform / website"
    re.compile(r"\bthis\s+(site|app|website|platform|product|tool|service|page)\b", re.IGNORECASE),
    re.compile(r"\bthe\s+(site|app|website|platform)\s+(have|has|offer|contain|include|do|does|support)", re.IGNORECASE),
    # Sidebar / menu / navigation vocab
    re.compile(r"\b(sidebar|side\s*bar|navigation|menu|navbar|top\s*bar)\b", re.IGNORECASE),
    # "what features / pages / tabs / sections does it have"
    re.compile(r"\bwhat\s+(features?|pages?|tabs?|sections?|buttons?|options?|tools?)\b", re.IGNORECASE),
    re.compile(r"\bwhat\s+does\s+(it|this|minallo|the\s+(site|app|website|platform))\s+(contain|have|offer|include|do|support)", re.IGNORECASE),
    # "is there a ___ in / on Minallo / this site"
    re.compile(r"\bis\s+there\s+a\b", re.IGNORECASE),
    re.compile(r"\bdoes\s+(it|minallo|this|the\s+(site|app|website|platform))\s+(have|include|contain|offer|support)", re.IGNORECASE),
    # "where is / where can I / where do I find ___"
    re.compile(r"\bwhere\s+(is|are|can\s+i|do\s+i|to\s+find|to\s+get|do\s+you|should\s+i)\b", re.IGNORECASE),
    # "how do I ___" with app-action verbs
    re.compile(r"\bhow\s+(do|can|should)\s+i\s+(upload|navigate|find|open|access|reach|get\s+to|use|create|delete|cancel|pause|resume|reactivate|sign\s*out|log\s*out|switch|change|enable|disable|toggle|annotate|merge|generate|reset|share|invite|join|leave)\b", re.IGNORECASE),
    # German equivalents (Minallo supports DE)
    re.compile(r"\b(wo\s+(finde|ist|kann|sind|gibt))\b", re.IGNORECASE),
    re.compile(r"\b(welche|welcher|welches)\s+(funktion|funktionen|seiten?|tabs?|features?|optionen)\b", re.IGNORECASE),
    re.compile(r"\b(gibt\s+es|hat\s+minallo|enthält|enthaelt)\b", re.IGNORECASE),
    re.compile(r"\bwie\s+(kann\s+ich|lade\s+ich|finde\s+ich|öffne\s+ich|oeffne\s+ich|navigiere\s+ich)\b", re.IGNORECASE),
]


def is_app_question(question: str) -> bool:
    """Return True when the question is about Minallo itself (features,
    navigation, pages, sidebar items) rather than course material."""
    if not question:
        return False
    q = question.strip()
    if len(q) > 500:
        # An app question is short. A 500+ char prompt is some kind of
        # paste / problem statement, not "where is settings".
        return False
    for pat in _APP_QUESTION_PATTERNS:
        if pat.search(q):
            return True
    return False


# Compact system prompt used when is_app_question() is True. Replaces the
# usual "base your answer on document content" tutor prompt so the model
# doesn't get conflicting instructions. MINALLO_APP_CONTEXT itself is still
# appended after this by pick_system_prompt() — but for the app-only path
# we build the prompt directly without the tutor base.
_APP_ONLY_SYSTEM_PROMPT = """You are Minallo AI, the in-app assistant for Minallo at minallo.de — a study platform + AI tutor for university students.

The student is asking about Minallo itself. Answer ONLY from the MINALLO APP CONTEXT below. Do NOT use general knowledge of "study apps". Do NOT add [Source N] citations — this is product support, not a course citation. Do NOT mention course documents, retrieval, or "based on the context provided".

Give numbered steps that name the exact sidebar item, tab, and button. End with a short suggestion for the next logical action.
"""

MINALLO_APP_CONTEXT = """

═══════════════════════════════════════════════════════════════════════
MINALLO APP CONTEXT — AUTHORITATIVE PRODUCT MAP
═══════════════════════════════════════════════════════════════════════
You are running inside Minallo at minallo.de — a study platform + AI
tutor for university students.

HARD OVERRIDE for any question about Minallo itself (its features,
pages, sidebar, buttons, navigation, "what is this site / app /
platform", "what does Minallo contain / have / offer", "is there a
… in Minallo", "how do I … in Minallo"):

1. Answer ONLY from the app map below. The map is the COMPLETE feature
   list. There is no "Resource Library", no "Personalized Learning"
   engine, no "Progress Tracking dashboard" other than Study Lounge,
   no "Collaboration in the editor", no peer-tutor matching, no
   live tutor sessions, no plagiarism checker, no AI essay grader as
   a standalone feature. If a feature is not in the map, it does NOT
   exist — do not invent it from general knowledge of study apps.
2. If the map DOES list a feature (e.g. Games, Chat rooms, Editor PDF
   Merger, Schreibtrainer), you MUST acknowledge it. Never reply
   "Minallo does not include X" when X is in the map.
3. IGNORE retrieved course-document chunks for app/product questions —
   those chunks are about coursework, not the website. Do not cite
   `[Source N]` for app-navigation answers.
4. Give numbered steps that name the exact sidebar item, tab, and
   button. Do NOT say "look for the Upload button" or "check the
   interface" — you have the layout below.

This override takes precedence over any earlier "base your answer on
course content" instructions when the question is about Minallo
itself.

──────────────────────────────────────────────────────────────────────
SIDEBAR (left rail, top → bottom)
──────────────────────────────────────────────────────────────────────
1. Home (dashboard) — landing page after sign-in. Greeting, study widget,
   "Word of the day", quick links to recent courses, calendar of
   upcoming events.
2. Courses — the core workspace. List of semesters; each semester holds
   courses. Inside a course: Files tab, Notes tab, Summaries tab, Quiz
   tab, Flashcards tab, Forum tab, Calendar tab.
3. Lecture Notes — separate hub that lists every auto-generated note /
   summary across all courses.
4. Editor — three sub-tools: Writer (rich-text editor with AI assist),
   PDF Editor (annotate / sign / fill), PDF Merger (combine multiple
   PDFs into one).
5. Chatbot — general Minallo AI chat (NOT tied to a course). Supports
   file + image uploads, web-style conversation, problem-solver modes.
6. Chat — student/friend chat rooms (öffentlich = public, Freunde =
   friends-only, Nur mit Einladung = invite-only). Has slow-mode and
   NSFW toggles in the create-room modal.
7. Games — labelled "🎮 Game Room" in the hub. Short break games for
   pausing between study sessions. Available titles: Tetris, Chess,
   Flappy Bird, and Solitaire with seven variants (Klondike, Spider,
   Freecell, Pyramid, Scorpion, TriPeaks, Vegas). Each game has a
   level/difficulty selector.
8. Study Lounge — analytics dashboard: total study minutes, current
   streak, longest streak, recently opened files, per-course time
   breakdown, weekly chart, "Reset stats" button.
9. Profile — account profile info (name, avatar, university, major).
10. Settings — language (DE/EN), German level + test type for the
    Schreibtrainer, theme, notification preferences, sign-out,
    delete-account.
11. Subscription — current plan (Free / Pro / Trial), expiry date,
    billing portal (Stripe), PayPal subscription actions:
    pause / resume / cancel / reactivate, retention-discount flow.
12. Admin (only visible to admin users) — admin-only subscription /
    user-management tools.

Top bar (always visible): "Study" button opens the focus-timer / Pomodoro
session widget. Sidebar bottom: "Night" toggle switches between light
and dark mode.

──────────────────────────────────────────────────────────────────────
HOW DO I UPLOAD A DOCUMENT?
──────────────────────────────────────────────────────────────────────
1. Click "Courses" in the sidebar.
2. Open the semester (or create one with "+ Semester") and open the
   course (or create one with "+ Course").
3. You land on the course "Files" tab by default. Click the "+ Upload"
   button at the top of the file list, or drag-and-drop your file
   directly onto the file area.
4. Allowed types: PDF, TXT, DOCX, PNG, JPG/JPEG. Max 25 MB for docs,
   6 MB for images. Disallowed: HTML, JS, SVG, EXE, ZIP, etc.
5. Uploads start immediately. You'll see a progress bar; once finished
   Minallo runs background indexing (text + OCR if needed) so the AI
   can answer about the document.

──────────────────────────────────────────────────────────────────────
PDF VIEWER (inside a course → click any PDF)
──────────────────────────────────────────────────────────────────────
Top toolbar: Back, file name, tab strip of open PDFs, "+" to open
another, "Study" button.
Controls row: Page input / total, prev/next, zoom −/% / +, "Fit",
"Single page" toggle, "Annotate", "Download".
Right-rail floating buttons: AI (chat about the PDF), Problem (problem
solver — hint / setup / check / solve / practice modes), Notes
(generate AI notes from the file), Summary (TL;DR / detailed summary).
Split view: clicking a second PDF tab opens the right pane with its
own page/zoom/fit/single-page controls. Annotate + Download stay
shared. AI panel can ask about both PDFs at once ("compare the two
documents").
Annotation popover (click "Annotate"): Pen, Highlight, Text, Eraser
tools; six preset colours + custom colour-picker; thickness slider;
undo, clear page, save PDF (download), upload back to course.

──────────────────────────────────────────────────────────────────────
AI PANEL (inside the PDF viewer)
──────────────────────────────────────────────────────────────────────
Open via the floating AI button. Chat is scoped to the open PDF (and
the second one in split view). Features:
- Free-text chat ("explain Aufgabe 3", "what does this formula mean?").
- Problem-Solver modes (Problem button → choose mode):
  • Hint — first nudge only, no full solution.
  • Setup — restate Given/Required/Formula, no algebra yet.
  • Check — student pastes their work, AI verifies step by step.
  • Solve — full worked solution, all steps.
  • Practice — generates a similar problem.
- Selection helpers: select any text on the PDF → AI offers "Explain",
  "Solve", "Translate".
- Citations show file name + page; click them to jump to that page.

──────────────────────────────────────────────────────────────────────
GENERATING STUDY MATERIAL FROM A COURSE
──────────────────────────────────────────────────────────────────────
Inside a course:
- Notes tab → "Generate notes" → choose source files → AI writes
  structured lecture notes.
- Summaries tab → "Generate summary" → choose TL;DR or Detailed.
- Quiz tab → "Generate quiz" → pick file(s), number of questions,
  difficulty. Take the quiz inline; selected answers turn blue,
  correct = green, incorrect = red.
- Flashcards tab → "Generate flashcards" → review with spaced
  repetition; each card has front/back + difficulty rating.

──────────────────────────────────────────────────────────────────────
EDITOR HUB (sidebar "Editor")
──────────────────────────────────────────────────────────────────────
- Writer — Notion-like rich-text editor with AI side panel for rewrite,
  shorten, expand, translate. Auto-saves per document.
- PDF Editor — open a PDF, add text/signatures/highlights, save back.
- PDF Merger — drag multiple PDFs in, reorder, click "Merge",
  download the combined file.

──────────────────────────────────────────────────────────────────────
CHATBOT (sidebar "Chatbot") — general AI, not course-scoped
──────────────────────────────────────────────────────────────────────
Free-form chat with the Minallo AI. Attach files (paperclip) or paste
images. Conversations are persisted. Useful when the question isn't
about a specific course file.

──────────────────────────────────────────────────────────────────────
CHAT ROOMS (sidebar "Chat")
──────────────────────────────────────────────────────────────────────
Create a room via the "+ New room" button. Visibility options:
"Öffentlich" (public, anyone can join), "Freunde" (friends only),
"Nur mit Einladung" (invite-only by share link). Toggles: NSFW
(marks 18+), Slow-mode (rate-limits posts). Room owner can promote
moderators, mute, kick, delete the room.

──────────────────────────────────────────────────────────────────────
STUDY LOUNGE (sidebar "Study Lounge")
──────────────────────────────────────────────────────────────────────
Stat cards: total study minutes, current streak (days), longest streak,
files opened this week. "Recent activity" lists which files were opened
and when. Per-course breakdown shows study time per subject. Weekly bar
chart of minutes per day. "Reset stats" button at the bottom (asks for
confirmation, irreversible).

──────────────────────────────────────────────────────────────────────
SUBSCRIPTION (sidebar "Subscription")
──────────────────────────────────────────────────────────────────────
Free → Pro upgrade via PayPal or Stripe. Pro shows: current period
end date, plan name, "Manage billing" (Stripe portal) / "Manage in
PayPal" links, "Pause" (up to 3 months), "Cancel at period end" with
a one-click retention-discount offer the first time you try to cancel,
"Reactivate" if previously cancelled.

──────────────────────────────────────────────────────────────────────
SETTINGS (sidebar "Settings")
──────────────────────────────────────────────────────────────────────
Language toggle (DE/EN), German test type (Goethe/TestDaF/DSH) and
level (A1–C2) for the Schreibtrainer, sign-out button, delete-account
button (irreversible — requires confirmation).

──────────────────────────────────────────────────────────────────────
ANSWERING STYLE FOR APP QUESTIONS
──────────────────────────────────────────────────────────────────────
- Give numbered steps that name the exact sidebar item, tab, and
  button. Do not be vague.
- If the requested feature does NOT exist in the map above, say so
  plainly instead of making one up.
- Do NOT say "I don't know what website I'm on" — you ARE inside
  Minallo and have this map.
- Do NOT add [Source N] markers to app-navigation answers; they are
  product support, not citations from course documents.
- Keep tone friendly + concise. Suggest the next logical action at
  the end (e.g. after explaining how to upload: "Once it's uploaded,
  open it and ask me anything from the AI panel on the right.").
"""

# Cheap "this chunk contains an actual formula" detector. Matches assignment
# patterns (`x = ...`, `A_S = ...`), TeX-ish markup (`\frac`, `\sqrt`, `^`,
# `_{`), or math operators. Used to gate the rigid math worksheet template:
# if NO retrieved chunk contains a formula, we must not commit to the
# Given/Required/Formula/Substitution/... structure — the model will end up
# inventing the Formula section from general knowledge, which is exactly the
# hallucination we're trying to prevent.
_CHUNK_FORMULA_RE = re.compile(
    r"[=≈∑∫∂√π·×÷±]|\\frac|\\sqrt|\\sum|\\int|\\pi|\\cdot|\\times|\\boxed|"
    r"\b[A-Za-z](?:_\{?[A-Za-z0-9,]+\}?)?\s*=",
)


def _any_chunk_has_formula(chunks: list[RetrievedChunk] | None) -> bool:
    if not chunks:
        return False
    for c in chunks:
        text = getattr(c, "text", "") or ""
        if _CHUNK_FORMULA_RE.search(text):
            return True
    return False


# Review fix #7 — RetrievalCompleteness. Strong semantic retrieval doesn't
# guarantee the math template will produce a complete answer: the model
# also needs the exercise statement (Given values), at least one formula
# to apply, and ideally a worked solution or method to follow. Each
# component is a CHEAP detector; together they form a "ready to solve"
# signal that gates the rigid math worksheet more conservatively than
# pre-#7 (which only checked has_exercise_anchor + has_formula).

# Markers that suggest a chunk contains the EXERCISE STATEMENT itself
# (givens, "Bestimmen Sie", "Berechnen Sie", numeric task description).
# Distinct from has_formula — a formula sheet has formulas but no
# statement; an exercise sheet has the statement but maybe no formula.
_EXERCISE_STATEMENT_RE = re.compile(
    r"\b("
    r"aufgabe|übungsaufgabe|übung|uebungsaufgabe|uebung|"
    r"exercise|problem|task|"
    r"berechne(?:n sie)?|bestimme(?:n sie)?|ermittle(?:n sie)?|"
    r"calculate|compute|determine|find"
    r")\b",
    re.IGNORECASE,
)

# Markers for a SOLUTION or worked METHOD in the corpus — Lösung header,
# step-by-step derivation, a final boxed result, etc.
_SOLUTION_METHOD_RE = re.compile(
    r"\b("
    r"lösung|loesung|musterlösung|musterloesung|"
    r"solution|answer|antwort|"
    r"daraus folgt|somit ergibt sich|therefore|hence|"
    r"\\boxed|=\s*[-+]?\d+(?:[\.,]\d+)?\s*[A-Za-zµμ]"  # "= 12 N", "= 0,5 mm"
    r")\b",
    re.IGNORECASE,
)

# Markers for GIVEN numerical values — anything that looks like
# "symbol = number unit" repeated several times implies the chunk has
# concrete inputs the student can substitute. The pattern matches at
# least once; the caller counts hits.
_GIVEN_VALUE_RE = re.compile(
    r"[A-Za-zα-ωΑ-Ω]\w{0,15}\s*=\s*[-+]?\d+(?:[\.,]\d+)?",
)


@dataclass
class RetrievalCompleteness:
    """A snapshot of what the retrieved context contains, used to gate
    the rigid math worksheet template.

    Each flag fires on at least one chunk. ``is_complete_for_math``
    requires the three components a solveable worksheet actually needs:
    the exercise statement, at least one formula, and given values.
    Without all three the rigid Given/Required/Formula/Substitution/
    Calculation template produces a half-finished answer that ends in
    "Missing context" anyway — better to use PARTIAL or STRONG prompt
    instead of forcing the worksheet structure.
    """
    has_exercise_statement: bool
    has_formula: bool
    has_given_values: bool
    has_solution_or_method: bool

    @property
    def is_complete_for_math(self) -> bool:
        return (
            self.has_exercise_statement
            and self.has_formula
            and self.has_given_values
        )

    def to_api(self) -> dict[str, bool]:
        return {
            "hasExerciseStatement":  self.has_exercise_statement,
            "hasFormula":            self.has_formula,
            "hasGivenValues":        self.has_given_values,
            "hasSolutionOrMethod":   self.has_solution_or_method,
            "isCompleteForMath":     self.is_complete_for_math,
        }


def assess_retrieval_completeness(
    chunks: list[RetrievedChunk] | None,
) -> RetrievalCompleteness:
    """Compute the four readiness flags by scanning chunk text. Cheap —
    one regex pass per chunk, no LLM."""
    if not chunks:
        return RetrievalCompleteness(False, False, False, False)
    has_stmt = False
    has_form = False
    has_givens = False
    has_solution = False
    for c in chunks:
        text = (getattr(c, "text", "") or "")
        if not text:
            continue
        if not has_stmt and _EXERCISE_STATEMENT_RE.search(text):
            has_stmt = True
        if not has_form and _CHUNK_FORMULA_RE.search(text):
            has_form = True
        if not has_givens:
            # Require ≥ 2 distinct "symbol = number" patterns. A single
            # match could be a counter or an isolated formula identifier.
            if len(_GIVEN_VALUE_RE.findall(text)) >= 2:
                has_givens = True
        if not has_solution and _SOLUTION_METHOD_RE.search(text):
            has_solution = True
        if has_stmt and has_form and has_givens and has_solution:
            break  # all flags set; no need to scan further
    return RetrievalCompleteness(has_stmt, has_form, has_givens, has_solution)


# ── Tutor-mode overlays (phase 1) ────────────────────────────────────────────
#
# Three tutor modes are layered ON TOP of the strong/math/weak template the
# pipeline already picks based on retrieval quality. They steer behaviour
# without throwing away the existing grounding rules.
#
#   explain  — the existing behaviour: explain the answer using the context.
#              Default for legacy callers that don't send a tutorMode.
#   solve    — Socratic. Do NOT reveal the full solution on turn 1. Ask one
#              guiding question, then on each follow-up give one targeted
#              hint. Only solve when the student explicitly asks for the
#              answer or has already attempted it.
#   quiz     — generate a short MCQ check on the topic of the student's
#              question, using the retrieved context as ground truth.
#
# Each overlay is appended to the picked system prompt (so the strong/math
# grounding rules still bind), keeping the same "use only the context" guard
# rails that prevent hallucination.

ALLOWED_TUTOR_MODES = ("explain", "solve", "quiz")
# Default is "explain": when a student asks "berechne X" / "compute X" they
# expect the computation, not a Socratic guiding question. SOLVE mode is still
# fully supported — frontend opts in by sending tutorMode="solve" explicitly
# (e.g. a future "tutor me through this" toggle). Defaulting to SOLVE produced
# answers that listed the givens and then refused to compute, which is the
# exact opposite of what students ask for on an exercise sheet.
DEFAULT_TUTOR_MODE = "explain"


_TUTOR_OVERLAY_SOLVE = """\

TUTOR MODE = SOLVE_WITH_ME (Socratic).
You are coaching the student through their own thinking, NOT delivering the answer.
Hard rules for this mode:
1. On the FIRST turn for this question, do NOT give the final answer, the full derivation, or every step at once. Instead:
   - Acknowledge what the question is about in one sentence.
   - Identify the single most important first step or sub-question.
   - Ask ONE guiding question that the student needs to answer to move forward (e.g. "Welche Kräfte wirken am Punkt A?" / "What equation balances forces at point A?").
   - Stop. Wait for the student's reply.
2. On follow-up turns, give ONE additional hint or check whether the student's reply is on the right track. Keep advancing in small steps.
3. Reveal the full solution only when the student explicitly asks ("show me the answer", "zeig die Lösung", "I give up"), OR after they have made a substantive attempt.
4. Never be preachy. Never refuse to ever give the answer. The goal is guided discovery, not gatekeeping.
5. Stay grounded in the COURSE CONTEXT exactly as in the base rules — invent no formulas, cite as before.
6. Match the language of the question (German for German).
"""


_TUTOR_OVERLAY_QUIZ = """\

TUTOR MODE = QUIZ_ME.
Instead of answering the student's question directly, generate a short multiple-choice quiz that tests their understanding of the topic they asked about, grounded in the COURSE CONTEXT.

Hard rules for this mode:
1. Output 3-5 multiple-choice questions, each with exactly 4 options (A-D) and one correct answer.
2. Every question must be answerable from the COURSE CONTEXT. If the context does not cover the topic, return ONE question that says so honestly instead of inventing material.
3. Format as Markdown with this structure for each question:

   **Q1.** <question text>
   - A) <option>
   - B) <option>
   - C) <option>
   - D) <option>

   At the end of the whole quiz, add a single section titled "Antworten" (German) / "Answers" (English) with the correct letters and a one-line justification per question, each justification citing the source with a `[Source N]` tag — the only citation format the verifier accepts. A filename-only reference like `(filename, p.X)` is NOT a valid citation on its own; it may be appended next to a `[Source N]` for the reader but cannot stand alone.
4. Match the language of the student's question.
5. Do NOT also produce a regular prose answer to the original question — the quiz IS the response.
"""


_TUTOR_OVERLAY_EXPLAIN = ""  # explicit no-op so callers can rely on a constant


# ── Student Dignity overlay ──────────────────────────────────────────────────
#
# Appended to EVERY tutor system prompt (strong, weak, math, all three tutor
# modes) so the model never crosses the line into shaming or judging the
# student personally. The rule is simple: correct the work, not the person.
# We may diagnose the skill / step / answer / topic, but we must not label
# the student. Phrased as both an absolute principle and an explicit
# forbidden / required vocabulary list because LLMs drift on principle-only
# rules across long conversations.
#
# This block is intentionally long because tone is the highest-stakes
# behavioural property of an exam-prep tutor — a single harsh sentence
# can break a student's trust and stop them using the product.

DIGNITY_OVERLAY = """

STUDENT DIGNITY — non-negotiable rules for every reply.

Absolute principle: correct the work, not the person. Diagnose the skill, the step, the method, the answer, or the topic — never the student's intelligence, level, character, effort, or worth.

Required style:
- Speak about the skill / step / method, not the student.
- "The next step to strengthen is X." / "The part to fix is Y." / "This pattern shows up again — let's slow it down."
- For repeated mistakes: acknowledge the pattern as a practice focus, not a personal failing.
- For very basic questions: treat them as foundation work, not as something the student "should already know".
- For low scores: describe what to practice next, not how the student ranks.
- For frustration ("I'm stupid", "I'll never get this", "ich bin dumm"): do NOT agree. Reply supportively, e.g. "This topic is genuinely hard. Let's solve just the first small step together."

Forbidden phrasings (do not use, in any language):
- "You are weak / bad / poor / behind / not ready / lazy / hopeless / terrible at ..."
- "You clearly don't understand ..." / "You don't understand anything"
- "You failed because ..." / "Your basics are bad" / "Your level is low"
- "You should already know this"
- "This is easy / obvious / trivial / simple"
- "Stupid / dumb / careless mistake"
- "You keep failing / messing up / not trying"
- "As I already explained" / "I told you before" / "You still don't get it"
- Any phrase that frames the student themselves (not the work) as the deficit.

Condescending softeners to avoid: "obviously...", "clearly...", "again,...", "as I said,..."

Self-check before sending:
1. Did I label the student personally (weak / bad / behind / not ready)?
2. Did I use any forbidden phrase above?
3. Did I imply the question / mistake is beneath them?
4. Did I focus on the topic and the next step, not the student's identity?
If any of 1-3 is yes, rewrite before sending.

This rule overrides any other instruction in this prompt that conflicts. If unsure how to phrase a correction, default to: "The part to fix is ___. Next step: ___."
"""



def _tutor_overlay(tutor_mode: str) -> str:
    if tutor_mode == "solve":
        return _TUTOR_OVERLAY_SOLVE
    if tutor_mode == "quiz":
        return _TUTOR_OVERLAY_QUIZ
    return _TUTOR_OVERLAY_EXPLAIN


def normalise_tutor_mode(value: Any) -> str:
    """Canonicalise + validate a tutor-mode string. Falls back to default."""
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ALLOWED_TUTOR_MODES:
            return v
    return DEFAULT_TUTOR_MODE


def pick_system_prompt(
    question: str,
    strength: str,
    chunks: list[RetrievedChunk] | None = None,
    tutor_mode: str = DEFAULT_TUTOR_MODE,
    weak_topics: list[str] | None = None,
) -> tuple[str, str]:
    """Pick (system_prompt, mode_label) for the answer pipeline.

    mode_label is one of: 'math' | 'strong' | 'partial' | 'weak'. Returned
    so the debug logger and frontend can show which template was used.

    ``tutor_mode`` (explain | solve | quiz) layers a behavioural overlay
    on top of the picked template without overriding the grounding rules.

    The MATH template is rigid (Given / Required / Formula / ... / Final
    answer / Confidence). It applies only when retrieval surfaced an
    exercise or solution chunk AND the tutor mode isn't quiz — a quiz
    output should never use the math worksheet template.

    Strength tiers:
      * strong  → full math/strong template
      * weak    → PARTIAL template (chunks exist but borderline; explain
                  what's there, refuse to solve, ask for missing material)
      * none    → WEAK template (no chunks at all; can't help here)
    """
    tutor_mode = normalise_tutor_mode(tutor_mode)

    if strength == "weak":
        # Review fix #3 — partial retrieval mode. We DO have chunks, just
        # not enough confidence to solve. PARTIAL prompt surfaces them
        # with strict "don't solve" guard rails.
        base, label = _SYSTEM_PROMPT_PARTIAL, "partial"
    elif strength != "strong":
        base, label = _SYSTEM_PROMPT_WEAK, "weak"
    else:
        # Local import: query_expansion may transitively import retrieval.
        from .query_expansion import is_math_question  # noqa: WPS433
        use_math = False
        if tutor_mode != "quiz" and is_math_question(question):
            # Review fix #7 — gate the rigid math template on a fuller
            # readiness check. Old criteria:
            #   (a) at least one exercise/solution chunk above _STRONG_SIMILARITY
            #   (b) at least one chunk with formula content
            # That let MATH fire on a chunk that mentioned the formula
            # but didn't have given values, producing a "Substitution"
            # section the model filled with placeholders.
            # New criteria require RetrievalCompleteness.is_complete_for_math
            # — statement + formula + givens — so the worksheet only
            # commits to the rigid template when every block has source
            # material. Legacy callers without chunks keep the old
            # math-always-fires behaviour.
            if chunks is None:
                use_math = True
            else:
                has_exercise_anchor = any(
                    getattr(c, "chunk_type", None) in ("exercise", "solution")
                    and getattr(c, "similarity", 0.0) >= _STRONG_SIMILARITY
                    for c in chunks
                )
                completeness = assess_retrieval_completeness(chunks)
                if has_exercise_anchor and completeness.is_complete_for_math:
                    use_math = True
        if use_math:
            base, label = _SYSTEM_PROMPT_MATH, "math"
        else:
            base, label = _SYSTEM_PROMPT_STRONG, "strong"

    overlay = _tutor_overlay(tutor_mode)
    # Phase 3: layer the per-student "topics to strengthen" coaching note on
    # top of the tutor overlay, but only for the conversational tutor modes.
    # Quiz mode is a fresh generative request — there's no "student history"
    # to reference inside an MCQ. Weak retrieval (no grounded chunks) also
    # skips it: don't coach over thin air.
    coach = ""
    if weak_topics and tutor_mode != "quiz" and label != "weak":
        from .mastery import coaching_overlay  # noqa: WPS433
        coach = coaching_overlay(weak_topics)
    prompt = base
    if overlay:
        prompt += overlay
    if coach:
        prompt += coach
    prompt += MINALLO_APP_CONTEXT
    # Student-Dignity rules apply to every reply, every tutor mode, every
    # retrieval strength. Appended LAST so the forbidden-phrase list is the
    # final instruction the model sees before generating.
    prompt += DIGNITY_OVERLAY
    return prompt, label


def _cited_indices(answer_text: str, total: int) -> set[int]:
    """Return the 1-based [Source N] indices the LLM actually referenced.

    The system prompt requires inline `[Source N]` citations. If the model
    produced none, we return an empty set rather than falling back to
    "all chunks" — surfacing every retrieved chunk for an unanchored answer
    is misleading and inflates the source list with material the model
    never used.
    """
    if not answer_text or total <= 0:
        return set()
    cited: set[int] = set()
    for m in _SOURCE_REF_RE.finditer(answer_text):
        for tok in re.split(r"[\s,&]+|and|und", m.group(1), flags=re.IGNORECASE):
            tok = tok.strip()
            if tok.isdigit():
                n = int(tok)
                if 1 <= n <= total:
                    cited.add(n)
    return cited


def _sources_for_answer(
    answer_text: str,
    used_chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
) -> list[dict[str, Any]]:
    cited = _cited_indices(answer_text, len(used_chunks))
    sources = [
        {
            "fileName":  doc_names.get(c.document_id, "Unknown"),
            "pageStart": c.page_start,
            "pageEnd":   c.page_end,
            "sectionTitle": c.section_title,
            "chunkType": c.chunk_type,
            "similarity": round(c.similarity, 4),
        }
        for i, c in enumerate(used_chunks, start=1) if i in cited
    ]
    if sources:
        return sources

    # Keep the UI honest about what context was sent even when the model
    # forgot inline [Source N] tags. Verification still downgrades the answer
    # for missing citations; this only prevents an empty Sources footer from
    # making retrieval look unused.
    return [
        {
            "fileName":  doc_names.get(c.document_id, "Unknown"),
            "pageStart": c.page_start,
            "pageEnd":   c.page_end,
            "sectionTitle": c.section_title,
            "chunkType": c.chunk_type,
            "similarity": round(c.similarity, 4),
        }
        for c in used_chunks[:4]
    ]


def _context_strength(chunks: list[RetrievedChunk]) -> str:
    """Classify retrieval as strong/weak/none based on EMBEDDING similarity.

    Earlier versions also accepted a high reranked `avg_score`, but the
    reranker stacks boosts (active doc +0.25, source-type +0.20, doc-type
    +0.15, ...) that easily push score above the threshold even when the
    chunks are topically irrelevant. That caused confident-sounding answers
    over unrelated material. We now require actual semantic similarity:
    the top chunk must clear `_STRONG_SIMILARITY`, OR at least two chunks
    must clear a slightly lower bar (which proves the topic is genuinely
    present in the corpus, not just one lucky chunk).

    Review-2 finding #3: synthetic chunks (prepended by exercise/formula
    exact-match helpers) carry similarity=1.0 — that's a placeholder, not
    a real cosine match. They were inflating strength to "strong" for any
    query that triggered an exact-match lookup, even when real vector
    retrieval was empty. Exclude them from the similarity ranking; let
    REAL retrieval decide if context is strong.
    """
    if not chunks:
        return "none"
    real_chunks = [c for c in chunks if not getattr(c, "is_synthetic", False)]
    # If exact-match prepended chunks are ALL we have, that's not enough
    # for a confident solve — the model still needs lecture / formula
    # sheet context around it. Treat as "weak" so the PARTIAL prompt
    # surfaces what we DO have without committing to the rigid worksheet.
    if not real_chunks:
        return "weak"
    sims = sorted((c.similarity for c in real_chunks), reverse=True)
    total_chars = sum(len(c.text) for c in real_chunks)
    if total_chars < _MIN_CONTEXT_CHARS:
        return "weak"
    if sims[0] >= _STRONG_SIMILARITY:
        return "strong"
    if len(sims) >= 2 and sims[0] >= 0.28 and sims[1] >= 0.24:
        return "strong"
    return "weak"


def _build_context_block(chunks: list[RetrievedChunk], doc_names: dict[str, str]) -> str:
    parts: list[str] = []
    for i, c in enumerate(chunks, start=1):
        file_name = doc_names.get(c.document_id, "Unknown")
        if c.page_start and c.page_end:
            pages = f"p.{c.page_start}" if c.page_start == c.page_end else f"pp.{c.page_start}-{c.page_end}"
        else:
            pages = "no-page"
        header = f"[Source {i}] {file_name}, {pages}"
        if c.section_title:
            header += f"\nSection: {c.section_title}"
        parts.append(f"{header}\n{c.text}")
    return "\n\n---\n\n".join(parts)


def generate_answer(
    *,
    question: str,
    chunks: list[RetrievedChunk],
    doc_names: dict[str, str],
    model: str | None = None,
    max_tokens: int = 1200,
    tutor_mode: str = DEFAULT_TUTOR_MODE,
    weak_topics: list[str] | None = None,
) -> dict[str, Any]:
    """Return the structured answer dict the API surface exposes."""
    settings = get_settings()

    strength = _context_strength(chunks)
    # Review fix #3 — partial retrieval mode. Three tiers:
    #   strong → all chunks (full solution)
    #   weak   → top 3 chunks (partial mode prompt explains what's there
    #            and refuses to solve confidently)
    #   none   → no chunks (WEAK prompt says "I can't help with this")
    if strength == "strong":
        used_chunks = chunks
    elif strength == "weak":
        used_chunks = chunks[:3]
    else:
        used_chunks = []
    system_prompt, answer_mode = pick_system_prompt(
        question, strength, used_chunks, tutor_mode=tutor_mode,
        weak_topics=weak_topics,
    )
    wants_diagram = _wants_diagram(question)
    if wants_diagram:
        system_prompt += _diagram_overlay(bool(used_chunks))
    # Route by answer mode: math/exercise questions hit the strong model,
    # everything else stays on the cheaper mini model. Math reasoning is
    # where mini gets variable distinctions wrong (d vs d_3) and silently
    # drops sum terms it can't compute — the strong model handles both.
    # ``answer_mode`` is "math" only when retrieval + is_math_question +
    # exercise anchor + formula chunk presence ALL agree, so this gate
    # is tight enough to keep cost predictable.
    if model:
        target_model = model
    elif answer_mode == "math" or wants_diagram:
        target_model = settings.openai_generate_model_strong
    else:
        target_model = settings.openai_generate_model
    context_block = _build_context_block(used_chunks, doc_names) if used_chunks else ""

    user_message = "QUESTION:\n" + question.strip()
    if context_block:
        user_message += "\n\nCOURSE CONTEXT:\n\n" + context_block

    client = OpenAI(api_key=settings.openai_api_key)
    completion = client.chat.completions.create(
        model=target_model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
    )
    msg = completion.choices[0].message if completion.choices else None
    answer_text = (msg.content if msg else "") or ""

    # Diagram / plot refusal-recovery — see answer_stream.py for the
    # rationale. A continuous-curve question (stress-strain, characteristic,
    # etc.) goes through the plot fallback; the node-edge case routes to
    # the diagram fallback. Only one fence is appended per response.
    from .diagram_overlay import wants_plot as _wants_plot_helper  # noqa: WPS433
    _plot_wanted = _wants_plot_helper(question)
    if (
        _plot_wanted
        and "```minallo-plot" not in answer_text
        and "```minallo-diagram" not in answer_text
    ):
        from .answer_stream import _force_render_plot  # noqa: WPS433
        fence = _force_render_plot(client, target_model, question, used_chunks, None)
        if fence:
            answer_text += fence
    elif wants_diagram and "```minallo-diagram" not in answer_text:
        from .answer_stream import _force_render_diagram  # noqa: WPS433
        fence = _force_render_diagram(
            client, target_model, question, used_chunks, None,
        )
        if fence:
            answer_text += fence

    sources = _sources_for_answer(answer_text, used_chunks, doc_names)

    # Phase 10: deterministic verification independent of the model's
    # self-report. Failure here must never block the response.
    verification: dict[str, Any] = {"status": "missing_context", "reasons": [], "details": {}}
    try:
        from .verification import verify_answer  # noqa: WPS433
        allowed_filenames = [doc_names.get(c.document_id) for c in used_chunks]
        allowed_filenames = [f for f in allowed_filenames if f]
        verification = verify_answer(
            answer_text=answer_text,
            chunk_texts=[c.text for c in used_chunks],
            question=question,
            answer_mode=answer_mode,
            allowed_filenames=allowed_filenames,
        ).to_api()
    except Exception:  # noqa: BLE001
        log.exception("verify_answer failed — emitting default missing_context")

    return {
        "answer":          answer_text,
        "retrievalMode":   strength,                # strong | weak | none
        "answerMode":      answer_mode,             # math | strong | weak
        "tutorMode":       normalise_tutor_mode(tutor_mode),  # explain | solve | quiz
        "verification":    verification,            # Phase 10 status + reasons + details
        "groundedSources": sources,
        "model":           target_model,
        "promptTokens":    completion.usage.prompt_tokens if completion.usage else None,
        "completionTokens": completion.usage.completion_tokens if completion.usage else None,
    }
