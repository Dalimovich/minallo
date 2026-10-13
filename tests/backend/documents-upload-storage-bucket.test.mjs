import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Regression for a confirmed production bug (2026-10-13 QA): documents-upload.ts
// stored a BARE storage_path, relying on this Cloudflare Function's
// RAG_STORAGE_BUCKET and python-ai's own independently-configured default
// agreeing on the same bucket name. They didn't — every upload reported
// success (201, indexingStarted: true) while the object landed in a bucket
// indexing never looked in, so processing_status always flipped to 'failed'
// with a storage 404. The fix embeds the bucket this request actually wrote
// to as a `<bucket>:` prefix (the same convention chat-attachments.ts
// already uses, and the exact format storage.py's _resolve_bucket_and_path
// and documents-delete.ts's bucket parsing already expect) so the two
// services can never disagree on where the file is.
const endpoint = fs.readFileSync('backend/functions/documents-upload.ts', 'utf8');

test('the stored/forwarded document path is bucket-qualified, not bare', () => {
  assert.match(endpoint, /const durableStoragePath = `\$\{STORAGE_BUCKET\}:\$\{storagePath\}`/);
  assert.match(endpoint, /storage_path:\s*durableStoragePath/);
});

test('the raw storage write itself still uses the bare path (bucket is separate in that call)', () => {
  assert.match(endpoint, /uploadToStorage\(serviceKey, storagePath, fileBuffer, mimeType\)/);
});

test('the idempotent-conflict lookup filters on the SAME bucket-qualified value that was actually inserted', () => {
  const insert = endpoint.indexOf('storage_path: durableStoragePath');
  const lookup = endpoint.indexOf("'&storage_path=eq.' + encodeURIComponent(durableStoragePath)");
  assert.ok(insert >= 0 && lookup > insert, 'conflict lookup must come after the insert and reference the same durable path');
});

test('indexing is kicked off with the bucket-qualified path, not the bare one', () => {
  assert.match(endpoint, /storagePath:\s*durableStoragePath\s*\n\s*\}\);/);
  assert.doesNotMatch(endpoint, /forwardToPython\('index-document', \{\s*userId: user\.id, courseId, documentId: document\.id, storagePath\s*\}\)/);
});
