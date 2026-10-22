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

// Second review pass (final verification request) caught that the negation
// guard was added for 'summary' but not mirrored for 'quiz' on the same
// lines — "Explain this chapter; don't quiz me" (this PR's own backend
// regression case) still showed the quiz-flavored loading status even
// though the backend correctly answers with a plain explanation.
test('"don\'t quiz me" is not treated as a quiz request', () => {
  const input = { question: "Explain this chapter; don't quiz me." };
  assert.notEqual(getThinkingContext(input), 'quiz');
  assert.notEqual(getInitialAssistantStatus(input), 'preparing_quiz');
});

test('a genuine quiz request still gets the quiz status (no overcorrection)', () => {
  const input = { question: 'Quiz me on this chapter.' };
  assert.equal(getThinkingContext(input), 'quiz');
  assert.equal(getInitialAssistantStatus(input), 'preparing_quiz');
});

for (const question of ['No summary please, just explain the concept', 'Why did you summarize that?']) {
  test(`summary mention is not a request: ${question}`, () => {
    assert.notEqual(getThinkingContext({ question }), 'summary');
    assert.notEqual(getInitialAssistantStatus({ question }), 'preparing_summary');
  });
}

for (const [question, context, status] of [
  ['Do not rush. Summarize this page.', 'summary', 'preparing_summary'],
  ['Do not guess; quiz me on this chapter.', 'quiz', 'preparing_quiz'],
  ["Why don't you quiz me?", 'quiz', 'preparing_quiz'],
]) {
  test(`positive task survives unrelated negation: ${question}`, () => {
    assert.equal(getThinkingContext({ question }), context);
    assert.equal(getInitialAssistantStatus({ question }), status);
  });
}
