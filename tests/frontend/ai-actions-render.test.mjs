import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same setup as ai-input-render.test.mjs: renderMarkdown reads `window`
// lazily and the delegated DOM handlers are guarded by
// `typeof document !== 'undefined'`, so a bare window stub is enough.
globalThis.window = globalThis.window || {};

const { renderMarkdown, AI_ACTION_TABS, AI_ASK_ACTIONS, AI_ACTION_GENERATE_BTN } = await import(
  '../../frontend/js/features/ai-chat/ai-markdown.ts'
);

function renderActions(spec) {
  return renderMarkdown('```minallo-actions\n' + JSON.stringify(spec) + '\n```');
}

test('valid minallo-actions renders allowlisted buttons', () => {
  const html = renderActions({
    actions: [
      { action: 'generate_flashcards', label: 'Generate flashcards' },
      { action: 'open_flashcards', label: 'Open Flashcards' },
    ],
  });
  assert.ok(html.includes('md-ai-actions'));
  assert.ok(html.includes('data-ai-action="generate_flashcards"'));
  assert.ok(html.includes('data-ai-action="open_flashcards"'));
  assert.ok(html.includes('Generate flashcards'));
  assert.equal((html.match(/<button /g) || []).length, 2);
});

test('quiz actions are no longer offered (inline quiz replaces them)', () => {
  assert.equal(AI_ACTION_TABS.open_quiz, undefined);
  assert.equal(AI_ACTION_TABS.generate_quiz, undefined);
  // A model that still emits them must render nothing — they are not allowlisted.
  const html = renderActions({
    actions: [
      { action: 'open_quiz', label: 'Quiz öffnen' },
      { action: 'generate_quiz', label: 'Quiz erstellen' },
    ],
  });
  assert.ok(!html.includes('md-ai-actions'));
  assert.ok(!html.includes('<button'));
});

test('a disallowed action block never leaks its raw JSON as text', () => {
  // The retired generate_quiz action renders no buttons; the marker + JSON must
  // vanish entirely, both fenced and unfenced — not show up as chat text.
  const fenced = renderActions({ actions: [{ action: 'generate_quiz', label: 'Quiz erstellen' }] });
  assert.ok(!fenced.includes('generate_quiz'));
  assert.ok(!fenced.includes('minallo-actions'));
  assert.ok(!fenced.includes('Quiz erstellen'));

  const unfenced = renderMarkdown(
    'minallo-actions\n\n{"actions":[{"action":"generate_quiz","label":"Quiz erstellen"}]}'
  );
  assert.ok(!unfenced.includes('generate_quiz'));
  assert.ok(!unfenced.includes('Quiz erstellen'));
  assert.ok(!unfenced.includes('actions'));
});

test('unknown action ids are dropped; all-unknown renders nothing', () => {
  const mixed = renderActions({
    actions: [
      { action: 'rm_rf_everything', label: 'Nope' },
      { action: 'open_files', label: 'Open Files' },
    ],
  });
  assert.ok(!mixed.includes('rm_rf_everything'));
  assert.ok(mixed.includes('data-ai-action="open_files"'));

  const none = renderActions({ actions: [{ action: 'not_a_real_action', label: 'X' }] });
  assert.ok(!none.includes('md-ai-actions'));
  assert.ok(!none.includes('<button'));
});

test('malformed JSON renders nothing and does not throw', () => {
  const html = renderMarkdown('```minallo-actions\n{broken json,,,\n```');
  assert.ok(!html.includes('md-ai-actions'));
  assert.ok(!html.includes('<button'));
});

test('at most 3 buttons render', () => {
  const html = renderActions({
    actions: [
      { action: 'open_files', label: 'a' },
      { action: 'open_cheatsheet', label: 'b' },
      { action: 'open_flashcards', label: 'c' },
      { action: 'open_examforge', label: 'd' },
    ],
  });
  assert.equal((html.match(/<button /g) || []).length, 3);
});

test('unfenced minallo-actions marker still renders buttons', () => {
  // The model sometimes drops the code fences and emits a bare marker line
  // followed by the JSON; it must not leak into the chat as plain text.
  const html = renderMarkdown(
    'Here you go:\n\nminallo-actions\n\n{"actions":[{"action":"generate_flashcards","label":"Karten erstellen"}]}'
  );
  assert.ok(html.includes('md-ai-actions'));
  assert.ok(html.includes('data-ai-action="generate_flashcards"'));
  assert.ok(html.includes('Karten erstellen'));
  assert.ok(!html.includes('minallo-actions{'));
  assert.ok(!html.includes('&quot;actions&quot;')); // raw JSON did not leak as text
});

