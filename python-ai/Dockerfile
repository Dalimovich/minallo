# StudySphere AI/RAG service.
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

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
