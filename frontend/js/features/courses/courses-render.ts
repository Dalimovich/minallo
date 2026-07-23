import { panelHide } from '../../core/panels.js';
import {
  applyCoursesLayoutPrefs,
  getCoursesLayoutPrefs,
  sortCoursesByLayout
} from './courses-layout.js';
import type { LegacyCourse } from '../../../globals.js';

interface CoursesRenderState {
  SEMS: Record<string, { color?: string; courses: LegacyCourse[] }>;
  COLORS: string[];
  activeSemId: string;
  activeCourseId: string | null;
  sdActiveSemId: string;
  _cameFromStudip: boolean;
}

// Reads the per-course "opened files" set that app.ts writes on each openFile().
// Returns the count clipped to total so a stale entry (file later deleted from
// the course) doesn't push the progress past 100%.
function _openedCount(courseId: string, total: number): number {
  if (!total) return 0;
  try {
    const raw = localStorage.getItem('ss_opened_' + courseId);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    return Math.min(arr.length, total);
  } catch { return 0; }
}

// Number of AI sessions tied to this course = count of saved Q/A pairs in the
// per-course chat history bucket (ss_course_qa_<id>). Treated as both "total"
// and "reviewed" since we don't track a separate "reviewed" flag yet.
function _aiSessionCount(courseId: string): number {
  try {
    const raw = localStorage.getItem('ss_course_qa_' + courseId);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

function _lastOpenedLabel(courseId: string): string {
  let ts = 0;
  try { ts = Number(localStorage.getItem('ss_lastopen_' + courseId) || 0); } catch { /* skip */ }
  if (!ts) return 'Not started';
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  return Math.floor(days / 30) + 'mo ago';
}

function _safePercent(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

// Per-course progress object matching the brief's CourseDashboardData shape,
// populated from the signals we actually have. Fields with no source yet
// (notes, exercises, weak topics) are returned as null so the UI can hide
// the sub-stat instead of showing a fake 0%.
export interface CourseProgress {
  files: number;
  studiedFiles: number;
  unreadFilesCount: number;
  readingProgress: number;
  notesProgress: number | null;
  practiceProgress: number | null;
  aiReviewProgress: number | null;
  aiSessions: number;
  total: number;
  lastOpened: string;
}

export function computeCourseProgress(courseId: string, files: number): CourseProgress {
  return _computeProgress(courseId, files);
}

function _computeProgress(courseId: string, files: number): CourseProgress {
  const studiedFiles = _openedCount(courseId, files);
  const aiSessions = _aiSessionCount(courseId);
  const readingProgress = _safePercent(studiedFiles, files);
  // AI: cap "enough sessions" at 8 so users with active chat hit 100% quickly.
  // We don't have a real total; this is an honest heuristic, not a fake metric.
  const aiReviewProgress = aiSessions > 0 ? _safePercent(Math.min(aiSessions, 8), 8) : null;
  // The brief averages 4 components weighted 0.4/0.25/0.2/0.15. We only have
  // 2 right now (reading, AI), so we renormalise over present buckets to
  // avoid showing 0% just because notes/practice tracking doesn't exist.
  const parts: Array<{ value: number; weight: number }> = [
    { value: readingProgress, weight: 0.4 },
  ];
  if (aiReviewProgress !== null) parts.push({ value: aiReviewProgress, weight: 0.15 });
  const sumWeights = parts.reduce((s, p) => s + p.weight, 0);
  const total = sumWeights > 0
    ? Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / sumWeights)
    : 0;
  return {
    files,
    studiedFiles,
    unreadFilesCount: Math.max(0, files - studiedFiles),
    readingProgress,
    notesProgress: null,
    practiceProgress: null,
    aiReviewProgress,
    aiSessions,
    total,
    lastOpened: _lastOpenedLabel(courseId),
  };
}

function _hydrateCardCount(
  courseId: string,
  badge: HTMLElement,
  initialCount: number,
  onCountChanged?: (newCount: number) => void
): void {
  const _applyBadge = (n: number): void => {
    if (badge.isConnected) badge.textContent = n + ' file' + (n !== 1 ? 's' : '');
  };
  // The chip badge and the card body (progress block vs "No files yet") were
  // computed from the same initialCount at render time. If hydration discovers
  // a different number, patching only the badge leaves the body stale —
  // showing "10 files" in the chip but "No files yet" below. Whenever the
  // resolved count differs from initialCount, the caller re-renders so the
  // body is rebuilt from the new count.
  const _maybeRerender = (n: number): void => {
    if (n !== initialCount && onCountChanged) onCountChanged(n);
  };
  // Keep dashboard rendering local-only. Opening a course refreshes real files.
  try {
    const cached = localStorage.getItem('ss_fc_' + courseId);
    if (cached != null) {
      const n = Number(cached);
      if (Number.isFinite(n)) {
        _applyBadge(n);
        _maybeRerender(n);
      }
    }
  } catch { /* quota / parse */ }
}

export function renderCourses(state: CoursesRenderState): void {
  const cl = document.getElementById('courseList');
  if (!cl) return;
  cl.innerHTML = '';
  const sem = state.SEMS[state.activeSemId];
  if (!sem) return;
  sem.courses.forEach((c, i) => {
    const col = state.COLORS[i % state.COLORS.length] || '#2563EB';
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'course-row' + (state.activeCourseId === c.id ? ' active' : '');

    const bar = document.createElement('div');
    bar.className = 'cr-bar';
    bar.style.background = col;

    const info = document.createElement('div');
    info.className = 'cr-info';

    const name = document.createElement('div');
    name.className = 'cr-name';
    name.textContent = c.name;

    const meta = document.createElement('div');
    meta.className = 'cr-meta';
    meta.textContent = c.meta || '';

    info.append(name, meta);
    row.append(bar, info);

    row.addEventListener('click', () => {
      if (state.activeCourseId === c.id) {
        state.activeCourseId = null;
        panelHide(document.getElementById('courseOverview'));
        const crumb = document.getElementById('breadcrumb');
        if (crumb) crumb.textContent = 'Courses';
        renderCourses(state);
      } else {
        state._cameFromStudip = false;
        if (typeof window.openCourse === 'function') window.openCourse(c);
      }
    });

    wrap.appendChild(row);
    cl.appendChild(wrap);
  });
}

function _buildStatPill(label: string, value: string, accent: string): string {
  return (
    '<div class="sd-stat-pill" style="--sd-stat-accent:' + accent + '">' +
      '<div class="sd-stat-label">' + label + '</div>' +
      '<div class="sd-stat-value">' + value + '</div>' +
    '</div>'
  );
}

export function sdRenderCourses(state: CoursesRenderState): void {
  const cl = document.getElementById('sdCourseList');
  if (!cl) return;
  _renderDailyMissionPreview(state, cl);
  cl.innerHTML = '';
  applyCoursesLayoutPrefs();
  const sem = state.SEMS[state.sdActiveSemId];
  if (!sem) {
    _renderNextStepsBelowGrid(null);
    _updateHeroStats(state, []);
    return;
  }
  if (!sem.courses.length) {
    const empty = document.createElement('div');
    empty.className = 'sd-empty-state';
    empty.innerHTML =
      '<div class="sd-empty-icon">📚</div>' +
      '<div class="sd-empty-title">No subjects yet</div>' +
      '<div class="sd-empty-sub">Use the search above to add the courses you\'re taking this semester.</div>';
    cl.appendChild(empty);
    _renderNextStepsBelowGrid(null);
    _updateHeroStats(state, []);
    return;
  }

  const progressByCourse: Array<{ course: LegacyCourse; progress: CourseProgress }> = [];
  const layoutPrefs = getCoursesLayoutPrefs();
  const courses = sortCoursesByLayout(sem.courses, layoutPrefs.sort);

  courses.forEach((c, i) => {
    const col = state.COLORS[i % state.COLORS.length] || '#2563EB';
    const card = document.createElement('article');
    card.className = 'sd-course-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Open ' + c.name);
    card.style.setProperty('--sd-card-accent', col);

    const folderCount = (c.userFolders || []).reduce(
      (s, fd) => s + (fd.files ? fd.files.length : 0), 0
    );
    const liveCount = (c.files?.length || 0) + folderCount;
    let cachedCount = 0;
    if (!liveCount) {
      try {
        const ufc = JSON.parse(localStorage.getItem('ss_uf_cache_' + c.id) || 'null');
        if (ufc) {
          cachedCount =
            (ufc.files || []).length +
            (ufc.folders || []).reduce(
              (s: number, fd: { files?: unknown[] }) => s + (fd.files ? fd.files.length : 0), 0
            );
        }
      } catch { /* corrupted cache */ }
    }
    const count =
      liveCount || cachedCount || parseInt(localStorage.getItem('ss_fc_' + c.id) || '0', 10);

    const progress = _computeProgress(c.id, count);
    try { localStorage.setItem('ss_progress_total_' + c.id, String(progress.total)); } catch { /* quota */ }
    progressByCourse.push({ course: c, progress });

    const safeName = (c.name || '').replace(/[<>&"]/g, (s) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[s] || s));

    // Per-card subject icon. Brief uses emojis (📘 📐 ⚙️ 🏭 📙). We don't store
    // a per-course icon, so derive one from a simple keyword match on the name;
    // falls back to a book icon. Pure decoration — name is the real identifier.
    const _pickCourseIcon = (name: string): string => {
      const n = name.toLowerCase();
      if (/mechan|statik|dynamik/.test(n)) return '📘';
      if (/konstru|cad|design/.test(n)) return '📐';
      if (/maschin|antrieb|getriebe/.test(n)) return '⚙️';
      if (/fertig|product|manufact/.test(n)) return '🏭';
      if (/elektro|electric|schalt/.test(n)) return '⚡';
      if (/mathe|math|analysis/.test(n)) return '📊';
      if (/inform|programm|code/.test(n)) return '💻';
      if (/chem/.test(n)) return '🧪';
      if (/physi/.test(n)) return '🔬';
      if (/sprach|deutsch|german|englisch/.test(n)) return '🗣';
      return '📙';
    };
    const courseIcon = _pickCourseIcon(c.name || '');

    const statsHtml = count > 0
      ? '<div class="sd-stat-row">' +
          _buildStatPill('Read', progress.readingProgress + '%', col) +
          _buildStatPill('Notes', (progress.notesProgress ?? 0) + '%', col) +
          _buildStatPill('Practice', (progress.practiceProgress ?? 0) + '%', col) +
          _buildStatPill('AI', (progress.aiReviewProgress ?? 0) + '%', col) +
        '</div>'
      : '';

    const progressBlock = count > 0
      ? '<div class="sd-course-progress">' +
          '<div class="sd-course-progress-head">' +
            '<span class="sd-course-progress-label">Study progress</span>' +
            '<span class="sd-course-progress-value">' + progress.total + '%</span>' +
          '</div>' +
          '<div class="sd-course-progress-track">' +
            '<div class="sd-course-progress-fill" style="width:' + progress.total + '%"></div>' +
          '</div>' +
        '</div>'
      : '<div class="sd-course-empty-msg">' +
          '<svg class="sd-course-empty-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<div>' +
            '<div class="sd-course-empty-msg-title">No files yet</div>' +
            '<div class="sd-course-empty-msg-sub">Upload lectures, exercises, or formula sheets to start.</div>' +
          '</div>' +
        '</div>';

    const lastOpenedHtml =
      '<span class="sd-course-chip sd-course-chip-time">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>' +
        '<span>' + progress.lastOpened + '</span>' +
      '</span>';

    // The Stats button keeps the .sd-course-summary-btn class on purpose:
    // courses-redesign.css is immutable-cached under a ?v= only bumped via
    // loader.js, so renaming the class would leave returning users with an
    // unstyled button until their CSS cache turns over.
    const actionsHtml =
      '<div class="sd-course-actions">' +
        '<button type="button" class="sd-course-summary-btn" data-course-stats>' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' +
          '<span>Stats</span>' +
        '</button>' +
        '<button type="button" class="sd-course-open-btn" data-open-course>Open course</button>' +
      '</div>';

    card.innerHTML =
      '<div class="sd-course-bar"></div>' +
      '<button type="button" class="sd-del-btn" aria-label="Remove course" title="Remove">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' +
      '</button>' +
      '<header class="sd-course-head">' +
        '<div class="sd-course-icon" aria-hidden="true">' + courseIcon + '</div>' +
        '<div class="sd-course-head-text">' +
          '<h3 class="sd-course-name">' + safeName + '</h3>' +
          '<div class="sd-course-chips">' +
            '<span class="sd-course-chip sd-course-chip-files" data-file-badge>' + count + ' file' + (count !== 1 ? 's' : '') + '</span>' +
            lastOpenedHtml +
          '</div>' +
        '</div>' +
      '</header>' +
      progressBlock +
      statsHtml +
      actionsHtml;

    const badgeEl = card.querySelector<HTMLElement>('[data-file-badge]');
    if (!liveCount && badgeEl) {
      _hydrateCardCount(c.id, badgeEl, count, (newCount) => {
        // Body was rendered for the old count (e.g. "No files yet" when the
        // cache said 0). Re-render the whole grid so the progress block
        // matches the freshly-fetched count.
        if (newCount !== count) sdRenderCourses(state);
      });
    }

    if (count === 0) card.classList.add('sd-course-card-empty');

    const delBtn = card.querySelector<HTMLButtonElement>('.sd-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        if (!window.confirm('Delete ' + c.name + '?\n\nThis will remove the course from your list. Uploaded files in Supabase storage are not deleted by this action.')) return;
        const list = state.SEMS[state.sdActiveSemId]?.courses;
        const removeIndex = list?.findIndex((item) => item.id === c.id) ?? -1;
        if (list && removeIndex >= 0) list.splice(removeIndex, 1);
        if (typeof window._saveUserCourses === 'function') window._saveUserCourses();
        sdRenderCourses(state);
      });
    }

    function _open(): void {
      if (typeof window.hideStudip === 'function') window.hideStudip();
      state._cameFromStudip = true;
      state.activeSemId = state.sdActiveSemId;
      renderCourses(state);
      if (typeof window.openCourse === 'function') window.openCourse(c);
    }

    card.querySelector<HTMLButtonElement>('[data-course-stats]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _openCourseStatsModal(c, progress, col, courseIcon);
    });
    card.querySelector<HTMLButtonElement>('[data-open-course]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _open();
    });

    card.addEventListener('click', _open);
    card.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _open();
      }
    });

    cl.appendChild(card);
  });

  _renderNextStepsBelowGrid(progressByCourse);
  _updateHeroStats(state, progressByCourse);
  applyCoursesLayoutPrefs();
}

