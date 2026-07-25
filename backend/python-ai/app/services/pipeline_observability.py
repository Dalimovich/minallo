"""Privacy-minimal timing events for the answer reliability pipeline."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class PipelineObserver:
    request_id: str
    metadata: dict[str, Any] = field(default_factory=dict)
    _starts: dict[str, float] = field(default_factory=dict)

    def start(self, stage: str, **metadata: Any) -> None:
        self._starts[stage] = time.perf_counter()
        self._emit(stage, "started", 0.0, metadata)

    def finish(self, stage: str, **metadata: Any) -> None:
        started = self._starts.pop(stage, time.perf_counter())
        self._emit(
            stage,
            "completed",
            (time.perf_counter() - started) * 1000,
            metadata,
        )

    def event(self, stage: str, **metadata: Any) -> None:
        self._emit(stage, "completed", 0.0, metadata)

    def _emit(
        self,
        stage: str,
        status: str,
        duration_ms: float,
        metadata: dict[str, Any],
    ) -> None:
        safe = {
            key: value
            for key, value in {**self.metadata, **metadata}.items()
            if key not in {"imageBase64", "documentText", "openContext"}
        }
        log.info(
            "ai_pipeline_stage request_id=%s stage=%s status=%s duration_ms=%.1f metadata=%s",
            self.request_id,
            stage,
            status,
            duration_ms,
            safe,
        )


__all__ = ["PipelineObserver"]
