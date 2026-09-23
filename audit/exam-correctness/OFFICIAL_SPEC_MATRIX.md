# Phase 1 — Official Specification Matrix

**Research budget note (reduced depth, stated up front):** this phase's research was time-boxed.
For Goethe C1 and Digital TestDaF, the two profile files already embed first-party, page-cited
sources from a prior verification pass (`goethe_c1.py` docstring, checked 2026-09-20 against the
Goethe-Institut Handbuch + Durchführungsbestimmungen PDFs; `testdaf_digital.py`, checked
2026-09-20 against the official demo PDF + testdaf.de pages, with a further independent
`pdftotext` re-extraction documented in `audit/testdaf-offline/REPORT.md`'s "Phase 2" section).
This audit did **not** re-fetch those PDFs itself this session; the facts below are recorded as
**PARTIALLY_VERIFIED (inherited citation)** rather than re-confirmed first-hand, per the task's
explicit allowance to mark reduced-depth cells honestly instead of silently re-deriving them.
For telc C1 Hochschule, this audit performed fresh `WebSearch` queries and one `WebFetch` attempt
against telc.net's own Handbuch PDF (image/scanned content, not machine-extractable by the fetch
tool) — timing facts are corroborated by a secondary source (deutschakademie.de, an authorized
telc exam centre) describing the same official structure; per-part item/point counts were **not**
independently confirmed against a primary telc.net source this session and are marked UNVERIFIED
below rather than filled from the profile code (the exact anti-pattern this audit exists to avoid).

Confidence key: **VERIFIED_OFFICIAL** (this session fetched/read the primary source directly),
**PARTIALLY_VERIFIED** (primary source cited with page/section by a prior verification pass I did
not personally re-fetch, or corroborated only by a reputable secondary/exam-centre source),
**UNVERIFIED** (no authoritative confirmation found this session).

---

## telc Deutsch C1 Hochschule

Source used this session: WebSearch results citing telc.net's own exam-format page and
deutschakademie.de (licensed telc exam centre); `WebFetch` of
`telc.net/.../Deutsch_c1_hochschule_Handbuch.pdf` (image-based PDF, not text-extractable by the
fetch tool — attempted, not usable). `telc_c1_hochschule.py`'s own `source_version` field says
only "verified against current telc.net exam-format description" (no page numbers), unlike the
other two profiles.

| Module | Part | Task type | Official item count | Options | Time | Max points | Confidence | Source |
|---|---|---|---|---|---|---|---|---|
| Lesen+Sprachbausteine | (shared block) | — | — | — | **90 min** (shared, learner allocates freely) | — | PARTIALLY_VERIFIED | deutschakademie.de exam-centre pages (multiple, consistent); telc.net official page description (not independently re-read this session in full detail) |
| Hören | hv1/hv2/hv3 | speaker_statement_matching / sentence_completion_mc3 / structured_note_completion | 10/10/10 (profile) | 8 speakers, 10 statements (hv1); 3-option (hv2) | **40 min** (module total, per secondary source) | 8/20/20 (profile) | UNVERIFIED (item/point counts not independently confirmed against primary telc.net text this session) | profile file only |
| Schreiben | schreiben_1 | choice_long_form_writing | 2 topic choice, ≥350 words | — | **70 min** | 48 (profile) | PARTIALLY_VERIFIED (70 min + ≥350 words corroborated by WebSearch secondary source: "eine Stellungnahme... mindestens 350 Wörter... 70 Minuten"); 48-point max UNVERIFIED | deutschakademie.de / germanexam.pro (secondary) |
| Sprechen | sprechen_1/2 | presentation_summary_followup / quote_guided_discussion | topicChoice=2, presentation 180s+120s, discussion 360s | — | **Vorbereitung 20 min + Sprechen ~16 min total** (secondary source) | 10/6 (profile) | PARTIALLY_VERIFIED for the 20-min-prep + module framing; the part-level breakdown (180+120+360s = 11 min of the ~16) is UNVERIFIED as an exact reconciliation — flagged as a MISMATCH candidate, see PROFILE_AUDIT.md | deutschakademie.de |
| Sprachbausteine | sprachbausteine_1 | cloze_mc4_language_elements | — | — | — | — | **EXCLUDED FROM SCOPE** per this task's explicit instruction (module stays disabled/out of correctness scope) | n/a |
| Pass mark | — | — | — | — | — | 60% written block (compensable across written parts) + 60% oral, scored separately | PARTIALLY_VERIFIED | WebSearch secondary source ("Man besteht ab 60% im schriftlichen Block... und 60% im mündlichen Teil") |

---

## Goethe-Zertifikat C1

Source (inherited citation, not re-fetched this session): `goethe_c1.py` docstring — Goethe-Institut
Handbuch Prüfungsziele/Testbeschreibung (© 2024, module table p.7, Lesen pp.24-28, Hören pp.29-33,
Schreiben pp.35-37, Sprechen pp.39-42, Bewertung pp.43-52) + Durchführungsbestimmungen (Stand
2025-09-01, §4/§4.3/§5/§6). All facts below are as transcribed into the profile file; this audit
checked them for internal consistency (see PROFILE_AUDIT.md) but did not independently re-open the
PDFs.