// ── Course stats modal ───────────────────────────────────────────────────────
// Opened from the Stats button on each course card. Rendered onto document.body
// (outside #psec-studip), so its styles are injected from JS — same pattern as
// study-timer / message-navigator — which also means the feature ships
// atomically with this module instead of needing a courses-redesign.css ?v=
// bump through loader.js.

function _ensureStatsModalCss(): void {
  if (document.getElementById('sdStatsModalCss')) return;
  const s = document.createElement('style');
  s.id = 'sdStatsModalCss';
  s.textContent =
    '.sd-stats-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(2,6,23,.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:sdStatsFade .18s ease}' +
    '@keyframes sdStatsFade{from{opacity:0}to{opacity:1}}' +
    '@keyframes sdStatsRise{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}' +
    '@keyframes sdStatsSheet{from{transform:translateY(100%)}to{transform:translateY(0)}}' +
    '.sd-stats-modal{--sd-stats-accent:#2563eb;position:relative;width:min(500px,100%);max-height:min(86vh,700px);overflow-y:auto;box-sizing:border-box;padding:26px;border-radius:24px;border:1px solid rgba(255,255,255,.1);background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015)),#0b1223;color:#e2e8f0;box-shadow:0 32px 90px -18px rgba(0,0,0,.65);animation:sdStatsRise .24s cubic-bezier(.22,1,.36,1);font-family:inherit;overscroll-behavior:contain}' +
    '.sd-stats-modal::before{content:"";display:none}' +
    '.sd-stats-modal::-webkit-scrollbar{width:6px}' +
    '.sd-stats-modal::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}' +
    '.sd-stats-close{position:absolute;top:16px;right:16px;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#cbd5e1;cursor:pointer;transition:background .15s ease,color .15s ease}' +
    '.sd-stats-close:hover{background:rgba(255,255,255,.12);color:#fff}' +
    '.sd-stats-head{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-right:44px}' +
    '.sd-stats-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;flex:0 0 auto;border-radius:14px;font-size:1.4rem;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06)}' +
    '.sd-stats-head-text{min-width:0}' +
    '.sd-stats-title{margin:0 0 4px;font-size:1.15rem;font-weight:800;color:#fff;line-height:1.3;overflow-wrap:anywhere}' +
    '.sd-stats-sub{font-size:.82rem;color:rgba(226,232,240,.6)}' +
    '.sd-stats-hero{display:flex;align-items:center;gap:22px;margin-bottom:22px}' +
    '.sd-stats-ring{position:relative;width:124px;height:124px;flex:0 0 auto}' +
    '.sd-stats-ring svg{width:100%;height:100%;transform:rotate(-90deg)}' +
    '.sd-stats-ring-track{fill:none;stroke:rgba(255,255,255,.08);stroke-width:11}' +
    '.sd-stats-ring-fill{fill:none;stroke:var(--sd-stats-accent);stroke-width:11;stroke-linecap:round}' +
    '.sd-stats-ring-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}' +
    '.sd-stats-ring-label strong{font-size:1.5rem;font-weight:800;color:#fff;line-height:1}' +
    '.sd-stats-ring-label span{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(226,232,240,.55)}' +
    '.sd-stats-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;flex:1;min-width:0}' +
    '.sd-stats-tile{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04)}' +
    '.sd-stats-tile-value{font-size:1.05rem;font-weight:800;color:#fff}' +
    '.sd-stats-tile-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:rgba(226,232,240,.55)}' +
    '.sd-stats-rows{display:flex;flex-direction:column;gap:14px}' +
    '.sd-stats-row-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}' +
    '.sd-stats-row-label{font-size:.85rem;font-weight:700;color:#e2e8f0}' +
    '.sd-stats-row-value{font-size:.85rem;font-weight:800;color:#fff}' +
    '.sd-stats-row.is-untracked .sd-stats-row-value{color:rgba(226,232,240,.45)}' +
    '.sd-stats-row-track{height:8px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}' +
    '.sd-stats-row-fill{height:100%;border-radius:999px;background:var(--sd-stats-accent);transition:width .5s cubic-bezier(.22,1,.36,1)}' +
    '.sd-stats-row-hint{margin-top:5px;font-size:.74rem;color:rgba(226,232,240,.5)}' +
    'body:not(.night) .sd-stats-overlay{background:rgba(15,23,42,.45)}' +
    'body:not(.night) .sd-stats-modal{background:#fff;border-color:rgba(15,23,42,.08);color:#1e293b;box-shadow:0 32px 90px -30px rgba(15,23,42,.35)}' +
    'body:not(.night) .sd-stats-title{color:#0f172a}' +
    'body:not(.night) .sd-stats-sub{color:#64748b}' +
    'body:not(.night) .sd-stats-close{background:rgba(15,23,42,.05);border-color:rgba(15,23,42,.08);color:#475569}' +
    'body:not(.night) .sd-stats-close:hover{background:rgba(15,23,42,.1);color:#0f172a}' +
    'body:not(.night) .sd-stats-icon{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.08)}' +
    'body:not(.night) .sd-stats-ring-track{stroke:rgba(15,23,42,.08)}' +
    'body:not(.night) .sd-stats-ring-label strong{color:#0f172a}' +
    'body:not(.night) .sd-stats-ring-label span{color:#64748b}' +
    'body:not(.night) .sd-stats-tile{background:rgba(15,23,42,.03);border-color:rgba(15,23,42,.08)}' +
    'body:not(.night) .sd-stats-tile-value{color:#0f172a}' +
    'body:not(.night) .sd-stats-tile-label{color:#64748b}' +
    'body:not(.night) .sd-stats-row-label{color:#334155}' +
    'body:not(.night) .sd-stats-row-value{color:#0f172a}' +
    'body:not(.night) .sd-stats-row-track{background:rgba(15,23,42,.08)}' +
    'body:not(.night) .sd-stats-row-hint{color:#94a3b8}' +
    '@media (max-width:640px){' +
      '.sd-stats-overlay{padding:0;align-items:flex-end}' +
      '.sd-stats-modal{width:100%;max-height:92vh;max-height:92dvh;border-radius:22px 22px 0 0;padding:28px 16px calc(18px + env(safe-area-inset-bottom));animation:sdStatsSheet .28s cubic-bezier(.22,1,.36,1);box-shadow:0 -24px 70px -28px rgba(0,0,0,.75)}' +
      '.sd-stats-modal::before{display:block;position:absolute;top:10px;left:50%;width:42px;height:4px;border-radius:999px;background:rgba(148,163,184,.5);transform:translateX(-50%)}' +
      '.sd-stats-close{top:18px;right:14px;width:38px;height:38px;border-radius:14px}' +
      '.sd-stats-head{gap:12px;margin-bottom:16px;padding-right:44px;align-items:flex-start}' +
      '.sd-stats-icon{width:42px;height:42px;border-radius:13px;font-size:1.2rem}' +
      '.sd-stats-title{font-size:1.02rem;line-height:1.25}' +
      '.sd-stats-sub{font-size:.78rem;line-height:1.35}' +
      '.sd-stats-hero{display:grid;grid-template-columns:104px minmax(0,1fr);gap:14px;align-items:center;margin-bottom:18px}' +
      '.sd-stats-ring{width:104px;height:104px}' +
      '.sd-stats-ring-track,.sd-stats-ring-fill{stroke-width:10}' +
      '.sd-stats-ring-label strong{font-size:1.28rem}' +
      '.sd-stats-ring-label span{font-size:.6rem;letter-spacing:.06em}' +
      '.sd-stats-tiles{width:100%}' +
      '.sd-stats-tile{min-height:54px;justify-content:center;padding:9px 10px;border-radius:12px}' +
      '.sd-stats-tile-value{font-size:1rem}' +
      '.sd-stats-tile-label{font-size:.64rem;letter-spacing:.04em}' +
      '.sd-stats-rows{gap:12px}' +
      '.sd-stats-row{padding:12px;border-radius:14px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06)}' +
      'body:not(.night) .sd-stats-row{background:rgba(15,23,42,.025);border-color:rgba(15,23,42,.06)}' +
      '.sd-stats-row-head{margin-bottom:8px}' +
      '.sd-stats-row-hint{line-height:1.35}' +
    '}' +
    '@media (max-width:380px){' +
      '.sd-stats-modal{padding-left:14px;padding-right:14px}' +
      '.sd-stats-hero{grid-template-columns:92px minmax(0,1fr);gap:12px}' +
      '.sd-stats-ring{width:92px;height:92px}' +
      '.sd-stats-tiles{gap:8px}' +
      '.sd-stats-tile{min-height:50px;padding:8px}' +
      '.sd-stats-tile-label{font-size:.6rem}' +
    '}';
  document.head.appendChild(s);
}

