"""Deterministic dialogue interpretation for multi-turn tutoring.

The retrieval query must represent what a short follow-up means in the current
conversation, not merely repeat its literal words.  This module intentionally
handles the high-risk repair/navigation acts before retrieval and leaves broad
academic intent classification to ``answer_intent``.
"""

from __future__ import annotations

import re
import json
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class DialogueAct(str, Enum):
    NEW_QUESTION = "new_question"
    CONTINUE_NEXT_QUESTION = "continue_next_question"
    CORRECT_ASSISTANT = "correct_assistant"
    REJECT_ANSWER = "reject_answer"
    RETRY_PREVIOUS_REQUEST = "retry_previous_request"
    REQUEST_TRANSLATION = "request_translation"
    REQUEST_SIMPLIFICATION = "request_simplification"
    REQUEST_MORE_DETAIL = "request_more_detail"
    ASK_ABOUT_PREVIOUS_STEP = "ask_about_previous_step"
    VERIFY_PREVIOUS_ANSWER = "verify_previous_answer"
    ANSWER_ALL_REQUESTED = "answer_all_requested"
    REQUEST_HINT = "request_hint"
    REQUEST_OVERVIEW = "request_overview"
    CHECK_ANSWER = "check_answer"
    REQUEST_RESULT_ONLY = "request_result_only"
    REQUEST_FIRST_STEP = "request_first_step"
    CONTINUE_FROM_STEP = "continue_from_step"
    REUSE_VERIFIED_RESULT = "reuse_verified_result"
    GENERAL_CONVERSATION = "general_conversation"


class ConversationIntent(str, Enum):
    NEW_QUESTION = "new_question"
    FOLLOW_UP_EXPLANATION = "follow_up_explanation"
    FOLLOW_UP_WHY = "follow_up_why"
    FOLLOW_UP_DERIVATION = "follow_up_derivation"
    FOLLOW_UP_EXAMPLE = "follow_up_example"
    FOLLOW_UP_CORRECTION = "follow_up_correction"
    FOLLOW_UP_REFERENCE = "follow_up_reference"


class TurnRelation(str, Enum):
    NEW_TOPIC = "new_topic"
    CONTINUATION = "continuation"
    ANSWER_TO_ASSISTANT = "answer_to_assistant"
    CLARIFICATION = "clarification"
    CORRECTION = "correction"
    REJECTION = "rejection"
    CONFIRMATION = "confirmation"
    DELEGATION = "delegation"
    AMBIGUOUS = "ambiguous"


class SpeechAct(str, Enum):
    QUESTION = "question"
    TASK_REQUEST = "task_request"
    SOCIAL = "social"
    ANSWER = "answer"
    CONFIRMATION = "confirmation"
    REJECTION = "rejection"
    CLARIFICATION_REQUEST = "clarification_request"
    DELEGATION = "delegation"


class TaskFamily(str, Enum):
    EXPLAIN = "explain"
    SOLVE = "solve"
    CALCULATE = "calculate"
    DERIVE = "derive"
    COMPARE = "compare"
    SUMMARIZE = "summarize"
    EXTRACT = "extract"
    STUDY_RECOMMENDATION = "study_recommendation"
    STUDY_PLAN = "study_plan"
    QUIZ = "quiz"
    FLASHCARDS = "flashcards"
    EXAMFORGE = "examforge"
    DEEP_LEARN = "deep_learn"
    GENERAL_ASSISTANCE = "general_assistance"
    CONVERSATION = "conversation"
    UNKNOWN = "unknown"


class EvidenceRequirement(str, Enum):
    """What information answering this turn actually needs — independent of
    what the user wants done with it (TaskFamily). ``EXPLAIN`` alone never
    tells you whether that means re-explaining the last answer from the
    conversation, restating a general-knowledge fact, or citing a lecture
    PDF; this is the second, orthogonal question the execution layer needs
    answered before it decides whether retrieval is worth running."""
    CONVERSATION_ONLY = "conversation_only"
    GENERAL_KNOWLEDGE = "general_knowledge"
    REUSE_PRIOR_GROUNDED = "reuse_prior_grounded"
    COURSE_RETRIEVAL = "course_retrieval"
    VISIBLE_PAGE = "visible_page"
    FULL_DOCUMENT = "full_document"
    WEB = "web"


