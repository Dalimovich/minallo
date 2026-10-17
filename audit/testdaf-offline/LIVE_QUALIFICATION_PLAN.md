# Digital TestDaF — live qualification plan (Phase 5)

This is a plan, not an execution. Nothing in this document authorizes running
`scripts/qa_testdaf_live.py` against a real provider. All 23 parts stay
`available=False` until each one individually passes qualification and a
human explicitly flips its flag — this document never does that itself.

## Live-sample qualification policy (decided)

This repo's internal QA policy for how many successful live samples are
sufficient before a part may be considered for release. This is **internal
QA policy, not an official TestDaF requirement**, and satisfying it is
**never proof of universal generator correctness** — it only means the
sampled runs did not reveal a defect.

- **Initial qualification = 3 successful live samples per task type.**
- A sample counts toward the 3 only when all of the following hold:
  (a) automated structural validation passes;
  (b) semantic/content QA passes;
  (c) all official task mechanics are correct (item counts, timings,
      required source kinds, scoring shape, etc., per the profile);
  (d) required media/service dependencies work (e.g. audio actually
      synthesizes and plays, grading service actually returns a real
      result — not a stub/fail-visibly default).
- If a sample fails because of a real content/generator/service defect,
  the defect must be fixed and that sample **replaced** with a new one —
  **failed samples never count toward the 3**, regardless of cause.
- After 3 clean samples, the task type is marked **PROVISIONALLY
  QUALIFIED** — not fully qualified, not released. A human still decides
  when/whether to flip `available=True`, separately from this policy.
- If the first 3 samples reveal substantial quality variability, borderline
  distractors, unstable grading, or other meaningful concerns, **5 clean
  samples** are required before release instead of 3.
