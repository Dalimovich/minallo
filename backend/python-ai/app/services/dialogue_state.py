"""Deterministic dialogue interpretation for multi-turn tutoring.

The retrieval query must represent what a short follow-up means in the current
conversation, not merely repeat its literal words.  This module intentionally
handles the high-risk repair/navigation acts before retrieval and leaves broad
academic intent classification to ``answer_intent``.
"""

from __future__ import annotations

import re
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
    r"\b(?:where did|why (?:did|is|does)|what does .* mean|"
    r"woher (?:kommt|kam)|warum|was bedeutet)\b",
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
_SUBSTITUTION_CONFUSION_RE = re.compile(
    r"\b(?:understand|verstehe|comprends?).{0,50}\b(?:not|nicht|pas)\b.{0,30}"
    r"\b(?:substitution|einsetzen|einsetzung)\b"
    r"|\b(?:not|nicht|pas)\b.{0,30}\b(?:substitution|einsetzen|einsetzung)\b",
    re.IGNORECASE,
)

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

    def to_api(self) -> dict[str, Any]:
        data = asdict(self)
        data["dialogue_act"] = self.dialogue_act.value
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
        resolved = (
            f"The previous answer was rejected. Re-resolve and answer "
            f"{('exercise ' + active) if active else 'the exact active question'}; "
            f"the student's correction is: {text}"
        )
    elif _CORRECTION_RE.match(text):
        act = DialogueAct.CORRECT_ASSISTANT
        invalidate = True
        resolved = (
            f"Correct the immediately previous answer about "
            f"{('exercise ' + active) if active else 'the active question'} using "
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
        resolved = (
            f"Explain the requested step of exercise {active or 'the active question'} "
            "in detail, tied to the verified givens and professor's work."
        )
    elif _PREVIOUS_STEP_RE.search(text) and last_assistant:
        act = DialogueAct.ASK_ABOUT_PREVIOUS_STEP
        depth = "brief"
        resolved = (
            f"Answer the student's focused question about the previous step in "
            f"exercise {active or 'the active question'}: {text}"
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
    elif _HINT_RE.search(text):
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

    return DialogueResolution(
        original_message=text,
        dialogue_act=act,
        resolved_request=resolved,
        active_question=active,
        previous_question=previous,
        response_language=language,
        requires_new_retrieval=retrieve,
        invalidate_previous_answer=invalidate,
        requested_depth=depth,
        explanation_attempt=_explanation_attempt(turns),
    )


__all__ = ["DialogueAct", "DialogueResolution", "resolve_dialogue"]
