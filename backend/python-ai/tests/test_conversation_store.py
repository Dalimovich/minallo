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

    def order(self, _value):
        return self

    def insert(self, payload):
        self.operation, self.payload = "insert", payload
        return self

    def upsert(self, payload, **_kwargs):
        self.operation, self.payload = "upsert", payload
        return self

    def update(self, payload):
        self.operation, self.payload = "update", payload
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
        if self.operation == "update":
            matched = [
                row for row in rows
                if all(str(row.get(key)) == str(value) for key, value in self.filters.items())
            ]
            for row in matched:
                row.update(dict(self.payload or {}))
            return SimpleNamespace(data=matched)
        matched = [
            row for row in rows
            if all(str(row.get(key)) == str(value) for key, value in self.filters.items())
        ]
        return SimpleNamespace(data=matched)


class FakeSupabase:
    def __init__(self):
        self.rows = {"ai_chat_conversations": [], "ai_chat_messages": [], "ai_tutor_requests": []}
        self.rpc_calls: list[tuple[str, dict]] = []

    def table(self, name):
        return FakeTable(self, name)

    def rpc(self, name, payload):
        self.rpc_calls.append((name, payload))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=None))


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


def test_full_transcript_hydration_is_ordered_and_user_scoped(monkeypatch) -> None:
    db = FakeSupabase()
    db.rows["ai_chat_conversations"].append({"id": "conversation", "user_id": "owner"})
    db.rows["ai_chat_messages"].extend([
        {"conversation_id": "conversation", "user_id": "owner", "client_message_id": "u-1", "role": "user", "content": "First"},
        {"conversation_id": "conversation", "user_id": "owner", "client_message_id": "a-1", "role": "assistant", "content": "Answer"},
        {"conversation_id": "conversation", "user_id": "other", "client_message_id": "secret", "role": "user", "content": "Private"},
    ])
    db.rows["ai_tutor_requests"].append({
        "conversation_id": "conversation", "user_id": "owner",
        "request_id": "request-1", "user_client_message_id": "u-1",
        "assistant_client_message_id": "a-1", "scoped_job_id": "job-1",
    })
    monkeypatch.setattr(conversation_store, "get_supabase", lambda: db)

    rows = conversation_store.get_durable_conversation_messages(
        user_id="owner", conversation_id="conversation",
    )
    assert [row["client_message_id"] for row in rows] == ["u-1", "a-1"]
    assert rows[1]["request_id"] == "request-1"
    assert rows[1]["scoped_job_id"] == "job-1"
    assert conversation_store.get_durable_conversation_messages(
        user_id="other", conversation_id="conversation",
    ) == []


def test_create_turn_uses_atomic_database_function(monkeypatch) -> None:
    db = FakeSupabase()
    monkeypatch.setattr(conversation_store, "get_supabase", lambda: db)

    conversation_store.create_durable_tutor_turn(
        user_id="user", conversation_id="conversation",
        user_message_id="u-1", user_content="Question",
        assistant_message_id="a-1", request_id="request-1",
        request_snapshot={"activeDocumentId": "doc-1", "visiblePage": 3},
    )

    assert db.rpc_calls == [("create_ai_tutor_turn", {
        "p_conversation_id": "conversation", "p_user_id": "user",
        "p_user_message_id": "u-1", "p_user_content": "Question",
        "p_assistant_message_id": "a-1", "p_request_id": "request-1",
        "p_request_snapshot": {"activeDocumentId": "doc-1", "visiblePage": 3},
    })]


def test_completed_continuation_preserves_saved_partial(monkeypatch) -> None:
    db = FakeSupabase()
    db.rows["ai_tutor_requests"].append({
        "request_id": "request-1", "user_id": "user", "conversation_id": "conversation",
        "assistant_client_message_id": "a-1", "partial_answer": "Saved first half",
    })
    db.rows["ai_chat_messages"].append({
        "conversation_id": "conversation", "client_message_id": "a-1", "content": "",
    })
    monkeypatch.setattr(conversation_store, "get_supabase", lambda: db)

    conversation_store.update_tutor_request(
        user_id="user", request_id="request-1", status="completed",
        stage="completed", final_answer="New second half", retryable=False,
    )

    assert db.rows["ai_tutor_requests"][0]["final_answer"] == "Saved first half\n\nNew second half"
    assert db.rows["ai_chat_messages"][0]["content"] == "Saved first half\n\nNew second half"
    assert db.rows["ai_chat_messages"][0]["completion_state"] == "complete"
