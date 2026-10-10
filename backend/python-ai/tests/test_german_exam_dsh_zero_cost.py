"""Zero-cost guarantees for the DSH structural phase: no model call, no generation, no inventory write,
nothing available, and no endpoint that could expose a DSH part.

The dsh*.py modules are scanned by AST (imports) so a future accidental provider import fails CI, and
every model/inventory entrypoint is replaced with a tripwire while the real routes are exercised."""

from __future__ import annotations

import ast
import os
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services import german_exam_generator as gen
from app.services import german_exam_inventory as inv
from app.services.german_exams import GERMAN_EXAM_PROFILES, get_profile
from app.services.german_exam_writing_grading import GRADABLE_WRITING_PROFILE_IDS, gradable_writing_task_types
from app.services.german_exam_speaking_practice import GRADABLE_SPEAKING_PROFILE_IDS

PKG = Path(__file__).resolve().parents[1] / "app" / "services" / "german_exams"
DSH_FILES = sorted(PKG.glob("dsh*.py"))
ALLOWED_IMPORTS = {"__future__", "collections", "dataclasses", "decimal", "fractions", "hashlib", "math", "typing", "unicodedata"}
ALLOWED_RELATIVE = {"shared", "dsh", "registry", "dsh_content_model"}
DSH_PARTS = [(m, p.part_id) for m, parts in get_profile("dsh").modules.items() for p in parts]
USER = "11111111-1111-4111-8111-111111111111"
AUTH = {"X-Internal-Token": "test-token"}


def test_there_are_dsh_files_to_scan() -> None:
    assert {f.name for f in DSH_FILES} == {"dsh.py", "dsh_result.py", "dsh_content_model.py", "dsh_hv_playback.py", "dsh_qualification.py"}


@pytest.mark.parametrize("path", DSH_FILES, ids=lambda p: p.name)
def test_dsh_modules_import_nothing_that_can_reach_a_provider(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert all(a.name.split(".")[0] in ALLOWED_IMPORTS for a in node.names), (path.name, ast.dump(node))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                assert (node.module or "").split(".")[0] in ALLOWED_RELATIVE | {"dsh"}, (path.name, node.module)
            else:
                assert (node.module or "").split(".")[0] in ALLOWED_IMPORTS, (path.name, node.module)


@pytest.fixture()
def tripwires(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    def boom(name: str):
        def _f(*a, **k):
            calls.append(name)
            raise AssertionError(f"{name} must not be reached for a DSH part")
        return _f

    for mod_name, mod in list(sys.modules.items()):
        if mod_name.startswith("app.services") and mod is not None and hasattr(mod, "chat_json"):
            monkeypatch.setattr(mod, "chat_json", boom(mod_name + ".chat_json"))
    for attr in ("take", "generate_and_store", "replenish_async", "stock_size"):
        monkeypatch.setattr(inv, attr, boom("inventory." + attr))
    monkeypatch.setattr(gen.german_exam_inventory, "is_stocked", boom("inventory.is_stocked"))
    return calls


@pytest.mark.parametrize("module,part_id", DSH_PARTS)
def test_generation_fails_before_any_model_inventory_or_topic_work(tripwires, module: str, part_id: str) -> None:
    with pytest.raises(NotImplementedError):
        gen.generate_task("u1", "dsh", module, part_id, "adaptive_practice")
    with pytest.raises(NotImplementedError):
        gen.generate_task("u1", "dsh", module, part_id, "exam_simulation")
    with pytest.raises(NotImplementedError):
        gen.generate_stock_task("dsh", module, part_id, {"topicId": "x", "label": "x"})
    assert tripwires == []


def test_no_dsh_part_is_available_anywhere() -> None:
    assert len(DSH_PARTS) == 5
    assert all(not p.available for parts in get_profile("dsh").modules.values() for p in parts)


def test_dsh_is_in_no_gradable_allow_list() -> None:
    assert "dsh" not in GRADABLE_WRITING_PROFILE_IDS and "dsh" not in GRADABLE_SPEAKING_PROFILE_IDS
    assert not gradable_writing_task_types() & {"dsh_tp_chart_based_argumentation"}


def test_inventory_never_iterates_profiles_by_itself() -> None:
    src = (Path(inv.__file__)).read_text(encoding="utf8")
    assert "GERMAN_EXAM_PROFILES" not in src and not re.search(r"\bdsh\b", src.lower())


# ---- HTTP surface --------------------------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings
    get_settings.cache_clear()


@pytest.fixture()
def client(tripwires, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app.routers import german_exam as router_mod
    monkeypatch.setattr(router_mod, "grade_writing_submission", lambda **k: tripwires.append("grade_writing_submission") or {})
    from app.main import app
    return TestClient(app)


@pytest.mark.parametrize("module,part_id", DSH_PARTS)
def test_generate_endpoint_answers_501_and_reaches_no_provider(client: TestClient, tripwires, module: str, part_id: str) -> None:
    r = client.post("/german-exam/generate", headers=AUTH, json={"userId": USER, "profileId": "dsh", "module": module, "partId": part_id})
    assert r.status_code == 501
    assert tripwires == []


def test_manifest_endpoint_serves_the_structure_without_generating(client: TestClient, tripwires) -> None:
    r = client.post("/german-exam/manifest", headers=AUTH, json={"profileId": "dsh"})
    assert r.status_code == 200
    body = r.json()
    assert [m["id"] for m in body["modules"]] == ["listening", "reading", "scientific_structures", "writing", "speaking"]
    assert all(p["implemented"] is False for m in body["modules"] for p in m["parts"])
    assert tripwires == []


def test_grade_writing_and_speaking_are_not_routable_for_dsh(client: TestClient, tripwires) -> None:
    payload = {
        "userId": USER, "profileId": "dsh", "partId": "tp_1", "topicId": "t1", "generationId": "g",
        "writingCoachTaskType": "freier_text", "text": "Ein Text. " * 10,
        "selectedTopic": {"questionId": "t1", "title": "T", "statements": ["a", "b"], "communicativeSituation": "c", "taskInstructions": "d"},
    }
    assert client.post("/german-exam/grade-writing", headers=AUTH, json=payload).status_code == 501
    speaking = {"userId": USER, "profileId": "dsh", "sessionId": "session-1234567890", "action": "transcribe", "stage": "presentation",
                "audioBase64": "eA==", "mimeType": "audio/webm", "tasks": {}, "selectedTopicId": "", "turns": []}
    assert client.post("/german-exam/speaking", headers=AUTH, json=speaking).status_code == 501
    assert tripwires == []


def test_other_profiles_are_untouched_by_the_dsh_registration() -> None:
    assert set(GERMAN_EXAM_PROFILES) == {"telc_c1_hochschule", "goethe_c1", "testdaf_digital", "dsh"}
