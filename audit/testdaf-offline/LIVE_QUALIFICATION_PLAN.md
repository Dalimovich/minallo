# Digital TestDaF — live qualification plan (Phase 5)

This is a plan, not an execution. Nothing in this document authorizes running
`scripts/qa_testdaf_live.py` against a real provider. All 23 parts stay
`available=False` until each one individually passes qualification and a
human explicitly flips its flag — this document never does that itself.

## Policy question this plan does NOT resolve on its own

No existing written policy in this repo states how many successful live
samples are sufficient to flip a part's `available` flag. T8's harness caps
a single invocation at `--max-samples <= 1`. Whether one clean sample is
*sufficient* for release, or whether N independent samples across N harness
invocations are required before a human signs off, **needs to be decided
explicitly by the user before Phase 6 starts** — this plan assumes the
conservative reading (multiple independent invocations, reviewed
individually, before any `available=True`) and calls that out per module
below. Do not treat "the harness ran once without error" as qualification.

## How to read the matrix

For every part: **Samples** = number of separate bounded harness invocations
recommended for *initial* qualification (1 representative sample per
invocation, per the roadmap). **Max provider calls** = calls-per-invocation
cap enforced by `QaBudget` (`SAFE_MAX_SAMPLES = 1`), so total provider calls
= Samples x 1 per part, executed one invocation at a time, not batched.
**Automated checks** = what the existing generator/validator pipeline
already asserts before content reaches the QA record (deterministic
validation + semantic verification, both already wired per module — see
`audit/testdaf-offline/REPORT.md` T1/T2/T3/T4). **Human review** = what a
person must additionally judge, since no automated check can certify
authentic C1 register, real-world plausibility, or exact conformance to a
paywalled official spec this repo cannot fetch.

---

## Lesen (Reading) — 7 parts

Reading has a generator/validator pipeline for `lexical_cloze` (lesen_1) and
`reading_multiple_choice` (lesen_3) per T1; `paragraph_ordering`,
`speech_act_matching`, `statement_category_matching`,
`statement_concept_pair_matching`, `reading_summary_error_detection`
(lesen_2, 4, 5, 6, 7) are registered task types with contracts but the T1
checkpoint states "all seven reading parts remain disabled" and lesen_2/
lesen_7 were paused pending official evidence (now resolved — see REPORT.md
Phase 2 findings below).

| Part | Task type | Samples | Max provider calls | Automated checks | Human review checklist | Pass/fail criteria |
|---|---|---|---|---|---|---|
| lesen_1 | lexical_cloze | 1 | 1 | Deterministic validator (exactly one correct option/gap, distractor plausibility) + semantic verify | Register matches C1 academic reading; gaps test grammar/collocation, not trivia; no ambiguous second-correct option | Validator+verifier pass AND human confirms no ambiguity |
| lesen_2 | paragraph_ordering | 1 | 1 | 5-paragraph structural validator (unique order, no orphan paragraph) | Paragraphs form one coherent, uniquely-orderable text; no paragraph independently placeable in two positions | Validator pass AND human confirms unique ordering is actually unambiguous |
| lesen_3 | reading_multiple_choice | 1 | 1 | 7-item MC validator + semantic verify (existing, most mature) | Paragraph-scoped items follow text order; final item tests whole-text purpose per demo pattern | Validator+verifier pass AND human spot-checks 2 of 7 items against source paragraph |
| lesen_4 | speech_act_matching | 1 | 1 | Unique-mapping validator (4 items, 8 options, no reused option) | Speech acts are genuinely distinguishable from each other, not near-synonyms | Validator pass AND human confirms no two options are defensibly correct for the same item |
| lesen_5 | statement_category_matching | 1 | 1 | Category validator (7 items, 4 roles incl. "neither") | "Neither"/"both" items aren't trivially guessable from surface wording | Validator pass AND human confirms category assignment requires reading comprehension, not keyword matching |
| lesen_6 | statement_concept_pair_matching | 1 | 1 | Unique-mapping validator (4 items, 2 groups, distractors) | Each statement maps to exactly one concept pair on a genuine content basis | Validator pass AND human confirms no plausible cross-assignment |
| lesen_7 | reading_summary_error_detection | 1 | 1 | 3-error validator + graphic-consistency check (requiredSourceKinds now includes graphic — Phase 2 fix) | Graphic is genuinely referenced by >=1 of the 3 errors (per demo: one error contradicted the chart); exactly 3, not 2 or 4, contentually-wrong sentences | Validator pass AND human confirms graphic is load-bearing, not decorative |

