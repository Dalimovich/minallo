"""DSH (Deutsche Sprachprüfung für den Hochschulzugang) — every exam-specific fact for this exam.

One exam = one file. DSH-1 / DSH-2 / DSH-3 are RESULT LEVELS of the same exam, not three exams:
this file is the single DSH profile and the levels are exposed through `legacy_level_values`
(the onboarding target-level strings) and `result_model` (thresholds).

Primary source (checked 2026-09-24, text read directly from the PDF):
  * HRK, "DSH-Musterprüfungsordnung", Anlage 1 zur Rahmenordnung RO-DT, Beschluss der HRK vom
    29.09.2025 sowie KMK-Beschlüsse vom 20.11.2025 und 27.11.2025 (in force, replaces the 2019 MPO).
    https://www.hrk.de/fileadmin/redaktion/hrk/02-Dokumente/02-07-Internationales/02-07-22_DSH/DSH_Musterpruefungsordnung_2025.pdf
    (§4 Gliederung, §5 Bewertung/Ergebnis, §10 Schriftliche Prüfung, §11 Mündliche Prüfung.)
Secondary (result arithmetic only): Universität Duisburg-Essen, "Berechnung des Ergebnisses"
  (700 written points = HV 200 / LV 200 / WS 100 / TP 200; oral 300).

Vocabulary used in the comments below:
  OFFICIAL  = stated in the 2025 MPO (section given).
  SECONDARY = stated by a university implementation, not by the MPO itself.
  DECISION  = a Minallo implementation choice (never presented as an official rule).

Individual universities register their OWN DSH regulations with the HRK (§12 of the MPO: "Hier wird
vom Standort die jeweils geltende Regelung eingefügt"). This profile is the generic HRK framework, not
any single university's exam; nothing local is mixed in.

Every part is `available=False`: this file only describes the exam's structure. Generation,
grading and rendering for DSH content do not exist yet, and a part may be flipped only after live
content qualification (see audit/dsh/IMPLEMENTATION_AUDIT.md).
"""

from __future__ import annotations

from .shared import (
    SCORING_RUBRIC,
    ExamProfile,
    ModuleSpec,
    PartBlueprint,
    ScoringSpec,
)

OFFICIAL_SOURCES = {
    "mpo_2025": "https://www.hrk.de/fileadmin/redaktion/hrk/02-Dokumente/02-07-Internationales/02-07-22_DSH/DSH_Musterpruefungsordnung_2025.pdf",
    "ro_dt_2025": "https://www.hrk.de/fileadmin/redaktion/hrk/02-Dokumente/02-07-Internationales/02-07-22_DSH/20260105_RO-DT_Fassung-HRK-v-04-11-2025-und-KMK-v-27-11-2025_01.pdf",
    "registration": "https://www.hrk.de/mitglieder/arbeitsmaterialien/registrierung-von-dsh-pruefungsordnungen/",
    "mpo_2019_superseded": "https://www.hrk.de/fileadmin/redaktion/hrk/02-Dokumente/02-07-Internationales/DSH_MPO_2019.pdf",
    "uni_due_result_calculation": "https://www.uni-due.de/dsh-info/berechnungergebnis.php",
}
VERIFIED_AT = "2026-09-24"
PROFILE_VERSION = 1

DISCLAIMER = (
    "DSH practice based on the HRK framework; individual universities may have registered local regulations."
)

# ---- Result model ---------------------------------------------------------------------------
RESULT_LEVELS = ("DSH-1", "DSH-2", "DSH-3")
# OFFICIAL §5(6): the level needs at least this share of the requirements in BOTH the written
# AND the oral exam.
LEVEL_THRESHOLDS_PERCENT = {"DSH-1": 57, "DSH-2": 67, "DSH-3": 82}
PASS_THRESHOLD_PERCENT = 57  # OFFICIAL §5(2) written, §5(5) oral

