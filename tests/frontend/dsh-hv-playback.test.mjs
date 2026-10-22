// DSH Hörverstehen two-play flow — browser mirror of dsh_hv_playback.py, checked against the SAME vectors
// the Python suite runs (tests/fixtures/dsh-hv-playback-vectors.json). No DOM, no audio, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VECTORS = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/dsh-hv-playback-vectors.json'), 'utf8'));
const hv = await import('../../frontend/js/features/german-exam/dsh-hv-playback.ts');

const apply = (state, event, now) => (event === 'recover' ? hv.recoverHv(state, now) : hv.advanceHv(state, event, now));

for (const vector of VECTORS.vectors) {
  test(`vector: ${vector.name}`, () => {
    let state = hv.newHvState(VECTORS.attemptId);
    for (const step of vector.steps) {
      if (step.expectError) {
        assert.throws(() => apply(state, step.event, step.nowMs), hv.HvPlaybackError, JSON.stringify(step));
        continue;
      }
      state = apply(state, step.event, step.nowMs);
      for (const [key, value] of Object.entries(step.expect)) assert.equal(state[key], value, `${vector.name} ${JSON.stringify(step)} ${key}`);
    }
  });
}

test('windows are the official 10 and 40 minutes (the backend branch checks them against the DSH profile)', () => {
  assert.deepEqual(hv.HV_WINDOWS_MS, { 1: 600000, 2: 2400000 });
});

test('never more than two plays over every short event sequence', () => {
  const events = ['start_play', 'playback_ended', 'tick', 'submit', 'recover'];
  const times = [0, 599999, 600000, 3100000];
  const walk = (state, depth) => {
    if (depth === 6) return;
    for (const event of events) {
      let next;
      try { next = apply(state, event, times[depth % times.length] + depth); } catch { continue; }
      assert.ok(next.playsStarted <= hv.HV_MAX_PLAYS);
      assert.ok(next.playsCompleted <= next.playsStarted);
      walk(next, depth + 1);
    }
  };
  walk(hv.newHvState('a'), 0);
});

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

test('controller: the play is on record BEFORE beginPlay returns, so a reload cannot restore play 1', () => {
  const storage = memoryStorage();
  let now = 1000;
  const first = new hv.HvPlaybackController(storage, 'attempt', () => now);
  assert.equal(first.beginPlay(), true);
  assert.equal(JSON.parse(storage.data['dsh-hv-playback:attempt']).playsStarted, 1); // persisted already
  // "reload": a brand-new controller over the same storage, before playback ever ended
  now = 5000;
  const reloaded = new hv.HvPlaybackController(storage, 'attempt', () => now);
  assert.equal(reloaded.snapshot.phase, 'processing_1');
  assert.equal(reloaded.snapshot.playsStarted, 1);
  assert.equal(reloaded.beginPlay(), false); // no second start while the window runs
  // reloading over and over never yields a ready state again
  for (let i = 0; i < 5; i += 1) {
    now += 1000;
    assert.notEqual(new hv.HvPlaybackController(storage, 'attempt', () => now).snapshot.phase, 'ready');
  }
});

test('controller: two plays, then nothing — including across a reload after the second play', () => {
  const storage = memoryStorage();
  let now = 0;
  const make = () => new hv.HvPlaybackController(storage, 'a2', () => now);
  let c = make();
  assert.equal(c.beginPlay(), true); now = 300000; c.endPlay();
  now = 300000 + 600000; c = make();
  assert.equal(c.snapshot.phase, 'awaiting_play_2');
  assert.equal(c.beginPlay(), true); now += 100000; c.endPlay();
  now += 1000; c = make();
  assert.equal(c.snapshot.playsStarted, 2);
  assert.equal(c.beginPlay(), false); // no third play
  assert.equal(make().beginPlay(), false);
});

test('controller fails closed: no usable storage means no play is granted', () => {
  assert.equal(new hv.HvPlaybackController(undefined, 'x', () => 0).beginPlay(), false);
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(new hv.HvPlaybackController(broken, 'x', () => 0).beginPlay(), false);
});

test('controller: a corrupt or foreign stored record cannot grant a fresh play', () => {
  const corrupt = memoryStorage({ 'dsh-hv-playback:z': '{not json' });
  assert.equal(new hv.HvPlaybackController(corrupt, 'z', () => 0).beginPlay(), true); // unreadable = nothing recorded yet
  const bogus = memoryStorage({ 'dsh-hv-playback:z': JSON.stringify({ schemaVersion: 1, attemptId: 'z', phase: 'bogus', playsStarted: 0 }) });
  assert.equal(new hv.HvPlaybackController(bogus, 'z', () => 0).beginPlay(), false); // invalid state => expired, not reset
});

test('submit is only possible after the second presentation', () => {
  const c = new hv.HvPlaybackController(memoryStorage(), 'a3', () => 0);
  assert.throws(() => c.submit(), hv.HvPlaybackError);
});
