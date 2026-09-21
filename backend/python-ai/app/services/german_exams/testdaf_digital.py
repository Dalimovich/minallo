"""Digital TestDaF foundation: all editable exam facts belong in this file.

The parts describe the scored core, not additional unscored trial tasks.
Module times are approximate; response times are speaking time only.
No raw-to-scaled conversion is published in the cited sources, so executable
ScoringSpec values remain None. TDN_BANDS apply ONLY to official scaled scores.
Scoring metadata below is descriptive and is not yet exposed by the manifest.
Only quality-gated task types can be made available; see each part below.
Skill tags/adaptations are application policy, not official examination rules.
"""

from __future__ import annotations

from .shared import ExamProfile, ModuleSpec, PartBlueprint

OFFICIAL_SOURCES = {
    "reading_mc_example": "https://www.testdaf.de/fileadmin/testdaf/downloads/Demo_Version_digitaler_TestDaF/Beispielaufgaben_Demo-Version_digitaler_TestDaF.pdf",
    "structure": "https://www.testdaf.de/de/teilnehmende/der-digitale-testdaf/aufbau-des-digitalen-testdaf/",
    "scoring": "https://www.testdaf.de/de/teilnehmende/der-digitale-testdaf/auswertung-des-digitalen-testdaf/",
}
VERIFIED_AT = "2026-09-20"
PROFILE_VERSION = 2

TDN_BANDS = (
    {"label": "Unter TDN 3", "min": 0, "max": 4},
    {"label": "TDN 3", "min": 5, "max": 9},
    {"label": "TDN 4", "min": 10, "max": 15},
    {"label": "TDN 5", "min": 16, "max": 20},
)
SCORING_METADATA = {
    "scaleMin": 0,
    "scaleMax": 20,
    "totalScaleMax": 80,
    "modulesAssessedSeparately": True,
    "bands": TDN_BANDS,
    "rawToScaledConversion": None,
    "rawToScaledConversionAvailable": False,
    "unscoredTrialTasksExcluded": True,
    "humanRatedModules": ("writing", "speaking"),
    "humanRatedListeningParts": ("hoeren_1", "hoeren_2", "hoeren_5"),
    "source": OFFICIAL_SOURCES["scoring"],
}
MODULE_METADATA = {
    "reading": {"taskCount": 7, "itemCount": 34, "durationSecondsApprox": 55 * 60},
    "listening": {"taskCount": 7, "itemCount": 30, "durationSecondsApprox": 40 * 60},
    "writing": {"taskCount": 2, "durationSecondsApprox": 60 * 60},
    "speaking": {"taskCount": 7, "durationSecondsApprox": 35 * 60},
}
DELIVERY_METADATA = {
    "fixedTaskOrder": True,
    "backNavigationAllowed": False,
    "additionalUnscoredTrialTasks": True,
    "taskCountsAndModuleTimesMayVary": True,
    "writingInput": "keyboard",
    "speakingInput": "recorded_audio",
}

_TAGS = {
    "reading": ("detail_comprehension", "text_structure", "inference", "author_intention", "argument_structure", "paraphrase_mapping"),
    "listening": ("detail_fact", "note_taking", "short_answer", "speaker_matching", "summary_error_detection", "sound_script_mapping"),
    "writing": ("task_fulfilment", "argument_structure", "coherence", "grammar_accuracy", "vocabulary_range", "register"),
    "speaking": ("task_fulfilment", "fluency", "argumentation", "coherence", "pronunciation", "register"),
}
# No adaptation is enabled before task implementations have been validated.
_ADAPTATIONS = {module: () for module in MODULE_METADATA}
_GRADING_DIMENSIONS = {
    "writing": ("task_fulfilment", "source_fidelity", "coherence", "linguistic_range", "comprehensibility"),
    "speaking": ("task_fulfilment", "situational_appropriateness", "source_fidelity", "fluency", "pronunciation", "linguistic_range", "comprehensibility"),
}


def _part(module: str, part_id: str, title: str, task_type: str, **constraints) -> PartBlueprint:
    return PartBlueprint(
        part_id=part_id, module=module, title=title, task_type=task_type,
        constraints=constraints, allowed_skill_tags=_TAGS[module],
        allowed_adaptations=_ADAPTATIONS[module],
        grading_dimensions=_GRADING_DIMENSIONS.get(module),
        scoring=None, available=False,
    )


# Demo pp. 8-9: four options, seven questions, numbered paragraphs, 15 minutes.
# Paragraph count, word budget and per-item scopes below are our practice policy
# modelled on that example, NOT universal official counts/length limits.
READING_MC_CONSTRAINTS = {
    "itemCount": 7,
    "optionCount": 4,
    "exampleTimeLimitSeconds": 900,
    "sourcePages": (8, 9),
    "sourceReference": OFFICIAL_SOURCES["reading_mc_example"],
    "textGenre": "popular-academic explanatory article with a clear line of argument, requiring no specialist knowledge",
    "readingRegister": "advanced B2/C1 academic reading; C1 practice target with nuanced reasoning and varied syntax",
    "questionStyle": "paragraph meaning, paraphrase, causal explanation, paragraph heading, author's stance; final question asks the whole article's communicative purpose",
    "itemsFollowTextOrder": True,
    "questionScopes": ("p1", "p2", "p3", "p4", "p5", "p6", "global"),
    "generationParagraphCount": 6,
    "generationWordCountMin": 500,
    "generationWordCountMax": 650,
    "balanceOptionPositions": True,
    # Application quality policy, not an official exam requirement.
    "generationModel": "gpt-5.4",
    "generationReasoningEffort": "medium",
    "generationMaxTokens": 10000,
    "verifierModel": "gpt-5.4",
    "presentation": {
        "numberParagraphs": True,
        "optionLabels": False,
        "instructions": "Lesen Sie den Artikel und bearbeiten Sie alle sieben Fragen. Wählen Sie jeweils eine Antwort. Sie können Ihre Auswahl bis zur Abgabe ändern. Übungszeit: 15 Minuten.",
    },
}


