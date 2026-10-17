/* Manage layout dropdown for the Courses overview.
 *
 * Lets the user customise *display* of the course list without touching the
 * underlying data: grid vs compact, sort order, which card details to show,
 * card density. Prefs persist to localStorage under `ss_courses_layout`.
 */

import type { LegacyCourse } from '../../../globals.js';

export interface CoursesLayoutPrefs {
  view: 'grid' | 'list';
  sort: 'recent' | 'name' | 'files' | 'progress' | 'not-started';
  showProgress: boolean;
  showFileCount: boolean;
  showLastOpened: boolean;
  showStats: boolean;
  density: 'comfortable' | 'compact';
}

const STORAGE_KEY = 'ss_courses_layout';

const DEFAULTS: CoursesLayoutPrefs = {
  view: 'grid',
  sort: 'recent',
  showProgress: true,
  showFileCount: true,
  showLastOpened: true,
  showStats: true,
  density: 'comfortable',
};

export function getCoursesLayoutPrefs(): CoursesLayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<CoursesLayoutPrefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveCoursesLayoutPrefs(prefs: CoursesLayoutPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* quota */ }
}

/** Read sort-relevant signals for a course (last-opened timestamp + file count). */
function _courseSignals(c: LegacyCourse): { lastOpened: number; files: number } {
  let lastOpened = 0;
  try {
    const v = localStorage.getItem('ss_lastopen_' + c.id);
    if (v) lastOpened = parseInt(v, 10) || 0;
  } catch { /* ignore */ }
  const folderCount = (c.userFolders || []).reduce(
    (s, fd) => s + (fd.files ? fd.files.length : 0), 0
  );
  let files = (c.files?.length || 0) + folderCount;
  if (!files) {
    files = parseInt(localStorage.getItem('ss_fc_' + c.id) || '0', 10) || 0;
  }
  return { lastOpened, files };
}

/** Returns a sorted *copy* of the course array. Never mutates the input. */
export function sortCoursesByLayout(
  courses: LegacyCourse[],
  sort: CoursesLayoutPrefs['sort']
): LegacyCourse[] {
  const arr = courses.slice();
  switch (sort) {
    case 'name':
      arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
    case 'files':
      arr.sort((a, b) => _courseSignals(b).files - _courseSignals(a).files);
      break;
    case 'progress':
      arr.sort((a, b) => {
        const av = parseInt(localStorage.getItem('ss_progress_total_' + a.id) || '0', 10);
        const bv = parseInt(localStorage.getItem('ss_progress_total_' + b.id) || '0', 10);
        return bv - av;
      });
      break;
    case 'not-started':
      arr.sort((a, b) => {
        const av = parseInt(localStorage.getItem('ss_progress_total_' + a.id) || '0', 10);
        const bv = parseInt(localStorage.getItem('ss_progress_total_' + b.id) || '0', 10);
        return av - bv;
      });
      break;
    case 'recent':
    default:
      arr.sort((a, b) => _courseSignals(b).lastOpened - _courseSignals(a).lastOpened);
      break;
  }
  return arr;
}

/** Apply visibility / density / view-mode classes to the course list shell.
 *  Safe to call repeatedly — purely toggles state on existing DOM. */
export function applyCoursesLayoutPrefs(): void {
  const prefs = getCoursesLayoutPrefs();
  const list = document.getElementById('sdCourseList');
  if (!list) return;
  list.classList.toggle('sd-view-list', prefs.view === 'list');
  list.classList.toggle('sd-density-compact', prefs.density === 'compact');
  list.classList.toggle('sd-hide-progress', !prefs.showProgress);
  list.classList.toggle('sd-hide-filecount', !prefs.showFileCount);
  list.classList.toggle('sd-hide-lastopened', !prefs.showLastOpened);
  list.classList.toggle('sd-hide-stats', !prefs.showStats);
}

/* ── Popover ──────────────────────────────────────────────────────────────── */

let _popover: HTMLElement | null = null;
let _outsideHandler: ((e: MouseEvent) => void) | null = null;

function _closePopover(): void {
  if (_popover && _popover.parentNode) _popover.parentNode.removeChild(_popover);
  _popover = null;
  if (_outsideHandler) {
    document.removeEventListener('mousedown', _outsideHandler);
    _outsideHandler = null;
  }
}

function _openPopover(anchor: HTMLElement): void {
  if (_popover) { _closePopover(); return; }
  const prefs = getCoursesLayoutPrefs();

  // Anchor wrapper — ensures position:relative scope.
  const parent = anchor.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  _popover = document.createElement('div');
  _popover.className = 'layout-popover';
  _popover.setAttribute('role', 'menu');
  _popover.innerHTML = _popoverHtml(prefs);
  parent.appendChild(_popover);

  // Wire interactions
  _popover.addEventListener('click', (e) => { e.stopPropagation(); });

  _popover.querySelectorAll<HTMLButtonElement>('[data-lp-view]').forEach((b) => {
    b.addEventListener('click', () => _updatePref({ view: b.dataset['lpView'] as CoursesLayoutPrefs['view'] }));
  });
  const sortSel = _popover.querySelector<HTMLSelectElement>('#lpSort');
  if (sortSel) sortSel.addEventListener('change', () => _updatePref({ sort: sortSel.value as CoursesLayoutPrefs['sort'] }));

  _popover.querySelectorAll<HTMLInputElement>('[data-lp-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset['lpToggle'] as keyof CoursesLayoutPrefs;
      _updatePref({ [key]: cb.checked } as Partial<CoursesLayoutPrefs>);
    });
  });

  _popover.querySelectorAll<HTMLButtonElement>('[data-lp-density]').forEach((b) => {
    b.addEventListener('click', () => _updatePref({ density: b.dataset['lpDensity'] as CoursesLayoutPrefs['density'] }));
  });

  const reset = _popover.querySelector<HTMLButtonElement>('#lpReset');
  if (reset) {
    reset.addEventListener('click', () => {
      saveCoursesLayoutPrefs({ ...DEFAULTS });
      _rerenderAndRefreshPopover();
    });
  }

  // Outside click closes.
  _outsideHandler = (e: MouseEvent) => {
    if (!_popover) return;
    const t = e.target as Node;
    if (!_popover.contains(t) && !anchor.contains(t)) _closePopover();
  };
  // Defer so the click that opened the popover doesn't immediately close it.
  setTimeout(() => {
    if (_outsideHandler) document.addEventListener('mousedown', _outsideHandler);
  }, 0);
}

