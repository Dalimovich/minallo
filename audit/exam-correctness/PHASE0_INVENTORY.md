# Phase 0 — Repository Inventory (read-only)

Scope: `backend/python-ai/app/services/german_exams*`, `backend/python-ai/app/routers/german_exam.py`,
`frontend/js/features/german-exam/`, `backend/python-ai/tests/test_german_exam_*.py`,
`backend/python-ai/scripts/qa_*.py`, `tests/e2e/*german*`, `audit/testdaf-offline/*`.
No code was modified in this phase.

## Exam profile files (single source of exam-specific facts)
- `backend/python-ai/app/services/german_exams/telc_c1_hochschule.py` (303 lines) — telc Deutsch C1
  Hochschule. 5 modules: listening (hv1-3), reading (lesen_1-3), language_elements
  (sprachbausteine_1, out of scope per task instructions), writing (schreiben_1), speaking
  (sprechen_1-2). **No part sets `available=` explicitly** → every part defaults to
  `available=True` via `PartBlueprint.available: bool = True` (see `shared.py`). TELC is therefore
  the one profile actually live in production today.
- `backend/python-ai/app/services/german_exams/goethe_c1.py` (285 lines) — Goethe-Zertifikat C1.
  4 modules, no language_elements: reading (lesen_1-4), listening (hoeren_1-4), writing
  (schreiben_1-2), speaking (sprechen_1-2). Every part explicitly `available=False`. Cites two
  first-party PDFs (Handbuch, Durchführungsbestimmungen) with page numbers in the module docstring,
  checked 2026-09-20.
- `backend/python-ai/app/services/german_exams/testdaf_digital.py` (206 lines) — Digital TestDaF.
  4 modules, no language_elements: reading (lesen_1-7), listening (hoeren_1-7), writing
  (schreiben_1-2), speaking (sprechen_1-7). Every part explicitly `available=False`. Cites the
  official demo PDF + testdaf.de structure/scoring pages, checked 2026-09-20.

## Engine (shared, exam-agnostic) code
- `german_exams/shared.py` — `ExamProfile`, `ModuleSpec`, `PartBlueprint`, `ScoringSpec`,
  `DeliveryPolicy` dataclasses. Enforces scoring-spec invariants (lookup-table monotonicity, 0→0,
  max→max) in `__post_init__`.
- `german_exams/task_types.py` — `TASK_TYPES: dict[str, bool]` registry + `is_task_type_implemented`.
  A part whose task type is `False` here 501s cleanly rather than being routed to another exam's
  handler. 3 task types are `False`: `paragraph_ordering`, `reading_summary_error_detection`
  (both TestDaF reading), and all 7 TestDaF `spoken_*`/`recorded_topic_presentation` types are
  actually `False` in the registry too — see IMPLEMENTATION_AUDIT.md for the full cross-check
  against each profile's parts.
- `german_exams/manifest.py` — `build_manifest()`: the one function that turns a profile into the
  frontend contract. A part is `implemented` in the manifest iff `part.available AND
  is_task_type_implemented(part.task_type)` — i.e. even if a part's own flag were ever flipped to
  `True`, an unimplemented task type still can't be served.
- `german_exams/registry.py` — `GERMAN_EXAM_PROFILES` dict of the 3 profiles above;
  `resolve_profile_id(family, german_level)` legacy-onboarding lookup; fails closed (returns
  `None`) on ambiguous/unknown input.
- `german_exams/result.py` — module-separated result representation (`practice_raw_result`,
  `official_style_scaled_result`, `practice_formative_result`, `build_module_result`). No function
  combines more than one module's data; `official_style_scaled_result` returns `None` whenever no
  verified `ScoringSpec` exists (e.g. every TestDaF part today) rather than inventing a score.
- `german_exams/scoring.py` — `raw_to_points`/`is_pass`, pure functions over `ScoringSpec`
  (`fixed_per_item` arithmetic vs `lookup_table` — an official conversion table, never computed).

