// Canonical parser for the `ss_ncb_chats_v1` localStorage payload.
//
// shell.ts (loadChatStore/saveChatStore) has only ever written this key as a
// bare SavedChat[] via compactChatsForStorage(). Any other reader must agree
// on that shape here instead of re-guessing it — a prior mismatch (a reader
// expecting `{ chats: [...] }`) silently made every bookmarked response
// invisible to the Saved panel. This module has no DOM/service dependencies
// so it can be imported by both the chat shell and any reader, and unit
// tested directly.

export type SavedReplySyncState = 'pending' | 'synced' | 'failed';

// The single normalizer for syncState wherever an untrusted or legacy value
// enters — loaded from localStorage, read off a server row, or serialized
// for storage. A field declared on a type but re-guessed independently at
// each read/write boundary is exactly how syncState was once silently
// dropped by the serializer that actually writes localStorage: the type
// said it persisted, but the code that built the stored object forgot the
// field. Both the write side (compactChatForStorage) and the read side
// (loadChatStore's migration) must call this one function, not reimplement
// the same three-way check independently.
export function normalizeSavedReplySyncState(state: unknown): SavedReplySyncState {
  return state === 'pending' || state === 'failed' ? state : 'synced';
}

export interface PersistedSavedReply {
  id?: string;
  text?: string;
  createdAt?: number;
  courseId?: string | null;
  sourceMessageId?: string;
  sourcePrompt?: string;
  chatId?: string;
  // Durable-sync bookkeeping: absent/'synced' means the durable server copy
  // is confirmed (or this is legacy data predating this field); 'pending'/
  // 'failed' mark a reply that still needs a retry attempt.
  syncState?: SavedReplySyncState;
}

export interface PersistedChat {
  id?: string;
  title?: string;
  savedReplies?: PersistedSavedReply[];
}

// The `minallo:saved-replies-changed` event contract. A 'created' (or
// repaired-duplicate) event must carry the full bookmark so the Saved panel
// can render it immediately, without racing the debounced localStorage write
// or re-reading a store that may still be stale.
export interface SavedBookmarkEventPayload {
  id: string;
  text: string;
  createdAt: number;
  courseId: string | null;
  sourceMessageId?: string;
  sourcePrompt?: string;
  chatId: string;
}

export interface SavedRepliesChangedDetail {
  action: 'created' | 'reconciled' | 'deleted';
  bookmark?: SavedBookmarkEventPayload;
  id?: string;
  replacedId?: string;
}

/**
 * Parses the raw `ss_ncb_chats_v1` JSON into the chat list it actually
 * contains. The `{ chats: [...] }` branch is kept only as defensive
 * back-compat for a hand-corrupted or foreign payload — the array branch is
 * the one real writers produce and must stay first/authoritative.
 */
export function parsePersistedChats(raw: string | null | undefined): PersistedChat[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed as PersistedChat[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { chats?: unknown }).chats)) {
    return (parsed as { chats: PersistedChat[] }).chats;
  }
  return [];
}