_EXERCISE_RE = re.compile(
    r"\b(?:aufgabe|uebung|übung|task|exercise|problem|question|ex)\s*"
    r"(\d+(?:[.,]\d+){0,3}(?:\s*(?:[.(]\s*)?[a-z]\s*\)?)?)(?!\w)",
    re.IGNORECASE,
)
_BARE_CONTINUATION_RE = re.compile(
    r"^\s*(?:now|next|weiter|jetzt)?\s*"
    r"(\d+(?:[.,]\d+){1,3}[a-z]?)\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_RETRY_RE = re.compile(
    r"^\s*(?:again|retry|try again|start again|nochmal|noch einmal|erneut)\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_TRANSLATION_RE = re.compile(
    r"^\s*(?:(?:answer|reply|write|explain|say|repeat)(?:\s+it)?\s+)?"
    r"(?:in|auf)\s+(english|german|deutsch|french|fran(?:ç|c)ais|arabic|"
    r"tunisian arabic|spanish|italian)\s*(?:please|pls|bitte)?\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_CORRECTION_RE = re.compile(
    r"^\s*(?:no\b|not\b|nope\b|wrong\b|incorrect\b|actually\b|"
    r"nein\b|nicht\b|falsch\b|doch\b|stimmt nicht\b)",
    re.IGNORECASE,
)
_REJECTION_RE = re.compile(
    r"\b(?:not (?:that|the) (?:one|question)|wrong question|"
    r"you answered the wrong|that is not what i asked|and not the one you answered|"
    r"nicht die aufgabe|falsche aufgabe)\b",
    re.IGNORECASE,
)
_SIMPLIFY_RE = re.compile(
    r"^\s*(?:i (?:do not|don't) understand|i'?m confused|explain (?:it|that) "
    r"(?:simply|again)|simpler|verstehe (?:es|das) nicht|ich verstehe nicht)\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_DETAIL_RE = re.compile(
    r"\b(?:in detail|more detail|step by step|detailed|ausf(?:ü|ue)hrlich|"
    r"schritt f(?:ü|ue)r schritt)\b",
    re.IGNORECASE,
)
_PREVIOUS_STEP_RE = re.compile(
    r"\b(?:explain (?:this|that|the) (?:step|formula|equation|result|point)|"
    r"where did|where does (?:this|that) come from|how did we get (?:this|that|\d+)|"
    r"why(?: (?:did|is|does))?|what does .* mean|the (?:first|second|third|previous) "
    r"(?:step|point|formula|result)|woher (?:kommt|kam)|warum|wie kommt man darauf|"
    r"erkl[aÃ¤]r(?:e)? (?:diesen|diese|das|den)|was bedeutet|der (?:erste|zweite|dritte) "
    r"(?:schritt|punkt))\b",
    re.IGNORECASE,
)
_VERIFY_RE = re.compile(
    r"^\s*(?:are you sure|is that correct|verify (?:it|that)|"
    r"bist du sicher|stimmt das)\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_ALL_RE = re.compile(
    r"^\s*(?:all|all of them|everything|alle|alle davon)\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_HINT_RE = re.compile(
    r"\b(?:hint|clue|small tip|tipp|hinweis|indice)\b",
    re.IGNORECASE,
)
_OVERVIEW_RE = re.compile(
    r"\b(?:overview|summary only|high[- ]level|überblick|ueberblick|aperçu|apercu)\b",
    re.IGNORECASE,
)
_CHECK_RE = re.compile(
    r"\b(?:check my (?:answer|work|calculation)|is my answer|"
    r"prüf(?:e)? meine|pruef(?:e)? meine|kontrollier(?:e)?)\b",
    re.IGNORECASE,
)
_RESULT_ONLY_RE = re.compile(
    r"\b(?:result|answer|final value|ergebnis|antwort|résultat|resultat)\s+only\b"
    r"|\b(?:only|just|nur)\s+(?:the\s+)?(?:result|answer|final value|ergebnis|antwort)\b",
    re.IGNORECASE,
)
_FIRST_STEP_RE = re.compile(
    r"\b(?:only|just|nur)\s+(?:the\s+)?first\s+step\b"
    r"|\b(?:erster|erste[nr]?)\s+schritt\s+(?:only|nur)\b",
    re.IGNORECASE,
)
_CONTINUE_STEP_RE = re.compile(
    r"^\s*(?:now\s+)?continue(?:\s+from\s+(?:this|that|the)\s+line)?"
    r"|^\s*(?:weiter|mach weiter)(?:\s+ab\s+(?:dieser|der)\s+zeile)?",
    re.IGNORECASE,
)
_REUSE_RE = re.compile(
    r"\b(?:use|reuse|with|using|verwende|benutze|nimm)\s+"
    r"(?:the\s+)?(?:(?:previous|earlier|verified|vorherige[nr]?|bestätigte[nr]?)\s+){1,3}"
    r"(?:result|answer|value|ergebnis|wert)\b",
    re.IGNORECASE,
)
_BARE_REACTION_RE = re.compile(
    r"^\s*(?:what|huh|really|seriously|wtf)\s*[?!]*\s*$",
    re.IGNORECASE,
)
_ACADEMIC_ASSISTANT_RE = re.compile(
    r"(?:[=≈≤≥]|\b(?:formula|equation|exercise|problem|theorem|calculation|"
    r"aufgabe|formel|gleichung|berechnung)\b)",
    re.IGNORECASE,
)
_MISROUTED_REFERENCE_REPLY_RE = re.compile(
    r"cannot reliably identify the marked question|please open that page|select the question area",
    re.IGNORECASE,
)
_SUBSTITUTION_CONFUSION_RE = re.compile(
    r"\b(?:understand|verstehe|comprends?).{0,50}\b(?:not|nicht|pas)\b.{0,30}"
    r"\b(?:substitution|einsetzen|einsetzung)\b"
    r"|\b(?:not|nicht|pas)\b.{0,30}\b(?:substitution|einsetzen|einsetzung)\b",
    re.IGNORECASE,
)