## Generation / validation / grading (task-type-keyed, reused across exams)
- `german_exam_generator.py` — `_dispatch_module()`, the per-module generation entrypoint used by
  both production and the QA scripts.
- `german_exam_reading.py` (1334 lines), `german_exam_listening.py` (598), `german_exam_writing.py`
  (409), `german_exam_speaking.py` (44, thin TestDaF dispatch to `generate_productive`),
  `german_exam_language_elements.py` (1437), `german_exam_media_tasks.py` (154, generic
  audio/video reference validation) — per-family generators.
- `german_exam_validator.py` (1250 lines) — deterministic structural validators keyed by task type.
- `german_exam_semantic_verify.py` (991), `_chunked.py`, `_adjudicate.py`, `_repair.py`,
  `_gate.py` — LLM-based semantic QA/repair pipeline layered on top of deterministic validation.
- `german_exam_writing_grading.py` (227) — `grade_writing_submission`, dimensions/weights sourced
  from `part.grading_dimensions` + `ScoringSpec` (band vs continuous chosen by field presence, not
  a profile-id branch). Wired in production **only** for `task_type == "choice_long_form_writing"`
  (TELC's writing type) — `routers/german_exam.py` line 203 hard 501s every other task type,
  including both Goethe and both TestDaF writing types.
- `german_exam_productive.py` (96) — the generic `generate_productive`/`grade_productive`/
  `validate_feedback` contract writing and TestDaF speaking share; `validate_feedback` structurally
  forbids numeric scores for speaking (qualitative feedback only).
- `german_exam_speaking_practice.py` (171) — TELC's own interactive speaking-practice/grading
  service. Hardcodes `get_profile("telc_c1_hochschule")` (line 149) and imports
  `SPEAKING_TASK_MAXIMA`/`SPEAKING_LANGUAGE_MAXIMA` directly from `telc_c1_hochschule.py` — the one
  genuinely exam-specific-fact-in-shared-module finding, see Phase 9.
- `german_exam_inventory.py` (244) — profile/profile_version/module/part_id-scoped stock
  take/replenish; no profile-id branching found (confirmed by existing
  `test_german_exam_inventory_testdaf.py`).
- `german_exam_adaptation.py`, `_performance.py`, `_skill_tags.py` — difficulty adaptation planner
  and skill-tag vocabulary, keyed by `allowed_adaptations`/`allowed_skill_tags` per part, not by
  profile id.

## Routers
- `backend/python-ai/app/routers/german_exam.py` — `POST /german-exam/grade-writing` gates on
  `task_type == "choice_long_form_writing"` (line ~203); `SpeakingPracticeRequest.profileId` is
  typed `Literal["telc_c1_hochschule"]` (line 259) — structurally rejects any other profile at the
  Pydantic layer, not just missing a code path.

## Frontend
- `frontend/js/features/german-exam/task-workspace.ts` — manifest-driven `TASK_RENDERERS` registry
  keyed by `taskType` (not by exam), assembled generically from `productive-task.ts`,
  `speaking-task.ts`, `media-task.ts`, `source-selection.ts`. `mountTaskWorkspace()` guards stale
  envelopes with an `epoch` counter + `AbortController` + an explicit identity check
  (`profileId`/`profileVersion`/`module`/`part.id`/`part.taskType` must all match what was
  requested) before rendering — directly relevant to Phase 6 (profile-switch leakage).
- `exam-session.ts` — full-exam-simulation state machine (`DeliveryPolicy`-driven), pure/no-DOM,
  fake-clock-testable (per T6 checkpoint in `audit/testdaf-offline/REPORT.md`).
- `module-result.ts` — frontend mirror of `result.py`'s module-separation rule; `validateModuleResult`
  defensively rejects a TDN/scaledScore key appearing anywhere it shouldn't.
- `exam-workspace.ts`, `media-task.ts`, `productive-task.ts`, `speaking-task.ts`,
  `source-selection.ts` — renderers/mounters, all task-type-keyed.

## Existing tests (backend)
41 `test_german_exam_*.py` files, ~486 `def test_` matches via a quick grep (deduped/overlapping
count; actual collected count below). Includes 3 profile-shape tests
(`test_german_exam_profile_telc_c1.py`, `_goethe_c1.py`, `_testdaf_digital.py`), a registry test,
an inventory test plus a TestDaF-specific inventory-isolation test, a result-representation test,
and `test_qa_budget.py`/`test_qa_testdaf_live.py` (not shown in the earlier find but referenced by
T8's REPORT.md entry — confirmed present under `backend/python-ai/tests/`).

Ran (this phase, read-only): `pytest tests/ -k "german_exam or qa_budget or qa_testdaf"` →
**773 passed, 0 failed** (9.56s). Full backend suite `pytest tests/` → **2479 passed, 10 skipped,
0 failed** (41.55s). See `PHASE12_TESTS.md`-equivalent section in the final report for the full
run log.

## Existing tests (frontend/e2e)
- `tests/e2e/18-german-learner.spec.ts`, `22-german-exam-engine-live.spec.ts`,
  `25-german-exam-profile-race.spec.ts`, `26-german-exam-engine-wiring.spec.ts`,
  `30-german-general-practice.spec.ts`, `33-german-exam-profile-switch.spec.ts` (TELC↔Goethe only,
  read not run — see DELIVERY_AUDIT.md), plus `tests/e2e/fixtures/german-exam-manifests.json`
  (generated from the real profiles via `UPDATE_MANIFEST_FIXTURE=1 pytest`, never hand-edited).
- `node scripts/run-unit-tests.mjs` (frontend unit suite): **826 passed, 2 pre-existing failures**
  unrelated to this branch (`german-learner-profile.test.mjs`: TS registry mirror missing
  `testdaf_digital` — a known, pre-existing drift, not something this audit phase introduces or is
  asked to fix).
- `npx tsc -p frontend/tsconfig.json`: clean, 0 errors.

## Existing audit scripts/docs (prior work, reused not rebuilt)
- `audit/testdaf-offline/REPORT.md` and `LIVE_QUALIFICATION_PLAN.md` — T0-T8 implementation
  checkpoints + a 5-phase audit-and-fix pass for TestDaF specifically, already resolving
  `lesen_2`'s item count (4→5, via the demo PDF's printed solution key) and `lesen_7`'s
  `requiredSourceKinds` gap, already documenting the TestDaF speaking architecture gap and the
  sprechen_4/sprechen_6 multi-phase renderer gap. Treated as ground truth for what it covers; not
  re-derived from scratch in this audit.
- `backend/python-ai/scripts/qa_budget.py` — generic `QaBudget`/`guard_new_sample`/
  `labeled_usage` bounded-QA primitives (hard ceiling `SAFE_MAX_COST_USD=0.25`,
  `SAFE_MAX_SAMPLES=1`).
- `backend/python-ai/scripts/qa_testdaf_live.py` — bounded, `QaBudget`-based, has `--dry-run`.
- `backend/python-ai/scripts/qa_goethe_live.py` — bounded (own inline `spent_usd >= max_cost_usd`
  check, **not** `qa_budget.QaBudget`), **no `--dry-run` mode**. Divergent pattern from the TestDaF
  script — noted as a Phase 7 finding.
- `backend/python-ai/scripts/qa_reading_mc.py`, `qa_goethe_lesen.py` — earlier, narrower QA
  scripts, superseded in scope by the two `_live.py` scripts above but not removed.

## Confirmed via grep, this phase
- `grep -rn "available=True" backend/python-ai/app/services/german_exams/*.py` → **0 matches**
  (no part sets it explicitly anywhere; TELC's live availability comes entirely from the
  dataclass default, which this audit does not change).
- `grep -rn "profile_id ==" backend/…` → 0 matches (no `if profile_id == "..."` anti-pattern found
  anywhere in services).
- 3 hardcoded profile-id string references found outside the profile files themselves — see
  Phase 9 / `IMPLEMENTATION_AUDIT.md`'s Cross-Exam Contamination section for detail.
