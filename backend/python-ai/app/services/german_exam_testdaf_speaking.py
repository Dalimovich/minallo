"""TestDaF digital speaking (Sprechen 1-7) — independent, non-interactive recordings.

Architecturally distinct from telc's interactive partner-dialogue model
(german_exam_speaking_practice.py, GRADABLE_SPEAKING_PROFILE_IDS={telc_c1_hochschule}): no
partner turns, no shared session state. Each of TestDaF's 7 tasks is one standalone recording,
submitted through the SAME generic grade_productive(part, content, submission, grader=...)
contract (german_exam_productive.py) that TestDaF/Goethe writing already use — not a copy of
telc's speaking dispatch, not a new parallel grading pipeline.

This module supplies the grader: honest, qualitative-only evaluation of a TRANSCRIPT. It never
fetches a recording, calls a transcription API, or knows how the recording reached it — see
"OPEN INTEGRATION QUESTION" below for exactly what remains before this can be wired to a real
route.

Never scores "pronunciation" at all (zero signal survives transcription) and restricts
"fluency" to disfluency markers actually visible in the transcript (filler words, repeated
words, self-corrections) — never inferred pacing, pausing or rhythm. Mirrors
german_exam_speaking_practice.py's own rule for telc: "the text evaluator NEVER scores acoustic
fluency or pronunciation." validate_feedback() (german_exam_productive.py) separately and
structurally forbids this module from ever returning a numeric official score
(scaledScore/tdn/pass/officialScore/rawScore) regardless of what it's asked for.

transcribe_testdaf_speaking_recording() below supplies the one piece that's storage-agnostic by
construction: already-obtained audio bytes -> timestamped segments, via whisper-1's
verbose_json (NOT telc's gpt-4o-mini-transcribe/`response_format="json"`, which returns no
segment timestamps at all — this module's evidence.startSeconds needs real ones). It never
fetches, uploads, or persists a recording itself.

OPEN INTEGRATION QUESTION (still deliberately NOT resolved here — see the backlog report, not a
code TODO): speaking-task.ts's mountSpeaking() already has a two-phase UI (upload() ->
{recordingId}, then grader({recordingId, durationSeconds})) with upload() currently stubbed
'Upload is not connected'. Wiring a real `upload` needs a genuine architectural decision this
module does not make: (a) persist the recording in a private bucket (mirrors storage.py's
existing upload_exam_video/signed_video_url pattern) and delete it immediately after
transcription succeeds — keeps the existing two-phase UI exactly as built, but needs a new
bucket + migration + retention policy for voice data; or (b) redesign mountSpeaking() into a
single combined upload-and-grade call so no recording is ever persisted server-side at all,
matching telc's own german_exam_speaking_practice.transcribe() precedent exactly (audio arrives
base64-encoded in the request, is transcribed synchronously, and is never written to storage at
all) — at the cost of changing an already-built, tested UI flow. Both are legitimate; this is a
product decision about handling a learner's voice recording, not an engineering one this module
should make unilaterally.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from ..config import get_settings
from .german_exam_productive import SPEAKING_TYPES
from .german_exam_speaking_practice import MIME_EXTENSIONS
from .llm_json import chat_json
from .openai_client import get_openai_client
from .usage_meter import record_usage

# Mirrors german_exam_speaking_practice.transcribe()'s own bound — not re-derived per task type.
_MAX_RECORDING_BYTES = 6 * 1024 * 1024

# Zero signal survives transcription to text — never scored, regardless of what the model returns.
_PRONUNCIATION_ONLY_DIMENSION = "pronunciation"
_NOT_ASSESSABLE_MESSAGE = (
    "Not assessable from a text transcript alone — this practice tool only has access to the "
    "transcribed words, not the actual audio. Practice this with a native speaker, a "
    "pronunciation app, or by listening back to your own recording."
)
# "fluency" keeps a narrow, honest signal: disfluency markers a transcript can actually show
# (filler words, repeated words, self-corrections) — never pacing, pausing or rhythm.
_FLUENCY_DIMENSION = "fluency"


def _quotable_segment(quote: str, segments: list[dict[str, Any]], duration_seconds: float) -> dict[str, Any] | None:
    """Only ever returns evidence for a quote that is a literal, locatable substring of some
    transcript segment, with a timestamp that satisfies validate_feedback's own bound
    (0 <= startSeconds < durationSeconds) — never fabricates either."""
    quote = quote.strip()
    if not quote:
        return None
    for segment in segments:
        text = (segment.get("text") or "")
        start = segment.get("start")
        if quote in text and isinstance(start, (int, float)) and 0 <= start < duration_seconds:
            return {"quote": quote, "startSeconds": float(start)}
    return None


def transcribe_testdaf_speaking_recording(
    audio_base64: str, mime_type: str, *, user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Pure transport: base64-encoded audio -> timestamped transcript segments. Storage-agnostic —
    how these bytes were obtained (fetched from storage, or carried directly in a request) is
    deliberately out of scope here; see the module docstring's OPEN INTEGRATION QUESTION for what
    still has to be decided before this can be wired to a real recordingId/upload path."""
    mime = mime_type.split(";")[0]
    if mime not in MIME_EXTENSIONS:
        raise ValueError("Unsupported recording format")
    try:
        audio = base64.b64decode(audio_base64, validate=True)
    except Exception as exc:
        raise ValueError("Invalid audio encoding") from exc
    if not 100 <= len(audio) <= _MAX_RECORDING_BYTES:
        raise ValueError("Recording must contain audio and be under 6 MB")
    model = "whisper-1"
    result = get_openai_client().audio.transcriptions.create(
        model=model, file=(f"speech.{MIME_EXTENSIONS[mime]}", audio, mime),
        language="de", response_format="verbose_json", timeout=90,
    )
    usage = getattr(result, "usage", None)
    record_usage(feature="testdaf_speaking_transcription", model=model, user_id=user_id,
                 prompt_tokens=getattr(usage, "input_tokens", 0), completion_tokens=getattr(usage, "output_tokens", 0))
    segments: list[dict[str, Any]] = []
    for raw in getattr(result, "segments", None) or ():
        start, end = getattr(raw, "start", None), getattr(raw, "end", None)
        text = (getattr(raw, "text", None) or "").strip()
        if text and isinstance(start, (int, float)) and isinstance(end, (int, float)):
            segments.append({"start": float(start), "end": float(end), "text": text})
    if not segments:
        raise ValueError("No usable speech detected. Please record again.")
    return segments


