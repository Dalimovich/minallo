"""scripts/qa_testdaf_live.py: every generator call, gen_timing call and
.env load is monkeypatched — this file makes zero real provider calls."""
import argparse
import json
import sys
from pathlib import Path

import pytest

from app.services.german_exams.testdaf_digital import TESTDAF_DIGITAL

# See test_qa_budget.py for why this is guarded rather than unconditional:
# unconditionally deleting+reimporting `scripts.*` here AND there makes
# whichever file collects second rebind sys.modules["scripts.qa_budget"] to a
# new module object, while the other file's already-imported names keep
# pointing at the old one — a real collection-order-dependent bug.
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

from scripts import qa_budget, qa_testdaf_live  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch):
    """Belt-and-braces: even if a test forgets to patch a generator, dotenv's
    load_dotenv() must never actually run (it's harmless here, but the fixture
    documents the invariant) and nothing should reach outside this process."""
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)


def _args(tmp_path, **overrides):
    defaults = dict(
        module="reading", part="lesen_1", env_file=tmp_path / ".env",
        out=tmp_path / "out", max_cost_usd=0.25, max_samples=1, dry_run=False,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _patch_generator(monkeypatch, module_path: str, fn):
    monkeypatch.setattr(module_path, fn)


class _FakeTimer:
    def expired(self):
        return False


@pytest.fixture(autouse=True)
def _fake_gen_timing(monkeypatch):
    from app.services import gen_timing

    class _Ctx:
        def __enter__(self):
            return _FakeTimer()

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(gen_timing, "timed_request", lambda *a, **k: _Ctx())
    monkeypatch.setattr(gen_timing, "finish", lambda timer, outcome: {"estimatedCostUsd": 0.01, "outcome": outcome})


def test_every_testdaf_module_has_a_distinct_qa_usage_label():
    assert set(qa_testdaf_live._MODULE_LABELS) == set(TESTDAF_DIGITAL.modules)
    assert len(set(qa_testdaf_live._MODULE_LABELS.values())) == 4
    assert all(label.startswith("testdaf_") and label.endswith("_qa") for label in qa_testdaf_live._MODULE_LABELS.values())
    assert not any(label == "__main__" for label in qa_testdaf_live._MODULE_LABELS.values())


def test_generator_dispatch_resolves_the_real_generator_function_for_every_module():
    import app.services.german_exam_reading as reading
    import app.services.german_exam_listening as listening
    import app.services.german_exam_writing as writing
    import app.services.german_exam_speaking as speaking

    assert qa_testdaf_live._generator("reading") is reading.generate_reading_part
    assert qa_testdaf_live._generator("listening") is listening.generate_listening_part
    assert qa_testdaf_live._generator("writing") is writing.generate_writing_part
    assert qa_testdaf_live._generator("speaking") is speaking.generate_speaking_part
    with pytest.raises(ValueError):
        qa_testdaf_live._generator("sprachbausteine")


def test_a_single_bounded_sample_writes_one_record_and_a_summary_with_no_release_gate(tmp_path, monkeypatch):
    _patch_generator(monkeypatch, "app.services.german_exam_reading.generate_reading_part",
                      lambda profile, part, plan, topic: ({"fake": "content"}, {"passed": True}))
    captured_labels = []
    monkeypatch.setattr(qa_testdaf_live, "labeled_usage", lambda label: _record_and_noop(captured_labels, label))

    args = _args(tmp_path)
    code = qa_testdaf_live.run(args)

    assert code == 0
    assert captured_labels == ["testdaf_lesen_qa"]
    record_path = args.out / "reading-lesen_1-sample-1.json"
    assert record_path.exists()
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert record["status"] == "pass" and record["content"] == {"fake": "content"}
    assert record["usageLabel"] == "testdaf_lesen_qa"
    assert record["profileId"] == "testdaf_digital"
    assert record["partAvailable"] is False  # every TestDaF part stays unavailable — this script never changes that

    summary = json.loads((args.out / "reading-lesen_1-summary.json").read_text(encoding="utf-8"))
    assert summary["samplesRun"] == 1 and summary["failures"] == 0
    assert summary["releaseGatePassed"] is False


def test_a_generator_exception_is_recorded_as_a_failed_sample_not_raised(tmp_path, monkeypatch):
    def boom(profile, part, plan, topic):
        raise ValueError("generator rejected content")

    _patch_generator(monkeypatch, "app.services.german_exam_listening.generate_listening_part", boom)
    monkeypatch.setattr(qa_testdaf_live, "labeled_usage", lambda label: _record_and_noop([], label))

    args = _args(tmp_path, module="listening", part="hoeren_1")
    code = qa_testdaf_live.run(args)

    assert code == 1
    record = json.loads((args.out / "listening-hoeren_1-sample-1.json").read_text(encoding="utf-8"))
    assert record["status"] == "fail" and "ValueError" in record["error"]


def test_run_never_starts_a_second_sample_once_max_samples_is_reached(tmp_path, monkeypatch):
    calls = []
    _patch_generator(monkeypatch, "app.services.german_exam_writing.generate_writing_part",
                      lambda profile, part, plan, topic: (calls.append(1), ({}, {}))[1])
    monkeypatch.setattr(qa_testdaf_live, "labeled_usage", lambda label: _record_and_noop([], label))

    args = _args(tmp_path, module="writing", part="schreiben_1", max_samples=1)
    qa_testdaf_live.run(args)
    assert len(calls) == 1  # --max-samples=1 permits exactly one generation call, never more


def test_run_stops_before_a_further_sample_once_the_cost_budget_is_already_spent(tmp_path, monkeypatch):
    """A budget of $0.01 with a $0.01-per-sample fake cost must terminate the run's second
    would-be sample BEFORE calling the generator again — proven with max_samples raised
    above 1 only inside this test's own QaBudget-level check (add_budget_args' CLI-level
    cap is tested separately in test_qa_budget.py)."""
    from scripts.qa_budget import QaBudget

    budget = QaBudget(max_cost_usd=0.01, max_samples=1, label="testdaf_sprechen_qa")
    budget.guard_new_sample()
    budget.record_call(0.01, sample=1)
    with pytest.raises(qa_budget.BudgetExceeded):
        budget.guard_new_sample()


def test_dry_run_never_imports_or_dispatches_to_a_real_generator(tmp_path, monkeypatch):
    """--dry-run must exercise run()'s real loop/budget/termination logic through the
    real CLI parser, without ever calling `_generator()` (which imports a real,
    network-capable generator module)."""
    called = []
    monkeypatch.setattr(qa_testdaf_live, "_generator", lambda module: called.append(module) or (_ for _ in ()).throw(
        AssertionError("dry-run must not resolve a real generator")))
    monkeypatch.setattr(qa_testdaf_live, "labeled_usage", lambda label: _record_and_noop([], label))
    load_dotenv_calls = []
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: load_dotenv_calls.append(a))

    parser = argparse.ArgumentParser()
    parser.add_argument("--module", required=True)
    parser.add_argument("--part", required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    qa_budget.add_budget_args(parser)
    args = parser.parse_args([
        "--module", "speaking", "--part", "sprechen_1", "--env-file", str(tmp_path / ".env"),
        "--out", str(tmp_path / "out"), "--dry-run", "--max-cost-usd", "0.25", "--max-samples", "1",
    ])

    code = qa_testdaf_live.run(args)

    assert code == 0
    assert called == []  # _generator() was never resolved/called
    assert load_dotenv_calls == []  # .env is never loaded in dry-run mode

    record = json.loads((args.out / "speaking-sprechen_1-sample-1.json").read_text(encoding="utf-8"))
    assert record["status"] == "pass"
    assert record["content"] == {"dryRun": True, "note": "fixture content, no provider call was made"}
    assert record["dryRun"] is True
    assert record["partAvailable"] is False

    summary = json.loads((args.out / "speaking-sprechen_1-summary.json").read_text(encoding="utf-8"))
    assert summary["dryRun"] is True and summary["releaseGatePassed"] is False and summary["samplesRun"] == 1


def test_dry_run_still_stops_before_a_further_sample_once_the_budget_is_spent(tmp_path, monkeypatch):
    monkeypatch.setattr(qa_testdaf_live, "labeled_usage", lambda label: _record_and_noop([], label))
    from app.services import gen_timing

    # Force a non-zero per-sample cost so a max-samples=1 run still demonstrates the
    # budget being spent after the single allowed sample (matches the real CLI cap).
    monkeypatch.setattr(gen_timing, "finish", lambda timer, outcome: {"estimatedCostUsd": 0.25, "outcome": outcome})

    args = _args(tmp_path, module="writing", part="schreiben_1", dry_run=True, max_cost_usd=0.25, max_samples=1)
    code = qa_testdaf_live.run(args)

    assert code == 0
    summary = json.loads((args.out / "writing-schreiben_1-summary.json").read_text(encoding="utf-8"))
    assert summary["samplesRun"] == 1
    assert summary["terminated"]["reason"] == "cost budget reached after this sample"


def _record_and_noop(sink, label):
    sink.append(label)
    from contextlib import contextmanager

    @contextmanager
    def _cm():
        yield

    return _cm()
