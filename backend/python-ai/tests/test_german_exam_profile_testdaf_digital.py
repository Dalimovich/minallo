"""Digital TestDaF foundation and fail-closed generation contract."""

import pytest

from app.services.german_exams import GERMAN_EXAM_PROFILES, build_manifest, get_profile, resolve_profile_id
from app.services.german_exams.testdaf_digital import (
    DELIVERY_METADATA, MODULE_METADATA, OFFICIAL_SOURCES, SCORING_METADATA, TDN_BANDS, TESTDAF_DIGITAL,
)


def test_profile_identity_and_no_ambiguous_legacy_mapping():
    assert get_profile("testdaf_digital") is TESTDAF_DIGITAL
    assert TESTDAF_DIGITAL.cefr_level is None
    assert TESTDAF_DIGITAL.profile_version == 3
    assert set(OFFICIAL_SOURCES) == {"structure", "scoring", "reading_mc_example"}
    assert resolve_profile_id("TestDaF", "TDN 4") is None


def test_scored_core_structure_and_counts():
    modules = TESTDAF_DIGITAL.modules
    assert list(modules) == ["reading", "listening", "writing", "speaking"]
    assert [len(parts) for parts in modules.values()] == [7, 7, 2, 7]
    assert [p.constraints["itemCount"] for p in modules["reading"]] == [5, 5, 7, 4, 7, 4, 3]
    lesen_7 = modules["reading"][6]
    assert lesen_7.constraints["requiredSourceKinds"] == ("text", "graphic")
    assert [p.constraints["itemCount"] for p in modules["listening"]] == [5, 4, 2, 6, 4, 5, 4]
    for module in ("reading", "listening"):
        assert sum(p.constraints["itemCount"] for p in modules[module]) == MODULE_METADATA[module]["itemCount"]
    assert [s.duration_seconds for s in TESTDAF_DIGITAL.module_specs.values()] == [3300, 2400, 3600, 2100]
    assert all(s.note and s.preparation_seconds is None for s in TESTDAF_DIGITAL.module_specs.values())


def test_productive_constraints_preserve_exact_and_approximate_requirements():
    first, second = TESTDAF_DIGITAL.modules["writing"]
    assert first.constraints["wordCountMin"] == 200
    assert (second.constraints["wordCountMinApprox"], second.constraints["wordCountMaxApprox"]) == (100, 150)
    assert [p.constraints["speakingSeconds"] for p in TESTDAF_DIGITAL.modules["speaking"]] == [45, 90, 120, 90, 150, 120, 90]


def test_scaled_bands_never_masquerade_as_raw_score_conversion():
    assert [(b["min"], b["max"]) for b in TDN_BANDS] == [(0, 4), (5, 9), (10, 15), (16, 20)]
    assert SCORING_METADATA["rawToScaledConversion"] is None
    assert SCORING_METADATA["rawToScaledConversionAvailable"] is False
    assert all(s.scoring is None for s in TESTDAF_DIGITAL.module_specs.values())
    assert all(p.scoring is None for parts in TESTDAF_DIGITAL.modules.values() for p in parts)


def test_manifest_shows_all_parts_as_unavailable():
    manifest = build_manifest(TESTDAF_DIGITAL)
    assert manifest["displayName"] == "Digitaler TestDaF"
    parts = [p for module in manifest["modules"] for p in module["parts"]]
    assert len(parts) == 23
    assert all(p["implemented"] is False for p in parts)


def test_delivery_policy_is_wired_from_delivery_metadata_and_exposed_on_the_manifest():
    """DELIVERY_METADATA is the single editable source of these facts (per the file's own
    docstring); TESTDAF_DIGITAL.delivery_policy must reflect it exactly, and the manifest
    must expose it generically (no TestDaF-specific manifest code)."""
    policy = TESTDAF_DIGITAL.delivery_policy
    assert policy is not None
    assert policy.fixed_task_order is DELIVERY_METADATA["fixedTaskOrder"]
    assert policy.back_navigation_allowed is DELIVERY_METADATA["backNavigationAllowed"]
    assert policy.additional_unscored_trial_tasks is DELIVERY_METADATA["additionalUnscoredTrialTasks"]
    manifest = build_manifest(TESTDAF_DIGITAL)
    assert manifest["deliveryPolicy"] == {
        "fixedTaskOrder": True, "backNavigationAllowed": False, "additionalUnscoredTrialTasks": True,
    }


def test_a_profile_without_a_delivery_policy_gets_a_null_manifest_field_not_a_default_guess():
    """Generic manifest behaviour, asserted on whichever other profiles exist today (not a
    TestDaF-specific check): a profile that has not opted into a timed simulation must not
    have one silently invented for it."""
    others = [p for pid, p in GERMAN_EXAM_PROFILES.items() if pid != "testdaf_digital"]
    assert others, "expected at least one non-TestDaF profile to compare against"
    for profile in others:
        assert profile.delivery_policy is None
        assert build_manifest(profile)["deliveryPolicy"] is None


@pytest.mark.parametrize("part", [p for parts in TESTDAF_DIGITAL.modules.values() for p in parts], ids=lambda p: p.part_id)
def test_generation_stops_before_inventory_or_dispatch(part, monkeypatch):
    from app.services import german_exam_generator as gen

    def forbidden(*args, **kwargs):
        raise AssertionError("Unavailable parts must not access inventory or dispatch generation")

    monkeypatch.setattr(gen.german_exam_inventory, "is_stocked", forbidden)
    monkeypatch.setattr(gen, "_dispatch_module", forbidden)
    assert part.available is False
    with pytest.raises(NotImplementedError, match="not available yet"):
        gen.generate_task("test-user", TESTDAF_DIGITAL.profile_id, part.module, part.part_id, "adaptive_practice")
