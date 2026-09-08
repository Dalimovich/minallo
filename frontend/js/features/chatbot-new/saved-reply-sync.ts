// Durable-sync engine for "Saved AI response" bookmarks — the create/delete
// mutation queue that used to live inline in shell.ts. Pulled out into its
// own module, with no DOM/window/document dependencies, specifically so the
// lifecycle (offline retry, in-flight dedupe, delete tombstones, coalesced
// retry triggers) can be exercised by real executable tests instead of
// regex assertions against shell.ts's source text — see
// tests/frontend/saved-reply-sync-engine.test.mjs.
//
// shell.ts owns the actual chatStore/localStorage/DOM; this module only
// operates on whatever SyncableSavedChat[] and callbacks it's handed via
// createSavedReplySyncEngine(deps).

import type { SavedReplySyncState, SavedRepliesChangedDetail } from './chat-store-format.js';

export interface SyncableSavedReply {
  id: string;
  text: string;
  createdAt: number;
  courseId: string | null;
  sourceMessageId?: string;
  sourcePrompt?: string;
  chatId?: string;
  syncState?: SavedReplySyncState;
}

export interface SyncableSavedChat {
  id: string;
  savedReplies: SyncableSavedReply[];
  pendingSavedReplyDeletes: Record<string, number>;
}

export interface SavedReplySyncDeps {
  getChats: () => SyncableSavedChat[];
  saveChatStore: () => void;
  getToken: () => string | null | undefined;
  dispatchChanged: (detail: SavedRepliesChangedDetail) => void;
  apiUrl: string;
  /** Defaults to the global fetch — overridden by tests. */
  fetchImpl?: typeof fetch;
  /** Defaults to 2000ms — overridden by tests that don't want to wait. */
  flushCooldownMs?: number;
}

export interface SavedReplySyncEngine {
  syncSavedReplyCreate: (chatId: string, r: SyncableSavedReply) => void;
  syncSavedReplyDelete: (chatId: string, id: string) => void;
  flushPendingSavedReplySync: () => void;
}