# Evidence-requirement signals: what a message needs answered from, as
# opposed to what it wants done (TaskFamily). These are deliberately
# narrower/high-confidence — anything not matched falls through to
# provenance-based reasoning in resolve_evidence_requirement rather than
# being force-fit into one of these buckets.
#
# SOURCE (where the evidence comes from) and FRESHNESS (whether existing
# evidence may be reused or must be re-checked) are separate questions.
# "Are you sure?" never names a source — it demands freshness and inherits
# whatever source the previous answer already used (general knowledge stays
# general, a course-grounded answer gets re-verified against the course).
# Only wording that actually NAMES a source ("according to my professor",
# "verify that against my PDF") overrides that inherited source.
_EXPLICIT_WEB_EVIDENCE_RE = re.compile(
    r"\b(?:search (?:the )?(?:web|internet|online)|look (?:it |that )?up online|"
    r"current(?:ly)?|today|latest|recent(?:ly)?|"
    r"suche (?:im internet|online)|aktuell|heute|neueste)\b",
    re.IGNORECASE,
)
_EXPLICIT_COURSE_SOURCE_RE = re.compile(
    r"\b(?:according to (?:my|the) (?:professor|lecture|course|script|slides?|pdf)|"
    r"my (?:professor|lecture|course|script|slides?)|"
    r"which page|exact (?:page|citation|formula|quote)|"
    r"where (?:does|did) (?:the|my) (?:professor|lecture|script) say|"
    r"verify (?:that|this|it) against (?:my|the|our) "
    r"(?:pdf|lecture|course|script|slides?|professor|notes?)|"
    r"show me the (?:exact|precise) (?:page|formula|source)|"
    r"wo genau (?:steht|sagt)|welche seite)\b",
    re.IGNORECASE,
)
# Freshness only — none of these name a source, so they must inherit
# whatever the previous answer was actually grounded in rather than forcing
# course retrieval onto a plain general-knowledge exchange.
_FRESH_VERIFICATION_RE = re.compile(
    r"\b(?:are you sure|is that correct|is that right|"
    r"i think (?:that'?s|your answer is|this is) wrong|that'?s wrong|"
    r"i don'?t think that'?s (?:right|correct)|"
    r"verify (?:it|that|this)\b|double[- ]check|"
    r"bist du sicher|stimmt das)\b",
    re.IGNORECASE,
)
_REFERENCES_PREVIOUS_ANSWER_RELATIONS = {
    TurnRelation.CONTINUATION,
    TurnRelation.ANSWER_TO_ASSISTANT,
    TurnRelation.CLARIFICATION,
    TurnRelation.CORRECTION,
    TurnRelation.REJECTION,
    TurnRelation.CONFIRMATION,
}
# A correction/rejection ("no, I don't think that's right") demands fresh
# evidence the same way explicit verification wording does, even when it
# doesn't match _FRESH_VERIFICATION_RE's literal phrasing — the semantic
# resolver assigns these relations for exactly this kind of pushback.
_FRESH_EVIDENCE_RELATIONS = {TurnRelation.CORRECTION, TurnRelation.REJECTION}
_EVIDENCE_SKIPS_RETRIEVAL = {
    EvidenceRequirement.CONVERSATION_ONLY,
    EvidenceRequirement.GENERAL_KNOWLEDGE,
    EvidenceRequirement.REUSE_PRIOR_GROUNDED,
}
# Acts that are inherently about verifying, correcting, or continuing exact
# prior work — a paraphrase of the previous answer can never satisfy them,
# so they always demand FRESH evidence. Which SOURCE that evidence comes
# from is still inherited from the previous answer's own provenance (see
# resolve_evidence_requirement's requires_fresh_evidence parameter) rather
# than assumed to be the course.
_VERIFICATION_SENSITIVE_ACTS = {
    DialogueAct.VERIFY_PREVIOUS_ANSWER, DialogueAct.CHECK_ANSWER,
    DialogueAct.CORRECT_ASSISTANT, DialogueAct.REJECT_ANSWER,
    DialogueAct.RETRY_PREVIOUS_REQUEST, DialogueAct.ANSWER_ALL_REQUESTED,
    DialogueAct.REQUEST_RESULT_ONLY, DialogueAct.REQUEST_FIRST_STEP,
    DialogueAct.CONTINUE_FROM_STEP, DialogueAct.REUSE_VERIFIED_RESULT,
}


def _previous_answer_provenance(turns: list[dict[str, Any]]) -> dict[str, str] | None:
    """The routing metadata the previous assistant turn was actually
    generated with, when the caller attached it (see PreviousTurn on the
    router). Returns None for legacy/plain {role, text} turns so callers can
    fall back to a safe default instead of assuming a shape that isn't there."""
    for turn in reversed(turns or []):
        if (turn.get("role") or "").lower() != "assistant":
            continue
        grounding_mode = turn.get("groundingMode") or turn.get("grounding_mode")
        answer_mode = turn.get("answerMode") or turn.get("answer_mode")
        source_scope = turn.get("sourceScope") or turn.get("source_scope")
        if not (grounding_mode or answer_mode or source_scope):
            return None
        return {
            "grounding_mode": str(grounding_mode or ""),
            "answer_mode": str(answer_mode or ""),
            "source_scope": str(source_scope or ""),
        }
    return None