# OFFICIAL §5(3): HV, LV, WS, TP are weighted 2:2:1:2.
WRITTEN_WEIGHTS = {"hv": 2, "lv": 2, "ws": 1, "tp": 2}
# SECONDARY (Uni Duisburg-Essen): 100 points per weight unit -> 200/200/100/200 = 700; oral 300.
# The MPO itself only fixes the ratio and percentages, so these point maxima are a scale, not law.
POINTS_PER_WEIGHT_UNIT = 100
WRITTEN_MAX_POINTS = {key: weight * POINTS_PER_WEIGHT_UNIT for key, weight in WRITTEN_WEIGHTS.items()}
ORAL_MAX_POINTS = 300  # SECONDARY

RESULT_MODEL = {
    "kind": "dsh_result_model",
    "framework": "HRK DSH-Musterprüfungsordnung 2025",
    "levels": list(RESULT_LEVELS),
    "thresholdsPercent": dict(LEVEL_THRESHOLDS_PERCENT),
    "passThresholdPercent": PASS_THRESHOLD_PERCENT,
    "writtenWeights": dict(WRITTEN_WEIGHTS),
    "maxPoints": {**WRITTEN_MAX_POINTS, "written": sum(WRITTEN_MAX_POINTS.values()), "oral": ORAL_MAX_POINTS},
    # OFFICIAL §5(1),(6): both components must reach the level; a strong one cannot make up for a weak one.
    "levelRequiresBothComponents": True,
    "writtenAndOralCompensate": False,
    # The MPO sets no per-sub-test minimum; some universities add one locally. Not applied here.
    "perPartMinimumPercent": None,
    # The MPO / RO-DT publish no CEFR mapping for DSH levels; Minallo shows none.
    "officialCefrMapping": None,
    "disclaimer": DISCLAIMER,
}

# DECISION: generic, data-driven presentation switch consumed by the exam workspace (no exam-name checks
# in the frontend): the module cards come from this manifest, never from the legacy static cards.
PRESENTATION = {"moduleCards": "manifest", "disclaimer": DISCLAIMER}

# ---- Task types (behaviour lives elsewhere; all unimplemented) --------------------------------
TASK_TYPE_HV = "dsh_hv_lecture_tasks"
TASK_TYPE_LV = "dsh_lv_text_tasks"
TASK_TYPE_WS = "dsh_ws_structure_tasks"
TASK_TYPE_TP = "dsh_tp_chart_based_argumentation"
TASK_TYPE_ORAL = "dsh_oral_presentation_conversation"
DSH_TASK_TYPES = (TASK_TYPE_HV, TASK_TYPE_LV, TASK_TYPE_WS, TASK_TYPE_TP, TASK_TYPE_ORAL)

# Assessment focus per module (OFFICIAL §10(4), §11c). Kept as data so the three grading modes can
# never be merged into one generic grader by accident.
ASSESSMENT = {
    "listening": "content",  # §10(4)1d: "nicht nach sprachlicher Richtigkeit und Form"
    "reading": "content",  # §10(4)2c
    "scientific_structures": "language_correctness",  # §10(4)2e
    "writing": "content_and_language",  # §10(4)3b, language weighted more strongly
    "speaking": "oral_rubric",  # §11c
}

# ---- Skill tags (must exist in german_exam_skill_tags.SKILL_TAGS for the module) --------------
_HV_TAGS = ("global_main_idea", "detail_fact", "note_taking", "academic_structure", "argument_structure",
            "causal_relationship", "paraphrase_mapping")
_LV_TAGS = ("global_comprehension", "detail_comprehension", "text_structure", "argument_structure",
            "paraphrase_mapping", "inference", "reference_resolution")
_WS_TAGS = ("syntactic_structure", "morphological_structure", "lexical_structure", "idiomatic_structure",
            "text_type_structure", "paraphrase", "transformation", "complex_structure_comprehension")
_TP_TAGS = ("task_fulfilment", "argument_structure", "coherence", "cohesion", "grammar_accuracy",
            "vocabulary_range", "register", "sentence_variety", "orthography")
