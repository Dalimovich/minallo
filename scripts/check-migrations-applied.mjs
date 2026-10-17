#!/usr/bin/env node
// Deployment gate: fails loudly if a migration file exists in
// supabase/migrations/ that hasn't been marked as applied to production.
//
// Why a marker file instead of querying the database: this repo applies
// migrations by hand (see supabase/migrations/README.md and the ops
// backlog note — there is no CI-driven `supabase db push`), so a DB-side
// check (e.g. against supabase_migrations.schema_migrations) would only be
// accurate if every migration had actually been applied through the
// Supabase CLI, which is not how this project currently works. A marker
// this project's humans update by hand is exactly as accurate as the
// process already is — it can't silently lie about DB state the way an
// unverified introspection query could, and it directly targets the real
// failure mode that already caused a production 502 once: code that
// depends on a new migration shipping before a human actually ran it.
//
// Usage: node scripts/check-migrations-applied.mjs
// Exits non-zero (and prints which files are pending) if the marker is
// behind the newest migration file, or if the marker references a file
// that no longer exists.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const markerPath = path.join(migrationsDir, '.last_applied');

function fail(message) {
  console.error('::error::' + message);
  process.exitCode = 1;
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.log('No migration files found — nothing to check.');
  process.exit(0);
}

let marker;
try {
  marker = readFileSync(markerPath, 'utf8').trim();
} catch {
  fail(
    `Missing ${path.relative(process.cwd(), markerPath)} — this file records the newest migration ` +
      'confirmed applied to production. Create it with the filename of the last migration you applied, ' +
      'e.g. `echo "' + files[files.length - 1] + '" > supabase/migrations/.last_applied`.'
  );
  process.exit(1);
}

if (!marker) {
  fail(`${path.relative(process.cwd(), markerPath)} is empty.`);
  process.exit(1);
}

const markerIndex = files.indexOf(marker);
if (markerIndex === -1) {
  fail(
    `supabase/migrations/.last_applied references "${marker}", which does not exist in supabase/migrations/. ` +
      'The marker is stale or corrupted — fix it to the actual last-applied migration filename.'
  );
  process.exit(1);
}

const pending = files.slice(markerIndex + 1);
if (pending.length) {
  fail(
    `${pending.length} migration(s) are in the repo but NOT marked as applied to production:\n` +
      pending.map((f) => '  - ' + f).join('\n') +
      '\nApply them to the production database, then update supabase/migrations/.last_applied to the ' +
      `newest applied filename (currently "${marker}").`
  );
  process.exit(1);
}

console.log(`All migrations up to and including "${marker}" are marked applied. Nothing pending.`);
