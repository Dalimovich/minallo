"""Goethe-Zertifikat C1 (modular) — every exam-specific fact for this exam.

Edit this file (and only this file) to change Goethe C1's modules, parts, task
types, official constraints, timings, scoring, grading dimensions, allowed
skills/adaptations, source metadata or profile version. Reusable behaviour
(generation / validation / rendering / scoring) lives in the shared task-type
implementations keyed by `PartBlueprint.task_type` — see task_types.py.

Sources (first-party, checked 2026-09-20):
  * Goethe-Zertifikat C1, Prüfungsziele / Testbeschreibung (Handbuch), © 2024
    Goethe-Institut — https://www.goethe.de/pro/relaunch/prf/de/Handbuch_Pruefungsziele_Testbeschreibung_C1.pdf
    (module table p.7, Lesen pp.24-28, Hören pp.29-33, Schreiben pp.35-37,
    Sprechen pp.39-42, Bewertung pp.43-52).
  * Goethe-Zertifikat C1, Durchführungsbestimmungen, Stand 1 September 2025 —
    https://www.goethe.de/pro/relaunch/prf/de/Durchfuehrungsbestimmungen_C1.pdf
    (§4 Lesen/Hören conversion table, §4.3 Schreiben, §5 Sprechen, §6 results).

Where the sources say "circa", the constraint key ends in `Approx`; nothing here
is an invented exact value. Values not yet verified (per-criterion Sprechen
weights) are deliberately absent rather than guessed.

There is intentionally NO `language_elements` module: Goethe C1 has no
Sprachbausteine section.

Every part is `available=False` until its generator, validator and renderer
exist (G1 Lesen, G2 Hören, G3 Schreiben, G4 Sprechen); flip the flag here then.
"""

from __future__ import annotations

from .shared import (
    SCORING_LOOKUP_TABLE,
    SCORING_RUBRIC,
    ExamProfile,
    ModuleSpec,
    PartBlueprint,
    ScoringSpec,
)

# Official raw-item -> result-point conversion for Lesen and Hören
# (Durchführungsbestimmungen 4.1/4.2, Stand 1.9.2025). Index = items correct (0..30).
# NOTE: the 2024 Handbuch prints 5 -> 19 (and "29" for 19 in the header row);
# both are typographical slips — the Durchführungsbestimmungen print 5 -> 17,
# which is also what round(raw * 3.33) gives. The table is transcribed, not computed.
RAW_TO_RESULT_POINTS: tuple[int, ...] = (
    0, 3, 7, 10, 13, 17, 20, 23, 27, 30,  # 0..9
    33, 37, 40, 43, 47, 50, 53, 57, 60, 63,  # 10..19
    67, 70, 73, 77, 80, 83, 87, 90, 93, 97,  # 20..29
    100,  # 30
)

RECEPTIVE_RAW_ITEMS = 30
MODULE_MAX_POINTS = 100
MODULE_PASS_POINTS = 60  # 60 % in every module (Handbuch 1.3, DFB 6.x)

_LESEN_TAGS = (  # must all be in german_exam_skill_tags.py's "reading" vocabulary (tested)
    "detail_comprehension", "global_comprehension", "selective_information", "text_structure",
    "reference_resolution", "paraphrase_mapping", "inference", "author_intention", "argument_structure",
)
_HOEREN_TAGS = (
    "global_main_idea", "detail_fact", "selective_information", "speaker_opinion",
    "attitude_tone", "not_stated_distinction", "implicit_inference", "paraphrase_mapping",
)

_LESEN_TOPICS: tuple[dict[str, str], ...] = (
    {"topicId": "remote_work_office", "label": "Homeoffice oder Büro – wie arbeiten wir künftig?"},
    {"topicId": "four_day_week", "label": "Die Vier-Tage-Woche: Chance oder Illusion?"},
    {"topicId": "social_media_youth", "label": "Soziale Medien und ihre Wirkung auf Jugendliche"},
    {"topicId": "city_car_free", "label": "Autofreie Innenstädte: Gewinn für alle?"},
    {"topicId": "ai_at_work", "label": "Künstliche Intelligenz am Arbeitsplatz"},
    {"topicId": "school_digital", "label": "Digitale Medien im Schulunterricht"},
    {"topicId": "local_journalism", "label": "Das Sterben der Lokalzeitungen"},
    {"topicId": "housing_costs", "label": "Wohnen in Großstädten: Wer kann es sich noch leisten?"},
    {"topicId": "science_communication", "label": "Wissenschaft in der Öffentlichkeit: Wie viel Vereinfachung ist erlaubt?"},
    {"topicId": "volunteering", "label": "Ehrenamt in einer Gesellschaft im Wandel"},
    {"topicId": "food_waste", "label": "Lebensmittelverschwendung und was dagegen hilft"},
    {"topicId": "language_and_gender", "label": "Sprache im Wandel: Debatte um gendergerechte Formulierungen"},
    {"topicId": "museums_future", "label": "Museen der Zukunft zwischen Tradition und Digitalisierung"},
    {"topicId": "mental_health_work", "label": "Psychische Belastung im Berufsalltag"},
    {"topicId": "energy_transition", "label": "Energiewende im Alltag: Was Haushalte tatsächlich bewegen"},
    {"topicId": "lifelong_learning", "label": "Weiterbildung im Beruf: Pflicht oder Chance?"},
)

