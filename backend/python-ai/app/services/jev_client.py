"""Isolated, disabled-by-default adapter for Jev (TypeSafe AI's "System
One" structured-decision model) -- 2026-10-22 evaluation preparation.

NOT WIRED INTO ANY LIVE CONSUMER. No router, generation, grounding,
cache, or persistence module imports this file. It exists so an offline
evaluation harness can call a real Jev endpoint, once credentials are
provided and the user explicitly approves a paid run -- see the
semantic-intent-layer-initiative memory entry / the 2026-10-22 report for
the acceptance criteria this evaluation is gated on. Flipping
settings.jev_adapter_enabled on by itself changes nothing in production;
it only lets THIS module's own construct_client() refuse to build a
client when it's off, as a second guard against an accidental call.

What Jev is (confirmed against TypeSafe's own docs, not guessed):
TypeSafe AI's Jev is a "System One" model -- it returns typed, calibrated
DECISIONS, never generated prose. Three question primitives:
  - Noul: "is this statement true?" -> a probability in [0, 1].
  - Choice: pick one label from a fixed option list -> label + confidence
    + a probability distribution over all options.
  - Score: position on a defined rubric -> score + confidence + a legend
    mapping levels to labels.
One HTTP call can ask several questions of the same `state` (input text)
at once. Endpoint: POST https://api.typesafe.ai/v1/systemone, bearer-
auth via TYPESAFE_API_KEY. Pricing is per INPUT token only ($0.042 /
Mtok as of 2026-10-22); there is no free tier or trial allowance
documented anywhere on typesafe.ai -- every real call this module makes
costs money the moment it's issued. Context budget: 64k tokens per
request by default (32k per individual question), extendable to 262k
with the `TypeSafe-Danger-Zone-Long-Context: true` header (not sent
here).

Independent benchmarking (Vals.ai, 2026-10, the most rigorous
third-party source found): for bounded, single-document claim
verification Jev performs within noise of frontier/mid-tier LLMs at a
small fraction of the cost and latency (p50 ~0.10s). On harder, more
open-ended legal reasoning (LegalBench) it finished LAST of twelve
systems tested, roughly level with Claude Haiku 4.5. No independent
benchmark of intent classification, multi-turn reference resolution, or
conversational-relationship judgment -- the actual shape of Minallo's
semantic-intent task -- was found to exist as of this writing. That gap
is exactly what the evaluation this module supports is for; it is not
assumed to transfer from either benchmark above.

Implemented with plain httpx rather than the `typesafe-sdk` PyPI
package: this keeps the isolated adapter installable/testable (a fake
httpx transport, same pattern this codebase already uses throughout its
own test suite) without adding a new production dependency before any
adoption decision is made. If Jev is adopted, switching to the official
SDK is a follow-up, not a blocker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import httpx

from ..config import get_settings

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_DEFAULT_MODEL = "jev-latest"

QuestionType = Literal["noul", "choice", "score"]


@dataclass(frozen=True)
class NoulQuestion:
    instructions: str

    def to_payload(self) -> dict[str, Any]:
        return {"type": "noul", "instructions": self.instructions}


@dataclass(frozen=True)
class ChoiceQuestion:
    """``options`` maps option name -> a plain-language description (or
    None when the name is self-explanatory) -- confirmed against
    docs.typesafe.ai/primitives/choice.md directly: ``criteria`` for a
    choice question is an OBJECT (name -> description), never a bare
    array of option names. A first live call against a bare array of
    names (this module's original, docs-misread shape) was rejected with
    a 422 before this was corrected -- see the 2026-10-22 report for
    that real, confirmed trace."""
    instructions: str
    options: dict[str, str | None]

    def to_payload(self) -> dict[str, Any]:
        return {"type": "choice", "instructions": self.instructions, "criteria": dict(self.options)}


@dataclass(frozen=True)
class ScoreQuestion:
    instructions: str
    rubric: tuple[str, ...]

    def to_payload(self) -> dict[str, Any]:
        return {"type": "score", "instructions": self.instructions, "criteria": list(self.rubric)}


Question = NoulQuestion | ChoiceQuestion | ScoreQuestion


@dataclass(frozen=True)
class JevAnswer:
    type: QuestionType
    noul: float | None = None
    choice: str | None = None
    # A numeric position on the rubric (e.g. 1.2 for a 0-2 scale), NOT a
    # label -- confirmed against docs.typesafe.ai/primitives/score.md's
    # own example response.
    score: float | None = None
    confidence: float | None = None
    probabilities: dict[str, float] | None = None
    # Score-only: level number (as a string, e.g. "0"/"1"/"2") -> the
    # description sent for that level in the request's own criteria.
    legend: dict[str, Any] | None = None


@dataclass(frozen=True)
class JevResponse:
    model: str
    answers: dict[str, JevAnswer]
    input_tokens: int
    output_tokens: int


class JevNotEnabledError(Exception):
    """Raised by construct_client() when settings.jev_adapter_enabled is
    False or no TYPESAFE_API_KEY is configured -- fails closed rather
    than silently constructing a client that would fail on first call."""


def construct_client(*, timeout_seconds: float = 10.0) -> "JevClient":
    settings = get_settings()
    if not settings.jev_adapter_enabled:
        raise JevNotEnabledError("settings.jev_adapter_enabled is False -- no Jev client constructed")
    if not settings.typesafe_api_key:
        raise JevNotEnabledError("TYPESAFE_API_KEY is not configured -- no Jev client constructed")
    return JevClient(api_key=settings.typesafe_api_key, timeout_seconds=timeout_seconds)


class JevClient:
    """Thin, explicit wrapper around one POST to JEV_ENDPOINT. Construct
    via construct_client(), never directly, so the enabled/credentials
    gate above is never bypassed by accident."""

    def __init__(self, *, api_key: str, timeout_seconds: float = 10.0) -> None:
        self._http = httpx.Client(
            timeout=httpx.Timeout(timeout_seconds, connect=5.0),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )

    def ask(
        self, *, state: str, questions: dict[str, Question], model: str = JEV_DEFAULT_MODEL,
    ) -> JevResponse:
        """One real, billed call (input tokens only). Every caller of
        this method is an explicit, deliberate spend -- never call it
        from a loop without first confirming the expected call count and
        cost with whoever approved the run."""
        body = {
            "model": model, "state": state,
            "questions": {name: question.to_payload() for name, question in questions.items()},
        }
        response = self._http.post(JEV_ENDPOINT, json=body)
        response.raise_for_status()
        data = response.json()
        answers = {}
        for name, raw in (data.get("answers") or {}).items():
            answers[name] = JevAnswer(
                type=raw["type"], noul=raw.get("noul"), choice=raw.get("choice"),
                score=raw.get("score"), confidence=raw.get("confidence"),
                probabilities=raw.get("probabilities"), legend=raw.get("legend"),
            )
        usage = data.get("usage") or {}
        return JevResponse(
            model=data.get("model", model), answers=answers,
            input_tokens=usage.get("input_tokens", 0), output_tokens=usage.get("output_tokens", 0),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "JevClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
