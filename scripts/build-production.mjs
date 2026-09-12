// Production build: copies frontend/ to dist/, stripping source files
// (.ts, .js.map, tsconfig, vite.config) and dev-only files (globals.d.ts).

import {
  cpSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
  'globals.d.ts'
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

// This URL is public: browsers connect to it directly for streaming. Generate
// it at build time so a host cutover does not require editing application code.
const DEFAULT_AI_SERVICE_URL = 'https://python-ai.fly.dev';
const configuredAiServiceUrl = (process.env.AI_SERVICE_URL || DEFAULT_AI_SERVICE_URL).replace(
  /\/$/,
  ''
);
let aiServiceOrigin;
try {
  const parsed = new URL(configuredAiServiceUrl);
  if (parsed.protocol !== 'https:' || parsed.origin !== configuredAiServiceUrl) {
    throw new Error('must be an HTTPS origin without a path');
  }
  aiServiceOrigin = parsed.origin;
} catch (error) {
  throw new Error(`Invalid AI_SERVICE_URL "${configuredAiServiceUrl}": ${error.message}`);
}

writeFileSync(
  join(OUT, 'js', 'runtime-config.js'),
  `window.MinalloConfig = Object.assign({}, window.MinalloConfig || {}, {\n  aiServiceUrl: ${JSON.stringify(aiServiceOrigin)}\n});\n`
);

const headersPath = join(OUT, '_headers');
const headers = readFileSync(headersPath, 'utf8');
writeFileSync(headersPath, headers.replaceAll(DEFAULT_AI_SERVICE_URL, aiServiceOrigin));

// Public deployment evidence: identify the exact served build without needing
// access to the hosting dashboard or assuming that a push has deployed.
let commit = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || null;
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    /* Source archives may not contain Git metadata. */
  }
}
const config = readFileSync(join(OUT, 'js/config.js'), 'utf8');
const index = readFileSync(join(OUT, 'index.html'), 'utf8');
const assetPaths = [
  'js/loader.js',
  'js/features/chatbot-new/shell.js',
  'js/features/chatbot-new/notes-intent-flow.js'
];
writeFileSync(
  join(OUT, 'build-info.json'),
  JSON.stringify(
    {
      commit,
      assetVersion: config.match(/assetVersion:\s*'([^']+)'/)?.[1] || null,
      loaderVersion: index.match(/loader\.js\?v=([^"']+)/)?.[1] || null,
      assets: Object.fromEntries(
        assetPaths.map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(OUT, file)))
            .digest('hex')
        ])
      )
    },
    null,
    2
  ) + '\n'
);
console.log(`Production build: copied ${SRC}/ → ${OUT}/, removed ${removed} source/dev files`);
