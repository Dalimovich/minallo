"""Privacy-minimal timing events for the answer reliability pipeline."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# Only routing identifiers, bounded status values and counts belong in logs.
# An allowlist prevents future debug payloads from exposing conversation text.
_SCALAR_FIELDS = frozenset({
    "conversationId", "taskFamily", "relation", "speechAct", "evidenceRequirement",
    "executionLane", "sourceScope", "documentAccess", "selectedDocumentCount",
    "failureStage", "errorCode", "recoveryAttempted", "terminalState", "terminalEvent",
    "contextSectionHash", "activeDocumentId", "documentCount", "visiblePage",
    "imageCount", "resolvedAssistantMode", "workspaceRequired", "visualKind",
    "numericalValidation", "preDisplayVerification", "textFallbackAllowed",
    "taskType", "resolvedTaskPage", "identityResolutionMethod", "visualIdentityBinding",
    "allowCourseFallback", "activePdfFound", "activeDocumentIdPresent",
    "pageTextStatus", "pageTextChars", "scopedJobId", "jobId", "coverageIntent",
    "chunkCount", "exerciseVisibleOnPage", "exerciseVisibleOnVisiblePage",
    "result", "repairAttempts", "success", "semanticMismatch",
})
_LIST_FIELDS = frozenset({"identityEvidencePages", "preferredPages", "imageRegions"})


def _safe_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in metadata.items():
        if key in _SCALAR_FIELDS and (value is None or isinstance(value, (str, int, float, bool))):
            safe[key] = value
        elif key in _LIST_FIELDS and isinstance(value, (list, tuple)):
            safe[key] = [item for item in value if isinstance(item, (str, int, float, bool))][:100]
    return safe


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
        safe = _safe_metadata({**self.metadata, **metadata})
        log.info(
            "ai_pipeline_stage request_id=%s stage=%s status=%s duration_ms=%.1f metadata=%s",
            self.request_id,
            stage,
            status,
            duration_ms,
            safe,
        )


__all__ = ["PipelineObserver"]
