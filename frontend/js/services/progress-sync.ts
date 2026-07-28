// Persistence layer for study progress (per-course) and study lounge stats.
// All writes are fire-and-forget — localStorage is the primary read path.
// On login / ss-ready, loadAndHydrate() pulls from DB → writes to localStorage
// so existing rendering code sees up-to-date data without any changes.

declare const window: Window & {
  _SUPA?: string;
  _SAKEY?: string;
  _sbToken?: string;
  _currentUser?: { id?: string; sub?: string } | null;
  _loungeRender?: () => void;
  _progressSync?: typeof _progressSync;
};

export interface LoungeStatsRow {
  studyMinutes: number;
  filesOpened: string[];
  coursesStudied: string[];
  aiMessages: number;
  gamesPlayed: number;
  streak: number;
  lastDate: string;
  recentFiles: Array<{ name: string; course?: string; ts: number }>;
}

function _uid(): string {
  const u = window._currentUser;
  return (u && (u.id || u.sub)) || '';
}

function _base(): string {
  return (window._SUPA || '') + '/rest/v1/';
}

function _headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: window._SAKEY || '',
    Authorization: 'Bearer ' + (window._sbToken || ''),
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Upsert the full lounge stats row. Fire-and-forget. */
export function syncLoungeStats(stats: LoungeStatsRow): void {
  const uid = _uid();
  if (!uid || !window._SUPA) return;
  void fetch(_base() + 'study_lounge_stats', {
    method: 'POST',
    headers: _headers({ Prefer: 'return=minimal,resolution=merge-duplicates' }),
    body: JSON.stringify({
      user_id: uid,
      study_minutes: stats.studyMinutes,
      files_opened: stats.filesOpened,
      courses_studied: stats.coursesStudied,
      ai_messages: stats.aiMessages,
      games_played: stats.gamesPlayed,
      streak: stats.streak,
      last_date: stats.lastDate,
      recent_files: stats.recentFiles,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

/** Upsert the opened-files list and last-opened timestamp for a course. Fire-and-forget. */
export function syncCourseProgress(
  courseId: string,
  openedFiles: string[],
  lastOpenedAtMs: number
): void {
  const uid = _uid();
  if (!uid || !window._SUPA || !courseId) return;
  // on_conflict targets the (user_id, course_id) unique key — without it
  // PostgREST resolves the merge on the PK (id), so a repeat open of any file in
  // an already-synced course 409s instead of updating.
  void fetch(_base() + 'course_progress?on_conflict=user_id,course_id', {
    method: 'POST',
    headers: _headers({ Prefer: 'return=minimal,resolution=merge-duplicates' }),
    body: JSON.stringify({
      user_id: uid,
      course_id: courseId,
      opened_files: openedFiles,
      last_opened_at: new Date(lastOpenedAtMs).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

/** Upsert the AI session count for a course. Fire-and-forget. */
export function syncCourseAiSessions(courseId: string, sessionCount: number): void {
  const uid = _uid();
  if (!uid || !window._SUPA || !courseId) return;
  void fetch(_base() + 'course_progress?on_conflict=user_id,course_id', {
    method: 'POST',
    headers: _headers({ Prefer: 'return=minimal,resolution=merge-duplicates' }),
    body: JSON.stringify({
      user_id: uid,
      course_id: courseId,
      ai_sessions: sessionCount,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

/** Load all persisted data from DB and hydrate localStorage. Awaitable but
 *  also safe to call fire-and-forget. Triggers a lounge re-render when done. */
export async function loadAndHydrate(): Promise<void> {
  const uid = _uid();
  if (!uid || !window._SUPA) return;

  const readHeaders: Record<string, string> = {
    apikey: window._SAKEY || '',
    Authorization: 'Bearer ' + (window._sbToken || ''),
  };

  const [loungeRes, progressRes] = await Promise.all([
    fetch(_base() + 'study_lounge_stats?user_id=eq.' + encodeURIComponent(uid) + '&limit=1', {
      headers: readHeaders,
    }).catch(() => null),
    fetch(_base() + 'course_progress?user_id=eq.' + encodeURIComponent(uid) + '&limit=200', {
      headers: readHeaders,
    }).catch(() => null),
  ]);

  if (loungeRes?.ok) {
    const rows: unknown[] = await loungeRes.json().catch(() => []);
    const row = Array.isArray(rows) && rows.length ? (rows[0] as Record<string, unknown>) : null;
    if (row) {
      const stats: LoungeStatsRow = {
        studyMinutes: (row.study_minutes as number) || 0,
        filesOpened: (row.files_opened as string[]) || [],
        coursesStudied: (row.courses_studied as string[]) || [],
        aiMessages: (row.ai_messages as number) || 0,
        gamesPlayed: (row.games_played as number) || 0,
        streak: (row.streak as number) || 0,
        lastDate: (row.last_date as string) || '',
        recentFiles: (row.recent_files as LoungeStatsRow['recentFiles']) || [],
      };
      try { localStorage.setItem('ss_stats', JSON.stringify(stats)); } catch { /* quota */ }
    }
  }

  if (progressRes?.ok) {
    const rows: unknown[] = await progressRes.json().catch(() => []);
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const cid = row.course_id as string | undefined;
        if (!cid) continue;
        try {
          const files = row.opened_files as string[] | undefined;
          if (Array.isArray(files) && files.length) {
            localStorage.setItem('ss_opened_' + cid, JSON.stringify(files));
          }
          const lastOpenedAt = row.last_opened_at as string | undefined;
          if (lastOpenedAt) {
            localStorage.setItem('ss_lastopen_' + cid, String(new Date(lastOpenedAt).getTime()));
          }
          const aiSessions = row.ai_sessions as number | undefined;
          if (typeof aiSessions === 'number' && aiSessions > 0) {
            // Reconstruct ss_course_qa_ count — only set if DB has MORE data than local
            const localKey = 'ss_course_qa_' + cid;
            try {
              const local = JSON.parse(localStorage.getItem(localKey) || '[]') as unknown[];
              if (aiSessions > local.length) {
                // Pad with placeholder entries so progress calculation uses DB count
                const padded = Array.from({ length: aiSessions }, (_, i) =>
                  local[i] ?? { q: '', a: '', ts: 0 }
                );
                localStorage.setItem(localKey, JSON.stringify(padded));
              }
            } catch { /* corrupted — leave as-is */ }
          }
        } catch { /* quota */ }
      }
    }
  }

  // Re-render lounge if it's currently visible
  if (typeof window._loungeRender === 'function') window._loungeRender();
}

// ── Self-init ─────────────────────────────────────────────────────────────────

const _progressSync = { syncLoungeStats, syncCourseProgress, syncCourseAiSessions, loadAndHydrate };
window._progressSync = _progressSync;

// Path 1: page reload with existing session — ss-ready fires after auth is
// confirmed AND after all core scripts (including this one) are loaded.
window.addEventListener('ss-ready', () => {
  if (_uid()) void loadAndHydrate();
}, { once: true });
