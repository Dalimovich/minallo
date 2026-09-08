// Real execution tests for the Saved AI response mutation queue
// (frontend/js/features/chatbot-new/saved-reply-sync.ts). This module has no
// DOM/window/document dependency, so — unlike shell.ts, which is only ever
// read as source text in these tests because importing it would pull in
// browser-only globals — it can be imported directly and driven with a fake
// chat store + fake fetch to exercise the actual offline-retry, in-flight
// dedupe, delete-tombstone, and coalesced-retry logic end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedReplySyncEngine } from '../../frontend/js/features/chatbot-new/saved-reply-sync.ts';

function makeChat(overrides = {}) {
  return { id: 'c1', savedReplies: [], pendingSavedReplyDeletes: {}, ...overrides };
}

function flushMicrotasks(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CREATE ─────────────────────────────────────────────────────────────

test('create: no token marks the reply pending and persists it, without attempting a request', () => {
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null };
  const chat = makeChat({ savedReplies: [reply] });
  let saveCount = 0;
  let fetchCalls = 0;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat],
    saveChatStore: () => { saveCount++; },
    getToken: () => null,
    dispatchChanged: () => {},
    apiUrl: '/api/chat-saved-replies',
    fetchImpl: async () => { fetchCalls++; return new Response('', { status: 200 }); },
  });
  engine.syncSavedReplyCreate(chat.id, reply);
  assert.equal(reply.syncState, 'pending');
  assert.equal(saveCount, 1);
  assert.equal(fetchCalls, 0);
});

test('create offline -> reload -> online: a later flush retries and syncs without a user re-click', async () => {
  // "Reload" is simulated by constructing a fresh engine instance against
  // the same underlying reply object — exactly what shell.ts does on a real
  // page load, since the engine itself holds no persisted state of its own.
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null };
  const chat = makeChat({ savedReplies: [reply] });
  const offlineEngine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => null,
    dispatchChanged: () => {}, apiUrl: '/api/x',
  });
  offlineEngine.syncSavedReplyCreate(chat.id, reply);
  assert.equal(reply.syncState, 'pending');

  let fetchCalls = 0;
  const reloadedEngine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => { fetchCalls++; return new Response(JSON.stringify({ duplicate: false, id: 'r1' }), { status: 200 }); },
  });
  reloadedEngine.flushPendingSavedReplySync(); // e.g. the 'online' trigger firing after reload
  await flushMicrotasks();
  assert.equal(fetchCalls, 1);
  assert.equal(reply.syncState, 'synced');
});

test('a non-ok POST response (e.g. an unresolved 409) marks the reply failed, never synced', async () => {
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null };
  const chat = makeChat({ savedReplies: [reply] });
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'conflict' } }), { status: 409 }),
  });
  engine.syncSavedReplyCreate(chat.id, reply);
  await flushMicrotasks();
  assert.equal(reply.syncState, 'failed');
});

test('a network failure (fetch rejects) marks the reply failed, not dropped', async () => {
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null };
  const chat = makeChat({ savedReplies: [reply] });
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  engine.syncSavedReplyCreate(chat.id, reply);
  await flushMicrotasks();
  assert.equal(reply.syncState, 'failed');
  assert.equal(chat.savedReplies.includes(reply), true); // never removed on failure
});

test('duplicate reconciliation renames the local id to the canonical server id and dispatches "reconciled"', async () => {
  const reply = { id: 'local1', text: 'hi', createdAt: 1, courseId: null };
  const chat = makeChat({ savedReplies: [reply] });
  let dispatched = null;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: (d) => { dispatched = d; }, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ duplicate: true, existingId: 'server1' }), { status: 200 }),
  });
  engine.syncSavedReplyCreate(chat.id, reply);
  await flushMicrotasks();
  assert.equal(chat.savedReplies[0].id, 'server1');
  assert.equal(chat.savedReplies[0].syncState, 'synced');
  assert.deepEqual(dispatched, { id: 'server1', replacedId: 'local1', action: 'reconciled' });
});

test('a stale failed POST cannot downgrade a reply a concurrent path already confirmed synced', async () => {
  // Simulates the real race: mergeSavedRepliesFromServer's GET confirms the
  // row while this POST is still in flight, then the POST resolves late
  // with a failure. Success must win.
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null, syncState: 'pending' };
  const chat = makeChat({ savedReplies: [reply] });
  let resolveFetch;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  engine.syncSavedReplyCreate(chat.id, reply);
  reply.syncState = 'synced'; // concurrent confirmation lands first
  resolveFetch(new Response('', { status: 500 })); // now the stale attempt fails
  await flushMicrotasks();
  assert.equal(reply.syncState, 'synced');
});

