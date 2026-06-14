import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUuid,
  isSafeCourseId,
  isSafePdfStorageName,
  cleanText,
  requireOneOf
} from '../../backend/lib/validation.ts';

test('isUuid accepts valid v4 UUID', () => {
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
});

test('isUuid rejects empty string', () => {
  assert.equal(isUuid(''), false);
});

test('isUuid rejects arbitrary string', () => {
  assert.equal(isUuid('not-a-uuid'), false);
});

test('isUuid rejects null', () => {
  assert.equal(isUuid(null), false);
});

test('isSafeCourseId accepts compact course keys', () => {
  assert.equal(isSafeCourseId('math-101_WS26.1'), true);
});

test('isSafeCourseId rejects path separators and spaces', () => {
  assert.equal(isSafeCourseId('../math 101'), false);
});

test('isSafePdfStorageName accepts PDF filenames', () => {
  assert.equal(isSafePdfStorageName('lecture_01-final.pdf'), true);
});

test('isSafePdfStorageName rejects paths and non-PDF files', () => {
  assert.equal(isSafePdfStorageName('../lecture.pdf'), false);
  assert.equal(isSafePdfStorageName('lecture.txt'), false);
});

test('cleanText trims whitespace', () => {
  assert.equal(cleanText('  hello  ', 100), 'hello');
});

test('cleanText throws when value exceeds maxLength', () => {
  assert.throws(() => cleanText('a'.repeat(101), 100), /maximum allowed length/);
});

test('cleanText accepts value at exactly maxLength', () => {
  assert.equal(cleanText('a'.repeat(100), 100), 'a'.repeat(100));
});

test('requireOneOf returns value when allowed', () => {
  assert.equal(requireOneOf('pro', ['free', 'pro'], 'plan'), 'pro');
});

test('requireOneOf throws when not allowed', () => {
  assert.throws(() => requireOneOf('admin', ['free', 'pro'], 'plan'), /not allowed/);
});
