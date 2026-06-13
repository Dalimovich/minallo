// Cross-section navigation: portal tabs, Stud.IP/Courses overlay, the
// resume-to-file stash, and the back-and-forth between portal and file
// views. Most functions push DOM state directly because the app shell
// hasn't migrated yet.

import { hideFilesView, selectTopLevelView, showFilesView } from './panels.js';
import type { LegacyCourse } from '../../globals.js';

export function setNavActive(id: string): void {
  document.querySelectorAll('.psb').forEach((el) => {
    el.classList.remove('on');
  });
  const el = document.getElementById(id);
  if (el) el.classList.add('on');
}

const SECTION_TITLE_KEYS: Record<string, string> = {
  dashboard: 'nav_dashboard',
  notes: 'nav_notes',
  editor: 'nav_editor',
  profile: 'nav_profile',
  settings: 'nav_settings',
  subscription: 'nav_subscription',
  studip: 'nav_courses',
  chat: 'nav_chat',
  notifications: 'nav_notifications',
  games: 'nav_games',
  lounge: 'nav_lounge',
  aipage: 'nav_chatbot',
  german: 'nav_practice',
};

function _sectionTitle(sec: string): string {
  const key = SECTION_TITLE_KEYS[sec];
  if (key && typeof window._t === 'function') return window._t(key);
  return key || sec;
}

export function showPortalSection(sec: string): void {
  const gamesItem = document.getElementById('psbGames');
  if (sec === 'games' && gamesItem && gamesItem.classList.contains('st-locked')) return;
  document.body.classList.toggle('minallo-notifications-page', sec === 'notifications');

  // Make sure portal is the visible top-level view — kills file/studip ghosts
  // that would otherwise sit on top of (or under) the section we're about to show.
  selectTopLevelView('portal');

  const ms = document.querySelector<HTMLElement>('#portal .main .main-scroll');
  const target = document.getElementById('psec-' + sec);
  const fab = document.getElementById('addWidgetFab');
  const tt = document.getElementById('topTitle');

  function revealTarget(): void {
    document.querySelectorAll<HTMLElement>('.portal-section').forEach((el) => {
      if (el === target) return;
      el.style.display = 'none';
      el.classList.remove('psec-entering', 'psec-leaving');
    });
    if (!target) return;
    target.style.display =
      target.classList.contains('editor-portal-section') || sec === 'chat' ? 'flex' : 'block';
    target.classList.remove('psec-entering');
    target.classList.add('psec-entering');
    if (ms) ms.classList.toggle('editor-active', sec === 'editor' || sec === 'chat');
    if (tt) {
      tt.textContent = _sectionTitle(sec);
      const key = SECTION_TITLE_KEYS[sec];
      if (key) tt.setAttribute('data-i18n', key);
    }
    if (fab) fab.classList.toggle('visible', sec === 'dashboard');

    const aiPanel = document.getElementById('aiPanel');
    if (sec !== 'studip') {
      if (typeof window.forceCloseAI === 'function') window.forceCloseAI();
      else if (aiPanel) aiPanel.classList.remove('visible');
    }

    // Document rail: visible on the courses dashboard (psec-studip) only here;
    // PDF visibility is handled by panels.ts → showFilesView / hideFilesView.
    // Use a global to avoid creating a hard import dependency from navigation
    // into the new feature module.
    const dr = (window as any).__minalloDocRail as
      | { setRouteVisibility: (route: 'pdf' | 'courses' | 'other') => void }
      | undefined;
    if (dr && typeof dr.setRouteVisibility === 'function') {
      dr.setRouteVisibility(sec === 'studip' ? 'courses' : 'other');
    }
  }

  // performance.css disables the section cross-fade app-wide, so the old 170ms
  // wait before swapping sections was pure dead time that made every navigation
  // feel sluggish. Reveal immediately; the entering animation (kept only for the
  // chat/aipage routes in performance.css) still plays.
  revealTarget();
}

export function showPortal(): void {
  if (typeof window._statsStopFile === 'function') window._statsStopFile();
  const portal = document.getElementById('portal');
  if (!portal) return;
  hideFilesView();
  portal.classList.add('show');
  portal.style.display = 'block';
  portal.style.opacity = '';
  portal.style.transition = '';
  portal.style.transform = '';
  portal.style.pointerEvents = '';
  portal.style.zIndex = '';
  try {
    const st = JSON.parse(localStorage.getItem('ss_state') || '{}');
    st.inApp = false;
    st.view = '';
    localStorage.setItem('ss_state', JSON.stringify(st));
  } catch {
    /* ignore */
  }
}