_READING = (
    _part("reading", "lesen_1", "Lückentext ergänzen", "lexical_cloze", itemCount=5),
    _part("reading", "lesen_2", "Textabschnitte ordnen", "paragraph_ordering", itemCount=4),
    _part("reading", "lesen_3", "Multiple-Choice", "reading_multiple_choice", **READING_MC_CONSTRAINTS),
    _part("reading", "lesen_4", "Sprachhandlungen zuordnen", "speech_act_matching", itemCount=4),
    _part("reading", "lesen_5", "Aussagen Kategorien zuordnen", "statement_category_matching", itemCount=7),
    _part("reading", "lesen_6", "Aussagen einem Begriffspaar zuordnen", "statement_concept_pair_matching", itemCount=4),
    _part("reading", "lesen_7", "Fehler in Zusammenfassung erkennen", "reading_summary_error_detection", itemCount=3),
)
_LISTENING = (
    _part("listening", "hoeren_1", "Kurzantwort: Übersicht ergänzen", "listening_overview_completion", itemCount=5, mediaType="audio"),
    _part("listening", "hoeren_2", "Kurzantwort: Textstellen zu Begriffspaar notieren", "listening_concept_pair_notes", itemCount=4, mediaType="audio"),
    _part("listening", "hoeren_3", "Fehler in Zusammenfassung erkennen", "listening_summary_error_detection", itemCount=2, mediaType="audio"),
    _part("listening", "hoeren_4", "Aussagen Personen zuordnen", "video_speaker_statement_matching", itemCount=6, mediaType="video"),
    _part("listening", "hoeren_5", "Kurzantwort: Gliederungspunkte zu Vortrag ergänzen", "video_outline_completion", itemCount=4, mediaType="video"),
    _part("listening", "hoeren_6", "Multiple-Choice", "listening_multiple_choice", itemCount=5, mediaType="audio"),
    _part("listening", "hoeren_7", "Laut- und Schriftbild abgleichen", "sound_script_comparison", itemCount=4, mediaType="audio"),
)
_WRITING = (
    _part("writing", "schreiben_1", "Argumentativen Text schreiben", "argumentative_essay", wordCountMin=200),
    _part("writing", "schreiben_2", "Informationen aus Lesetext und Grafik zusammenfassen", "text_graph_summary", wordCountMinApprox=100, wordCountMaxApprox=150),
)
_SPEAKING = (
    _part("speaking", "sprechen_1", "Rat geben", "spoken_advice", speakingSeconds=45),
    _part("speaking", "sprechen_2", "Optionen abwägen", "spoken_option_comparison", speakingSeconds=90),
    _part("speaking", "sprechen_3", "Text zusammenfassen", "spoken_text_summary", speakingSeconds=120),
    _part("speaking", "sprechen_4", "Informationen abgleichen, Stellung nehmen", "spoken_information_comparison", speakingSeconds=90),
    _part("speaking", "sprechen_5", "Thema präsentieren", "recorded_topic_presentation", speakingSeconds=150),
    _part("speaking", "sprechen_6", "Argumente wiedergeben, Stellung nehmen", "spoken_argument_response", speakingSeconds=120),
    _part("speaking", "sprechen_7", "Maßnahmen kritisieren", "spoken_measure_critique", speakingSeconds=90),
)

TESTDAF_DIGITAL = ExamProfile(
    profile_id="testdaf_digital", family="TestDaF", variant="Digital", cefr_level=None,
    # TDN alone does not distinguish digital from paper-based TestDaF.
    legacy_level_values=(), display_name="Digitaler TestDaF",
    source_name="g.a.s.t. / TestDaF-Institut: Aufbau und Auswertung des digitalen TestDaF",
    source_reference=OFFICIAL_SOURCES["structure"],
    source_version="Official web pages, retrieved " + VERIFIED_AT,
    verified_at=VERIFIED_AT, profile_version=PROFILE_VERSION,
    modules={"reading": _READING, "listening": _LISTENING, "writing": _WRITING, "speaking": _SPEAKING},
    module_specs={
        module: ModuleSpec(
            label=label, duration_seconds=MODULE_METADATA[module]["durationSecondsApprox"],
            note="Ungefähre Dauer; zusätzliche unbewertete Erprobungsaufgaben sind möglich.",
        )
        for module, label in (("reading", "Lesen"), ("listening", "Hören"), ("writing", "Schreiben"), ("speaking", "Sprechen"))
    },
)
