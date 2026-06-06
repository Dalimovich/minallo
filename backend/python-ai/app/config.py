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
    # Reasoning effort for o-series strong models (low | medium | high).
    # "low" is faster/cheaper; "medium" is the safe default that solves the
    # multi-phase kinematics correctly. Ignored for non-reasoning models.
    openai_reasoning_effort: str = Field("medium", alias="OPENAI_REASONING_EFFORT")
    openai_embedding_model: str = Field(
        "text-embedding-3-small", alias="OPENAI_EMBEDDING_MODEL"
    )
    openai_embedding_dim: int = Field(1536, alias="OPENAI_EMBEDDING_DIM")

    # --- Supabase Storage bucket holding the uploaded PDFs.
    # Same env var the existing Netlify uploader reads (defaults match).
    rag_storage_bucket: str = Field("course-uploads", alias="RAG_STORAGE_BUCKET")

    # --- Shared secret between Netlify and this service.
    # Same env var the existing Netlify trigger-processing flow already uses
    # (see backend/lib/trigger-processing.js) so we don't introduce a second
    # secret to rotate. Every internal request must arrive with
    # `X-Internal-Token: <this value>`.
    ai_service_internal_token: str = Field(..., alias="INTERNAL_SECRET")

    # --- Phase 12: vision OCR fallback. Enabled by default for weak pages
    # that the OCR-need detector flags; set the env var to false to avoid
    # vision-model indexing costs.
    vision_ocr_enabled: bool = Field(True, alias="MINALLO_VISION_OCR_ENABLED")
    vision_ocr_model: str = Field("gpt-4o-mini", alias="MINALLO_VISION_OCR_MODEL")
    vision_ocr_max_pages: int = Field(20, alias="MINALLO_VISION_OCR_MAX_PAGES")
    vision_ocr_render_dpi: int = Field(150, alias="MINALLO_VISION_OCR_DPI")
    # Handwritten notes need a little more raster detail than printed pages,
    # but usually not the full Mathpix/formula-sheet DPI.
    vision_ocr_handwriting_dpi: int = Field(
        220, alias="MINALLO_VISION_OCR_HANDWRITING_DPI"
    )
    # Kept under the main vision OCR gate; this only chooses the handwriting
    # prompt/preprocess path for likely handwritten pages.
    handwriting_ocr_enabled: bool = Field(True, alias="MINALLO_HANDWRITING_OCR_ENABLED")
    # Formula pages need finer rendering — subscripts, indices and the
    # numerator/denominator of small fractions blur at 150 DPI. Mathpix
    # (the formula path) renders at this higher DPI; the OpenAI path keeps
    # the cheaper default above.
    vision_ocr_mathpix_dpi: int = Field(300, alias="MINALLO_VISION_OCR_MATHPIX_DPI")

    # --- Schreibtrainer: persistence stays off until the migrations land.
    # Flip to true once user_writing_submissions / user_writing_weaknesses
    # tables exist (docs/schreibtrainer-ai-spec.md §14 + §20).
    writing_coach_persistence_enabled: bool = Field(
        False, alias="WRITING_COACH_PERSISTENCE_ENABLED"
    )

    # --- Misc
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    environment: str = Field("development", alias="ENVIRONMENT")


    # --- Mathpix vision OCR. Optional second provider routed to from
    # `vision_ocr.pages_via_vision` for formula-dense pages when both
    # credentials are present and routing != "off". Stays disabled if
    # either credential is missing.
    mathpix_app_id: str | None = Field(None, alias="MATHPIX_APP_ID")
    mathpix_app_key: str | None = Field(None, alias="MATHPIX_APP_KEY")
    mathpix_routing: str = Field("off", alias="MINALLO_MATHPIX_ROUTING")
    # "off"                — never use Mathpix
    # "formulasheet_only"  — only for filenames matching the Formelzettel pattern
    # "always"             — every OCR page goes to Mathpix


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
