// Push env vars to a Cloudflare Pages project as encrypted secrets.
//
// USAGE
//   1. Pull values out of Netlify (any one of these works):
//        netlify env:list --json > .env.netlify.json
//        netlify env:export --plain > .env.from-netlify
//      Or paste values into a local .env.cloudflare file:
//        KEY=value
//        OTHER=value
//   2. Authenticate wrangler once:
//        npx wrangler login
//   3. Run this script:
//        node scripts/sync-env-to-cloudflare.mjs <project-name> <env-file> [--env=production|preview]
//
//   Example:
//        node scripts/sync-env-to-cloudflare.mjs minallo .env.cloudflare --env=production
//
// Lists every var the code actually reads (grepped from backend/lib/env helpers).
// Skips Netlify-specific platform vars (NETLIFY, CONTEXT) — Cloudflare sets
// CF_PAGES instead and cors.ts already handles both.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Canonical list — keep in sync with the requireEnv/optionalEnv calls.
// Marked SECRET get `wrangler pages secret put` (encrypted, hidden in
// dashboard); marked PLAIN get `wrangler pages deployment env set` style
// behavior — but pages doesn't expose a non-secret CLI path, so for now
// we set everything as a secret. They're still readable inside Functions
// via the env binding.
const REQUIRED = [
  // Supabase
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  // Python AI backend
  'AI_SERVICE_URL',
  'INTERNAL_SECRET',
  // OpenAI (edge SSE)
  'OPENAI_API_KEY',
  // Stripe
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  // PayPal
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_PLAN_ID',
  'PAYPAL_WEBHOOK_ID',
  // CORS
  'ALLOWED_ORIGIN'
];

const OPTIONAL = [
  'AI_UPSTREAM_TIMEOUT_MS',
  'AI_MODEL',
  'AI_NANO_MODEL',
  'PAYPAL_API_BASE',
  'RAG_STORAGE_BUCKET',
  // Rate limits + caps — all default in code; only override if a value is set.
  'AI_CHAT_RATE_LIMIT_MAX',
  'AI_CHAT_RATE_LIMIT_WINDOW_MS',
  'AI_ASK_RATE_LIMIT_MAX',
  'AI_ASK_RATE_LIMIT_WINDOW_MS',
  'AI_GENERATE_RATE_LIMIT_MAX',
  'AI_GENERATE_RATE_LIMIT_WINDOW_MS',
  'CHAT_RATE_LIMIT_MAX',
  'CHAT_RATE_LIMIT_WINDOW_MS',
  'NOTES_RATE_LIMIT_MAX',
  'NOTES_RATE_LIMIT_WINDOW_MS',
  'UPLOAD_RATE_LIMIT_MAX',
  'UPLOAD_RATE_LIMIT_WINDOW_MS',
  'WRITING_COACH_RATE_LIMIT_MAX',
  'WRITING_COACH_RATE_LIMIT_WINDOW_MS',
  'AI_MONTHLY_CAP',
  'INTERACTIVE_MONTHLY_CAP',
  'GENERATION_MONTHLY_CAP'
];

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseEnvFile(path) {
  if (!existsSync(path)) die(`env file not found: ${path}`);
  const out = {};
  // Two supported shapes:
  //   1) netlify env:list --json   (array of {key, values: [{value, context}]})
  //   2) KEY=value lines           (.env style, # comments ok, quoted values ok)
  //
  // Encoding: PowerShell 5.1's `>` redirect writes UTF-16 LE w/ BOM. Detect
  // and decode it; otherwise readFileSync('utf8') returns garbage and the
  // JSON branch silently falls through to the .env branch, which finds
  // zero `=` lines and reports every var "missing".
  const bytes = readFileSync(path);
  let raw;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    raw = bytes.toString('utf16le').slice(1); // skip BOM codepoint
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    raw = bytes.slice(3).toString('utf8'); // UTF-8 BOM
  } else {
    raw = bytes.toString('utf8');
  }
  if (raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{')) {
    const data = JSON.parse(raw);
    const entries = Array.isArray(data) ? data : Object.entries(data);
    for (const item of entries) {
      if (Array.isArray(item)) {
        const [k, v] = item;
        if (typeof v === 'string') out[k] = v;
      } else if (item && item.key) {
        const v = item.values?.find((x) => x.context === 'production')?.value
          ?? item.values?.[0]?.value
          ?? item.value;
        if (typeof v === 'string') out[item.key] = v;
      }
    }
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function putSecret(project, env, key, value) {
  // wrangler reads the secret value from stdin so it never appears in argv /
  // shell history. --project-name + --env target the right Pages env.
  const result = spawnSync(
    'npx',
    [
      'wrangler',
      'pages',
      'secret',
      'put',
      key,
      '--project-name',
      project,
      ...(env ? ['--env', env] : [])
    ],
    { input: value, stdio: ['pipe', 'inherit', 'inherit'], shell: true }
  );
  return result.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  const project = args[0];
  const envFile = args[1];
  if (!project || !envFile) {
    die('usage: node scripts/sync-env-to-cloudflare.mjs <project-name> <env-file> [--env=production|preview]');
  }
  const envFlag = args.find((a) => a.startsWith('--env='))?.slice(6) || 'production';
  if (!['production', 'preview'].includes(envFlag)) {
    die(`--env must be production or preview (got "${envFlag}")`);
  }

  const values = parseEnvFile(envFile);
  const missingRequired = REQUIRED.filter((k) => !values[k]);
  if (missingRequired.length) {
    console.error('missing required vars in env file:');
    for (const k of missingRequired) console.error(`  - ${k}`);
    process.exit(1);
  }

  const toSet = [
    ...REQUIRED.map((k) => [k, values[k], true]),
    ...OPTIONAL.filter((k) => values[k]).map((k) => [k, values[k], false])
  ];

  console.log(`Pushing ${toSet.length} vars to Cloudflare Pages project "${project}" (${envFlag})\n`);
  let failed = 0;
  for (const [k, v, required] of toSet) {
    process.stdout.write(`  ${k.padEnd(40)} ... `);
    const ok = putSecret(project, envFlag, k, v);
    console.log(ok ? 'ok' : (required ? 'FAILED (required)' : 'failed'));
    if (!ok && required) {
      failed++;
      // If the FIRST required var fails, the project name / auth is wrong
      // and every other call will fail the same way. Stop hammering.
      if (failed === 1 && k === toSet[0][0]) {
        console.error('\nFirst write failed — likely wrong project name or unauthenticated.');
        console.error('Check `npx wrangler pages project list` and re-run with the right name.');
        process.exit(1);
      }
    }
  }
  if (failed) {
    console.error(`\n${failed} required var(s) failed — re-run after fixing wrangler auth / project name.`);
    process.exit(1);
  }
  console.log(`\nDone. ${toSet.length} vars set on ${envFlag}.`);
  const optionalSet = OPTIONAL.filter((k) => values[k]);
  const optionalSkipped = OPTIONAL.filter((k) => !values[k]);
  if (optionalSkipped.length) {
    console.log(`\nOptional vars not in env file (defaults will be used by handlers):`);
    for (const k of optionalSkipped) console.log(`  - ${k}`);
  }
  console.log(
    `\nIf the project also needs the same vars on the "preview" environment,\n` +
    `re-run with --env=preview.`
  );
  void optionalSet;
}

main();
