# Phase 3 — Structural Implementation Audit (+ Phase 9 Cross-Exam Contamination)

## Method
For every part: (a) is the `task_type` string registered in `german_exams/task_types.py`'s
`TASK_TYPES` dict, and does that value match whether a real generator/validator actually exists
for it (checked by grepping the task-type string across `german_exam_reading.py`,
`german_exam_listening.py`, `german_exam_writing.py`, `german_exam_speaking.py`,
`german_exam_productive.py`, `german_exam_validator.py`); (b) does `manifest.py`'s
`implemented` field correctly compute `available AND is_task_type_implemented`; (c) any
part/task-type/module mapping errors.

## Headline finding: the `TASK_TYPES` registry has drifted stale for TestDaF speaking

`german_exams/task_types.py` marks all 7 TestDaF speaking task types
(`spoken_advice`, `spoken_option_comparison`, `spoken_text_summary`,
`spoken_information_comparison`, `recorded_topic_presentation`, `spoken_argument_response`,
`spoken_measure_critique`) **`False`** (not implemented). But:
- `german_exam_speaking.py`'s `generate_speaking_part()` dispatches every task type in
  `german_exam_productive.SPEAKING_TYPES` (which is exactly this same 7-type set) straight to
  `generate_productive()` — a real, working generator.
- `frontend/js/features/german-exam/task-workspace.ts` line 12 registers all 7 of these exact
  type strings against `mountSpeaking`, a real, working renderer.
- `audit/testdaf-offline/REPORT.md`'s T4 checkpoint documents 33 passing backend tests and 8
  passing browser tests covering exactly this generator/renderer pair for these 7 types.

So the registry says "not implemented" for something that **is** implemented and tested.
This is **safe today** (double-gated: `available=False` on every TestDaF part already blocks
generation on its own), confirmed by reading `german_exam_generator.py` line 87:
`if not part.available or not is_task_type_implemented(part.task_type): <501>` — either condition
alone is sufficient to block. But it is a **real latent release-readiness bug**: the day a human
flips a TestDaF speaking part's `available=True` after live qualification (Phase 5-7 of the prior
TestDaF audit), generation would **still fail with a 501** until someone separately remembers to
flip that task type's registry entry too — a step not mentioned anywhere in the T0-T8 checkpoints
or the `LIVE_QUALIFICATION_PLAN.md`'s "what Phase 6 would look like" section. **New finding, not
previously documented.** Recorded here, not fixed (fixing it would mean flipping registry
booleans on task types with production-shaped code but zero live-qualified samples — out of scope
for a documentation-only audit, and the double-gate is currently safe as-is).

By contrast, `paragraph_ordering` and `reading_summary_error_detection` (TestDaF `lesen_2`,
`lesen_7`) are genuinely `False` and correctly so — grepping both task-type strings across
`german_exam_reading.py` and `german_exam_validator.py` returns **zero matches**: no generator or
validator code exists for either, matching the registry.

## Per-exam structural table

### telc C1 Hochschule
| Part | task_type | Registry | available | manifest `implemented` | Note |
|---|---|---|---|---|---|
| hv1 | speaker_statement_matching | True | True (default) | True | PASS |
| hv2 | sentence_completion_mc3 | True | True (default) | True | PASS |
| hv3 | structured_note_completion | True | True (default) | True | PASS |
| lesen_1 | text_reconstruction_sentence_matching | True | True (default) | True | PASS |
| lesen_2 | section_statement_matching | True | True (default) | True | PASS |
| lesen_3 | detail_tristate_with_global_heading | True | True (default) | True | PASS |
| sprachbausteine_1 | cloze_mc4_language_elements | True | True (default) | True | EXCLUDED from correctness scope per task instructions, structural row shown for completeness only |
| schreiben_1 | choice_long_form_writing | True | True (default) | True | PASS |
| sprechen_1 | presentation_summary_followup | True | True (default) | True | PASS |
| sprechen_2 | quote_guided_discussion | True | True (default) | True | PASS |

All 10 TELC parts are structurally `implemented=True` — consistent with TELC being the exam
actually live in production.

