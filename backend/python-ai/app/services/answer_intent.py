"""Major-agnostic academic intent classification for answer routing."""

from __future__ import annotations

import re
from enum import Enum
from typing import Any

from .query_expansion import is_math_question


class AcademicIntent(str, Enum):
    MATH_PROBLEM = "math_problem"
    MIXED_MATH_AND_CONCEPT = "mixed_math_and_concept"
    CONCEPTUAL_EXPLANATION = "conceptual_explanation"
    COURSE_SUMMARY = "course_summary"
    DEFINITION_OR_THEOREM = "definition_or_theorem"
    COMPARISON = "comparison"
    CODE_PROBLEM = "code_problem"
    QUIZ_GENERATION = "quiz_generation"
    EXAM_GENERATION = "exam_generation"
    FLASHCARD_GENERATION = "flashcard_generation"
    # Distinct student workflows with their own output shape (added 2026-06-18).
    ANSWER_CORRECTION_OR_GRADING = "answer_correction_or_grading"
    PRACTICE_VARIANT_GENERATION = "practice_variant_generation"
    FORMULA_EXTRACTION = "formula_extraction"
    FORMULA_EXPLANATION = "formula_explanation"
    EXAM_PRIORITY_LIST = "exam_priority_list"
    SOURCE_FINDING = "source_finding"
    CASE_OR_APPLICATION_REASONING = "case_or_application_reasoning"
    GENERAL_COURSE_QA = "general_course_qa"
    APP_QUESTION = "app_question"