_GOETHE_C1_LESEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="lesen_1", module="reading", title="Lückentext (Multiple Choice)",
        task_type="contextual_cloze_mc4",
        constraints={"gapCount": 8, "exampleGapCount": 1, "optionCount": 4, "wordCountApprox": 320,
                     "suggestedMinutes": 10, "balanceOptionPositions": True},
        allowed_skill_tags=_LESEN_TAGS, allowed_adaptations=("lexical_specificity", "grammar_complexity"),
        scoring=ScoringSpec(max_points=8, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="lesen_2", module="reading", title="Sachtext verstehen",
        task_type="reading_detail_mc3",
        # Handbuch p.26: deskriptiv-explikativer Sachtext (public sphere, scientific topic of general
        # interest), circa 680 words; the item order follows the text.
        constraints={"itemCount": 7, "optionCount": 3, "wordCountApprox": 680, "itemsFollowTextOrder": True,
                     "suggestedMinutes": 20,
                     "textGenre": "descriptive-explanatory article (Sachtext) with high information density on a "
                                  "scientific topic of general interest, as published in the general press",
                     "balanceOptionPositions": True},
        allowed_skill_tags=_LESEN_TAGS, allowed_adaptations=("paraphrase_distance", "inference_depth"),
        scoring=ScoringSpec(max_points=7, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="lesen_3", module="reading", title="Text mit Sätzen rekonstruieren",
        task_type="text_reconstruction_sentence_matching",
        # Handbuch p.27: "Der Text ist circa 530 Wörter lang, mit den ausgeschnittenen Sätzen circa 600
        # Wörter"; genre = Kommentar oder Reportage on a controversial topic (public/professional/academic).
        constraints={"gapCount": 8, "candidateCount": 10, "unusedCandidates": 2, "wordCountApprox": 530,
                     "wordCountWithSentencesApprox": 600, "suggestedMinutes": 20,
                     # Opt-in engine behaviours (telc's lesen_1 does not use them): exact placeholder /
                     # candidate integrity checks, and scrambling the candidate order.
                     "strictPlaceholders": True, "shuffleCandidates": True,
                     "generationMode": "article_first", "solverRepair": True,
                     # Engine tuning (not an official fact): verify the 8 gaps as 2 parallel chunks of 4,
                     # each against all 10 candidates — one 8x10 call exhausts its reasoning budget.
                     "verifier": {"chunks": 2, "chunkMaxTokens": 8000, "blindSolve": True},
                     "textGenre": "a press commentary (Kommentar) or report (Reportage) on a controversial current "
                                  "topic from public, professional or academic life"},
        allowed_skill_tags=_LESEN_TAGS, allowed_adaptations=("reference_complexity", "distractor_similarity"),
        scoring=ScoringSpec(max_points=8, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="lesen_4", module="reading", title="Meinungen zuordnen",
        task_type="multi_author_statement_matching_with_none",
        constraints={"authorCount": 3, "statementCount": 7, "unmatchedStatements": 2, "wordCountApprox": 430,
                     "suggestedMinutes": 15},
        allowed_skill_tags=_LESEN_TAGS, allowed_adaptations=("paraphrase_distance", "inference_depth"),
        scoring=ScoringSpec(max_points=7, points_per_correct=1), available=False,
    ),
)

_GOETHE_C1_HOEREN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="hoeren_1", module="listening", title="Podcast: drei Besprechungen zuordnen",
        task_type="multi_source_statement_matching",
        constraints={"sourceCount": 3, "statementCount": 6, "playsAllowed": 1, "readingSeconds": 60,
                     "wordCountApprox": 420},
        allowed_skill_tags=_HOEREN_TAGS, allowed_adaptations=("paraphrase_distance", "opinion_explicitness"),
        scoring=ScoringSpec(max_points=6, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="hoeren_2", module="listening", title="Interview: stimmt / stimmt nicht / nicht im Text",
        task_type="listening_tristate",
        constraints={"itemCount": 9, "answerOptions": ["stimmt", "stimmt nicht", "dazu wird nichts gesagt"],
                     "playsAllowed": 2, "readingSeconds": 60, "wordCountApprox": 620},
        allowed_skill_tags=_HOEREN_TAGS, allowed_adaptations=("distractor_proximity", "negation_density"),
        scoring=ScoringSpec(max_points=9, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="hoeren_3", module="listening", title="Gespräch in vier Abschnitten",
        task_type="segmented_dialogue_mc3",
        constraints={"sectionCount": 4, "itemsPerSection": 2, "optionCount": 3, "playsAllowed": 1,
                     "readingSecondsPerSection": 30, "speakerCount": 3, "wordCountApprox": 710},
        allowed_skill_tags=_HOEREN_TAGS, allowed_adaptations=("distractor_proximity", "opinion_explicitness"),
        scoring=ScoringSpec(max_points=8, points_per_correct=1), available=False,
    ),
    PartBlueprint(
        part_id="hoeren_4", module="listening", title="Vortrag",
        task_type="listening_detail_mc3",
        # A Vortrag (lecture) is a solo monologue, not a multi-speaker dialogue — overrides the
        # shared sentence_completion_mc3 validator's default speakerCountMin (2).
        constraints={"itemCount": 7, "optionCount": 3, "playsAllowed": 2, "readingSeconds": 90,
                     "wordCountApprox": 540, "speakerCountMin": 1},
        allowed_skill_tags=_HOEREN_TAGS, allowed_adaptations=("distractor_proximity", "negation_density"),
        scoring=ScoringSpec(max_points=7, points_per_correct=1), available=False,
    ),
)

# Schreiben rating (Handbuch Abb. 28/29, DFB 4.3): four criteria per task, five bands
# A..E, only the printed point values are awarded (no intermediate values).
# Teil 1 = 60 points, Teil 2 = 40 points; two independent raters, mean rounded.
WRITING_BAND_FRACTIONS = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.25, "E": 0.0}
_GOETHE_WRITING_DIMENSIONS = ("task_fulfilment", "coherence", "vocabulary", "structures")

