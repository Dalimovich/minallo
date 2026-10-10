// Persist + restore the user's last-known place in the app (semester +
// course + file + portal section). Stored in localStorage.ss_state.

import type { LegacyCourse } from '../../globals.js';

type SemestersMap = Record<string, { color: string; courses: LegacyCourse[] }>;

export interface StatePersistenceOptions {
  getActiveSemId: () => string;
  getActiveCourseId: () => string | null;
  getActiveFileName: () => string | null;
  getActiveCourseSection: () => string;
  setActiveSemId: (id: string) => void;
  setActiveCourseId: (id: string) => void;
  getSems: () => SemestersMap;
  getCurrentUser: () => { id?: string; sub?: string } | null;
  renderCourses: () => void;
  showFilesView: () => void;
  showStudip: () => void;
  showPortal: () => void;
  showPortalSection: (section: string) => void;
  showCourseSection: (course: LegacyCourse, section: string) => void;
  setNavActive: (id: string) => void;
  setSsRestoring: (v: boolean) => void;
  setPendingPortalRestore: (v: { section: string } | null) => void;
  setPendingRestoreCourse: (v: { course: LegacyCourse; sec: string; file?: string } | null) => void;
  panelShow: (el: HTMLElement | null, isFlexEl?: boolean) => void;
  panelHide: (el: HTMLElement | null) => void;
}

// Portal sections that own the full page — refreshing on these must NOT
// trigger a course/file restore even when ss_state still has old course data.
const PORTAL_ONLY_SECTIONS = [
  'aipage', 'notes', 'chat', 'games', 'lounge', 'editor',
  'notifications', 'profile', 'settings', 'subscription',
  'german', 'admin', 'dashboard',
];

interface StoredState {
  semId?: string;
  courseId?: string;
  fileName?: string;
  section?: string;
  inApp?: boolean;
  view?: string;
}