_CALC_VERB_RE = re.compile(
    r"\b("
    r"solve|calculate|compute|derive|evaluate|differentiate|integrate|"
    r"simplify|factor|expand|determine|find|estimate|convert|prove|"
    r"berechne|berechnen|rechne|rechnen|loese|loesen|l(?:oe|ö)se|"
    r"bestimme|bestimmen|ermittle|ermitteln|ableiten|integrieren|beweise"
    r")\b",
    re.IGNORECASE,
)
_MATH_CONTEXT_RE = re.compile(
    r"("
    r"\b\d+(?:[\.,]\d+)?\s?(?:m|cm|mm|km|kg|g|mg|mcg|ml|l|n|pa|j|w|s|hz|"
    r"eur|usd|%|mg/kg|mmol/l|bpm|units?)\b|"
    r"[=≈≤≥≠]|[+\-*/^]\s*\d|"
    r"\b(rate|ratio|percentage|roi|interest|profit|revenue|cost|dose|dosage|"
    r"concentration|mol|molarity|force|velocity|acceleration|probability|"
    r"mean|median|variance|standard deviation|regression|formula|equation|"
    r"formel|gleichung|wahrscheinlichkeit|durchschnitt)\b"
    r")",
    re.IGNORECASE,
)
_EXERCISE_REF_RE = re.compile(
    r"\b(?:aufgabe|uebung|übung|exercise|problem|task)\s+\d+(?:[.\-]\d+)?(?:\s*\([a-z]\))?\b",
    re.IGNORECASE,
)
_NO_SOLVE_RE = re.compile(
    r"\b(do\s+not|don't|without|nicht|ohne)\s+(?:solve|calculate|compute|loesen|lösen|berechnen|rechnen)\b|"
    r"\bexplain\b.{0,40}\b(?:do\s+not|don't)\s+solve\b|"
    r"\berkl(?:ä|ae)r(?:e|en)?\b.{0,40}\bnicht\s+l(?:ö|oe)sen\b",
    re.IGNORECASE,
)
_CONCEPT_RE = re.compile(
    r"\b(explain|why|how|intuition|concept|meaning|interpret|describe|"
    r"erkl(?:ä|ae)r(?:e|en)?|warum|wie|bedeutet|konzept|intuition)\b",
    re.IGNORECASE,
)
_SUMMARY_RE = re.compile(
    r"\b(summar(?:y|ize|ise)|recap|overview|key points|main idea|"
    r"zusammenfass(?:ung|en)|fasse zusammen|kernaussagen?)\b",
    re.IGNORECASE,
)
_DEFINITION_RE = re.compile(
    r"\b(define|definition|what is|what are|theorem|lemma|satz|begriff|"
    r"definiere|was ist|was sind)\b",
    re.IGNORECASE,
)
_COMPARISON_RE = re.compile(
    r"\b(compare|contrast|difference between|differences?|versus|vs\.?|"
    r"pros and cons|advantages?|disadvantages?|unterschied|vergleiche|"
    r"gegen(?:ue|ü)ber|vor- und nachteile)\b",
    re.IGNORECASE,
)
_CODE_RE = re.compile(
    r"\b(code|coding|program|implement|debug|bug|error|exception|trace|"
    r"python|java|javascript|typescript|c\+\+|sql|html|css|algorithm|"
    r"compiler|runtime|stack trace)\b",
    re.IGNORECASE,
)
_QUIZ_RE = re.compile(r"\b(quiz|mcq|multiple choice|practice questions?|test me|prüfe mich|uebungsfragen|übungsfragen)\b", re.IGNORECASE)
# A request to BUILD an exam/Probeklausur. Either an unambiguous noun, or a
# creation verb followed (within a short span) by exam/klausur/prüfung.
_EXAM_GEN_RE = re.compile(
    r"\b(?:probeklausur|(?:uebungs|übungs)klausur|mock\s+exam|practice\s+exam|sample\s+exam|past\s+paper)\b"
    r"|\b(?:create|generate|make|write|build|prepare|design|compose|give\s+me|set\s+up|put\s+together|"
    r"erstell\w*|generier\w*|mach\w*|schreib\w*|entwirf|bau\w*|gib\s+mir)\b"
    r"[^.?!\n]{0,40}?\b(?:exam|klausur|pr(?:ü|ue)fung)\b",
    re.IGNORECASE,
)
# "a question for every lecture", "one per file", "each chapter", "all sources".
_COVERAGE_NOUN = (
    r"(?:lectures?|files?|chapters?|sources?|pdfs?|topics?|documents?|"
    r"kapitel\w*|vorlesung\w*|datei\w*|quelle\w*|thema\w*|themen|dokument\w*)"
)
_PER_SOURCE_COVERAGE_RE = re.compile(
    r"\b(?:every|each|all|jede[rsn]?|alle[rsn]?)\b[^.?!\n]{0,30}?\b" + _COVERAGE_NOUN + r"\b"
    r"|\b(?:one|a|eine?)\b[^.?!\n]{0,20}?\b(?:question|frage)\b[^.?!\n]{0,20}?\b(?:per|for\s+each|for\s+every|f(?:ü|ue)r\s+jede)\b"
    r"|\b(?:per|for\s+each|for\s+every|f(?:ü|ue)r\s+jede)\b[^.?!\n]{0,20}?\b" + _COVERAGE_NOUN + r"\b",
    re.IGNORECASE,
)
_FLASHCARD_RE = re.compile(r"\b(flashcards?|karteikarten?|anki)\b", re.IGNORECASE)
# Grading / checking the student's OWN submitted work. High precision: requires
# self-reference ("my/this answer|solution|work") or an explicit grading ask, so
# a plain "is X correct?" stays normal Q&A. Absorbs the chatbot "check my work".
_GRADING_RE = re.compile(
    r"\b(?:is|are|war|ist|sind)\s+(?:my|this|these|mein\w*|das|die)\s+"
    r"(?:answer|solution|approach|work|attempt|antwort\w*|l(?:ö|oe)sung\w*|rechnung\w*|ansatz)"
    r"\s+(?:correct|right|ok(?:ay)?|wrong|richtig|korrekt|falsch)"
    r"|\b(?:correct|grade|check|rate|mark|improve|fix|review)\s+my\s+"
    r"(?:answer|solution|work|attempt|antwort\w*|l(?:ö|oe)sung\w*)"
    r"|\b(?:korrigier\w*|bewert\w*|benot\w*)\s+(?:meine?\w*|das|die)"
    r"|\bhow\s+many\s+points\b|\bwie\s+viele?\s+punkte\b"
    r"|\bwhat(?:'s| is|s)?\s+(?:wrong|missing)\s+(?:with|in)\s+my\b"
    r"|\bwhere\s+did\s+i\s+(?:go\s+wrong|make\s+(?:a\s+)?mistake)\b"
    r"|\bcheck\s+my\s+work\b|\bgrade\s+(?:this|my)\b",
    re.IGNORECASE,
)
# A single practice VARIANT of an existing problem — not a quiz set, not a full
# exam. "another Aufgabe like this", "change the numbers", "let me practice this".
_PRACTICE_VARIANT_RE = re.compile(
    r"\b(?:another|similar|one\s+more|a\s+new|noch\s+eine?|weitere?|(?:ä|ae)hnlich\w*)\s+"
    r"(?:aufgabe|task|problem|exercise|(?:ü|ue)bung\w*)"
    r"|\b(?:practice|(?:ü|ue)b\w*)\s+this\s+type\b|\blet\s+me\s+practice\b"
    r"|\bchange\s+the\s+(?:numbers|values)\b|\b(?:ä|ae)ndere\s+die\s+(?:zahlen|werte)\b"
    r"|\b(?:with|but\s+with|mit)\s+(?:different|other|anderen)\s+(?:numbers|values|zahlen|werten)\b"
    r"|\blike\s+this\s+one\s+but\b|\bwie\s+diese[rs]?\s+aber\b",
    re.IGNORECASE,
)
# Extract / list the formulas (build a Formelsammlung) — NOT explain one formula.
_FORMULA_EXTRACTION_RE = re.compile(
    r"\bformelsammlung\b"
    r"|\b(?:list|give\s+me|extract|collect|sammle?|liste?(?:\s+(?:mir|alle))?)\b[^.?!\n]{0,30}"
    r"\b(?:formula|formulae|formel\w*|equation|gleichung\w*)"
    r"|\b(?:all|alle|every|welche)\b[^.?!\n]{0,20}\b(?:formula|formulae|formel\w*|equation|gleichung\w*)"
    r"|\bwhat\s+(?:formula|formulae|formel\w*|equation)s?\b[^.?!\n]{0,25}\b(?:do\s+i\s+need|need|use|important)"
    r"|\b(?:formula|formel\w*|equation)s?\b[^.?!\n]{0,20}\b(?:brauche\s+ich|do\s+i\s+need)",
    re.IGNORECASE,
)
# Source / citation lookup: WHERE is something stated. Keeps it to a short
# file/page answer instead of a full re-explanation.
_SOURCE_FINDING_RE = re.compile(
    r"\bwhere\s+(?:is|are|was|does|did|can\s+i\s+find)\b[^.?!\n]{0,45}"
    r"\b(?:mention\w*|state\w*|said|cover\w*|defin\w*|discuss\w*|written|in\s+the\s+(?:file|slide|lecture|chapter|notes|pdf))"
    r"|\bwhich\s+(?:file|document|chapter|slide|lecture|pdf|source|kapitel|datei|folie|vorlesung)\b"
    r"|\bin\s+which\s+(?:file|document|chapter|slide|lecture|kapitel|datei|folie|vorlesung)\b"
    r"|\bshow\s+me\s+(?:the\s+)?(?:source|where\s+it)\b|\bcite\s+(?:the\s+)?(?:source|file|page)\b"
    r"|\bwhere\s+did\s+you\s+get\s+(?:that|this|it)\b"
    r"|\bwo\s+(?:steht|wird|findet|kommt)\b|\bin\s+welche[rm]\s+(?:datei|vorlesung|kapitel|folie)\b"
    r"|\bquelle\s+(?:angeben|nennen|f(?:ü|ue)r)\b",
    re.IGNORECASE,
)
# Explain ONE formula (meaning / variables / when to use) — NOT list them all.
_FORMULA_EXPLANATION_RE = re.compile(
    r"\b(?:explain|erkl(?:ä|ae)r\w*|what\s+does|was\s+bedeutet)\b[^.?!\n]{0,30}"
    r"\b(?:formula|formulae|formel\w*|equation|gleichung\w*)"
    r"|\b(?:formula|formulae|formel\w*|equation|gleichung\w*)\b[^.?!\n]{0,30}"
    r"\b(?:mean\b|means\b|bedeut\w*|stand\s+for)"
    r"|\bwhat\s+(?:does|do)\b[^.?!\n]{0,25}\b(?:variable|symbol|term|letter)s?\b[^.?!\n]{0,15}\bmean"
    r"|\bwhen\s+(?:do|should)\s+i\s+use\s+(?:this|the)\s+(?:formula|formel\w*|equation)"
    r"|\bwann\s+(?:nutze|verwende|benutze)\s+ich\s+(?:diese|die)\s+(?:formel|gleichung)"
    r"|\bwhy\s+is\b[^.?!\n]{0,45}\b(?:divided\s+by|multiplied\s+by|squared|to\s+the\s+power)",
    re.IGNORECASE,
)
# "What's important / likely for the exam" — a priority list, not a timed plan
# (timed "make a study plan" is handled by the frontend mission router).
_EXAM_PRIORITY_RE = re.compile(
    r"\bwhat(?:'?s| is| are)?\s+(?:the\s+)?(?:most\s+)?important\b[^.?!\n]{0,30}"
    r"\b(?:for\s+the\s+(?:exam|klausur|test)|topics?|to\s+know)"
    r"|\bwhat\s+(?:should\s+i|to)\s+focus\s+on\b"
    r"|\bwhat(?:'?s| is)?\s+(?:likely|going)\s+to\s+(?:appear|come\s+up|be\s+(?:on|in)\s+the\s+(?:exam|test|klausur))"
    r"|\bwhat\s+(?:will|might|could)\s+(?:be\s+)?(?:on|in)\s+the\s+(?:exam|klausur|test)"
    r"|\bmost\s+important\s+topics?\b|\bwichtigste[nr]?\s+themen\b"
    r"|\bwas\s+(?:ist|kommt)\b[^.?!\n]{0,30}\b(?:wichtig|klausurrelevant|in\s+der\s+(?:klausur|pr(?:ü|ue)fung))"
    r"|\bexam\s+priorit\w*|\bklausurrelevant\w*",
    re.IGNORECASE,
)
# Cross-cutting STYLE flag (not a mutually-exclusive intent): "answer like my
# professor / in the script / Musterlösung style". Layered on the base intent.
_PROFESSOR_STYLE_RE = re.compile(
    r"\b(?:like|wie)\s+(?:my|the|our|mein\w*|der|die|unser\w*)\s+(?:prof\w*|dozent\w*|lecturer|teacher|professor)"
    r"|\b(?:in|im)\s+(?:the\s+)?(?:script|skript|vorlesungsstil|lecture\s+style)"
    r"|\bmusterl(?:ö|oe)sung\b|\bexam[-\s]?ready\b|\bexam[-\s]?style\b|\bklausurreif\w*"
    r"|\bwhat\s+(?:would|does)\s+the\s+(?:exam|professor|prof|klausur)\s+(?:expect|want)"
    r"|\bprofessor[-\s]?style\b|\buse\s+(?:the\s+)?(?:course|lecture)\s+wording\b"
    r"|\b(?:answer|write|antworte?)\b[^.?!\n]{0,20}\blike\s+(?:in\s+)?(?:the\s+)?(?:lecture|script|skript|exam|klausur)\b",
    re.IGNORECASE,
)
_CASE_RE = re.compile(
    r"\b("
    r"case|scenario|patient|diagnosis|treatment|symptoms?|clinical|"
    r"business case|market entry|strategy|recommendation|recommend|"
    r"marketing|segmentation|positioning|law|legal|policy|ethic(?:al|s)?|"
    r"apply|application|analy[sz]e|analysis|interpret this case|"
    r"fallbeispiel|patient(?:in)?|diagnose|therapie|strategie|"
    r"empfehlung|rechtlich|ethisch|anwenden|analysiere"
    r")\b",
    re.IGNORECASE,
)
_APP_RE = re.compile(
    r"\b(minallo|this\s+(?:site|app|website|platform)|upload|subscription|sidebar|"
    r"navigation|settings|account|course page|pdf hochladen|abo|konto)\b",
    re.IGNORECASE,
)
_PURE_CHITCHAT_RE = re.compile(
    r"^\s*(?:"
    r"hi|hii+|hello|hey|heyy+|yo|sup|"
    r"good\s+(?:morning|afternoon|evening)|"
    r"hallo|moin|servus|guten\s+(?:morgen|tag|abend)|"
    r"thanks?|thank\s+you|thx|danke|dankeschoen|dankeschon|"
    r"ok(?:ay)?|kk|cool|nice|great|perfect|"
    r"bye|goodbye|see\s+you|tsch(?:ue|u)ss|ciao"
    r")\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_SOCIAL_QUESTION_RE = re.compile(
    r"^\s*(?:"
    r"how\s+are\s+you|how'?s\s+it\s+going|what'?s\s+up|"
    r"wie\s+geht(?:'?s|\s+es)?(?:\s+dir)?|alles\s+gut"
    r")\s*[.!?]*\s*$",
    re.IGNORECASE,
)