_ORAL_TAGS = ("task_fulfilment", "fluency", "interaction", "argumentation", "coherence", "grammar_accuracy",
              "vocabulary_range", "pronunciation", "response_to_partner")

# TP rubric. OFFICIAL §10(4)3b lists these two groups and says the language side "stärker zu
# berücksichtigen" — it publishes NO numeric weights, so none are invented here (see `numericWeights`).
TP_CONTENT_DIMENSIONS = ("content_completeness", "content_development", "content_structure", "content_coherence")
TP_LANGUAGE_DIMENSIONS = ("language_correctness", "language_vocabulary", "language_syntax", "language_cohesion")
TP_RUBRIC = {
    "content": TP_CONTENT_DIMENSIONS,
    "language": TP_LANGUAGE_DIMENSIONS,
    "languageWeightedHigher": True,
    "numericWeights": None,
}

# OFFICIAL §10(2): only a monolingual dictionary in paper form; no other aids.
_WRITTEN_AIDS = "monolingual_dictionary_paper_only"

_HV = PartBlueprint(
    part_id="hv_1", module="listening", title="Hörverstehen: Vortrag verstehen und verarbeiten",
    task_type=TASK_TYPE_HV,
    constraints={
        # OFFICIAL §10(4)1a: measured as the length of the equivalent WRITTEN text, "je nach
        # Redundanz". No audio duration is official, so none is stated here.
        "lectureCharsMin": 5500, "lectureCharsMax": 7000, "lectureLengthUnit": "characters_with_spaces_of_equivalent_written_text",
        "specialistKnowledgeRequired": False,
        "communicativeSituation": "lecture_or_seminar_exercise",
        # OFFICIAL §10(4)1b: presented twice, notes allowed.
        "presentationCount": 2, "notesAllowed": True,
        # OFFICIAL §10(1)1: 10 min after the 1st and 40 min after the 2nd presentation; the
        # presentation itself and any pre-teaching are not counted.
        "processingWindows": ({"afterPresentation": 1, "seconds": 600}, {"afterPresentation": 2, "seconds": 2400}),
        "processingTimeExcludesPresentation": True,
        # OFFICIAL §10(4)1b: topic hints, names/dates/difficult terms and visual aids are permitted.
        "topicHintAllowed": True, "namesDatesTermsMayBeGiven": True, "visualAidsAllowed": True,
        # OFFICIAL §10(4)1c: task forms may be combined.
        "taskForms": ("questions", "structure_sketch", "summary", "line_of_thought"), "taskFormsCombinable": True,
        "assessment": ASSESSMENT["listening"], "languageCorrectnessAssessed": False,
        "aids": _WRITTEN_AIDS,
    },
    allowed_skill_tags=_HV_TAGS, allowed_adaptations=(),
    scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["hv"], mode=SCORING_RUBRIC), available=False,
)

_LV = PartBlueprint(
    part_id="lv_1", module="reading", title="Leseverstehen: Text verstehen und verarbeiten",
    task_type=TASK_TYPE_LV,
    constraints={
        # OFFICIAL §10(4)2a
        "textCharsMin": 4500, "textCharsMax": 6000, "textLengthUnit": "characters_with_spaces",
        "textCharacter": "largely_authentic_study_related_science_oriented", "specialistKnowledgeRequired": False,
        "optionalGraphic": True,
        # OFFICIAL §10(4)2b
        "taskForms": ("questions", "argument_structure", "outline", "explain_passages", "headings", "summary"),
        "assessment": ASSESSMENT["reading"], "languageCorrectnessAssessed": False,
        # LV and WS are ONE examination part on ONE text (OFFICIAL §5(4), §10(4)2d).
        "sharedSourceGroup": "lv_ws", "sourceRole": "source",
        "aids": _WRITTEN_AIDS,
    },
    allowed_skill_tags=_LV_TAGS, allowed_adaptations=(),
    scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["lv"], mode=SCORING_RUBRIC), available=False,
)

