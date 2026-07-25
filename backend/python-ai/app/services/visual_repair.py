"""One-shot repair for drafts that falsely deny attached visual evidence."""

from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..config import get_settings
from .openai_client import get_openai_client

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
    domain: str | None = None
    requested_quantities: list[str] = Field(default_factory=list)
    visible_values: list[str] = Field(default_factory=list)
    visible_answer_options: list[VisualAnswerOptionResult] = Field(default_factory=list)
    visible_mapping_labels: list[str] = Field(default_factory=list)
    visible_formula_symbols: list[str] = Field(default_factory=list)
    task_kind: str | None = None
    task_summary: str | None = None
    evidence_page: int | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


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
    schema = VisualTaskIdentityResult.model_json_schema()
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
                        # Pydantic defaults make several fields optional in the
                        # JSON Schema. OpenAI strict mode requires every schema
                        # property to be listed as required, so validation is
                        # enforced locally below for cross-SDK compatibility.
                        "strict": False,
                        "schema": schema,
                    },
                },
            )
            raw = str(response.choices[0].message.content or "").strip()
            return VisualTaskIdentityResult.model_validate(json.loads(raw))
        except (ValidationError, ValueError, TypeError, json.JSONDecodeError) as exc:
            last_error = exc
    raise ValueError("visual identity did not match schema") from last_error


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


def _repair_prompt(
    *,
    question: str,
    draft: str,
    visible_page: int | None,
    open_context: str,
) -> str:
    return f"""Your previous draft incorrectly claimed that the visible PDF page,
formula, diagram, or table was unavailable.

A current page image is attached to this request.

Visible page: {visible_page or "unknown"}

Inspect the attached visual evidence again.

Before answering, identify internally:
1. the exercise number;
2. the requested quantity or object;
3. the relevant formula, diagram, table, or marked area;
4. at least two visible labels, values, symbols, or answer choices.

Then answer the user's actual question:
{question}

Do not ask the user to reopen, upload, select, or paste content that is
already attached.

Previous incorrect draft:
{draft}

Current visible-page text:
{open_context[:12000]}
"""


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
) -> str | None:
    prompt = _repair_prompt(
        question=question,
        draft=draft,
        visible_page=visible_page,
        open_context=open_context,
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
) -> str | None:
    """Sync adapter for the existing synchronous SSE generator."""
    prompt = _repair_prompt(
        question=question,
        draft=draft,
        visible_page=visible_page,
        open_context=open_context,
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
    "MAX_VISUAL_DENIAL_REPAIRS",
    "VISUAL_DENIAL_REPAIR_TIMEOUT_SECONDS",
    "VisualAnswerOptionResult",
    "VisualTaskIdentityResult",
    "generate_visual_repair",
    "generate_visual_task_identity",
    "generate_grounded_repair_sync",
    "repair_false_visual_denial",
    "repair_false_visual_denial_sync",
]