_GOETHE_C1_SCHREIBEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="schreiben_1", module="writing", title="Diskussionsbeitrag (Forum)",
        task_type="forum_discussion_post",
        constraints={"contentPointCount": 4, "wordCountApprox": 230, "register": "neutral",
                     "suggestedMinutes": 50},
        allowed_skill_tags=("task_fulfilment", "coherence", "vocabulary_range", "grammar_accuracy", "register",
                            "argument_structure", "orthography"),
        allowed_adaptations=("argument_complexity", "register_challenge", "task_fulfilment_complexity"),
        scoring=ScoringSpec(
            max_points=60, mode=SCORING_RUBRIC, band_fractions=WRITING_BAND_FRACTIONS,
            criteria_max_points={"task_fulfilment": 14, "coherence": 14, "vocabulary": 16, "structures": 16},
        ),
        grading_dimensions=_GOETHE_WRITING_DIMENSIONS, time_limit_seconds=50 * 60, available=False,
    ),
    PartBlueprint(
        part_id="schreiben_2", module="writing", title="(Halb-)formelle Nachricht",
        task_type="formal_context_message",
        constraints={"contentPointCount": 4, "wordCountApprox": 120, "register": "formal_or_semiformal",
                     "addressForm": "Sie", "suggestedMinutes": 25},
        allowed_skill_tags=("task_fulfilment", "coherence", "vocabulary_range", "grammar_accuracy", "register",
                            "orthography"),
        allowed_adaptations=("register_challenge", "task_fulfilment_complexity"),
        scoring=ScoringSpec(
            max_points=40, mode=SCORING_RUBRIC, band_fractions=WRITING_BAND_FRACTIONS,
            criteria_max_points={"task_fulfilment": 10, "coherence": 10, "vocabulary": 10, "structures": 10},
        ),
        grading_dimensions=_GOETHE_WRITING_DIMENSIONS, time_limit_seconds=25 * 60, available=False,
    ),
)

_GOETHE_SPEAKING_TAGS = (
    "task_fulfilment", "coherence", "interaction", "vocabulary_range", "grammar_accuracy",
    "pronunciation", "register", "response_to_partner", "argumentation",
)
_GOETHE_SPEAKING_ADAPTATIONS = ("argument_complexity", "counterargument_pressure", "register_challenge")