_WS = PartBlueprint(
    part_id="ws_1", module="scientific_structures", title="Wissenschaftssprachliche Strukturen",
    task_type=TASK_TYPE_WS,
    constraints={
        # WS is derived from the LV text of the SAME examination (OFFICIAL §10(4)2d: "die
        # Besonderheiten des zugrunde gelegten Textes").
        "sharedSourceGroup": "lv_ws", "sourceRole": "derived",
        "sourcePart": {"module": "reading", "partId": "lv_1"},
        # OFFICIAL §10(4)2d
        "taskForms": ("completion", "complex_structure_comprehension", "paraphrase", "transformation"),
        "structureCategories": ("syntactic", "morphological", "lexical", "idiomatic", "text_type"),
        "assessment": ASSESSMENT["scientific_structures"], "languageCorrectnessAssessed": True,
        # DECISION: several answers can be linguistically correct, so the answer model is
        # "answer families", never a single key.
        "multipleAcceptedAnswers": True, "answerModel": "answer_families",
        "aids": _WRITTEN_AIDS,
    },
    allowed_skill_tags=_WS_TAGS, allowed_adaptations=(),
    scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["ws"], mode=SCORING_RUBRIC), available=False,
)

_TP = PartBlueprint(
    part_id="tp_1", module="writing", title="Vorgabenorientierte Textproduktion",
    task_type=TASK_TYPE_TP,
    constraints={
        # OFFICIAL §10(4)3a: "ca. 250 Wörtern" — approximate, so no minimum/maximum is stated.
        "wordCountApprox": 250,
        "textType": "argumentative_factual_text", "topicKind": "study_related_science_oriented",
        # OFFICIAL §10(4)3a: suitable inputs (non-linear texts and/or quotations, statements, short texts).
        "inputKinds": ("diagram", "keyword_list", "table", "graphic", "quotation", "statement", "short_text"),
        "languageActs": ("describe", "summarize", "compare", "justify", "evaluate", "take_position"),
        # OFFICIAL §10(4)3a: must not become a free essay; no pre-formulated passages / text blocks.
        "freeEssayAllowed": False, "templateFriendlyPromptsAllowed": False,
        "assessment": ASSESSMENT["writing"], "rubric": TP_RUBRIC,
        "aids": _WRITTEN_AIDS,
    },
    allowed_skill_tags=_TP_TAGS, allowed_adaptations=(),
    # No criteria_max_points / band_fractions: the MPO publishes none.
    grading_dimensions=TP_CONTENT_DIMENSIONS + TP_LANGUAGE_DIMENSIONS,
    scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["tp"], mode=SCORING_RUBRIC), available=False,
)

_ORAL = PartBlueprint(
    part_id="sprechen_1", module="speaking", title="Mündliche Prüfung: Kurzvortrag und Gespräch",
    task_type=TASK_TYPE_ORAL,
    constraints={
        # OFFICIAL §11a,b (all are maxima except the preparation time, which is stated as 20 minutes).
        "preparationSeconds": 1200, "examSecondsMax": 1200,
        "presentationSecondsMax": 300, "conversationSecondsMax": 900,
        "presentationStyle": "preferably_descriptive",
        "inputKinds": ("short_text", "graphic"),
        "languageActs": ("describe", "summarize", "compare", "justify", "evaluate", "take_position"),
        "groupExamsAllowed": False, "interactive": True,
        # OFFICIAL §4(3) (2025): in person or as an online remote exam.
        "deliveryModes": ("in_person", "online_remote"),
        "preparationAids": _WRITTEN_AIDS,
        # OFFICIAL §11c
        "assessmentCriteria": ("content_appropriateness", "comprehensibility", "independence_of_statements",
                               "conversational_behaviour", "linguistic_correctness", "lexical_differentiation",
                               "pronunciation_and_intonation"),
        "assessment": ASSESSMENT["speaking"],
    },
    allowed_skill_tags=_ORAL_TAGS, allowed_adaptations=(),
    grading_dimensions=("task_fulfilment", "fluency", "interaction", "grammar_accuracy", "vocabulary_range",
                        "pronunciation"),
    scoring=ScoringSpec(max_points=ORAL_MAX_POINTS, mode=SCORING_RUBRIC), available=False,
)

