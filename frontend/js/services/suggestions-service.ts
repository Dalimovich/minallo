// Client for /api/suggestions — crowd-sourced major, Vertiefung, and course-name
// dropdown enrichment. See backend/functions/suggestions.ts.

function _authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (window._sbToken || ''),
  };
}

export type SuggestionKind = 'vertiefung' | 'course' | 'major';

export interface SuggestionItem {
  value: string;
  count: number;
}

export interface SuggestionContext {
  university?: string | null;
  universityName?: string | null;
  major?: string | null;
  vertiefung?: string | null;
}

export interface SuggestionSubmitResult {
  count: number;
  approved: boolean;
  accepted: boolean;
  reason?: string;
}

// Approved suggestions for a given (kind, parent). `parent` scopes the bucket
// — e.g. `Maschinenbau` so Vertiefung suggestions don't leak across majors.
// Empty/omitted parent uses the global bucket ('*').
export async function listSuggestions(
  kind: SuggestionKind,
  parent?: string | null
): Promise<SuggestionItem[]> {
  const q = new URLSearchParams({ kind });
  if (parent) q.set('parent', parent);
  try {
    const res = await fetch('/api/suggestions?' + q.toString(), {
      headers: _authHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: SuggestionItem[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

// Record that this user typed `value` as a (kind, parent). The server
// dedupes case-insensitively and auto-approves at threshold (5).
export async function submitSuggestion(
  kind: SuggestionKind,
  parent: string | null | undefined,
  value: string,
  context?: SuggestionContext
): Promise<SuggestionSubmitResult | null> {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  try {
    const res = await fetch('/api/suggestions', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ kind, parent: parent || '*', value: trimmed, context: context || {} }),
    });
    const data = (await res.json().catch(() => null)) as Partial<SuggestionSubmitResult> | null;
    if (!res.ok) {
      return {
        count: 0,
        approved: false,
        accepted: false,
        reason: data?.reason || 'not_accepted',
      };
    }
    return data as SuggestionSubmitResult;
  } catch {
    return null;
  }
}
