import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNotesFileNameFromText,
  pickExplicitNotesCandidate,
} from '../../frontend/js/features/chatbot-new/notes-intent-resolver.ts';

// These are REAL executions of the pure matching logic (not source-text
// inspection) — they exercise the exact reported bug scenario: the user
// replies with the literal filename copied from the clarification list.
const COURSE_FILES = [
  'Zusammenfassung_ME_4_Schnappverbindungen.pdf',
  'Zusammenfassung_ME_3_Getriebe.pdf',
  'Zusammenfassung_ME_2_Lager.pdf',
  'Zusammenfassung_ME_1_WNV.pdf',
  'Zusammenfassung_GdK_safe.pdf',
  'Klausur_H2019_IK-Teil_Aufgaben_mit_Ergebnissen.pdf',
  'Klausur_F2019_IK-Teil_Aufgaben_mit_Ergebnissen.pdf',
  'GdK_F2026_Formelzettel_IK-IFL.pdf',
];

test('an exact filename reply (copied from the clarification list) resolves to that file', () => {
  const resolved = resolveNotesFileNameFromText(COURSE_FILES, 'Zusammenfassung_ME_3_Getriebe.pdf');
  assert.equal(resolved, 'Zusammenfassung_ME_3_Getriebe.pdf');
});

test('matching is case-insensitive and tolerant of stray quoting', () => {
  assert.equal(
    resolveNotesFileNameFromText(COURSE_FILES, 'zusammenfassung_me_3_getriebe.pdf'),
    'Zusammenfassung_ME_3_Getriebe.pdf'
  );
  assert.equal(
    resolveNotesFileNameFromText(COURSE_FILES, '"Zusammenfassung_ME_3_Getriebe.pdf"'),
    'Zusammenfassung_ME_3_Getriebe.pdf'
  );
});

test('a filename typed without the .pdf extension still matches', () => {
  assert.equal(
    resolveNotesFileNameFromText(COURSE_FILES, 'Zusammenfassung_ME_3_Getriebe'),
    'Zusammenfassung_ME_3_Getriebe.pdf'
  );
});

test('a sentence naming the file ("make notes from X") still resolves via substring match', () => {
  assert.equal(
    resolveNotesFileNameFromText(COURSE_FILES, 'make notes from Zusammenfassung_ME_3_Getriebe.pdf'),
    'Zusammenfassung_ME_3_Getriebe.pdf'
  );
});

test('an unrelated reply matches nothing, so the pending flow can be abandoned', () => {
  assert.equal(resolveNotesFileNameFromText(COURSE_FILES, 'never mind, what is 2+2?'), null);
  assert.equal(resolveNotesFileNameFromText(COURSE_FILES, ''), null);
});

test('similarly-prefixed files are not confused with each other', () => {
  // Regression guard: ME_3 and ME_4 share a long common prefix
  // ("Zusammenfassung_ME_"), so a naive prefix/substring match in the wrong
  // direction could return the wrong file.
  assert.equal(
    resolveNotesFileNameFromText(COURSE_FILES, 'Zusammenfassung_ME_4_Schnappverbindungen.pdf'),
    'Zusammenfassung_ME_4_Schnappverbindungen.pdf'
  );
});

test('explicit filename in the same turn (route.sourcePhrase) wins over selection and active PDF', () => {
  const route = { explicitSourceReference: true, sourcePhrase: 'Zusammenfassung_ME_3_Getriebe.pdf' };
  const candidate = pickExplicitNotesCandidate(
    route,
    ['lib-item-1'],
    [{ id: 'lib-item-1', courseId: 'course-1', documents: [{ name: 'Zusammenfassung_ME_1_WNV.pdf' }] }],
    { courseId: 'course-1', fileName: 'Zusammenfassung_ME_2_Lager.pdf' },
    'course-1'
  );
  assert.equal(candidate, 'Zusammenfassung_ME_3_Getriebe.pdf');
});

test('a generic sourcePhrase like "open_document" is ignored so selection/active-PDF still apply', () => {
  const route = { explicitSourceReference: true, sourcePhrase: 'open_document' };
  const candidate = pickExplicitNotesCandidate(
    route, [], [],
    { courseId: 'course-1', fileName: 'Zusammenfassung_ME_2_Lager.pdf' },
    'course-1'
  );
  assert.equal(candidate, 'Zusammenfassung_ME_2_Lager.pdf');
});

test('exactly one explicitly selected Course file wins over the active PDF', () => {
  const route = { explicitSourceReference: false };
  const candidate = pickExplicitNotesCandidate(
    route,
    ['lib-item-1'],
    [{ id: 'lib-item-1', courseId: 'course-1', documents: [{ name: 'Zusammenfassung_ME_1_WNV.pdf' }] }],
    { courseId: 'course-1', fileName: 'Zusammenfassung_ME_2_Lager.pdf' },
    'course-1'
  );
  assert.equal(candidate, 'Zusammenfassung_ME_1_WNV.pdf');
});

test('multiple selected Course files are ambiguous, so the active PDF is used instead', () => {
  const route = { explicitSourceReference: false };
  const candidate = pickExplicitNotesCandidate(
    route,
    ['lib-item-1'],
    [{
      id: 'lib-item-1', courseId: 'course-1',
      documents: [{ name: 'Zusammenfassung_ME_1_WNV.pdf' }, { name: 'Zusammenfassung_ME_2_Lager.pdf' }],
    }],
    { courseId: 'course-1', fileName: 'Zusammenfassung_ME_3_Getriebe.pdf' },
    'course-1'
  );
  assert.equal(candidate, 'Zusammenfassung_ME_3_Getriebe.pdf');
});

test('the active PDF is ignored when it belongs to a different course', () => {
  const route = { explicitSourceReference: false };
  const candidate = pickExplicitNotesCandidate(
    route, [], [],
    { courseId: 'other-course', fileName: 'Zusammenfassung_ME_2_Lager.pdf' },
    'course-1'
  );
  assert.equal(candidate, undefined);
});

test('no explicit signal at all yields undefined, deferring to the caller\'s remaining fallbacks', () => {
  const route = { explicitSourceReference: false };
  assert.equal(pickExplicitNotesCandidate(route, [], [], null, 'course-1'), undefined);
});