def resolve_evidence_requirement(
    message: str, *, relation: TurnRelation, continues_previous_goal: bool,
    previous_turns: list[dict[str, Any]] | None = None,
    requires_fresh_evidence: bool = False,
) -> EvidenceRequirement:
    """What information answering this turn actually needs, and from where —
    independent of what the user wants done with it (TaskFamily says WHAT,
    this says WHERE FROM). Source and freshness are separate questions:
    "are you sure?" never names a source, it demands a fresh check using
    whatever source the previous answer already used (general knowledge
    stays general, a course-grounded answer gets re-verified against the
    course) — it must not be read as an implicit request to search course
    material that was never involved. Only wording that actually NAMES a
    source in the CURRENT message (explicit web/course phrasing) overrides
    that inherited source; requires_fresh_evidence lets a caller that has
    already classified the act (e.g. resolve_dialogue's verification/
    correction acts, or a CORRECTION/REJECTION relation) force a fresh
    check without pretending it named a source either."""
    text = message or ""
    if _EXPLICIT_WEB_EVIDENCE_RE.search(text):
        return EvidenceRequirement.WEB
    if _EXPLICIT_COURSE_SOURCE_RE.search(text):
        return EvidenceRequirement.COURSE_RETRIEVAL
    wants_fresh_check = (
        requires_fresh_evidence
        or relation in _FRESH_EVIDENCE_RELATIONS
        or bool(_FRESH_VERIFICATION_RE.search(text))
    )
    references_previous_answer = (
        continues_previous_goal or relation in _REFERENCES_PREVIOUS_ANSWER_RELATIONS
    )
    if references_previous_answer or wants_fresh_check:
        provenance = _previous_answer_provenance(previous_turns or [])
        if provenance is None:
            # No recorded provenance (legacy turn, or an older persisted
            # section). Fall back to the same academic-content heuristic
            # resolve_dialogue already uses for bare reactions: a formula/
            # exercise-laden exchange is worth re-grounding, an ordinary
            # conversational one is safest reused/re-affirmed as general
            # knowledge. Check the USER's turn too, not just the reply — an
            # exercise request ("Solve Aufgabe 12.2") establishes academic
            # context even when the assistant's own reply was generic
            # ("I am missing context").
            last_assistant = _latest_turn(previous_turns or [], "assistant")
            last_user = _latest_turn(previous_turns or [], "user")
            if (
                (last_assistant and _ACADEMIC_ASSISTANT_RE.search(last_assistant))
                or (last_user and _ACADEMIC_ASSISTANT_RE.search(last_user))
            ):
                return EvidenceRequirement.COURSE_RETRIEVAL
            return (
                EvidenceRequirement.GENERAL_KNOWLEDGE if wants_fresh_check
                else EvidenceRequirement.CONVERSATION_ONLY
            )
        if provenance["grounding_mode"] == "web" or provenance["source_scope"] == "internet":
            return EvidenceRequirement.WEB if wants_fresh_check else EvidenceRequirement.CONVERSATION_ONLY
        was_general = provenance["grounding_mode"] in {"", "general"} or provenance["source_scope"] in {
            "", "general_knowledge",
        }
        if was_general:
            return (
                EvidenceRequirement.GENERAL_KNOWLEDGE if wants_fresh_check
                else EvidenceRequirement.CONVERSATION_ONLY
            )
        return EvidenceRequirement.COURSE_RETRIEVAL if wants_fresh_check else EvidenceRequirement.REUSE_PRIOR_GROUNDED
    # A genuinely new topic: preserve the existing auto-mode default of
    # letting retrieval run so the post-retrieval relevance gate can decide,
    # rather than pre-judging "general knowledge" before evidence is checked.
    #
    # KNOWN GAP: this makes evidence resolution non-authoritative for new
    # topics specifically — it hands STANDARD_RAG the same "try it, then
    # judge" default source_router.classify_source_scope uses for AUTO mode,
    # but execution_router picks its LANE upfront, before any retrieval
    # result exists to judge. A self-contained medium-complexity general
    # question ("help me decide whether studying in the morning or evening
    # suits me better") with no course wording therefore still gets a
    # preliminary STANDARD_RAG lane rather than FAST_GENERAL, even though
    # classify_task_profile's own `course` signal correctly stays False.
    # This is deliberately NOT patched with a general-question phrase list
    # (source_router's own comment explains why that under-covers real
    # questions) — the two acceptable fixes are making source resolution run
    # BEFORE lane selection, or recomputing the execution plan once source
    # scope is known, and both are real pipeline-ordering changes, not a
    # one-line rule. In the meantime this is a latency/architecture-purity
    # issue rather than a correctness one: source_router's post-retrieval
    # gate still downgrades an empty course search to general knowledge, and
    # stream.py's deferred-pipeline exception handler retries once as
    # FAST_CONTEXTUAL (never surfacing a misleading "grounded" failure) for
    # exactly this shape of request — see
    # test_medium_complexity_general_question_in_course_chat_stays_correct
    # and test_medium_complexity_general_question_failure_recovers_gracefully
    # in test_conversational_evidence_resolution.py.
    return EvidenceRequirement.COURSE_RETRIEVAL


_LANGUAGE_CODES = {
    "english": "en",
    "german": "de",
    "deutsch": "de",
    "french": "fr",
    "français": "fr",
    "francais": "fr",
    "arabic": "ar",
    "tunisian arabic": "ar",
    "spanish": "es",
    "italian": "it",
}


@dataclass(frozen=True)
class DialogueResolution:
    original_message: str
    dialogue_act: DialogueAct
    resolved_request: str
    active_question: str | None
    previous_question: str | None
    response_language: str
    requires_new_retrieval: bool
    invalidate_previous_answer: bool
    requested_depth: str
    explanation_attempt: int
    conversation_intent: ConversationIntent = ConversationIntent.NEW_QUESTION
    referent_type: str = "unknown"
    referent_text: str | None = None
    relation: TurnRelation = TurnRelation.NEW_TOPIC
    speech_act: SpeechAct = SpeechAct.QUESTION
    task_family: TaskFamily = TaskFamily.UNKNOWN
    continues_previous_goal: bool = False
    confidence: float = 1.0
    evidence_requirement: EvidenceRequirement = EvidenceRequirement.COURSE_RETRIEVAL

    def to_api(self) -> dict[str, Any]:
        data = asdict(self)
        data["dialogue_act"] = self.dialogue_act.value
        data["conversation_intent"] = self.conversation_intent.value
        data["relation"] = self.relation.value
        data["speech_act"] = self.speech_act.value
        data["task_family"] = self.task_family.value
        data["evidence_requirement"] = self.evidence_requirement.value
        return data

    def prompt_overlay(self) -> str:
        return (
            "\nDETERMINISTIC DIALOGUE RESOLUTION (mandatory):\n"
            f"- Dialogue act: {self.dialogue_act.value}\n"
            f"- Resolved request: {self.resolved_request}\n"
            f"- Active question: {self.active_question or 'not established'}\n"
            f"- Response language: {self.response_language}\n"
            f"- Requested depth: {self.requested_depth}\n"
            "- Follow the resolved request without changing its action, exercise, "
            "language, or depth. A current correction outranks every prior assistant "
            "claim. Do not advertise product features or add stock sections that the "
            "student did not request.\n"
        )


def _normalise_label(value: str) -> str:
    raw = value.replace(",", ".").lower().strip()
    raw = re.sub(r"(?<=\d)[.(]\s*([a-z])\)?$", r"\1", raw)
    raw = re.sub(r"\s+", "", raw).rstrip(")")
    match = re.fullmatch(r"(\d+(?:\.\d+){0,3})([a-z]?)", raw)
    if not match:
        return raw
    return ".".join(str(int(part)) for part in match.group(1).split(".")) + match.group(2)


def _labels(text: str) -> list[str]:
    return [_normalise_label(m.group(1)) for m in _EXERCISE_RE.finditer(text or "")]