- T8's `QaBudget` still caps any single harness invocation at
  `--max-samples <= 1`, so "3 clean samples" means 3 separate bounded
  invocations (more if any invocation's sample fails and must be replaced),
  reviewed individually — never batched, never inferred from one run.

## How to read the matrix

For every part: **Samples** = the qualification target under the policy
above — "3 (5 if variability)" — i.e. 3 clean, policy-passing live samples
for initial qualification, rising to 5 if the first 3 show meaningful
variability; failed samples are replaced and do not count. **Max provider
calls** = calls-per-invocation cap enforced by `QaBudget`
(`SAFE_MAX_SAMPLES = 1`), so reaching the qualification target takes at
least that many separate invocations (more if samples must be replaced),
executed one invocation at a time, not batched. **Automated checks** = what
the existing generator/validator pipeline already asserts before content
reaches the QA record (deterministic validation + semantic verification,
both already wired per module — see `audit/testdaf-offline/REPORT.md`
T1/T2/T3/T4). **Human review** = what a person must additionally judge,
since no automated check can certify authentic C1 register, real-world
plausibility, or exact conformance to a paywalled official spec this repo
cannot fetch. **Pass/fail criteria** = the per-part policy-compliant
qualification criteria — "3 clean samples (5 if variability found)" per
the policy above, plus that part's own specific checks.

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
| lesen_1 | lexical_cloze | 3 (5 if variability) | 1/invocation | Deterministic validator (exactly one correct option/gap, distractor plausibility) + semantic verify | Register matches C1 academic reading; gaps test grammar/collocation, not trivia; no ambiguous second-correct option | 3 clean samples (5 if variability found): validator+verifier pass AND human confirms no ambiguity, on every counted sample |
| lesen_2 | paragraph_ordering | 3 (5 if variability) | 1/invocation | 5-paragraph structural validator (unique order, no orphan paragraph) | Paragraphs form one coherent, uniquely-orderable text; no paragraph independently placeable in two positions | 3 clean samples (5 if variability found): validator pass AND human confirms unique ordering is actually unambiguous, on every counted sample |
| lesen_3 | reading_multiple_choice | 3 (5 if variability) | 1/invocation | 7-item MC validator + semantic verify (existing, most mature) | Paragraph-scoped items follow text order; final item tests whole-text purpose per demo pattern | 3 clean samples (5 if variability found): validator+verifier pass AND human spot-checks 2 of 7 items against source paragraph, on every counted sample |
| lesen_4 | speech_act_matching | 3 (5 if variability) | 1/invocation | Unique-mapping validator (4 items, 8 options, no reused option) | Speech acts are genuinely distinguishable from each other, not near-synonyms | 3 clean samples (5 if variability found): validator pass AND human confirms no two options are defensibly correct for the same item, on every counted sample |
| lesen_5 | statement_category_matching | 3 (5 if variability) | 1/invocation | Category validator (7 items, 4 roles incl. "neither") | "Neither"/"both" items aren't trivially guessable from surface wording | 3 clean samples (5 if variability found): validator pass AND human confirms category assignment requires reading comprehension, not keyword matching, on every counted sample |
| lesen_6 | statement_concept_pair_matching | 3 (5 if variability) | 1/invocation | Unique-mapping validator (4 items, 2 groups, distractors) | Each statement maps to exactly one concept pair on a genuine content basis | 3 clean samples (5 if variability found): validator pass AND human confirms no plausible cross-assignment, on every counted sample |
| lesen_7 | reading_summary_error_detection | 3 (5 if variability) | 1/invocation | 3-error validator + graphic-consistency check (requiredSourceKinds now includes graphic — Phase 2 fix) | Graphic is genuinely referenced by >=1 of the 3 errors (per demo: one error contradicted the chart); exactly 3, not 2 or 4, contentually-wrong sentences | 3 clean samples (5 if variability found): validator pass AND human confirms graphic is load-bearing, not decorative, on every counted sample |

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
| hoeren_1 | listening_overview_completion | audio | 3 (5 if variability) | 1/invocation | Short-answer validator (<=2 words/answer, normalization rules) | Answers are unambiguous from audio alone, no world knowledge required | 3 clean samples (5 if variability found): validator pass AND human listens to synthesized audio in full and confirms transcript/audio match, on every counted sample |
| hoeren_2 | listening_concept_pair_notes | audio | 3 (5 if variability) | 1/invocation | Note-taking validator | Notes derivable from a single, locatable audio segment | 3 clean samples (5 if variability found), same review as hoeren_1 |
| hoeren_3 | listening_summary_error_detection | audio | 3 (5 if variability) | 1/invocation | 2-error validator, reveal-after-media | Errors are genuinely contradicted by audio content | 3 clean samples (5 if variability found), same review as hoeren_1 |
| hoeren_4 | video_speaker_statement_matching | video | 3 (5 if variability) | 1/invocation | Category validator (6 items, "both"/"neither") | Speaker attribution is unambiguous on-screen/in-audio | 3 clean samples (5 if variability found): human WATCHES full video, confirms speaker identity is visually/aurally clear, on every counted sample |
| hoeren_5 | video_outline_completion | video | 3 (5 if variability) | 1/invocation | Short-answer validator | Outline points map 1:1 to spoken content | 3 clean samples (5 if variability found): human watches full video, on every counted sample |
| hoeren_6 | listening_multiple_choice | audio | 3 (5 if variability) | 1/invocation | 5-item MC validator + semantic verify | Distractors are plausible but clearly wrong on close listening | 3 clean samples (5 if variability found): validator+verifier pass AND human spot-check, on every counted sample |
| hoeren_7 | sound_script_comparison | audio | 3 (5 if variability) | 1/invocation | Sound/script validator | Audio pronunciation genuinely disambiguates the written pairs tested | 3 clean samples (5 if variability found): human listening review mandatory (this task type tests phonetic perception specifically), on every counted sample |

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
| schreiben_1 | argumentative_essay | 3 (5 if variability) | 1/invocation | wordCountMin, no requiredSourceKinds, essay-prompt validator | Prompt has a genuine, debatable stance requirement; topic is academically appropriate | 3 clean samples (5 if variability found): validator pass AND human confirms prompt is answerable in ~200 words without specialist knowledge, on every counted sample (also requires a real, wired grading result per sample — see dependency table) |
| schreiben_2 | text_graph_summary | 3 (5 if variability) | 1/invocation | wordCountMinApprox/MaxApprox, requiredSourceKinds=(text,graphic), structured-graphic renderer | Graphic and text are mutually consistent (no contradiction the task doesn't intend); ~100-150 word target achievable | 3 clean samples (5 if variability found): validator pass AND human confirms the accessible-table graphic rendering matches source data, on every counted sample (also requires a real, wired grading result per sample — see dependency table) |

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
| sprechen_1 | spoken_advice | 3 (5 if variability) | 1/invocation | Duration validator (45s cap), no source | Prompt situation is natural, advice-eliciting | 3 clean samples (5 if variability found): validator pass AND human listens to a real recorded response against the prompt, on every counted sample (also requires a real, wired transcription+grading result per sample — see dependency table) |
| sprechen_2 | spoken_option_comparison | 3 (5 if variability) | 1/invocation | Duration validator (90s cap) | Two options are genuinely comparable/debatable | Same policy as sprechen_1 |
| sprechen_3 | spoken_text_summary | 3 (5 if variability) | 1/invocation | Duration validator (120s), hideSourceAfterPreparation | Source text summarizable within 4 min prep | Same policy as sprechen_1 |
| sprechen_4 | spoken_information_comparison | 3 (5 if variability) | 1/invocation | Duration validator (90s), requiredSourceKinds=(graphic,script) | **BLOCKED** — see below | **Cannot enter live QA** until the multi-phase renderer gap is closed; once unblocked, same 3-clean-samples (5 if variability) policy applies |
| sprechen_5 | recorded_topic_presentation | 3 (5 if variability) | 1/invocation | Duration validator (150s) | Presentation topic has natural structure/subpoints | Same policy as sprechen_1 |
| sprechen_6 | spoken_argument_response | 3 (5 if variability) | 1/invocation | Duration validator (120s), requiredSourceKinds=(script,) | **BLOCKED** — see below | **Cannot enter live QA** until the multi-phase renderer gap is closed; once unblocked, same 3-clean-samples (5 if variability) policy applies |
| sprechen_7 | spoken_measure_critique | 3 (5 if variability) | 1/invocation | Duration validator (90s) | Measure is genuinely critiquable, not one-sided | Same policy as sprechen_1 |

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
   invocation per sample (real provider call, real cost, capped at
   $0.25/1 sample by `QaBudget`'s hard ceiling — this script cannot be told
   to exceed that).
2. Human reviews the written diagnostics JSON against the checklist above
   and against the live-sample qualification policy (does this sample count
   toward the 3, or does a real defect require a fix-and-replace?).
3. Repeat until 3 clean, policy-counted samples exist for that part (5 if
   the first 3 reveal substantial quality variability, borderline
   distractors, unstable grading, or similar concerns). Failed samples are
   fixed and replaced, never counted.
4. Record each sample's outcome (pass/fail/notes) outside this repo's
   release flags — this plan does not specify where; that's an operational
   decision for whoever runs Phase 6.
5. Only once a part reaches PROVISIONALLY QUALIFIED status under the policy
   above does a human — not this harness, not any script — decide whether
   and when to flip `available=True` for that one part in
   `testdaf_digital.py`. Qualification under this policy is never itself an
   automatic release.

Total for an initial pass across all 18 currently-unblocked parts, assuming
every sample is clean on the first try (the optimistic case — real defects
will require additional replacement invocations): at least 18 x 3 = 54
provider calls, at least $13.50 (54 x $0.25 ceiling; actual cost per the
existing `model_pricing.estimate_cost_usd` figures will likely be far lower
per sample). If any part needs the 5-sample bar, its total rises
accordingly. **This plan proposes that number; it does not authorize
spending it.**
