import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Minimal env so the module loads without throwing
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.OPENAI_API_KEY = 'sk-fake';

const { _testing } = require('../../backend/lib/study-pipeline.js');
const {
  parseJsonSafe,
  wordJaccard,
  deduplicateItems,
  normalizeGeneratedItems,
  textStudyScore,
  flashcardsSystemPrompt,
  quizSystemPrompt
} = _testing;

// ── parseJsonSafe ─────────────────────────────────────────────────────────────

test('parseJsonSafe: parses plain JSON', () => {
  const result = parseJsonSafe('{"items":[]}');
  assert.deepEqual(result, { items: [] });
});

test('parseJsonSafe: strips markdown code fence', () => {
  const result = parseJsonSafe('```json\n{"items":[]}\n```');
  assert.deepEqual(result, { items: [] });
});

test('parseJsonSafe: extracts embedded JSON object', () => {
  const result = parseJsonSafe('Here is the result: {"items":[{"a":1}]} done');
  assert.deepEqual(result, { items: [{ a: 1 }] });
});

test('parseJsonSafe: throws on non-JSON', () => {
  assert.throws(() => parseJsonSafe('not json at all'), /JSON/i);
});

// ── wordJaccard ───────────────────────────────────────────────────────────────

test('wordJaccard: identical strings return 1', () => {
  assert.equal(wordJaccard('the quick fox', 'the quick fox'), 1);
});

test('wordJaccard: completely different strings return 0', () => {
  assert.equal(wordJaccard('apple banana', 'orange grape'), 0);
});

test('wordJaccard: partial overlap returns value between 0 and 1', () => {
  const score = wordJaccard('what is Newton second law', 'what is Newton first law');
  assert.ok(score > 0 && score < 1, 'expected partial overlap score');
});

test('wordJaccard: empty strings return 0', () => {
  assert.equal(wordJaccard('', 'something'), 0);
});

// ── deduplicateItems ──────────────────────────────────────────────────────────

test('deduplicateItems: keeps unique items', () => {
  const items = [
    { question: 'What is Newton second law?' },
    { question: 'What is the Pythagorean theorem?' }
  ];
  assert.equal(deduplicateItems(items).length, 2);
});

test('deduplicateItems: removes near-duplicate questions', () => {
  const items = [
    { question: 'What is the definition of velocity in mechanics?' },
    { question: 'What is the definition of velocity in mechanics please explain' }
  ];
  assert.equal(deduplicateItems(items).length, 1);
});

test('deduplicateItems: removes near-duplicate flashcard fronts', () => {
  const items = [
    { front: 'Define kinetic energy in classical mechanics' },
    { front: 'Define kinetic energy in classical mechanics please' }
  ];
  assert.equal(deduplicateItems(items).length, 1);
});

test('deduplicateItems: keeps first of duplicates', () => {
  const items = [
    { question: 'What is Newton second law of motion?' },
    { question: 'What is Newton second law of motion in physics?' }
  ];
  const result = deduplicateItems(items);
  assert.equal(result[0].question, items[0].question);
});

test('normalizeGeneratedItems: fills missing quiz options with em-dash instead of dropping the item', () => {
  // The pipeline intentionally recovers items that came back from the model
  // with only some options populated — we'd rather show "—" placeholders
  // than throw away an otherwise-valid question. Items are dropped only when
  // the answer letter is impossible to resolve.
  const result = normalizeGeneratedItems('quiz', [
    {
      question: 'What is force?',
      options: { A: 'Mass times acceleration', B: 'Energy', C: 'Power', D: 'Velocity' },
      answer: 'A'
    },
    { question: 'Partial options', options: { A: 'Only one option' }, answer: 'A' }
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].options.B, '—');
  assert.equal(result[1].options.C, '—');
  assert.equal(result[1].options.D, '—');
});

test('normalizeGeneratedItems: drops quiz items with an unresolvable answer', () => {
  const result = normalizeGeneratedItems('quiz', [
    {
      question: 'Bad answer',
      options: { A: 'one', B: 'two', C: 'three', D: 'four' },
      answer: 'XYZ'
    }
  ]);
  assert.equal(result.length, 0);
});

test('normalizeGeneratedItems: drops empty flashcards', () => {
  const result = normalizeGeneratedItems('flashcards', [
    { front: 'Define velocity', back: 'Rate of change of displacement.' },
    { front: '', back: 'Missing front' }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].front, 'Define velocity');
});

// ── textStudyScore ────────────────────────────────────────────────────────────

test('textStudyScore: formula-like text scores positively', () => {
  // Multi-line so the short-text penalty does not cancel the formula bonus
  const score = textStudyScore('Newton second law states:\nF = m * a\nwhere m is mass and a is acceleration');
  assert.ok(score > 0, 'formula text should score > 0');
});

test('textStudyScore: numbered list scores positively', () => {
  const score = textStudyScore('1. First step\n2. Second step\n3. Third step');
  assert.ok(score > 0);
});

test('textStudyScore: table-of-contents line scores negatively', () => {
  const score = textStudyScore('1. Introduction ........... 3');
  assert.ok(score < 0, 'TOC lines should be penalized');
});

test('textStudyScore: very short text scores negatively', () => {
  const score = textStudyScore('Ok');
  assert.ok(score < 0, 'very short text should be penalized');
});

// ── prompt count enforcement ──────────────────────────────────────────────────

test('flashcardsSystemPrompt: includes requested count', () => {
  const prompt = flashcardsSystemPrompt(11);
  assert.ok(prompt.includes('11'), 'prompt must mention requested count');
  assert.ok(prompt.includes('EXACTLY'), 'prompt must enforce exact count');
});

test('quizSystemPrompt: includes requested count', () => {
  const prompt = quizSystemPrompt(7, 'medium');
  assert.ok(prompt.includes('7'), 'prompt must mention requested count');
  assert.ok(prompt.includes('EXACTLY'), 'prompt must enforce exact count');
});

test('quizSystemPrompt: includes difficulty', () => {
  const prompt = quizSystemPrompt(5, 'hard');
  assert.ok(prompt.includes('hard'));
});