# ---- Topic banks: static metadata only (no generated content) ---------------------------------
# OFFICIAL §10(2): the sub-tests must belong to at least two different topic areas. Topics are
# academic / study-relevant and need no specialist knowledge (DECISION: labels are seeds only).
TOPIC_AREAS = ("natural_science_technology", "society_education", "economy_law", "health_environment", "culture_media")


def _t(topic_id: str, label: str, area: str) -> dict[str, str]:
    return {"topicId": topic_id, "label": label, "area": area}


_HV_TOPICS = (
    _t("hv_energy_storage", "Wie lässt sich erneuerbare Energie speichern?", "natural_science_technology"),
    _t("hv_urban_heat", "Hitze in Städten und wie Stadtplanung reagiert", "health_environment"),
    _t("hv_migration_labour", "Arbeitsmigration und ihre Folgen für Volkswirtschaften", "economy_law"),
    _t("hv_multilingual_classrooms", "Mehrsprachigkeit in Schule und Hochschule", "society_education"),
    _t("hv_media_attention", "Aufmerksamkeit und Nachrichtenkonsum in digitalen Medien", "culture_media"),
    _t("hv_sleep_learning", "Schlaf und Lernleistung", "health_environment"),
)
_LV_TOPICS = (
    _t("lv_open_science", "Offene Wissenschaft: Chancen und Grenzen des freien Datenzugangs", "society_education"),
    _t("lv_circular_economy", "Kreislaufwirtschaft als Wirtschaftsmodell", "economy_law"),
    _t("lv_ai_in_research", "Künstliche Intelligenz im Forschungsalltag", "natural_science_technology"),
    _t("lv_public_libraries", "Bibliotheken im digitalen Zeitalter", "culture_media"),
    _t("lv_diet_health", "Ernährungsgewohnheiten und Gesundheit", "health_environment"),
    _t("lv_data_protection", "Datenschutz zwischen Sicherheit und Freiheit", "economy_law"),
)
_TP_TOPICS = (
    _t("tp_study_duration", "Studiendauer und Studienabbruch", "society_education"),
    _t("tp_commuting", "Pendeln und Wohnortwahl von Studierenden", "society_education"),
    _t("tp_renewables_share", "Entwicklung des Anteils erneuerbarer Energien", "natural_science_technology"),
    _t("tp_online_shopping", "Onlinehandel und Innenstädte", "economy_law"),
    _t("tp_reading_habits", "Leseverhalten in verschiedenen Altersgruppen", "culture_media"),
    _t("tp_sports_health", "Sportliche Aktivität und Gesundheit", "health_environment"),
)
# The oral exam reuses the written-exam style topic material, kept as its own bank so it can diverge.
_ORAL_TOPICS = _TP_TOPICS

# WS has no bank of its own on purpose: it is derived from the LV text of the same examination.
DSH_TOPIC_BANKS = {
    "listening": _HV_TOPICS,
    "reading": _LV_TOPICS,
    "writing": _TP_TOPICS,
    "speaking": _ORAL_TOPICS,
}


def written_topic_set_is_valid(hv_topic_id: str, lv_topic_id: str, tp_topic_id: str) -> bool:
    """OFFICIAL §10(2): at least two different topic areas across the written sub-tests. DECISION:
    additionally no topic may repeat between HV, LV and TP. Unknown ids are invalid."""
    areas = []
    for module, topic_id in (("listening", hv_topic_id), ("reading", lv_topic_id), ("writing", tp_topic_id)):
        match = next((t for t in DSH_TOPIC_BANKS[module] if t["topicId"] == topic_id), None)
        if match is None:
            return False
        areas.append(match["area"])
    return len({hv_topic_id, lv_topic_id, tp_topic_id}) == 3 and len(set(areas)) >= 2


