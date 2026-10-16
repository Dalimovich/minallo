"""One-shot repair for drafts that falsely deny attached visual evidence."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field

from ..config import get_settings
from .openai_client import get_openai_client
from .reliability import GroundedTaskKind, TaskTraits, VisualTaskKind

log = logging.getLogger(__name__)

VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS = 25
MAX_VISUAL_DENIAL_REPAIRS = 1
MAX_VISUAL_IDENTITY_ATTEMPTS = 2


class VisualAnswerOptionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str | None = None
    text: str
    selected: bool | None = None
    page: int | None = None
    source: str = "vision"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class VisualTaskIdentityResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exercise_reference: str | None = None
    detected_task_references: list[str] = Field(default_factory=list)
    detected_task_count: int = Field(default=0, ge=0)
    domain: str | None = None
    requested_quantities: list[str] = Field(default_factory=list)
    visible_values: list[str] = Field(default_factory=list)
    visible_answer_options: list[VisualAnswerOptionResult] = Field(default_factory=list)
    visible_mapping_labels: list[str] = Field(default_factory=list)
    visible_formula_symbols: list[str] = Field(default_factory=list)
    task_kind: GroundedTaskKind | None = None
    task_summary: str | None = None
    evidence_page: int | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


def build_visual_identity_prompt(
    *,
    user_question: str,
    requested_exercise: str | None,
    visible_page: int | None,
    active_filename: str | None,
    selected_region_present: bool,
) -> str:
    target = requested_exercise or "not explicitly specified"
    return f"""Identify the task requested by the user from the attached PDF evidence.

User request: {user_question}
Requested exercise: {target}
Visible page: {visible_page or 'unknown'}
Active file: {active_filename or 'unknown'}
Selected region present: {selected_region_present}

If a requested exercise is specified, identify that exercise only. Do not return
another exercise as the active exercise. If it is not visible in the supplied
evidence, set exercise_reference to null and lower confidence.

Return every exercise reference visible in detected_task_references and set
detected_task_count consistently. Extract the exact domain, requested quantities,
values, answer options and selected state, mapping labels, formula symbols, task
kind, evidence page, and confidence. Do not solve the exercise."""


def visual_identity_model_for_task(
    traits: TaskTraits,
    *,
    image_count: int,
    has_mapping_labels: bool,
) -> str:
    settings = get_settings()
    demanding = bool(
        traits.requires_complete_mapping
        or traits.requires_spatial_reasoning
        or has_mapping_labels
        or image_count > 1
        or traits.visual_kind in {
            VisualTaskKind.TECHNICAL_DRAWING_MAPPING,
            VisualTaskKind.CHECKBOX_EXTRACTION,
        }
    )
    return (
        settings.openai_generate_model_strong
        if demanding else settings.openai_generate_model
    )


def _strict_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Make Pydantic's schema compatible with OpenAI strict structured output."""
    result = dict(schema)
    properties = result.get("properties")
    if isinstance(properties, dict):
        result["required"] = list(properties)
        result["additionalProperties"] = False
        result["properties"] = {
            key: _strict_json_schema(value) if isinstance(value, dict) else value
            for key, value in properties.items()
        }
    if isinstance(result.get("items"), dict):
        result["items"] = _strict_json_schema(result["items"])
    for branch_key in ("$defs", "definitions"):
        if isinstance(result.get(branch_key), dict):
            result[branch_key] = {
                key: _strict_json_schema(value) if isinstance(value, dict) else value
                for key, value in result[branch_key].items()
            }
    return result


def generate_visual_task_identity(
    *, prompt: str, images: list[dict[str, object]], model: str,
) -> VisualTaskIdentityResult:
    """Return schema-validated visual identity, with one bounded repair retry."""
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image in images:
        data = str(image.get("data") or "")
        if data:
            media_type = str(image.get("mediaType") or "image/png")
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}", "detail": "high"},
            })
    client = get_openai_client()
    last_error: Exception | None = None
    messages: list[dict[str, Any]] = [{"role": "user", "content": content}]
    schema = _strict_json_schema(VisualTaskIdentityResult.model_json_schema())
    for attempt in range(MAX_VISUAL_IDENTITY_ATTEMPTS):
        if attempt:
            messages.append({
                "role": "user",
                "content": "Return only valid JSON conforming exactly to the supplied schema.",
            })
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0,
                max_tokens=1800,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "visual_task_identity",
                        "strict": attempt == 0,
                        "schema": schema,
                    },
                },
            )
            raw = str(response.choices[0].message.content or "").strip()
            return VisualTaskIdentityResult.model_validate(json.loads(raw))
        except Exception as exc:
            last_error = exc
    raise ValueError("visual_identity_schema_failure") from last_error


