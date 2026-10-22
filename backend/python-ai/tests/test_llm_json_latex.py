"""LaTeX-in-JSON backslash repair (deep_learn / cheatsheet / quiz math)."""

import json
from contextlib import nullcontext
from types import SimpleNamespace

from app.services.llm_json import _parse_json_lenient, _salvage_string_value


def test_salvage_truncated_text_value():
    # A cheatsheet response cut off at the token cap: no closing quote/brace.
    bs = "\\"
    raw = '{"text": "## Kinematik' + bs + 'n$$x = v_0 t + ' + bs + 'frac{1}{2} a t^2$$' + bs + 'nmore'
    out = _salvage_string_value(raw, "text")
    assert out is not None
    assert r"\frac" in out          # LaTeX preserved, not eaten
    assert "## Kinematik\n" in out  # real newline decoded
    assert out.endswith("more")     # partial tail kept


def test_salvage_complete_value_stops_at_quote():
    out = _salvage_string_value('{"text": "abc", "x": 1}', "text")
    assert out == "abc"


def test_salvage_missing_key():
    assert _salvage_string_value('{"other": "z"}', "text") is None


def test_under_escaped_latex_is_repaired():
    # What a model actually emits: single-backslash LaTeX inside JSON, with
    # real escaped newlines for markdown. Build it so the backslashes are
    # literal single backslashes regardless of source escaping.
    bs = "\\"
    lesson = (
        "## H" + bs + "nText: $$ v = " + bs + "frac{" + bs + "triangle x}{" + bs + "triangle t} $$ "
        + bs + "rho " + bs + "beta " + bs + "Delta " + bs + "alpha " + bs + "nabla " + bs + "nu."
        + bs + "nStep two." + bs + "n" + bs + "nNext."
    )
    raw = '{"lesson": "' + lesson + '"}'
    out = _parse_json_lenient(raw)
    for tok in (r"\frac", r"\triangle", r"\rho", r"\beta", r"\Delta", r"\alpha", r"\nabla", r"\nu"):
        assert tok in out["lesson"], f"lost {tok}"
    assert "\nStep two.\n\nNext." in out["lesson"], "real newlines corrupted"


def test_valid_json_is_left_untouched():
    # Properly-escaped JSON (model doubled its backslashes) must round-trip
    # exactly — including a legitimate newline before a lowercase letter.
    original = {"a": "valid \\frac and a\nb and \"q\""}
    raw = json.dumps(original)
    out = _parse_json_lenient(raw)
    assert out == original, out


def test_valid_escaped_math_untouched():
    original = {"m": "$$\\frac{1}{2}\\nabla\\cdot E$$"}
    raw = json.dumps(original)
    assert _parse_json_lenient(raw) == original


def test_fenced_invalid_escape_repaired():
    bs = "\\"
    raw = "```json\n" + '{"x": "' + bs + "Delta = " + bs + 'sqrt{2}"}' + "\n```"
    out = _parse_json_lenient(raw)
    assert out["x"] == r"\Delta = \sqrt{2}", out["x"]


def test_chat_json_retries_transient_rate_limit(monkeypatch):
    from app.services import llm_json

    class RateLimited(Exception):
        status_code = 429

    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))],
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
    )
    attempts = []

    def create(**_):
        attempts.append(1)
        if len(attempts) == 1:
            raise RateLimited()
        return response

    client = SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=create),
    ))
    monkeypatch.setattr(llm_json, "get_openai_client", lambda: client)
    monkeypatch.setattr(llm_json, "llm_fanout_slot", nullcontext)
    monkeypatch.setattr(llm_json, "record_usage", lambda **_: None)
    monkeypatch.setattr(llm_json.time, "sleep", lambda _: None)

    result = llm_json.chat_json(system="Return JSON.", user="Test")

    assert result.data == {"ok": True}
    assert len(attempts) == 2
