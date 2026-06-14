import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKABLE_STATES,
  topicsForDocuments,
  selectMarkableTopics,
  candidateRevertTopics,
  topicsToRevert,
} from '../../backend/lib/study-done-files-logic.ts';

// ── topicsForDocuments ────────────────────────────────────────────────────────

const TOPICS = [
  { id: 'tA', source_document_ids: ['doc1', 'doc2'] },
  { id: 'tB', source_document_ids: ['doc2'] },
  { id: 'tC', source_document_ids: ['doc3'] },
  { id: 'tNull', source_document_ids: null }, // unprofiled / no docs
];

test('topicsForDocuments maps docs to covering topics and reports mapped docs', () => {
  const { topicIds, docsWithTopics } = topicsForDocuments(TOPICS, ['doc1', 'doc4']);
  assert.deepEqual(topicIds, ['tA']);
  assert.deepEqual([...docsWithTopics], ['doc1']); // doc4 maps to nothing
});

test('topicsForDocuments dedups topics across multiple matched docs', () => {
  const { topicIds, docsWithTopics } = topicsForDocuments(TOPICS, ['doc1', 'doc2']);
  assert.deepEqual(topicIds.sort(), ['tA', 'tB']);
  assert.deepEqual([...docsWithTopics].sort(), ['doc1', 'doc2']);
});

test('topicsForDocuments returns empty when no doc maps (file without topic links)', () => {
  const { topicIds, docsWithTopics } = topicsForDocuments(TOPICS, ['doc9']);
  assert.deepEqual(topicIds, []);
  assert.equal(docsWithTopics.size, 0);
});

// ── selectMarkableTopics (no downgrade / promote in_progress) ──────────────────

test('MARKABLE_STATES promotes only not_started/in_progress/no-row', () => {
  assert.ok(MARKABLE_STATES.has(''));
  assert.ok(MARKABLE_STATES.has('not_started'));
  assert.ok(MARKABLE_STATES.has('in_progress'));
  assert.ok(!MARKABLE_STATES.has('studied'));
  assert.ok(!MARKABLE_STATES.has('weak'));
  assert.ok(!MARKABLE_STATES.has('practiced'));
  assert.ok(!MARKABLE_STATES.has('mastered'));
});

test('selectMarkableTopics writes onto no-row, not_started and in_progress', () => {
  const state = new Map([
    ['t2', 'not_started'],
    ['t3', 'in_progress'],
    // t1 absent → no row → '' → markable
  ]);
  assert.deepEqual(selectMarkableTopics(['t1', 't2', 't3'], state).sort(), ['t1', 't2', 't3']);
});

test('selectMarkableTopics never downgrades studied/weak/practiced/mastered', () => {
  const state = new Map([
    ['s', 'studied'],
    ['w', 'weak'],
    ['p', 'practiced'],
    ['m', 'mastered'],
    ['n', 'not_started'],
  ]);
  assert.deepEqual(selectMarkableTopics(['s', 'w', 'p', 'm', 'n'], state), ['n']);
});

// ── candidateRevertTopics ─────────────────────────────────────────────────────

test('candidateRevertTopics picks topics covered only by removed files', () => {
  // tA covered by doc1(removed)+doc2 ; tB by doc2 ; tC by doc3(removed)
  const { ids, docsById } = candidateRevertTopics(
    TOPICS,
    new Set(['doc1', 'doc3']), // removed
    new Set(['doc2'])          // still done
  );
  // tA is still covered by doc2 (still done) → not a candidate; tC only by doc3 → candidate
  assert.deepEqual(ids, ['tC']);
  assert.deepEqual(docsById.get('tC'), ['doc3']);
});

test('candidateRevertTopics returns all removed-only topics when nothing still done', () => {
  const { ids } = candidateRevertTopics(TOPICS, new Set(['doc1', 'doc2', 'doc3']), new Set());
  assert.deepEqual(ids.sort(), ['tA', 'tB', 'tC']);
});

// ── topicsToRevert (provenance) ───────────────────────────────────────────────

test('topicsToRevert keeps topics protected by a task_completed event', () => {
  const docsById = new Map([['t1', ['doc1']], ['t2', ['doc2']]]);
  const out = topicsToRevert(['t1', 't2'], docsById, new Set(['t1']), new Set());
  assert.deepEqual(out, ['t2']); // t1 earned via event → kept
});

test('topicsToRevert keeps topics whose file was worked in a completed task', () => {
  const docsById = new Map([['t1', ['docX']], ['t2', ['docY']]]);
  // completedFiles can include exercise/solution ids, not just lectures
  const out = topicsToRevert(['t1', 't2'], docsById, new Set(), new Set(['docY']));
  assert.deepEqual(out, ['t1']); // t2 covered by a completed task's file → kept
});

test('topicsToRevert reverts only topics with no completion evidence', () => {
  const docsById = new Map([['t1', ['d1']], ['t2', ['d2']], ['t3', ['d3']]]);
  const out = topicsToRevert(
    ['t1', 't2', 't3'],
    docsById,
    new Set(['t1']),       // earned event
    new Set(['d2'])        // completed-task file
  );
  assert.deepEqual(out, ['t3']);
});
