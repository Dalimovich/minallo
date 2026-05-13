// Cross-section navigation: portal tabs, Stud.IP/Courses overlay, the
// resume-to-file stash, and the back-and-forth between portal and file
// views. Most functions push DOM state directly because the app shell
// hasn't migrated yet.
import { hideFilesView, showFilesView } from './panels.js';
let _activePortalSection = null;
export function setNavActive(id) {
    document.querySelectorAll('.psb').forEach((el) => {
        el.classList.remove('on');
    });
    const el = document.getElementById(id);
    if (el)
        el.classList.add('on');
}
const SECTION_TITLES = {
    dashboard: 'Dashboard',
    notes: 'Lecture Notes',
    editor: 'Editor',
    profile: 'Profile',
    settings: 'Settings',
    subscription: 'Subscription',
    studip: 'Courses',
    chat: 'Chat',
    notifications: 'Notifications',
    games: 'Games',
    lounge: 'Study Lounge',
    aipage: 'Chatbot',
    german: 'Practice',
};
export function showPortalSection(sec) {
    const gamesItem = document.getElementById('psbGames');
    if (sec === 'games' && gamesItem && gamesItem.classList.contains('st-locked'))
        return;
    const ms = document.querySelector('#portal .main .main-scroll');
    const target = document.getElementById('psec-' + sec);
    const fab = document.getElementById('addWidgetFab');
    const tt = document.getElementById('topTitle');
    function revealTarget() {
        document.querySelectorAll('.portal-section').forEach((el) => {
            el.style.display = 'none';
            el.classList.remove('psec-entering', 'psec-leaving');
        });
        if (!target)
            return;
        target.style.display =
            target.classList.contains('editor-portal-section') || sec === 'chat' ? 'flex' : 'block';
        target.classList.remove('psec-entering');
        void target.offsetWidth;
        target.classList.add('psec-entering');
        if (ms)
            ms.classList.toggle('editor-active', sec === 'editor' || sec === 'chat');
        if (tt)
            tt.textContent = SECTION_TITLES[sec] || sec;
        if (fab)
            fab.classList.toggle('visible', sec === 'dashboard');
        _activePortalSection = target;
        const aiPanel = document.getElementById('aiPanel');
        const aiTab = document.getElementById('aiTab');
        const aiBubble = document.getElementById('aiBubble');
        if (sec !== 'studip') {
            if (typeof window.forceCloseAI === 'function')
                window.forceCloseAI();
            else if (aiPanel)
                aiPanel.classList.remove('visible');
            if (aiTab)
                aiTab.style.display = 'none';
            if (aiBubble)
                aiBubble.style.display = 'none';
            if (typeof window._aiBubbleClose === 'function')
                window._aiBubbleClose();
        }
        else {
            if (aiTab)
                aiTab.style.display = '';
            if (aiBubble)
                aiBubble.style.display = '';
        }
    }
    const leaving = _activePortalSection;
    if (leaving && leaving !== target && leaving.style.display !== 'none') {
        leaving.classList.add('psec-leaving');
        setTimeout(revealTarget, 170);
    }
    else {
        revealTarget();
    }
}
export function showPortal() {
    if (typeof window._statsStopFile === 'function')
        window._statsStopFile();
    const portal = document.getElementById('portal');
    if (!portal)
        return;
    const app = document.getElementById('app');
    const studip = document.getElementById('studipDash');
    const alreadyVisible = portal.classList.contains('show') &&
        portal.style.display !== 'none' &&
        !!app &&
        app.style.display === 'none';
    const studipVisible = !!studip && studip.style.display !== 'none';
    if (!alreadyVisible || studipVisible) {
        hideFilesView();
        portal.style.transition = 'none';
        portal.style.opacity = '0';
        portal.style.transform = 'scale(0.97)';
        portal.style.pointerEvents = 'none';
        portal.style.zIndex = '220';
        portal.classList.add('show');
        void portal.offsetWidth;
        portal.style.transition =
            'opacity 380ms cubic-bezier(0.22,1,0.36,1),transform 380ms cubic-bezier(0.22,1,0.36,1)';
        portal.style.opacity = '1';
        portal.style.transform = 'scale(1)';
        portal.style.pointerEvents = 'auto';
        setTimeout(() => {
            portal.style.zIndex = '';
            portal.style.opacity = '';
            portal.style.transition = '';
            portal.style.transform = '';
            portal.style.display = 'block';
        }, 400);
    }
    else {
        hideFilesView();
        portal.classList.add('show');
        portal.style.display = 'block';
    }
    try {
        const st = JSON.parse(localStorage.getItem('ss_state') || '{}');
        st.inApp = false;
        st.view = '';
        localStorage.setItem('ss_state', JSON.stringify(st));
    }
    catch {
        /* ignore */
    }
}
function _findCourseFile(resume) {
    const sems = window.SEMS || window._SEMS || {};
    const activeSemId = window.activeSemesterId || window._activeSemesterId;
    let course;
    if (activeSemId && sems[activeSemId]) {
        course = (sems[activeSemId].courses || []).find((c) => c.id === resume.courseId);
    }
    if (!course) {
        Object.keys(sems).some((sid) => {
            const c = (sems[sid].courses || []).find((cc) => cc.id === resume.courseId);
            if (c) {
                course = c;
                return true;
            }
            return false;
        });
    }
    if (!course)
        return null;
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
export function stashResumeFile() {
    if (!window.activeFileName || !window.activeCourseId)
        return;
    try {
        if (sessionStorage.getItem('ss_resume_file'))
            return; // don't overwrite
        sessionStorage.setItem('ss_resume_file', JSON.stringify({ courseId: window.activeCourseId, fileName: window.activeFileName }));
    }
    catch {
        /* ignore */
    }
}
export function clearResumeFile() {
    try {
        sessionStorage.removeItem('ss_resume_file');
    }
    catch {
        /* ignore */
    }
}
export function showStudipResume() {
    let raw = null;
    try {
        raw = sessionStorage.getItem('ss_resume_file');
    }
    catch {
        /* ignore */
    }
    if (!raw) {
        showStudip();
        return false;
    }
    let resume = null;
    try {
        resume = JSON.parse(raw);
    }
    catch {
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
    const aiTab = document.getElementById('aiTab');
    const aiBubble = document.getElementById('aiBubble');
    if (aiTab)
        aiTab.style.display = '';
    if (aiBubble)
        aiBubble.style.display = '';
    window.openFile(hit.file, hit.course);
    return true;
}
export function showStudip() {
    hideFilesView();
    const portal = document.getElementById('portal');
    if (portal) {
        portal.classList.add('show');
        portal.style.display = 'block';
    }
    setNavActive('pcStudip');
    if (typeof window.showPortalSection === 'function')
        window.showPortalSection('studip');
    else
        showPortalSection('studip');
    if (typeof window.sdRenderCourses === 'function')
        window.sdRenderCourses();
    try {
        const st = JSON.parse(localStorage.getItem('ss_state') || '{}');
        st.view = 'studip';
        st.inApp = false;
        localStorage.setItem('ss_state', JSON.stringify(st));
    }
    catch {
        /* ignore */
    }
}
export function hideStudip(stRunning) {
    showFilesView(stRunning);
}
export function navTo(navId, section) {
    const appEl = document.getElementById('app');
    const fromFiles = !!(appEl && appEl.style.display !== 'none');
    const studipEl = document.getElementById('studipDash');
    const fromStudip = !!(studipEl && studipEl.style.display !== 'none');
    if (fromFiles)
        stashResumeFile();
    if (fromFiles || fromStudip)
        showPortal();
    setNavActive(navId);
    if (typeof window.showPortalSection === 'function')
        window.showPortalSection(section);
    else
        showPortalSection(section);
}
//# sourceMappingURL=navigation.js.map