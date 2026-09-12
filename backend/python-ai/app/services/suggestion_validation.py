"""AI validation for crowd-sourced dropdown suggestions.

The verdict only controls whether a typed value can enter the shared
5-user suggestion counter. It must never decide whether a user can save a
personal course/profile value.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from .llm_json import chat_json

log = logging.getLogger(__name__)


_SYSTEM = (
    "You validate user-submitted academic dropdown suggestions for Minallo. "
    "Return strict JSON only: "
    '{"accepted":boolean,"reason":string,"normalized":string}. '
    "Reject profanity, slurs, insults, sexual content, hateful wording, spam, "
    "keyboard mashing, jokes, test values, and non-academic nonsense in any language. "
    "For kind=major, accept only a plausible real study programme for the named university. "
    "For kind=vertiefung, accept only a plausible specialization/fachprofil for the given "
    "university and major. For kind=course, accept only a plausible real university module "
    "or course for the given university, major, and specialization. "
    "If you are uncertain whether it is a real academic item for that context, reject it. "
    "Keep normalized as the clean display name in the original language, without adding "
    "semester numbers or explanations."
)


def _clean(value: Any, limit: int = 160) -> str:
    return str(value or "").strip()[:limit]


def validate_suggestion(
    *,
    kind: str,
    parent: str,
    value: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = context or {}
    value = _clean(value, 120)
    kind = _clean(kind, 40)
    parent = _clean(parent, 120)
    if kind not in {"major", "vertiefung", "course"} or not value:
        return {"accepted": False, "reason": "invalid_input", "normalized": ""}

    user_prompt = (
        f"kind: {kind}\n"
        f"parent bucket: {parent}\n"
        f"submitted value: {value}\n"
        f"university short: {_clean(context.get('university')) or 'unknown'}\n"
        f"university full name: {_clean(context.get('universityName')) or 'unknown'}\n"
        f"major/programme: {_clean(context.get('major')) or 'unknown'}\n"
        f"vertiefung/specialization: {_clean(context.get('vertiefung')) or 'unknown'}\n"
    )

    try:
        settings = get_settings()
        result = chat_json(
            system=_SYSTEM,
            user=user_prompt,
            model=settings.openai_generate_model,
            max_tokens=180,
        )
        data = result.data if isinstance(result.data, dict) else {}
    except Exception:  # noqa: BLE001
        log.exception("suggestion validation failed")
        return {"accepted": False, "reason": "ai_error", "normalized": ""}

    accepted = data.get("accepted") is True
    normalized = _clean(data.get("normalized") or value, 120)
    reason = _clean(data.get("reason") or ("accepted" if accepted else "rejected"), 120)
    if not normalized:
        accepted = False
        reason = "empty_normalized_name"
    return {
        "accepted": accepted,
        "reason": reason,
        "normalized": normalized if accepted else "",
    }
