import test from 'node:test';
import assert from 'node:assert/strict';
import { runNotesFlow, NOTES_FALLBACK_MAX_PAGES } from '../../frontend/js/features/chatbot-new/notes-intent-flow.ts';

// Real executions of the full two-turn Notes flow with mock/spy
// dependencies — this is the behavioral proof the static-source-inspection
// tests couldn't give: it fails if the second turn ever reaches the point
// of NOT calling the Notes generator, or if generation is ever attempted
// more than once, or if a >20-page document silently falls back to raw
// extraction when an indexed document is available.

const COURSE_FILES = [
  'Zusammenfassung_ME_4_Schnappverbindungen.pdf',
  'Zusammenfassung_ME_3_Getriebe.pdf',
  'Zusammenfassung_ME_2_Lager.pdf',
];

function makeDeps(overrides = {}) {
  const calls = {
    resolveDocument: [],
    extractPdfText: [],
    generateNotes: [],
    onNoteSaved: [],
    onFileResolved: [],
  };
  const deps = {
    getCourseFiles: () => COURSE_FILES,
    resolveDocument: async (courseId, fileName) => {
      calls.resolveDocument.push({ courseId, fileName });
      return { documentId: null, ready: false };
    },
    extractPdfText: async (fileName, maxPages) => {
      calls.extractPdfText.push({ fileName, maxPages });
      return 'extracted pdf text';
    },
    generateNotes: async (courseId, opts) => {
      calls.generateNotes.push({ courseId, opts });
      return { note: { id: 'note-123', content_markdown: '# Notes body' } };
    },
    onNoteSaved: (courseId) => calls.onNoteSaved.push(courseId),
    onFileResolved: (fileName) => calls.onFileResolved.push(fileName),
    ...overrides,
  };
  return { deps, calls };
}

test('turn 1 ("create a note") with multiple files sets a pending action and never generates', async () => {
  const { deps, calls } = makeDeps();

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'create a note',
    pendingNotesAction: null,
    now: 1000,
    ttlMs: 600_000,
  }, deps);

  assert.match(outcome.text, /Which file should I make notes from\?/);
  assert.deepEqual(outcome.pendingNotesAction, { courseId: 'course-1', createdAt: 1000 });
  assert.equal(outcome.generationAttempted, false);
  assert.equal(calls.generateNotes.length, 0);
  assert.equal(calls.resolveDocument.length, 0);
  assert.equal(calls.extractPdfText.length, 0);
  // The clarification carries the exact file list separately from the
  // rendered text, so a caller can render it as clickable choices — see
  // renderNotesFileChooser in shell.ts.
  assert.deepEqual(outcome.clarifyFiles, COURSE_FILES);
});

test('turn 2 (bare filename reply) resumes generation exactly once and clears the pending action', async () => {
  const { deps, calls } = makeDeps();

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  // This is the exact reported bug: the second turn must reach the Notes
  // generator, not a generic assistant answer.
  assert.equal(calls.generateNotes.length, 1);
  assert.equal(calls.generateNotes[0].opts.fileName, 'Zusammenfassung_ME_3_Getriebe.pdf');
  assert.equal(calls.onFileResolved[0], 'Zusammenfassung_ME_3_Getriebe.pdf');
  assert.equal(calls.onNoteSaved.length, 1);
  assert.equal(calls.onNoteSaved[0], 'course-1');
  assert.equal(outcome.pendingNotesAction, null);
  assert.equal(outcome.noteId, 'note-123');
  assert.match(outcome.text, /Notes from Zusammenfassung_ME_3_Getriebe\.pdf \(saved to your Notes tab\)/);
  assert.match(outcome.text, /# Notes body/);
});

test('a single-turn explicit command ("make notes from X.pdf") generates directly, no clarification round-trip', async () => {
  const { deps, calls } = makeDeps();

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'make notes from Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: null,
    now: 1000,
    ttlMs: 600_000,
    explicitCandidate: 'Zusammenfassung_ME_3_Getriebe.pdf',
  }, deps);

  assert.equal(calls.generateNotes.length, 1);
  assert.equal(calls.generateNotes[0].opts.fileName, 'Zusammenfassung_ME_3_Getriebe.pdf');
  assert.equal(outcome.pendingNotesAction, null);
  assert.equal(outcome.noteId, 'note-123');
});

