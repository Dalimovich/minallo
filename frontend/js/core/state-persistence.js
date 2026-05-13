// Persist + restore the user's last-known place in the app (semester +
// course + file + portal section). Stored in localStorage.ss_state.
// Portal sections that own the full page — refreshing on these must NOT
// trigger a course/file restore even when ss_state still has old course data.
const PORTAL_ONLY_SECTIONS = [
    'aipage', 'notes', 'chat', 'games', 'lounge', 'editor',
    'notifications', 'profile', 'settings', 'subscription',
    'german', 'admin', 'dashboard',
];
export function initStatePersistence(options) {
    let _stateRestored = false;
    function saveState() {
        try {
            let curTab = null;
            try {
                curTab = sessionStorage.getItem('ss_portal_tab');
            }
            catch {
                /* sessionStorage disabled */
            }
            if (curTab && PORTAL_ONLY_SECTIONS.indexOf(curTab) !== -1) {
                localStorage.removeItem('ss_state');
                return;
            }
            const appEl = document.getElementById('app');
            const pdfEl = document.getElementById('pdfView');
            const appVisible = !!(appEl && appEl.style.display === 'flex');
            const pdfVisible = !!(pdfEl && (pdfEl.style.display === 'flex' || pdfEl.style.display === 'block'));
            if (!appVisible && !pdfVisible)
                return;
            const st = {
                semId: options.getActiveSemId(),
                courseId: options.getActiveCourseId() || undefined,
                fileName: options.getActiveFileName() || undefined,
                section: options.getActiveCourseSection(),
                inApp: true,
            };
            localStorage.setItem('ss_state', JSON.stringify(st));
        }
        catch {
            /* localStorage error */
        }
    }
    function restoreState() {
        if (_stateRestored)
            return;
        _stateRestored = true;
        options.setSsRestoring(true);
        try {
            const raw = localStorage.getItem('ss_state');
            if (!raw)
                return;
            const st = JSON.parse(raw);
            if (!st.inApp)
                return;
            let lastTab = null;
            try {
                lastTab = sessionStorage.getItem('ss_portal_tab') || localStorage.getItem('ss_last_section');
            }
            catch {
                /* sessionStorage disabled */
            }
            if (lastTab && PORTAL_ONLY_SECTIONS.indexOf(lastTab) !== -1)
                return;
            if (st.view === 'studip') {
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
                const sem = sems[options.getActiveSemId()];
                if (sem) {
                    const course = sem.courses.find((c) => c.id === st.courseId);
                    if (course) {
                        options.setActiveCourseId(st.courseId);
                        if (!course.files)
                            course.files = [];
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
                            const rstCached = JSON.parse(localStorage.getItem('ss_uf_cache_' + course.id) || 'null');
                            if (rstCached && Array.isArray(rstCached.files)) {
                                const currentUser = options.getCurrentUser();
                                const rstUid = (currentUser && (currentUser.id || currentUser.sub)) ||
                                    localStorage.getItem('ss_last_uid');
                                course.files = rstCached.files.map((f) => ({
                                    name: f.name,
                                    _storageName: f.storageName,
                                    size: f.size || 0,
                                    date: f.date,
                                    _uploaded: true,
                                    _uid: rstUid,
                                    _course: course,
                                }));
                                course.userFolders = (rstCached.folders || []).map((fd) => ({
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
                                }));
                            }
                        }
                        catch {
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
                }
            }
        }
        catch (e) {
            console.warn('State restore failed:', e);
        }
        finally {
            options.setSsRestoring(false);
        }
    }
    return { saveState, restoreState };
}
//# sourceMappingURL=state-persistence.js.map