test('unfenced multi-line minallo-actions JSON renders buttons', () => {
  const html = renderMarkdown(
    'minallo-actions\n{\n  "actions": [\n    {"action":"open_flashcards","label":"Karten öffnen"}\n  ]\n}'
  );
  assert.ok(html.includes('data-ai-action="open_flashcards"'));
  assert.ok(html.includes('Karten öffnen'));
});

test('bare minallo-actions marker with no JSON falls through to text', () => {
  const html = renderMarkdown('minallo-actions\n\nSome other prose.');
  assert.ok(!html.includes('md-ai-actions'));
  assert.ok(html.includes('Some other prose.'));
});

test('HTML in labels is escaped (no injection)', () => {
  const html = renderActions({
    actions: [{ action: 'open_flashcards', label: '<img src=x onerror=alert(1)>' }],
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('a missing or empty label drops the button', () => {
  const html = renderActions({ actions: [{ action: 'open_flashcards' }, { action: 'open_files', label: '  ' }] });
  assert.ok(!html.includes('<button'));
});

test('every nav action maps to one of the six real course tabs', () => {
  const tabs = new Set(['files', 'quiz', 'flashcards', 'examforge', 'cheatsheet', 'deeplearn']);
  for (const [action, tab] of Object.entries(AI_ACTION_TABS)) {
    assert.ok(tabs.has(tab), action + ' maps to unknown tab ' + tab);
  }
});

test('ask actions compose non-empty follow-up questions', () => {
  for (const [action, text] of Object.entries(AI_ASK_ACTIONS)) {
    assert.ok(typeof text === 'string' && text.trim().length > 10, action);
  }
});

function renderQuiz(spec) {
  return renderMarkdown('```minallo-quiz\n' + JSON.stringify(spec) + '\n```');
}

test('minallo-quiz renders an interactive quiz with options and answers', () => {
  const html = renderQuiz({
    title: 'Sandguss',
    questions: [
      {
        q: 'Welcher Formgrundstoff?',
        options: ['Wasser', 'Bentonit', 'Quarzsand'],
        answer: 2,
        explanation: 'Quarzsand ist der Formgrundstoff.',
      },
    ],
  });
  assert.ok(html.includes('class="md-quiz"'));
  assert.ok(html.includes('data-answer="2"'));
  assert.ok(html.includes('md-quiz-opt'));
  assert.ok(html.includes('Quarzsand'));
  assert.ok(html.includes('md-quiz-explain'));
  assert.equal((html.match(/data-idx=/g) || []).length, 3); // three options
});

test('minallo-quiz accepts a letter answer and normalises to an index', () => {
  const html = renderQuiz({
    questions: [{ q: 'Q?', options: ['x', 'y', 'z'], answer: 'B' }],
  });
  assert.ok(html.includes('data-answer="1"'));
});

test('minallo-quiz drops questions with too few options and bad JSON renders nothing', () => {
  const oneOpt = renderQuiz({ questions: [{ q: 'Q?', options: ['only'], answer: 0 }] });
  assert.ok(!oneOpt.includes('md-quiz'));

  const broken = renderMarkdown('```minallo-quiz\n{not valid,,,\n```');
  assert.ok(!broken.includes('md-quiz'));
});

test('unfenced minallo-quiz marker still renders the quiz', () => {
  const html = renderMarkdown(
    'Hier dein Quiz:\n\nminallo-quiz\n\n{"questions":[{"q":"Q?","options":["a","b"],"answer":1}]}'
  );
  assert.ok(html.includes('class="md-quiz"'));
  assert.ok(html.includes('data-answer="1"'));
  assert.ok(!html.includes('minallo-quiz{'));
});

test('minallo-quiz escapes HTML in questions/options (no injection)', () => {
  const html = renderQuiz({
    questions: [{ q: '<img src=x onerror=alert(1)>', options: ['<b>a</b>', 'b'], answer: 0 }],
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>a</b>'));
  assert.ok(html.includes('&lt;'));
});

test('every generate-button action is a known tab action with a CSS selector', () => {
  for (const [action, selector] of Object.entries(AI_ACTION_GENERATE_BTN)) {
    assert.ok(AI_ACTION_TABS[action], action + ' has a generate button but no tab mapping');
    assert.ok(
      typeof selector === 'string' && selector.startsWith('#'),
      action + ' maps to a non-id selector: ' + selector
    );
  }
  // Every generate_*/start action that opens a tab should auto-start its flow.
  for (const action of Object.keys(AI_ACTION_TABS)) {
    if (action.startsWith('generate_') || action === 'start_deeplearn') {
      assert.ok(AI_ACTION_GENERATE_BTN[action], action + ' is missing a generate-button selector');
    }
  }
});