def _latest_turn(
    turns: list[dict[str, str]], role: str, *, exclude_current: str | None = None,
) -> str | None:
    skipped_current = False
    for turn in reversed(turns):
        if (turn.get("role") or "").lower() != role:
            continue
        text = (turn.get("text") or "").strip()
        if not text:
            continue
        if exclude_current and not skipped_current and text == exclude_current.strip():
            skipped_current = True
            continue
        return text
    return None


def _active_questions(message: str, turns: list[dict[str, str]]) -> tuple[str | None, str | None]:
    current = _labels(message)
    user_labels: list[str] = []
    assistant_labels: list[str] = []
    for turn in reversed(turns):
        found = _labels(turn.get("text") or "")
        if not found:
            bare = _BARE_CONTINUATION_RE.match(turn.get("text") or "")
            if bare:
                found = [_normalise_label(bare.group(1))]
        if not found:
            continue
        target = (
            user_labels
            if (turn.get("role") or "").lower() == "user"
            else assistant_labels
        )
        target.extend(reversed(found))
    # User-established references outrank labels asserted by the assistant.
    # This prevents the assistant's wrong "12.6" from becoming dialogue state
    # after the student had explicitly asked for "13.6".
    history_labels = [*user_labels, *assistant_labels]
    active = current[-1] if current else (history_labels[0] if history_labels else None)
    previous = None
    for label in history_labels:
        if label != active:
            previous = label
            break
    return active, previous


def _label_confirmed_by_last_turn_pair(
    label: str | None, last_user: str | None, last_assistant: str | None,
) -> bool:
    """Does the immediately preceding user/assistant turn pair actually
    concern `label`, so a correction/rejection may still safely name it?

    Naming the label is safe when the STUDENT's own most recent message
    named it (test_assistants_wrong_label_never_overrides_users_active_
    question: the assistant answered the wrong exercise, but the user's own
    immediately preceding turn still established the real one — user labels
    always outrank the assistant's), or when the assistant's reply itself
    carries the same label. It is unsafe when neither the immediately
    preceding user turn nor the immediately preceding assistant turn
    mentions any exercise label at all — that means the active label is
    left over from further back in history and the conversation has since
    moved to an unlabeled topic (e.g. a plain conceptual question) that the
    correction is actually objecting to.
    """
    if label is None:
        return True
    if last_user and label in _labels(last_user):
        return True
    if last_assistant and label in _labels(last_assistant):
        return True
    return False


def _stale_active_label(active: str | None, text: str, last_user: str | None,
                        last_assistant: str | None) -> bool:
    """Should a correction/rejection avoid naming `active` in its resolved
    request? Only when it was NOT named by the student's current message
    itself (that always wins outright — see
    test_explicit_corrected_question_number_outranks_old_reference) and the
    immediately preceding turn pair gives no evidence it's still what's
    being discussed (see _label_confirmed_by_last_turn_pair)."""
    if active is None:
        return False
    if active in _labels(text):
        return False
    return not _label_confirmed_by_last_turn_pair(active, last_user, last_assistant)


def _explanation_attempt(turns: list[dict[str, str]]) -> int:
    attempts = 0
    for turn in reversed(turns[-8:]):
        if (turn.get("role") or "").lower() != "user":
            continue
        text = turn.get("text") or ""
        if _SIMPLIFY_RE.search(text) or _DETAIL_RE.search(text):
            attempts += 1
        elif attempts:
            break
    return attempts + 1


