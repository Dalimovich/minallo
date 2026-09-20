# German Exam Engine — one exam = one file

Exam-specific facts live in `backend/python-ai/app/services/german_exams/<exam>.py`
(`telc_c1_hochschule.py`, `goethe_c1.py`, …): modules, parts, task types, official
constraints, timings, scoring, grading dimensions, allowed skills/adaptations, source
metadata, profile version. `registry.py` only assembles them; `shared.py` holds the generic
types (`ExamProfile`, `PartBlueprint`, `ScoringSpec`, `ModuleSpec`); `scoring.py` the generic
receptive scoring (`fixed_per_item` / `lookup_table` / `rubric`); `manifest.py` the
serialisable manifest the frontend builds the exam workspace from.

Reusable behaviour (generation / validation / rendering / grading) is keyed by
`PartBlueprint.task_type` — never by exam. `task_types.py` says which task types exist; a part
also carries `available=False` until it can be generated (it then shows in the navigation and
fails cleanly with 501).

## Adding an exam
1. New `german_exams/<exam>.py` exporting an `ExamProfile`; register it in `registry.py`.
2. Mirror only `(profileId, family, legacy levels)` in `backend/lib/german-learner-profile.ts`
   and `frontend/js/features/auth/german-profile.ts` (parity is tested).
3. `tests/test_german_exam_profile_<exam>.py` for its exact structure.
4. Regenerate the E2E manifest fixture:
   `UPDATE_MANIFEST_FIXTURE=1 pytest tests/test_german_exam_scoring_manifest.py`.
5. Reuse an existing task type only when the interaction is genuinely identical; otherwise add
   a new generic task type (named for the task, not the exam).

Edge functions do not keep module/part allowlists: they check `(profile → module → part)`
against the cached manifest (`backend/lib/german-exam-manifest.ts`); python-ai remains the
authority (`get_part`).
