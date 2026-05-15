// Minallo document side rail + drawer.
//
// Task-01 wired the shell (rail + empty drawer + resize + route guard).
// Task-02 mounts real working content per mode by HOSTING the existing
// legacy panels inside the drawer rather than reimplementing them:
//   - AI mode:     host #aiPanel    (chat history, composer, chips, send)
//   - Notes mode:  host #pdfNotesPanel and force its tabs to Notes|Saved
//   - Summary mode: host #pdfNotesPanel and force its tabs to Summary|Saved
//
// This keeps the original send / generate / save / load flows untouched
// (we drive them via DOM simulation on the same buttons the legacy
// toolbar callers use) and avoids parallel implementations.
const WIDTH_KEY = 'ss_dr_width';
const WIDTH_MIN = 340;
const WIDTH_MAX = 520;
const WIDTH_DEFAULT = 390;
let _initialized = false;
let _openMode = null;
let _drawerWidth = WIDTH_DEFAULT;
// Track original parents/styles so we can restore the legacy panels on close.
let _aiHomeParent = null;
let _notesHomeParent = null;
function clampWidth(w) {
    if (!Number.isFinite(w))
        return WIDTH_DEFAULT;
    return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(w)));
}
function loadWidth() {
    try {
        const raw = localStorage.getItem(WIDTH_KEY);
        if (raw == null)
            return WIDTH_DEFAULT;
        const n = parseFloat(raw);
        return clampWidth(n);
    }
    catch {
        return WIDTH_DEFAULT;
    }
}
function saveWidth(w) {
    try {
        localStorage.setItem(WIDTH_KEY, String(w));
    }
    catch {
        /* ignore */
    }
}
const HEADER_COPY = {
    ai: { title: 'AI', subtitle: 'Ask this document' },
    notes: { title: 'Notes', subtitle: 'AI-generated notes from this PDF' },
    summary: { title: 'Summary', subtitle: 'AI-generated summary of this PDF' },
};
function $(id) {
    return document.getElementById(id);
}
function applyHeader(mode) {
    const titleEl = $('drTitle');
    const subEl = $('drSubtitle');
    const copy = HEADER_COPY[mode];
    if (titleEl)
        titleEl.textContent = copy.title;
    if (subEl)
        subEl.textContent = copy.subtitle;
}
function updateRailActive(mode) {
    const buttons = document.querySelectorAll('.dr-rail-btn');
    buttons.forEach((b) => {
        const m = b.dataset.drMode;
        b.classList.toggle('is-active', !!m && m === mode);
        b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    });
}
function applyWidth(drawer, w) {
    drawer.style.width = w + 'px';
}
function updateDrawerModeClass(drawer, mode) {
    drawer.classList.remove('dr-mode-ai', 'dr-mode-notes', 'dr-mode-summary');
    if (mode)
        drawer.classList.add('dr-mode-' + mode);
}
// ── Trash button label/state per mode ────────────────────────────────────
function configureTrash(mode) {
    const trash = $('drTrash');
    if (!trash)
        return;
    // Clear previous handler.
    trash.onclick = null;
    trash.disabled = false;
    trash.removeAttribute('aria-disabled');
    if (mode === 'ai') {
        trash.title = 'Clear chat';
        trash.setAttribute('aria-label', 'Clear chat');
        trash.onclick = () => {
            const btn = document.getElementById('aiClearBtn');
            if (btn)
                btn.click();
        };
    }
    else {
        // Notes / Summary — delete the currently-loaded note for this tab.
        trash.title = 'Delete current note';
        trash.setAttribute('aria-label', 'Delete current note');
        const np = window._notesPanel;
        if (np && typeof np.delete === 'function') {
            trash.onclick = () => np.delete();
        }
        else {
            trash.disabled = true;
            trash.setAttribute('aria-disabled', 'true');
            trash.title = 'Coming soon';
        }
    }
}
// ── Host content area helpers ────────────────────────────────────────────
function getContentEl() {
    const drawer = $('drDrawer');
    if (!drawer)
        return null;
    return drawer.querySelector('.dr-content');
}
function clearDrawerContent() {
    const content = getContentEl();
    if (!content)
        return;
    // Move out any hosted legacy panels before clearing innerHTML so we don't
    // destroy live DOM nodes the legacy modules still reference.
    restoreAiPanel();
    restoreNotesPanel();
    content.innerHTML = '';
}
// ── AI mode: host the legacy #aiPanel inside the drawer ──────────────────
function mountAiPanel() {
    const content = getContentEl();
    if (!content)
        return;
    const panel = document.getElementById('aiPanel');
    if (!panel) {
        content.innerHTML = '<div class="dr-empty">AI panel not loaded yet.</div>';
        return;
    }
    if (!_aiHomeParent)
        _aiHomeParent = panel.parentElement;
    // The ai-bubble.js `detachPanel` may have set fixed positioning. Override.
    panel.classList.add('dr-host-ai');
    panel.style.position = 'static';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '100%';
    panel.style.height = '100%';
    panel.style.zIndex = '';
    panel.style.opacity = '1';
    panel.style.transform = 'none';
    panel.style.borderRadius = '0';
    panel.style.boxShadow = 'none';
    panel.style.border = 'none';
    panel.style.background = 'transparent';
    panel.style.display = 'flex';
    // Make sure the legacy bridge treats the panel as visible so renders run.
    panel.classList.add('visible');
    content.appendChild(panel);
    // Restore chat history via existing bridge.
    const w = window;
    if (typeof w.openAI === 'function') {
        try {
            w.openAI();
        }
        catch (_e) { /* ignore */ }
    }
    // Pin the panel so ai-panel-bridge's mouseleave→closeAI auto-close doesn't
    // remove `.visible` (which kills input/send) when the cursor leaves the
    // drawer. The drawer has its own X / Esc / rail-toggle close paths.
    if (typeof w.pinAI === 'function') {
        try {
            w.pinAI();
        }
        catch (_e) { /* ignore */ }
    }
    // Auto-focus the input after the drawer transition (~240ms).
    window.setTimeout(() => {
        const input = document.getElementById('aiInput');
        if (!input)
            return;
        try {
            input.focus({ preventScroll: true });
        }
        catch {
            input.focus();
        }
    }, 240);
}
function restoreAiPanel() {
    const panel = document.getElementById('aiPanel');
    if (!panel || !panel.classList.contains('dr-host-ai'))
        return;
    panel.classList.remove('dr-host-ai', 'visible');
    // Reset overrides so the bubble path (if ever re-enabled) still works.
    panel.style.position = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.transform = '';
    panel.style.opacity = '';
    panel.style.borderRadius = '';
    panel.style.boxShadow = '';
    panel.style.border = '';
    panel.style.background = '';
    panel.style.display = '';
    // Park it back on document.body (where ai-bubble.js's detachPanel left it),
    // hidden until next open. We don't try to put it back inside #pdfViewerWrap
    // because that container may have been swapped out by route navigation.
    if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
    }
}
// ── Notes / Summary mode: host the legacy #pdfNotesPanel ─────────────────
function ensureNotesPanel() {
    let panel = document.getElementById('pdfNotesPanel');
    if (panel)
        return panel;
    // The legacy module exposes ensure() which reads window.activeCourseId /
    // window.activeFileName, calls _createPanel + _injectToolbarButton, and
    // resolves the documentId. open() alone is not enough — it bails when
    // #pdfNotesPanel doesn't exist yet, and the one-shot 500ms init timer in
    // notes-panel.js can miss in some PDF-open flows.
    const w = window;
    if (w._notesPanel && typeof w._notesPanel.ensure === 'function') {
        try {
            w._notesPanel.ensure();
        }
        catch (_e) { /* ignore */ }
    }
    else if (w._notesPanel && typeof w._notesPanel.open === 'function') {
        try {
            w._notesPanel.open();
        }
        catch (_e) { /* ignore */ }
    }
    panel = document.getElementById('pdfNotesPanel');
    return panel;
}
function mountNotesPanel(mode) {
    const content = getContentEl();
    if (!content)
        return;
    const panel = ensureNotesPanel();
    if (!panel) {
        content.innerHTML =
            '<div class="dr-empty">Open a PDF first to use Notes & Summary tools.</div>';
        return;
    }
    if (!_notesHomeParent)
        _notesHomeParent = panel.parentElement;
    // The legacy open() may have set #pdfView to .pdf-split — undo so the
    // PDF page keeps its full width while the drawer hosts the panel.
    const pdfView = document.getElementById('pdfView');
    if (pdfView)
        pdfView.classList.remove('pdf-split');
    // Reset legacy inline styles & host inside the drawer.
    panel.classList.add('dr-host-notes');
    panel.style.position = 'static';
    panel.style.display = 'flex';
    panel.style.width = '100%';
    panel.style.height = '100%';
    panel.style.left = '';
    panel.style.right = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.border = 'none';
    panel.style.boxShadow = 'none';
    panel.style.background = 'transparent';
    content.appendChild(panel);
    // Switch to the relevant tab (Notes drawer → notes tab; Summary drawer →
    // summary tab). Simulating a click drives the legacy state machine
    // correctly (tabs, detail-row visibility, content render).
    const wantTab = mode === 'summary' ? 'summary' : 'notes';
    const tabBtn = panel.querySelector('.np-tab[data-tab="' + wantTab + '"]');
    if (tabBtn && !tabBtn.classList.contains('active'))
        tabBtn.click();
    // Set a mode marker on the panel so CSS can hide the irrelevant tab.
    panel.classList.remove('dr-mode-notes', 'dr-mode-summary');
    panel.classList.add('dr-mode-' + mode);
}
function restoreNotesPanel() {
    const panel = document.getElementById('pdfNotesPanel');
    if (!panel || !panel.classList.contains('dr-host-notes'))
        return;
    panel.classList.remove('dr-host-notes', 'dr-mode-notes', 'dr-mode-summary');
    panel.style.position = '';
    panel.style.display = 'none';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.border = '';
    panel.style.boxShadow = '';
    panel.style.background = '';
    if (_notesHomeParent && panel.parentElement !== _notesHomeParent) {
        _notesHomeParent.appendChild(panel);
    }
}
// ── Drawer open/close/switch ─────────────────────────────────────────────
function renderModeContent(mode) {
    clearDrawerContent();
    configureTrash(mode);
    if (mode === 'ai') {
        mountAiPanel();
    }
    else {
        mountNotesPanel(mode);
    }
}
const MOBILE_MQ = '(max-width: 768px)';
function isMobileViewport() {
    try {
        return window.matchMedia(MOBILE_MQ).matches;
    }
    catch {
        return false;
    }
}
function openDrawer(mode) {
    const drawer = $('drDrawer');
    if (!drawer)
        return;
    const wasOpen = _openMode != null;
    _openMode = mode;
    applyHeader(mode);
    updateDrawerModeClass(drawer, mode);
    drawer.hidden = false;
    // Decide presentation mode at open time. Once open, we keep whatever
    // mode we picked even if the viewport is resized across the breakpoint.
    if (!wasOpen) {
        const sheet = isMobileViewport();
        drawer.classList.toggle('dr-sheet', sheet);
        const root = $('drRoot');
        if (root)
            root.classList.toggle('is-sheet-open', sheet);
    }
    void drawer.offsetWidth;
    drawer.classList.add('is-open');
    // On mobile (sheet mode) CSS forces full-width; don't apply the persisted
    // desktop width.
    if (!drawer.classList.contains('dr-sheet')) {
        applyWidth(drawer, _drawerWidth);
    }
    updateRailActive(mode);
    // Render after the slide-in starts so we don't pay the cost during the
    // transition; tiny delay also helps the input auto-focus feel natural.
    if (wasOpen) {
        // Mode switch — render immediately.
        renderModeContent(mode);
    }
    else {
        window.setTimeout(() => {
            if (_openMode === mode)
                renderModeContent(mode);
        }, 40);
    }
}
function closeDrawer() {
    const drawer = $('drDrawer');
    if (!drawer)
        return;
    _openMode = null;
    drawer.classList.remove('is-open');
    // Clear sheet-mode state on close so the next open re-evaluates the
    // viewport.
    const wasSheet = drawer.classList.contains('dr-sheet');
    drawer.classList.remove('dr-sheet');
    const rootEl = $('drRoot');
    if (rootEl)
        rootEl.classList.remove('is-sheet-open');
    if (wasSheet) {
        // Strip the inline width that JS might have left behind from a prior
        // desktop session so it doesn't leak back when the user resizes up.
        drawer.style.width = '';
    }
    updateDrawerModeClass(drawer, null);
    updateRailActive(null);
    // Tear down hosted content so legacy modules' references stay valid.
    clearDrawerContent();
    const onEnd = () => {
        if (!drawer.classList.contains('is-open'))
            drawer.hidden = true;
        drawer.removeEventListener('transitionend', onEnd);
    };
    drawer.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
        if (!drawer.classList.contains('is-open'))
            drawer.hidden = true;
    }, 360);
}
function toggleMode(mode) {
    if (_openMode === mode) {
        closeDrawer();
    }
    else {
        openDrawer(mode);
    }
}
function wireResize() {
    const drawer = $('drDrawer');
    const handle = $('drResize');
    if (!drawer || !handle)
        return;
    let dragging = false;
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
        if (!dragging)
            return;
        const dx = e.clientX - startX;
        const next = clampWidth(startW - dx);
        _drawerWidth = next;
        applyWidth(drawer, next);
    };
    const onUp = () => {
        if (!dragging)
            return;
        dragging = false;
        handle.classList.remove('is-active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveWidth(_drawerWidth);
    };
    handle.addEventListener('mousedown', (e) => {
        // Resize is desktop-only — disable in mobile bottom-sheet mode.
        if (drawer.classList.contains('dr-sheet'))
            return;
        dragging = true;
        startX = e.clientX;
        startW = drawer.offsetWidth || _drawerWidth;
        handle.classList.add('is-active');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        e.preventDefault();
    });
}
function wireRailButtons() {
    const buttons = document.querySelectorAll('.dr-rail-btn');
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.drMode;
            if (!mode)
                return;
            toggleMode(mode);
        });
    });
}
function wireClose() {
    const btn = $('drClose');
    if (btn)
        btn.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _openMode != null) {
            closeDrawer();
        }
    });
}
function setRouteVisibility(route) {
    const root = $('drRoot');
    if (!root)
        return;
    root.hidden = false;
    root.classList.toggle('is-pdf', route === 'pdf');
    root.classList.toggle('is-courses', route === 'courses');
    if (route === 'other' && _openMode != null) {
        closeDrawer();
    }
}
export function initDocumentRail() {
    if (_initialized)
        return;
    const root = $('drRoot');
    if (!root) {
        window.addEventListener('ss-ready', () => initDocumentRail(), { once: true });
        return;
    }
    _initialized = true;
    _drawerWidth = loadWidth();
    const drawer = $('drDrawer');
    if (drawer)
        applyWidth(drawer, _drawerWidth);
    wireRailButtons();
    wireClose();
    wireResize();
    const w = window;
    w.__minalloDocRail = {
        setRouteVisibility,
        open: openDrawer,
        close: closeDrawer,
    };
    root.classList.remove('is-pdf', 'is-courses');
}
//# sourceMappingURL=document-rail.js.map