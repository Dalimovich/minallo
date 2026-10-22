// Math normalization for the Notes / Summary panel.
//
// The panel's KaTeX pass only renders `$…$` / `$$…$$`. But the model frequently
// emits math the panel then showed as raw text:
//   1. standard LaTeX delimiters `\[ … \]` (display) and `\( … \)` (inline);
//   2. *bare* LaTeX on a formula line with NO delimiters at all, e.g.
//      `f(x)=\frac{x}{1+x^2},\quad x\in\R (S. 1)` — so `\frac`, `\quad`, `\R`
//      rendered as literal backslashes.
//
// `normalize()` rewrites both into `$…$` / `$$…$$` so the existing KaTeX pass
// catches them. It is deliberately conservative: bare-LaTeX wrapping only fires
// on a line that is *essentially all math* (after stripping a leading bullet and
// a trailing `(S. …)` page reference) AND contains a real `\command`, so prose
// sentences that merely mention a symbol are never wrapped.
//
// Classic browser script (notes-panel.js is a non-module IIFE) with a CommonJS
// export tail so the pure transform can be unit-tested under node.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NotesMath = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // A LaTeX control word: \frac, \quad, \in, \R, \lim, \sum, \sqrt, \infty, …
  var TEX_CMD = /\\[a-zA-Z]+/;

  // Characters allowed in a "math-only" line body (besides whitespace). Includes
  // the common unicode math glyphs the model mixes in (ℝ ℂ π → ∞ √ ≤ ≥ ≠ ± · × ÷).
  var MATH_BODY = /^[\sA-Za-z0-9\\^_{}()[\]+\-*/=,.;:'|<>!?√πℝℂ→∞≤≥≠±·×÷…]+$/;

  // Trailing source citation the generators append — often wrapped in markdown
  // emphasis: " *(S. 1)*", " (S. 1)", " _(S. 3–4)_", " *(p. 12)*". The emphasis
  // markers MUST stay outside the math wrap, otherwise KaTeX renders them as
  // literal asterisks (e.g. "∗(S.1)∗").
  var PAGE_REF = /\s*[*_]{0,2}\s*\((?:S\.|p\.|pp\.|Seite|Seiten|page)\s*[^)]*\)\s*[*_]{0,2}\s*$/i;

  // Leading list bullet on a formula line.
  var BULLET = /^\s*(?:[–—\-*•]\s+)?/;

  function wrapBareLatexLine(line) {
    if (line.indexOf('$') !== -1) return line; // already has math delimiters
    if (!TEX_CMD.test(line)) return line; // no bare control words → nothing to do

    var ref = '';
    var body = line;
    var refMatch = body.match(PAGE_REF);
    if (refMatch) {
      ref = refMatch[0];
      body = body.slice(0, refMatch.index);
    }

    var bulletMatch = body.match(BULLET);
    var bullet = bulletMatch ? bulletMatch[0] : '';
    var core = body.slice(bullet.length);

    var trimmed = core.trim();
    if (!trimmed) return line;
    // Only wrap when the remaining content is essentially all math — this is what
    // keeps prose ("…ist stetig, weil …") from being swallowed into `$…$`.
    if (!MATH_BODY.test(trimmed)) return line;

    return bullet + '$' + trimmed + '$' + ref;
  }

  function normalize(text) {
    if (!text) return text;

    // 1) Standard LaTeX delimiters → `$`/`$$` (mirrors the AI-chat renderer).
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, function (_, m) {
      return '$$' + m.trim() + '$$';
    });
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, function (_, m) {
      return '$' + m.trim() + '$';
    });

    // 2) Bare-LaTeX formula lines → wrapped inline math (per-line, conservative).
    text = text
      .split('\n')
      .map(wrapBareLatexLine)
      .join('\n');

    return text;
  }

  return { normalize: normalize };
});