def _chunk_text(chunks: list[Any] | None, limit: int = 4) -> str:
    if not chunks:
        return ""
    return "\n".join((getattr(c, "text", "") or "") for c in chunks[:limit])


def _has_math_problem_context(chunks: list[Any] | None) -> bool:
    if not chunks:
        return False
    joined = _chunk_text(chunks)
    if not joined:
        return False
    has_problem_chunk = any(
        (getattr(c, "chunk_type", "") or "").lower() in {"exercise", "solution", "formula"}
        for c in chunks[:4]
    )
    return has_problem_chunk and bool(_MATH_CONTEXT_RE.search(joined))


def _normalise_intent(value: AcademicIntent | str | None) -> AcademicIntent | None:
    if value is None:
        return None
    if isinstance(value, AcademicIntent):
        return value
    try:
        return AcademicIntent(value)
    except ValueError:
        return None


def classify_academic_intent(
    question: str,
    chunks: list[Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> AcademicIntent:
    """Classify the student's task intent across majors.

    The older ``is_math_question`` helper remains a signal, but broad words
    such as "problem", "case", "solution", and "Aufgabe" do not by
    themselves route to the strict math worksheet.
    """

    metadata = metadata or {}
    if metadata.get("app_question"):
        return AcademicIntent.APP_QUESTION

    text = (question or "").strip()
    if not text:
        return AcademicIntent.GENERAL_COURSE_QA
    q = text.lower()

    if _APP_RE.search(text) and not _MATH_CONTEXT_RE.search(text):
        if any(token in q for token in ("minallo", "this app", "this site", "upload", "subscription", "sidebar")):
            return AcademicIntent.APP_QUESTION

    if _FLASHCARD_RE.search(text):
        return AcademicIntent.FLASHCARD_GENERATION
    if _QUIZ_RE.search(text):
        return AcademicIntent.QUIZ_GENERATION
    if _CODE_RE.search(text):
        return AcademicIntent.CODE_PROBLEM
    if _SUMMARY_RE.search(text):
        return AcademicIntent.COURSE_SUMMARY
    if _COMPARISON_RE.search(text):
        return AcademicIntent.COMPARISON
    # Exam generation is checked after summary/comparison so "summary of the
    # exam" routes to summary; a real "create an exam" request has no such
    # keyword and falls through to here.
    if _EXAM_GEN_RE.search(text):
        return AcademicIntent.EXAM_GENERATION

    # Distinct student workflows, checked before the math/concept fallbacks so a
    # self-referential "is my solution correct?" or "where is this stated?" gets
    # its own structure instead of a generic explanation. High precision (see the
    # regexes) so a plain question never trips them.
    if _GRADING_RE.search(text):
        return AcademicIntent.ANSWER_CORRECTION_OR_GRADING
    if _PRACTICE_VARIANT_RE.search(text):
        return AcademicIntent.PRACTICE_VARIANT_GENERATION
    if _FORMULA_EXTRACTION_RE.search(text):
        return AcademicIntent.FORMULA_EXTRACTION
    # Explaining ONE formula is checked AFTER extraction so "explain all the
    # formulas" lists them, but "explain this formula" explains it.
    if _FORMULA_EXPLANATION_RE.search(text):
        return AcademicIntent.FORMULA_EXPLANATION
    if _EXAM_PRIORITY_RE.search(text):
        return AcademicIntent.EXAM_PRIORITY_LIST
    if _SOURCE_FINDING_RE.search(text):
        return AcademicIntent.SOURCE_FINDING

    no_solve = bool(_NO_SOLVE_RE.search(text))
    calc_verb = bool(_CALC_VERB_RE.search(text))
    math_context = bool(_MATH_CONTEXT_RE.search(text))
    exercise_ref = bool(_EXERCISE_REF_RE.search(text))
    visible_math_context = _has_math_problem_context(chunks)
    legacy_math_signal = is_math_question(text)
    conceptual_signal = bool(_CONCEPT_RE.search(text))
    case_signal = bool(_CASE_RE.search(text))
    definition_signal = bool(_DEFINITION_RE.search(text))

    deictic_solve = calc_verb and bool(re.search(r"\b(this|it|that|the\s+(?:first|second|third)?\s*problem)\b", q))
    deictic_visible_problem = bool(
        re.search(r"\b(answer|do|work through|help with)\b.{0,40}\b(?:this|it|that|problem|aufgabe|exercise)\b", q)
    )
    explicit_math = (
        not no_solve
        and (
            (calc_verb and (math_context or exercise_ref or visible_math_context or legacy_math_signal))
            or (exercise_ref and visible_math_context)
            or (deictic_solve and visible_math_context)
            or (deictic_visible_problem and visible_math_context)
        )
    )

    if explicit_math and conceptual_signal:
        return AcademicIntent.MIXED_MATH_AND_CONCEPT
    if explicit_math:
        return AcademicIntent.MATH_PROBLEM

    if definition_signal:
        return AcademicIntent.DEFINITION_OR_THEOREM
    if case_signal:
        return AcademicIntent.CASE_OR_APPLICATION_REASONING
    if conceptual_signal or no_solve:
        return AcademicIntent.CONCEPTUAL_EXPLANATION
    return AcademicIntent.GENERAL_COURSE_QA


def wants_per_source_coverage(question: str) -> bool:
    """True when the student asks for output covering each/every selected file
    ("a question for every lecture", "one per chapter", "all sources")."""
    return bool(_PER_SOURCE_COVERAGE_RE.search(question or ""))


# Professor / exam-ready styling is a CROSS-CUTTING modifier, not a standalone
# intent: "explain X like my professor" is still a conceptual explanation, just
# phrased the course's way. So it's layered on top of whatever intent fires.
PROFESSOR_STYLE_INSTRUCTION = (
    "\n\nPROFESSOR / EXAM-READY STYLE (layer this on top of the format above): the "
    "student wants the answer phrased the way THEIR course would. Use the EXACT "
    "terminology, notation and definitions from the retrieved COURSE CONTEXT — not "
    "generic textbook wording — follow the lecture's structure/order, and write it at "
    "the level a Musterlösung would earn full marks for. Where useful, end with a "
    "short `**Expected keywords:**` line (the terms a grader looks for) and a one-line "
    "`**Common mistake:**`. If the course context doesn't actually contain what's "
    "needed, say so plainly instead of filling the gap with general knowledge."
)


def wants_professor_style(question: str) -> bool:
    """True when the student asks for a course/professor/Musterlösung-style answer
    ('answer like my professor', 'in the script', 'exam-ready', 'klausurreif')."""
    return bool(_PROFESSOR_STYLE_RE.search(question or ""))


def is_non_academic_chitchat(question: str) -> bool:
    """True for pure social/acknowledgement turns that should not query RAG."""
    text = (question or "").strip()
    if not text:
        return False
    return bool(_PURE_CHITCHAT_RE.match(text) or _SOCIAL_QUESTION_RE.match(text))


def chitchat_answer(question: str) -> str:
    """Small static replies for social turns; avoids wasting an LLM/RAG call."""
    text = (question or "").strip().lower()
    if re.match(r"^(thanks?|thank\s+you|thx|danke|dankeschoen|dankeschon)\b", text):
        return "You're welcome. What would you like to work on next?"
    if re.match(r"^(bye|goodbye|see\s+you|tsch(?:ue|u)ss|ciao)\b", text):
        return "See you. Good luck with your studying."
    if _SOCIAL_QUESTION_RE.match(text):
        return "I'm doing well and ready to help. What would you like to study?"
    if re.match(r"^(ok(?:ay)?|kk|cool|nice|great|perfect)\b", text):
        return "Got it. What would you like to work on next?"
    return "Hi! What would you like to study or work on?"


def intent_is_math_like(intent: AcademicIntent | str | None) -> bool:
    return _normalise_intent(intent) in {
        AcademicIntent.MATH_PROBLEM,
        AcademicIntent.MIXED_MATH_AND_CONCEPT,
    }


def intent_allows_missing_input(intent: AcademicIntent | str | None) -> bool:
    return intent_is_math_like(intent)


def intent_style_instruction(intent: AcademicIntent | str | None) -> str:
    intent = _normalise_intent(intent) or AcademicIntent.GENERAL_COURSE_QA
    lines = ["", "", "ACADEMIC TASK INTENT ROUTING:"]

    if intent == AcademicIntent.CASE_OR_APPLICATION_REASONING:
        lines.extend([
            "- Treat this as case/application reasoning, not a math worksheet.",
            "- Use this structure when supported by the sources: facts/context, relevant concept/framework, application to the case, conclusion/recommendation.",
        ])
    elif intent == AcademicIntent.COURSE_SUMMARY:
        lines.append("- Treat this as a summary request: preserve the source's main points and avoid adding unstated examples.")
    elif intent == AcademicIntent.DEFINITION_OR_THEOREM:
        lines.append("- Treat this as a definition/theorem request: state the sourced definition or theorem first, then explain it briefly.")
    elif intent == AcademicIntent.COMPARISON:
        lines.append("- Treat this as a comparison request: compare dimensions side by side, then give the takeaway.")
    elif intent == AcademicIntent.CODE_PROBLEM:
        lines.append("- Treat this as a coding/debugging request: use fenced code blocks and explain the cause, fix, and trace when relevant.")
    elif intent == AcademicIntent.QUIZ_GENERATION:
        lines.append("- Treat this as quiz generation: produce study questions with answers/explanations grounded in the provided material.")
    elif intent == AcademicIntent.EXAM_GENERATION:
        lines.extend([
            "- Treat this as EXAM GENERATION. Produce a complete, university-style practice exam (Probeklausur) grounded in the COURSE CONTEXT — NOT a short list of one-line questions.",
            "- Begin with a title heading `# Probeklausur: <course/topic>` followed by an exam header block: **Time** (e.g. 60-90 min), **Total** (points summing to ~100), **Allowed tools**, and a one-line **Instructions**.",
            "- Produce one `## Aufgabe N: <lecture/file name> — <points> Punkte` section per selected source file, each with a `**Source:** [Source N] — <file name>` line directly under the heading. Distribute the ~100 points roughly EVENLY across the files (≈ 100 / number-of-files per Aufgabe); NEVER give one Aufgabe 30-40 points while others get a handful — balanced, smaller tasks make a realistic 90-minute exam.",
            "- Give each Aufgabe subquestions a), b), c) (and d) where useful), each worth ~5-10 points, so the whole exam reads as ~10-17 smaller tasks rather than a few huge blocks. The subquestions MIX: a definition/theory question, an explanation/application question, a calculation/math task WHERE the source contains formulas, and a short comparison/classification or process-selection question.",
            "- Write realistic calculation tasks wherever the source has formulas (state concrete given values and ask the student to compute, e.g. Umformgrad, Nenndehnung, Spanungsquerschnitt, Schnittgeschwindigkeit, Vorschubgeschwindigkeit, Bearbeitungszeit).",
            "- FORMULA FAITHFULNESS. Use a formula ONLY if it appears in the retrieved source, and copy it EXACTLY — same variable names, same numerator/denominator structure. Never invent, rewrite, approximate or guess a formula. Do NOT ask the student to 'derive' (herleiten) a formula unless the lecture actually shows that derivation; if the source merely STATES a formula (e.g. the Spanraumzahl), ask the student to EXPLAIN or apply it, not derive it. If a formula is unclear, garbled or absent, write a conceptual question instead of a bogus calculation.",
            "- Default to open questions, calculations, and explanation/diagram prompts. Do NOT use multiple-choice unless the student explicitly asked for it.",
            # Source hygiene — judge PER SLIDE/PAGE, never skip a whole file.
            "- JUDGE TECHNICAL RELEVANCE PER SLIDE/PAGE, NOT PER FILE. A lecture PDF normally MIXES a few non-technical slides (title, agenda, learning-objectives, an info/StudING/event slide, a QR-code slide, a literature/references slide) WITH the real technical content. IGNORE those individual slides, but ALWAYS build the file's Aufgabe from its TECHNICAL content found in the OTHER chunks of that same file.",
            "- A chapter PDF almost always has real subject matter, so do NOT mark an Aufgabe 'entfällt' and do NOT call a file 'non-technical' or 'only literature' just because ONE retrieved slide was an info/title/QR/literature slide. (e.g. Kunststofftechnik files cover Extrusion, Spritzgießen, Thermoplaste/Duroplaste/Elastomere, Kunststoffverfahren; Umformverfahren files cover DIN 8582 by Spannungszustand, Tailored Blanks, Tiefziehen, Streckziehen, Gesenkbiegen, Strangpressen.) Only skip a file if it genuinely has NO technical content in ANY of its chunks — which is rare. Never invent a 'communication structure / layout / QR-code / target groups' question.",
            "- Ground every task in the SPECIFIC examples, classifications, workflows and process lists the source actually presents (e.g. the named machining processes Fräsen/Bohren/Drehen and Schleifen/Läppen/Honen; the Verschleißkurven → Standzeit-Schnittgeschwindigkeits-Diagramm workflow), not generic textbook phrasing. When judging a computed value, use the accepted tolerance/range the source states (don't call a result within the stated range 'not ideal').",
            # Item 3 / 7.6 — classification must use the right standard level.
            "- CLASSIFICATION QUESTIONS — use the correct standard. DIN 8580 defines the six manufacturing MAIN groups (Urformen, Umformen, Trennen, Fügen, Beschichten, Stoffeigenschaften ändern). DIN 8593 defines the SUBGROUPS of Fügen. When the source is about joining (Fügen), ask the student to classify the named processes into the DIN 8593 subgroups of Fügen (Zusammensetzen, Füllen, An-/Einpressen, Fügen durch Urformen, Fügen durch Umformen, Schweißen, Löten, Kleben, textiles Fügen) and to justify the choice. NEVER ask whether Kleben, Löten or Einpressen belong to Urformen/Umformen/Trennen — they are ALL within the Hauptgruppe Fügen; mixing the two standard levels is wrong.",
            # Items 1 / 2 / 5 / 6 — the Kurzlösung must be COMPLETE, no placeholders.
            "- The `## Kurzlösung` section is MANDATORY and must be COMPLETE — it is part of the graded output, not an afterthought. Write `### Aufgabe N` for EVERY Aufgabe above, in the SAME order and numbering, then `**a)**`, `**b)**`, `**c)**` (and `**d)**`) matching that Aufgabe's subquestions exactly.",
            "- SCALE ANSWER DEPTH TO THE POINTS, per subpart: ~5 points → 3-5 precise bullets; ~10 points → 6-8 bullets or clear labelled subparts; 15+ points → a rubric-style answer (Definition, then ordered explanation/process steps, then examples, plus the formula where relevant). A 16-17 point Aufgabe must NEVER be answered with only 2-4 bullets total — that is the single most common failure.",
            "- Use the EXACT technical terms from the source so a student sees what earns the marks. For calculation subparts state the formula AND the expected/worked result; for classification subparts give the actual categories; for 'name N …' subparts list N real items; for 'explain the process' subparts give the FULL ordered process steps (e.g. Spritzgießen: Plastifizieren → Einspritzen → Nachdruck → Abkühlen/Erstarren → Werkzeug öffnen → Auswerfen).",
            "- ABSOLUTELY NO PLACEHOLDERS in the Kurzlösung. Never write '…', '...', 'stichpunktartig ergänzen', 'analog (zu oben)', 'für jede (weitere) Aufgabe …', 'etc.', 'usw.' or a single summary line in place of an answer. Every single Aufgabe must be answered in full, even if that makes the Kurzlösung long — completeness overrides brevity.",
            "- Match the language of the course material (German course → German exam).",
        ])
    elif intent == AcademicIntent.ANSWER_CORRECTION_OR_GRADING:
        lines.extend([
            "- Treat this as GRADING the student's OWN submitted answer/solution — evaluate it, do NOT just re-explain the topic or solve it from scratch.",
            "- Use this exact structure: `## Verdict` (Correct / Partly correct / Wrong), `## Estimated points` (X / Y — only if a point total is known or implied, else omit), `## What is good`, `## What is missing or wrong` (name the FIRST wrong step for a multi-step solution), `## Corrected answer` (only the parts that need fixing — don't rewrite what was already right), `## Exam tip` (one line).",
            "- Ground the judgement in the COURSE CONTEXT / expected method; if the student's work isn't actually included in the message, ask them to paste it instead of inventing one.",
        ])
    elif intent == AcademicIntent.PRACTICE_VARIANT_GENERATION:
        lines.extend([
            "- Treat this as PRACTICE-VARIANT generation: produce ONE new exercise of the SAME type as the referenced problem, with DIFFERENT numbers/context and comparable difficulty. Do not just restate the original.",
            "- For a calculation subject use a `**Gegeben:**` / `**Gesucht:**` structure with concrete numeric values and units, and ask for the unknown(s).",
            "- Put the full step-by-step solution in a SEPARATE `## Lösung` section at the very end (so the student can attempt it first); never reveal the result inside the task statement.",
        ])
    elif intent == AcademicIntent.FORMULA_EXTRACTION:
        lines.extend([
            "- Treat this as FORMULA EXTRACTION: list the formulas the SOURCE actually contains as a compact Formelsammlung — do NOT write prose explanations or solve anything.",
            "- For each formula give: the formula (copied EXACTLY from the source — same symbols, same numerator/denominator), its variables with units, and a short 'used for / condition' note.",
            "- NEVER invent or guess a formula that is not in the retrieved source. If a needed formula isn't present, say so rather than fabricating it.",
        ])
    elif intent == AcademicIntent.FORMULA_EXPLANATION:
        lines.extend([
            "- Treat this as explaining ONE formula. Use this structure: `## Formula` (state it exactly as in the source), `## Meaning` (what it computes, in one or two sentences), `## Variables` (each symbol with its meaning and unit), `## When to use it` (and the condition/assumption it needs), `## Common mistake`, `## Mini example` (a short worked numeric example).",
            "- Only DERIVE the formula if the source actually shows the derivation; if the source merely states it, say so and explain/apply it instead of inventing a derivation. Never invent variables or a formula the source doesn't contain.",
        ])
    elif intent == AcademicIntent.EXAM_PRIORITY_LIST:
        lines.extend([
            "- Treat this as an EXAM-PRIORITY request: rank what to focus on, do not write a timed schedule. Use `## Must know`, `## Should know`, `## Nice to know`, and `## Likely question types`, grounded in the selected course material (topics the sources emphasise / repeat / build on).",
            "- Be specific to the actual sources — name the real topics, formulas and processes — not generic exam advice. If you can't tell what's emphasised from the material, say so.",
        ])
    elif intent == AcademicIntent.SOURCE_FINDING:
        lines.extend([
            "- Treat this as a SOURCE-FINDING request: the student wants WHERE something is, not a full explanation. Answer with the exact file name and the page/section/`[Source N]` where it appears, plus a SHORT quote or one-line summary of the relevant part.",
            "- Keep it brief — do NOT generate a long explanation unless the student also asked for one. If it isn't in the selected sources, say so plainly instead of guessing a location.",
        ])
    elif intent == AcademicIntent.FLASHCARD_GENERATION:
        lines.append("- Treat this as flashcard generation: use compact front/back cards grounded in the provided material.")
    elif intent == AcademicIntent.MIXED_MATH_AND_CONCEPT:
        lines.append("- Treat this as mixed concept plus calculation: explain the idea briefly, then solve the numeric/formula part if context permits.")
    elif intent == AcademicIntent.MATH_PROBLEM:
        lines.append("- Treat this as a calculation/solving request only if the needed problem statement and calculation data are available.")
    else:
        lines.append("- Treat this as general university course Q&A; adapt to the student's major and the retrieved source type.")

    if intent_allows_missing_input(intent):
        lines.append("- `minallo-input` is permitted only for missing numeric input values needed to finish this calculation.")
    else:
        lines.append("- Never emit `minallo-input` for this request; ask a normal clarifying question only if needed.")

    return "\n".join(lines)


__all__ = (
    "AcademicIntent",
    "PROFESSOR_STYLE_INSTRUCTION",
    "chitchat_answer",
    "classify_academic_intent",
    "intent_allows_missing_input",
    "intent_is_math_like",
    "intent_style_instruction",
    "is_non_academic_chitchat",
    "wants_per_source_coverage",
    "wants_professor_style",
)
