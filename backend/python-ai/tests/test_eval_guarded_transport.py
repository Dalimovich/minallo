"""scripts/eval_guarded_transport.py: the durable spend ledger every live
eval runner (Arm A/B/D) shares. Proves the 2026-10-24 completion-record
addition, crash-recovery semantics, retry attribution, and the hard-stop
budget guard -- against a fake inner httpx transport, no network."""

import json
import sys
from pathlib import Path

import httpx
import pytest

# See test_qa_budget.py for why this guarded reimport exists.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])
_scripts_pkg = sys.modules.get("scripts")
_scripts_already_correct = _scripts_pkg is not None and any(
    Path(p).resolve() == Path(_BACKEND_ROOT, "scripts") for p in getattr(_scripts_pkg, "__path__", [])
)
if not _scripts_already_correct:
    if _BACKEND_ROOT in sys.path:
        sys.path.remove(_BACKEND_ROOT)
    sys.path.insert(0, _BACKEND_ROOT)
    for _name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
        del sys.modules[_name]

from scripts.eval_guarded_transport import BudgetStop, EvalGuardedTransport  # noqa: E402

URL = "https://example.invalid/v1/chat/completions"


def _validate_and_price(body: dict) -> tuple[float, str]:
    return 0.01, str(body.get("model"))


def _read_ledger(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _request(model: str = "gpt-4o-mini", *, retry: int = 0) -> httpx.Request:
    headers = {"x-stainless-retry-count": str(retry)} if retry else {}
    return httpx.Request("POST", URL, json={"model": model}, headers=headers)


class _FakeInnerTransport(httpx.BaseTransport):
    def __init__(self, responder):
        self._responder = responder

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self._responder(request)

    def close(self) -> None:
        pass


def test_successful_attempt_writes_a_reservation_then_a_completion_line(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: httpx.Response(
        200, json={"model": "gpt-4o-mini-2024-07-18", "usage": {"input_tokens": 10, "output_tokens": 2}},
    ))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)
    guard.context = {"arm": "A", "scenario": "AB-01", "turn": 1}
    guard.handle_request(_request())

    lines = _read_ledger(ledger_path)
    assert len(lines) == 2
    reservation, completion = lines
    assert reservation["type"] == "reservation"
    assert reservation["arm"] == "A" and reservation["scenario"] == "AB-01"
    assert reservation["reserved_usd"] == 0.01
    assert completion["type"] == "completion"
    assert completion["status"] == 200
    assert completion["returned_model"] == "gpt-4o-mini-2024-07-18"
    assert completion["usage"] == {"input_tokens": 10, "output_tokens": 2}
    assert completion["error"] is None
    assert completion["cumulative_reserved_usd"] == 0.01
    assert isinstance(completion["latency_ms"], float)


def test_a_transport_error_still_writes_a_durable_completion_record(tmp_path):
    """The crash-recovery case: even when the call itself fails, the
    outcome (that it failed, and why) must be durably recorded -- never
    silently lost because only the in-memory attempt dict would have had it."""
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: (_ for _ in ()).throw(httpx.ConnectTimeout("boom")))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)

    with pytest.raises(httpx.ConnectTimeout):
        guard.handle_request(_request())

    lines = _read_ledger(ledger_path)
    assert len(lines) == 2
    reservation, completion = lines
    assert reservation["type"] == "reservation"
    assert completion["type"] == "completion"
    assert completion["status"] is None
    assert completion["error"] == "ConnectTimeout"
    # The reservation still counts -- a failed attempt was still a real risk.
    assert completion["cumulative_reserved_usd"] == 0.01


def test_reservation_survives_even_if_nothing_after_it_ever_runs(tmp_path):
    """Simulates a hard crash between the reservation write and the
    response: the reservation line alone, on disk, must already reflect
    the at-risk spend -- proven by reading the ledger file BEFORE the
    response is ever produced."""
    ledger_path = tmp_path / "ledger.jsonl"
    seen_mid_flight: list[list[dict]] = []

    def _responder(request: httpx.Request) -> httpx.Response:
        seen_mid_flight.append(_read_ledger(ledger_path))
        return httpx.Response(200, json={"model": "gpt-4o-mini", "usage": {}})

    inner = _FakeInnerTransport(_responder)
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)
    guard.handle_request(_request())

    assert len(seen_mid_flight[0]) == 1  # only the reservation existed when the "call" was in flight
    assert seen_mid_flight[0][0]["type"] == "reservation"


def test_sdk_retries_are_separate_attempts_with_their_own_ledger_lines(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: httpx.Response(200, json={"model": "gpt-4o-mini", "usage": {}}))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)
    guard.handle_request(_request(retry=0))
    guard.handle_request(_request(retry=1))

    lines = _read_ledger(ledger_path)
    reservations = [line for line in lines if line["type"] == "reservation"]
    assert [r["sdk_retry"] for r in reservations] == [0, 1]
    assert [r["attempt_number"] for r in reservations] == [1, 2]
    completions = [line for line in lines if line["type"] == "completion"]
    assert completions[1]["cumulative_reserved_usd"] == pytest.approx(0.02)


def test_cost_ceiling_stops_before_the_next_reservation_is_written(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: httpx.Response(200, json={"model": "gpt-4o-mini", "usage": {}}))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=100, budget_usd=0.015)
    guard.handle_request(_request())  # $0.01 spent, under $0.015
    with pytest.raises(BudgetStop):
        guard.handle_request(_request())  # would bring total to $0.02 > $0.015

    lines = _read_ledger(ledger_path)
    assert len(lines) == 2  # exactly one reservation + one completion -- the stopped attempt wrote nothing
    assert guard.spent_usd == 0.01


def test_request_count_ceiling_stops_before_the_next_reservation_is_written(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: httpx.Response(200, json={"model": "gpt-4o-mini", "usage": {}}))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=1, budget_usd=1.0)
    guard.handle_request(_request())
    with pytest.raises(BudgetStop):
        guard.handle_request(_request())

    assert len(_read_ledger(ledger_path)) == 2


def test_refuses_to_run_against_an_existing_ledger_path(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    ledger_path.touch()
    inner = _FakeInnerTransport(lambda req: httpx.Response(200, json={}))
    with pytest.raises(FileExistsError):
        EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)


def test_unapproved_endpoint_is_rejected_before_any_ledger_write(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    inner = _FakeInnerTransport(lambda req: httpx.Response(200, json={}))
    guard = EvalGuardedTransport(ledger_path, inner, URL, _validate_and_price, max_requests=5, budget_usd=1.0)
    other_request = httpx.Request("POST", "https://not-approved.invalid/v1/x", json={"model": "gpt-4o-mini"})
    with pytest.raises(BudgetStop):
        guard.handle_request(other_request)
    assert _read_ledger(ledger_path) == []