def resolve_dialogue(
    message: str,
    *,
    previous_turns: list[dict[str, str]] | None = None,
    response_language: str = "en",
) -> DialogueResolution:
    """Resolve navigation, repair, translation and explanation follow-ups."""
    text = (message or "").strip()
    turns = list(previous_turns or [])
    active, previous = _active_questions(text, turns)
    last_user = _latest_turn(turns, "user", exclude_current=text)
    last_assistant = _latest_turn(turns, "assistant")
    act = DialogueAct.NEW_QUESTION
    resolved = text
    retrieve = True
    invalidate = False
    depth = "normal"
    language = response_language
    conversation_intent = ConversationIntent.NEW_QUESTION
    referent_type = "unknown"
    referent_text = None

    translation = _TRANSLATION_RE.match(text)
    continuation = _BARE_CONTINUATION_RE.match(text)
    if translation and last_assistant:
        act = DialogueAct.REQUEST_TRANSLATION
        language = _LANGUAGE_CODES[translation.group(1).casefold()]
        resolved = (
            f"Restate the immediately preceding assistant answer in {language}, "
            "preserving its exact exercise, values, formulas, reasoning and conclusion."
        )
        retrieve = False
    elif _RETRY_RE.match(text) and last_user:
        act = DialogueAct.RETRY_PREVIOUS_REQUEST
        resolved = f"Retry the previous request without changing it: {last_user}"
        retrieve = True
    elif _REJECTION_RE.search(text):
        act = DialogueAct.REJECT_ANSWER
        invalidate = True
        if _stale_active_label(active, text, last_user, last_assistant):
            active = None
        resolved = (
            f"The previous answer was rejected. Re-resolve and answer "
            f"{('exercise ' + active) if active else 'the immediately previous answer'}; "
            f"the student's correction is: {text}"
        )
    elif _CORRECTION_RE.match(text):
        act = DialogueAct.CORRECT_ASSISTANT
        invalidate = True
        if _stale_active_label(active, text, last_user, last_assistant):
            active = None
        resolved = (
            f"Correct the immediately previous answer about "
            f"{('exercise ' + active) if active else 'the immediately previous answer'} using "
            f"fresh exact evidence. Student correction: {text}"
        )
    elif continuation:
        active = _normalise_label(continuation.group(1))
        act = DialogueAct.CONTINUE_NEXT_QUESTION
        resolved = f"Continue in the same tutoring workflow and answer exercise {active}."
    elif _SIMPLIFY_RE.match(text) and last_assistant:
        act = DialogueAct.REQUEST_SIMPLIFICATION
        depth = "first_time_learner"
        resolved = (
            f"Explain the last discussed step of exercise {active or 'the active question'} "
            "more simply, using a different teaching strategy."
        )
    elif _DETAIL_RE.search(text) and last_assistant:
        act = DialogueAct.REQUEST_MORE_DETAIL
        depth = "detailed"
        conversation_intent = ConversationIntent.FOLLOW_UP_EXPLANATION
        referent_type = "calculation_step"
        referent_text = last_assistant
        resolved = (
            "Explain the most recently discussed calculation step in detail. "
            f"Use the preceding answer and question as the primary referent: {last_user or ''}"
        )
    elif _PREVIOUS_STEP_RE.search(text) and last_assistant and not _FIRST_STEP_RE.search(text):
        act = DialogueAct.ASK_ABOUT_PREVIOUS_STEP
        depth = "brief"
        conversation_intent = (
            ConversationIntent.FOLLOW_UP_WHY
            if re.search(r"\b(?:why|warum)\b", text, re.IGNORECASE)
            else ConversationIntent.FOLLOW_UP_EXPLANATION
        )
        referent_type = "calculation_step"
        referent_text = last_assistant
        resolved = (
            "Resolve the demonstrative reference from the immediately preceding "
            f"assistant answer and user question, then answer it: {text}. "
            "Do not claim the exercise is unspecified and do not ask the student "
            "to repeat context already present in the conversation."
        )
    elif _VERIFY_RE.match(text) and last_assistant:
        act = DialogueAct.VERIFY_PREVIOUS_ANSWER
        resolved = (
            f"Independently verify the immediately previous answer about exercise "
            f"{active or 'the active question'} against the exact active evidence. "
            "Do not rely on the previous assistant answer as evidence."
        )
    elif _ALL_RE.match(text):
        act = DialogueAct.ANSWER_ALL_REQUESTED
        depth = "detailed"
        resolved = (
            f"Solve all requested parts of "
            f"{('exercise group ' + active) if active else 'the active exercise group'} "
            "sequentially and completely. Do not replace the solutions with a topic overview."
        )
    elif _HINT_RE.search(text) and not re.search(r"\b(?:no|without)\s+(?:a\s+)?clue\b", text, re.I):
        act = DialogueAct.REQUEST_HINT
        depth = "one_step"
        resolved = (
            f"Give one bounded hint for exercise {active or 'the active question'}. "
            "Do not reveal the complete solution or final result."
        )
    elif _OVERVIEW_RE.search(text):
        act = DialogueAct.REQUEST_OVERVIEW
        depth = "brief"
        resolved = (
            f"Give only a concise overview of exercise {active or 'the active scope'}, "
            "without silently turning it into a complete solution."
        )
    elif _CHECK_RE.search(text):
        act = DialogueAct.CHECK_ANSWER
        resolved = (
            f"Check the student's answer for exercise {active or 'the active question'} "
            "against verified evidence and identify the first incorrect step."
        )
    elif _RESULT_ONLY_RE.search(text):
        act = DialogueAct.REQUEST_RESULT_ONLY
        depth = "brief"
        resolved = (
            f"Return only the verified final result for exercise "
            f"{active or 'the active question'}, with its unit and no derivation."
        )
    elif _FIRST_STEP_RE.search(text):
        act = DialogueAct.REQUEST_FIRST_STEP
        depth = "one_step"
        resolved = (
            f"Show only the first step for exercise {active or 'the active question'} "
            "and stop before continuing."
        )
    elif _CONTINUE_STEP_RE.search(text) and last_assistant:
        act = DialogueAct.CONTINUE_FROM_STEP
        resolved = (
            f"Continue exercise {active or 'the active question'} from the next "
            "unfinished line in the previous answer. Do not restart."
        )
    elif _REUSE_RE.search(text):
        act = DialogueAct.REUSE_VERIFIED_RESULT
        resolved = (
            f"Continue exercise {active or 'the active question'} using only the "
            "previous result if its provenance is still verified for the same "
            "document revision and exam variant."
        )
    elif _SUBSTITUTION_CONFUSION_RE.search(text):
        act = DialogueAct.REQUEST_SIMPLIFICATION
        depth = "one_step"
        resolved = (
            f"Explain only the substitution step in exercise "
            f"{active or 'the active question'} using verified givens; do not "
            "repeat the formula-selection explanation or complete solution."
        )
    elif _BARE_REACTION_RE.match(text) and last_assistant:
        if (
            _ACADEMIC_ASSISTANT_RE.search(last_assistant)
            and not _MISROUTED_REFERENCE_REPLY_RE.search(last_assistant)
        ):
            act = DialogueAct.ASK_ABOUT_PREVIOUS_STEP
            depth = "brief"
            conversation_intent = ConversationIntent.FOLLOW_UP_EXPLANATION
            referent_type = "previous_answer"
            referent_text = last_assistant
            resolved = "Clarify the immediately preceding academic answer briefly."
        else:
            act = DialogueAct.GENERAL_CONVERSATION
            retrieve = False
            referent_type = "previous_answer"
            referent_text = last_assistant
            resolved = "Acknowledge that the immediately preceding reply was confusing or unrelated."

    relation = TurnRelation.NEW_TOPIC
    speech_act = SpeechAct.QUESTION if "?" in text else SpeechAct.TASK_REQUEST
    if act in {DialogueAct.CORRECT_ASSISTANT}:
        relation, speech_act = TurnRelation.CORRECTION, SpeechAct.ANSWER
    elif act in {DialogueAct.REJECT_ANSWER}:
        relation, speech_act = TurnRelation.REJECTION, SpeechAct.REJECTION
    elif act is not DialogueAct.NEW_QUESTION:
        relation = TurnRelation.CONTINUATION
    task_family = _infer_task_family(text)
    if task_family is TaskFamily.UNKNOWN and relation is not TurnRelation.NEW_TOPIC:
        task_family = _infer_active_task(turns)
    requires_fresh_evidence = act in _VERIFICATION_SENSITIVE_ACTS
    evidence_requirement = resolve_evidence_requirement(
        text, relation=relation,
        continues_previous_goal=relation is not TurnRelation.NEW_TOPIC,
        previous_turns=turns, requires_fresh_evidence=requires_fresh_evidence,
    )
    if not retrieve and not requires_fresh_evidence:
        # An act-specific rule already decided no retrieval is needed
        # (translation, or a bare reaction to non-academic content) —
        # honour that explicit call rather than re-deriving it.
        final_retrieve = False
    else:
        # Verifying, correcting, or continuing exact prior work can never be
        # satisfied by paraphrasing a previous answer — but which SOURCE
        # that fresh check runs against still comes from the previous
        # answer's own provenance (resolve_evidence_requirement, above),
        # not an assumption that it must be the course.
        final_retrieve = evidence_requirement not in _EVIDENCE_SKIPS_RETRIEVAL
    return DialogueResolution(
        original_message=text,
        dialogue_act=act,
        resolved_request=resolved,
        active_question=active,
        previous_question=previous,
        response_language=language,
        requires_new_retrieval=final_retrieve,
        invalidate_previous_answer=invalidate,
        requested_depth=depth,
        explanation_attempt=_explanation_attempt(turns),
        conversation_intent=conversation_intent,
        referent_type=referent_type,
        referent_text=referent_text,
        relation=relation,
        evidence_requirement=evidence_requirement,
        speech_act=speech_act,
        task_family=task_family,
        continues_previous_goal=relation is not TurnRelation.NEW_TOPIC,
    )


