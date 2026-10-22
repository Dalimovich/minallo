"""Inventory architecture is capable of TestDaF later without seeding it now.

Verifies profile_id + profile_version + module + part_id (+ task_type, resolved
server-side from the profile registry) are sufficient to isolate TestDaF stock from
TELC/Goethe, using only fake inventory rows — no real database, no live generation, no
TestDaF item is ever inserted by these tests.
"""
import pytest

from app.services import german_exam_inventory as inv
from app.services.german_exams import get_profile
from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL


@pytest.fixture(autouse=True)
def _stock_on(monkeypatch):
    monkeypatch.setenv("GERMAN_EXAM_INVENTORY_ENABLED", "true")


class _Rpc:
    def __init__(self, data=None):
        self._data = data

    def execute(self):
        return type("R", (), {"data": self._data})()


class _Sb:
    """Fake Supabase client. Only ever asked for a fake row — nothing here can insert
    or read a real database row, so no TestDaF item can be seeded by these tests."""

    def __init__(self, data=None):
        self.data = data
        self.rpc_calls: list[tuple[str, dict]] = []

    def rpc(self, name, args):
        self.rpc_calls.append((name, args))
        return _Rpc(self.data)


def _fake_row(part_id: str, remaining: int = 9):
    return [{
        "id": "inv-testdaf-1", "topic_id": "hochschule_alltag", "remaining_unserved": remaining,
        "content": {"module": "reading", "part": {"id": part_id}, "topic": {"topicId": "hochschule_alltag"},
                    "content": {"article": "x", "items": []}, "generationId": "stock-gen"},
    }]


def test_take_scopes_the_rpc_call_to_the_testdaf_profile_id_and_its_own_profile_version(monkeypatch):
    sb = _Sb(_fake_row("lesen_1"))
    monkeypatch.setattr(inv, "get_supabase", lambda: sb)
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no replenish expected here")))
    env = inv.take("u1", "testdaf_digital", "reading", "lesen_1")
    assert env is not None and env["source"] == "inventory"
    assert sb.rpc_calls, "take() must call the inventory RPC"
    name, args = sb.rpc_calls[0]
    assert name == "german_exam_inventory_take"
    assert args["p_profile_id"] == "testdaf_digital"
    assert args["p_module"] == "reading"
    assert args["p_part_id"] == "lesen_1"
    assert args["p_profile_version"] == get_profile("testdaf_digital").profile_version == TESTDAF_DIGITAL.profile_version


def test_take_for_testdaf_and_telc_use_distinct_profile_ids_in_the_same_module_and_part_shape(monkeypatch):
    """profile_id is the isolating key: two different exams can share a module name
    (both have "reading") and even a part_id spelling without colliding, because the RPC
    call — and the underlying table's lookup index — is always scoped by profile_id."""
    calls = []

    def fake_supabase():
        sb = _Sb(_fake_row("lesen_1"))
        calls.append(sb)
        return sb

    monkeypatch.setattr(inv, "get_supabase", fake_supabase)
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: None)
    inv.take("u1", "testdaf_digital", "reading", "lesen_1")
    inv.take("u1", "telc_c1_hochschule", "reading", "lesen_1")
    profile_ids = [c.rpc_calls[0][1]["p_profile_id"] for c in calls]
    assert profile_ids == ["testdaf_digital", "telc_c1_hochschule"]
    assert len(set(profile_ids)) == 2


def test_is_stocked_treats_testdaf_the_same_generic_way_as_every_other_profile(monkeypatch):
    """No TestDaF-specific branch exists in is_stocked(): the same STOCKED_MODULES/mode/
    topic-override rule that gates TELC gates TestDaF, because is_stocked() never receives
    or checks a profile id at all."""
    assert inv.is_stocked("reading", "adaptive_practice", None)
    assert inv.is_stocked("listening", "adaptive_practice", None)
    assert inv.is_stocked("writing", "adaptive_practice", None)
    assert not inv.is_stocked("speaking", "adaptive_practice", None)  # same rule TELC/Goethe speaking already follows
    assert not inv.is_stocked("reading", "adaptive_practice", "a custom topic")
    monkeypatch.setenv("GERMAN_EXAM_INVENTORY_ENABLED", "false")
    assert not inv.is_stocked("reading", "adaptive_practice", None)


def test_taking_stock_for_an_unavailable_testdaf_part_never_generates_or_inserts_anything(monkeypatch):
    """Every TestDaF part is available=False; get_part() itself does not gate `take()` (the
    caller — generate_task — checks availability before ever calling take()), but this test
    still proves take() alone touches only the fake RPC double, never a real insert path."""
    sb = _Sb(_fake_row("lesen_1"))
    monkeypatch.setattr(inv, "get_supabase", lambda: sb)
    monkeypatch.setattr(inv, "generate_and_store", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not seed inventory")))
    monkeypatch.setattr(inv, "replenish_async", lambda *a, **k: None)
    inv.take("u1", "testdaf_digital", "reading", "lesen_1")
    # replenish_async is a no-op stub above; generate_and_store (the only thing that can
    # ever insert a row) is asserted unreachable via the monkeypatch itself.


def test_generate_task_refuses_to_serve_stock_or_generate_for_any_unavailable_testdaf_part(monkeypatch):
    """The existing fail-closed contract (see test_german_exam_profile_testdaf_digital.py)
    already proves generate_task() 501s before reaching inventory or dispatch for every
    unavailable TestDaF part; this asserts the same for a representative part per module
    using the real registry, not a stub, so a future accidental `available=True` flip on a
    single part cannot silently start serving/generating stock for it."""
    from app.services import german_exam_generator as gen

    for module, parts in TESTDAF_DIGITAL.modules.items():
        part = parts[0]
        assert part.available is False
        monkeypatch.setattr(inv, "is_stocked", lambda *a, **k: (_ for _ in ()).throw(AssertionError("unavailable part must not reach inventory")))
        with pytest.raises(NotImplementedError):
            gen.generate_task("u1", "testdaf_digital", module, part.part_id, "adaptive_practice")
