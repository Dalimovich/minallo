"""Intent-driven, topic-aware staged retrieval plans for course questions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Iterable

from ..supabase_client import get_supabase


ROUTING_POLICY_VERSION = "intent-topic-stages-v1"


class AcademicIntent(StrEnum):
    CONCEPTUAL = "conceptual"
    EXPLANATION = "explanation"
    CALCULATION = "calculation"
    EXERCISE_SOLUTION = "exercise_solution"
    DEFINITION = "definition"
    CLASSIFICATION = "classification"
    LIST = "list"
    COMPARISON = "comparison"
    DERIVATION = "derivation"
    EXAM_PREPARATION = "exam_preparation"
    FORMULA_LOOKUP = "formula_lookup"
    VISUAL_INTERPRETATION = "visual_interpretation"
    FOLLOW_UP = "follow_up"


@dataclass(frozen=True)
class TopicDetection:
    primary_topic: str | None
    secondary_topics: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    confidence: float = 0.0
    matched_course_topics: tuple[str, ...] = ()


@dataclass(frozen=True)
class SourceStage:
    stage: int
    document_types: tuple[str, ...]
    chunk_types: tuple[str, ...]
    purpose: str
    required: bool = False
    max_candidates: int = 8


@dataclass(frozen=True)
class QuestionRoutingPlan:
    original_question: str
    intents: tuple[AcademicIntent, ...]
    topic: TopicDetection
    source_stages: tuple[SourceStage, ...]
    required_evidence: tuple[str, ...]
    allow_general_knowledge: bool = True
    allow_web: bool = True
    policy_version: str = ROUTING_POLICY_VERSION

    def trace(self) -> dict:
        return {
            "policyVersion": self.policy_version,
            "intents": [intent.value for intent in self.intents],
            "topic": self.topic.primary_topic,
            "topicConfidence": self.topic.confidence,
            "sourceStages": [{
                "stage": stage.stage,
                "documentTypes": list(stage.document_types),
                "chunkTypes": list(stage.chunk_types),
                "purpose": stage.purpose,
            } for stage in self.source_stages],
            "requiredEvidence": list(self.required_evidence),
        }


_CALC = re.compile(r"\b(?:berechn\w*|rechne\w*|calculate\w*|compute\w*|solve\w*|lös(?:e|en|ung)|aufgabe\s*\d|exercise\s*\d)\b|\d+(?:[.,]\d+)?\s*(?:mm|cm|m|kg|n|pa|mpa|s|hz|w)\b", re.I)
_EXPLAIN = re.compile(r"\b(?:erklär\w*|erklaer\w*|explain\w*|why|warum|wie funktioniert|wie kommt|versteh\w*|understand\w*|jeden schritt|every step)\b", re.I)
_DERIVE = re.compile(r"\b(?:herleit|derive|derivation|umform|wie (?:kommt|wurde).*(?:wert|value|darauf))\b", re.I)
_EXAM = re.compile(r"\b(?:klausur|prüfung|pruefung|exam|kurzfragen?|musterlösung|points?|punkte)\b", re.I)
_FORMULA = re.compile(r"\b(?:formel(?:sammlung|zettel)?|formula|gleichung|equation|symbol(?:e|s)?|zeichen)\b", re.I)
_VISUAL = re.compile(r"\b(?:abbildung|diagramm|graph|tabelle|bild|figure|diagram|table|selected region|markierte)\b", re.I)
_FOLLOW = re.compile(r"^\s*(?:warum|why|wie|how|erklär(?:e)? (?:das|diesen schritt)|explain (?:this|that)(?: step)?)[?.!\s]*$", re.I)
_LIST = re.compile(r"\b(?:nennen|liste|list|vorteile|nachteile|advantages|disadvantages|wie viele|how many)\b", re.I)
_COMPARE = re.compile(r"\b(?:vergleich|compare|unterschied|difference|versus|vs\.?|gegenüber)\b", re.I)
_CLASSIFY = re.compile(r"\b(?:klassifiz|einteil|classification|gruppen?|categories|arten)\b", re.I)
_DEFINE = re.compile(r"\b(?:was ist|was sind|what is|what are|define|definition|bedeutet|meaning)\b", re.I)


def detect_intents(question: str) -> tuple[AcademicIntent, ...]:
    found: list[AcademicIntent] = []
    def add(intent: AcademicIntent, yes: bool) -> None:
        if yes and intent not in found:
            found.append(intent)
    add(AcademicIntent.FOLLOW_UP, bool(_FOLLOW.search(question)))
    add(AcademicIntent.EXAM_PREPARATION, bool(_EXAM.search(question)))
    add(AcademicIntent.CALCULATION, bool(_CALC.search(question)))
    add(AcademicIntent.EXERCISE_SOLUTION, bool(re.search(r"\b(?:aufgabe|exercise|problem|lösung|solution)\b", question, re.I) and _CALC.search(question)))
    add(AcademicIntent.EXPLANATION, bool(_EXPLAIN.search(question)))
    add(AcademicIntent.DERIVATION, bool(_DERIVE.search(question)))
    add(AcademicIntent.FORMULA_LOOKUP, bool(_FORMULA.search(question)))
    add(AcademicIntent.VISUAL_INTERPRETATION, bool(_VISUAL.search(question)))
    add(AcademicIntent.DEFINITION, bool(_DEFINE.search(question)))
    add(AcademicIntent.CLASSIFICATION, bool(_CLASSIFY.search(question)))
    add(AcademicIntent.LIST, bool(_LIST.search(question)))
    add(AcademicIntent.COMPARISON, bool(_COMPARE.search(question)))
    if not found or any(intent in found for intent in (AcademicIntent.DEFINITION, AcademicIntent.LIST, AcademicIntent.COMPARISON, AcademicIntent.CLASSIFICATION)):
        add(AcademicIntent.CONCEPTUAL, True)
    return tuple(found)


def detect_topic(question: str, course_topics: Iterable[str] = ()) -> TopicDetection:
    normalized = question.casefold()
    topics = [str(topic).strip() for topic in course_topics if str(topic).strip()]
    exact = [topic for topic in topics if topic.casefold() in normalized]
    if exact:
        exact.sort(key=len, reverse=True)
        return TopicDetection(exact[0], tuple(exact[1:4]), (), 0.96, tuple(exact[:6]))
    q_tokens = set(re.findall(r"[\wäöüß-]{4,}", normalized))
    scored = []
    for topic in topics:
        tokens = set(re.findall(r"[\wäöüß-]{4,}", topic.casefold()))
        overlap = len(q_tokens & tokens) / max(1, len(tokens))
        if overlap:
            scored.append((overlap, topic))
    if scored:
        scored.sort(reverse=True)
        confidence, topic = scored[0]
        return TopicDetection(topic, tuple(value for _, value in scored[1:4]), (), min(0.79, 0.45 + confidence * 0.35), tuple(value for _, value in scored[:6]))
    cleaned = re.sub(r"\b(?:was|ist|sind|what|explain|erkläre|warum|why|berechne|calculate|solve|aufgabe|exercise|bitte|please)\b", " ", question, flags=re.I)
    cleaned = re.sub(r"[^\wäöüß-]+", " ", cleaned).strip()
    candidate = " ".join(cleaned.split()[:8]) or None
    return TopicDetection(candidate, (), (), 0.35 if candidate else 0.0, ())


def _stages(intents: tuple[AcademicIntent, ...]) -> tuple[SourceStage, ...]:
    has = set(intents)
    if AcademicIntent.EXAM_PREPARATION in has:
        order = [(("exam",), ("exercise_question",), "exact exam wording"), (("solution_sheet",), ("solution_step", "worked_example"), "official exam solution"), (("lecture",), ("definition", "general_explanation"), "course terminology"), (("formula_sheet",), ("formula",), "allowed formulas"), (("exercise_sheet",), ("exercise_question", "worked_example"), "practice examples")]
    elif AcademicIntent.CALCULATION in has or AcademicIntent.EXERCISE_SOLUTION in has:
        order = [(("exercise_sheet", "exam"), ("exercise_question",), "exact problem and givens"), (("solution_sheet",), ("solution_step", "worked_example"), "official or worked solution"), (("lecture",), ("worked_example", "derivation", "general_explanation"), "method explanation"), (("formula_sheet",), ("formula",), "formula and notation")]
    elif AcademicIntent.FORMULA_LOOKUP in has and AcademicIntent.EXPLANATION not in has:
        order = [(("formula_sheet",), ("formula",), "authoritative formula"), (("lecture",), ("formula", "definition", "derivation"), "formula meaning"), (("solution_sheet",), ("solution_step", "worked_example"), "formula in use"), (("exercise_sheet",), ("exercise_question",), "application example")]
    elif AcademicIntent.EXPLANATION in has or AcademicIntent.DERIVATION in has:
        order = [(("lecture",), ("definition", "general_explanation", "derivation", "diagram", "table"), "professor explanation"), (("professor_notes",), ("definition", "general_explanation", "diagram"), "professor notes"), (("solution_sheet",), ("worked_example", "solution_step"), "worked example"), (("exercise_sheet",), ("exercise_question", "worked_example"), "practice context"), (("formula_sheet",), ("formula",), "notation and formula")]
    else:
        order = [(("lecture",), ("definition", "classification", "general_explanation", "advantage_list", "comparison", "diagram"), "course definition"), (("professor_notes",), ("definition", "general_explanation"), "professor notes"), (("formula_sheet",), ("formula", "classification"), "formal reference"), (("solution_sheet",), ("worked_example", "solution_step"), "worked example"), (("exercise_sheet",), ("exercise_question",), "exercise context")]
    return tuple(SourceStage(i + 1, docs, chunks, purpose, i == 0, 8 if i < 2 else 5) for i, (docs, chunks, purpose) in enumerate(order))


def build_question_routing_plan(question: str, course_topics: Iterable[str] = ()) -> QuestionRoutingPlan:
    intents = detect_intents(question)
    topic = detect_topic(question, course_topics)
    required = []
    if AcademicIntent.CALCULATION in intents:
        required += ["exact question identity", "givens", "required quantity", "formula", "solution method", "units"]
    if AcademicIntent.EXPLANATION in intents:
        required += ["direct explanation", "conditions", "example or derivation"]
    if AcademicIntent.DEFINITION in intents:
        required.append("definition")
    if AcademicIntent.LIST in intents:
        match = re.search(r"\b(?:one|two|three|four|ein(?:e|en)?|zwei|drei|vier|\d+)\b", question, re.I)
        required.append(f"requested list count: {match.group(0) if match else 'all requested'}")
    return QuestionRoutingPlan(question, intents, topic, _stages(intents), tuple(dict.fromkeys(required)))


def evidence_is_sufficient(plan: QuestionRoutingPlan, chunks: Iterable[object]) -> bool:
    values = list(chunks)
    if not values:
        return False
    text = " ".join(str(getattr(chunk, "text", "") or "") for chunk in values).casefold()
    chunk_types = {str(getattr(chunk, "chunk_type", "") or "") for chunk in values}
    intents = set(plan.intents)
    topic_ok = not plan.topic.primary_topic or plan.topic.primary_topic.casefold() in text or any(
        plan.topic.primary_topic.casefold() == str(getattr(chunk, "primary_topic", "") or "").casefold()
        for chunk in values
    )
    if AcademicIntent.CALCULATION in intents:
        has_problem = bool(chunk_types & {"exercise_question", "worked_example", "solution_step"})
        has_method = bool(chunk_types & {"formula", "derivation", "worked_example", "solution_step"}) or "=" in text
        has_units = bool(re.search(r"\b(?:mm|cm|m|kg|n|pa|mpa|s|hz|w)\b", text, re.I))
        return topic_ok and has_problem and has_method and has_units
    if AcademicIntent.LIST in intents:
        requested = re.search(r"\b(?:three|drei|3)\b", plan.original_question, re.I)
        count = len(re.findall(r"(?:^|\n)\s*(?:[-•*]|\d+[.)])\s+", text))
        return topic_ok and (count >= 3 if requested else count >= 1)
    if AcademicIntent.EXPLANATION in intents:
        return topic_ok and bool(chunk_types & {"definition", "general_explanation", "derivation", "worked_example"})
    return topic_ok and bool(chunk_types & {"definition", "classification", "general_explanation", "advantage_list", "comparison"} or len(text) > 120)


def load_course_topic_inventory(user_id: str, course_id: str) -> tuple[str, ...]:
    """Return the automatic chat topic inventory; never requires Deep Learn."""
    sb = get_supabase()
    found: list[str] = []
    try:
        rows = (sb.table("course_topics").select("name").eq("user_id", user_id)
                .eq("course_id", course_id).limit(500).execute()).data or []
        found.extend(str(row.get("name") or "").strip() for row in rows)
    except Exception:
        pass
    try:
        rows = (sb.table("document_chunks").select("primary_topic,topics")
                .eq("user_id", user_id).eq("course_id", course_id)
                .not_.is_("primary_topic", "null").limit(2000).execute()).data or []
        for row in rows:
            found.append(str(row.get("primary_topic") or "").strip())
            found.extend(str(value).strip() for value in (row.get("topics") or []))
    except Exception:
        pass
    return tuple(dict.fromkeys(value for value in found if value))


__all__ = ["AcademicIntent", "QuestionRoutingPlan", "ROUTING_POLICY_VERSION", "SourceStage", "TopicDetection", "build_question_routing_plan", "detect_intents", "detect_topic", "evidence_is_sufficient", "load_course_topic_inventory"]