# Sprechen rating criteria (Handbuch Abb. 34). Per-criterion point weights are
# in the Modellsatz Prüferblätter and are added when Sprechen is implemented.
_GOETHE_C1_SPRECHEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="sprechen_1", module="speaking", title="Vortrag mit anschließenden Fragen",
        task_type="presentation_with_followup",
        constraints={"topicChoiceCount": 2, "contentPointCount": 4, "presentationMinutesApprox": 5,
                     "totalMinutesApprox": 7},
        allowed_skill_tags=_GOETHE_SPEAKING_TAGS, allowed_adaptations=_GOETHE_SPEAKING_ADAPTATIONS,
        grading_dimensions=("task_fulfilment", "presentation_coherence", "presentation_questions_answers",
                            "vocabulary", "structures", "pronunciation"),
        available=False,
    ),
    PartBlueprint(
        part_id="sprechen_2", module="speaking", title="Diskussion führen",
        task_type="guided_pair_discussion",
        constraints={"discussionPromptCount": 4, "totalMinutesApprox": 5, "pairRequired": True,
                     "consensusRequired": False},
        allowed_skill_tags=_GOETHE_SPEAKING_TAGS, allowed_adaptations=_GOETHE_SPEAKING_ADAPTATIONS,
        grading_dimensions=("task_fulfilment", "discussion_interaction", "vocabulary", "structures",
                            "pronunciation"),
        available=False,
    ),
)

_RECEPTIVE_MODULE_SCORING = ScoringSpec(
    max_points=MODULE_MAX_POINTS, mode=SCORING_LOOKUP_TABLE, pass_points=MODULE_PASS_POINTS,
    raw_item_count=RECEPTIVE_RAW_ITEMS, raw_to_result_points=RAW_TO_RESULT_POINTS,
)
_PRODUCTIVE_MODULE_SCORING = ScoringSpec(
    max_points=MODULE_MAX_POINTS, mode=SCORING_RUBRIC, pass_points=MODULE_PASS_POINTS,
)

GOETHE_C1 = ExamProfile(
    profile_id="goethe_c1",
    family="Goethe",
    variant=None,
    cefr_level="C1",
    legacy_level_values=("C1",),
    source_name=(
        "Goethe-Zertifikat C1 – Prüfungsziele, Testbeschreibung (Handbuch 2024) + "
        "Durchführungsbestimmungen (Stand 2025-09-01)"
    ),
    source_reference=(
        "https://www.goethe.de/pro/relaunch/prf/de/Handbuch_Pruefungsziele_Testbeschreibung_C1.pdf ; "
        "https://www.goethe.de/pro/relaunch/prf/de/Durchfuehrungsbestimmungen_C1.pdf"
    ),
    source_version="Handbuch © 2024 Goethe-Institut; Durchführungsbestimmungen Stand 1. September 2025",
    verified_at="2026-09-20",
    profile_version=2,  # 2: Lesen Teil 3 genre + with-sentences word count, topic bank
    display_name="Goethe-Zertifikat C1",
    # Goethe C1 is general advanced German (public life, society, work, education, science, culture,
    # media, technology, environment) — not a university-only bank. Banks for the other modules are
    # added with their phases.
    topic_banks={"reading": _LESEN_TOPICS},
    module_specs={
        # Lesen 65 min includes 5 min to transfer answers; Hören ~40 min includes pause and 3 min transfer.
        "reading": ModuleSpec(label="Lesen", duration_seconds=65 * 60, scoring=_RECEPTIVE_MODULE_SCORING),
        "listening": ModuleSpec(label="Hören", duration_seconds=40 * 60, scoring=_RECEPTIVE_MODULE_SCORING),
        "writing": ModuleSpec(label="Schreiben", duration_seconds=75 * 60, scoring=_PRODUCTIVE_MODULE_SCORING,
                              note="Both texts together should be at least 350 words."),
        "speaking": ModuleSpec(label="Sprechen", preparation_seconds=20 * 60, scoring=_PRODUCTIVE_MODULE_SCORING,
                               note="Pair exam of about 20 minutes; the introductory warm-up is not scored."),
    },
    modules={
        "reading": _GOETHE_C1_LESEN,
        "listening": _GOETHE_C1_HOEREN,
        "writing": _GOETHE_C1_SCHREIBEN,
        "speaking": _GOETHE_C1_SPRECHEN,
    },
)
