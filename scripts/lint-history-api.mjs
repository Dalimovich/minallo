// Guards against the exact bug fixed in commit 5b450ca8: frontend/app/index.html
// carries <base href="/"> (needed so loader.ts's relative asset paths resolve
// from /app/), which also makes history.pushState/replaceState resolve a bare
// "#..." url argument against "/" instead of the document's actual URL —
// silently rewriting the address bar out of /app/ on every call site that
// forgets to prefix the hash with location.pathname. This scans every
// pushState/replaceState call under frontend/ and fails if the url argument is
// a literal that starts with '#' (optionally concatenated with '+') without
// location.pathname/window.location.pathname anywhere in it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = 'frontend';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler']);
const EXTS = new Set(['.js', '.ts']);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (EXTS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

// Strips // and /* */ comments and string/template contents are left intact
// elsewhere — this pass only exists to stop a pushState( mentioned in a
// comment from producing a false positive.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

// Finds the text of the full argument list of a call whose opening "(" is at
// openIdx, respecting nested brackets and string/template literals.
function matchArgs(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    } else if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  return src.slice(openIdx + 1);
}

// Splits a top-level comma list, respecting nested brackets/strings.
function splitArgs(argsText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < argsText.length && argsText[i] !== quote) {
        if (argsText[i] === '\\') i++;
        i++;
      }
    } else if (c === ',' && depth === 0) {
      parts.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(argsText.slice(start));
  return parts.map((p) => p.trim());
}

const CALL_RE = /\.(pushState|replaceState)\s*\(/g;
const violations = [];

for (const file of walk(ROOT, [])) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(src))) {
    const openIdx = m.index + m[0].length - 1;
    const argsText = matchArgs(src, openIdx);
    const args = splitArgs(argsText);
    const urlArg = (args[2] || '').trim();
    if (!urlArg) continue;
    const startsWithBareHash = /^['"`]#/.test(urlArg);
    const hasPathname = /\b(location|window\.location)\.pathname\b/.test(urlArg);
    if (startsWithBareHash && !hasPathname) {
      const line = raw.slice(0, m.index).split('\n').length;
      violations.push({ file, line, call: m[1], urlArg });
    }
  }
}

if (violations.length) {
  console.error('history API lint failed: bare "#..." url argument(s) found.');
  console.error(
    'These resolve against <base href="/"> instead of the current URL — prefix with ' +
    'location.pathname (or window.location.pathname), e.g. location.pathname + \'#foo\'.'
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.call}(..., ..., ${v.urlArg})`);
  }
  process.exit(1);
}

console.log(`history API lint passed (no bare "#" pushState/replaceState arguments found).`);
