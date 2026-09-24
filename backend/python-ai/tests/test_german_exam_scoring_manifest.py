"""Shared engine behaviour: generic scoring, the manifest contract, and clean
failure for parts that are in an exam's structure but not generatable yet."""

from __future__ import annotations

import pytest

from app.services import german_exam_generator as gen
from app.services.german_exams import GERMAN_EXAM_PROFILES, GermanExamProfileError, ScoringSpec, build_manifest, get_part, get_profile
from app.services.german_exams.scoring import is_pass, raw_to_points
from app.services.german_exams.task_types import TASK_TYPES


def test_fixed_per_item_scoring_unchanged_for_telc() -> None:
    spec = get_part("telc_c1_hochschule", "listening", "hv2").scoring
    assert spec.resolved_mode == "fixed_per_item"
    assert raw_to_points(spec, 7) == 14
    writing = get_part("telc_c1_hochschule", "writing", "schreiben_1").scoring
    assert writing.resolved_mode == "rubric" and writing.max_points == 48 and writing.points_per_correct is None


def test_lookup_scoring_and_pass() -> None:
    spec = get_profile("goethe_c1").module_specs["reading"].scoring
    assert raw_to_points(spec, 30) == 100 and raw_to_points(spec, 5) == 17 and raw_to_points(spec, 0) == 0
    assert is_pass(spec, raw_to_points(spec, 18)) and not is_pass(spec, raw_to_points(spec, 17))
    with pytest.raises(GermanExamProfileError):
        raw_to_points(spec, 31)


def test_lookup_spec_is_validated() -> None:
    with pytest.raises(ValueError):
        ScoringSpec(max_points=10, mode="lookup_table", raw_item_count=2, raw_to_result_points=(0, 5))  # wrong length
    with pytest.raises(ValueError):
        ScoringSpec(max_points=10, mode="lookup_table", raw_item_count=2, raw_to_result_points=(0, 8, 5))  # not ending at max


def test_every_profile_task_type_is_registered() -> None:
    for profile in GERMAN_EXAM_PROFILES.values():
        for parts in profile.modules.values():
            for part in parts or ():
                assert part.task_type in TASK_TYPES, (profile.profile_id, part.part_id, part.task_type)


def test_manifest_goethe() -> None:
    m = build_manifest(get_profile("goethe_c1"))
    assert m["profileId"] == "goethe_c1" and m["displayName"] == "Goethe-Zertifikat C1"
    assert [(x["id"], x["label"], len(x["parts"])) for x in m["modules"]] == [
        ("reading", "Lesen", 4), ("listening", "Hören", 4), ("writing", "Schreiben", 2), ("speaking", "Sprechen", 2)]
    assert "language_elements" not in [x["id"] for x in m["modules"]]
    assert [x["durationSeconds"] for x in m["modules"]] == [3900, 2400, 4500, None]
    assert m["modules"][3]["preparationSeconds"] == 1200
    assert all(not p["implemented"] for x in m["modules"] for p in x["parts"])  # G0: nothing generatable yet


def test_manifest_telc_keeps_its_modules_and_order() -> None:
    m = build_manifest(get_profile("telc_c1_hochschule"))
    assert [x["label"] for x in m["modules"]] == ["Lesen", "Hören", "Sprachbausteine", "Schreiben", "Sprechen"]
    assert all(p["implemented"] for x in m["modules"] for p in x["parts"])


def test_unavailable_goethe_part_fails_cleanly_before_any_work(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **k):
        raise AssertionError("must not reach inventory/LLM/topic history")

    monkeypatch.setattr(gen.german_exam_inventory, "is_stocked", boom)
    with pytest.raises(NotImplementedError):
        gen.generate_task("u1", "goethe_c1", "reading", "lesen_3", "adaptive_practice")
    with pytest.raises(GermanExamProfileError):
        gen.generate_task("u1", "goethe_c1", "language_elements", "sprachbausteine_1", "adaptive_practice")
    with pytest.raises(GermanExamProfileError):
        gen.generate_task("u1", "telc_c1_hochschule", "reading", "lesen_4", "adaptive_practice")


def test_e2e_manifest_fixture_matches_the_profile_files() -> None:
    """tests/e2e/fixtures/german-exam-manifests.json feeds the profile-switch E2E. It is generated
    from the real profile files so the E2E can never assert against a hand-copied structure.
    Regenerate with: UPDATE_MANIFEST_FIXTURE=1 pytest tests/test_german_exam_scoring_manifest.py"""
    import json
    import os
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "tests" / "e2e" / "fixtures" / "german-exam-manifests.json"
    current = {pid: build_manifest(p) for pid, p in GERMAN_EXAM_PROFILES.items()}
    if os.environ.get("UPDATE_MANIFEST_FIXTURE") == "1":
        path.write_text(json.dumps(current, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf8")
    assert json.loads(path.read_text(encoding="utf8")) == json.loads(json.dumps(current))


def test_every_profile_part_only_allows_known_skill_tags() -> None:
    """A tag the module's controlled vocabulary does not contain would be offered to the LLM in the
    prompt and then rejected by validation (wasted repairs), so profiles may only list known tags."""
    from app.services.german_exam_skill_tags import validate_tags

    for profile in GERMAN_EXAM_PROFILES.values():
        for module, parts in profile.modules.items():
            for part in parts or ():
                validate_tags(part.module, list(part.allowed_skill_tags))  # raises on an unknown tag