export function createSavedReplySyncEngine(deps: SavedReplySyncDeps): SavedReplySyncEngine {
  const { getChats, saveChatStore, getToken, dispatchChanged, apiUrl } = deps;
  const fetchImpl = deps.fetchImpl || fetch;
  const flushCooldownMs = deps.flushCooldownMs ?? 2000;

  // One in-flight POST per reply object — otherwise two retry triggers
  // firing close together (e.g. 'online' and an auth-ready event) can both
  // start a request for the same still-pending reply. Keyed on the reply
  // object itself (stable for its lifetime, survives the id being rewritten
  // during duplicate reconciliation below) rather than a string id.
  const createInFlight = new Set<SyncableSavedReply>();
  // One in-flight DELETE per reply id, same rationale.
  const deleteInFlight = new Set<string>();

  let lastFlushAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Bookmark has two guarantees: (1) immediate local visibility — already
  // true by the time this is called — and (2) eventual durable persistence.
  // This function attempts (2) but must never be the only attempt: a
  // missing token or a failed POST leaves the reply's syncState so
  // flushPendingSavedReplySync retries it later instead of the durable copy
  // silently never existing.
  function syncSavedReplyCreate(chatId: string, r: SyncableSavedReply): void {
    if (createInFlight.has(r)) return;
    r.syncState = 'pending';
    const token = getToken();
    if (!token) {
      saveChatStore();
      return; // retried by flushPendingSavedReplySync once auth is ready
    }
    const requestedId = r.id;
    createInFlight.add(r);
    void fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        id: r.id, chatId, text: r.text, createdAt: r.createdAt,
        courseId: r.courseId, sourceMessageId: r.sourceMessageId, sourcePrompt: r.sourcePrompt
      }),
    }).then(async (response) => {
      if (!response.ok) {
        // A newer concurrent attempt (e.g. a server GET that already
        // confirmed this exact reply) must not be downgraded by this now-stale failure.
        if (r.syncState !== 'synced') { r.syncState = 'failed'; saveChatStore(); }
        return;
      }
      const result = await response.json() as { duplicate?: boolean; existingId?: string };
      if (!result.duplicate || !result.existingId || result.existingId === requestedId) {
        r.syncState = 'synced';
        saveChatStore();
        return;
      }
      const chat = getChats().find((candidate) => candidate.id === chatId);
      const local = chat?.savedReplies.find((candidate) => candidate.id === requestedId);
      if (!chat || !local) return;
      const canonical = chat.savedReplies.find((candidate) => candidate.id === result.existingId);
      if (canonical) {
        canonical.syncState = 'synced';
        chat.savedReplies = chat.savedReplies.filter((candidate) => candidate !== local);
      } else {
        local.id = result.existingId;
        local.syncState = 'synced';
      }
      saveChatStore();
      dispatchChanged({ id: result.existingId, replacedId: requestedId, action: 'reconciled' });
    }).catch(() => {
      // offline / network failure — the local copy is intact; syncState
      // stays 'pending' so flushPendingSavedReplySync retries on the next trigger.
      if (r.syncState !== 'synced') { r.syncState = 'failed'; saveChatStore(); }
    }).finally(() => {
      createInFlight.delete(r);
    });
  }

  function syncSavedReplyDelete(chatId: string, id: string): void {
    if (deleteInFlight.has(id)) return;
    const token = getToken();
    if (!token) return; // caller already persisted a pendingSavedReplyDeletes tombstone; retried once auth is ready
    deleteInFlight.add(id);
    void fetchImpl(apiUrl + '?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    }).then((response) => {
      if (!response.ok) return; // tombstone stays; retried by flushPendingSavedReplySync
      const chat = getChats().find((c) => c.id === chatId);
      if (chat && Object.prototype.hasOwnProperty.call(chat.pendingSavedReplyDeletes, id)) {
        delete chat.pendingSavedReplyDeletes[id];
        saveChatStore();
      }
    }).catch(() => {
      // offline / network failure — tombstone stays; retried by
      // flushPendingSavedReplySync. Until it clears, the caller's server
      // merge must refuse to let a stale server row resurrect this id.
    }).finally(() => {
      deleteInFlight.delete(id);
    });
  }

  // Retry triggers (auth ready, back online, Saved panel opened, chat-store
  // load) call this instead of reaching into the chat list themselves.
  // Bounded and event-driven, never a poll: it only re-attempts replies
  // already marked 'pending'/'failed' plus any unresolved delete
  // tombstones, and the cooldown collapses bursts of near-simultaneous
  // triggers (e.g. 'online' and an auth-ready event firing together) into
  // one pass. The backend's source-message/content-fingerprint dedupe (see
  // syncSavedReplyCreate's duplicate-reconcile branch) makes a redundant
  // retry of an already-synced reply safe, so this never needs to be
  // perfectly precise.
  function flushPendingSavedReplySync(): void {
    if (!getToken()) return;
    const now = Date.now();
    const elapsed = now - lastFlushAt;
    if (elapsed < flushCooldownMs) {
      // A trigger arriving mid-cooldown must not be silently dropped —
      // schedule exactly one trailing flush for when the cooldown ends
      // rather than discarding it and depending on some unrelated later trigger.
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushPendingSavedReplySync();
        }, flushCooldownMs - elapsed);
      }
      return;
    }
    lastFlushAt = now;
    for (const chat of getChats()) {
      for (const reply of chat.savedReplies) {
        if (reply.syncState === 'pending' || reply.syncState === 'failed') {
          syncSavedReplyCreate(reply.chatId || chat.id, reply);
        }
      }
      for (const id of Object.keys(chat.pendingSavedReplyDeletes || {})) {
        syncSavedReplyDelete(chat.id, id);
      }
    }
  }

  return { syncSavedReplyCreate, syncSavedReplyDelete, flushPendingSavedReplySync };
}
