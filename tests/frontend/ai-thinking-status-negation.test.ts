import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getThinkingContext,
  getInitialAssistantStatus,
} from '../../frontend/js/features/ai-chat/ai-thinking-status.ts';

// Regression coverage for the P1 negation-blindness bug: a student who
// explicitly prohibits summarization ("explain this, do not summarize it")
// was shown a loading status that announced a summary ("I'm identifying the
// main points before creating the summary") because both status pickers
// matched the bare word "summarize"/"summary" with no negation check.

test('an explanation request that explicitly prohibits summarizing is not treated as a summary request', () => {
  const input = { question: 'Explain the concept on this page in detail. Do not summarize it.' };
  assert.notEqual(getThinkingContext(input), 'summary');
  assert.notEqual(getInitialAssistantStatus(input), 'preparing_summary');
});

test('"don\'t give me a summary" is not treated as a summary request', () => {
  const input = { question: "Explain in detail; don't give me a summary." };
  assert.notEqual(getThinkingContext(input), 'summary');
  assert.notEqual(getInitialAssistantStatus(input), 'preparing_summary');
});

test('a genuine summary request still gets the summary status (no overcorrection)', () => {
  const input = { question: 'Summarize this page.' };
  assert.equal(getThinkingContext(input), 'summary');
  assert.equal(getInitialAssistantStatus(input), 'preparing_summary');
});

test('an explicit summary tool call still wins even if the question text says otherwise', () => {
  const input = { tool: 'summary', question: 'explain this' };
  assert.equal(getThinkingContext(input), 'summary');
});
