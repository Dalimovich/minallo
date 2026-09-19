from types import SimpleNamespace

from app.services import gen_timing, llm_json


class _FakeCompletions:
    def create(self, **kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
        )


def _patch(monkeypatch):
    client = SimpleNamespace(chat=SimpleNamespace(completions=_FakeCompletions()))
    client.with_options = lambda **kw: client
    monkeypatch.setattr(llm_json, "get_openai_client", lambda: client)
    monkeypatch.setattr(llm_json, "record_usage", lambda **kw: None)
    monkeypatch.setattr(llm_json, "usage_from_response", lambda resp: {})


def test_calls_recorded_including_worker_threads(monkeypatch):
    _patch(monkeypatch)
    with gen_timing.timed_request("language_elements", "sprachbausteine_1") as timer:
        llm_json.chat_json(system="s", user="u", model="gpt-4o")
        with gen_timing.ContextThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: llm_json.chat_json(system="s", user="u", model="gpt-5.4-mini", reasoning_effort="medium"), range(3)))
        summary = gen_timing.finish(timer, "ok")
    assert summary["llmCalls"] == 4
    assert summary["outcome"] == "ok" and summary["requestId"]
    assert set(summary["models"]) == {"gpt-4o:default", "gpt-5.4-mini:medium"}
    assert "slotWaitMsSum" in summary and "fanoutAtStart" in summary


def test_no_timer_means_no_recording(monkeypatch):
    _patch(monkeypatch)
    assert gen_timing.current() is None
    assert llm_json.chat_json(system="s", user="u").data == {"ok": True}