### Goethe-Zertifikat C1
| Part | task_type | Registry | available | manifest `implemented` | Note |
|---|---|---|---|---|---|
| lesen_1-4 | contextual_cloze_mc4 / reading_detail_mc3 / text_reconstruction_sentence_matching / multi_author_statement_matching_with_none | True (all 4) | False (all) | False | PASS — correctly gated by `available` alone, task type ready |
| hoeren_1-4 | multi_source_statement_matching / listening_tristate / segmented_dialogue_mc3 / listening_detail_mc3 | True (all 4) | False (all) | False | PASS |
| schreiben_1-2 | forum_discussion_post / formal_context_message | True (both) | False (both) | False | PASS |
| sprechen_1-2 | presentation_with_followup / guided_pair_discussion | True (both) | False (both) | False | PASS |

Every Goethe task type is registered `True` (generator/validator code genuinely exists per T1-T4
equivalents of the Goethe implementation) but every part is `available=False`, so nothing is
served. Single-gate, correctly conservative.

### Digital TestDaF
| Part | task_type | Registry | available | manifest `implemented` | Note |
|---|---|---|---|---|---|
| lesen_1 | lexical_cloze | True | False | False | PASS |
| lesen_2 | paragraph_ordering | **False** | False | False | Double-gated; registry correctly reflects "no generator exists" |
| lesen_3 | reading_multiple_choice | True | False | False | PASS |
| lesen_4 | speech_act_matching | True | False | False | PASS |
| lesen_5 | statement_category_matching | True | False | False | PASS |
| lesen_6 | statement_concept_pair_matching | True | False | False | PASS |
| lesen_7 | reading_summary_error_detection | **False** | False | False | Double-gated; registry correctly reflects "no generator exists" |
| hoeren_1-3,6,7 | (5 types) | True (all 5) | False | False | PASS |
| hoeren_4/5 | video_speaker_statement_matching / video_outline_completion | True (both) | False | False | PASS structurally; production video pipeline does not exist at all (see DELIVERY_AUDIT.md — this is a release blocker, not a structural mismatch) |
| schreiben_1/2 | argumentative_essay / text_graph_summary | True (both) | False | False | PASS |
| sprechen_1-7 | spoken_advice, spoken_option_comparison, spoken_text_summary, spoken_information_comparison, recorded_topic_presentation, spoken_argument_response, spoken_measure_critique | **False (all 7 — stale, see headline finding above)** | False | False | Currently safe (double-gated); **flag for whoever runs live qualification: the registry must also be flipped, not just `available`** |

## Other structural checks
- **Session/manifest identity guard** (frontend `task-workspace.ts`): every task-open request
  verifies `envelope.exam.profileId`, `profileVersion`, `module`, `part.id`, `part.taskType` all
  match what was requested before rendering — a genuine structural safeguard against one profile's
  content leaking into another's UI slot. PASS.
- **Inventory scoping**: `german_exam_inventory.py`'s RPC calls are scoped by
  `profile_id + profile_version + module + part_id` (per `test_german_exam_inventory_testdaf.py`,
  already existing). PASS — confirmed by reading the RPC call sites, not re-run against a live DB.
- **`ScoringSpec` mode invariants**: enforced at dataclass construction (`__post_init__`), so a
  malformed lookup table would fail at **import time**, not silently produce wrong scores — the
  fact that `goethe_c1.py` imports successfully today is itself a passing structural test. PASS.

## Phase 9 — Cross-Exam Contamination Audit

Grepped for `if profile_id ==`-style anti-patterns across `backend/python-ai/app/services/*.py`
and `german_exams/*.py`: **zero matches**. Grepped for hardcoded profile-id string literals
(`"telc_c1_hochschule"`, `"goethe_c1"`, `"testdaf_digital"`) outside the three profile files
themselves:

