"""Pre-generated inventory: serve-from-stock, fail-open fallback, replenishment gating."""
from app.services import german_exam_generator as gen
from app.services import german_exam_inventory as inv
import pytest


@pytest.fixture(autouse=True)
def _stock_on(monkeypatch):
    monkeypatch.setenv("GERMAN_EXAM_INVENTORY_ENABLED", "true")


class _Rpc:
    def __init__(self, data=None, exc=None):
        self._data, self._exc = data, exc

    def execute(self):
        if self._exc:
            raise self._exc
        return type("R", (), {"data": self._data})()


class _Sb:
    def __init__(self, data=None, exc=None):
        self.data, self.exc, self.calls = data, exc, []

    def rpc(self, name, args):
        self.calls.append((name, args))
        return _Rpc(self.data, self.exc)


def _row(remaining):
    return [{"id": "inv-1", "topic_id": "urban_mobility", "remaining_unserved": remaining,
             "content": {"module": "listening", "topic": {"topicId": "urban_mobility"},
                         "content": {"questions": []}, "generationId": "stock-gen"}}]


def test_take_returns_envelope_with_fresh_generation_id(monkeypatch):
    monkeypatch.setattr(inv, "get_supabase", lambda: _Sb(_row(9)))
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no replenish")))
    env = inv.take("u1", "telc_c1_hochschule", "listening", "hv1")
    assert env["source"] == "inventory" and env["inventoryId"] == "inv-1"
    assert env["generationId"] != "stock-gen"


def test_take_below_low_water_triggers_replenish(monkeypatch):
    calls = []
    monkeypatch.setattr(inv, "get_supabase", lambda: _Sb(_row(2)))
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: calls.append((a, k)))
    assert inv.take("u1", "telc_c1_hochschule", "listening", "hv1") is not None
    assert calls and calls[0][1]["need"] == inv.target_stock() - 2


def test_empty_stock_returns_none_and_replenishes(monkeypatch):
    calls = []
    monkeypatch.setattr(inv, "get_supabase", lambda: _Sb([]))
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: calls.append(k))
    assert inv.take("u1", "telc_c1_hochschule", "listening", "hv1") is None
    assert calls


def test_rpc_failure_fails_open_without_replenishing(monkeypatch):
    monkeypatch.setattr(inv, "get_supabase", lambda: _Sb(exc=RuntimeError("function does not exist")))
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not generate")))
    assert inv.take("u1", "telc_c1_hochschule", "listening", "hv1") is None


def test_is_stocked_rules(monkeypatch):
    assert inv.is_stocked("reading", "adaptive_practice", None)
    assert not inv.is_stocked("reading", "adaptive_practice", "custom topic")
    assert not inv.is_stocked("reading", "exam_simulation", None)
    assert not inv.is_stocked("speaking", "adaptive_practice", None)
    monkeypatch.setenv("GERMAN_EXAM_INVENTORY_ENABLED", "false")
    assert not inv.is_stocked("reading", "adaptive_practice", None)


def test_generate_task_serves_stock_and_skips_live(monkeypatch):
    recorded = []
    stocked = {"generationId": "g-new", "topic": {"topicId": "urban_mobility"}, "source": "inventory"}
    monkeypatch.setattr(inv, "take", lambda *a: stocked)
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: recorded.append(a))
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: (_ for _ in ()).throw(AssertionError("live path")))
    env = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice")
    assert env is stocked and recorded and recorded[0][-1] == "g-new"


def test_custom_topic_bypasses_stock(monkeypatch):
    monkeypatch.setattr(inv, "take", lambda *a: (_ for _ in ()).throw(AssertionError("must bypass")))
    monkeypatch.setattr(gen, "compute_weakness", lambda *a, **k: None)
    monkeypatch.setattr(gen, "build_adaptation_plan", lambda *a, **k: [])
    monkeypatch.setattr(gen, "record_topic_used", lambda *a, **k: None)
    monkeypatch.setattr(gen, "_generate_listening", lambda *a: ({}, {}))
    env = gen.generate_task("u1", "telc_c1_hochschule", "listening", "hv1", "adaptive_practice", topic_override="Kaffee")
    assert env["topic"]["topicId"] == "custom"


def test_replenish_is_single_flight_per_part(monkeypatch):
    started = []
    monkeypatch.setattr(inv.threading, "Thread", lambda **kw: type("T", (), {"start": lambda self: started.append(kw)})())
    inv._inflight.clear()
    assert inv.replenish_async("p", "reading", "lesen_1", need=5) is True
    assert inv.replenish_async("p", "reading", "lesen_1", need=5) is False
    assert inv.replenish_async("p", "reading", "lesen_2", need=0) is False
    inv._inflight.clear()
    assert len(started) == 1
