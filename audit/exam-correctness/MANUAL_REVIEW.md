# Phase 8 — Manual Review Queue

Items automation cannot reliably prove. No item here is marked PASS anywhere in this audit's other
documents — MANUAL_REVIEW is its own status, never silently upgraded.

## 1. TELC Sprechen total time: ~16 min (secondary source) vs. 11 min (part-level constraint sum)
**Exam/part:** telc_c1_hochschule / speaking / sprechen_1, sprechen_2.
**Problem:** `PROFILE_AUDIT.md` found the profile's `presentationSeconds` (180) +
`summaryFollowupSeconds` (120) + `discussionSeconds` (360) sum to 660s (11 min), while a secondary
source (deutschakademie.de) states "Sprechen: 16 Minuten" for the module total.
**Why automation can't establish this:** no primary telc.net text was machine-readable this
session (the Handbuch PDF is image-based); resolving which number (if either) is authoritative
requires either a human reading the scanned PDF or fetching a different, text-extractable primary
source.
**What a reviewer must check:** open `telc.net/.../Deutsch_c1_hochschule_Handbuch.pdf` (or an
equivalent primary source) directly and read the Sprechen section's stated total/per-task timing;
determine whether the extra ~5 minutes is transition/setup time not represented as a constraint, or
whether the profile's per-task seconds are themselves wrong.
**Source:** `OFFICIAL_SPEC_MATRIX.md` telc Sprechen row; `PROFILE_AUDIT.md`.

## 2. Goethe Sprechen per-criterion point weights — genuinely unpublished, unresolved
**Exam/part:** goethe_c1 / speaking / sprechen_1, sprechen_2.
**Problem:** the profile explicitly declines to state per-criterion Sprechen weights, citing that
the Modellsatz Prüferblätter (not yet obtained) would carry them.
**Why automation can't establish this:** this requires acquiring and reading a specific,
possibly-not-freely-downloadable examiner-material document, not something a search/fetch tool
reliably surfaces.
**What a reviewer must check:** locate a Goethe C1 Modellsatz Prüferblätter (examiner rating
sheet) and transcribe the per-criterion point weights, if publicly available; if not available,
this must stay UNVERIFIED indefinitely, not guessed.
**Source:** `OFFICIAL_SPEC_MATRIX.md` Goethe Sprechen rows; `goethe_c1.py` docstring.

## 3. TestDaF sprechen_4 / sprechen_6 — exact interaction semantics of the pre-preparation source phase
**Exam/part:** testdaf_digital / speaking / sprechen_4, sprechen_6.
**Problem:** the official demo PDF shows approximate timer values for a graphic-view/audio-listen
phase before preparation, but not whether that playback is skippable, replayable, auto-started, or
interruptible — `audit/testdaf-offline/REPORT.md`'s "Phase 6" section already documented this and
deliberately did not build a renderer for it on this basis.
**Why automation can't establish this:** the demo PDF's printed timer headers alone don't specify
interaction rules; only a fuller official source (candidate manual, live-test observation, or
direct confirmation from testdaf.de) could.
**What a reviewer must check:** find or request an authoritative description of the digital
TestDaF interface's exact playback-control behavior during this phase before any renderer work
begins on it.
**Source:** `audit/testdaf-offline/REPORT.md` section D; `OFFICIAL_SPEC_MATRIX.md` TestDaF Sprechen
rows.

## 4. Real generated-content quality — every task type, all three exams
**Exam/part:** all 44 in-scope parts.
**Problem:** no live content has ever been reviewed against the CONTENT_AUDIT.md checklist (one
defensible answer, genuine distractors, appropriate register, no external-knowledge dependency,
etc.) — this task's hard constraints forbid generating any.
**Why automation can't establish this:** semantic/content quality judgments (naturalness,
distractor plausibility, register authenticity) require either human review or the semantic
verifier, and the semantic verifier's own correctness against real content is itself unverified at
scale (Phase 4).
**What a reviewer must check:** run `scripts/qa_correctness_harness.py --execute` (human-initiated,
budget-capped, outside this task) for each task type, then manually review every sample against
`CONTENT_AUDIT.md`'s checklist before counting it toward the qualification policy already defined
in `audit/testdaf-offline/LIVE_QUALIFICATION_PLAN.md` (3 clean samples, 5 if variability).
**Source:** `CONTENT_AUDIT.md`; `PHASE7_HARNESS.md`.