def generate_visual_repair(
    *,
    prompt: str,
    images: list[dict[str, object]],
    model: str,
) -> str:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image in images:
        media_type = str(image.get("mediaType") or "image/png")
        data = str(image.get("data") or "")
        if data:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}", "detail": "high"},
            })
    response = get_openai_client().chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        temperature=0,
        max_tokens=1800,
    )
    return str(response.choices[0].message.content or "").strip()


_EXERCISE_IDENTIFICATION_STEPS = """Before answering, identify internally:
1. the exercise number;
2. the requested quantity or object;
3. the relevant formula, diagram, table, or marked area;
4. at least two visible labels, values, symbols, or answer choices."""

# No numbered checklist for descriptive requests (FACTORY BWL-01): a plain
# "explain the illustration" question has no exercise number or requested
# quantity, and the exercise-shaped checklist above gave the model literal
# headers it could echo back verbatim as answer content instead of reading
# the image — confirmed from a live repair output whose section headers
# ("Exercise Number:", "Requested Quantity or Object:", ...) were lifted
# straight from this prompt rather than describing anything on the page.
_DESCRIPTIVE_IDENTIFICATION_STEPS = """Before answering, identify internally the
visible sections or components, any labels or captions actually printed on
the page, and how those parts connect or relate to each other."""


_EXERCISE_ANTI_INVENTION_GUARD = (
    "Describe only what is actually visible on the page — do not invent an "
    "exercise number, a requested quantity, or specific values that are not "
    "actually printed there."
)
_DESCRIPTIVE_ANTI_INVENTION_GUARD = (
    "Describe only what is actually visible on the page — do not invent "
    "labels, values, or specific content that is not actually printed there."
)


def _repair_prompt(
    *,
    question: str,
    draft: str,
    visible_page: int | None,
    open_context: str,
    needs_exercise_identification: bool,
) -> str:
    identification_steps = (
        _EXERCISE_IDENTIFICATION_STEPS
        if needs_exercise_identification
        else _DESCRIPTIVE_IDENTIFICATION_STEPS
    )
    anti_invention_guard = (
        _EXERCISE_ANTI_INVENTION_GUARD
        if needs_exercise_identification
        else _DESCRIPTIVE_ANTI_INVENTION_GUARD
    )
    return f"""Your previous draft incorrectly claimed that the visible PDF page,
formula, diagram, or table was unavailable.

A current page image is attached to this request.

Visible page: {visible_page or "unknown"}

Inspect the attached visual evidence again.

{identification_steps}

Then answer the user's actual question:
{question}

Do not ask the user to reopen, upload, select, or paste content that is
already attached. {anti_invention_guard}

Previous incorrect draft:
{draft}

Current visible-page text:
{open_context[:12000]}
"""


# Deliberately shorter, header-shaped fragments rather than full sentences:
# the observed failure had the model turn the checklist into title-case
# section headers ("Exercise Number:", "Requested Quantity or Object:") in
# its answer, not a verbatim copy of the full instruction sentences.
_REPAIR_INSTRUCTION_ECHO_PHRASES = (
    "exercise number",
    "requested quantity",
    "relevant formula, diagram, table",
    "visible labels, values, symbols",
    "visible sections or components",
    "labels or captions actually printed",
)
_VAGUE_HEDGE_RE = re.compile(
    r"\b(?:likely|probably|presumably)\s+(?:represents?|indicates?|shows?)\b|"
    r"\bappears?\s+to\s+(?:represent|show|indicate)\b|"
    r"\bseems?\s+to\s+(?:represent|show|indicate)\b",
    re.IGNORECASE,
)


