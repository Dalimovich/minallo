# Learner Files

The learner workspace has one flat document library, separate from student
Courses and SEMS. Generated German Exam Engine tasks remain independent of it.

## File-grounded flows

- Reading: "From my files", selected-document reading exercise generation.
- Grammar: "From my files", text topic detection, selected-document exercises.
- Vocabulary: "From my files", selected-document exercises.
- General practice file list: Open, Delete, Quiz, and Explain.
- File-based quiz and flashcard source selection and generation.
- Upload controls in Files and the older Practice upload surface.

All of these read `frontend/js/features/german/learner-files.ts`. Practice uses
document identity and the original storage location, including legacy folders,
rather than filenames alone or the global active university course. Saved
quizzes and cards keep their existing skill-specific persistence keys.

## Service

`listLearnerFiles`, `getLearnerFile`, `uploadLearnerFile`, `readLearnerFile`,
`openLearnerFile`, `deleteLearnerFile`, `getLearnerFileStorageScope`,
`indexLearnerFile`, and `refreshLearnerFile` centralize file access.

New uploads always use `german-files` within the existing `course-uploads`
storage bucket. Reads also include `german-general`, `german-reading`,
`german-listening`, `german-sprachbausteine`, `german-writing`,
`german-speaking`, `german-vocab`, `german-grammar`, `german-sentences`, and
`german-games`. Indexed files are deduplicated by document ID. Legacy objects
are not moved; reads, explicit deletion, and indexing retries use their original
scope. File operations do not assign `activeCourseId` or `activeCourseRef`.

The Files uploader renders immediately, shares one picker/drop handler, queues
two uploads at a time per batch, and preserves pending rows during hydration.
Upload and indexing failures have separate retry actions. PDF readiness is
confirmed against document status, not just the indexing-start response.

The existing backend indexes PDFs only. Other supported formats remain uploaded
and openable; text files also work in file-grounded practice. Reading, Grammar,
Vocabulary, and Quiz/Explain retain their existing PDF/text generation support.
Opening a learner document uses a separate browser tab, keeping university
course and embedded course-viewer state untouched.

## Verification

- `node scripts/run-unit-tests.mjs`
- `npm run build`
- `node tests/reliability/browser-learner-files.mjs`

The browser check expects a frontend server at `http://localhost:5177` (override
with `E2E_BASE_URL`). It uses the real Files modules and CSS with deterministic
storage/API fixtures, and the production file-picker rendering functions. It
covers desktop/mobile layouts, slow hydration, native picker, multi-file drop,
upload/indexing retries, shared pickers, open/delete, fresh listing, empty state,
and university course isolation. It does not perform live AI generation or
write to a production account.