test('overlapping retry triggers never start two concurrent POSTs for the same reply', async () => {
  const reply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null, syncState: 'pending' };
  const chat = makeChat({ savedReplies: [reply] });
  let fetchCalls = 0;
  let resolveFetch;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: () => { fetchCalls++; return new Promise((resolve) => { resolveFetch = resolve; }); },
  });
  engine.flushPendingSavedReplySync(); // e.g. startup
  engine.flushPendingSavedReplySync(); // e.g. 'online' firing immediately after
  assert.equal(fetchCalls, 1);
  resolveFetch(new Response(JSON.stringify({ duplicate: false, id: 'r1' }), { status: 200 }));
  await flushMicrotasks();
  assert.equal(reply.syncState, 'synced');
});

test('a retry trigger arriving mid-cooldown is coalesced into one trailing flush, not dropped', async () => {
  const chat = makeChat();
  const flushCooldownMs = 60;
  let fetchCalls = 0;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs,
    fetchImpl: async () => { fetchCalls++; return new Response(JSON.stringify({ duplicate: false, id: 'x' }), { status: 200 }); },
  });
  engine.flushPendingSavedReplySync(); // consumes the cooldown window (nothing pending yet)
  chat.savedReplies.push({ id: 'r1', text: 'hi', createdAt: 1, courseId: null, syncState: 'pending' });
  engine.flushPendingSavedReplySync(); // mid-cooldown — must not be silently dropped
  assert.equal(fetchCalls, 0, 'the trailing flush has not fired yet');
  await flushMicrotasks(flushCooldownMs + 40);
  assert.equal(fetchCalls, 1, 'the coalesced trailing flush picked up the new pending reply');
});

// ── DELETE ─────────────────────────────────────────────────────────────

test('delete: no token leaves the tombstone untouched for the caller to retry once auth is ready', () => {
  const chat = makeChat({ pendingSavedReplyDeletes: { r1: 1000 } });
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => null,
    dispatchChanged: () => {}, apiUrl: '/api/x',
  });
  engine.syncSavedReplyDelete(chat.id, 'r1');
  assert.deepEqual(chat.pendingSavedReplyDeletes, { r1: 1000 });
});

test('delete offline -> reload: a failed DELETE keeps the tombstone; a later successful retry clears it', async () => {
  const chat = makeChat({ pendingSavedReplyDeletes: { r1: 1000 } });
  let succeed = false;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => new Response('', { status: succeed ? 200 : 500 }),
  });
  engine.syncSavedReplyDelete(chat.id, 'r1');
  await flushMicrotasks();
  assert.deepEqual(chat.pendingSavedReplyDeletes, { r1: 1000 }, 'tombstone survives a failed DELETE');

  // Simulated reload with a fresh engine instance, same tombstone still in the chat.
  succeed = true;
  const reloadedEngine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => new Response('', { status: 200 }),
  });
  reloadedEngine.flushPendingSavedReplySync();
  await flushMicrotasks();
  assert.deepEqual(chat.pendingSavedReplyDeletes, {}, 'confirmed durable delete clears the tombstone');
});

test('a network failure on DELETE keeps the tombstone in place', async () => {
  const chat = makeChat({ pendingSavedReplyDeletes: { r1: 1000 } });
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  engine.syncSavedReplyDelete(chat.id, 'r1');
  await flushMicrotasks();
  assert.deepEqual(chat.pendingSavedReplyDeletes, { r1: 1000 });
});

test('overlapping delete retries never start two concurrent DELETEs for the same id', async () => {
  const chat = makeChat({ pendingSavedReplyDeletes: { r1: 1 } });
  let fetchCalls = 0;
  let resolveFetch;
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: () => { fetchCalls++; return new Promise((resolve) => { resolveFetch = resolve; }); },
  });
  engine.syncSavedReplyDelete(chat.id, 'r1');
  engine.syncSavedReplyDelete(chat.id, 'r1'); // e.g. a second trigger firing before the first resolves
  assert.equal(fetchCalls, 1);
  resolveFetch(new Response('', { status: 200 }));
  await flushMicrotasks();
  assert.deepEqual(chat.pendingSavedReplyDeletes, {});
});

test('flushPendingSavedReplySync retries both pending creates and pending-delete tombstones together', async () => {
  const pendingReply = { id: 'r1', text: 'hi', createdAt: 1, courseId: null, syncState: 'failed' };
  const chat = makeChat({ savedReplies: [pendingReply], pendingSavedReplyDeletes: { r2: 1 } });
  const calls = [];
  const engine = createSavedReplySyncEngine({
    getChats: () => [chat], saveChatStore: () => {}, getToken: () => 'tok',
    dispatchChanged: () => {}, apiUrl: '/api/x', flushCooldownMs: 0,
    fetchImpl: async (url, init) => {
      calls.push(init.method);
      if (init.method === 'DELETE') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ duplicate: false, id: 'r1' }), { status: 200 });
    },
  });
  engine.flushPendingSavedReplySync();
  await flushMicrotasks();
  assert.equal(pendingReply.syncState, 'synced');
  assert.deepEqual(chat.pendingSavedReplyDeletes, {});
  assert.deepEqual(calls.sort(), ['DELETE', 'POST']);
});
