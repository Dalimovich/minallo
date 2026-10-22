// Thin, DOM-independent access point for the real saved-reply delete flow,
// so callers outside the chat surface (the Saved panel's per-item delete
// control in workspace-library.ts) can reach it without importing shell.ts
// itself. shell.ts is a large monolith that owns chatStore/localStorage/DOM
// wiring; workspace-library.ts importing from it created an unwanted
// dependency from the library/Saved surface back onto the chat surface.
//
// shell.ts registers the real engine (built by createSavedReplySyncEngine in
// saved-reply-sync.ts, the actual DOM-independent implementation) once at
// module init via setSavedReplyEngine(). Until that happens — or if this is
// somehow called from a context where the chat shell was never mounted —
// deleteSavedReplyById resolves to `false` rather than throwing.
import type { SavedReplySyncEngine } from './saved-reply-sync.js';

let activeEngine: SavedReplySyncEngine | null = null;

export function setSavedReplyEngine(engine: SavedReplySyncEngine): void {
  activeEngine = engine;
}

export async function deleteSavedReplyById(chatId: string, id: string): Promise<boolean> {
  if (!activeEngine) return false;
  return activeEngine.deleteSavedReplyById(chatId, id);
}
