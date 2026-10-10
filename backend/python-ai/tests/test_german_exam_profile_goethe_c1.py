"""goethe_c1 exam-specific structure (app/services/german_exams/goethe_c1.py).

Every number asserted here traces to the Goethe-Zertifikat C1 Handbuch (2024) or
the Durchführungsbestimmungen (Stand 2025-09-01) cited in the profile file."""

from __future__ import annotations

import pytest

from app.services.german_exams import GermanExamProfileError, get_part, get_profile, list_parts, resolve_profile_id
from app.services.german_exams.goethe_c1 import RAW_TO_RESULT_POINTS, WRITING_BAND_FRACTIONS

PID = "goethe_c1"


def _sum_scoring(module: str) -> int:
    return sum(p.scoring.max_points for p in list_parts(PID, module) if p.scoring)


def test_resolves_only_from_goethe_plus_c1() -> None:
    assert resolve_profile_id("Goethe", "C1") == PID
    assert resolve_profile_id("goethe", "C1") == PID
    for family, level in [("Goethe", "B2"), ("Goethe", "C2"), ("Goethe", "B1"), ("telc", "C1"), ("OESD", "C1"), ("", "C1")]:
        assert resolve_profile_id(family, level) is None, (family, level)


def test_profile_metadata() -> None:
    p = get_profile(PID)
    assert p.family == "Goethe" and p.cefr_level == "C1" and p.display_name == "Goethe-Zertifikat C1"
    assert p.source_name and p.source_reference.startswith("https://www.goethe.de/") and p.source_version
    assert p.verified_at and p.profile_version >= 1


def test_module_set_has_no_language_elements() -> None:
    p = get_profile(PID)
    assert set(p.modules) == {"reading", "listening", "writing", "speaking"}
    assert "language_elements" not in p.modules


def test_language_elements_and_telc_part_fail_cleanly() -> None:
    with pytest.raises(GermanExamProfileError):
        get_part(PID, "language_elements", "sprachbausteine_1")
    with pytest.raises(GermanExamProfileError):
        list_parts(PID, "language_elements")
    with pytest.raises(GermanExamProfileError):
        get_part(PID, "listening", "hv1")  # telc-only part id
    with pytest.raises(GermanExamProfileError):
        get_part("telc_c1_hochschule", "reading", "lesen_4")  # goethe-only part


def test_lesen_module_structure() -> None:
    parts = list_parts(PID, "reading")
    assert [p.part_id for p in parts] == ["lesen_1", "lesen_2", "lesen_3", "lesen_4"]
    assert sum(p.scoring.max_points for p in parts) == 30
    spec = get_profile(PID).module_specs["reading"]
    assert spec.duration_seconds == 65 * 60


def test_lesen_parts() -> None:
    p1, p2, p3, p4 = list_parts(PID, "reading")
    assert p1.task_type == "contextual_cloze_mc4"
    assert (p1.constraints["gapCount"], p1.constraints["optionCount"], p1.constraints["suggestedMinutes"]) == (8, 4, 10)
    assert p2.task_type == "reading_detail_mc3"
    assert (p2.constraints["itemCount"], p2.constraints["optionCount"], p2.constraints["suggestedMinutes"]) == (7, 3, 20)
    assert p3.task_type == "text_reconstruction_sentence_matching"
    assert (p3.constraints["gapCount"], p3.constraints["candidateCount"], p3.constraints["unusedCandidates"]) == (8, 10, 2)
    assert p3.constraints["suggestedMinutes"] == 20
    assert p4.task_type == "multi_author_statement_matching_with_none"
    assert (p4.constraints["authorCount"], p4.constraints["statementCount"], p4.constraints["unmatchedStatements"]) == (3, 7, 2)
    assert p4.constraints["suggestedMinutes"] == 15


def test_hoeren_module_structure() -> None:
    parts = list_parts(PID, "listening")
    assert [p.part_id for p in parts] == ["hoeren_1", "hoeren_2", "hoeren_3", "hoeren_4"]
    assert sum(p.scoring.max_points for p in parts) == 30
    assert get_profile(PID).module_specs["listening"].duration_seconds == 40 * 60


