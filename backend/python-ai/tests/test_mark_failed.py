"""_mark_failed must not disable a document that already had a healthy
active revision — a failed candidate rebuild never touches the active
revision's own rows, so the document must stay usable. See indexing.py's
`was_previously_ready` / `preserve_active` plumbing."""
from __future__ import annotations

from app.services.indexing import _mark_failed


class _FakeQuery:
    def __init__(self, captured: dict) -> None:
        self._captured = captured

    def update(self, payload):  # noqa: ANN001
        self._captured["payload"] = payload
        return self

    def eq(self, *a, **k):  # noqa: ANN002
        return self

    def execute(self):
        return self


class _FakeSB:
    def __init__(self) -> None:
        self.captured: dict = {}

    def table(self, _name: str) -> _FakeQuery:
        return _FakeQuery(self.captured)


def test_preserve_active_keeps_processing_status_untouched() -> None:
    sb = _FakeSB()
    _mark_failed(sb, "doc-1", "candidate index revision failed coverage validation", preserve_active=True)
    payload = sb.captured["payload"]
    assert "processing_status" not in payload
    assert payload["index_revision_status"] == "ready"
    assert "failed coverage validation" in payload["processing_error"]


def test_no_prior_revision_marks_document_failed() -> None:
    sb = _FakeSB()
    _mark_failed(sb, "doc-2", "0 chunks produced", preserve_active=False)
    payload = sb.captured["payload"]
    assert payload["processing_status"] == "failed"
    assert "index_revision_status" not in payload