function _openCourseStatsModal(
  course: LegacyCourse,
  progress: CourseProgress,
  accent: string,
  icon: string
): void {
  _ensureStatsModalCss();
  document.querySelector('.sd-stats-overlay')?.remove();

  const esc = (v: string): string =>
    v.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch] || ch));
  const name = esc(course.name || 'Course');
  const fileWord = progress.files === 1 ? 'file' : 'files';

  // Overall ring: r=52 in a 120 viewBox → circumference ≈ 326.73.
  const circumference = 2 * Math.PI * 52;
  const dash = (Math.max(0, Math.min(100, progress.total)) / 100) * circumference;

  const aiHint = progress.aiSessions > 0
    ? progress.aiSessions + ' chat session' + (progress.aiSessions !== 1 ? 's' : '')
    : 'No AI chats yet';
  // null = no tracking source exists yet (matches the card's sub-stat pills,
  // which render those as 0%); the modal shows an em dash + hint instead.
  const rows: Array<{ label: string; value: number | null; hint: string }> = [
    { label: 'Read', value: progress.readingProgress, hint: progress.studiedFiles + ' of ' + progress.files + ' ' + fileWord + ' opened' },
    { label: 'Notes', value: progress.notesProgress, hint: 'Not tracked yet' },
    { label: 'Practice', value: progress.practiceProgress, hint: 'Not tracked yet' },
    { label: 'AI review', value: progress.aiReviewProgress, hint: aiHint },
  ];
  const rowsHtml = rows.map((r) =>
    '<div class="sd-stats-row' + (r.value === null ? ' is-untracked' : '') + '">' +
      '<div class="sd-stats-row-head">' +
        '<span class="sd-stats-row-label">' + r.label + '</span>' +
        '<span class="sd-stats-row-value">' + (r.value === null ? '&mdash;' : r.value + '%') + '</span>' +
      '</div>' +
      '<div class="sd-stats-row-track"><div class="sd-stats-row-fill" style="width:' + (r.value ?? 0) + '%"></div></div>' +
      '<div class="sd-stats-row-hint">' + r.hint + '</div>' +
    '</div>'
  ).join('');

  const tilesHtml = [
    { v: String(progress.files), l: 'Files' },
    { v: String(progress.studiedFiles), l: 'Opened' },
    { v: String(progress.unreadFilesCount), l: 'Unread' },
    { v: String(progress.aiSessions), l: 'AI chats' },
  ].map((t) =>
    '<div class="sd-stats-tile">' +
      '<span class="sd-stats-tile-value">' + t.v + '</span>' +
      '<span class="sd-stats-tile-label">' + t.l + '</span>' +
    '</div>'
  ).join('');

  const overlay = document.createElement('div');
  overlay.className = 'sd-stats-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', (course.name || 'Course') + ' statistics');
  overlay.innerHTML =
    '<div class="sd-stats-modal" style="--sd-stats-accent:' + esc(accent) + '">' +
      '<button type="button" class="sd-stats-close" aria-label="Close">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
      '<header class="sd-stats-head">' +
        '<div class="sd-stats-icon" aria-hidden="true">' + icon + '</div>' +
        '<div class="sd-stats-head-text">' +
          '<h3 class="sd-stats-title">' + name + '</h3>' +
          '<div class="sd-stats-sub">' + progress.files + ' ' + fileWord + ' &middot; ' + progress.lastOpened + '</div>' +
        '</div>' +
      '</header>' +
      '<div class="sd-stats-hero">' +
        '<div class="sd-stats-ring">' +
          '<svg viewBox="0 0 120 120" aria-hidden="true">' +
            '<circle class="sd-stats-ring-track" cx="60" cy="60" r="52"/>' +
            '<circle class="sd-stats-ring-fill" cx="60" cy="60" r="52" stroke-dasharray="' + dash.toFixed(1) + ' ' + circumference.toFixed(1) + '"/>' +
          '</svg>' +
          '<div class="sd-stats-ring-label"><strong>' + progress.total + '%</strong><span>overall</span></div>' +
        '</div>' +
        '<div class="sd-stats-tiles">' + tilesHtml + '</div>' +
      '</div>' +
      '<div class="sd-stats-rows">' + rowsHtml + '</div>' +
    '</div>';

  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    prevFocus?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector<HTMLButtonElement>('.sd-stats-close')?.addEventListener('click', close);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLButtonElement>('.sd-stats-close')?.focus();
}

