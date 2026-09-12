"""Deutsch Schreibtrainer — analyse a German paragraph against the user's
profile level and task type.

Returns a structured analysis matching docs/schreibtrainer-ai-spec.md:
score, scoreExplanation, correctedText, improvedText, strengths,
feedbackItems (with severity, confidence, spanStart/End), structureFeedback,
examReadiness, practiceRecommendations, longitudinalNote, insufficientContext.

Supabase persistence of submissions + weakness profile is wired behind a
flag — it will be enabled when the migrations land in the dedicated
persistence slice.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .llm_json import chat_json
from ..config import get_settings

log = logging.getLogger(__name__)

# Word-count thresholds for honest grading. Anything below MIN_FOR_ANY
# triggers an `insufficientContext` block and we skip score/structure/exam.
MIN_WORDS_FOR_ANY_GRADING = 60
MIN_WORDS_FOR_FULL_GRADING = 120

ARGUMENTATIVE_TASK_TYPES = {"stellungnahme", "argumentation", "motivationsschreiben"}

ALLOWED_LEVELS = {"A1", "A2", "B1", "B2", "C1", "C1 Hochschule", "C2"}
ALLOWED_TASK_TYPES = {
    "email",
    "stellungnahme",
    "argumentation",
    "zusammenfassung",
    "bericht",
    "motivationsschreiben",
    "freier_text",
}
ALLOWED_SEVERITIES = {"high", "medium", "low", "optional"}
ALLOWED_CONFIDENCES = {"high", "medium", "low"}
ALLOWED_ITEM_TYPES = {"grammar", "vocabulary", "style", "pattern"}


def _word_count(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text or "", flags=re.UNICODE))


def _system_prompt(profile_level: str, task_type: str, explanation_language: str) -> str:
    is_argumentative = task_type in ARGUMENTATIVE_TASK_TYPES
    is_c1_hochschule = profile_level == "C1 Hochschule"
    return f"""You are an honest, supportive German writing coach grading a student text.

PROFILE LEVEL: {profile_level}
TASK TYPE: {task_type}
EXPLANATION LANGUAGE: {explanation_language}

STUDENT DIGNITY — applies to every field you produce (strengths, scoreExplanation, explanation, longitudinalNote, every feedbackItem). Correct the writing, not the writer.
- Describe the grammar / vocabulary / style point, NEVER the student. Diagnose the skill, not the level of the person.
- Required style examples (mirror this voice):
  * "Your meaning is clear. The grammar point to strengthen is adjective endings after definite articles."
  * "For a {profile_level}-level text, a more precise expression would be ..."
  * "This sentence is understandable; the word order needs adjustment."
  * "The idea is almost right — the issue is the auxiliary verb in the Perfekt."
- FORBIDDEN phrasings, no matter how poor the text is: "Your German is weak / bad / poor / too simple", "You write like a beginner", "Your vocabulary is too low for {profile_level}", "You don't understand cases", "You should already know this", "This is easy", "Stupid / dumb / careless mistake", "You keep messing up", "You are not ready". Avoid condescending softeners ("obviously", "clearly", "as I already said").
- Never tell the student their text "is at A1 level" if they're working at C1 — describe what the specific sentence needs to reach C1.
- If the student writes anything self-deprecating in the text, do not agree with it.

Core rule: Evaluate the text according to the student's PROFILE LEVEL and TASK TYPE. A phrase can be grammatically correct but still inappropriate for the profile level — mark such cases as vocabulary or style upgrades, NOT as grammar mistakes.

Judgment by profile level:
- A1 / A2: basic correctness only. Do not flag simple vocabulary as bad. Simple explanations. Focus on word order, articles, verb forms.
- B1: sentence structure, articles, prepositions, verb conjugation, common vocabulary. Practical, not academic.
- B2: connectors, argument structure, natural wording, precise vocabulary.
- C1 / C1 Hochschule: academic / university German. Mark grammatically-correct-but-too-simple wording as `vocabulary` or `style` upgrades. Suggest formal connectors, nominal style, precise wording. Do not reward Nominalstil for its own sake — clarity over complication.

