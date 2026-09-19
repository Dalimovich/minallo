import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

// The VM intentionally cannot import the document API. Exercise the real
// local catalog fallback, so API fixtures cannot conceal folder lookup bugs.
test('Notes finds nested course files across semesters despite a partial active course', async () => {
  const runtime = shellRuntime(
    {
      window: {
        activeCourseRef: { id: 'mechanics', files: [] },
        activeSemesterId: 'new-semester',
        SEMS: {
          'old-semester': {
            courses: [
              {
                id: 'mechanics',
                files: [{ name: 'Lecture.pdf' }],
                userFolders: [
                  {
                    name: 'Revision',
                    files: [
                      { name: 'Zusammenfassung_ME_1_WNV.pdf' },
                      { name: 'lecture.PDF' },
                      { name: 'readme.txt' }
                    ]
                  }
                ]
              }
            ]
          },
          'new-semester': {
            courses: [{ id: 'other-course', files: [{ name: 'Wrong-course.pdf' }] }]
          }
        }
      }
    },
    ['getCourseNotesFiles', 'listCourses', 'getSems', 'getActiveSemId']
  );
  assert.deepEqual(Array.from(await runtime.getCourseNotesFiles('mechanics')), [
    'Lecture.pdf',
    'Zusammenfassung_ME_1_WNV.pdf'
  ]);
});

test('Notes can use an active course before the semester tree has hydrated', async () => {
  const runtime = shellRuntime(
    {
      window: {
        activeCourseRef: {
          id: 'mechanics',
          userFolders: [{ name: 'Revision', files: [{ name: 'Revision.pdf' }] }]
        }
      }
    },
    ['getCourseNotesFiles', 'listCourses', 'getSems', 'getActiveSemId']
  );
  assert.deepEqual(Array.from(await runtime.getCourseNotesFiles('mechanics')), ['Revision.pdf']);
  assert.deepEqual(Array.from(await runtime.getCourseNotesFiles('other-course')), []);
});