function _renderDailyMissionPreview(state: CoursesRenderState, beforeEl: HTMLElement): void {
  let host = document.getElementById('sdDailyMissionPreview') as HTMLElement | null;
  if (!host) {
    host = document.createElement('section');
    host.id = 'sdDailyMissionPreview';
    host.className = 'sd-daily-mission-card';
    beforeEl.parentElement?.insertBefore(host, beforeEl);
  }
  const sem = state.SEMS[state.sdActiveSemId];
  const course = sem?.courses?.find((c) => c.id);
  const courseId = course?.id || null;
  const courseName = course?.name || 'your selected course';

  const openAi = (): void => {
    try { sessionStorage.setItem('ss_daily_mission_seed', 'to-do'); } catch { /* ignore */ }
    // Bug 2 fix: use _navigatePortal so URL hash and sidebar highlight are updated.
    const _wp2 = window as unknown as { _navigatePortal?: (s: string) => void; showPortalSection?: (s: string) => void };
    if (typeof _wp2._navigatePortal === 'function') _wp2._navigatePortal('aipage');
    else if (typeof _wp2.showPortalSection === 'function') _wp2.showPortalSection('aipage');
    window.setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
      if (!ta) return;
      ta.value = 'to-do';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    }, 350);
  };

  const showTasksModal = async (): Promise<void> => {
    console.log('[DailyMission] showTasksModal clicked, courseId:', courseId);
    if (!courseId) {
      console.log('[DailyMission] No courseId, returning');
      return;
    }
    try {
      console.log('[DailyMission] Importing getDailyMission...');
      const { getDailyMission } = await import('../../services/study-service.js');
      console.log('[DailyMission] Got getDailyMission, fetching data for', courseId);
      const data = await getDailyMission(courseId);
      console.log('[DailyMission] Got data:', data);
      if (!data.hasPlan || !data.tasks.length) {
        console.log('[DailyMission] No plan or tasks, returning');
        return;
      }

      const tasks = data.tasks.filter((t) => t.status !== 'replaced');
      console.log('[DailyMission] Modal tasks filtered:', tasks.length, 'from', data.tasks.length);

      let content = '';
      if (tasks.length === 0) {
        content = '<div class="dm-modal-empty">No active tasks for today</div>';
      } else {
        const labels: Record<string, string> = {
          study_topic: 'Study', read_pages: 'Read', solve_exercise_sheet: 'Exercises',
          practice_problem_set: 'Practice', generate_quiz_if_no_exercises: 'Quiz',
          review_weak_topic: 'Review', review_topic: 'Review', exam_style_practice: 'Exam prep',
          check_solution_sheet: 'Check Solutions', review_completed_exercise: 'Review Exercise',
          pre_exam_review: 'Pre-Exam Review', create_flashcards: 'Flashcards'
        };
        const getTypeLabel = (taskType: string) => labels[taskType] || 'Study';
        const groups = ['must_do', 'should_do', 'optional'];
        const groupLabels: Record<string, string> = { must_do: 'Must Do', should_do: 'Should Do', optional: 'Optional' };
        groups.forEach((group) => {
          const groupTasks = tasks.filter((t) => (t as any).priority_group === group);
          if (groupTasks.length > 0) {
            content += '<div class="dm-modal-group"><div class="dm-modal-group-title">' + groupLabels[group] + '</div>';
            groupTasks.forEach((task) => {
              const isDone = task.status === 'completed';
              content += '<div class="dm-task dm-task--' + task.status + '">' +
                '<div class="dm-task-title' + (isDone ? ' is-done' : '') + '">' + task.title + '</div>' +
                '<div class="dm-task-meta">' + getTypeLabel(task.task_type) + ' &middot; ' + task.estimated_minutes + 'min</div>' +
              '</div>';
            });
            content += '</div>';
          }
        });
      }

      const modal = document.createElement('div');
      modal.className = 'dm-tasks-modal-overlay';
      modal.innerHTML = '<div class="dm-tasks-modal">' +
        '<div class="dm-tasks-modal-header">' +
          '<h3>Today\'s Tasks</h3>' +
          '<button type="button" class="dm-modal-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="dm-tasks-modal-content">' + content + '</div>' +
      '</div>';
      document.body.appendChild(modal);

      const closeBtn = modal.querySelector('.dm-modal-close') as HTMLButtonElement;
      const close = () => { modal.remove(); };
      closeBtn.addEventListener('click', close);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
      });
    } catch (err) {
      console.error('[DailyMission] showTasksModal error:', err);
    }
  };

  const paint = (
    title: string,
    text: string,
    cta: string,
    active: boolean,
    meta?: { tasks?: number; minutes?: number; focus?: string; state?: string; hasActiveTasks?: boolean }
  ): void => {
    if (!host) return;
    const focus = meta?.focus || courseName;
    const taskLabel = typeof meta?.tasks === 'number'
      ? meta.tasks + ' task' + (meta.tasks !== 1 ? 's' : '')
      : 'Course sources';
    const minuteLabel = typeof meta?.minutes === 'number'
      ? meta.minutes + ' min left'
      : 'Trusted plan';
    const stateLabel = meta?.state || (active ? 'Ready today' : 'Setup needed');
    host.innerHTML =
      '<div class="sd-dm-orb" aria-hidden="true">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>' +
      '</div>' +
      '<div class="sd-dm-left">' +
        '<div class="sd-dm-kicker"><span class="sd-dm-dot' + (active ? ' is-active' : '') + '"></span>Daily Study Mission</div>' +
        '<h2>' + title + '</h2>' +
        '<p>' + text + '</p>' +
      '</div>' +
      '<div class="sd-dm-meta" aria-label="Mission status">' +
        '<span>' + stateLabel + '</span>' +
        '<span>' + taskLabel + '</span>' +
        '<span>' + minuteLabel + '</span>' +
        '<span>' + focus + '</span>' +
      '</div>' +
      '<button type="button" class="sd-dm-cta">' +
        '<span>' + cta + '</span>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>' +
      '</button>';
    const ctaBtn = host.querySelector<HTMLButtonElement>('.sd-dm-cta');
    if (ctaBtn) {
      if (meta?.hasActiveTasks) {
        ctaBtn.addEventListener('click', showTasksModal);
      } else {
        ctaBtn.addEventListener('click', openAi);
      }
    }
  };

  if (!courseId) {
    paint('Daily Study Mission', 'Turn your uploaded course files into a daily study plan.', 'Set Up Mission', false, { state: 'Choose a subject' });
    return;
  }

  paint(
    'Daily Study Mission',
    'Checking today\'s trusted study plan for ' + courseName + '...',
    'Open in AI',
    false,
    { focus: courseName, state: 'Checking sources' }
  );
  import('../../services/study-service.js')
    .then((mod) => mod.getDailyMissionSummary(courseId))
    .then((summary) => {
      if (summary.noValidCandidates) {
        paint(
          'Daily Study Mission',
          'Minallo needs confirmed course sources before it can build trusted tasks for ' + courseName + '.',
          'Review Course Map',
          false,
          { focus: courseName, state: 'Needs sources' }
        );
        return;
      }
      if (!summary.hasPlan) {
        paint(
          'Daily Study Mission',
          'Turn your uploaded course files into a daily study plan for ' + courseName + '.',
          'Set Up Mission',
          false,
          { focus: courseName, state: 'Ready to set up' }
        );
        return;
      }
      if (summary.totalTasks > 0 && summary.completedTasks >= summary.totalTasks) {
        paint(
          'Mission complete for today',
          'Good work. You finished today\'s trusted study plan.',
          'View Mission',
          true,
          { tasks: summary.totalTasks, minutes: 0, focus: courseName, state: 'Complete' }
        );
        return;
      }
      if (summary.hasUnavailableSources) {
        paint(
          'Daily Study Mission',
          'Some of today\'s tasks lost their source file. Open the mission in AI to fix or replace them.',
          'Fix in AI',
          true,
          { tasks: summary.totalTasks, minutes: summary.minutesRemaining, focus: courseName, state: 'Needs attention' }
        );
        return;
      }
      paint(
        'Daily Study Mission',
        'Today\'s trusted plan is ready from your real course sources.',
        'View Tasks →',
        true,
        { tasks: summary.totalTasks, minutes: summary.minutesRemaining, focus: courseName, state: 'Active today', hasActiveTasks: true }
      );
    })
    .catch(() => {
      paint('Daily Study Mission', 'Confirm your course sources to generate trusted tasks.', 'Review Course Map', false, { focus: courseName, state: 'Needs sources' });
    });
}

