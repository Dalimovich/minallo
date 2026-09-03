import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pdfCourseSections } from '../../frontend/js/features/pdf-viewer/pdf-tabs.ts';

test('PDF tabs use hydrated active-course folders when the registry copy is empty', () => {
  const registryCourse = {
    id: 'uc_1777906910748',
    name: 'Fertigungstechnik',
    files: [],
    userFolders: [],
  };
  const activeCourse = {
    id: registryCourse.id,
    name: registryCourse.name,
    files: [],
    userFolders: [
      { name: 'Exams', files: [{ name: 'exam.pdf' }] },
      { name: 'Lectures', files: [{ name: 'lecture.pdf' }] },
      { name: 'Exercises', files: [{ name: 'exercise.pdf' }] },
    ],
  };

  const sections = pdfCourseSections(activeCourse, [{ courses: [registryCourse] }]);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].course, activeCourse);
  assert.deepEqual(
    sections[0].files.map((file) => [file.name, file._folder]),
    [
      ['exam.pdf', 'Exams'],
      ['lecture.pdf', 'Lectures'],
      ['exercise.pdf', 'Exercises'],
    ],
  );
});

test('PDF tabs keep the richer registry copy if it finishes loading later', () => {
  const activeCourse = { id: 'course-1', name: 'Course', files: [], userFolders: [] };
  const registryCourse = {
    ...activeCourse,
    userFolders: [{ name: 'Documents', files: [{ name: 'loaded.pdf' }] }],
  };

  const sections = pdfCourseSections(activeCourse, [{ courses: [registryCourse] }]);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].course, registryCourse);
  assert.equal(sections[0].files[0].name, 'loaded.pdf');
});
