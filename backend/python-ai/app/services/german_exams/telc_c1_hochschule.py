"""telc Deutsch C1 Hochschule — every exam-specific fact for this exam.

Edit this file (and only this file) to change telc C1 Hochschule's modules,
parts, task types, official constraints, timings, scoring, grading dimensions,
allowed skills/adaptations, source metadata or profile version. Reusable
behaviour (generation / validation / rendering / scoring) lives in the shared
task-type implementations, keyed by `PartBlueprint.task_type`.
"""

from __future__ import annotations

from .shared import ExamProfile, ModuleSpec, PartBlueprint, ScoringSpec

_TELC_C1_HOCHSCHULE_HOEREN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="hv1",
        module="listening",
        title="Globalverstehen",
        task_type="speaker_statement_matching",
        constraints={
            "speakerCount": 8,
            "statementCount": 10,
            "unusedStatements": 2,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "global_main_idea",
            "paraphrase_mapping",
            "speaker_matching",
            "speaker_intention",
            "speaker_opinion",
            "attitude_tone",
        ),
        allowed_adaptations=("paraphrase_distance", "opinion_explicitness", "inference_depth"),
        scoring=ScoringSpec(max_points=8, points_per_correct=1),
        approx_duration_seconds=480,  # ~ 8 min, per official material — audio length, not prep time
    ),
    PartBlueprint(
        part_id="hv2",
        module="listening",
        title="Detailverstehen",
        task_type="sentence_completion_mc3",
        # speakerCount is deliberately NOT a hard "2" — official material describes "zwei oder
        # mehr Menschen" (an interview/discussion), so only a minimum is an official constraint.
        constraints={
            "itemCount": 10,
            "optionCount": 3,
            "speakerCountMin": 2,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "detail_fact",
            "selective_information",
            "numbers_dates",
            "negation_contrast",
            "causal_relationship",
            "implicit_inference",
            "not_stated_distinction",
        ),
        allowed_adaptations=("distractor_proximity", "negation_density"),
        scoring=ScoringSpec(max_points=20, points_per_correct=2),
        approx_duration_seconds=540,  # ~ 9 min
    ),
    PartBlueprint(
        part_id="hv3",
        module="listening",
        title="Informationstransfer",
        task_type="structured_note_completion",
        constraints={
            "itemCount": 10,
            "playsAllowed": 1,
        },
        allowed_skill_tags=(
            "academic_structure",
            "note_taking",
            "detail_fact",
            "numbers_dates",
            "argument_structure",
            "summary_error_detection",
        ),
        allowed_adaptations=("signposting_explicitness", "hierarchy_depth"),
        scoring=ScoringSpec(max_points=20, points_per_correct=2),
        approx_duration_seconds=1200,  # ~ 20 min
    ),
)


# Lesen + Sprachbausteine officially share one 90-minute block; the learner
# may allocate that time freely across parts. This is UI/prep-guide copy,
# not an enforced per-part timer — see PartBlueprint.time_limit_seconds'
# docstring (reserved for future exam-simulation mode).
LESEN_SPRACHBAUSTEINE_SHARED_MINUTES = 90

_TELC_C1_HOCHSCHULE_LESEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="lesen_1",
        module="reading",
        title="Textrekonstruktion",
        task_type="text_reconstruction_sentence_matching",
        constraints={
            "gapCount": 6,
            "candidateCount": 8,
            "unusedCandidates": 2,
            "wordCountMin": 400,
            "wordCountMax": 500,
        },
        allowed_skill_tags=(
            "text_structure",
            "reference_resolution",
            "argument_structure",
            "paraphrase_mapping",
        ),
        allowed_adaptations=("reference_complexity", "distractor_similarity"),
        scoring=ScoringSpec(max_points=12, points_per_correct=2),
    ),
    PartBlueprint(
        part_id="lesen_2",
        module="reading",
        title="Selektives Verstehen",
        task_type="section_statement_matching",
        constraints={
            "sectionCount": 5,
            "statementCount": 6,
            "wordCountMin": 650,
            "wordCountMax": 850,
        },
        allowed_skill_tags=(
            "global_comprehension",
            "selective_information",
            "author_intention",
            "paraphrase_mapping",
            "inference",
            "argument_structure",
        ),
        allowed_adaptations=("paraphrase_distance", "inference_depth"),
        scoring=ScoringSpec(max_points=12, points_per_correct=2),
    ),
    PartBlueprint(
        part_id="lesen_3",
        module="reading",
        title="Detail- und Globalverstehen",
        task_type="detail_tristate_with_global_heading",
        constraints={
            "detailItemCount": 11,
            "globalHeadingItemCount": 1,  # exactly one heading-question item
            "globalHeadingOptionCount": 3,  # that item has exactly 3 heading options
            "wordCountMin": 1000,
            "wordCountMax": 1200,
        },
        allowed_skill_tags=(
            "detail_comprehension",
            "global_comprehension",
            "inference",
            "text_structure",
            "argument_structure",
        ),
        allowed_adaptations=("inference_depth", "argument_complexity", "author_intention_explicitness"),
        scoring=ScoringSpec(max_points=24, points_per_correct=2),
    ),
)


_TELC_C1_HOCHSCHULE_SPRACHBAUSTEINE: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="sprachbausteine_1",
        module="language_elements",
        title="Sprachbausteine",
        task_type="cloze_mc4_language_elements",
        constraints={
            "itemCount": 22,
            "optionCount": 4,
            "wordCountMin": 320,
            "wordCountMax": 350,
            "grammarCountMin": 12,
            "grammarCountMax": 16,
            "lexicalCountMin": 4,
            "lexicalCountMax": 8,
            "orthographyCountMin": 1,
            "orthographyCountMax": 4,
        },
        allowed_skill_tags=(
            "grammar",
            "collocation",
            "connectors",
            "prepositions",
            "word_formation",
            "register",
            "syntax",
            "lexical_choice",
        ),
        allowed_adaptations=("lexical_specificity", "grammar_complexity"),
        scoring=ScoringSpec(max_points=22, points_per_correct=1),
    ),
)


