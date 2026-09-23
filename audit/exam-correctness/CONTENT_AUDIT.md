# Phase 4 — Content Audit

No live generation was performed in this task (hard constraint). This phase is, per the task's
own instruction for this exact situation: (a) a documented checklist/rubric per task family,
(b) a check of existing committed fixtures against that checklist as a proxy, (c) an explicit
UNVERIFIED status for "real generated content" on every task type, pending the Phase 7 harness
(not executed here).

## (a) Checklist per task family

**Objective/selection tasks (MC, matching, cloze, category assignment):**
1. Exactly one defensible correct answer per item (no second answer a fair reader could pick).
2. Distractors are genuinely wrong, not merely "less good" — each must be falsifiable from the
   source text/audio, not from outside knowledge.
3. No item is answerable from world knowledge alone, without reading/listening to the source
   (unless the task type is explicitly designed to test general knowledge, which none here are).
4. Item order, count, and option count match the profile's `constraints`.
5. For "unused"/"none of the above"/"neither" style options: genuinely plausible as a correct
   answer for at least one item in the set (not a permanent throwaway option).
6. Register and topic match the stated CEFR level and academic/general-interest domain.

**Reading/listening comprehension specifically:** paraphrase distance between source and correct
answer is C1-appropriate (not verbatim copy, not so distant it becomes inference beyond the text).

**Language elements (Sprachbausteine):** excluded from this audit's scope per task instructions —
no checklist applied.

**Writing:** task fulfilment requirements (content points) are genuinely achievable in the stated
word count; register/audience is unambiguous; rubric dimensions map 1:1 to the profile's
`grading_dimensions`; no fabricated learner quotes in grading output (already asserted by existing
tests per `audit/testdaf-offline/REPORT.md` T3).

**Speaking:** prompt is genuinely speakable within the time limit; for TestDaF's non-interactive
recorded model, the prompt must not presuppose a live partner/interlocutor (that would be a
content defect specific to this architecture — a TELC-shaped prompt ported to TestDaF); for TELC's
interactive model, the AI-partner's turns must respond to what the learner actually said, not a
scripted ignore-the-input flow.

## (b) Fixture-proxy check

Read all four `tests/e2e/fixtures/*.json` files (source-selection.json: 4 entries,
productive-tasks.json: 2, speaking-tasks.json: 7, media-tasks.json: 7) and
`backend/python-ai/tests/german_exam_semantic_fixtures.py` (53 lines).

| Fixture file | Sample checked | Result | Note |
|---|---|---|---|
| `source-selection.json` entry 0 (`lesen_1`/`lexical_cloze`) | Options are literally `"Aussage 0"`, `"Aussage 1"`... and prompts are `"Textstelle 0"`, `"Textstelle 1"`... | **PASS (mechanics) / N/A (content quality — synthetic placeholders, no German content to assess)** | Confirms `REPORT.md`'s own statement: "Offline fixtures deliberately test mechanics, not language quality." These are not real exam items and should not be graded against the content checklist above — they test that the *renderer/validator plumbing* (option counts, evidence-id wiring, skill-tag propagation) works, not that generated German is any good. |
| `productive-tasks.json` (2 entries, writing) | Structural shape (word count fields, grading dimension keys) | **PASS (mechanics)** — matches `_GOETHE_WRITING_DIMENSIONS`/TELC's `grading_dimensions` shape where applicable | Content is placeholder, not real learner/generated prose — no content-quality claim possible |
| `speaking-tasks.json` (7 entries) | Structural shape (recordingId/durationSeconds fields for TestDaF-style parts) | **PASS (mechanics)** | Same placeholder caveat |
| `media-tasks.json` (7 entries) | audio/video URL scheme validation shape | **PASS (mechanics)** | No real audio/video asset referenced (by design — no TTS/video call permitted) |
| `german_exam_semantic_fixtures.py` | Fixture builders for semantic-verify pipeline tests | **PASS (mechanics)** — exercises the verifier's issue-detection code paths (ambiguity, unsupported keys, outside knowledge, implausible distractors) against deliberately-broken synthetic content, not real generated content | This is the closest existing proxy to "does the semantic verifier actually catch the checklist's failure modes" — and it does, per the passing `test_german_exam_semantic_*` suite (see Phase 12) — but that is a test of the **verifier's ability to catch planted defects**, not proof that real live-generated content is itself defect-free. |

**Overall fixture-proxy verdict: MANUAL_REVIEW is not applicable to placeholder content, and no
fixture claims to be real exam-quality German prose.** No fixture failed its own mechanical
contract. No fixture provides evidence either way about real generated-content quality — that
remains entirely open, see below.

## (c) Real generated content status: UNVERIFIED for every task type

Every one of the 44 in-scope task types (10 TELC excl. Sprachbausteine + 12 Goethe + 23 TestDaF −
1 excluded Sprachbausteine part... see COMPLETE_TASK_MATRIX.md for the exact count) has its "real
generated content" quality marked **UNVERIFIED** in this audit. This is not a gap this audit could
close: Phase 7 builds the harness that *would* produce reviewable live samples, but this task's
hard constraints forbid executing it against a real provider. TELC is the one exception worth
naming precisely: TELC is **already live in production** (`available=True` by default on every
part), meaning real generated content already exists in production usage today — but auditing
*that* live content was out of scope for this pass (no access to production generation logs was
used or requested here; this audit worked from the repository only).

## TestDaF speaking — represented exactly as instructed
The TestDaF speaking content-quality question is inseparable from its grading architecture gap:
since no grader exists for TestDaF's independent-recording model (see GRADING_AUDIT.md), "content
defect" and "grading capability missing" are two different questions, and this audit keeps them
separate. TestDaF sprechen_1-7's **prompt content** generation itself (the text/audio/graphic
material the learner responds to) uses the same `generate_productive` pipeline as writing and is
therefore auditable the same way as any other productive task's prompt-generation code — it is the
**response-grading** side that has zero implementation, not prompt generation. This is marked
**IMPLEMENTATION GAP / GRADING CAPABILITY MISSING** in GRADING_AUDIT.md, not scored as a content
defect here.