def grade_testdaf_speaking_transcript(
    request: dict[str, Any], segments: list[dict[str, Any]], *, provider: Any = None
) -> dict[str, Any]:
    """Pure grading logic — no I/O beyond the injectable `provider` (defaults to chat_json).
    `request` is exactly what german_exam_productive.grading_request() builds (kind, taskType,
    dimensions, task, submission, constraints). `segments` is a transcription's timestamped
    segments: `[{"start": float, "end": float, "text": str}, ...]`. Returns feedback satisfying
    validate_feedback()'s full contract, including TestDaF speaking's startSeconds evidence
    requirement."""
    if request.get("taskType") not in SPEAKING_TYPES:
        raise ValueError(f"not a TestDaF speaking task type: {request.get('taskType')!r}")
    dimensions = list(request.get("dimensions") or ())
    if not dimensions:
        raise ValueError("request has no grading dimensions")
    duration_seconds = request.get("submission", {}).get("durationSeconds")
    if not isinstance(duration_seconds, (int, float)) or duration_seconds <= 0:
        raise ValueError("request is missing a valid submission.durationSeconds")

    full_text = " ".join(s.get("text", "").strip() for s in segments if isinstance(s.get("text"), str)).strip()
    if not full_text:
        raise ValueError("empty transcript — no usable speech detected")

    gradable = [d for d in dimensions if d != _PRONUNCIATION_ONLY_DIMENSION]
    call = provider or chat_json
    system = (
        "You are an honest, supportive examiner giving PRACTICE feedback on a Digital TestDaF "
        "speaking recording. You have ONLY the transcribed words — you cannot hear tone, pace, "
        "pauses or pronunciation, and must never guess at acoustic qualities from text. Judge "
        "strictly from the transcript against the task below. This is formative practice "
        "feedback only — never state or imply an official TDN/scaled score.\n\n"
        + (f"For the 'fluency' dimension specifically: judge ONLY disfluency markers actually "
           "visible in the transcript (filler words like 'äh'/'ähm', repeated words, visible "
           "self-corrections/restarts) — never infer speaking pace, pausing or rhythm, which "
           "require audio you do not have.\n\n" if _FLUENCY_DIMENSION in gradable else "")
        + f"Task given to the learner: {json.dumps(request.get('task'), ensure_ascii=False)}\n\n"
        f"Dimensions to assess: {gradable}\n\n"
        'Return JSON only: {"dimensions": {"<dimension_id>": {"feedback": "1-3 honest, specific '
        'sentences", "quotes": ["exact transcript excerpt", ...]}, ...}}. Every quote must be '
        "copied VERBATIM from the transcript — never paraphrase, translate or invent a quote; "
        "quotes may be an empty list if there is nothing specific to cite for that dimension."
    )
    result = call(system=system, user=json.dumps({"transcript": full_text}, ensure_ascii=False),
                   model=get_settings().german_exam_model, max_tokens=1500)
    raw = result.data if isinstance(result.data, dict) else {}
    raw_dimensions = raw.get("dimensions") if isinstance(raw.get("dimensions"), dict) else {}

    out_dimensions: list[dict[str, Any]] = []
    for dim_id in dimensions:
        if dim_id == _PRONUNCIATION_ONLY_DIMENSION:
            out_dimensions.append({"id": dim_id, "feedback": _NOT_ASSESSABLE_MESSAGE, "evidence": []})
            continue
        entry = raw_dimensions.get(dim_id) if isinstance(raw_dimensions.get(dim_id), dict) else {}
        feedback = entry.get("feedback")
        if not isinstance(feedback, str) or not feedback.strip():
            feedback = "No specific signal for this criterion in your response — try a longer or more detailed answer."
        quotes = entry.get("quotes") if isinstance(entry.get("quotes"), list) else []
        evidence = []
        for quote in quotes:
            if not isinstance(quote, str):
                continue
            located = _quotable_segment(quote, segments, duration_seconds)
            if located:  # never fabricate evidence for a quote the transcript doesn't actually contain
                evidence.append(located)
        out_dimensions.append({"id": dim_id, "feedback": feedback.strip(), "evidence": evidence[:3]})

    return {"kind": "practice_feedback", "dimensions": out_dimensions}