def test_hoeren_parts() -> None:
    p1, p2, p3, p4 = list_parts(PID, "listening")
    assert p1.task_type == "multi_source_statement_matching"
    assert (p1.constraints["sourceCount"], p1.constraints["statementCount"]) == (3, 6)
    assert (p1.constraints["playsAllowed"], p1.constraints["readingSeconds"]) == (1, 60)
    assert p2.task_type == "listening_tristate"
    assert p2.constraints["itemCount"] == 9 and p2.constraints["playsAllowed"] == 2 and p2.constraints["readingSeconds"] == 60
    assert p2.constraints["answerOptions"] == ["stimmt", "stimmt nicht", "dazu wird nichts gesagt"]
    assert p3.task_type == "segmented_dialogue_mc3"
    assert (p3.constraints["sectionCount"], p3.constraints["itemsPerSection"], p3.constraints["optionCount"]) == (4, 2, 3)
    assert (p3.constraints["playsAllowed"], p3.constraints["readingSecondsPerSection"]) == (1, 30)
    assert p4.task_type == "listening_detail_mc3"
    assert (p4.constraints["itemCount"], p4.constraints["optionCount"], p4.constraints["playsAllowed"]) == (7, 3, 2)
    assert p4.constraints["readingSeconds"] == 90


def test_schreiben_structure_and_rubric_weights() -> None:
    p1, p2 = list_parts(PID, "writing")
    assert get_profile(PID).module_specs["writing"].duration_seconds == 75 * 60
    assert (p1.task_type, p2.task_type) == ("forum_discussion_post", "formal_context_message")
    assert (p1.constraints["contentPointCount"], p1.constraints["wordCountApprox"], p1.constraints["suggestedMinutes"]) == (4, 230, 50)
    assert (p2.constraints["contentPointCount"], p2.constraints["wordCountApprox"], p2.constraints["suggestedMinutes"]) == (4, 120, 25)
    assert p1.scoring.max_points == 60 and p2.scoring.max_points == 40
    assert p1.scoring.criteria_max_points == {"task_fulfilment": 14, "coherence": 14, "vocabulary": 16, "structures": 16}
    assert p2.scoring.criteria_max_points == {"task_fulfilment": 10, "coherence": 10, "vocabulary": 10, "structures": 10}
    for p in (p1, p2):
        assert sum(p.scoring.criteria_max_points.values()) == p.scoring.max_points
        assert p.grading_dimensions == ("task_fulfilment", "coherence", "vocabulary", "structures")
    assert p1.scoring.max_points + p2.scoring.max_points == 100
    assert WRITING_BAND_FRACTIONS == {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.25, "E": 0.0}


def test_sprechen_structure() -> None:
    p1, p2 = list_parts(PID, "speaking")
    spec = get_profile(PID).module_specs["speaking"]
    assert spec.preparation_seconds == 20 * 60
    assert len(list_parts(PID, "speaking")) == 2  # the warm-up is not a scored learner part
    assert p1.task_type == "presentation_with_followup"
    assert (p1.constraints["topicChoiceCount"], p1.constraints["contentPointCount"]) == (2, 4)
    assert p2.task_type == "guided_pair_discussion"
    assert p2.constraints["discussionPromptCount"] == 4 and p2.constraints["consensusRequired"] is False
    assert "discussion_interaction" in p2.grading_dimensions and "presentation_coherence" in p1.grading_dimensions


def test_receptive_modules_use_official_lookup_table() -> None:
    for module in ("reading", "listening"):
        s = get_profile(PID).module_specs[module].scoring
        assert (s.resolved_mode, s.raw_item_count, s.max_points, s.pass_points) == ("lookup_table", 30, 100, 60)


# Transcribed independently from Durchführungsbestimmungen 4.1 (Stand 2025-09-01).
_OFFICIAL = {30: 100, 29: 97, 28: 93, 27: 90, 26: 87, 25: 83, 24: 80, 23: 77, 22: 73, 21: 70, 20: 67, 19: 63, 18: 60,
             17: 57, 16: 53, 15: 50, 14: 47, 13: 43, 12: 40, 11: 37, 10: 33, 9: 30, 8: 27, 7: 23, 6: 20, 5: 17,
             4: 13, 3: 10, 2: 7, 1: 3, 0: 0}


@pytest.mark.parametrize("raw", range(31))
def test_conversion_table_every_raw_value(raw: int) -> None:
    assert RAW_TO_RESULT_POINTS[raw] == _OFFICIAL[raw]


def test_pass_threshold_is_18_of_30() -> None:
    assert RAW_TO_RESULT_POINTS[18] == 60 and RAW_TO_RESULT_POINTS[17] == 57
