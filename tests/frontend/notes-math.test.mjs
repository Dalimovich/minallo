import { test } from 'node:test';
import assert from 'node:assert/strict';

// notes-math.js is a classic browser script with a CommonJS export tail; under
// node ESM it imports as a default export.
import notesMath from '../../frontend/views/notes/notes-math.js';

const { normalize } = notesMath;

test('\\[ … \\] display delimiters become $$ … $$', () => {
  const out = normalize('\\[ \\lim_{x\\to\\pi} f(x) \\]');
  assert.ok(out.includes('$$'));
  assert.ok(!out.includes('\\['));
  assert.ok(!out.includes('\\]'));
  assert.ok(out.includes('\\lim_{x\\to\\pi}'));
});

test('\\( … \\) inline delimiters become $ … $', () => {
  const out = normalize('Es gilt \\(x\\in\\R\\) hier.');
  assert.equal(out, 'Es gilt $x\\in\\R$ hier.');
});

test('bare formula line gets wrapped, page ref preserved outside math', () => {
  const out = normalize('f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R (S. 1)');
  assert.equal(out, '$f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R$ (S. 1)');
});

test('markdown-italic page ref *(S. 1)* stays OUTSIDE the math wrap', () => {
  const out = normalize('f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R *(S. 1)*');
  assert.equal(out, '$f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R$ *(S. 1)*');
});

test('underscore-emphasized page ref _(S. 3–4)_ stays outside the math wrap', () => {
  const out = normalize('c_n=\\frac{1}{n^a},\\quad a>0 _(S. 3–4)_');
  assert.equal(out, '$c_n=\\frac{1}{n^a},\\quad a>0$ _(S. 3–4)_');
});

test('bare formula line with a leading bullet keeps the bullet outside math', () => {
  const out = normalize('– c_n=\\frac{1}{n^a},\\quad a>0 (S. 1)');
  assert.equal(out, '– $c_n=\\frac{1}{n^a},\\quad a>0$ (S. 1)');
});

test('geometric-series formula line is wrapped', () => {
  const out = normalize('\\sum_{k=1}^\\infty q^k = \\frac{q}{1-q},\\quad |q|<1');
  assert.equal(out, '$\\sum_{k=1}^\\infty q^k = \\frac{q}{1-q},\\quad |q|<1$');
});

test('prose that merely mentions a backslash command is NOT wrapped', () => {
  // Real prose: contains a TeX command but also normal words → must stay as-is,
  // otherwise KaTeX would choke on the sentence.
  const line = 'Die Funktion ist stetig, weil sie eine Verkettung stetiger Funktionen ist.';
  assert.equal(normalize(line), line);
});

test('a sentence containing \\frac but mostly words is left alone', () => {
  const line = 'Hier berechnen wir die Ableitung und erhalten anschliessend das Ergebnis.';
  assert.equal(normalize(line), line);
});

test('already-delimited math is left untouched', () => {
  const line = 'Inline $a^2+b^2$ and display $$\\int_0^1 x\\,dx$$ stay as-is.';
  assert.equal(normalize(line), line);
});

test('plain text without any LaTeX is unchanged', () => {
  const line = 'g : ℝ→ℝ mit g(x)=e (S. 1)';
  assert.equal(normalize(line), line);
});

test('multi-line input only wraps the math lines', () => {
  const input = [
    'Definitionen',
    'f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R (S. 1)',
    'Dies ist eine ganz normale Erklärung im Fließtext.',
  ].join('\n');
  const out = normalize(input).split('\n');
  assert.equal(out[0], 'Definitionen');
  assert.equal(out[1], '$f(x)=\\frac{x}{1+x^2},\\quad x\\in\\R$ (S. 1)');
  assert.equal(out[2], 'Dies ist eine ganz normale Erklärung im Fließtext.');
});
