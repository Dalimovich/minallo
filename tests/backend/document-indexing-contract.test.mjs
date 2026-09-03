import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const endpoint = fs.readFileSync('backend/functions/documents-index-existing.ts', 'utf8');
const courseFiles = fs.readFileSync('frontend/js/features/courses/course-files.ts', 'utf8');
const courseFolders = fs.readFileSync('frontend/js/features/courses/course-folders.ts', 'utf8');
const documentList = fs.readFileSync('backend/functions/documents-list.ts', 'utf8');

test('index-existing reports and persists an indexing-start failure', () => {
  assert.match(endpoint, /code:\s*'uploaded_not_indexed'/);
  assert.match(endpoint, /processing_status:\s*'failed'/);
  assert.match(endpoint, /indexingStarted:\s*false/);
});

test('course upload cannot silently discard indexing failures or mark failed docs ready', () => {
  assert.doesNotMatch(courseFiles, /indexExistingDocument\([\s\S]{0,400}?\.catch\(\(\) => \{\}\)/);
  assert.match(courseFiles, /modal\.markFailed\(/);
  assert.match(courseFiles, /if \(failedFiles\.length\)/);
  assert.match(courseFiles, /d\?\.page_count/);
  assert.match(courseFiles, /d\?\.chunk_count/);
  assert.match(documentList, /page_count,chunk_count/);
  assert.doesNotMatch(courseFolders, /indexExistingDocument\([\s\S]{0,400}?\.catch\(\(\) => \{\}\)/);
});