| Module | Part | Task type | Item/gap count | Options | Word count | Time | Max points | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| Lesen | lesen_1 | contextual_cloze_mc4 | 8 gaps + 1 example | 4 | ~320 | ~10 min (suggested) | 8 | PARTIALLY_VERIFIED |
| Lesen | lesen_2 | reading_detail_mc3 | 7 items | 3 | ~680 | ~20 min | 7 | PARTIALLY_VERIFIED |
| Lesen | lesen_3 | text_reconstruction_sentence_matching | 8 gaps / 10 candidates (2 unused) | — | ~530 (~600 w/ sentences) | ~20 min | 8 | PARTIALLY_VERIFIED |
| Lesen | lesen_4 | multi_author_statement_matching_with_none | 7 statements / 3 authors (2 unmatched) | — | ~430 | ~15 min | 7 | PARTIALLY_VERIFIED |
| Lesen (module) | — | — | 30 raw items total (Lesen) | — | — | **65 min** (incl. 5 min transfer) | 100 (lookup table, 60% pass) | PARTIALLY_VERIFIED — raw→100 table transcribed with an explicitly documented correction (profile docstring: 2024 Handbuch prints "5→19" as a typographical slip; Durchführungsbestimmungen print "5→17", matching `round(raw*3.33)`; table uses 17) |
| Hören | hoeren_1 | multi_source_statement_matching | 6 statements / 3 sources | — | ~420 | 1 play, 60s reading | 6 | PARTIALLY_VERIFIED |
| Hören | hoeren_2 | listening_tristate | 9 items | 3 (stimmt/stimmt nicht/nichts gesagt) | ~620 | 2 plays, 60s reading | 9 | PARTIALLY_VERIFIED |
| Hören | hoeren_3 | segmented_dialogue_mc3 | 4 sections × 2 items | 3 | ~710 | 1 play, 30s/section reading | 8 | PARTIALLY_VERIFIED |
| Hören | hoeren_4 | listening_detail_mc3 | 7 items | 3 | ~540 | 2 plays, 90s reading | 7 | PARTIALLY_VERIFIED |
| Hören (module) | — | — | 30 raw items | — | — | **40 min** (incl. pause + 3 min transfer) | 100 (lookup table, 60% pass) | PARTIALLY_VERIFIED |
| Schreiben | schreiben_1 | forum_discussion_post | 4 content points | — | ~230 | 50 min | 60 (4 rubric criteria × A-E bands) | PARTIALLY_VERIFIED |
| Schreiben | schreiben_2 | formal_context_message | 4 content points | — | ~120 | 25 min | 40 (4 rubric criteria) | PARTIALLY_VERIFIED |
| Schreiben (module) | — | — | — | — | ≥350 words combined | **75 min** | 100 (rubric, 60% pass) | PARTIALLY_VERIFIED |
| Sprechen | sprechen_1 | presentation_with_followup | 2 topic choice, 4 content points | — | — | ~5 min presentation, ~7 min total | rubric, per-criterion weights **not yet verified** (explicitly absent per docstring) | PARTIALLY_VERIFIED for structure; **UNVERIFIED** for per-criterion point weights (profile deliberately omits them) |
| Sprechen | sprechen_2 | guided_pair_discussion | 4 discussion prompts | — | — | ~5 min total | same as above | PARTIALLY_VERIFIED / UNVERIFIED (weights) |
| Sprechen (module) | — | — | — | — | — | pair exam, ~20 min total, 20 min prep, warm-up unscored | rubric, 60% pass | PARTIALLY_VERIFIED |

Language_elements: **not applicable — Goethe C1 has no Sprachbausteine module** (profile docstring
states this explicitly; confirmed structurally: `goethe_c1.py` has no `language_elements` key in
`modules`).

---

## Digital TestDaF

Source (inherited citation, independently re-extracted once already in a prior session via
`pdftotext` on the official demo PDF per `audit/testdaf-offline/REPORT.md` Phase 2 — not re-run by
this audit session, but the extraction method and resulting corrections are on record and treated
as VERIFIED_OFFICIAL-equivalent for the two items it resolved). testdaf.de structure/scoring pages
cited for module-level facts.

