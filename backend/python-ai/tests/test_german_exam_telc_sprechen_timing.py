"""TELC C1 Hochschule Sprechen timing, reconciled against the official telc Handbuch
(Lernziele und Testspezifikationen, pp. 47-50, telc.net .../Deutsch_c1_hochschule_Handbuch.pdf):
- 20 min Vorbereitung; mündliche Prüfung ca. 16 min für eine Paarprüfung (ca. 24 min Dreierprüfung)
- Teil 1A ca. 3 min PRO TEILNEHMER, Teil 1B ca. 2 min PRO TEILNEHMER, Teil 2 ca. 6 min (shared dialogue)
- Punkte: Teil 1A 6, Teil 1B 4, sprachliche Angemessenheit 32 (four criteria x 8)

The earlier "11 min vs 16 min" mismatch summed a single participant's turns; the pair total is 16.
"""
from app.services.german_exams import get_part
from app.services.german_exams.telc_c1_hochschule import SPEAKING_LANGUAGE_MAXIMA, SPEAKING_TASK_MAXIMA


def test_pair_exam_total_is_sixteen_minutes_when_both_participants_are_counted() -> None:
    s1 = get_part("telc_c1_hochschule", "speaking", "sprechen_1").constraints
    s2 = get_part("telc_c1_hochschule", "speaking", "sprechen_2").constraints
    assert s1["presentationSeconds"] == 180 and s1["summaryFollowupSeconds"] == 120
    per_participant = s1["presentationSeconds"] + s1["summaryFollowupSeconds"]
    assert 2 * per_participant + s2["discussionSeconds"] == 16 * 60


def test_sprechen_1_time_limit_is_the_per_participant_share() -> None:
    part = get_part("telc_c1_hochschule", "speaking", "sprechen_1")
    assert part.time_limit_seconds == part.constraints["presentationSeconds"] + part.constraints["summaryFollowupSeconds"]


def test_speaking_point_weights_match_the_handbook() -> None:
    assert SPEAKING_TASK_MAXIMA["presentation"] == 6 and SPEAKING_TASK_MAXIMA["summary_followup"] == 4
    assert SPEAKING_TASK_MAXIMA["discussion"] == 6  # Handbuch p.50: Teil 2 = 6 Punkte
    assert sum(SPEAKING_LANGUAGE_MAXIMA.values()) == 32
