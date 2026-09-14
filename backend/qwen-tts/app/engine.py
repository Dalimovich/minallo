"""Qwen3-TTS wrapper: load the model once, build the voice-clone prompt once,
reuse both for every request.

API surface follows the qwen-tts package's documented `Qwen3TTSModel` /
create_voice_clone_prompt / generate_voice_clone contract. Pin the installed
`qwen-tts` version deliberately (pyproject.toml) — if a future release renames
these entry points, startup below fails fast (surfaced via /health) rather
than silently degrading output.
"""

import io
import logging
import threading
import time
from pathlib import Path

from .config import get_settings

log = logging.getLogger("qwen-tts")


class TTSGenerationError(RuntimeError):
    pass


class QwenTTSEngine:
    def __init__(self) -> None:
        self._model = None
        self._voice_prompt = None
        # generate_voice_clone is not confirmed thread-safe across concurrent
        # calls on one model instance; serialize with a bounded semaphore
        # instead (max_concurrency), rather than a single global lock, so a
        # slow request doesn't fully block a second one on a multi-core host.
        self._sem = threading.Semaphore(get_settings().max_concurrency)
        self._ready = threading.Event()
        self._load_error: str | None = None

    def load(self) -> None:
        """Called once at process startup (see main.py lifespan). Blocking —
        this is the ~model-download-and-warm-up cost, intentionally paid
        once per process, not per request."""
        settings = get_settings()
        started = time.monotonic()
        try:
            from qwen_tts import Qwen3TTSModel  # noqa: PLC0415 (heavy import, load on demand)

            log.info("loading %s ...", settings.model_id)
            self._model = Qwen3TTSModel.from_pretrained(
                settings.model_id,
                cache_dir=settings.model_cache_dir,
            )

            ref_audio = Path(settings.reference_audio_path)
            ref_text_path = Path(settings.reference_transcript_path)
            if not ref_audio.exists() or not ref_text_path.exists():
                raise TTSGenerationError(
                    f"Reference voice files missing: {ref_audio} / {ref_text_path}. "
                    "See backend/qwen-tts/deploy/README.md for how to obtain the "
                    "Thorsten-Voice CC0 reference clip + transcript."
                )
            ref_text = ref_text_path.read_text(encoding="utf-8").strip()

            log.info("building voice-clone prompt from %s ...", ref_audio)
            self._voice_prompt = self._model.create_voice_clone_prompt(
                ref_audio=str(ref_audio),
                ref_text=ref_text,
                x_vector_only_mode=False,
            )
            self._ready.set()
            log.info("qwen3-tts ready in %.1fs", time.monotonic() - started)
        except Exception as exc:  # noqa: BLE001
            self._load_error = str(exc)
            log.exception("qwen3-tts failed to load")
            raise

    def is_ready(self) -> bool:
        return self._ready.is_set()

    def load_error(self) -> str | None:
        return self._load_error

    def generate(self, text: str, language: str = "German") -> tuple[bytes, int]:
        """Returns (wav_bytes, duration_ms). Reuses the prompt built at
        startup — never recreated per call."""
        if not self._ready.is_set() or self._model is None or self._voice_prompt is None:
            raise TTSGenerationError("model not ready")

        acquired = self._sem.acquire(timeout=get_settings().generate_timeout_s)
        if not acquired:
            raise TTSGenerationError("too many concurrent generations")
        try:
            result = self._model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=self._voice_prompt,
            )
            # qwen-tts returns (audio_array, sample_rate) per its docs; encode
            # to WAV bytes here so the router/storage layer never touches
            # raw numpy arrays.
            audio_array, sample_rate = result
            import soundfile as sf  # noqa: PLC0415

            buf = io.BytesIO()
            sf.write(buf, audio_array, sample_rate, format="WAV")
            wav_bytes = buf.getvalue()
            duration_ms = int(len(audio_array) / float(sample_rate) * 1000)
            return wav_bytes, duration_ms
        finally:
            self._sem.release()


_engine: QwenTTSEngine | None = None


def get_engine() -> QwenTTSEngine:
    global _engine
    if _engine is None:
        _engine = QwenTTSEngine()
    return _engine
