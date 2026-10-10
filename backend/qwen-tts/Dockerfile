# Isolated Qwen3-TTS inference service. Deliberately NOT the same image/host
# as backend/python-ai — see backend/qwen-tts/deploy/README.md for why.
#
# CPU-only base by default. If/when this runs on a GPU host, swap the FROM
# line for an nvidia/cuda devel-or-runtime base matching the installed torch
# build (e.g. nvidia/cuda:12.4.1-runtime-ubuntu22.04) and add the CUDA torch
# wheel index to the pip install step below — do not attempt that swap
# without first confirming the actual GPU box's driver/CUDA version.

FROM python:3.11-slim AS base

ARG MINALLO_REVISION=unknown

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8090 \
    MINALLO_REVISION=${MINALLO_REVISION} \
    QWEN_TTS_MODEL_CACHE_DIR=/models

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --upgrade pip \
 && pip install .

RUN addgroup --system qwentts \
 && adduser --system --ingroup qwentts --home /app qwentts
COPY --chown=qwentts:qwentts app ./app

# Model weights are downloaded into this volume on first boot (see
# compose.yaml's qwen_models volume) rather than baked into the image, so a
# code-only redeploy doesn't re-pull multiple GB. The one approved German
# reference clip + transcript IS baked into the image (app/voice/) since it's
# tiny and must never silently drift — see deploy/README.md.
RUN mkdir -p /models && chown qwentts:qwentts /models
VOLUME ["/models"]

EXPOSE 8090

USER qwentts

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://localhost:8090/health || exit 1

# Single worker: the model is loaded once per process (see app/main.py's
# lifespan) and generation is internally serialized via a semaphore
# (QWEN_TTS_MAX_CONCURRENCY) — running multiple gunicorn workers would load
# multiple copies of a 2GB+ model into RAM for no throughput benefit on a
# single-model-instance design. Raise worker count only after moving to a
# host with enough RAM/VRAM for N model copies AND confirming the model
# object is safe to share/replicate that way.
CMD ["gunicorn", "app.main:app", "-k", "uvicorn.workers.UvicornWorker", "-w", "1", "-b", "0.0.0.0:8090", "--timeout", "150", "--graceful-timeout", "30"]