function _updateHeroStats(
  state: CoursesRenderState,
  data: Array<{ course: LegacyCourse; progress: CourseProgress }>
): void {
  const semLbl = document.getElementById('sdHeroSemLabel');
  const semBtnLbl = document.getElementById('sdSemLabel');
  if (semLbl && semBtnLbl) semLbl.textContent = semBtnLbl.textContent || '';

  const semColor = (state.SEMS[state.sdActiveSemId] as { color?: string } | undefined)?.color;
  if (semColor) {
    document.querySelectorAll<HTMLElement>('#sdHeroStats .sd-hero-stat-dot').forEach((el) => {
      el.style.background = semColor;
      el.style.boxShadow = '0 0 8px ' + semColor + '99';
    });
  }

  const courseLbl = document.getElementById('sdHeroCoursesLabel');
  const filesLbl = document.getElementById('sdHeroFilesLabel');
  const progressLbl = document.getElementById('sdHeroProgressLabel');
  const tFn = window._t;
  const courseWord = data.length === 1
    ? (tFn ? tFn('sd_course_one') : 'course')
    : (tFn ? tFn('sd_course_many') : 'courses');
  if (courseLbl) courseLbl.textContent = data.length + ' ' + courseWord;
  const totalFiles = data.reduce((s, d) => s + d.progress.files, 0);
  const fileWord = totalFiles === 1
    ? (tFn ? tFn('sd_file_one') : 'file')
    : (tFn ? tFn('sd_file_many') : 'files');
  if (filesLbl) filesLbl.textContent = totalFiles + ' ' + fileWord;
  const tracked = data.filter((d) => d.progress.files > 0);
  const avg = tracked.length
    ? Math.round(tracked.reduce((s, d) => s + d.progress.total, 0) / tracked.length)
    : 0;
  const avgLabel = tFn ? tFn('sd_avg_progress') : 'avg progress';
  if (progressLbl) progressLbl.textContent = avg + '% ' + avgLabel;
}

