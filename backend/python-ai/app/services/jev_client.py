"""Isolated client adapter for TypeSafe AI's Jev decision API (api.typesafe.ai).

EXPERIMENTAL. Disabled by default (``Settings.semantic_intent_jev_mode ==
"off"``) and not wired into any router or caller yet -- this module is only
the adapter + typed contract, for the semantic-intent evaluation harness to
call directly while Jev is measured against the existing deterministic and
LLM-escalation baselines (student_intent.py / semantic_intent_orchestrator.py).

Jev is a structured DECISION model (noul / choice / score), not a generative
one: it answers predefined questions about a ``state`` blob and never writes
free text. This adapter mirrors the invariants the existing semantic-intent
call sites already enforce (see ``student_intent.py``'s module docstring):

- Evidence boundary: ``state`` must contain only the student's message and
  trusted, already-resolved context -- NEVER retrieved document/course text.
  A Jev result is a classification signal, never an authority that can grant
  access, invent a document/exercise identity, or override a trusted
  restriction.
- Fail-closed: any problem (disabled, missing key, timeout, transport error,
  malformed/out-of-schema response) returns ``None`` rather than raising.
  Callers must already have a deterministic/LLM fallback, exactly like
  ``student_intent._semantic_model_call``'s contract.
- Pinned model: ``Settings.jev_model`` is a specific version
  (``jev-1.13.0``), never ``jev-latest`` -- a rolling alias could silently
  change deployed decision thresholds without a code change.
- No retries: Jev's entire value proposition is low latency, so a stall is
  "skip it this turn," not "wait longer."
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Union

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)

JEV_API_URL = "https://api.typesafe.ai/v1/systemone"
# Short and not retried on purpose -- see module docstring.
JEV_TIMEOUT = httpx.Timeout(5.0, connect=3.0)


@lru_cache(maxsize=1)
def _get_jev_client() -> httpx.Client:
    """Process-wide pooled client -- same reasoning as
    ``openai_client.get_openai_client``: avoid a fresh TCP+TLS handshake
    per call."""
    return httpx.Client(timeout=JEV_TIMEOUT)


@dataclass(frozen=True)
class JevChoiceQuestion:
    name: str
    prompt: str
    options: tuple[str, ...]


@dataclass(frozen=True)
class JevNoulQuestion:
    name: str
    prompt: str


@dataclass(frozen=True)
class JevScoreQuestion:
    name: str
    prompt: str
    min_label: str
    max_label: str


JevQuestion = Union[JevChoiceQuestion, JevNoulQuestion, JevScoreQuestion]


@dataclass(frozen=True)
class JevChoiceAnswer:
    choice: str
    confidence: float
    probabilities: dict[str, float]


@dataclass(frozen=True)
class JevNoulAnswer:
    noul: float  # P(yes)


@dataclass(frozen=True)
class JevScoreAnswer:
    score: float
    confidence: float
    probabilities: dict[str, float]


JevAnswer = Union[JevChoiceAnswer, JevNoulAnswer, JevScoreAnswer]


@dataclass(frozen=True)
class JevResult:
    answers: dict[str, JevAnswer]
    input_tokens: int
    output_tokens: int
    latency_ms: float


def _question_payload(question: JevQuestion) -> dict:
    if isinstance(question, JevChoiceQuestion):
        return {
            "type": "choice", "name": question.name, "prompt": question.prompt,
            "options": list(question.options),
        }
    if isinstance(question, JevNoulQuestion):
        return {"type": "noul", "name": question.name, "prompt": question.prompt}
    return {
        "type": "score", "name": question.name, "prompt": question.prompt,
        "min_label": question.min_label, "max_label": question.max_label,
    }


def _parse_answer(question: JevQuestion, raw: dict) -> JevAnswer:
    if isinstance(question, JevChoiceQuestion):
        return JevChoiceAnswer(
            choice=str(raw["choice"]), confidence=float(raw["confidence"]),
            probabilities={str(k): float(v) for k, v in raw.get("probabilities", {}).items()},
        )
    if isinstance(question, JevNoulQuestion):
        return JevNoulAnswer(noul=float(raw["noul"]))
    return JevScoreAnswer(
        score=float(raw["score"]), confidence=float(raw["confidence"]),
        probabilities={str(k): float(v) for k, v in raw.get("probabilities", {}).items()},
    )


def ask_jev(state: dict, questions: list[JevQuestion]) -> JevResult | None:
    """Ask Jev one or more structured questions about ``state``.

    Returns ``None`` whenever Jev is off/unconfigured, passed no questions,
    or on any transport/schema failure -- see module docstring for why this
    never raises. ``state`` is the caller's responsibility to keep within the
    evidence boundary (no retrieved document/course text).
    """
    settings = get_settings()
    if settings.semantic_intent_jev_mode == "off" or not settings.jev_api_key or not questions:
        return None

    started = time.perf_counter()
    payload = {
        "model": settings.jev_model,
        "state": state,
        "questions": [_question_payload(q) for q in questions],
    }
    try:
        response = _get_jev_client().post(
            JEV_API_URL, json=payload,
            headers={"Authorization": f"Bearer {settings.jev_api_key}"},
        )
        response.raise_for_status()
        data = response.json()
        raw_answers = data["answers"]
        answers = {q.name: _parse_answer(q, raw_answers[q.name]) for q in questions}
        usage = data.get("usage") or {}
        input_tokens = int(usage.get("input_tokens", 0))
        output_tokens = int(usage.get("output_tokens", 0))
    except Exception as exc:  # noqa: BLE001 -- deliberate fail-closed boundary
        log.info("jev_call_failed exception=%s", type(exc).__name__)
        return None

    latency_ms = (time.perf_counter() - started) * 1000
    # Privacy-conscious diagnostics only -- never state/message content,
    # mirroring student_intent._log_shadow.
    log.info(
        "jev_call mode=%s model=%s question_count=%d input_tokens=%d "
        "output_tokens=%d latency_ms=%.1f",
        settings.semantic_intent_jev_mode, settings.jev_model, len(questions),
        input_tokens, output_tokens, latency_ms,
    )
    return JevResult(
        answers=answers, input_tokens=input_tokens, output_tokens=output_tokens,
        latency_ms=latency_ms,
    )


__all__ = [
    "JevAnswer", "JevChoiceAnswer", "JevChoiceQuestion", "JevNoulAnswer",
    "JevNoulQuestion", "JevQuestion", "JevResult", "JevScoreAnswer",
    "JevScoreQuestion", "ask_jev",
]
