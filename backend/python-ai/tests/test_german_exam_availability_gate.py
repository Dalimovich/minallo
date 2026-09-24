"""Release gate: engine capability != product availability.

PartBlueprint.available defaults to True, so a part that forgets available=False
would silently go live. These tests freeze the set of currently-available parts;
changing it must be a deliberate edit to EXPECTED_AVAILABLE below, made only after
the qualification process in audit/testdaf-offline/LIVE_QUALIFICATION_PLAN.md.
"""
from __future__ import annotations

import pytest

from app.services import german_exam_generator as generator
from app.services.german_exams import GERMAN_EXAM_PROFILES
from app.services.german_exams import manifest as manifest_mod

EXPECTED_AVAILABLE = frozenset({
    ("telc_c1_hochschule", "listening", "hv1"), ("telc_c1_hochschule", "listening", "hv2"),
    ("telc_c1_hochschule", "listening", "hv3"),
    ("telc_c1_hochschule", "reading", "lesen_1"), ("telc_c1_hochschule", "reading", "lesen_2"),
    ("telc_c1_hochschule", "reading", "lesen_3"),
    ("telc_c1_hochschule", "writing", "schreiben_1"),
    ("telc_c1_hochschule", "speaking", "sprechen_1"), ("telc_c1_hochschule", "speaking", "sprechen_2"),
    ("telc_c1_hochschule", "language_elements", "sprachbausteine_1"),
})


def _all_parts():
    for profile in GERMAN_EXAM_PROFILES.values():
        for module, parts in profile.modules.items():
            for part in parts:
                yield profile, module, part


def _blocked():
    return [(p, m, part) for p, m, part in _all_parts() if (p.profile_id, m, part.part_id) not in EXPECTED_AVAILABLE]


def test_available_parts_match_the_frozen_allowlist_exactly() -> None:
    actual = {(p.profile_id, m, part.part_id) for p, m, part in _all_parts() if part.available}
    assert actual == EXPECTED_AVAILABLE, (
        f"availability changed. newly available: {sorted(actual - EXPECTED_AVAILABLE)}; "
        f"no longer available: {sorted(EXPECTED_AVAILABLE - actual)}")


@pytest.mark.parametrize("profile_id", ["testdaf_digital", "goethe_c1"])
def test_no_part_of_a_unqualified_profile_is_available(profile_id: str) -> None:
    assert not [part.part_id for m, parts in GERMAN_EXAM_PROFILES[profile_id].modules.items()
                for part in parts if part.available]


def test_blocked_categories_are_present_and_unavailable() -> None:
    blocked = {(p.profile_id, m, part.part_id): part for p, m, part in _blocked()}
    assert any(k[0] == "testdaf_digital" and k[1] == "speaking" for k in blocked)
    assert any(k[0] == "goethe_c1" and k[1] == "speaking" for k in blocked)
    for key in (("testdaf_digital", "listening", "hoeren_4"), ("testdaf_digital", "listening", "hoeren_5")):
        assert key in blocked and blocked[key].available is False


def test_implemented_task_type_alone_never_makes_a_blocked_part_serveable(monkeypatch) -> None:
    monkeypatch.setattr(generator, "is_task_type_implemented", lambda _t: True)
    for profile, _module, part in _blocked():
        with pytest.raises(NotImplementedError):
            generator._require_available(profile, part)


def test_manifest_never_reports_a_blocked_part_as_implemented(monkeypatch) -> None:
    monkeypatch.setattr(manifest_mod, "is_task_type_implemented", lambda _t: True)
    for _profile, _module, part in _blocked():
        assert manifest_mod._part(part)["implemented"] is False