_TASK_SIGNALS: tuple[tuple[TaskFamily, re.Pattern[str]], ...] = (
    (TaskFamily.FLASHCARDS, re.compile(r"\bflashcards?|karteikarten\b", re.I)),
    (TaskFamily.QUIZ, re.compile(r"\bquiz(?:zes)?\b", re.I)),
    (TaskFamily.EXAMFORGE, re.compile(r"\bexamforge\b", re.I)),
    (TaskFamily.DEEP_LEARN, re.compile(r"\bdeep\s*learn\b", re.I)),
    (TaskFamily.STUDY_PLAN, re.compile(r"\b(?:plan|schedule|organize)\b.*\b(?:study|revision|exam|learn)|\b(?:study|revision|exam)\b.*\b(?:plan|schedule|organize)\b", re.I)),
    (TaskFamily.STUDY_RECOMMENDATION, re.compile(r"\bwhat\s+should\s+i\s+(?:study|learn|revise)|\bwhere\s+to\s+start\b", re.I)),
    (TaskFamily.CALCULATE, re.compile(r"\b(?:calculate|compute|bestimme|berechne)\b", re.I)),
    (TaskFamily.DERIVE, re.compile(r"\b(?:derive|prove|herleiten|beweisen)\b", re.I)),
    (TaskFamily.SOLVE, re.compile(r"\b(?:solve|l[öo]se)\b", re.I)),
    (TaskFamily.COMPARE, re.compile(r"\b(?:compare|contrast|difference|vergleiche)\b", re.I)),
    (TaskFamily.SUMMARIZE, re.compile(r"\b(?:summari[sz]e|summary|zusammenfass)\w*\b", re.I)),
    (TaskFamily.EXTRACT, re.compile(r"\b(?:extract|collect|extrahiere)\b", re.I)),
    (TaskFamily.EXPLAIN, re.compile(r"\b(?:explain|teach|erkl[äa]r)\w*\b", re.I)),
)


def _infer_task_family(text: str) -> TaskFamily:
    for family, pattern in _TASK_SIGNALS:
        if pattern.search(text or ""):
            return family
    return TaskFamily.UNKNOWN


def _infer_active_task(turns: list[dict[str, str]]) -> TaskFamily:
    for turn in reversed(turns):
        if (turn.get("role") or "").lower() != "user":
            continue
        family = _infer_task_family(turn.get("text") or "")
        if family is not TaskFamily.UNKNOWN:
            return family
    return TaskFamily.UNKNOWN


def _infer_pending_assistant_task(turns: list[dict[str, str]]) -> TaskFamily:
    """Infer an explicitly offered task without treating any mention as pending."""
    assistant = _latest_turn(turns, "assistant") or ""
    if not re.search(
        r"\b(?:want me to|would you like me to|shall i|should i|i can|let me)\b",
        assistant,
        re.IGNORECASE,
    ):
        return TaskFamily.UNKNOWN
    return _infer_task_family(assistant)


def needs_semantic_resolution(message: str, resolution: DialogueResolution,
                              previous_turns: list[dict[str, str]] | None) -> bool:
    """Only ambiguous context-dependent turns pay for semantic classification."""
    standalone = bool(re.match(
        r"^\s*(?:what\s+(?:is|are|was|were)|who\s+(?:is|was)|when\s+(?:is|was|did)|"
        r"where\s+(?:is|are|was)|how\s+(?:many|much)|does\s+|do\s+you\s+know)\b",
        message or "", re.I,
    ))
    return bool(
        previous_turns
        and not standalone
        and resolution.dialogue_act is DialogueAct.NEW_QUESTION
        and resolution.task_family is TaskFamily.UNKNOWN
        and (len((message or "").split()) <= 12 or re.search(r"\b(?:it|that|this|one|same|instead)\b", message, re.I))
    )


def is_pure_social_turn(message: str, resolution: DialogueResolution) -> bool:
    """Return true only when dialogue semantics leave no pending user task.

    Short acknowledgements such as ``sure`` are lexical chitchat in isolation,
    but can confirm an offered study plan, quiz, or other task.  This predicate
    is the single boundary at which the raw social heuristic may run after the
    conversation has been resolved.
    """
    if resolution.task_family not in {TaskFamily.UNKNOWN, TaskFamily.CONVERSATION}:
        return False
    if resolution.continues_previous_goal:
        return False
    if resolution.relation in {
        TurnRelation.CONTINUATION,
        TurnRelation.ANSWER_TO_ASSISTANT,
        TurnRelation.CORRECTION,
        TurnRelation.REJECTION,
        TurnRelation.CONFIRMATION,
        TurnRelation.DELEGATION,
    }:
        return False
    from .answer_intent import is_non_academic_chitchat  # avoid startup cycle
    return is_non_academic_chitchat(message)


