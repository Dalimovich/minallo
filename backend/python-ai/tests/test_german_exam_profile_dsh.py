"""DSH profile: structure, registration, availability, manifest. Deterministic — no model, no network.

Every expected value below is quoted from the HRK DSH-Musterprüfungsordnung 2025 (section noted) or is
explicitly a Minallo decision (see audit/dsh/IMPLEMENTATION_AUDIT.md)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.german_exam_skill_tags import SKILL_TAGS, validate_tags
from app.services.german_exams import GERMAN_EXAM_PROFILES, build_manifest, get_part, get_profile, resolve_profile_id
from app.services.german_exams import dsh as dsh_mod
from app.services.german_exams.dsh import DISCLAIMER, DSH_TASK_TYPES
from app.services.german_exams.task_types import TASK_TYPES, is_task_type_implemented

PROFILE = get_profile("dsh")
ROOT = Path(__file__).resolve().parents[3]


def _parts():
    return [(m, p) for m, parts in PROFILE.modules.items() for p in parts or ()]


# ---- profile ------------------------------------------------------------------------------
def test_dsh_is_one_profile_with_three_result_levels() -> None:
    assert PROFILE.profile_id == "dsh" and PROFILE.family == "DSH"
    assert PROFILE.legacy_level_values == ("DSH-1", "DSH-2", "DSH-3")
    assert [p.profile_id for p in GERMAN_EXAM_PROFILES.values() if p.family == "DSH"] == ["dsh"]
    for level in ("DSH-1", "DSH-2", "DSH-3"):
        assert resolve_profile_id("DSH", level) == "dsh"
    assert resolve_profile_id("DSH", "C1") is None and resolve_profile_id("DSH", "") is None


def test_no_cefr_level_is_invented() -> None:
    assert PROFILE.cefr_level is None
    manifest = build_manifest(PROFILE)
    assert manifest["cefrLevel"] is None
    assert manifest["resultModel"]["officialCefrMapping"] is None
    assert not re.search(r"\b(A1|A2|B1|B2|C1|C2)\b", repr(manifest)), "a CEFR level leaked into the DSH manifest"


def test_module_structure_and_order_follow_the_mpo() -> None:
    m = build_manifest(PROFILE)
    assert [(x["id"], x.get("code"), x["label"]) for x in m["modules"]] == [
        ("listening", "HV", "Hörverstehen"),
        ("reading", "LV", "Leseverstehen"),
        ("scientific_structures", "WS", "Wissenschaftssprachliche Strukturen"),
        ("writing", "TP", "Textproduktion"),
        ("speaking", None, "Mündliche Prüfung"),
    ]
    assert all(len(x["parts"]) == 1 for x in m["modules"])
    assert "language_elements" not in PROFILE.modules  # DSH has no Sprachbausteine


def test_every_part_is_unavailable_and_every_task_type_is_unimplemented() -> None:
    assert len(_parts()) == 5
    assert all(p.available is False for _, p in _parts())
    assert all(p.task_type in DSH_TASK_TYPES for _, p in _parts())
    assert all(TASK_TYPES[t] is False and not is_task_type_implemented(t) for t in DSH_TASK_TYPES)
    m = build_manifest(PROFILE)
    assert all(p["implemented"] is False for x in m["modules"] for p in x["parts"])


def test_exactly_five_dsh_task_types_all_registered() -> None:
    assert len(DSH_TASK_TYPES) == len(set(DSH_TASK_TYPES)) == 5
    assert all(t.startswith("dsh_") and t in TASK_TYPES for t in DSH_TASK_TYPES)
    assert {t for t in TASK_TYPES if t.startswith("dsh_")} == set(DSH_TASK_TYPES)


# ---- official facts ---------------------------------------------------------------------------
def test_hv_facts() -> None:  # §10(1)1, §10(4)1
    c = get_part("dsh", "listening", "hv_1").constraints
    assert (c["lectureCharsMin"], c["lectureCharsMax"]) == (5500, 7000)
    assert c["presentationCount"] == 2 and c["notesAllowed"] is True
    assert [(w["afterPresentation"], w["seconds"]) for w in c["processingWindows"]] == [(1, 600), (2, 2400)]
    assert c["processingTimeExcludesPresentation"] is True
    assert set(c["taskForms"]) == {"questions", "structure_sketch", "summary", "line_of_thought"}
    assert c["assessment"] == "content" and c["languageCorrectnessAssessed"] is False


def test_no_invented_audio_duration_anywhere() -> None:
    for _, part in _parts():
        keys = " ".join(part.constraints).lower()
        assert "audioduration" not in keys and "durationseconds" not in keys
    assert get_part("dsh", "listening", "hv_1").approx_duration_seconds is None


def test_lv_facts() -> None:  # §10(4)2a,b,c
    c = get_part("dsh", "reading", "lv_1").constraints
    assert (c["textCharsMin"], c["textCharsMax"]) == (4500, 6000)
    assert c["optionalGraphic"] is True and c["specialistKnowledgeRequired"] is False
    assert set(c["taskForms"]) == {"questions", "argument_structure", "outline", "explain_passages", "headings", "summary"}
    assert c["assessment"] == "content" and c["languageCorrectnessAssessed"] is False


def test_ws_facts_and_it_is_not_sprachbausteine() -> None:  # §10(4)2d,e
    part = get_part("dsh", "scientific_structures", "ws_1")
    c = part.constraints
    assert c["assessment"] == "language_correctness" and c["languageCorrectnessAssessed"] is True
    assert set(c["structureCategories"]) == {"syntactic", "morphological", "lexical", "idiomatic", "text_type"}
    assert c["multipleAcceptedAnswers"] is True and c["answerModel"] == "answer_families"
    assert part.task_type == "dsh_ws_structure_tasks" != "cloze_mc4_language_elements"
    assert "sprachbaustein" not in repr(build_manifest(PROFILE)).lower()


def test_lv_and_ws_share_one_source_group_in_the_manifest() -> None:  # §5(4)
    lv = get_part("dsh", "reading", "lv_1").constraints
    ws = get_part("dsh", "scientific_structures", "ws_1").constraints
    assert lv["sharedSourceGroup"] == ws["sharedSourceGroup"] == "lv_ws"
    assert (lv["sourceRole"], ws["sourceRole"]) == ("source", "derived")
    ref = ws["sourcePart"]
    assert get_part("dsh", ref["module"], ref["partId"]) is get_part("dsh", "reading", "lv_1")


def test_tp_facts() -> None:  # §10(4)3
    part = get_part("dsh", "writing", "tp_1")
    c = part.constraints
    assert c["wordCountApprox"] == 250 and "wordCountMin" not in c and "wordCountMax" not in c
    assert c["freeEssayAllowed"] is False and c["templateFriendlyPromptsAllowed"] is False
    assert c["assessment"] == "content_and_language"
    rubric = c["rubric"]
    assert rubric["languageWeightedHigher"] is True
    assert rubric["numericWeights"] is None, "the MPO publishes no numeric weights; none may be invented"
    assert set(part.grading_dimensions) == set(rubric["content"]) | set(rubric["language"])
    assert part.scoring.criteria_max_points is None and part.scoring.band_fractions is None


def test_oral_facts() -> None:  # §11
    part = get_part("dsh", "speaking", "sprechen_1")
    c = part.constraints
    assert c["preparationSeconds"] == 1200 and c["examSecondsMax"] == 1200
    assert c["presentationSecondsMax"] == 300 and c["conversationSecondsMax"] == 900
    assert c["groupExamsAllowed"] is False and c["interactive"] is True
    assert set(c["deliveryModes"]) == {"in_person", "online_remote"}  # §4(3) 2025
    assert PROFILE.module_specs["speaking"].preparation_seconds == 1200


# ---- oral assessment-contract regression (fixes the §11c / grading_dimensions mismatch) -------
_OFFICIAL_ORAL_CRITERIA = (  # §11c, quoted verbatim from the MPO — the ONLY authoritative list
    "content_appropriateness", "comprehensibility", "independence_of_statements",
    "conversational_behaviour", "linguistic_correctness", "lexical_differentiation",
    "pronunciation_and_intonation",
)


def test_oral_grading_dimensions_are_exactly_the_seven_official_sect11c_criteria() -> None:
    """Pins the fix: grading_dimensions used to be six names borrowed from the generic
    cross-exam speaking skill-tag vocabulary (_ORAL_TAGS-shaped), not DSH's own official
    criteria. Every other exam's grading_dimensions IS that exam's own official rubric
    (telc's sprechen_1/2, Goethe's Sprechen Handbuch Abb. 34 names, TestDaF's own seven
    criteria) — DSH must follow the same pattern, not an invented or borrowed one."""
    part = get_part("dsh", "speaking", "sprechen_1")
    assert part.grading_dimensions == _OFFICIAL_ORAL_CRITERIA
    assert len(part.grading_dimensions) == 7 and len(set(part.grading_dimensions)) == 7


def test_oral_constraints_assessment_criteria_and_grading_dimensions_are_one_source() -> None:
    """The descriptive constraints.assessmentCriteria citation and the operational
    grading_dimensions the rubric machinery keys off must never be allowed to drift apart
    again — they are the same tuple (dsh.ORAL_ASSESSMENT_CRITERIA), not two independently
    maintained lists."""
    part = get_part("dsh", "speaking", "sprechen_1")
    assert part.constraints["assessmentCriteria"] == part.grading_dimensions
    assert dsh_mod.ORAL_ASSESSMENT_CRITERIA == _OFFICIAL_ORAL_CRITERIA
    assert part.constraints["assessmentCriteria"] is dsh_mod.ORAL_ASSESSMENT_CRITERIA
    assert part.grading_dimensions is dsh_mod.ORAL_ASSESSMENT_CRITERIA


def test_oral_grading_dimensions_never_silently_become_testdaf_or_generic_speaking_semantics() -> None:
    """Guards specifically against the failure mode this phase fixed: a future edit that
    re-introduces TestDaF's speaking dimension SET wholesale (or the generic _ORAL_TAGS/
    telc-style adaptation vocabulary) into DSH's grading_dimensions without that being an
    explicit, deliberate, evidenced change. A single shared concept name is not itself a
    leak — "comprehensibility" is independently an OFFICIAL criterion in both DSH's §11c
    and TestDaF's own speaking rubric, so exact set equality (not disjointness) is the
    right invariant here."""
    from app.services.german_exams import testdaf_digital as testdaf_mod

    testdaf_speaking_dimensions = set(testdaf_mod._GRADING_DIMENSIONS["speaking"])
    dsh_oral_dimensions = set(get_part("dsh", "speaking", "sprechen_1").grading_dimensions)
    assert dsh_oral_dimensions != testdaf_speaking_dimensions
    generic_six_that_used_to_be_there = {
        "task_fulfilment", "fluency", "interaction", "grammar_accuracy", "vocabulary_range", "pronunciation",
    }
    assert dsh_oral_dimensions != generic_six_that_used_to_be_there, (
        "the previously-wrong generic speaking-tag-derived dimension set must not reappear"
    )


def test_oral_criteria_carry_no_invented_numeric_weight() -> None:
    """§11c names the seven criteria but the verified source establishes no per-criterion
    numeric weight for any of them — mirrors TP_RUBRIC's own 'numericWeights: None' rule
    (test_tp_facts above). None may be invented; equal weighting is not assumed either."""
    part = get_part("dsh", "speaking", "sprechen_1")
    assert part.scoring is not None
    assert part.scoring.criteria_max_points is None
    assert part.scoring.band_fractions is None


def test_written_module_timings() -> None:  # §10(1)
    specs = PROFILE.module_specs
    assert specs["listening"].duration_seconds == 50 * 60
    assert specs["reading"].duration_seconds == 90 * 60
    assert specs["writing"].duration_seconds == 70 * 60
    assert specs["scientific_structures"].duration_seconds is None  # shares the LV 90 minutes


def test_aids_are_paper_monolingual_dictionary_only() -> None:  # §10(2), 2025 wording
    for module in ("listening", "reading", "scientific_structures", "writing"):
        part = PROFILE.modules[module][0]
        assert part.constraints["aids"] == "monolingual_dictionary_paper_only"


def test_scoring_maxima_and_result_model() -> None:  # §5(3) + secondary point scale
    scoring = {m: PROFILE.module_specs[m].scoring.max_points for m in PROFILE.module_specs}
    assert scoring == {"listening": 200, "reading": 200, "scientific_structures": 100, "writing": 200, "speaking": 300}
    rm = build_manifest(PROFILE)["resultModel"]
    assert rm["levels"] == ["DSH-1", "DSH-2", "DSH-3"]
    assert rm["thresholdsPercent"] == {"DSH-1": 57, "DSH-2": 67, "DSH-3": 82}
    assert rm["writtenWeights"] == {"hv": 2, "lv": 2, "ws": 1, "tp": 2}
    assert rm["maxPoints"]["written"] == 700 and rm["maxPoints"]["oral"] == 300
    assert rm["writtenAndOralCompensate"] is False and rm["levelRequiresBothComponents"] is True
    assert rm["perPartMinimumPercent"] is None  # a local rule, deliberately not applied


def test_generic_presentation_switch_and_disclaimer() -> None:
    m = build_manifest(PROFILE)
    assert m["presentation"] == {"moduleCards": "manifest", "disclaimer": DISCLAIMER}
    assert DISCLAIMER == "DSH practice based on the HRK framework; individual universities may have registered local regulations."
    # No other profile opts in or gets new manifest keys.
    for pid, profile in GERMAN_EXAM_PROFILES.items():
        if pid != "dsh":
            other = build_manifest(profile)
            assert "presentation" not in other and "resultModel" not in other
            assert all("code" not in x for x in other["modules"])


def test_skill_tags_come_from_the_module_vocabulary() -> None:
    for module, part in _parts():
        validate_tags(module, list(part.allowed_skill_tags))
    assert "scientific_structures" in SKILL_TAGS and "language_elements" in SKILL_TAGS


# ---- topics ---------------------------------------------------------------------------------
def test_topic_banks_are_static_academic_and_area_tagged() -> None:
    banks = PROFILE.topic_banks
    assert set(banks) == {"listening", "reading", "writing", "speaking"}  # WS derives from LV: no bank
    for topics in banks.values():
        assert len(topics) >= 5
        assert all(t["area"] in dsh_mod.TOPIC_AREAS and t["topicId"] and t["label"] for t in topics)
        assert len({t["topicId"] for t in topics}) == len(topics)


def test_written_topic_sets_need_two_areas_and_no_repeats() -> None:  # §10(2)
    for seed in range(0, 300, 7):
        pick = dsh_mod.pick_written_topic_set(seed)
        assert dsh_mod.written_topic_set_is_valid(pick["listening"], pick["reading"], pick["writing"])
    assert dsh_mod.pick_written_topic_set(3) == dsh_mod.pick_written_topic_set(3)  # deterministic
    # hv_urban_heat + lv_diet_health are both health_environment; tp_sports_health too -> one area only
    assert not dsh_mod.written_topic_set_is_valid("hv_urban_heat", "lv_diet_health", "tp_sports_health")
    assert not dsh_mod.written_topic_set_is_valid("nope", "lv_diet_health", "tp_sports_health")


# ---- no leakage from other exams --------------------------------------------------------------
def test_no_other_exam_content_leaks_into_dsh() -> None:
    other_types = {p.task_type for pid, prof in GERMAN_EXAM_PROFILES.items() if pid != "dsh"
                   for parts in prof.modules.values() for p in parts or ()}
    assert not other_types & {p.task_type for _, p in _parts()}
    text = (ROOT / "backend/python-ai/app/services/german_exams/dsh.py").read_text(encoding="utf8").lower()
    for word in ("telc", "goethe", "testdaf", "sprachbaustein"):
        assert not re.search(r"[\"']" + word, text), word  # never used as data


# ---- registration mirrors ---------------------------------------------------------------------
def test_ts_registries_and_onboarding_levels_mirror_the_profile() -> None:
    edge = (ROOT / "backend/lib/german-learner-profile.ts").read_text(encoding="utf8")
    client = (ROOT / "frontend/js/features/auth/german-profile.ts").read_text(encoding="utf8")
    assert "{ profileId: 'dsh', family: 'DSH', levels: ['DSH-1', 'DSH-2', 'DSH-3'] }" in edge
    assert "{ profileId: 'dsh', family: 'DSH', legacyLevelValues: ['DSH-1', 'DSH-2', 'DSH-3'] }" in client
    assert "DSH: ['DSH-1', 'DSH-2', 'DSH-3']" in client


def test_frontend_standalone_dsh_manifest_fixture_matches_the_profile() -> None:
    """tests/frontend/fixtures/dsh-manifest.json lets the frontend tests run without this backend."""
    import json

    path = ROOT / "tests/frontend/fixtures/dsh-manifest.json"
    assert json.loads(path.read_text(encoding="utf8")) == json.loads(json.dumps(build_manifest(PROFILE)))


def test_profile_file_has_exactly_one_profile_id_line() -> None:
    src = (ROOT / "backend/python-ai/app/services/german_exams/dsh.py").read_text(encoding="utf8")
    assert len(re.findall(r'^    profile_id="dsh",', src, re.M)) == 1