def repair_reads_as_ungrounded_description(repaired: str) -> bool:
    """Floor check for descriptive (non-exercise) repairs, where the existing
    structural identity/obligation validation is a no-op (no exercise number,
    no required quantity, no mapping labels to compare against). A
    well-structured answer can still be a model parroting the repair prompt's
    own instructions back as section headers (a real, observed failure —
    FACTORY BWL-01), or papering over an unread image with vague hedging
    ("likely represents...") instead of naming what's actually shown. Neither
    check references any specific diagram's labels — both are generic
    signals of template-echoing or guessing, so this generalizes to any
    lecture illustration, not just the one that surfaced the bug."""
    text = (repaired or "").casefold()
    if any(phrase in text for phrase in _REPAIR_INSTRUCTION_ECHO_PHRASES):
        return True
    return len(_VAGUE_HEDGE_RE.findall(repaired or "")) >= 2


async def repair_false_visual_denial(
    *,
    request_id: str,
    question: str,
    draft: str,
    visible_page: int | None,
    open_context: str,
    image_parts: list[dict[str, object]],
    model: str,
    generator: Callable[..., str] = generate_visual_repair,
    needs_exercise_identification: bool = False,
) -> str | None:
    prompt = _repair_prompt(
        question=question,
        draft=draft,
        visible_page=visible_page,
        open_context=open_context,
        needs_exercise_identification=needs_exercise_identification,
    )
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(generator, prompt=prompt, images=image_parts, model=model),
            timeout=VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        log.warning("visual denial repair timed out request_id=%s", request_id)
    except Exception:
        log.exception("visual denial repair failed request_id=%s", request_id)
    return None


def repair_false_visual_denial_sync(
    *,
    request_id: str,
    question: str,
    draft: str,
    visible_page: int | None,
    open_context: str,
    image_parts: list[dict[str, object]],
    model: str | None = None,
    generator: Callable[..., str] = generate_visual_repair,
    needs_exercise_identification: bool = False,
) -> str | None:
    """Sync adapter for the existing synchronous SSE generator."""
    prompt = _repair_prompt(
        question=question,
        draft=draft,
        visible_page=visible_page,
        open_context=open_context,
        needs_exercise_identification=needs_exercise_identification,
    )
    chosen_model = model or get_settings().openai_generate_model
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="visual-repair")
    future = executor.submit(generator, prompt=prompt, images=image_parts, model=chosen_model)
    try:
        return future.result(timeout=VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS)
    except FutureTimeout:
        future.cancel()
        log.warning("visual denial repair timed out request_id=%s", request_id)
    except Exception:
        log.exception("visual denial repair failed request_id=%s", request_id)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return None


def generate_grounded_repair_sync(
    *,
    request_id: str,
    question: str,
    incorrect_draft: str,
    source_context: str,
    image_parts: list[dict[str, object]],
    mismatch_codes: list[str],
    model: str | None = None,
) -> str | None:
    prompt = f"""The previous draft contradicted the active source task.
Mismatch codes: {", ".join(mismatch_codes)}

Discard the previous task interpretation. Re-ground only from the active
document/page evidence below and attached images. Identify the exercise,
domain, requested quantity and required answer type, then answer once.
Do not reuse facts that occur only in the incorrect draft.

Question:
{question}

Active source evidence:
{source_context[:16000]}

Incorrect draft (for contradiction diagnosis only):
{incorrect_draft[:8000]}
"""
    chosen_model = model or get_settings().openai_generate_model
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="grounding-repair")
    future = executor.submit(
        generate_visual_repair,
        prompt=prompt,
        images=image_parts,
        model=chosen_model,
    )
    try:
        return future.result(timeout=VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS)
    except FutureTimeout:
        future.cancel()
        log.warning("grounding repair timed out request_id=%s", request_id)
    except Exception:
        log.exception("grounding repair failed request_id=%s", request_id)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return None


__all__ = [
    "build_visual_identity_prompt",
    "MAX_VISUAL_DENIAL_REPAIRS",
    "VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS",
    "VisualAnswerOptionResult",
    "VisualTaskIdentityResult",
    "repair_reads_as_ungrounded_description",
    "generate_visual_repair",
    "generate_visual_task_identity",
    "visual_identity_model_for_task",
    "generate_grounded_repair_sync",
    "repair_false_visual_denial",
    "repair_false_visual_denial_sync",
]
