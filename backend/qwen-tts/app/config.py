from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Shared secret between python-ai and this service. Never exposed
    # to the public internet directly — python-ai is the only caller.
    internal_token: str = Field(..., alias="QWEN_TTS_INTERNAL_SECRET")

    environment: str = Field("production", alias="ENVIRONMENT")
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    # --- Model / voice.
    model_id: str = Field("Qwen/Qwen3-TTS-12Hz-0.6B-Base", alias="QWEN_TTS_MODEL_ID")
    model_cache_dir: str = Field("/models", alias="QWEN_TTS_MODEL_CACHE_DIR")
    default_voice: str = Field("minallo-de-1", alias="QWEN_TTS_DEFAULT_VOICE")

    # One approved German reference clip + its exact transcript (Thorsten-Voice
    # CC0), baked into the image at build time — see deploy/README.md. The
    # voice-clone prompt built from these is reused for every request; it is
    # never rebuilt per-generation (that's the whole latency point).
    reference_audio_path: str = Field(
        "app/voice/minallo_german_reference.wav", alias="QWEN_TTS_REFERENCE_AUDIO_PATH"
    )
    reference_transcript_path: str = Field(
        "app/voice/minallo_german_reference.txt", alias="QWEN_TTS_REFERENCE_TRANSCRIPT_PATH"
    )

    # --- Request limits. This service has no auth of its own beyond the
    # internal token — python-ai is responsible for per-user rate limiting
    # and input validation before it ever calls here, but we still bound
    # things defensively in case that layer is ever bypassed or misconfigured.
    max_text_length: int = Field(2000, alias="QWEN_TTS_MAX_TEXT_LENGTH")
    max_concurrency: int = Field(2, alias="QWEN_TTS_MAX_CONCURRENCY")
    generate_timeout_s: float = Field(120.0, alias="QWEN_TTS_GENERATE_TIMEOUT_S")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