// ── Resume-to-file helpers ─────────────────────────────────────────────────
// The Courses sidebar button should jump straight back to the PDF the user
// was viewing before they hopped to Chat / Settings / Editor etc. This
// behaviour was historically baked into showStudip; that broke because
// showStudip is called from many side-effect paths. The explicit stash /
// resume helpers below decouple it cleanly.

interface ResumeEntry {
  courseId: string;
  fileName: string;
}

function _findCourseFile(resume: ResumeEntry): { file: Record<string, unknown>; course: LegacyCourse } | null {
  const sems = window.SEMS || window._SEMS || {};
  const activeSemId = window.activeSemesterId || window._activeSemesterId;
  let course: LegacyCourse | undefined;
  if (activeSemId && sems[activeSemId]) {
    course = (sems[activeSemId].courses || []).find((c) => c.id === resume.courseId);
  }
  if (!course) {
    Object.keys(sems).some((sid) => {
      const c = (sems[sid]!.courses || []).find((cc) => cc.id === resume.courseId);
      if (c) {
        course = c;
        return true;
      }
      return false;
    });
  }
  if (!course) return null;

  const files = Array.isArray(course.files) ? course.files : [];
  let file = files.find((f) => f.name === resume.fileName);
  if (!file) {
    (course.userFolders || []).some((fd) => {
      const hit = (fd.files || []).find((f) => f.name === resume.fileName);
      if (hit) {
        file = hit;
        return true;
      }
      return false;
    });
  }
  return file ? { file, course } : null;
}

export function stashResumeFile(): void {
  if (!window.activeFileName || !window.activeCourseId) return;
  try {
    if (sessionStorage.getItem('ss_resume_file')) return; // don't overwrite
    sessionStorage.setItem(
      'ss_resume_file',
      JSON.stringify({ courseId: window.activeCourseId, fileName: window.activeFileName })
    );
  } catch {
    /* ignore */
  }
}

export function clearResumeFile(): void {
  try {
    sessionStorage.removeItem('ss_resume_file');
  } catch {
    /* ignore */
  }
}

export function showStudipResume(): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem('ss_resume_file');
  } catch {
    /* ignore */
  }
  if (!raw) {
    showStudip();
    return false;
  }

  let resume: ResumeEntry | null = null;
  try {
    resume = JSON.parse(raw) as ResumeEntry;
  } catch {
    resume = null;
  }
  if (!resume || !resume.courseId || !resume.fileName) {
    clearResumeFile();
    showStudip();
    return false;
  }

  const hit = _findCourseFile(resume);
  if (!hit || typeof window.openFile !== 'function') {
    showStudip();
    return false;
  }

  clearResumeFile();
  showFilesView(typeof window._stRunning !== 'undefined' ? window._stRunning : false);
  // Resuming a PDF lands us back on the Courses route, so reflect that in the
  // sidebar — otherwise whichever section the user just left stays highlighted.
  setNavActive('pcStudip');

  window.openFile(hit.file, hit.course);
  return true;
}

export function showStudip(): void {
  // The courses listing is the `psec-studip` portal section — not a separate
  // top-level container. Switch to portal (hides #app file view), then ask
  // showPortalSection to reveal the specific section.
  selectTopLevelView('portal');
  setNavActive('pcStudip');
  if (typeof window.showPortalSection === 'function') window.showPortalSection('studip');
  else showPortalSection('studip');
  if (typeof window.sdRenderCourses === 'function') window.sdRenderCourses();
  try {
    const st = JSON.parse(localStorage.getItem('ss_state') || '{}');
    st.view = 'studip';
    st.inApp = false;
    localStorage.setItem('ss_state', JSON.stringify(st));
  } catch {
    /* ignore */
  }
}

export function hideStudip(stRunning?: boolean): void {
  showFilesView(stRunning);
}

export function navTo(navId: string, section: string): void {
  const appEl = document.getElementById('app');
  const fromFiles = !!(appEl && appEl.style.display !== 'none');

  if (fromFiles) stashResumeFile();
  setNavActive(navId);
  if (typeof window.showPortalSection === 'function') window.showPortalSection(section);
  else showPortalSection(section);
}
