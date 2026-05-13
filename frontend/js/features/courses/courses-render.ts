import { panelShow, panelHide } from '../../core/panels.js';
import { listCourseDocuments } from '../../services/ai-service.js';
import type { LegacyCourse } from '../../../globals.js';

interface CoursesRenderState {
  SEMS: Record<string, { courses: LegacyCourse[] }>;
  COLORS: string[];
  activeSemId: string;
  activeCourseId: string | null;
  sdActiveSemId: string;
  _cameFromStudip: boolean;
}

// Reuse one in-flight fetch per course so opening the dashboard repeatedly
// doesn't fan out into duplicate /api/documents/list calls.
const _countFetchInFlight: Record<string, Promise<number | null>> = {};

function _hydrateCardCount(courseId: string, badge: HTMLElement): void {
  const inFlight = _countFetchInFlight[courseId];
  if (inFlight) {
    inFlight.then((count) => {
      if (count != null) badge.textContent = count + ' file' + (count !== 1 ? 's' : '');
    });
    return;
  }
  _countFetchInFlight[courseId] = listCourseDocuments(courseId)
    .then((docs) => {
      const count = Array.isArray(docs) ? docs.length : 0;
      try { localStorage.setItem('ss_fc_' + courseId, String(count)); } catch { /* quota */ }
      if (badge.isConnected) badge.textContent = count + ' file' + (count !== 1 ? 's' : '');
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
        panelShow(document.getElementById('welcomeState'));
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

export function sdRenderCourses(state: CoursesRenderState): void {
  const cl = document.getElementById('sdCourseList');
  if (!cl) return;
  cl.innerHTML = '';
  const sem = state.SEMS[state.sdActiveSemId];
  if (!sem) return;
  if (!sem.courses.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:32px;text-align:center;opacity:.5;font-size:.9rem';
    empty.textContent = 'No subjects added yet. Use the search bar above to add your courses.';
    cl.appendChild(empty);
    return;
  }
  sem.courses.forEach((c, i) => {
    const col = state.COLORS[i % state.COLORS.length] || '#2563EB';
    const card = document.createElement('div');
    card.className = 'sd-course-card';
    card.style.position = 'relative';

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

    const colorBar = document.createElement('div');
    colorBar.className = 'sd-course-bar';
    colorBar.style.background = col;

    const courseName = document.createElement('div');
    courseName.className = 'sd-course-name';
    courseName.textContent = c.name;

    const courseMeta = document.createElement('div');
    courseMeta.className = 'sd-course-meta';
    courseMeta.textContent = c.meta || '';

    const badge = document.createElement('div');
    badge.className = 'sd-course-badge';
    badge.textContent = count + ' file' + (count !== 1 ? 's' : '');

    // course.files is only hydrated when the user opens the course. On a
    // fresh dashboard render that hasn't happened yet, so kick off a
    // background count fetch and refresh the badge + ss_fc_<id> cache.
    if (!liveCount) _hydrateCardCount(c.id, badge);

    const delBtn = document.createElement('button');
    delBtn.className = 'sd-del-btn';
    delBtn.title = 'Remove';
    delBtn.textContent = '✕';
    delBtn.style.cssText =
      'position:absolute;top:8px;right:8px;background:rgba(255,100,100,.15);border:none;color:rgba(255,120,120,.8);border-radius:6px;padding:2px 7px;cursor:pointer;font-size:.8rem;line-height:1';

    delBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      state.SEMS[state.sdActiveSemId]?.courses.splice(i, 1);
      if (typeof window._saveUserCourses === 'function') window._saveUserCourses();
      sdRenderCourses(state);
    });

    card.append(colorBar, courseName, courseMeta, badge, delBtn);

    card.addEventListener('click', () => {
      if (typeof window.hideStudip === 'function') window.hideStudip();
      state._cameFromStudip = true;
      state.activeSemId = state.sdActiveSemId;
      renderCourses(state);
      if (typeof window.openCourse === 'function') window.openCourse(c);
    });

    cl.appendChild(card);
  });
}