def resolve_dialogue_semantically(message: str, *, previous_turns: list[dict[str, str]],
                                  base: DialogueResolution) -> DialogueResolution:
    """Resolve only ambiguous turns with a small structured model call; fail closed."""
    from .answer import chat_completion_params  # local imports avoid startup cycles
    from .openai_client import INTERACTIVE_SUPPORT_TIMEOUT, get_openai_client
    from ..config import get_settings

    frame = {
        "activeTask": _infer_active_task(previous_turns).value,
        "recentTurns": previous_turns[-10:],
        "currentMessage": message,
    }
    system = f"""Classify the current conversational turn. Return JSON only with keys:
relation, speechAct, taskFamily, continuesPreviousGoal, resolvedRequest, confidence.
relation must be one of {[v.value for v in TurnRelation]}; speechAct one of
{[v.value for v in SpeechAct]}; taskFamily one of {[v.value for v in TaskFamily]}.
Explicit current requests override history. A short
reply must be interpreted against the assistant turn it answers. Preserve prior task
and source intent for continuations; mark unrelated self-contained requests new_topic.
Do not include reasoning."""
    try:
        model = get_settings().openai_generate_model
        completion = get_openai_client().chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": json.dumps(frame)}],
            response_format={"type": "json_object"}, timeout=INTERACTIVE_SUPPORT_TIMEOUT,
            **chat_completion_params(model, 220),
        )
        raw = completion.choices[0].message.content if completion.choices else "{}"
        data = json.loads(raw or "{}")
        relation = TurnRelation(str(data.get("relation")))
        speech_act = SpeechAct(str(data.get("speechAct")))
        task_family = TaskFamily(str(data.get("taskFamily")))
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0))))
        if confidence < 0.65:
            # Too unsure to trust taskFamily/continuesPreviousGoal — but the
            # turn was already judged short/context-dependent to get here,
            # so returning the raw lexical `base` (typically NEW_TOPIC) is
            # exactly what routes an ordinary follow-up into RAG. The prior
            # conversation is the safest available evidence for this class
            # of turn regardless of classifier confidence.
            return _safe_conversational_fallback(message, previous_turns, base)
        resolved = str(data.get("resolvedRequest") or message).strip()[:4000]
        inferred_task = _infer_active_task(previous_turns)
        if inferred_task is TaskFamily.UNKNOWN:
            inferred_task = _infer_pending_assistant_task(previous_turns)
        from .answer_intent import is_non_academic_chitchat
        if (
            task_family in {TaskFamily.UNKNOWN, TaskFamily.CONVERSATION}
            and inferred_task is TaskFamily.UNKNOWN
            and is_non_academic_chitchat(message)
        ):
            # A semantic model cannot turn a standalone social acknowledgement
            # into a phantom pending dependency when history contains no task.
            return base
        continues_previous_goal = bool(data.get("continuesPreviousGoal"))
        evidence_requirement = resolve_evidence_requirement(
            message, relation=relation, continues_previous_goal=continues_previous_goal,
            previous_turns=previous_turns,
        )
        return DialogueResolution(
            **{**base.__dict__, "resolved_request": resolved, "relation": relation,
               "speech_act": speech_act, "task_family": task_family,
               "continues_previous_goal": continues_previous_goal,
               "evidence_requirement": evidence_requirement,
               "requires_new_retrieval": evidence_requirement not in _EVIDENCE_SKIPS_RETRIEVAL,
               "confidence": confidence}
        )
    except Exception:
        # Classification unavailability must not erase obvious conversational
        # continuity. This branch is reached only for turns already deemed
        # short/context-dependent (standalone questions never call it).
        return _safe_conversational_fallback(message, previous_turns, base)


def _safe_conversational_fallback(
    message: str, previous_turns: list[dict[str, str]], base: DialogueResolution,
) -> DialogueResolution:
    """Shared fallback for when semantic classification is unavailable or
    too low-confidence to trust. Only called for turns needs_semantic_
    resolution already judged short/context-dependent, so the prior
    assistant turn (when one exists) is always the safest available
    evidence — never a guessed retrieval just because the classifier
    couldn't decide."""
    last_assistant = _latest_turn(previous_turns, "assistant")
    if not last_assistant:
        return base
    relation = (
        TurnRelation.ANSWER_TO_ASSISTANT
        if last_assistant.rstrip().endswith("?")
        else TurnRelation.CONTINUATION
    )
    inherited = _infer_active_task(previous_turns)
    if inherited is TaskFamily.UNKNOWN:
        inherited = _infer_pending_assistant_task(previous_turns)
    evidence_requirement = resolve_evidence_requirement(
        message, relation=relation, continues_previous_goal=True,
        previous_turns=previous_turns,
    )
    return DialogueResolution(
        **{**base.__dict__, "relation": relation, "speech_act": SpeechAct.ANSWER,
           "task_family": inherited, "continues_previous_goal": True,
           "evidence_requirement": evidence_requirement,
           "requires_new_retrieval": evidence_requirement not in _EVIDENCE_SKIPS_RETRIEVAL,
           "confidence": 0.55}
    )


__all__ = ["ConversationIntent", "DialogueAct", "DialogueResolution", "EvidenceRequirement",
           "SpeechAct", "TaskFamily", "TurnRelation", "is_pure_social_turn",
           "needs_semantic_resolution", "resolve_dialogue", "resolve_dialogue_semantically",
           "resolve_evidence_requirement"]