Judgment by task type:
- email: register depends on addressee; flag overly casual or overly stiff phrasing.
- stellungnahme / argumentation: expect intro / main argument(s) / counterargument / conclusion. Connectors and structure matter.
- zusammenfassung: neutrality, no opinions, condensed.
- bericht: chronological, factual, neutral.
- motivationsschreiben: formal, confident, structured.
- freier_text: looser register but still graded against profile level.

Three feedback categories (DISTINGUISH — do not lump 2 and 3 in with 1):
1. Actual grammar/spelling mistake — type=grammar, isActualError=true, isLevelUpgrade=false, severity in (high|medium|low).
2. Level-based vocabulary upgrade — type=vocabulary, isActualError=false, isLevelUpgrade=true, severity defaults to medium.
3. Style / register / connector improvement — type=style, isActualError=false, isLevelUpgrade=true, severity in (low|optional).

Repeated mistakes: if the same category appears ≥3 times, emit ONE aggregated item with type="pattern", a `count` field, and an `examples` array of short snippets. Do NOT also emit the individual items.

For every feedbackItem:
- Provide `original` (the snippet from the student's text exactly as written) and `suggestion` (the replacement).
- Provide `spanStart` and `spanEnd` — 0-indexed UTF-16 character offsets into the SUBMITTED TEXT, such that submittedText[spanStart:spanEnd] equals `original` exactly. For pattern items, set spanStart=spanEnd=0 and use examples[].spanStart/spanEnd if you can; otherwise omit per-example spans.
- Provide a non-empty `explanation` that answers WHY this fits the profile level / task type. Bad: "Use vorteilhaft instead of gut." Good: "Vorteilhaft is more precise and formal than gut, so it fits an academic C1 text."
- Provide a `confidence` value (high|medium|low). If you are not sure something is wrong, do NOT mark it as a grammar error — mark it as optional severity with confidence=low.
- If you mark a pattern item, also emit a `ruleCard` object with title, rule, example, miniExerciseHint.

Produce TWO rewritten texts:
- `correctedText`: minimal — only fix language errors. KEEP the student's voice and ideas intact.
- `improvedText`: stronger rewrite adapted to profile level + task type. This is the "what good looks like" model answer.

Strengths: include 2-5 concrete things the student did well. Never empty.

Structure feedback ({"required" if is_argumentative else "optional"} for this task type): emit a `structureFeedback` object with verdict (weak|adequate|strong), missing[] (list of missing pieces like "counterargument", "clear conclusion"), and note.

Exam readiness ({"required" if is_c1_hochschule else "omit"} for this profile level): emit `examReadiness` with wouldPass, verdict (likely|borderline|unlikely), missing[], note.

Score the text on 6 axes (0-100): grammar, vocabulary, structure, style, taskFulfillment, plus overall. Include `scoreExplanation` (non-empty, 1-3 sentences) that explains the overall score.

Insufficient context: if the text is too short or too vague to grade fairly, return `insufficientContext` with reason (tooShort|tooVague|offTopic), a friendly message, and minWords. When this is present, set score values to null and omit structureFeedback / examReadiness.

Estimated level: emit `estimatedLevel` (string like "B2+/C1-") for what level the submitted text reads as.

Explanation language: write `explanation` and `scoreExplanation` in {explanation_language}. Keep `original` and `suggestion` in German.

Output JSON only, no prose, matching this shape:

{{
  "profileLevel": "{profile_level}",
  "taskType": "{task_type}",
  "estimatedLevel": "B2+/C1-",
  "score": {{ "overall": 74, "grammar": 78, "vocabulary": 68, "structure": 72, "style": 70, "taskFulfillment": 80 }},
  "scoreExplanation": "...",
  "correctedText": "...",
  "improvedText": "...",
  "strengths": ["..."],
  "feedbackItems": [
    {{
      "type": "grammar|vocabulary|style|pattern",
      "label": "Grammar mistake | C1 vocabulary upgrade | Style improvement | Repeated mistake",
      "category": "e.g. Perfekt auxiliary / Academic vocabulary / Connector upgrade",
      "severity": "high|medium|low|optional",
      "confidence": "high|medium|low",
      "original": "...",
      "suggestion": "...",
      "spanStart": 0,
      "spanEnd": 0,
      "count": 1,
      "examples": [],
      "isActualError": true,
      "isLevelUpgrade": false,
      "explanation": "...",
      "ruleCard": null
    }}
  ],
  "structureFeedback": {{ "verdict": "adequate", "missing": [], "note": "..." }},
  "examReadiness": {{ "wouldPass": true, "verdict": "borderline", "missing": [], "note": "..." }},
  "practiceRecommendations": ["..."],
  "longitudinalNote": null,
  "insufficientContext": null
}}
"""


def _user_prompt(text: str, weakness_profile: list[dict[str, Any]] | None) -> str:
    parts = [
        "SUBMITTED TEXT (grade this; spans must be UTF-16 offsets into this exact string):",
        "<<<TEXT",
        text,
        "TEXT>>>",
    ]
    if weakness_profile:
        top = ", ".join(
            f'{w.get("category","?")} (count={w.get("count","?")})'
            for w in weakness_profile[:5]
        )
        parts.append(
            "STUDENT'S RECENT WEAKNESSES (use to write the longitudinalNote and "
            f"to bias practiceRecommendations; do NOT invent corrections to fit them): {top}"
        )
    return "\n".join(parts)


def _coerce_str(v: Any, default: str = "") -> str:
    return v if isinstance(v, str) else default


def _coerce_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    return None


def _coerce_bool(v: Any, default: bool) -> bool:
    return v if isinstance(v, bool) else default


def _clamp_choice(v: Any, allowed: set[str], default: str) -> str:
    return v if isinstance(v, str) and v in allowed else default


def _normalise_score(raw: Any) -> dict[str, int | None]:
    out: dict[str, int | None] = {
        "overall": None,
        "grammar": None,
        "vocabulary": None,
        "structure": None,
        "style": None,
        "taskFulfillment": None,
    }
    if not isinstance(raw, dict):
        return out
    for k in out:
        v = _coerce_int(raw.get(k))
        if v is not None:
            out[k] = max(0, min(100, v))
    return out


def _normalise_item(raw: Any, text_len: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    item_type = _clamp_choice(raw.get("type"), ALLOWED_ITEM_TYPES, "style")
    original = _coerce_str(raw.get("original"))
    suggestion = _coerce_str(raw.get("suggestion"))
    explanation = _coerce_str(raw.get("explanation"))
    if not explanation:
        return None  # spec rule: no item ships without an explanation

    span_start = _coerce_int(raw.get("spanStart"))
    span_end = _coerce_int(raw.get("spanEnd"))
    if span_start is None or span_start < 0 or span_start > text_len:
        span_start = 0
    if span_end is None or span_end < span_start or span_end > text_len:
        span_end = span_start

    severity = _clamp_choice(raw.get("severity"), ALLOWED_SEVERITIES, "low")
    confidence = _clamp_choice(raw.get("confidence"), ALLOWED_CONFIDENCES, "medium")

    examples_raw = raw.get("examples")
    examples: list[Any] = examples_raw if isinstance(examples_raw, list) else []

    rule_card_raw = raw.get("ruleCard")
    rule_card: dict[str, Any] | None = None
    if isinstance(rule_card_raw, dict) and rule_card_raw.get("rule"):
        rule_card = {
            "title": _coerce_str(rule_card_raw.get("title")),
            "rule": _coerce_str(rule_card_raw.get("rule")),
            "example": _coerce_str(rule_card_raw.get("example")),
            "miniExerciseHint": _coerce_str(rule_card_raw.get("miniExerciseHint")),
        }

    return {
        "type": item_type,
        "label": _coerce_str(raw.get("label")),
        "category": _coerce_str(raw.get("category")),
        "severity": severity,
        "confidence": confidence,
        "original": original,
        "suggestion": suggestion,
        "spanStart": span_start,
        "spanEnd": span_end,
        "count": _coerce_int(raw.get("count")) or 1,
        "examples": examples,
        "isActualError": _coerce_bool(raw.get("isActualError"), item_type == "grammar"),
        "isLevelUpgrade": _coerce_bool(raw.get("isLevelUpgrade"), item_type in ("vocabulary", "style")),
        "explanation": explanation,
        "ruleCard": rule_card,
    }


def _normalise_structure(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    verdict = _clamp_choice(raw.get("verdict"), {"weak", "adequate", "strong"}, "adequate")
    missing = raw.get("missing")
    return {
        "verdict": verdict,
        "missing": missing if isinstance(missing, list) else [],
        "note": _coerce_str(raw.get("note")),
    }


def _normalise_exam(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    verdict = _clamp_choice(raw.get("verdict"), {"likely", "borderline", "unlikely"}, "borderline")
    missing = raw.get("missing")
    return {
        "wouldPass": _coerce_bool(raw.get("wouldPass"), False),
        "verdict": verdict,
        "missing": missing if isinstance(missing, list) else [],
        "note": _coerce_str(raw.get("note")),
    }


def _normalise_insufficient(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    return {
        "reason": _clamp_choice(raw.get("reason"), {"tooShort", "tooVague", "offTopic"}, "tooShort"),
        "message": _coerce_str(raw.get("message"), "Your text is too short to grade reliably."),
        "minWords": _coerce_int(raw.get("minWords")) or MIN_WORDS_FOR_ANY_GRADING,
    }


def analyse_writing(
    *,
    user_id: str,
    text: str,
    profile_level: str,
    task_type: str,
    explanation_language: str = "English",
    weakness_profile: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run the analysis and return the normalised response shape.

    Validation lives in the router; this function trusts its inputs and
    focuses on the LLM call + response normalisation.
    """
    text = text or ""
    text_len = len(text)
    word_count = _word_count(text)

    # Hard short-circuit: if the text is below the absolute floor we don't
    # bother spending tokens. The router already rejects empty input.
    if word_count < MIN_WORDS_FOR_ANY_GRADING:
        return {
            "profileLevel": profile_level,
            "taskType": task_type,
            "estimatedLevel": "",
            "score": _normalise_score(None),
            "scoreExplanation": "",
            "correctedText": text,
            "improvedText": "",
            "strengths": [],
            "feedbackItems": [],
            "structureFeedback": None,
            "examReadiness": None,
            "practiceRecommendations": [],
            "longitudinalNote": None,
            "insufficientContext": {
                "reason": "tooShort",
                "message": (
                    f"Your text is too short to judge reliably. "
                    f"Write at least {MIN_WORDS_FOR_FULL_GRADING} words for full feedback."
                ),
                "minWords": MIN_WORDS_FOR_FULL_GRADING,
            },
            "model": None,
            "promptTokens": None,
            "completionTokens": None,
        }

    system = _system_prompt(profile_level, task_type, explanation_language)
    user = _user_prompt(text, weakness_profile)

    # Escalate to gpt-4o for advanced levels. C1 / C1 Hochschule / C2 grading
    # needs subtle distinctions between actual mistake / vocab upgrade / style
    # upgrade — gpt-4o-mini handles A1–B2 fine but blurs the line at academic
    # German. A1–B2 stay on the cheaper default model.
    settings = get_settings()
    strong_levels = {"C1", "C1 Hochschule", "C2"}
    chosen_model = (
        getattr(settings, "openai_generate_model_strong", None)
        if profile_level in strong_levels
        else getattr(settings, "openai_generate_model", None)
    )
    result = chat_json(
        system=system,
        user=user,
        model=chosen_model,
        max_tokens=3500,
    )
    data = result.data if isinstance(result.data, dict) else {}

    # Items
    raw_items = data.get("feedbackItems")
    items: list[dict[str, Any]] = []
    if isinstance(raw_items, list):
        for r in raw_items:
            item = _normalise_item(r, text_len)
            if item is not None:
                items.append(item)

    # Below-full threshold: keep surface items but hide score/structure/exam
    insufficient = _normalise_insufficient(data.get("insufficientContext"))
    if insufficient is None and word_count < MIN_WORDS_FOR_FULL_GRADING and task_type in ARGUMENTATIVE_TASK_TYPES:
        insufficient = {
            "reason": "tooShort",
            "message": (
                f"Your text is under {MIN_WORDS_FOR_FULL_GRADING} words. "
                "Grammar items are reliable, but score / structure / exam-readiness need a longer text."
            ),
            "minWords": MIN_WORDS_FOR_FULL_GRADING,
        }

    if insufficient:
        score = _normalise_score(None)
        structure_feedback: dict[str, Any] | None = None
        exam_readiness: dict[str, Any] | None = None
        score_explanation = ""
    else:
        score = _normalise_score(data.get("score"))
        structure_feedback = _normalise_structure(data.get("structureFeedback"))
        exam_readiness = _normalise_exam(data.get("examReadiness")) if profile_level == "C1 Hochschule" else None
        score_explanation = _coerce_str(data.get("scoreExplanation"))

    strengths_raw = data.get("strengths")
    strengths = [s for s in strengths_raw if isinstance(s, str) and s.strip()] if isinstance(strengths_raw, list) else []

    practice_raw = data.get("practiceRecommendations")
    practice = [s for s in practice_raw if isinstance(s, str) and s.strip()] if isinstance(practice_raw, list) else []

    # Phase 3: feed Schreibtrainer mistakes into the shared mastery table so
    # the dashboard "Your weak topics" widget surfaces writing weaknesses
    # alongside course quiz weaknesses. Only actual grammar/style errors at
    # medium-or-high severity count — vocab "upgrade" suggestions are not
    # mistakes and shouldn't tar the student's mastery score.
    try:
        from .mastery import record_writing_weakness  # noqa: WPS433
        weak_cats: list[str] = []
        for it in items:
            if not it.get("isActualError"):
                continue
            if it.get("severity") not in ("high", "medium"):
                continue
            cat = (it.get("category") or it.get("type") or "").strip()
            if cat:
                weak_cats.append(cat)
        if weak_cats:
            record_writing_weakness(user_id=user_id, weak_categories=weak_cats)
    except Exception:  # noqa: BLE001
        log.exception("schreibtrainer mastery sync failed (ignored)")

    return {
        "profileLevel": profile_level,
        "taskType": task_type,
        "estimatedLevel": _coerce_str(data.get("estimatedLevel")),
        "score": score,
        "scoreExplanation": score_explanation,
        "correctedText": _coerce_str(data.get("correctedText"), text),
        "improvedText": _coerce_str(data.get("improvedText")),
        "strengths": strengths,
        "feedbackItems": items,
        "structureFeedback": structure_feedback,
        "examReadiness": exam_readiness,
        "practiceRecommendations": practice,
        "longitudinalNote": _coerce_str(data.get("longitudinalNote")) or None,
        "insufficientContext": insufficient,
        "model": result.model,
        "promptTokens": result.prompt_tokens,
        "completionTokens": result.completion_tokens,
    }


def persist_submission(
    *,
    user_id: str,
    text: str,
    profile_level: str,
    task_type: str,
    analysis: dict[str, Any],
) -> str | None:
    """Persist the submission + refresh the weakness profile.

    Wired but disabled — the `user_writing_submissions` and
    `user_writing_weaknesses` tables land in a follow-up migration slice.
    Once those exist, flip the flag and this becomes a real insert.
    """
    settings = get_settings()
    if not getattr(settings, "writing_coach_persistence_enabled", False):
        return None
    # Intentional no-op placeholder. The schema lives in the spec at
    # docs/schreibtrainer-ai-spec.md §20 (submissions) and §14 (weaknesses).
    log.info("writing-coach persistence flag is on but tables not migrated; skipping insert")
    return None


def fetch_weakness_profile(user_id: str) -> list[dict[str, Any]]:
    """Returns the user's top recurring weakness categories.

    Empty until the table lands. The shape is fixed now so the prompt
    template doesn't change when persistence comes online.
    """
    settings = get_settings()
    if not getattr(settings, "writing_coach_persistence_enabled", False):
        return []
    return []