def pick_written_topic_set(seed: int) -> dict[str, str]:
    """Deterministic (no randomness, no I/O) topic triple that satisfies written_topic_set_is_valid."""
    for offset in range(len(_HV_TOPICS) * len(_LV_TOPICS) * len(_TP_TOPICS)):
        n = seed + offset
        hv = _HV_TOPICS[n % len(_HV_TOPICS)]
        lv = _LV_TOPICS[(n // len(_HV_TOPICS)) % len(_LV_TOPICS)]
        tp = _TP_TOPICS[(n // (len(_HV_TOPICS) * len(_LV_TOPICS))) % len(_TP_TOPICS)]
        if written_topic_set_is_valid(hv["topicId"], lv["topicId"], tp["topicId"]):
            return {"listening": hv["topicId"], "reading": lv["topicId"], "writing": tp["topicId"]}
    raise RuntimeError("no valid DSH topic combination")  # unreachable with the banks above


_RUBRIC_MODULE = SCORING_RUBRIC

DSH = ExamProfile(
    profile_id="dsh",
    family="DSH",
    variant="HRK-Musterprüfungsordnung",
    cefr_level=None,  # the MPO / RO-DT define no CEFR level for DSH
    legacy_level_values=("DSH-1", "DSH-2", "DSH-3"),
    source_name="HRK DSH-Musterprüfungsordnung (Anlage 1 RO-DT), Beschluss 29.09.2025",
    source_reference=OFFICIAL_SOURCES["mpo_2025"],
    source_version="HRK 29.09.2025; KMK Hochschulausschuss 20.11.2025 / Schulkommission 27.11.2025",
    verified_at=VERIFIED_AT,
    profile_version=PROFILE_VERSION,
    display_name="DSH",
    topic_banks=DSH_TOPIC_BANKS,
    result_model=RESULT_MODEL,
    presentation=PRESENTATION,
    module_specs={
        # §10(1)1: 10 + 40 min processing; the presentations themselves are not counted.
        "listening": ModuleSpec(
            label="Hörverstehen", code="HV", duration_seconds=50 * 60,
            note="Bearbeitungszeit 10 + 40 Minuten; der zweimalige Vortrag zählt nicht dazu.",
            scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["hv"], mode=_RUBRIC_MODULE),
        ),
        # §10(1)2: 90 min including reading time, shared with WS.
        "reading": ModuleSpec(
            label="Leseverstehen", code="LV", duration_seconds=90 * 60,
            note="90 Minuten einschließlich Lesezeit, gemeinsam mit den wissenschaftssprachlichen Strukturen (WS).",
            scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["lv"], mode=_RUBRIC_MODULE),
        ),
        "scientific_structures": ModuleSpec(
            label="Wissenschaftssprachliche Strukturen", code="WS", duration_seconds=None,
            note="Gemeinsame Teilprüfung mit dem Leseverstehen (90 Minuten insgesamt); bezieht sich auf denselben Text.",
            scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["ws"], mode=_RUBRIC_MODULE),
        ),
        "writing": ModuleSpec(
            label="Textproduktion", code="TP", duration_seconds=70 * 60,
            note="Bearbeitungszeit 70 Minuten, ca. 250 Wörter.",
            scoring=ScoringSpec(max_points=WRITTEN_MAX_POINTS["tp"], mode=_RUBRIC_MODULE),
        ),
        "speaking": ModuleSpec(
            label="Mündliche Prüfung", preparation_seconds=20 * 60,
            note="20 Minuten Vorbereitung, dann Kurzvortrag (max. 5 Min.) und Gespräch (max. 15 Min.); höchstens 20 Minuten.",
            scoring=ScoringSpec(max_points=ORAL_MAX_POINTS, mode=_RUBRIC_MODULE),
        ),
    },
    modules={
        "listening": (_HV,),
        "reading": (_LV,),
        "scientific_structures": (_WS,),
        "writing": (_TP,),
        "speaking": (_ORAL,),
    },
)
