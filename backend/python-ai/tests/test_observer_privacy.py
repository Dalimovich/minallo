"""Actual observer logging regression; uses only synthetic private content.

Run from backend/python-ai with PYTHONPATH=.:
  .venv/Scripts/python.exe -m pytest ../../audit/repros/test_observer_privacy.py -q
"""

import logging
from dataclasses import replace

from app.services.dialogue_state import resolve_dialogue
from app.services.pipeline_observability import PipelineObserver


def test_dialogue_observer_preserves_routing_without_logging_private_text(caplog):
    private_question = "SYNTHETIC_PRIVATE_QUESTION_9E22"
    private_document = "SYNTHETIC_DOCUMENT_EXCERPT_6A51"
    private_referent = "SYNTHETIC_PRIVATE_REFERENT_3B08"
    dialogue = replace(
        resolve_dialogue("Explain torque"),
        original_message=private_question,
        resolved_request=private_document,
        referent_text=private_referent,
    )
    with caplog.at_level(logging.INFO, logger="app.services.pipeline_observability"):
        PipelineObserver("audit-request-privacy").event(
            "turn_resolved", **dialogue.to_api(),
            taskFamily=dialogue.task_family.value,
            speechAct=dialogue.speech_act.value,
            evidenceRequirement=dialogue.evidence_requirement.value,
            selectedDocumentCount=2,
        )
    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert "audit-request-privacy" in emitted
    assert "turn_resolved" in emitted
    assert "taskFamily" in emitted
    assert "speechAct" in emitted
    assert "evidenceRequirement" in emitted
    assert "selectedDocumentCount" in emitted
    for secret in (private_question, private_document, private_referent):
        assert secret not in emitted


def test_observer_rejects_unknown_nested_metadata(caplog):
    secret = "SYNTHETIC_NESTED_SECRET_1D70"
    with caplog.at_level(logging.INFO, logger="app.services.pipeline_observability"):
        PipelineObserver("audit-nested", metadata={"futureDebugPayload": {"text": secret}}).event(
            "request_terminal", terminalState="failed", errorCode="provider_unavailable",
        )
    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert "provider_unavailable" in emitted
    assert "terminalState" in emitted
    assert secret not in emitted