| Module | Part | Task type | Item count | Options | Time | Source requirement | Confidence |
|---|---|---|---|---|---|---|---|
| Lesen | lesen_1 | lexical_cloze | 5 | 4 | — | text | PARTIALLY_VERIFIED |
| Lesen | lesen_2 | paragraph_ordering | **5** (corrected from an earlier itemCount=4 guess via the demo's printed solution key showing paragraphs [1]-[5]) | — | — | text | PARTIALLY_VERIFIED — corroborated by a documented printed-solution-key re-extraction (Phase 2, REPORT.md) |
| Lesen | lesen_3 | reading_multiple_choice | 7 | 4 | 15 min (demo) | text, 500-650 words | PARTIALLY_VERIFIED (demo pp. 8-9) |
| Lesen | lesen_4 | speech_act_matching | 4 | 8 (unique mapping) | — | text | PARTIALLY_VERIFIED |
| Lesen | lesen_5 | statement_category_matching | 7 | 4 (incl. "both"/"neither") | — | text | PARTIALLY_VERIFIED |
| Lesen | lesen_6 | statement_concept_pair_matching | 4 | 8 (2 groups, unique) | — | text | PARTIALLY_VERIFIED |
| Lesen | lesen_7 | reading_summary_error_detection | 3 (errors) | — | — | **text AND graphic** (added via Phase-2 re-extraction; solution key: "Es gibt genau drei inhaltlich falsche Sätze") | PARTIALLY_VERIFIED |
| Lesen (module) | — | — | 35 total items (7 tasks) | — | ~55 min | — | PARTIALLY_VERIFIED (aggregate re-derived from per-task solution-key counts; no separate official aggregate table found in the extractable PDF text — its overview table's Items column is image-rendered) |
| Hören | hoeren_1-3,6,7 | (5 types) | 5/4/2/5/4 | audio | ~40 min (module) | audio | PARTIALLY_VERIFIED |
| Hören | hoeren_4/5 | video_speaker_statement_matching / video_outline_completion | 6/4 | audio+**video** | — | video | PARTIALLY_VERIFIED (structure); video acquisition is an unresolved production dependency (see GRADING/DELIVERY audits) |
| Schreiben | schreiben_1 | argumentative_essay | ≥200 words | — | 30 min (practice cap) | none required | PARTIALLY_VERIFIED |
| Schreiben | schreiben_2 | text_graph_summary | 100-150 words | — | 30 min (practice cap) | text + graphic | PARTIALLY_VERIFIED |
| Sprechen | sprechen_1 | spoken_advice | — | — | 45s speak / 30s prep | none | PARTIALLY_VERIFIED |
| Sprechen | sprechen_2 | spoken_option_comparison | — | — | 90s / 45s | none | PARTIALLY_VERIFIED |
| Sprechen | sprechen_3 | spoken_text_summary | — | — | 120s / 240s prep | text (hidden after prep) | PARTIALLY_VERIFIED |
| Sprechen | sprechen_4 | spoken_information_comparison | — | — | 90s / 90s prep + **~50s source playback not modeled by any renderer** | graphic + script | PARTIALLY_VERIFIED — multi-phase structure confirmed via demo timer headers (Phase 2), renderer gap confirmed by code inspection (see DELIVERY_AUDIT.md) |
| Sprechen | sprechen_5 | recorded_topic_presentation | — | — | 150s / 120s prep | text | PARTIALLY_VERIFIED |
| Sprechen | sprechen_6 | spoken_argument_response | — | — | 120s / 90s prep + **~58s source playback not modeled** | script | PARTIALLY_VERIFIED, same renderer-gap caveat |
| Sprechen | sprechen_7 | spoken_measure_critique | — | — | 90s / 90s prep | text | PARTIALLY_VERIFIED |
| Scoring (all modules) | — | — | — | — | — | TDN bands (3/4/5) documented as **descriptive only** — no raw→scaled conversion is published anywhere found (`rawToScaledConversionAvailable: False`) | **UNVERIFIED by design** — profile explicitly refuses to fabricate this; correctly represented, not a gap in this audit |
| Speaking grading architecture | all 7 sprechen parts | — | — | — | — | **IMPLEMENTATION GAP / GRADING CAPABILITY MISSING** (not a content or spec defect): TestDaF uses 7 independent non-interactive recorded-response parts (`recordingId`/`durationSeconds` submission, qualitative-only feedback — numeric scores structurally forbidden by `validate_feedback()`), fundamentally different from TELC's interactive AI-partner dialogue model (`german_exam_speaking_practice.py`). No grader implementation exists for TestDaF's model. See GRADING_AUDIT.md. | n/a | Documented per this task's explicit instruction — not rediscovered, not fabricated |

## Sources used (Phase 1, consolidated)
- telc.net exam-format page (via WebSearch synthesis, not directly fetched with readable text this
  session); `telc.net/.../Deutsch_c1_hochschule_Handbuch.pdf` (WebFetch attempted — image-based PDF,
  not text-extractable by the fetch tool, so **not usable as a citation this session**).
- deutschakademie.de (licensed telc exam centre — secondary, not primary telc.net text; used for
  corroboration only, at PARTIALLY_VERIFIED confidence).
- germanexam.pro (secondary, corroborated the 70-min/350-word Schreiben fact only).
- Goethe-Institut Handbuch Prüfungsziele/Testbeschreibung C1 (© 2024) — cited via `goethe_c1.py`'s
  own docstring, inherited from a prior verification pass, not re-fetched this session.
- Goethe-Institut Durchführungsbestimmungen C1 (Stand 2025-09-01) — same inheritance note.
- TestDaF/g.a.s.t. official demo PDF (`Beispielaufgaben_Demo-Version_digitaler_TestDaF.pdf`) —
  inherited from `audit/testdaf-offline/REPORT.md`'s prior `pdftotext` extraction pass, not
  re-fetched this session.
- testdaf.de structure/scoring pages — same inheritance note.