export function initStatePersistence(options: StatePersistenceOptions): {
  saveState: () => void;
  restoreState: () => void;
} {
  let _stateRestored = false;

  function saveState(): void {
    try {
      // Read from the actually-visible view, not from ss_portal_tab. The tab
      // can be stale (e.g. user used the chatbot, then opened a file via a
      // path that didn't update the tab) and the old behavior here was to
      // *delete* ss_state when the stale tab said "I'm on a portal-only
      // section" — which wiped the user's course/file location and made
      // refresh land on dashboard.
      //
      // The portal `data-active-view` attribute is set by selectTopLevelView()
      // and is the truth. Fall back to DOM inspection for cases where the
      // attribute hasn't been set yet (early boot).
      const portalEl = document.getElementById('portal');
      let activeView: string | null = portalEl ? portalEl.dataset.activeView || null : null;
      if (!activeView) {
        const appEl = document.getElementById('app');
        if (appEl && appEl.style.display !== 'none' && appEl.style.display !== '') activeView = 'file';
        else activeView = 'portal';
      }

      // Only persist when the user is in file view (course overview or PDF).
      // Pure portal sections (notes, editor, chatbot, studip listing, etc.) are
      // tracked entirely via ss_portal_tab and don't need ss_state.
      if (activeView !== 'file') return;

      // activeView === 'file' — courseOverview or pdfView under #app.
      const st: StoredState = {
        semId: options.getActiveSemId(),
        courseId: options.getActiveCourseId() || undefined,
        fileName: options.getActiveFileName() || undefined,
        section: options.getActiveCourseSection(),
        inApp: true,
      };
      localStorage.setItem('ss_state', JSON.stringify(st));
    } catch {
      /* localStorage error */
    }
  }

  function restoreState(): void {
    if (_stateRestored) return;
    options.setSsRestoring(true);
    try {
      const raw = localStorage.getItem('ss_state');
      if (!raw) { _stateRestored = true; return; }
      const st = JSON.parse(raw) as StoredState;
      if (!st.inApp) { _stateRestored = true; return; }

      let lastTab: string | null = null;
      try {
        lastTab = sessionStorage.getItem('ss_portal_tab') || localStorage.getItem('ss_last_section');
      } catch {
        /* sessionStorage disabled */
      }
      if (lastTab && PORTAL_ONLY_SECTIONS.indexOf(lastTab) !== -1) { _stateRestored = true; return; }

      if (st.view === 'studip') {
        _stateRestored = true;
        options.showStudip();
        return;
      }

      options.setPendingPortalRestore(null);
      options.showFilesView();
      options.setNavActive('pcStudip');

      const sems = options.getSems();
      if (st.semId && sems[st.semId]) {
        options.setActiveSemId(st.semId);
        options.renderCourses();
      }

      if (st.courseId && st.courseId.indexOf('german-') === 0) {
        _stateRestored = true;
        const skill = st.courseId.replace('german-', '');
        options.showPortal();
        options.setNavActive('psbGerman');
        options.showPortalSection('german');
        if (typeof window._glOpenSkill === 'function') {
          window._glOpenSkill(skill);
          if (st.fileName && window._uid) {
            const uid = window._uid;
            const fileName = st.fileName;
            setTimeout(() => {
              window._glOpenFile?.(uid, fileName);
            }, 500);
          }
        }
        return;
      }

      if (st.courseId) {
        // Search ALL semesters for the course, not just the active one
        let course: LegacyCourse | undefined;
        for (const semData of Object.values(sems)) {
          course = semData.courses.find((c) => c.id === st.courseId);
          if (course) break;
        }
        if (course) {
            _stateRestored = true;
            options.setActiveCourseId(st.courseId);
            if (!course.files) course.files = [];
            options.panelHide(document.getElementById('welcomeState'));
            options.panelShow(document.getElementById('courseOverview'));
            const crumb = document.getElementById('breadcrumb');
            if (crumb) {
              crumb.textContent = '';
              const crumbB = document.createElement('b');
              crumbB.textContent = course.name;
              crumb.appendChild(crumbB);
            }
            options.renderCourses();
            const restSec = st.section || 'files';
            const restFile = st.fileName;

            try {
              const rstCached = JSON.parse(
                localStorage.getItem('ss_uf_cache_' + course.id) || 'null'
              );
              if (rstCached && Array.isArray(rstCached.files)) {
                const currentUser = options.getCurrentUser();
                const rstUid =
                  (currentUser && (currentUser.id || currentUser.sub)) ||
                  localStorage.getItem('ss_last_uid');
                course.files = rstCached.files.map((f: Record<string, unknown>) => ({
                  name: f.name,
                  _storageName: f.storageName,
                  size: f.size || 0,
                  date: f.date,
                  _uploaded: true,
                  _uid: rstUid,
                  _course: course,
                }));
                course.userFolders = (rstCached.folders || []).map(
                  (fd: { name: string; files: Array<Record<string, unknown>> }) => ({
                    name: fd.name,
                    files: (fd.files || []).map((f) => ({
                      name: f.name,
                      _storageName: f.storageName,
                      size: f.size || 0,
                      date: f.date,
                      _uploaded: true,
                      _uid: rstUid,
                      _course: course,
                      _folder: fd.name,
                    })),
                  })
                );
              }
            } catch {
              /* cache parse failed — render without cached files */
            }

            options.showCourseSection(course, restSec);
            options.setPendingRestoreCourse({
              course,
              sec: restSec,
              file: restFile,
            });
            return;
        }
        // Course not found in SEMS — leave _stateRestored false so a later
        // call (after courses load from network) can retry. Revert the file
        // view we speculatively showed above so the user doesn't see a blank
        // shell while waiting for courses to load.
        options.showPortal();
        return;
      }

      // No courseId to restore — mark as done
      _stateRestored = true;
    } catch (e) {
      console.warn('State restore failed:', e);
    } finally {
      options.setSsRestoring(false);
    }
  }

  return { saveState, restoreState };
}
