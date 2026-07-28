import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const { documentTypeMeta, badgeHtml, correctionSelectHtml, normalizeDocumentFileName } = await import(
  '../../frontend/js/features/courses/document-type-badge.ts'
);

test('high-confidence classifier → High badge, no review', () => {
  const m = documentTypeMeta({ effective_document_type: 'exam', document_type_confidence: 0.95 });
  assert.equal(m.label, 'Exam');
  assert.equal(m.confidenceLabel, 'High');
  assert.equal(m.needsReview, false);
  assert.ok(badgeHtml({ effective_document_type: 'exam', document_type_confidence: 0.95 })
    .includes('Detected source type: Exam · Confidence: High'));
});

test('medium confidence is labelled Medium and not review', () => {
  const m = documentTypeMeta({ effective_document_type: 'lecture', document_type_confidence: 0.7 });
  assert.equal(m.confidenceLabel, 'Medium');
  assert.equal(m.needsReview, false);
});

test('low confidence → needsReview + correction selector rendered', () => {
  const doc = { id: 'd1', effective_document_type: 'exam', document_type_confidence: 0.4 };
  const m = documentTypeMeta(doc);
  assert.equal(m.needsReview, true);
  const sel = correctionSelectHtml(doc);
  assert.ok(sel.includes('>File type</label>'));
  assert.ok(sel.includes('data-doc-id="d1"'));
  assert.ok(sel.includes('<option value="exam" selected>Exam</option>'));
});

test('unknown type needs review', () => {
  const m = documentTypeMeta({ id: 'd', effective_document_type: 'unknown', document_type_confidence: 0 });
  assert.equal(m.needsReview, true);
  assert.equal(m.label, 'Unknown');
});

test('user override → "you set this", no confidence, no review', () => {
  const doc = {
    id: 'd', effective_document_type: 'solution_sheet',
    user_document_type_override: 'solution_sheet', document_type_confidence: 0.2,
  };
  const m = documentTypeMeta(doc);
  assert.equal(m.userSet, true);
  assert.equal(m.needsReview, false);
  assert.equal(m.confidenceLabel, '');
  assert.ok(badgeHtml(doc).includes('Source type: Solution (you set this)'));
  assert.ok(correctionSelectHtml(doc).includes('value="solution_sheet" selected'));
  assert.ok(correctionSelectHtml(doc).includes('Use detected type'));
});

test('cheat_sheet and formula_sheet share one label', () => {
  assert.equal(documentTypeMeta({ effective_document_type: 'cheat_sheet', document_type_confidence: 0.9 }).label,
    'Cheat sheet / Formula sheet');
  assert.equal(documentTypeMeta({ effective_document_type: 'formula_sheet', document_type_confidence: 0.9 }).label,
    'Cheat sheet / Formula sheet');
});

test('correction selector empty without an id', () => {
  assert.equal(correctionSelectHtml({ effective_document_type: 'unknown', document_type_confidence: 0 }), '');
});

test('high-confidence documents still render an editable picker', () => {
  const html = correctionSelectHtml({
    id: 'd2', document_type: 'lecture', effective_document_type: 'lecture',
    document_type_confidence: 0.99,
  });
  assert.ok(html.includes('class="doc-type-select study-file-type-select"'));
  assert.ok(html.includes('value="lecture" selected'));
  assert.ok(html.includes('Use detected type (Lecture)'));
});

test('picker isolates parent-card events and contains rollback handling', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../../frontend/js/features/courses/document-type-badge.ts', import.meta.url), 'utf8'
  );
  assert.match(source, /\['click', 'pointerdown', 'mousedown', 'keydown'\]/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /sel\.value = previous/);
  assert.match(source, /document-type-changed/);
});

test('document matching handles folder prefixes, URL encoding, and Unicode consistently', () => {
  assert.equal(normalizeDocumentFileName('Vorlesung\\Formelsammlung%20WS.pdf'), 'formelsammlung ws.pdf');
  assert.equal(normalizeDocumentFileName('  FORMELSAMMLUNG WS.PDF  '), 'formelsammlung ws.pdf');
});

test('file-card decoration is not restricted to ready documents', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../../frontend/js/features/courses/document-type-badge.ts', import.meta.url), 'utf8'
  );
  assert.doesNotMatch(source, /doc\.processing_status !== 'ready'/);
  assert.match(source, /unavailablePickerHtml/);
});
