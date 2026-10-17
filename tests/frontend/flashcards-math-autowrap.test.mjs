import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Regression coverage for flashcards showing raw text instead of rendered
// LaTeX: cards that arrive with no $...$ delimiters at all rely on
// _fcAutoWrapMath to add them before KaTeX ever sees the text. The original
// gate/atom regexes required a "^"/"_" to be followed by exactly one
// alphanumeric character with no sign, so a scientific-notation exponent
// like "10^-6" (a very common shape in engineering formulas) was invisible
// to the gate check and never got wrapped, and a multi-digit exponent like
// "x^12" only had its first digit wrapped.
//
// The regexes are extracted directly from the source (not re-typed here) so
// this test fails if the actual implementation drifts from what it claims.

const source = fs.readFileSync(
  new URL('../../frontend/views/flashcards/flashcards.js', import.meta.url),
  'utf8'
);

function extractRegexLiteral(varName) {
  const match = source.match(new RegExp(`var ${varName} = (\\/.*\\/[a-z]*);`));
  assert.ok(match, `could not find ${varName} regex literal in flashcards.js`);
  // eslint-disable-next-line no-eval -- reconstructing a regex literal from its own source text
  return eval(match[1]);
}

const ATOM_RE = extractRegexLiteral('_FC_ATOM_RE');
const gateSource = source.match(/if \(!(\/.*\/)\.test\(s\)\) return s; \/\/ no LaTeX at all/);
assert.ok(gateSource, 'could not find the _fcAutoWrapMath gate regex in flashcards.js');
// eslint-disable-next-line no-eval
const GATE_RE = eval(gateSource[1]);

function autoWrap(s) {
  if (!s || /[$]|\\\(|\\\[/.test(s)) return s;
  if (!GATE_RE.test(s)) return s;
  return s.replace(ATOM_RE, (m) => '$' + m + '$');
}

test('a negative scientific-notation exponent with no other LaTeX now gets wrapped', () => {
  const input = 'deltaS = 2.4 x 10^-6 mm/N';
  const out = autoWrap(input);
  assert.match(out, /\$10\^-6\$/);
});

test('a multi-digit exponent is wrapped in full, not cut after the first digit', () => {
  const out = autoWrap('the value is x^12 exactly');
  assert.match(out, /\$x\^12\$/);
  assert.doesNotMatch(out, /\$x\^1\$2/);
});

test('a negative subscript-like value is wrapped in full', () => {
  const out = autoWrap('reference is a_-3 baseline');
  assert.match(out, /\$a_-3\$/);
});

test('plain prose with a caret used non-mathematically is still left alone', () => {
  const input = 'no math here at all';
  assert.equal(autoWrap(input), input);
});

test('a card that already uses $...$ delimiters is trusted and never re-wrapped', () => {
  const input = 'already has $10^{-6}$ delimited correctly';
  assert.equal(autoWrap(input), input);
});

test('existing bare-LaTeX-command wrapping (\\frac etc.) still works after the regex edit', () => {
  const out = autoWrap('use \\frac{a}{b} to compute it');
  assert.match(out, /\$\\frac\{a\}\{b\}\$/);
});
