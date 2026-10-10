from types import SimpleNamespace

import pytest

from app.services import llm_json


@pytest.mark.parametrize("model,token_key", [("gpt-4o-mini", "max_tokens"), ("gpt-5.4-mini", "max_completion_tokens")])
@pytest.mark.parametrize("schema", [None, {"type": "object", "properties": {}, "additionalProperties": False, "required": []}])
def test_schema_and_token_budget_forwarded(monkeypatch, model, token_key, schema):
    calls = []
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(model=model, usage=None, choices=[SimpleNamespace(
            message=SimpleNamespace(content="{}"), finish_reason="stop")])
    monkeypatch.setattr(llm_json, "get_openai_client", lambda: SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    monkeypatch.setattr(llm_json, "record_usage", lambda **kwargs: None)
    result = llm_json.chat_json(system="JSON", user="test", model=model, max_tokens=1234, json_schema=schema)
    assert result.data == {}
    assert calls[0][token_key] == 1234
    expected = ({"type": "json_schema", "json_schema": {
        "name": "structured_result", "strict": True, "schema": schema}} if schema else {"type": "json_object"})
    assert calls[0]["response_format"] == expected