Reading dependencies: none outside the existing LLM generation pipeline —
text-only generation, no audio/video/grading service needed. The graphic for
lesen_7 needs a real chart-rendering step (already used by schreiben_2's
"structured graphics render accessible tables" per T3) — confirm that
component covers lesen_7's read-only (non-editable) graphic display, not
just the writing module's data-table variant, before lesen_7's first live run.

---

## Hören (Listening) — 7 parts

All seven interaction contracts exist per T2 (script generation only;
"generator-supplied assets are rejected"). Release blocker per T2: "all
listening parts need playable, script-aligned media delivery. Video
acquisition/generation is not implemented."

| Part | Task type | Media | Samples | Max provider calls | Automated checks | Human review checklist | Pass/fail criteria |
|---|---|---|---|---|---|---|---|
| hoeren_1 | listening_overview_completion | audio | 1 | 1 | Short-answer validator (<=2 words/answer, normalization rules) | Answers are unambiguous from audio alone, no world knowledge required | Validator pass AND human listens to synthesized audio in full and confirms transcript/audio match |
| hoeren_2 | listening_concept_pair_notes | audio | 1 | 1 | Note-taking validator | Notes derivable from a single, locatable audio segment | Same as above |
| hoeren_3 | listening_summary_error_detection | audio | 1 | 1 | 2-error validator, reveal-after-media | Errors are genuinely contradicted by audio content | Same as above |
| hoeren_4 | video_speaker_statement_matching | video | 1 | 1 | Category validator (6 items, "both"/"neither") | Speaker attribution is unambiguous on-screen/in-audio | Human WATCHES full video, confirms speaker identity is visually/aurally clear |
| hoeren_5 | video_outline_completion | video | 1 | 1 | Short-answer validator | Outline points map 1:1 to spoken content | Human watches full video |
| hoeren_6 | listening_multiple_choice | audio | 1 | 1 | 5-item MC validator + semantic verify | Distractors are plausible but clearly wrong on close listening | Validator+verifier pass AND human spot-check |
| hoeren_7 | sound_script_comparison | audio | 1 | 1 | Sound/script validator | Audio pronunciation genuinely disambiguates the written pairs tested | Human listening review mandatory (this task type tests phonetic perception specifically) |

**Hören release blocker (unchanged from T2, confirmed still open by this
audit):** audio generation has a real, generic path — `app/services/
tts_provider.py` (`TTSProvider.generate`) proxies to the Qwen3-TTS backend
already used by the Hören/Qwen-TTS initiative (per user memory: code merged
2026-09-16, **voice not yet confirmed live**). TestDaF listening should wire
through this exact same provider once it's live — no new TTS integration
needed, just call the existing service with the generated script. **Video
generation/acquisition has no existing implementation anywhere in this
codebase** (TELC/Goethe don't have a video-listening task type at all,
per T2). hoeren_4 and hoeren_5 cannot even enter live qualification until a
video pipeline is chosen and built — that is a real, unresolved release
blocker, not a QA-harness gap. Do not fabricate placeholder video.

---

## Schreiben (Writing) — 2 parts

Both task types have full content generation/validation, editor, timer,
draft recovery, submission lifecycle, and an injectable grading contract per
T3.