function _updatePref(patch: Partial<CoursesLayoutPrefs>): void {
  const prefs = getCoursesLayoutPrefs();
  const next = { ...prefs, ...patch };
  saveCoursesLayoutPrefs(next);
  _rerenderAndRefreshPopover();
}

function _rerenderAndRefreshPopover(): void {
  const w = window as unknown as { sdRenderCourses?: () => void };
  if (typeof w.sdRenderCourses === 'function') w.sdRenderCourses();
  else applyCoursesLayoutPrefs();
  // Update popover UI to reflect current state.
  if (_popover) {
    const prefs = getCoursesLayoutPrefs();
    _popover.innerHTML = _popoverHtml(prefs);
    // Re-wire interactions after innerHTML rewrite.
    const anchor = document.getElementById('sdManageLayoutBtn');
    _closePopover();
    if (anchor) _openPopover(anchor);
  }
}

function _popoverHtml(p: CoursesLayoutPrefs): string {
  const onIf = (b: boolean): string => (b ? 'checked' : '');
  const active = (cond: boolean): string => (cond ? ' lp-active' : '');
  return (
    '<div class="lp-section">' +
      '<div class="lp-section-title">View mode</div>' +
      '<div class="lp-seg">' +
        '<button type="button" class="lp-seg-btn' + active(p.view === 'grid') + '" data-lp-view="grid">Grid</button>' +
        '<button type="button" class="lp-seg-btn' + active(p.view === 'list') + '" data-lp-view="list">Compact list</button>' +
      '</div>' +
    '</div>' +
    '<div class="lp-section">' +
      '<div class="lp-section-title">Sort courses by</div>' +
      '<div class="lp-select-wrap">' +
        '<select id="lpSort" class="lp-select">' +
          '<option value="recent"' + (p.sort === 'recent' ? ' selected' : '') + '>Recently opened</option>' +
          '<option value="name"' + (p.sort === 'name' ? ' selected' : '') + '>Course name A–Z</option>' +
          '<option value="files"' + (p.sort === 'files' ? ' selected' : '') + '>Most files</option>' +
          '<option value="progress"' + (p.sort === 'progress' ? ' selected' : '') + '>Study progress</option>' +
          '<option value="not-started"' + (p.sort === 'not-started' ? ' selected' : '') + '>Not started first</option>' +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="lp-section">' +
      '<div class="lp-section-title">Card details</div>' +
      '<label class="lp-toggle"><input type="checkbox" data-lp-toggle="showProgress" ' + onIf(p.showProgress) + '><span>Show study progress</span></label>' +
      '<label class="lp-toggle"><input type="checkbox" data-lp-toggle="showFileCount" ' + onIf(p.showFileCount) + '><span>Show file count</span></label>' +
      '<label class="lp-toggle"><input type="checkbox" data-lp-toggle="showLastOpened" ' + onIf(p.showLastOpened) + '><span>Show last opened</span></label>' +
      '<label class="lp-toggle"><input type="checkbox" data-lp-toggle="showStats" ' + onIf(p.showStats) + '><span>Show Read / Notes / Practice / AI</span></label>' +
    '</div>' +
    '<div class="lp-section">' +
      '<div class="lp-section-title">Card density</div>' +
      '<div class="lp-seg">' +
        '<button type="button" class="lp-seg-btn' + active(p.density === 'comfortable') + '" data-lp-density="comfortable">Comfortable</button>' +
        '<button type="button" class="lp-seg-btn' + active(p.density === 'compact') + '" data-lp-density="compact">Compact</button>' +
      '</div>' +
    '</div>' +
    '<button type="button" id="lpReset" class="lp-reset">Reset layout</button>'
  );
}

export function initCoursesLayout(): void {
  // Toggle popover on button click. Event-delegated so the binding survives
  // re-renders of the controls row.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>('#sdManageLayoutBtn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (_popover) _closePopover();
    else _openPopover(btn);
  });

  // Apply current prefs on first paint and whenever the course list re-renders.
  // sdRenderCourses already rebuilds the list each time, so we just observe.
  const list = document.getElementById('sdCourseList');
  if (list) {
    const obs = new MutationObserver(() => applyCoursesLayoutPrefs());
    obs.observe(list, { childList: true });
  }
  applyCoursesLayoutPrefs();
}

// Expose so courses-render.ts (loaded as JS) can pick up the sort.
(window as unknown as {
  _coursesLayoutSort?: (courses: LegacyCourse[]) => LegacyCourse[];
  _applyCoursesLayoutPrefs?: () => void;
})._coursesLayoutSort = (courses) => sortCoursesByLayout(courses, getCoursesLayoutPrefs().sort);
(window as unknown as {
  _applyCoursesLayoutPrefs?: () => void;
})._applyCoursesLayoutPrefs = applyCoursesLayoutPrefs;
