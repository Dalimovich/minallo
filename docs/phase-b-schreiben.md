# Phase B: Schreiben

Implemented on 2026-09-17. Phase A's existing Sprachbausteine implementation is retained. Sprechen remains unimplemented.

## Blueprint and generation

`telc_c1_hochschule`, profile version 4, includes `writing/schreiben_1` with task type `choice_long_form_writing`: choose one of exactly two distinct topics, at least 350 words, 70 minutes, maximum 48 points. The four rubric dimensions are task fulfilment, correctness, repertoire and communicative design. Productive skills have no `points_per_correct` value.

Official format reference: [telc C1 Hochschule](https://www.telc.net/sprachpruefungen/zertifikatspruefung/deutsch/telc-deutsch-c1-hochschule/) and the [telc handbook](https://www.telc.net/fileadmin/user_upload/Handbooks/telc_deutsch_c1_hochschule_handbuch.pdf).

Generation uses the existing exam envelope, including profile/version, generation ID and adaptation metadata. `content.questions` contains two objects with `questionId`, `title`, `communicativeSituation`, `taskInstructions` and `writingCoachTaskType`. There is no answer key. Structural validation rejects malformed topics, duplicate identifiers/text and additional fields that could expose model answers. Semantic verification checks distinctness, clarity, answerability, general academic knowledge, C1 suitability and answer leakage. Failed verification triggers bounded repair/regeneration before exposure.

## Shared evaluator and response

The existing `writing_coach.analyse_writing` accepts optional exam context. The adapter supplies the selected topic's complete instructions, profile, level and rubric dimensions. Generic calls keep their existing behavior. Learner essays never enter the generated-task semantic verifier.

`POST /api/ai/german-exam/grade-writing` returns:

```text
{ analysis, rubric, scoreValue, maxScoreValue, examResultItems }
```

`analysis` retains the Writing Coach's strengths, quoted examples, explanations, suggestions and structure feedback. The rubric maps taskFulfillment, grammar, vocabulary and average(structure, style) to the four dimensions. Their equal-weight mean is scaled to 48 points. This continuous AI practice estimate is explicitly labelled; it is not an official examiner's categorical telc rating. Missing scores remain null.

## Persistence and weaknesses

The frontend forwards scored dimension items to the existing results endpoint. Each attempt stores a dimension score out of 100, its skill tags, profile/version and generation ID, plus `metadata.rubric`, `metadata.rubricDimension` and `metadata.selectedTopic`. The persistence service forces writing's `first_attempt_correct` and `final_correct` to null. Unscorable dimensions do not create attempts. Writing attempts use stable UUIDs scoped to user, profile, generation and dimension, with conflict-ignore upserts so save retries cannot double-count weaknesses. No schema migration is needed: the existing attempts table already supports these nullable fields, numeric scores and UUID primary key.

Writing weakness scores derive from dimension score/max-score ratios and tags. The writing workspace requests its Weak Areas snapshot after saving completes; three observations per tag are required before showing a reliable signal. Subsequent generation uses those weaknesses within the blueprint's four permitted adaptation axes, while retaining C1 and the two-topic structure.

## Workspace

The existing Writing Coach editor and feedback rendering serve both modes. Supported profiles open generated Schreiben; Freies Schreiben remains available. Exam mode hides generic task/level controls, displays Thema A/B, requires selection, counts words live, and locks the selected topic during grading. It preserves the submitted text and puts optional rewritten versions behind a disclosure. Failed saves retain the grade and offer a save-only retry. Repeated opens/profile notifications share one generation request. Unsupported profiles continue using generic Writing Coach.

## Verification and limits

- Full Python suite: 1,852 passed, 8 skipped. After adding save idempotency, all 13 persistence tests passed, including its new regression.
- Unit suite: 686 passed, including behavioral tests for delayed profile loading, mode controls, selected-task submission, save retry ordering and generic compatibility.
- Frontend, backend and Pages Functions TypeScript checks passed.
- Python application pyright passed with no errors or warnings.
- Frontend compilation passed.

No live paid model call, deployed database write, browser visual QA or deployment verification was performed in this session. Semantic quality is covered with deterministic mocked verdicts; production model quality still requires sampling. Existing client-reported attempt persistence is retained. Sprechen is outside this phase.
