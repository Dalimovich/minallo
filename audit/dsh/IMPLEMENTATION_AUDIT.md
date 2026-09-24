# DSH implementation audit (structural phase)

Branch `feat/dsh-profile`, based on `origin/main` (c735ce11). Date of source check: 2026-09-24.
**Scope of this phase:** exam structure, registration, data model, scoring arithmetic, delivery state
machine and UI structure. **No DSH content exists, none was generated, and no DSH task is available.**
Nothing in this phase called a model, TTS, transcription or the inventory.

Legend — **OFFICIAL**: stated in the current HRK MPO. **SECONDARY**: stated by a university, not by the MPO.
**INFERRED**: derived from official text but not stated. **DECISION**: a Minallo implementation choice.
**FUTURE**: not built in this phase.

## 1. Sources used

| Source | Version | Role |
|---|---|---|
| HRK, DSH-Musterprüfungsordnung, Anlage 1 zur RO-DT — [PDF](https://www.hrk.de/fileadmin/redaktion/hrk/02-Dokumente/02-07-Internationales/02-07-22_DSH/DSH_Musterpruefungsordnung_2025.pdf) | Beschluss HRK 29.09.2025; KMK Hochschulausschuss 20.11.2025, Schulkommission 27.11.2025 | **Primary.** Text read directly from the PDF (pdftotext). |
| HRK, Rahmenordnung RO-DT (Fassung HRK 04.11.2025 / KMK 27.11.2025) | 2025 | Context: §3 DSH, levels DSH-1/2/3, admission meaning. Contains **no CEFR mapping** for DSH. |
| [HRK page on registration of local DSH regulations](https://www.hrk.de/mitglieder/arbeitsmaterialien/registrierung-von-dsh-pruefungsordnungen/) | read 2026-09-24 | Confirms each site registers its own local regulation. |
| [Uni Duisburg-Essen, Berechnung des Ergebnisses](https://www.uni-due.de/dsh-info/berechnungergebnis.php) | read 2026-09-24 | **Secondary**, point scale only (700 written = 200/200/100/200; oral 300). |
| HRK MPO 2019 (superseded) | 11.03.2019 | Read earlier for tracing only; **not** used as the specification. |

Note: the URL in the task brief (`…Musterprüfungsordnung_2025.pdf`, with an umlaut) returns 404. The real file name
has no umlaut (`…Musterpruefungsordnung_2025.pdf`), found via the HRK page.

### 2019 → 2025 differences found in the text
* Dictionary: 2019 "einsprachige Wörterbücher", **2025 "in Papierform"** (§10(2), §11a). Recorded as `aids: monolingual_dictionary_paper_only`. Minallo (digital) cannot offer a paper dictionary; not simulated.
* §4(2) **electronic written exam** (elektronische Präsenzprüfung) and §4(3) **online oral exam** (elektronische Fernprüfung) are now explicitly allowed and equivalent. Oral `deliveryModes = (in_person, online_remote)`.
* §5(2)/(3): wording "HV, **LV inklusive WS**, TP" (LV and WS explicitly one Teilprüfung); §6(2) commission composition tightened. Result thresholds, weights, times and lengths are **unchanged**.
* §1(2): DSH-3 can be required by a university for certain purposes (previously only DSH-1 relaxations were named).

## 2. Internal audit (done before implementing)

**1. Reusable as-is:** one-profile-per-file architecture (`shared.ExamProfile`), registry, manifest pipeline
(`build_manifest` → `/german-exam/manifest` → `fetchExamManifest` → workspace), `available=False` gate
(`_require_available` raises before inventory/model/topic work), the frontend's manifest-driven overview and
card hiding, `createExamWorkspace` (sequence-numbered, abort-on-switch, clears state before render), the
onboarding level catalogue (`GERMAN_TEST_LEVELS.DSH` already existed), the parity tests that read the profile
files, the e2e manifest fixture generator.

**2. Had to be added:** DSH profile; dedicated result calculator; open-answer/answer-family model; LV↔WS binding;
HV two-play state machine (Python + browser mirror, shared vectors); a `scientific_structures` skill-tag
vocabulary; generic manifest fields (`code`, `resultModel`, `presentation`); manifest-driven module cards
and chatbot-link rule; structure preview for onboarding/Profile; an availability gate at the edge; tests.

**3. Existing abstractions insufficient for DSH:**
* `result.py` refuses to combine modules — DSH's official result *is* a weighted combination → dedicated `dsh_result.py`.
* All objective task types are MC/matching/short-key; DSH HV/LV are **open content answers** → `OpenAnswerItem`.
* `language_elements` is telc Sprachbausteine (cloze MC, `MODULE_SKILL` → the Sprachbausteine card) — DSH WS
  is a different task family → **own module key `scientific_structures`**, own tag vocabulary, own task type.
* `media-task.ts` has no play count/timers → separate two-play state machine (not yet wired to audio).
* The practice screen had static per-skill cards (`reading`, `listening`, `sprachbausteine`, `writing`) hidden by
  manifest; a profile could not opt out of them entirely → generic `presentation.moduleCards = "manifest"`.
* Generate endpoint charged subscription/cap/rate-limit **before** python answered 501 for a listed-but-unavailable part
  → `checkExamPartAvailability` gate (also fixes the same latent issue for Goethe).
* `GRADABLE_*_PROFILE_IDS` allow-lists are correct as they are; DSH is intentionally not added.

**4. Structural (done here):** profile, manifest, registries, scoring arithmetic, data model, playback rules, UI structure, gates.

**5. Needs future AI generation/grading:** lecture/text/chart/task generation (HV, LV, WS, TP), content-point
extraction and grading of open answers, WS answer-family construction + adjudication, TP rubric grading,
oral examiner dialogue and speaking grading, TTS for the HV lecture.

**6. Cannot be completed without live model calls:** everything in (5), plus content qualification (blind
solver, semantic verification, manual review) and live UI validation with real content.

## 3. Requirement → implementation → test

Files: `P` = `backend/python-ai/app/services/german_exams/`; tests in `backend/python-ai/tests/` (py) and `tests/` (mjs).
"Live-dependent" = needs future generation/grading to be *useful*; the structural part is done and tested.

| # | Requirement | Status | Source | Implementation | Test | Verified | Live-dep. |
|---|---|---|---|---|---|---|---|
| R1 | One exam, three result levels DSH-1/2/3 (not three exams) | OFFICIAL | RO-DT §3, MPO §2, §5(6) | `P/dsh.py` (`legacy_level_values`, `RESULT_MODEL`) | `test_german_exam_profile_dsh.py::test_dsh_is_one_profile…` | yes | no |
| R2 | No CEFR mapping for DSH levels | OFFICIAL (absence) | MPO, RO-DT (none stated) | `cefr_level=None`, `officialCefrMapping=None` | `…::test_no_cefr_level_is_invented` | yes | no |
| R3 | Written exam = HV, LV(+WS as one Teilprüfung), TP; oral mandatory | OFFICIAL | §4(2),(3), §5(4) | `dsh.py` modules; module order HV, LV, WS, TP, oral | `…::test_module_structure_and_order…` | yes | no |
| R4 | HV: lecture-like text, no specialist knowledge | OFFICIAL | §10(4)1a | `hv_1` constraints | `…::test_hv_facts` | yes | gen |
| R5 | HV length 5,500–7,000 chars incl. spaces (of the equivalent written text) | OFFICIAL | §10(4)1a | `lectureCharsMin/Max`; `validate_hv_content` | `…::test_hv_facts`, `test_german_exam_dsh_content_model.py::test_hv_lecture_length…` | yes | gen |
| R6 | **No** audio duration is official → none stated | OFFICIAL (absence) | §10(4)1a ("je nach Redundanz") | none defined; `approx_duration_seconds=None` | `…::test_no_invented_audio_duration_anywhere` | yes | no |
| R7 | HV presented twice; notes allowed; topic hints/names/dates/terms/visuals allowed | OFFICIAL | §10(4)1b | `presentationCount=2`, `notesAllowed`, hint flags | `…::test_hv_facts` | yes | no |
| R8 | HV processing: 10 min after 1st, 40 min after 2nd play; play time not counted | OFFICIAL | §10(1)1 | `processingWindows`; `dsh_hv_playback.py`; `dsh-hv-playback.ts` | `test_german_exam_dsh_hv_playback.py` (12 shared vectors + exhaustive sequences), `dsh-hv-playback.test.mjs` | yes | no |
| R9 | HV tasks: questions / structure sketch / summary / line of thought, combinable | OFFICIAL | §10(4)1c | `taskForms`, `taskFormsCombinable` | `…::test_hv_facts` | yes | gen |
| R10 | HV assessed on completeness/appropriateness, **not** language | OFFICIAL | §10(4)1d | `ASSESSMENT`, `OpenAnswerItem(assess_language=False)`, `score_content_item` (no answer-text parameter) | `…content_model.py::test_content_items_can_never_penalise_language`, `…score_takes_no_answer_text…` | yes | grading |
| R11 | LV: 4,500–6,000 chars incl. spaces; authentic study text; no specialist knowledge; optional graphic | OFFICIAL | §10(4)2a | `lv_1` constraints; `validate_lv_content` | `…::test_lv_facts`, `…content_model::test_lv_text_length…` (edges 4499/4500/6000/6001) | yes | gen |
| R12 | LV task forms (questions, argument structure, outline, explain passages, headings, summary); content-assessed | OFFICIAL | §10(4)2b,c | `taskForms`, `assessment` | `…::test_lv_facts` | yes | gen/grading |
| R13 | Reading block 90 min incl. reading time, shared LV+WS | OFFICIAL | §10(1)2 | `ModuleSpec(reading)=5400s`, WS note | `…::test_written_module_timings` | yes | no |
| R14 | WS tied to the LV text; forms: completion, complex structures, paraphrase, transformation; categories syntactic/morphological/lexical/idiomatic/text-type | OFFICIAL | §10(4)2d | `ws_1` constraints, module `scientific_structures` | `…::test_ws_facts_and_it_is_not_sprachbausteine` | yes | gen |
| R15 | WS assessed on linguistic correctness | OFFICIAL | §10(4)2e | `StructureItem`, `score_structure_item` | `…content_model::test_ws_is_graded_on_correctness…` | yes | grading |
| R16 | WS admits several correct answers | INFERRED | §10(4)2d ("Umformungen") | `AnswerFamily` model; unmatched ≠ wrong (`needsAdjudication`) | `…::test_several_answers_can_be_correct`, `test_families_must_be_unambiguous` | model only | adjudication |
| R17 | LV and WS share one source; WS cannot cite another LV | OFFICIAL (shared text) + DECISION (fingerprint binding) | §5(4), §10(4)2d | `sharedSourceGroup`, `sourcePart`; `validate_lv_ws_bundle`, `source_fingerprint` | `…::test_lv_and_ws_share_one_source_group…`, `…content_model::test_ws_cannot_reference_…` (4 tests) | yes | gen |
| R18 | TP ≈ 250 words (approximate); study-related, science-oriented argumentative factual text | OFFICIAL | §10(4)3a | `wordCountApprox=250` (no min/max invented) | `…::test_tp_facts` | yes | gen |
| R19 | TP inputs: diagrams, keyword lists, tables, graphics, quotations, statements, short texts; language acts | OFFICIAL | §10(4)3a | `inputKinds`, `languageActs`; `validate_tp_content` | `…content_model::test_tp_must_be_input_bound…` | yes | gen |
| R20 | TP must not be a free essay; no template-friendly prompts | OFFICIAL | §10(4)3a | `freeEssayAllowed=False`, `templateFriendlyPromptsAllowed=False`, `inputRefs` required | same | structural only — "template-friendly" needs semantic review | review |
| R21 | TP content criteria + language criteria; language weighted stronger | OFFICIAL | §10(4)3b | `TP_RUBRIC`, `grading_dimensions` | `…::test_tp_facts` | yes | grading |
| R22 | **No numeric TP weights are published** → none assigned | OFFICIAL (absence) | §10(4)3b | `numericWeights=None`, no `criteria_max_points` | `…::test_tp_facts` | yes | no |
| R23 | TP time 70 min | OFFICIAL | §10(1)3 | `ModuleSpec(writing)=4200s` | `…::test_written_module_timings` | yes | no |
| R24 | Sub-tests span ≥ 2 topic areas; monolingual paper dictionary only | OFFICIAL | §10(2) | `TOPIC_AREAS`, `written_topic_set_is_valid`, `aids` | `…::test_written_topic_sets…`, `test_aids_are_paper…` | yes | no |
| R25 | Topic banks: static, academic | DECISION | — | `DSH_TOPIC_BANKS` (seed labels only) | `…::test_topic_banks_are_static…` | seeds only | review |
| R26 | Oral: 20 min prep; ≤5 min presentation (preferably descriptive) + ≤15 min conversation; ≤20 min total; no group exams; input = short text/graphic | OFFICIAL | §11a,b | `sprechen_1` constraints (`…Max` keys for maxima) | `…::test_oral_facts` | yes | no |
| R27 | Oral delivery in person or online | OFFICIAL | §4(3) (2025) | `deliveryModes` | `…::test_oral_facts` | yes | no |
| R28 | Oral criteria (content, comprehensibility, independence, conversational behaviour, correctness, lexical differentiation, pronunciation/intonation) | OFFICIAL | §11c | `assessmentCriteria` | `…::test_oral_facts` | yes | grading |
| R29 | Oral is NOT routed through the telc-only speaking route | DECISION | — | DSH not in `GRADABLE_SPEAKING_PROFILE_IDS`; task type unimplemented | `test_german_exam_dsh_zero_cost.py::test_grade_writing_and_speaking_are_not_routable_for_dsh` | yes | FUTURE |
| R30 | Weights HV:LV:WS:TP = 2:2:1:2 | OFFICIAL | §5(3) | `WRITTEN_WEIGHTS` | `test_german_exam_dsh_result.py::test_weighting_is_2_2_1_2` | yes | no |
| R31 | Written pass ≥ 57 %; oral pass ≥ 57 % | OFFICIAL | §5(2),(5) | `PASS_THRESHOLD_PERCENT` | result tests | yes | no |
| R32 | DSH-1/2/3 need ≥ 57/67/82 % in **both** written and oral; no compensation | OFFICIAL | §5(1),(6) | `overall_result` (min of levels) | `test_no_compensation_…`, `test_failed_written_decides…` | yes | no |
| R33 | Point scale 700 (200/200/100/200) and oral 300 | SECONDARY | Uni Duisburg-Essen | `WRITTEN_MAX_POINTS`, `ORAL_MAX_POINTS` | `test_threshold_points_are_the_verified_numbers` | scale only | no |
| R34 | Boundaries 398/399, 468/469, 573/574 (written); 170/171, 200/201, 245/246 (oral); exact fractions | derived from R31–R33 | — | `dsh_result.level_for_share` (Fraction) | `test_written_boundaries`, `test_oral_boundaries`, `test_fractional_points…` | yes | no |
| R35 | Failed written exam decides the result; oral may be skipped | OFFICIAL | §4(3) | `overall_result` (`limitedBy`) | `test_failed_written_decides_…` | yes | no |
| R36 | Result is a practice estimate with the local-regulation disclaimer | DECISION | — | `official:false`, `DISCLAIMER` | `test_result_is_labelled_practice…` | yes | no |
| R37 | Invalid scores rejected (negative, > max, NaN/inf, bool, str, unknown part) | DECISION | — | `_checked` | `test_invalid_scores_are_rejected`, `test_invalid_structure_is_rejected` | yes | no |
| R38 | Every DSH part `available=False`, all task types `False` | DECISION | — | `dsh.py`, `task_types.py` | `…::test_every_part_is_unavailable…`, `test_german_exam_dsh_zero_cost.py` | yes | — |
| R39 | Registered in Python, edge TS, browser TS, manifest, task types; parity | DECISION | — | `registry.py`, `german-learner-profile.ts`, `german-profile.ts` | existing parity tests + `…::test_ts_registries_and_onboarding_levels_mirror_the_profile`; manifest fixture drift test | yes | no |
| R40 | UI generated from the manifest: DSH modules with codes; **no Sprachbausteine** anywhere (cards, nav, links, preview, counts) | DECISION (user requirement) | — | `presentation.moduleCards`, `staticExamCardState`, `chatPanelLinkHidden`, `renderOverviewHtml`, `exam-structure-preview.ts` | `german-exam-dsh-ui.test.mjs` (12 numbered scenarios + no-per-exam-branching test) | yes (logic); visual check below | no |
| R41 | Unavailable ≠ invisible: every DSH module (module card + "coming soon" chip) and part (disabled button, `data-state=unavailable`) is shown | DECISION (user requirement) | — | `renderOverviewHtml` + `mountTaskWorkspace` | `…::unavailable does not mean invisible…`; DOM check in §9 | yes | no |
| R42 | Unavailable part cannot consume paid usage | DECISION | — | `checkExamPartAvailability` in `ai-german-exam-generate.ts` | `german-exam-availability-gate.test.mjs` | yes | no |
| R43 | No model / TTS / inventory access from DSH code | DECISION (user requirement) | — | AST import allow-list; tripwires on `chat_json` and inventory | `test_german_exam_dsh_zero_cost.py` | yes | no |

## 4. Known university-local variations (NOT applied)

Each site registers its own regulation (MPO §12 "Hier wird vom Standort die jeweils geltende Regelung eingefügt"; §3, §7, §8 defer
admission, fees, repetition and consequences to local rules). Not individually verified here, and deliberately not mixed in:
* a **per-sub-test minimum** (e.g. 57 % in each part) is reported by some sites; the MPO sets 57 % on the *whole* written exam only.
  → `resultModel.perPartMinimumPercent = null`.
* electronic vs. paper delivery, exact reading/processing organisation, dictionary handling, fees, repetition rules, and the exact
  oral format vary by site.
Product wording (shown in the UI): *"DSH practice based on the HRK framework; individual universities may have registered local regulations."*

## 5. Deliberately not implemented (FUTURE)

* Any content: lectures, texts, charts, questions, keys, WS items; any generator, semantic verifier, blind solver, repair loop.
* Open-answer **grading** (content-point extraction), WS adjudication, TP rubric grading, the writing/speaking allow-lists for DSH.
* TTS for the HV lecture and wiring the two-play state machine to real audio; **server-side attempt record** (table + endpoint + migration)
  — the current play count lives in browser storage and protects against reloads/stale tabs, **not** deliberate tampering.
* Oral examiner dialogue, speaking grading, online-remote oral delivery.
* Full timed simulation (a "shared LV+WS 90-minute block" needs a delivery concept the engine does not have; `delivery_policy=None`).
* Practice-mode early advance of the HV window; a paper-dictionary equivalent.
* A DSH inventory/stock, DSH weakness-based adaptation, DSH result persistence and per-attempt result UI.
* Task-type naming from the brief (`dsh_hv_open_comprehension`, `dsh_hv_structure_sketch`, …, 11 names): collapsed to **5** flexible types
  because each official Teilprüfung combines several task forms (`taskForms` lists them).

## 6. Task types (5)

`dsh_hv_lecture_tasks`, `dsh_lv_text_tasks`, `dsh_ws_structure_tasks`, `dsh_tp_chart_based_argumentation`, `dsh_oral_presentation_conversation`
— all `False` in `task_types.py`, all parts `available=False`.

## 7. Zero-cost statement

The DSH files import only `dataclasses/decimal/fractions/hashlib/math/typing/unicodedata` and the exam-profile package (AST-checked).
Every real generation/inventory entry point is replaced with a tripwire in `test_german_exam_dsh_zero_cost.py` while the real routes are exercised.
The 2019/2025 PDFs were fetched with `curl`; no OpenAI, TTS, transcription or inventory call was made in this phase.

## 8. UI architecture (what changed and why)

The practice screen already built an overview from the manifest, but the exam **cards** were four static blocks (`reading`, `listening`,
`sprachbausteine`, `writing`) merely hidden when the manifest lacked their module. A profile could therefore never own its module list
completely, and DSH's Hörverstehen/Leseverstehen would have mapped onto telc's legacy Lesen/Hören cards.
* Profiles now carry two **generic** optional manifest fields: `modules[].code` (the exam's own short code) and `presentation`
  (`moduleCards: "manifest"`, `disclaimer`). A profile that sets `moduleCards: "manifest"` has NO static exam cards and NO chatbot
  exam links; its module cards come only from the manifest. There is no `if exam == "dsh"` anywhere in the frontend
  (asserted by a test that scans the code, not the data).
* WS lives under its own module key `scientific_structures`; it never touches the `language_elements` → Sprachbausteine mapping.
* The chatbot German panel used to show a static Sprachbausteine link for every exam (also Goethe/TestDaF, which have no such module).
  It now follows the same manifest rule. **Behaviour change for Goethe/TestDaF learners:** that dead link disappears.
* Onboarding and Profile show a structure preview generated from the profile files (`exam-structure-preview.ts`, drift-tested).
* Generation requests are built from the current ready manifest (`buildGenerateRequestBody`), so a stale mounted workspace cannot send the
  previous exam's profile id.

## 9. Visual / DOM verification (performed)

The real `applyDom` code path (exported as `applyExamStateToDom`) was bundled with esbuild and driven in headless Chromium on the real
`practice.html` exam group, the real chatbot German-panel markup and the real `practice.css` / `chatbot.css` rules, with the real generated manifests.
Sequence: telc → DSH → telc → Goethe → DSH → TestDaF → DSH → loading. At every step the module list, visible static cards, visible chatbot links and any
visible "Sprachbausteine" text matched the target exam exactly (DSH: 5 manifest module cards HV/LV/WS/TP/Mündliche Prüfung, zero static exam cards,
chat links Vocabulary/Grammar/Writing Coach/Sprechen only, no visible Sprachbausteine anywhere; telc: its four cards + Sprachbausteine link restored;
loading: nothing exam-specific). No page errors.
Defects found by this check and fixed before committing: (1) `chatbot.css` sets `display:flex` on `.ncb-german-panel-link`, which overrides the
`hidden` attribute — the links are now hidden with an explicit `display:none`; (2) the long label "Wissenschaftssprachliche Strukturen" overflowed
its card; (3) the module cards duplicated the part list already shown by the task workspace; (4) unreadable disabled part buttons.
This harness is scratch tooling (not committed). The repository's Playwright e2e suite (`tests/e2e/33-…`) was **not** run here (needs the full app + auth).

## 9b. Offline qualification suite (no OpenAI)

`dsh_qualification.py` + `tests/test_german_exam_dsh_offline_qualification.py` (50 tests) define the automated gates AI-generated DSH content must
pass, with the two AI judgements **injected** (`blind_solver` for WS, `content_matcher` for open-answer grading) so today they run against deterministic
fakes and later against a real model with no code change. Hand-authored golden content (`tests/dsh_golden_content.py`: an LV text of 4,775 chars, an
HV lecture of 5,968 chars, WS items anchored to exact LV sentences, content keys with reference answers and error-ridden variants, a TP task) must
pass every gate; each gate is also proven to fail on a targeted mutation. A gate that needs a judgement but got none is `skipped`, so a report is
`qualified` only when every gate ran and passed — and even then it cannot flip availability (manual review and live UI validation still apply).
Gates: LV length/forms/graphic, WS source binding (id + fingerprint + exact quoted span), WS item well-formedness (official forms/categories, unambiguous
answer families), WS key not leaked in the prompt, WS blind solver (sees the prompt only: not the key, not the quoted source sentence), HV/LV structure and
official length, reference answer reaches full marks, empty answer scores 0, language errors do not change a content score, TP anchored in its inputs and
not a free essay (narrow heuristic), topic-area rule. A socket tripwire proves the suite never touches the network.
Bug found while writing it: the blind view first included `sourceSentence`, which for completion items *is* the answer — now hidden.
Known weakness the gates cannot fix: a completion item whose gap sits in a sentence copied from the LV text is answerable by looking at the text; that is
a content-design matter for the semantic/manual review phase.

## 10. Branch note

`chore/zero-cost-correctness` (not merged, 3 commits ahead of main: TestDaF writing-grading shape fix, QA-harness reachability, an
availability-allowlist freeze test) was **not** used as a base. If it lands first, the freeze test will need DSH's five parts to stay `False`
(they do) and `GRADABLE_WRITING_PROFILE_IDS` must still exclude `dsh`.
