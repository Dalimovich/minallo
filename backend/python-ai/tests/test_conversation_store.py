from __future__ import annotations

from types import SimpleNamespace

from app.services import conversation_store


class FakeTable:
    def __init__(self, db: "FakeSupabase", name: str):
        self.db = db
        self.name = name
        self.filters: dict[str, str] = {}
        self.operation = "select"
        self.payload: dict | None = None

    def select(self, *_args):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def limit(self, _value):
        return self

    def insert(self, payload):
        self.operation, self.payload = "insert", payload
        return self

    def upsert(self, payload, **_kwargs):
        self.operation, self.payload = "upsert", payload
        return self

    def execute(self):
        rows = self.db.rows[self.name]
        if self.operation == "insert":
            rows.append(dict(self.payload or {}))
            return SimpleNamespace(data=[self.payload])
        if self.operation == "upsert":
            key = (self.payload or {}).get("client_message_id")
            if not any(row.get("client_message_id") == key for row in rows):
                rows.append(dict(self.payload or {}))
            return SimpleNamespace(data=[self.payload])
        matched = [
            row for row in rows
            if all(str(row.get(key)) == str(value) for key, value in self.filters.items())
        ]
        return SimpleNamespace(data=matched)


class FakeSupabase:
    def __init__(self):
        self.rows = {"ai_chat_conversations": [], "ai_chat_messages": []}

    def table(self, name):
        return FakeTable(self, name)


def test_ensure_is_idempotent_and_persists_user_message(monkeypatch) -> None:
    db = FakeSupabase()
    monkeypatch.setattr(conversation_store, "get_supabase", lambda: db)

    first = conversation_store.ensure_durable_conversation(
        user_id="user",
        client_conversation_id="local-chat",
        course_id="course",
        active_document_id=None,
        title_seed="Kurzfragen",
        client_message_id="message-1",
        message_text="Explain every question.",
    )
    second = conversation_store.ensure_durable_conversation(
        user_id="user",
        client_conversation_id="local-chat",
        course_id="course",
        active_document_id=None,
        title_seed="Kurzfragen",
        client_message_id="message-1",
        message_text="Explain every question.",
    )

    assert first.created is True
    assert second.created is False
    assert second.conversation_id == first.conversation_id
    assert len(db.rows["ai_chat_conversations"]) == 1
    assert len(db.rows["ai_chat_messages"]) == 1


def test_validation_is_user_scoped(monkeypatch) -> None:
    db = FakeSupabase()
    db.rows["ai_chat_conversations"].append({"id": "conversation", "user_id": "owner"})
    monkeypatch.setattr(conversation_store, "get_supabase", lambda: db)

    assert conversation_store.validate_durable_conversation(
        user_id="owner", conversation_id="conversation",
    )
    assert not conversation_store.validate_durable_conversation(
        user_id="different-user", conversation_id="conversation",
    )
