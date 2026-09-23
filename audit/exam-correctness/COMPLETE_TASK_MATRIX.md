# Phase 10 — Complete Audit Matrix

## Availability gate (Phase 11)
A part's `overall_status` may only be **PASS** if every layer below is itself verified —
`official_spec_status=PASS AND profile_status=PASS AND implementation_status=PASS AND
content_status=PASS AND grading_status=PASS AND delivery_status=PASS AND manual_review=CLEAR`. No
unverified/partially-verified layer may roll up to PASS. **Actual `available` flags remain
unchanged by this audit** — see the final grep confirmation in the closing report. This document
is a correctness audit, not a release decision.

Status values used below: PASS, MISMATCH, MISSING, BLOCKED, UNVERIFIED, PARTIALLY_VERIFIED (used
only in `official_spec_status`, treated as "not PASS" for rollup purposes), MANUAL_REVIEW, N/A
(excluded).

## telc Deutsch C1 Hochschule (9 in-scope parts + 1 excluded)

| Part | Task type | Official spec | Profile | Implementation | Content | Grading | Delivery | Manual review | Availability | Overall | Failure reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hv1 | speaker_statement_matching | UNVERIFIED (item/points) | PASS | PASS | UNVERIFIED | PASS (mechanics) | PASS | CLEAR | True | UNVERIFIED | official item/point counts not independently confirmed |
| hv2 | sentence_completion_mc3 | UNVERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | True | UNVERIFIED | same |
| hv3 | structured_note_completion | UNVERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | True | UNVERIFIED | same |
| lesen_1 | text_reconstruction_sentence_matching | UNVERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | True | UNVERIFIED | item counts not independently confirmed |
| lesen_2 | section_statement_matching | UNVERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | True | UNVERIFIED | same |
| lesen_3 | detail_tristate_with_global_heading | UNVERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | True | UNVERIFIED | same |
| schreiben_1 | choice_long_form_writing | PARTIALLY_VERIFIED (time/words confirmed, points not) | MISSING (no pass-mark constant) | PASS | UNVERIFIED | PASS (route wired) | PASS | CLEAR | True | UNVERIFIED | max-points unverified; no pass-mark constant in profile |
| sprechen_1 | presentation_summary_followup | MISMATCH (16 vs 11 min) | MISMATCH | PASS | UNVERIFIED | PASS (route wired) | PASS | **MANUAL_REVIEW #1** | True | MANUAL_REVIEW | unresolved timing discrepancy |
| sprechen_2 | quote_guided_discussion | MISMATCH (16 vs 11 min) | MISMATCH | PASS | UNVERIFIED | PASS (route wired) | PASS | **MANUAL_REVIEW #1** | True | MANUAL_REVIEW | same |
| sprachbausteine_1 | cloze_mc4_language_elements | N/A | N/A | N/A | N/A | N/A | N/A | N/A | True | N/A (EXCLUDED) | explicitly out of scope per task instructions |

## Goethe-Zertifikat C1 (12 parts)

| Part | Task type | Official spec | Profile | Implementation | Content | Grading | Delivery | Manual review | Availability | Overall | Failure reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|
| lesen_1 | contextual_cloze_mc4 | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS (mechanics) | PASS | CLEAR | False | UNVERIFIED | pending live qualification |
| lesen_2 | reading_detail_mc3 | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| lesen_3 | text_reconstruction_sentence_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| lesen_4 | multi_author_statement_matching_with_none | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| hoeren_1 | multi_source_statement_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| hoeren_2 | listening_tristate | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| hoeren_3 | segmented_dialogue_mc3 | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| hoeren_4 | listening_detail_mc3 | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| schreiben_1 | forum_discussion_post | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | **MISSING (no route)** | PASS | CLEAR | False | BLOCKED | grading route not wired (grade_productive exists, unused by any router) |
| schreiben_2 | formal_context_message | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | **MISSING (no route)** | PASS | CLEAR | False | BLOCKED | same |
| sprechen_1 | presentation_with_followup | PARTIALLY_VERIFIED (weights UNVERIFIED) | PASS (honestly incomplete) | PASS | UNVERIFIED | **MISSING (no implementation, no route)** | PASS | **MANUAL_REVIEW #2** | False | BLOCKED | no grading implementation at all; weights unpublished |
| sprechen_2 | guided_pair_discussion | PARTIALLY_VERIFIED (weights UNVERIFIED) | PASS | PASS | UNVERIFIED | **MISSING** | PASS | **MANUAL_REVIEW #2** | False | BLOCKED | same |

## Digital TestDaF (23 parts)