// ── Next steps panel ─────────────────────────────────────────────────────────
// Renders below the grid. Suggestions are computed from real signals only —
// we hide the panel entirely if none apply.
interface Suggestion {
  id: string;
  icon: string;
  title: string;
  text: string;
  action: () => void;
}

function _renderNextStepsBelowGrid(
  data: Array<{ course: LegacyCourse; progress: CourseProgress }> | null
): void {
  const host = document.getElementById('sdNextSteps');
  if (!host) return;
  host.innerHTML = '';

  if (!data || !data.length) return;

  const suggestions: Suggestion[] = [];

  // Find one course with unread files
  const unread = data
    .filter((d) => d.progress.files > 0 && d.progress.unreadFilesCount > 0)
    .sort((a, b) => b.progress.unreadFilesCount - a.progress.unreadFilesCount)[0];
  if (unread) {
    const n = unread.progress.unreadFilesCount;
    suggestions.push({
      id: 'review-unread-files',
      icon: '👀',
      title: 'Continue ' + unread.course.name,
      text: n + ' file' + (n > 1 ? 's' : '') + ' you haven\'t opened yet.',
      action: () => {
        if (typeof window.openCourse === 'function') window.openCourse(unread.course);
      },
    });
  }

  // Suggest AI chat on a course that has files but no chat yet
  const noChat = data.find(
    (d) => d.progress.files > 0 && d.progress.aiSessions === 0
  );
  if (noChat) {
    suggestions.push({
      id: 'ask-ai',
      icon: '🤖',
      title: 'Ask AI about ' + noChat.course.name,
      text: 'You haven\'t used the AI tutor for this course yet.',
      action: () => {
        if (typeof window.openCourse === 'function') window.openCourse(noChat.course);
      },
    });
  }

  // Pomodoro / Study Lounge — only if the lounge section exists
  if (typeof window.showPortalSection === 'function') {
    suggestions.push({
      id: 'focus-session',
      icon: '⏱',
      title: '25 min focus session',
      text: 'Start a Pomodoro session right now.',
      action: () => {
        const w = window as unknown as { startQuickPomodoro?: (m?: number) => void };
        if (typeof w.startQuickPomodoro === 'function') w.startQuickPomodoro(25);
      },
    });
  }

  if (!suggestions.length) return;

  const wrap = document.createElement('section');
  wrap.className = 'sd-next-steps';
  wrap.innerHTML =
    '<div class="sd-next-steps-head">' +
      '<div>' +
        '<div class="sd-next-steps-eyebrow">Next steps</div>' +
        '<h2 class="sd-next-steps-title">Pick up where you left off</h2>' +
      '</div>' +
    '</div>' +
    '<div class="sd-next-steps-grid"></div>';
  const grid = wrap.querySelector<HTMLElement>('.sd-next-steps-grid');
  if (grid) {
    suggestions.forEach((s) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sd-next-step';
      card.innerHTML =
        '<div class="sd-next-step-icon">' + s.icon + '</div>' +
        '<div class="sd-next-step-body">' +
          '<div class="sd-next-step-title">' + s.title + '</div>' +
          '<div class="sd-next-step-text">' + s.text + '</div>' +
        '</div>' +
        '<div class="sd-next-step-arrow">→</div>';
      card.addEventListener('click', s.action);
      grid.appendChild(card);
    });
  }
  host.appendChild(wrap);
}