| Part | Task type | Samples | Max provider calls | Automated checks | Human review checklist | Pass/fail criteria |
|---|---|---|---|---|---|---|
| schreiben_1 | argumentative_essay | 1 | 1 | wordCountMin, no requiredSourceKinds, essay-prompt validator | Prompt has a genuine, debatable stance requirement; topic is academically appropriate | Validator pass AND human confirms prompt is answerable in ~200 words without specialist knowledge |
| schreiben_2 | text_graph_summary | 1 | 1 | wordCountMinApprox/MaxApprox, requiredSourceKinds=(text,graphic), structured-graphic renderer | Graphic and text are mutually consistent (no contradiction the task doesn't intend); ~100-150 word target achievable | Validator pass AND human confirms the accessible-table graphic rendering matches source data |

**Schreiben release blocker (confirmed unchanged by this audit — T3):** the
injected productive grader for both parts still needs to be connected to
"the authenticated production grading service" — this is not a new problem
for TestDaF; it's the same generic `grade_productive(part, content,
submission, *, grader=...)` contract in `german_exam_productive.py` used by
every profile's writing module. Confirm with whoever owns TELC/Goethe
writing grading in production whether that service is live and reachable
generically (profile-agnostic) before scheduling schreiben_1/2 live QA —
if it's live for TELC/Goethe, wiring TestDaF through it is a config change,
not new code.

---

## Sprechen (Speaking) — 7 parts

All seven task types share the generic productive-task contract and
`mountSpeaking` renderer per T4. Phase 2 of this audit (see REPORT.md)
confirmed via the official demo PDF that sprechen_1/2/3/5/7 are correctly
modeled as a single preparation-then-recording pass, but that sprechen_4 and
sprechen_6 have an additional, un-rendered source-playback phase (graphic
view + audio listen, or audio listen alone) before preparation that the
generic renderer does not implement.

| Part | Task type | Samples | Max provider calls | Automated checks | Human review checklist | Pass/fail criteria |
|---|---|---|---|---|---|---|
| sprechen_1 | spoken_advice | 1 | 1 | Duration validator (45s cap), no source | Prompt situation is natural, advice-eliciting | Validator pass AND human listens to a real recorded response against the prompt |
| sprechen_2 | spoken_option_comparison | 1 | 1 | Duration validator (90s cap) | Two options are genuinely comparable/debatable | Same |
| sprechen_3 | spoken_text_summary | 1 | 1 | Duration validator (120s), hideSourceAfterPreparation | Source text summarizable within 4 min prep | Same |
| sprechen_4 | spoken_information_comparison | 1 | 1 | Duration validator (90s), requiredSourceKinds=(graphic,script) | **BLOCKED** — see below | **Cannot enter live QA** until the multi-phase renderer gap is closed |
| sprechen_5 | recorded_topic_presentation | 1 | 1 | Duration validator (150s) | Presentation topic has natural structure/subpoints | Human review |
| sprechen_6 | spoken_argument_response | 1 | 1 | Duration validator (120s), requiredSourceKinds=(script,) | **BLOCKED** — see below | **Cannot enter live QA** until the multi-phase renderer gap is closed |
| sprechen_7 | spoken_measure_critique | 1 | 1 | Duration validator (90s) | Measure is genuinely critiquable, not one-sided | Human review |

**Sprechen release blockers:**
1. **sprechen_4 / sprechen_6 phase gap (confirmed by this audit, Phase 2C):**
   the official demo shows source-viewing/listening phases before
   preparation that `mountSpeaking` doesn't implement (it only has
   preparation -> recording). These two parts should stay excluded from live
   QA until either (a) the generic renderer gains an optional source-playback
   phase — justified here because both TestDaF tasks need it and a future
   TELC/Goethe task requiring the same could reuse it, so this is a
   candidate for the *shared* renderer, not a TestDaF-only fork — or (b) a
   scoped TestDaF-only wrapper is built if no other profile ever needs it.
   This audit did not build either, per the roadmap's "don't change code
   merely because it could be improved" instruction; it is a real,
   documented blocker for exactly these two parts, not for the other five.
2. **No TTS audio yet for sprechen_4/sprechen_6's "script" source kind** —
   same Qwen3-TTS dependency as Hören, not yet confirmed live.
3. **Recording -> transcription -> grading**: `app/services/
   german_exam_speaking_practice.py` already has a working `transcribe()`
   function (`gpt-4o-mini-transcribe`) used elsewhere in the German exam
   engine. TestDaF speaking grading should be wired through this exact
   existing service via the same injectable-grader contract writing already
   uses — no new transcription integration needed, just confirm it's
   reachable generically (profile-agnostic) the same way as the writing
   grading service above.

---

## What Phase 6 (not run here) would look like, bounded

For each **unblocked** part (18 of 23 — all of Lesen and Schreiben, 5 of 7
Sprechen; Hören is fully blocked on TTS/video, sprechen_4/6 blocked on the
renderer gap):

1. One `python -m scripts.qa_testdaf_live --module <m> --part <p> --env-file
   .env --max-cost-usd 0.25 --max-samples 1 --out diag_runs/testdaf`
   invocation (real provider call, real cost, capped at $0.25/1 sample by
   `QaBudget`'s hard ceiling — this script cannot be told to exceed that).
2. Human reviews the written diagnostics JSON against the checklist above.
3. Record the outcome (pass/fail/notes) outside this repo's release flags —
   this plan does not specify where; that's an operational decision for
   whoever runs Phase 6.
4. Only after the explicit multi-sample policy question above is answered
   and satisfied does a human — not this harness, not any script — flip
   `available=True` for that one part in `testdaf_digital.py`.

Total for an initial pass across all 18 currently-unblocked parts: at most
18 provider calls, at most $4.50 total (18 x $0.25 ceiling; actual cost per
the existing `model_pricing.estimate_cost_usd` figures will likely be far
lower per sample). **This plan proposes that number; it does not authorize
spending it.**
