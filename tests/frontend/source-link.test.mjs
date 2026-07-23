import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};

const { normalizeSourceFileName, sourceFileNameSimilarity, resolveCourseFile } = await import(
  '../../frontend/js/features/pdf-viewer/source-link.ts'
);

test('source filename normalization tolerates paths, accents, and punctuation', () => {
  assert.equal(normalizeSourceFileName('folder/Übung 2.pdf'), 'ubung2pdf');
});

test('lossy indexed German filename resolves to the real course PDF', () => {
  const real = { name: 'Übung_2_-_Spritzgießen_mit_Lösung.pdf', _storageName: 'stored.pdf' };
  const unrelated = { name: 'Kapitel_2_Urformen.pdf', _storageName: 'other.pdf' };
  const course = { files: [real, unrelated], userFolders: [] };
  const cited = 'bung_2_-_Spritzgie_en_mit_L_sung.pdf';
  assert.ok(sourceFileNameSimilarity(real.name, cited) >= 0.72);
  assert.equal(resolveCourseFile(course, cited), real);
});

test('weak or ambiguous citation names do not open an unrelated PDF', () => {
  const course = { files: [{ name: 'Lecture_1.pdf' }, { name: 'Lecture_2.pdf' }], userFolders: [] };
  assert.equal(resolveCourseFile(course, 'Lecture.pdf'), null);
});