| Part | Task type | Official spec | Profile | Implementation | Content | Grading | Delivery | Manual review | Availability | Overall | Failure reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|
| lesen_1 | lexical_cloze | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS (mechanics) | PASS | CLEAR | False | UNVERIFIED | pending live qualification |
| lesen_2 | paragraph_ordering | PARTIALLY_VERIFIED (corrected) | PASS | **MISSING (no generator; registry=False)** | UNVERIFIED | PASS | **BLOCKED** | CLEAR | False | BLOCKED | no generator/validator exists |
| lesen_3 | reading_multiple_choice | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | pending live qualification |
| lesen_4 | speech_act_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| lesen_5 | statement_category_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| lesen_6 | statement_concept_pair_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | PASS | CLEAR | False | UNVERIFIED | same |
| lesen_7 | reading_summary_error_detection | PARTIALLY_VERIFIED (corrected) | PASS | **MISSING (no generator; registry=False)** | UNVERIFIED | PASS | **BLOCKED** | CLEAR | False | BLOCKED | no generator/validator exists; graphic-rendering coverage for read-only display also unconfirmed |
| hoeren_1 | listening_overview_completion | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED (TTS unconfirmed live)** | CLEAR | False | BLOCKED | audio pipeline live-status unconfirmed |
| hoeren_2 | listening_concept_pair_notes | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED** | CLEAR | False | BLOCKED | same |
| hoeren_3 | listening_summary_error_detection | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED** | CLEAR | False | BLOCKED | same |
| hoeren_4 | video_speaker_statement_matching | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED (no video pipeline exists)** | **MANUAL_REVIEW #5** | False | BLOCKED | video sourcing/storage does not exist at all |
| hoeren_5 | video_outline_completion | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED** | **MANUAL_REVIEW #5** | False | BLOCKED | same |
| hoeren_6 | listening_multiple_choice | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED (TTS)** | CLEAR | False | BLOCKED | audio pipeline unconfirmed |
| hoeren_7 | sound_script_comparison | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | PASS | **BLOCKED (TTS)** | **MANUAL_REVIEW #6** | False | BLOCKED | audio pipeline unconfirmed + phonetic-realism review needed |
| schreiben_1 | argumentative_essay | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | **MISSING (no route)** | PASS | CLEAR | False | BLOCKED | grading route not wired |
| schreiben_2 | text_graph_summary | PARTIALLY_VERIFIED | PASS | PASS | UNVERIFIED | **MISSING (no route)** | PASS | CLEAR | False | BLOCKED | same |
| sprechen_1 | spoken_advice | PARTIALLY_VERIFIED | PASS | **MISMATCH (registry=False but generator/renderer work — stale registry)** | UNVERIFIED | **MISSING — IMPLEMENTATION GAP / GRADING CAPABILITY MISSING** | PASS (renderer works) | CLEAR | False | BLOCKED | grading architecture gap (see GRADING_AUDIT.md) + stale registry entry |
| sprechen_2 | spoken_option_comparison | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | PASS | CLEAR | False | BLOCKED | same |
| sprechen_3 | spoken_text_summary | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | PASS | CLEAR | False | BLOCKED | same |
| sprechen_4 | spoken_information_comparison | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | **BLOCKED (multi-phase renderer gap + TTS)** | **MANUAL_REVIEW #3** | False | BLOCKED | grading gap + renderer gap + TTS dependency + unresolved phase semantics |
| sprechen_5 | recorded_topic_presentation | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | PASS | CLEAR | False | BLOCKED | grading gap |
| sprechen_6 | spoken_argument_response | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | **BLOCKED (renderer gap + TTS)** | **MANUAL_REVIEW #3** | False | BLOCKED | same as sprechen_4 |
| sprechen_7 | spoken_measure_critique | PARTIALLY_VERIFIED | PASS | MISMATCH (same) | UNVERIFIED | **MISSING** | PASS | CLEAR | False | BLOCKED | grading gap |

## Rollup counts (computed directly from `data/complete_task_matrix.json`, authoritative)
- **Total rows: 45** (44 in-scope parts + 1 explicitly excluded — TELC Sprachbausteine).
- **PASS: 0** (no task has every layer verified — expected and correct: no live content has been
  qualified anywhere, per this task's own hard constraints).
- **UNVERIFIED: 20** (telc 7, goethe 8, testdaf 5) — pending live qualification only, no additional
  structural/grading blocker found beyond "no real content has ever been reviewed."
- **MANUAL_REVIEW (as overall_status): 2** (telc sprechen_1/2 — the TELC Sprechen timing
  discrepancy is the specific, additional, unresolved blocker beyond generic content-unverified
  status).
- **BLOCKED: 22** (goethe 4 — writing/speaking grading-route gap; testdaf 18 — 2 missing
  generators, 7 listening parts blocked on TTS/video, 2 writing parts blocked on grading-route gap,
  7 speaking parts blocked on the grading-architecture gap).
- **EXCLUDED: 1** (TELC Sprachbausteine, per task instructions).

By exam: telc_c1_hochschule = 10 rows (7 UNVERIFIED, 2 MANUAL_REVIEW, 1 EXCLUDED); goethe_c1 = 12
rows (8 UNVERIFIED, 4 BLOCKED); testdaf_digital = 23 rows (5 UNVERIFIED, 18 BLOCKED).
