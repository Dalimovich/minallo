"""Ad-hoc check of OpenAI prompt-cache hit rate after the pick_system_prompt reorder.

Builds the exact same system+user prompt generate_answer would, twice
(cold + warm), and prints prompt/completion/cached tokens from the OpenAI
response usage. Run from backend/python-ai with the .venv active:

    .venv\\Scripts\\python.exe scripts\\test_prompt_cache.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.retrieval import retrieve_chunks, backfill_doc_names
from app.services.answer import (
    pick_system_prompt,
    _build_context_block,
    _context_strength,
    MAX_PROMPT_CHUNKS,
    chat_completion_params,
)
from app.services.answer_intent import classify_academic_intent
from app.services.openai_client import get_openai_client
from app.services.usage_meter import usage_from_response
from app.config import get_settings

COURSE_ID = "uc_1776947657158"
USER_ID = "b1f54590-3be9-4ef7-8235-f877befaccb3"
QUESTION = "Erkläre mir den Satz von Steiner und wann man ihn anwendet."


def run_once(label: str, system_prompt: str, user_message: str, model: str) -> None:
    client = get_openai_client()
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        **chat_completion_params(model, 1200),
    )
    usage = usage_from_response(completion)
    print(f"--- {label} ---")
    print("system_prompt_chars:", len(system_prompt))
    print("usage:", usage)


if __name__ == "__main__":
    chunks = retrieve_chunks(user_id=USER_ID, course_id=COURSE_ID, query=QUESTION)
    doc_names = backfill_doc_names(chunks, {})
    strength = _context_strength(chunks)
    used_chunks = chunks[:MAX_PROMPT_CHUNKS] if strength == "strong" else chunks[:3]
    academic_intent = classify_academic_intent(QUESTION, used_chunks, {"tutor_mode": "explain"})
    system_prompt, answer_mode = pick_system_prompt(
        QUESTION, strength, used_chunks, tutor_mode="explain", intent=academic_intent,
    )
    context_block = _build_context_block(used_chunks, doc_names) if used_chunks else ""
    user_message = "QUESTION:\n" + QUESTION
    if context_block:
        user_message += "\n\nCOURSE CONTEXT:\n\n" + context_block

    settings = get_settings()
    model = settings.openai_generate_model_strong if answer_mode == "math" else settings.openai_generate_model
    print("answerMode:", answer_mode, "model:", model, "chunks:", len(used_chunks))

    run_once("cold", system_prompt, user_message, model)
    time.sleep(2)
    run_once("warm", system_prompt, user_message, model)