# telc official duration for Schreiben: 70 minutes.
SCHREIBEN_MINUTES = 70

_TELC_C1_HOCHSCHULE_SCHREIBEN: tuple[PartBlueprint, ...] = (
    PartBlueprint(
        part_id="schreiben_1",
        module="writing",
        title="Schreiben",
        task_type="choice_long_form_writing",
        constraints={
            "topicChoiceCount": 2,
            "wordCountMin": 350,
            "statementCount": 2,
            "inputWordCountMin": 45,
            "inputWordCountMax": 55,
        },
        # Full "writing" skill-tag vocabulary (see german_exam_skill_tags.py)
        # — these are the tags a GRADED SUBMISSION's rubric-dimension attempt
        # rows may carry (see german_exam_writing_grading.py), not tags on
        # the generated task itself, which has no skill-tagged items.
        allowed_skill_tags=(
            "task_fulfilment",
            "argument_structure",
            "coherence",
            "cohesion",
            "grammar_accuracy",
            "vocabulary_range",
            "register",
            "sentence_variety",
            "orthography",
        ),
        allowed_adaptations=(
            "argument_complexity",
            "register_challenge",
            "cohesion_demand",
            "task_fulfilment_complexity",
        ),
        # Writing has no fixed per-item point value — the 48-point max is an
        # overall exam-mode score derived from the rubric (see
        # german_exam_writing_grading.py), not itemCount * points_per_correct.
        scoring=ScoringSpec(max_points=48, points_per_correct=None),
        grading_dimensions=(
            "task_fulfilment",
            "correctness",
            "repertoire",
            "communicative_design",
        ),
        time_limit_seconds=SCHREIBEN_MINUTES * 60,
    ),
)


SPEAKING_TASK_MAXIMA = {"presentation": 6, "summary_followup": 4, "discussion": 6}
SPEAKING_LANGUAGE_MAXIMA = {"fluency": 8, "repertoire": 8, "grammatical_correctness": 8, "pronunciation_intonation": 8}
_SPEAKING_TAGS = ("task_fulfilment", "fluency", "interaction", "argumentation", "coherence",
                  "grammar_accuracy", "vocabulary_range", "pronunciation", "register", "response_to_partner")
_SPEAKING_ADAPTATIONS = ("argument_complexity", "required_spontaneity", "counterargument_pressure", "register_challenge", "followup_complexity")
_TELC_C1_HOCHSCHULE_SPRECHEN = (
    PartBlueprint(
        part_id="sprechen_1", module="speaking", title="Präsentation, Zusammenfassung und Anschlussfragen",
        task_type="presentation_summary_followup",
        constraints={"topicChoiceCount": 2, "presentationSeconds": 180, "summaryFollowupSeconds": 120,
                     "subtasks": ["1A", "1B"], "taskMaxima": {"presentation": 6, "summary_followup": 4}},
        allowed_skill_tags=_SPEAKING_TAGS, allowed_adaptations=_SPEAKING_ADAPTATIONS,
        scoring=ScoringSpec(max_points=10, points_per_correct=None),
        grading_dimensions=("presentation", "summary_followup"), time_limit_seconds=300,
    ),
    PartBlueprint(
        part_id="sprechen_2", module="speaking", title="Diskussion", task_type="quote_guided_discussion",
        constraints={"discussionTopicCount": 1, "examinerTopicPoolCount": 3, "discussionSeconds": 360,
                     "taskMaxima": {"discussion": 6}},
        allowed_skill_tags=_SPEAKING_TAGS, allowed_adaptations=_SPEAKING_ADAPTATIONS,
        scoring=ScoringSpec(max_points=6, points_per_correct=None),
        grading_dimensions=("discussion",), time_limit_seconds=360,
    ),
)


TELC_C1_HOCHSCHULE = ExamProfile(
    profile_id="telc_c1_hochschule",
    family="telc",
    variant="C1 Hochschule",
    cefr_level="C1",
    legacy_level_values=("C1 Hochschule",),
    source_name="telc Deutsch C1 Hochschule – Handbuch",
    source_reference="telc GmbH official model-test/handbook material for telc Deutsch C1 Hochschule",
    source_version="verified against current telc.net exam-format description",
    verified_at="2026-09-17",
    profile_version=5,
    display_name="telc Deutsch C1 Hochschule",
    # Navigation order. Lesen and Sprachbausteine officially share one 90-minute
    # block (LESEN_SPRACHBAUSTEINE_SHARED_MINUTES), so neither carries its own duration.
    module_specs={
        "reading": ModuleSpec(label="Lesen"),
        "listening": ModuleSpec(label="Hören"),
        "language_elements": ModuleSpec(label="Sprachbausteine"),
        "writing": ModuleSpec(label="Schreiben", duration_seconds=SCHREIBEN_MINUTES * 60),
        "speaking": ModuleSpec(label="Sprechen"),
    },
    modules={
        "listening": _TELC_C1_HOCHSCHULE_HOEREN,
        "reading": _TELC_C1_HOCHSCHULE_LESEN,
        "writing": _TELC_C1_HOCHSCHULE_SCHREIBEN,
        "speaking": _TELC_C1_HOCHSCHULE_SPRECHEN,
        "language_elements": _TELC_C1_HOCHSCHULE_SPRACHBAUSTEINE,
    },
)