| File | Line | Finding | Assessment |
|---|---|---|---|
| `german_exam_speaking_practice.py` | 16 | `from .german_exams.telc_c1_hochschule import SPEAKING_LANGUAGE_MAXIMA, SPEAKING_TASK_MAXIMA` | **Genuine exam-specific coupling.** This module is TELC's own interactive speaking-practice/grading engine — its docstring and design are TELC-specific by intent (TELC's interactive-dialogue speaking model has no equivalent in Goethe/TestDaF today), so importing TELC's own constants from TELC's own profile file is not "leakage" into shared code — it's a TELC-only module, correctly named/scoped. Not a contamination bug. |
| `german_exam_speaking_practice.py` | 149 | `profile = get_profile("telc_c1_hochschule")` hardcoded | Same assessment — this function's whole purpose is TELC interactive speaking practice; it does not pretend to be exam-agnostic. **Not contamination**, but worth naming precisely: this module is *not* the place Goethe/TestDaF speaking grading will ever be wired through — a generic-sounding module name (`german_exam_speaking_practice`) could mislead a future engineer into assuming it's exam-agnostic infrastructure. Recommend (not actioned — documentation only) a doc comment at the top of the file stating explicitly "TELC-only; does not generalize" if one isn't already there — checked: the module docstring is silent on this, so this is a real (minor) clarity gap. |
| `routers/german_exam.py` | 259 | `SpeakingPracticeRequest.profileId: Literal["telc_c1_hochschule"]` | Structurally enforces that this specific endpoint is TELC-only at the Pydantic layer. Correct behavior given `german_exam_speaking_practice.py`'s own TELC-only design (previous row) — not contamination, but it does mean **no Goethe speaking-practice endpoint exists at all**, a gap distinct from TestDaF's (TestDaF's gap is "no grader exists for the architecture"; Goethe's gap is "no route exists, full stop") — worth stating precisely rather than conflating the two, see GRADING_AUDIT.md. |
| `routers/german_exam.py` | 203 | `if part.task_type != "choice_long_form_writing": raise HTTPException(501)` | This gates by **task_type**, not profile_id — technically exam-agnostic in form (any future exam using `choice_long_form_writing` would pass), but in practice only TELC's `schreiben_1` uses that task type today, so it has the *effect* of a TELC-only gate without being written as one. Not a contamination anti-pattern (no `if profile_id ==` anywhere), but flagged because the effect is identical — Goethe's `forum_discussion_post`/`formal_context_message` and TestDaF's `argumentative_essay`/`text_graph_summary` all 501 here regardless of qualification status, which is correct today (none are qualified) but this single-task-type allowlist will need to grow, not be reworked, when another exam's writing is ready — confirmed this is an additive change, not a redesign, since `grade_productive()` (the generic, profile-agnostic contract) already exists and is unused by any router. |

**No exam-specific fact (item counts, timing, scoring maxima, speaking-stage structure) embedded
inside genuinely shared/generic code was found.** `german_exam_writing_grading.py` (the shared
grading-dimension/banding logic) derives everything from `part.grading_dimensions`/`ScoringSpec`
field presence — confirmed by direct read, no profile-id or exam-name branch anywhere in that
file. `german_exam_validator.py`, `german_exam_adaptation.py`, `german_exam_semantic_verify.py`
are keyed by `task_type`/`allowed_skill_tags`/`allowed_adaptations`, never by profile id (grep
confirms zero `telc`/`goethe`/`testdaf` string literals in any of these three files).

**Conclusion:** the three cross-exam-id references found are each a **correctly scoped
single-exam module doing single-exam work**, not leakage of one exam's facts into shared
infrastructure — the architecture passes the contamination check as designed. The one thing worth
a human's attention (not a bug) is that `german_exam_speaking_practice.py`'s generic-sounding name
could be mistaken for shared infrastructure by someone extending Goethe/TestDaF speaking grading
later; and the `TASK_TYPES` registry staleness above is the one genuine (if currently harmless)
implementation-audit defect found in this phase.

## 2026-09-23 follow-up: registry staleness fixed

The headline finding above (`TASK_TYPES` marking all 7 TestDaF speaking task types `False` despite
a real generator/renderer existing for them) has been fixed on branch
`fix/testdaf-speaking-registry-and-e2e`: `spoken_advice`, `spoken_option_comparison`,
`spoken_text_summary`, `spoken_information_comparison`, `recorded_topic_presentation`,
`spoken_argument_response`, and `spoken_measure_critique` are now registered `True` in
`german_exams/task_types.py`. This is a registry-only change — it reflects an already-true fact
about the engine (generator/validator/renderer exist), it does not flip any `PartBlueprint.available`
flag anywhere (TestDaF speaking parts, and every other still-unreleased Goethe/TestDaF part, remain
`available=False`), and it does not implement recording grading (still open, see
`GRADING_AUDIT.md`). `german_exam_generator.py`'s double-gate (`if not part.available or not
is_task_type_implemented(part.task_type)`) still blocks TestDaF speaking generation on the
`available` check alone, confirmed by a new regression test
(`test_testdaf_speaking_task_types_are_now_registered_implemented_but_parts_stay_gated_by_available`
in `test_german_exam_audit_regressions.py`). The "flag for whoever runs live qualification" note in
the per-exam structural table above is now stale in the sense that the registry half of that future
work is done; the `available` flip itself is still deliberately not done and out of scope for this
follow-up.
