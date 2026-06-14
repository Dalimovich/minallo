# Minallo AI/RAG service.
# Slim Python 3.11 base. No OCR in v1 — tesseract added later if needed.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

WORKDIR /app

# System deps kept minimal. pdfminer.six is pure-Python; no native deps needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cached layer)
COPY pyproject.toml ./
RUN pip install --upgrade pip \
 && pip install .

# Copy application
COPY app ./app

EXPOSE 8080

# Health check used by Fly / Render / Railway
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

# --max-requests recycles each worker after ~N requests (+ jitter so the two
# workers don't restart in lockstep) to shed slow memory growth / fragmentation
# from PDF rasterization on the 2 GB box. Set high so a recycle rarely lands on
# a long generation/stream; graceful-timeout lets in-flight requests finish, and
# Phase-2a recovery re-queues any indexing a recycle interrupts.
CMD ["gunicorn", "app.main:app", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8080", "--timeout", "120", "--graceful-timeout", "30", "--max-requests", "2000", "--max-requests-jitter", "200"]
