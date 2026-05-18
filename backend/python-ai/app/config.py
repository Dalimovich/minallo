"""Centralised settings loaded from env vars (with .env support for local dev)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All runtime config. Same env var names as the Netlify functions reuse."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Supabase (reuse existing names so Netlify and Python read the same secrets)
    supabase_url: str = Field(..., alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(..., alias="SUPABASE_SERVICE_ROLE_KEY")

    # --- OpenAI
    openai_api_key: str = Field(..., alias="OPENAI_API_KEY")
    openai_generate_model: str = Field("gpt-4o-mini", alias="OPENAI_GENERATE_MODEL")
    openai_generate_model_strong: str = Field("gpt-4o", alias="OPENAI_GENERATE_MODEL_STRONG")
    openai_embedding_model: str = Field(
        "text-embedding-3-small", alias="OPENAI_EMBEDDING_MODEL"
    )
    openai_embedding_dim: int = Field(1536, alias="OPENAI_EMBEDDING_DIM")

    # --- Supabase Storage bucket holding the uploaded PDFs.
    # Same env var the existing Netlify uploader reads (defaults match).
    rag_storage_bucket: str = Field("course-documents", alias="RAG_STORAGE_BUCKET")

    # --- Shared secret between Netlify and this service.
    # Same env var the existing Netlify trigger-processing flow already uses
    # (see backend/lib/trigger-processing.js) so we don't introduce a second
    # secret to rotate. Every internal request must arrive with
    # `X-Internal-Token: <this value>`.
    ai_service_internal_token: str = Field(..., alias="INTERNAL_SECRET")

    # --- Phase 12: vision OCR fallback. Off by default — costs an API
    # call per bad page on every indexing run, so we only enable it on
    # documents the OCR-need detector (Phase 11) flagged.
    vision_ocr_enabled: bool = Field(False, alias="MINALLO_VISION_OCR_ENABLED")
    vision_ocr_model: str = Field("gpt-4o-mini", alias="MINALLO_VISION_OCR_MODEL")
    vision_ocr_max_pages: int = Field(20, alias="MINALLO_VISION_OCR_MAX_PAGES")
    vision_ocr_render_dpi: int = Field(150, alias="MINALLO_VISION_OCR_DPI")

    # --- Misc
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    environment: str = Field("development", alias="ENVIRONMENT")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
