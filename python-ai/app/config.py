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

    # --- Shared secret between Netlify proxy and this service.
    # Every request must arrive with `X-Internal-Token: <this value>`.
    ai_service_internal_token: str = Field(..., alias="AI_SERVICE_INTERNAL_TOKEN")

    # --- Misc
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    environment: str = Field("development", alias="ENVIRONMENT")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
