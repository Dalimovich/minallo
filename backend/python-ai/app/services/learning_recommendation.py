"""Deterministic explanation planning and Deep Learn recommendations.

The model writes the answer; this module owns the product decision.  Keeping
the recommendation structured prevents invented buttons, unsupported claims
about a learner, and recommendation text leaking into course citations.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class ExplanationDepth(str, Enum):
    BRIEF = "brief"
    NORMAL = "normal"
    DETAILED = "detailed"
    DEEP = "deep"


class DeepLearnReasonCode(str, Enum):
    USER_REQUESTED_DETAILED_EXPLANATION = "user_requested_detailed_explanation"
    CONCEPT_COMPLEXITY = "concept_complexity"
    MULTIPLE_PREREQUISITES = "multiple_prerequisites"
    REPEATED_CLARIFICATION = "repeated_clarification"
    INCORRECT_ATTEMPT = "incorrect_attempt"
    LOW_MASTERY = "low_mastery"
    FAILED_SELF_CHECK = "failed_self_check"
    EXAM_RELEVANT_TOPIC = "exam_relevant_topic"
    MULTI_STEP_METHOD = "multi_step_method"
    VISUAL_TOPIC = "visual_topic"
    USER_CONFUSION_STATEMENT = "user_confusion_statement"


_EXPLAIN_RE = re.compile(
    r"\b(explain|why|how did|what does .{0,80} mean|step[ -]?by[ -]?step|"
    r"give (?:me )?an example|visuali[sz]e|make this clearer|erkl[aä]r(?:e| mir)?|"
    r"warum|wie kommt man darauf|schritt f[uü]r schritt|gib mir ein beispiel)\b",
    re.IGNORECASE,
)
_CONFUSION_RE = re.compile(
    r"\b(i (?:do not|don't|dont) understand|i(?:'m| am) confused|doesn(?:'t|t) make sense|"
    r"ich verstehe (?:das|es) nicht|ich bin verwirrt|noch einfacher)\b",
    re.IGNORECASE,
)
_DEEP_RE = re.compile(
    r"\b(full derivation|derive|in depth|deep(?:ly)?|ausf[uü]hrlich|herleit(?:e|ung))\b",
    re.IGNORECASE,
)
_QUICK_RE = re.compile(r"\b(brief|quick(?:ly)?|one sentence|kurz|knapp)\b", re.IGNORECASE)
_MULTI_STEP_RE = re.compile(
    r"\b(process|procedure|method|calculate|deriv|stages?|steps?|verfahren|ablauf|"
    r"berechn|herleit|vorgehen|prozess)\b",
    re.IGNORECASE,
)
_VISUAL_RE = re.compile(
    r"\b(diagram|figure|image|graph|table|visual|geometry|cross[ -]?section|material flow|"
    r"abbildung|schaubild|grafik|tabelle|bild|querschnitt|werkstofffluss)\b",
    re.IGNORECASE,
)
_ADMIN_RE = re.compile(
    r"\b(deadline|upload|login|subscription|account|folder|anmeld|hochladen|konto)\b", re.IGNORECASE
)
_TRIVIAL_RE = re.compile(
    r"^\s*(hi|hello|hey|hallo|danke|thanks|translate|übersetze)\b", re.IGNORECASE
)


@dataclass(frozen=True)
class ExplanationPlan:
    topic: str
    depth: ExplanationDepth
    answer_intents: list[str]
    explanation_requested: bool
    prerequisite_topics: list[str] = field(default_factory=list)
    include_definition: bool = True
    include_intuition: bool = True
    include_step_by_step: bool = False
    include_example: bool = True
    include_formula_breakdown: bool = False
    include_assumptions: bool = False
    include_common_mistakes: bool = False
    include_exam_tip: bool = False
    include_visual_aids: bool = False

    def to_api(self) -> dict[str, Any]:
        data = asdict(self)
        data["depth"] = self.depth.value
        return data

    def prompt_overlay(self) -> str:
        blocks = []
        for name, enabled in (
            ("definition", self.include_definition),
            ("intuition", self.include_intuition),
            ("step-by-step explanation", self.include_step_by_step),
            ("worked example", self.include_example),
            ("formula symbols and assumptions", self.include_formula_breakdown),
            ("common mistakes", self.include_common_mistakes),
            ("exam relevance", self.include_exam_tip),
        ):
            if enabled:
                blocks.append(name)
        return (
            "\nPEDAGOGICAL EXPLANATION PLAN (server-owned):\n"
            f"- Topic: {self.topic}\n- Depth: {self.depth.value}\n"
            f"- Include when useful: {', '.join(blocks)}.\n"
            "- Answer directly first, then teach the concept coherently. "
            "Do not claim the student is weak or confused unless the plan records that signal.\n"
        )


def _topic_from_question(question: str) -> str:
    text = re.sub(r"\s+", " ", question).strip(" ?.!")
    text = re.sub(
        r"^(?:please\s+)?(?:can you\s+)?(?:explain|describe|define|what is|what are|"
        r"why is|why does|how does|how do|erkl[aä]r(?:e| mir)?|was ist|was sind|wie funktioniert)\s+",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.split(
        r"\b(?:in detail|step[ -]?by[ -]?step|ausf[uü]hrlich)\b",
        text,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    words = text.split()
    return " ".join(words[:14]).strip(" ,:;-") or "this course topic"


def build_explanation_plan(
    question: str,
    *,
    weak_topics: list[str] | None = None,
    previous_turns: list[dict[str, str]] | None = None,
    has_selected_region: bool = False,
    has_page_image: bool = False,
) -> ExplanationPlan:
    explicit = bool(_EXPLAIN_RE.search(question))
    confusion = bool(_CONFUSION_RE.search(question))
    multi_step = bool(_MULTI_STEP_RE.search(question))
    visual = bool(_VISUAL_RE.search(question) or has_selected_region)
    topic = _topic_from_question(question)
    repetitions = sum(
        1
        for turn in (previous_turns or [])
        if turn.get("role") == "user" and topic.lower() in turn.get("text", "").lower()
    )
    intents = ["direct_answer"]
    if explicit or confusion or multi_step:
        intents.append("detailed_explanation")
    if multi_step:
        intents.append("process_explanation")
    if visual:
        intents.append("diagram_interpretation" if has_selected_region else "visual_explanation")
    if confusion:
        intents.append("prerequisite_repair")
    depth = ExplanationDepth.NORMAL
    if _QUICK_RE.search(question):
        depth = ExplanationDepth.BRIEF
    elif _DEEP_RE.search(question) or repetitions >= 2:
        depth = ExplanationDepth.DEEP
    elif explicit or confusion or multi_step:
        depth = ExplanationDepth.DETAILED
    weak_match = next(
        (item for item in (weak_topics or []) if item.lower() in question.lower()), None
    )
    if weak_match and "deep_learn_recommendation" not in intents:
        intents.append("deep_learn_recommendation")
    return ExplanationPlan(
        topic=topic,
        depth=depth,
        answer_intents=intents,
        explanation_requested=explicit,
        include_step_by_step=multi_step
        or depth in {ExplanationDepth.DETAILED, ExplanationDepth.DEEP},
        include_formula_breakdown=bool(
            re.search(r"[=λµσεν]|formula|equation|gleichung|formel", question, re.IGNORECASE)
        ),
        include_assumptions=multi_step,
        include_common_mistakes=depth in {ExplanationDepth.DETAILED, ExplanationDepth.DEEP},
        include_exam_tip=bool(re.search(r"exam|klausur|prüfung", question, re.IGNORECASE)),
        include_visual_aids=visual or (has_page_image and multi_step),
    )


def build_learning_recommendations(
    plan: ExplanationPlan,
    *,
    course_id: str | None,
    document_ids: list[str] | None,
    source_chunk_ids: list[str] | None,
    visual_ids: list[str] | None = None,
    weak_topics: list[str] | None = None,
    previous_turns: list[dict[str, str]] | None = None,
    response_language: str | None = None,
) -> list[dict[str, Any]]:
    if not course_id or _ADMIN_RE.search(plan.topic) or _TRIVIAL_RE.search(plan.topic):
        return []
    weak_match = next(
        (item for item in (weak_topics or []) if item.lower() in plan.topic.lower()), None
    )
    repetitions = sum(
        1
        for turn in (previous_turns or [])
        if turn.get("role") == "user" and plan.topic.lower() in turn.get("text", "").lower()
    )
    if weak_match:
        reason = DeepLearnReasonCode.LOW_MASTERY
        reason_text = "Your recorded practice results indicate that a guided lesson on this topic may be useful."
        confidence, priority = 0.9, "high"
    elif "prerequisite_repair" in plan.answer_intents:
        reason = DeepLearnReasonCode.USER_CONFUSION_STATEMENT
        reason_text = (
            "A guided lesson can rebuild the prerequisite ideas and then return to this question."
        )
        confidence, priority = 0.9, "high"
    elif repetitions >= 2:
        reason = DeepLearnReasonCode.REPEATED_CLARIFICATION
        reason_text = "This concept has come up repeatedly, so a structured lesson may help connect the pieces."
        confidence, priority = 0.86, "high"
    elif plan.depth == ExplanationDepth.DEEP:
        reason = DeepLearnReasonCode.USER_REQUESTED_DETAILED_EXPLANATION
        reason_text = "This topic benefits from a guided lesson with examples and self-checks."
        confidence, priority = 0.82, "medium"
    elif "process_explanation" in plan.answer_intents:
        reason = DeepLearnReasonCode.MULTI_STEP_METHOD
        reason_text = "This is a multi-step method, so a guided lesson could help you practise the complete sequence."
        confidence, priority = 0.76, "medium"
    elif plan.include_visual_aids:
        reason = DeepLearnReasonCode.VISUAL_TOPIC
        reason_text = "A guided lesson can connect the visual structure to the underlying concept."
        confidence, priority = 0.72, "medium"
    elif plan.depth == ExplanationDepth.DETAILED:
        reason = DeepLearnReasonCode.CONCEPT_COMPLEXITY
        reason_text = "This topic has several connected ideas, so a guided lesson could help consolidate them."
        confidence, priority = 0.68, "low"
    else:
        return []
    topic = plan.topic
    digest = hashlib.sha256(f"{course_id}:{topic.lower()}:{reason.value}".encode()).hexdigest()[:16]
    is_de = str(response_language or "").lower().startswith("de")
    return [
        {
            "id": f"deep-learn-{digest}",
            "kind": "deep_learn",
            "topic": topic,
            "displayTopic": topic,
            "reasonCode": reason.value,
            "reasonText": reason_text,
            "confidence": confidence,
            "priority": priority,
            "courseId": course_id,
            "documentIds": list(dict.fromkeys(document_ids or [])),
            "sourceChunkIds": list(dict.fromkeys(source_chunk_ids or [])),
            "visualIds": list(dict.fromkeys(visual_ids or [])),
            "lessonMode": "professor" if priority == "high" else "simple",
            "lessonLanguage": "de" if is_de else "en",
            "prerequisites": plan.prerequisite_topics,
            "learningGoals": [f"Explain {topic}", f"Apply {topic} to a course example"],
            "action": {
                "label": ("Deep Learn starten: " if is_de else "Start Deep Learn: ") + topic,
                "type": "open_deep_learn",
            },
        }
    ]


__all__ = (
    "DeepLearnReasonCode",
    "ExplanationDepth",
    "ExplanationPlan",
    "build_explanation_plan",
    "build_learning_recommendations",
)
