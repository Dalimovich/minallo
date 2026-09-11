import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('frontend/js/features/chatbot-new/deep-learn-workspace.ts', 'utf8');

// Regression coverage for a Deep Learn lesson showing raw, unrendered LaTeX
// after being reopened as a saved note. keyFormulas.formula is generated as
// raw LaTeX with NO $ delimiters by contract (deep_learn.py: "the formula
// card adds them"), and the LIVE lesson view honors that — it wraps the
// formula in $$...$$ before handing it to the KaTeX-aware renderMarkdownInto
// (see the formulaHost.querySelectorAll block below). But structuredToMarkdown,
// which builds the markdown that gets PERSISTED as the note's content_markdown,
// must do the same — the formula would otherwise render correctly on first
// view, then revert to raw text every time the note was reopened later.

test('structuredToMarkdown wraps keyFormulas.formula in $$...$$ before persisting', () => {
  const fn = source.slice(
    source.indexOf('function structuredToMarkdown'),
    source.indexOf('function previewFromLesson')
  );
  assert.match(fn, /'\*\*Formula:\*\* ' \+ \(f\.formula \? '\$\$' \+ f\.formula \+ '\$\$' : ''\)/);
});

test('the live formula-card view already wraps the same field the same way', () => {
  const fn = source.slice(
    source.indexOf('function renderStructuredResult'),
    source.indexOf('function renderStructuredResult') + 6000
  );
  assert.match(fn, /renderMarkdownInto\(el, f\.formula \? '\$\$' \+ f\.formula \+ '\$\$' : ''\)/);
});
