// Production build: copies frontend/ to dist/, stripping source files
// (.ts, .js.map, tsconfig, vite.config) and dev-only files (globals.d.ts).

import { cpSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'frontend';
const OUT = 'dist';

// Clean previous build
rmSync(OUT, { recursive: true, force: true });

// Copy everything
cpSync(SRC, OUT, { recursive: true });

// Files/patterns to strip from the production output
const STRIP_EXTENSIONS = new Set(['.ts', '.map']);
const STRIP_NAMES = new Set([
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
  'globals.d.ts',
]);

let removed = 0;

function clean(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      clean(full);
      continue;
    }
    const ext = extname(entry);
    if (STRIP_EXTENSIONS.has(ext) || STRIP_NAMES.has(entry)) {
      unlinkSync(full);
      removed++;
    }
  }
}

clean(OUT);
console.log(`Production build: copied ${SRC}/ → ${OUT}/, removed ${removed} source/dev files`);