## 5. TestDaF Hören 4/5 — video sourcing/production, once acquired
**Exam/part:** testdaf_digital / listening / hoeren_4, hoeren_5.
**Problem:** even once a video pipeline is built (a currently-nonexistent capability, not merely
unqualified), a human must confirm a produced/sourced video is genuinely TestDaF-appropriate
(visual clarity, speaker identifiability, register).
**Why automation can't establish this:** video content realism/appropriateness is not
machine-checkable by any tool in this codebase.
**What a reviewer must check:** watch every sample video in full once video generation/sourcing
exists; confirm speaker identity is visually/aurally unambiguous, per
`audit/testdaf-offline/LIVE_QUALIFICATION_PLAN.md`'s own Hören review checklist.
**Source:** `DELIVERY_AUDIT.md`; `audit/testdaf-offline/REPORT.md` section C.

## 6. TestDaF Hören 7 (`sound_script_comparison`) — phonetic perception realism
**Exam/part:** testdaf_digital / listening / hoeren_7.
**Problem:** this task type specifically tests whether audio pronunciation disambiguates written
word pairs — a defect here (e.g. TTS mispronunciation, or a pair that's actually indistinguishable
in the synthesized voice) is inherently an audio-quality judgment.
**Why automation can't establish this:** no automated phonetic-quality checker exists in this
codebase; TTS voice reachability is itself unconfirmed (per user memory: Qwen voice not yet
confirmed live).
**What a reviewer must check:** listen to every sample in full once TTS is confirmed live; confirm
disambiguation is genuinely audible, not just textually different.
**Source:** `audit/testdaf-offline/LIVE_QUALIFICATION_PLAN.md` Hören table.

## 7. TELC/Goethe speaking — interactive AI-partner response quality (TELC) / pair-discussion quality (Goethe, once built)
**Exam/part:** telc_c1_hochschule / speaking / sprechen_1, sprechen_2 (live in production today);
goethe_c1 / speaking / sprechen_1, sprechen_2 (once a grading route is built).
**Problem:** whether the AI partner's live dialogue turns genuinely respond to what the learner
said (not a scripted ignore-the-input flow) is a conversational-quality judgment.
**Why automation can't establish this:** requires a human to actually converse with the AI partner
and judge responsiveness — not proxy-testable from fixtures.
**What a reviewer must check:** conduct several live TELC speaking-practice sessions and confirm
the partner's follow-ups genuinely track the learner's actual answers.
**Source:** `GRADING_AUDIT.md` speaking section.

## 8. TestDaF profile-switch e2e coverage gap
**Exam/part:** all three exams, delivery layer.
**Problem:** `33-german-exam-profile-switch.spec.ts` proves TELC↔Goethe switching has no
stale-state leakage, but no e2e spec exercises a transition involving `testdaf_digital`.
**Why automation can't establish this (yet):** this audit did not run a browser this session (see
DELIVERY_AUDIT.md); a human/future pass should decide whether to extend the existing spec or add a
new one, then actually run it.
**What a reviewer must check:** add and run a TELC↔TestDaF and Goethe↔TestDaF variant of the
existing spec.
**Source:** `DELIVERY_AUDIT.md`.

**Total manual-review items: 8** (2 genuinely resolvable-if-a-primary-source-is-found timing/weight
gaps, 1 interaction-semantics gap, 1 blanket "no real content has ever been reviewed" item covering
all 44 tasks, 2 media-realism items, 1 conversational-quality item, 1 test-coverage gap).
