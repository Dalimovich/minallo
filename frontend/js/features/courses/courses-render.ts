import { panelHide } from '../../core/panels.js';
import { listCourseDocuments } from '../../services/ai-service.js';
import type { LegacyCourse } from '../../../globals.js';

interface CoursesRenderState {
  SEMS: Record<string, { color?: string; courses: LegacyCourse[] }>;
  COLORS: string[];
  activeSemId: string;
  activeCourseId: string | null;
  sdActiveSemId: string;
  _cameFromStudip: boolean;
}

// Reuse one in-flight fetch per course so opening the dashboard repeatedly
// doesn't fan out into duplicate /api/documents/list calls.
const _countFetchInFlight: Record<string, Promise<number | null>> = {};

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
  // The cached-profile IIFE in app.ts renders course cards before _verifyAndEnter
  // sets window._sbToken, so a fetch fired here would 401. Render the cached count
  // (written by a prior successful fetch) and bail — a second render runs once
  // auth completes via loadUserData → _loadUserCourses, which will repopulate.
  if (!(window as unknown as { _sbToken?: string })._sbToken) {
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
    return;
  }
  const inFlight = _countFetchInFlight[courseId];
  if (inFlight) {
    inFlight.then((count) => {
      if (count != null) {
        _applyBadge(count);
        _maybeRerender(count);
      }
    });
    return;
  }
  _countFetchInFlight[courseId] = listCourseDocuments(courseId)
    .then((docs) => {
      const count = Array.isArray(docs) ? docs.length : 0;
      try { localStorage.setItem('ss_fc_' + courseId, String(count)); } catch { /* quota */ }
      _applyBadge(count);
      _maybeRerender(count);
      return count;
    })
    .catch(() => null)
    .finally(() => { delete _countFetchInFlight[courseId]; });
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
  cl.innerHTML = '';
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

  sem.courses.forEach((c, i) => {
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
      '<button type="button" class="sd-course-open-btn" data-open-course>Open course</button>';

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
        state.SEMS[state.sdActiveSemId]?.courses.splice(i, 1);
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