test('an unrelated reply during a pending clarification abandons it without touching generation at all', async () => {
  const { deps, calls } = makeDeps();

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'never mind, what is the capital of France?',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  assert.equal(outcome.text, '');
  assert.equal(outcome.generationAttempted, false);
  assert.equal(outcome.pendingNotesAction, null);
  assert.equal(calls.generateNotes.length, 0);
  assert.equal(calls.resolveDocument.length, 0);
  assert.equal(calls.extractPdfText.length, 0);
});

test('an expired pending action is not resumed by a later filename-shaped reply', async () => {
  const { deps, calls } = makeDeps();

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 1000 + 700_000, // past the 600_000ms TTL
    ttlMs: 600_000,
  }, deps);

  // Falls through as a fresh command with no explicit candidate — with 3
  // files available it's ambiguous, so it re-asks rather than silently
  // guessing or reusing the stale pending courseId.
  assert.match(outcome.text, /Which file should I make notes from\?/);
  assert.equal(calls.generateNotes.length, 0);
});

test('a document with a ready indexed id skips raw PDF extraction entirely — no page cap applies', async () => {
  const { deps, calls } = makeDeps({
    resolveDocument: async (courseId, fileName) => {
      calls.resolveDocument.push({ courseId, fileName });
      return { documentId: 'doc-abc', ready: true };
    },
  });

  await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  // This is the >20-page regression guard: an indexed, ready document must
  // go straight to the backend's chunk-based path (empty pdfText, real
  // documentId) — extractPdfText must never be called, so a 70-page lecture
  // can never be silently truncated to the old 20-page client-side cap.
  assert.equal(calls.extractPdfText.length, 0);
  assert.equal(calls.generateNotes[0].opts.documentId, 'doc-abc');
  assert.equal(calls.generateNotes[0].opts.pdfText, '');
});

test('a document with no ready indexed id falls back to extraction with no page cap at all', async () => {
  const { deps, calls } = makeDeps();

  await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  assert.equal(calls.extractPdfText.length, 1);
  assert.equal(calls.extractPdfText[0].maxPages, NOTES_FALLBACK_MAX_PAGES);
  assert.ok(NOTES_FALLBACK_MAX_PAGES > 20, 'the fallback cap must not silently reintroduce the 20-page bug');
  assert.equal(calls.generateNotes[0].opts.documentId, null);
  assert.equal(calls.generateNotes[0].opts.pdfText, 'extracted pdf text');
});

test('a persistence failure (generated but not saved) never calls onNoteSaved and never claims success', async () => {
  const { deps, calls } = makeDeps({
    generateNotes: async (courseId, opts) => {
      calls.generateNotes.push({ courseId, opts });
      // Mirrors the backend contract after the persist_failed fix: content
      // exists, but the DB insert failed and note.id is null.
      return { error: 'persist_failed', note: { id: null, content_markdown: '# Notes body' } };
    },
  });

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  assert.equal(calls.onNoteSaved.length, 0);
  assert.equal(outcome.noteId, undefined);
  assert.doesNotMatch(outcome.text, /saved to your Notes tab/);
  assert.match(outcome.text, /could not be saved/);
  // Not re-asked as if it were still ambiguous — it's a generation/persist
  // failure, not a missing-source state.
  assert.equal(outcome.pendingNotesAction, null);
});

test('a null note id without an explicit persist_failed error is still treated as a failure, never a false success', async () => {
  const { deps } = makeDeps({
    generateNotes: async () => ({ note: { id: null, content_markdown: '# Notes body' } }),
  });

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'Zusammenfassung_ME_3_Getriebe.pdf',
    pendingNotesAction: { courseId: 'course-1', createdAt: 1000 },
    now: 5000,
    ttlMs: 600_000,
  }, deps);

  assert.doesNotMatch(outcome.text, /saved to your Notes tab/);
});

test('exactly one file in the course generates without asking, even with no explicit candidate', async () => {
  const { deps, calls } = makeDeps({ getCourseFiles: () => ['OnlyFile.pdf'] });

  const outcome = await runNotesFlow({
    courseId: 'course-1',
    latestText: 'create a note',
    pendingNotesAction: null,
    now: 1000,
    ttlMs: 600_000,
  }, deps);

  assert.equal(calls.generateNotes.length, 1);
  assert.equal(calls.generateNotes[0].opts.fileName, 'OnlyFile.pdf');
  assert.equal(outcome.pendingNotesAction, null);
});
