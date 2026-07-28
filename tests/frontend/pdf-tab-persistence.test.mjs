import { test } from 'node:test';
import assert from 'node:assert/strict';

import { persistablePdfFile } from '../../frontend/js/features/pdf-viewer/pdf-tab-persistence.ts';

test('PDF tab persistence strips circular course state', () => {
  const course = { id: 'c1', name: 'Mechanics', files: [] };
  const file = {
    name: 'lecture.pdf',
    _uploaded: true,
    _storageName: 'u/lecture.pdf',
    _folder: 'Week 1',
    _uid: 'user-1',
    _course: course,
    transientBytes: new Uint8Array([1, 2, 3]),
  };
  course.files.push(file);

  const safe = persistablePdfFile(file);
  assert.deepEqual(safe, {
    name: 'lecture.pdf',
    _uploaded: true,
    _storageName: 'u/lecture.pdf',
    _folder: 'Week 1',
    _uid: 'user-1',
  });
  assert.doesNotThrow(() => JSON.stringify(safe));
  assert.ok(!('_course' in safe));
});

test('bundled PDF tab keeps only its stable name', () => {
  assert.deepEqual(persistablePdfFile({ name: 'formula-sheet.pdf' }), {
    name: 'formula-sheet.pdf',
  });
});

