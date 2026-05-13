import { showCourseSection } from './course-view.js';
import { listCourseDocuments, indexExistingDocument, generateStudyTool, } from '../../services/ai-service.js';
// Session-level cache: prevents re-triggering files already confirmed or in-flight.
// Key: courseId + ':' + fname.toLowerCase() → 'ready' | 'triggered'
const _ragConfirmed = {};
export function bindFileEvents(co, course) {
    let selectMode = false;
    let selectedFiles = [];
    function updateMultiBar() {
        const bar = co.querySelector('#coMultiBar');
        const cnt = co.querySelector('#coSelCount');
        const btn = co.querySelector('#coMultiSumBtn');
        if (!bar || !cnt || !btn)
            return;
        cnt.textContent = String(selectedFiles.length);
        bar.classList.toggle('show', selectedFiles.length > 0);
        btn.disabled = selectedFiles.length === 0;
        btn.title = selectedFiles.length === 0 ? 'Select at least 1 file' : '';
        if (selectedFiles.length === 1)
            btn.textContent = '✨ AI Chat (1 file)';
        else if (selectedFiles.length > 1)
            btn.textContent = '✨ AI Chat (' + selectedFiles.length + ' files)';
        else
            btn.textContent = '✨ AI Chat';
    }
    initCourseStudyTools(co, course);
    // ── Select toggle ────────────────────────────────────────────────────────
    const selectToggle = co.querySelector('#coSelectToggle');
    selectToggle?.addEventListener('click', () => {
        selectMode = !selectMode;
        selectToggle.classList.toggle('active', selectMode);
        selectToggle.textContent = selectMode ? '✕ Cancel selection' : '☑ Select multiple';
        const filesList = co.querySelector('#coFilesList');
        filesList?.classList.toggle('co-select-mode', selectMode);
        co.querySelectorAll('.co-folder-files').forEach((fl) => {
            fl.classList.toggle('co-select-mode', selectMode);
        });
        co.querySelectorAll('.co-folder-select-all-btn').forEach((b) => {
            b.style.display = selectMode ? '' : 'none';
        });
        if (!selectMode) {
            selectedFiles = [];
            co.querySelectorAll('.co-file').forEach((el) => el.classList.remove('selected'));
            co.querySelectorAll('.co-file-cb').forEach((cb) => cb.classList.remove('checked'));
            updateMultiBar();
        }
    });
    // ── Multi-select clear ───────────────────────────────────────────────────
    co.querySelector('#coMultiClear')?.addEventListener('click', () => {
        selectedFiles = [];
        co.querySelectorAll('.co-file').forEach((el) => el.classList.remove('selected'));
        co.querySelectorAll('.co-file-cb').forEach((cb) => cb.classList.remove('checked'));
        updateMultiBar();
    });
    // ── Multi AI summary ─────────────────────────────────────────────────────
    const multiSumBtn = co.querySelector('#coMultiSumBtn');
    multiSumBtn?.addEventListener('click', () => {
        if (selectedFiles.length === 0)
            return;
        const files = selectedFiles.slice();
        const btn = multiSumBtn;
        const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
        btn.disabled = true;
        btn.textContent = 'Loading…';
        const promises = files.map((f) => new Promise((resolve) => {
            function fromBytes(bytes) {
                window
                    ._ssEnsurePdfJs?.()
                    .then(() => {
                    return window.pdfjsLib
                        .getDocument({ data: bytes })
                        .promise.then((pdf) => {
                        const pdfDoc = pdf;
                        const pp = [];
                        for (let p = 1; p <= Math.min(pdfDoc.numPages, 15); p++) {
                            pp.push(pdfDoc.getPage(p).then((pg) => pg.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))));
                        }
                        Promise.all(pp)
                            .then((pages) => resolve('=== ' + f.name + ' ===\n' + pages.join('\n')))
                            .catch(() => resolve('=== ' + f.name + ' === [extraction failed]'));
                    })
                        .catch(() => resolve('=== ' + f.name + ' === [could not open]'));
                })
                    .catch(() => resolve('=== ' + f.name + ' === [could not load PDF.js]'));
            }
            if (f.sname && uid) {
                window._ufFetchBytes?.(uid, course, f.sname, f.folder || null)
                    .then(fromBytes)
                    .catch(() => resolve('=== ' + f.name + ' === [fetch failed]'));
            }
            else {
                const path = window.PDF_DATA && window.PDF_DATA[f.name];
                if (path) {
                    window._fetchPdfBytes?.(path, fromBytes, () => resolve('=== ' + f.name + ' === [not available]'));
                }
                else {
                    resolve('=== ' + f.name + ' === [not available in demo]');
                }
            }
        }));
        Promise.all(promises).then((parts) => {
            window.pdfFullText = parts.join('\n\n');
            const names = files.map((f) => f.name.replace(/\.pdf$/i, ''));
            window.activeFileName = names.join(', ');
            if (typeof window.openAI === 'function')
                window.openAI();
            const chatEl = document.getElementById('aiChat');
            if (chatEl)
                chatEl.innerHTML = '';
            const intro = '📂 **' + files.length + ' file' + (files.length !== 1 ? 's' : '') + ' loaded:**\n' +
                files.map((f) => '- ' + f.name).join('\n') +
                '\n\nAsk me anything — I can summarise, compare, explain concepts, generate quizzes, and more.';
            if (typeof window.addBotMsg === 'function')
                window.addBotMsg(intro);
            btn.disabled = false;
            updateMultiBar();
        });
    });
    // ── Multi delete ─────────────────────────────────────────────────────────
    co.querySelector('#coMultiDeleteBtn')?.addEventListener('click', () => {
        const toDelete = selectedFiles.slice();
        if (!toDelete.length)
            return;
        if (!confirm('Delete ' + toDelete.length + ' file' + (toDelete.length !== 1 ? 's' : '') + '?'))
            return;
        const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
        if (!uid)
            return;
        toDelete.forEach((s) => {
            window._ufDelete?.(course, s.name, s.folder || null, s.sname || null);
        });
        selectedFiles = [];
        showCourseSection(course, 'files');
        if (typeof window.showToast === 'function') {
            window.showToast('Deleted', toDelete.length + ' file' + (toDelete.length !== 1 ? 's' : '') + ' removed');
        }
    });
    // ── Multi move ───────────────────────────────────────────────────────────
    const multiMoveBtn = co.querySelector('#coMultiMoveBtn');
    multiMoveBtn?.addEventListener('click', () => {
        if (!selectedFiles.length)
            return;
        const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
        if (!uid)
            return;
        window._glMoveDestPicker?.(uid, course, async (toCourse, toFolder) => {
            multiMoveBtn.textContent = 'Moving…';
            multiMoveBtn.disabled = true;
            const toMove = selectedFiles.slice();
            try {
                await Promise.all(toMove.map((s) => window._ufMoveFileTo?.(uid, course, toCourse, s.name, s.folder || null, toFolder, s.sname || null)));
                course.userFolders = null;
                course.files = (course.files || [])
                    .filter((f) => !(f._uploaded && toMove.some((s) => s.name === f.name)));
                selectedFiles = [];
                await window._ufMerge?.(course);
                showCourseSection(course, 'files');
                const destCard = toCourse.id !== course.id ? toCourse.name || toCourse.id : null;
                const destFolder = toFolder ? '"' + toFolder + '"' : 'root';
                const destLabel = destCard ? destCard + (toFolder ? ' / ' + toFolder : '') : destFolder;
                if (typeof window.showToast === 'function') {
                    window.showToast('Moved ✓', toMove.length + ' file' + (toMove.length !== 1 ? 's' : '') + ' → ' + destLabel);
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : 'Move failed';
                if (typeof window.showToast === 'function')
                    window.showToast('Move failed', msg);
            }
        });
    });
    // ── File row click (open / select) ───────────────────────────────────────
    co.querySelectorAll('.co-file[data-fname]').forEach((el) => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = e.target;
            if (target?.closest('.co-dl-btn') ||
                target?.closest('.co-del-btn') ||
                target?.closest('.co-reindex-btn') ||
                target?.closest('.co-rag-status')) {
                return;
            }
            const fname = el.getAttribute('data-fname');
            if (!fname)
                return;
            const folderAttr = el.getAttribute('data-folder') || null;
            const snameAttr = el.querySelector('.co-del-btn')?.getAttribute('data-sname') || null;
            if (selectMode) {
                const idx = selectedFiles.findIndex((s) => s.name === fname && s.folder === folderAttr);
                if (idx === -1) {
                    selectedFiles.push({ name: fname, folder: folderAttr, sname: snameAttr });
                    el.classList.add('selected');
                    el.querySelector('.co-file-cb')?.classList.add('checked');
                }
                else {
                    selectedFiles.splice(idx, 1);
                    el.classList.remove('selected');
                    el.querySelector('.co-file-cb')?.classList.remove('checked');
                }
                updateMultiBar();
                return;
            }
            let f;
            if (folderAttr) {
                const fd = (course.userFolders || []).find((x) => x.name === folderAttr);
                if (fd)
                    f = (fd.files || []).find((x) => x.name === fname);
            }
            else {
                f = (course.files || []).find((x) => x.name === fname);
            }
            if (f) {
                if (typeof window.openFile === 'function')
                    window.openFile(f, course);
            }
            else if (typeof window.showToast === 'function') {
                window.showToast('File not found', 'Try refreshing the course');
            }
        });
    });
    // ── Download button ──────────────────────────────────────────────────────
    co.querySelectorAll('.co-dl-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fname = btn.getAttribute('data-fname');
            if (typeof window.downloadFile === 'function' && fname)
                window.downloadFile(fname);
        });
    });
    // ── Delete uploaded file ─────────────────────────────────────────────────
    co.querySelectorAll('.co-del-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fname = btn.getAttribute('data-fname');
            const sname = btn.getAttribute('data-sname') || null;
            const folder = btn.getAttribute('data-folder') || null;
            if (!fname)
                return;
            const where = folder ? 'from folder "' + folder + '"' : 'from this course';
            if (!confirm('Delete "' + fname + '" ' + where + '?'))
                return;
            window._ufDelete?.(course, fname, folder, sname);
            showCourseSection(course, 'files');
        });
    });
    // ── Re-index button ──────────────────────────────────────────────────────
    co.querySelectorAll('.co-reindex-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fname = btn.getAttribute('data-fname');
            const sname = btn.getAttribute('data-sname') || null;
            const folder = btn.getAttribute('data-folder') || null;
            if (!sname || !fname)
                return;
            btn.textContent = '⏳';
            btn.style.pointerEvents = 'none';
            indexExistingDocument(course.id, sname, fname, _guessSourceType(fname), folder, { ..._guessDocMeta(fname), forceReindex: true })
                .then(() => {
                btn.textContent = '✓ AI';
                btn.style.background = 'rgba(6,214,160,.15)';
                btn.style.color = 'rgba(6,214,160,.9)';
                btn.style.borderColor = 'rgba(6,214,160,.3)';
                if (typeof window.showToast === 'function') {
                    window.showToast('Re-indexed', '"' + fname + '" is now updated for AI.');
                }
                try {
                    _bindRagStatus(co, course);
                }
                catch { /* ignore */ }
            })
                .catch(() => {
                btn.textContent = '↺ AI';
                btn.style.pointerEvents = '';
                if (typeof window.showToast === 'function') {
                    window.showToast('Error', 'Re-index failed. Try again.');
                }
            });
        });
    });
    // ── Reindex-all button ───────────────────────────────────────────────────
    const reindexAllBtn = co.querySelector('#coReindexAllBtn');
    reindexAllBtn?.addEventListener('click', () => {
        const targets = [];
        (course.files || []).forEach((f) => {
            if (f._uploaded && f._storageName && /\.pdf$/i.test(f.name)) {
                targets.push({ fname: f.name, sname: f._storageName, folder: null });
            }
        });
        (course.userFolders || []).forEach((fd) => {
            (fd.files || []).forEach((f) => {
                if (f._uploaded && f._storageName && /\.pdf$/i.test(f.name)) {
                    targets.push({ fname: f.name, sname: f._storageName, folder: fd.name });
                }
            });
        });
        if (!targets.length) {
            if (typeof window.showToast === 'function') {
                window.showToast('Nothing to reindex', 'No uploaded PDFs in this course.');
            }
            return;
        }
        if (!confirm('Re-index ' + targets.length + ' PDF' + (targets.length === 1 ? '' : 's') + ' in this course? This may take a few minutes.'))
            return;
        reindexAllBtn.disabled = true;
        const origLabel = reindexAllBtn.textContent || '';
        let done = 0;
        let failed = 0;
        function updateLabel() {
            reindexAllBtn.textContent = '⏳ ' + done + ' / ' + targets.length;
        }
        updateLabel();
        function _waitForDoc(docId) {
            return new Promise((resolve) => {
                let attempts = 0;
                const MAX = 60;
                (function poll() {
                    if (attempts++ >= MAX)
                        return resolve({ status: 'timeout', error: null });
                    listCourseDocuments(course.id)
                        .then((docs) => {
                        const d = (docs || []).find((x) => x.id === docId);
                        if (!d)
                            return setTimeout(poll, 3000);
                        if (d.processing_status === 'ready' || d.processing_status === 'failed') {
                            return resolve({
                                status: d.processing_status,
                                error: d.processing_error || null,
                            });
                        }
                        setTimeout(poll, 3000);
                    })
                        .catch(() => setTimeout(poll, 3000));
                })();
            });
        }
        function _runOne(t, retry) {
            return indexExistingDocument(course.id, t.sname, t.fname, _guessSourceType(t.fname), t.folder, { ..._guessDocMeta(t.fname), forceReindex: true })
                .then((res) => {
                const r = res;
                if (!r || !r.documentId)
                    return { status: 'failed', error: null };
                return _waitForDoc(r.documentId);
            })
                .then((result) => {
                if (result.status === 'ready')
                    return result;
                if (!retry) {
                    return new Promise((r) => setTimeout(r, 1500)).then(() => _runOne(t, true));
                }
                return result;
            })
                .catch((e) => {
                const msg = e instanceof Error ? e.message : '';
                if (msg === 'SESSION_EXPIRED') {
                    return { status: 'failed', error: 'Session expired — please refresh the page and try again.' };
                }
                return { status: 'failed', error: null };
            });
        }
        let i = 0;
        const failedErrors = [];
        function next() {
            if (i >= targets.length) {
                reindexAllBtn.disabled = false;
                reindexAllBtn.textContent = origLabel;
                if (typeof window.showToast === 'function') {
                    let msg = done + ' succeeded' + (failed ? ', ' + failed + ' failed' : '') + '.';
                    if (failedErrors.length === 1 && failedErrors[0])
                        msg += ' Error: ' + failedErrors[0];
                    window.showToast('Reindex complete', msg);
                }
                try {
                    _bindRagStatus(co, course);
                }
                catch { /* ignore */ }
                return;
            }
            const t = targets[i++];
            _runOne(t, false).then((result) => {
                if (result.status === 'ready')
                    done++;
                else {
                    failed++;
                    if (result.error)
                        failedErrors.push(result.error);
                }
                updateLabel();
                try {
                    _bindRagStatus(co, course);
                }
                catch { /* ignore */ }
                next();
            });
        }
        next();
    });
    // ── RAG status indicators ────────────────────────────────────────────────
    _bindRagStatus(co, course);
    // ── Upload button ────────────────────────────────────────────────────────
    const uploadBtn = co.querySelector('#coUploadBtn');
    const uploadInput = co.querySelector('#coUploadInput');
    if (uploadBtn && uploadInput) {
        uploadBtn.addEventListener('click', () => {
            const folders = (course.userFolders || []).map((fd) => fd.name);
            if (folders.length === 0) {
                uploadInput._targetFolder = null;
                uploadInput.click();
            }
            else {
                window._showFolderPickerPopup?.(uploadBtn, folders, (chosen) => {
                    uploadInput._targetFolder = chosen;
                    uploadInput.click();
                });
            }
        });
    }
    if (uploadInput) {
        uploadInput.addEventListener('change', function () {
            const files = Array.from(this.files || []);
            if (!files.length)
                return;
            const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
            if (!uid) {
                if (typeof window.showToast === 'function') {
                    window.showToast('Not signed in', 'Sign in to upload files.');
                }
                return;
            }
            const toolbar = co.querySelector('.co-files-toolbar');
            const progWrap = document.createElement('div');
            progWrap.className = 'co-upload-progress';
            progWrap.innerHTML =
                '<div class="co-upload-progress-label"><span id="coProgLabel">Uploading 0 / ' + files.length +
                    '…</span><span id="coProgPct">0%</span></div>' +
                    '<div class="co-upload-progress-track"><div class="co-upload-progress-bar" id="coProgBar" style="width:0%"></div></div>';
            if (toolbar)
                toolbar.appendChild(progWrap);
            let completed = 0;
            const totalPct = new Array(files.length).fill(0);
            function updateProgress(idx, pct) {
                totalPct[idx] = pct;
                const avg = Math.round(totalPct.reduce((a, b) => a + b, 0) / files.length);
                const bar = co.querySelector('#coProgBar');
                const label = co.querySelector('#coProgLabel');
                const pctEl = co.querySelector('#coProgPct');
                if (bar)
                    bar.style.width = avg + '%';
                if (pctEl)
                    pctEl.textContent = avg + '%';
                if (label)
                    label.textContent = 'Uploading ' + completed + ' / ' + files.length + '…';
            }
            const targetFolder = this._targetFolder || null;
            Promise.all(files.map((file, idx) => window
                ._ufUpload?.(uid, course, file, (pct) => updateProgress(idx, pct), targetFolder)
                .then(() => {
                completed++;
                updateProgress(idx, 100);
            })))
                .then(() => {
                if (progWrap.parentNode)
                    progWrap.parentNode.removeChild(progWrap);
                course.files = (course.files || [])
                    .filter((f) => !f._uploaded);
                return window._ufMerge?.(course);
            })
                .then(() => {
                try {
                    const courseFiles = (course.files || []);
                    const toCache = {
                        files: courseFiles
                            .filter((f) => f._uploaded && !f._folder)
                            .map((f) => ({ name: f.name, storageName: f._storageName, size: f.size, date: f.date })),
                        folders: (course.userFolders || []).map((fd) => ({
                            name: fd.name,
                            files: fd.files.map((f) => ({
                                name: f.name, storageName: f._storageName, size: f.size, date: f.date,
                            })),
                        })),
                    };
                    localStorage.setItem('ss_uf_cache_' + course.id, JSON.stringify(toCache));
                }
                catch { /* quota */ }
                showCourseSection(course, 'files');
                if (typeof window.showToast === 'function') {
                    window.showToast('Files uploaded', '' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' added to ' + (course.short || course.name));
                }
                // Auto-index any newly uploaded PDFs for RAG
                const pdfFiles = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
                if (pdfFiles.length && course.id) {
                    const allFiles = (course.files || []);
                    pdfFiles.forEach((pf) => {
                        const merged = allFiles.find((x) => x.name === pf.name && x._uploaded && x._storageName);
                        if (merged && merged._storageName) {
                            indexExistingDocument(course.id, merged._storageName, merged.name, _guessSourceType(merged.name), merged._folder || null, _guessDocMeta(merged.name)).catch(() => { });
                        }
                    });
                }
            })
                .catch((e) => {
                if (progWrap.parentNode)
                    progWrap.parentNode.removeChild(progWrap);
                const msg = e instanceof Error ? e.message : 'Please try again.';
                if (typeof window.showToast === 'function')
                    window.showToast('Upload failed', msg);
            });
            this.value = '';
        });
    }
}
function initCourseStudyTools(co, course) {
    window._generateStudyTool = generateStudyTool;
    co.querySelectorAll('[data-course-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-course-tab') || 'files';
            setCourseStudyMode(co, course, tabName);
            if (typeof window.showCourseSection === 'function') {
                window.showCourseSection(course, tabName);
            }
        });
    });
}
function setCourseStudyMode(co, course, mode) {
    const nextMode = ['files', 'quiz', 'flashcards'].includes(mode) ? mode : 'files';
    co.querySelectorAll('[data-course-tab]').forEach((tab) => {
        const isActive = tab.getAttribute('data-course-tab') === nextMode;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    co.querySelectorAll('[data-course-panel]').forEach((panel) => {
        panel.classList.toggle('active', panel.getAttribute('data-course-panel') === nextMode);
    });
    const inner = co.closest('.co-inner');
    if (inner)
        inner.classList.toggle('co-inner-wide', nextMode === 'quiz' || nextMode === 'flashcards');
    if (nextMode === 'quiz') {
        const quizPanel = co.querySelector('#coQuizPanel');
        if (quizPanel) {
            (function tryMountQuiz() {
                if (typeof window.mountQuiz === 'function') {
                    if (!quizPanel.dataset.qzMounted) {
                        quizPanel.dataset.qzMounted = '1';
                        window.mountQuiz(quizPanel, course, { generate: generateStudyTool });
                    }
                    else if (typeof window.resetQuizToGrid === 'function') {
                        window.resetQuizToGrid(quizPanel);
                    }
                }
                else {
                    setTimeout(tryMountQuiz, 80);
                }
            })();
        }
        return;
    }
    if (nextMode === 'flashcards') {
        const flashPanel = co.querySelector('#coFlashPanel');
        if (flashPanel) {
            (function tryMountFlashcards() {
                if (typeof window.mountFlashcards === 'function') {
                    if (!flashPanel.dataset.fcMounted) {
                        flashPanel.dataset.fcMounted = '1';
                        window.mountFlashcards(flashPanel, course, { generate: generateStudyTool });
                    }
                    else if (typeof window.resetFlashcardsToGrid === 'function') {
                        window.resetFlashcardsToGrid(flashPanel);
                    }
                }
                else {
                    setTimeout(tryMountFlashcards, 80);
                }
            })();
        }
    }
}
function _guessSourceType(fileName) {
    const n = fileName.toLowerCase();
    if (n.includes('lösung') || n.includes('loesung') || n.includes('solution'))
        return 'solution';
    if (n.includes('aufgabe') || n.includes('exercise') || n.includes('übung') || n.includes('ag_'))
        return 'exercise';
    if (n.includes('exam') || n.includes('klausur') || n.includes('prüfung'))
        return 'exam';
    if (n.includes('formelzettel') || n.includes('formelsammlung') || n.includes('formel') ||
        n.includes('zusammenfassung') || n.includes('summary') || n.includes('cheatsheet') ||
        n.includes('cheat sheet') || n.includes('merkblatt') || n.includes('überblick'))
        return 'summary';
    if (n.includes('notes') || n.includes('notiz') || n.includes('mitschrift'))
        return 'notes';
    return 'lecture';
}
function _guessDocMeta(fileName) {
    const n = fileName.replace(/\.[^.]+$/, '');
    const meta = {};
    let m = n.match(/(?:lecture|vorlesung|vl|lec)[_\s-]*(\d+)/i);
    if (m && m[1]) {
        meta.lectureNumber = parseInt(m[1], 10);
        return meta;
    }
    m = n.match(/(?:exercise|aufgabe|seminar|ag|uebung|übung|ue)[_\s-]*(\d+)/i);
    if (m && m[1]) {
        meta.exerciseNumber = parseInt(m[1], 10);
        return meta;
    }
    return meta;
}
// Simple FIFO throttle. Concurrency 1 — pgvector HNSW serializes inserts
// anyway, and parallel triggers cause Supabase statement_timeout cascades.
const _ragQueue = [];
let _ragRunning = 0;
const _RAG_CONCURRENCY = 1;
function _ragEnqueue(fn) {
    return new Promise((resolve) => {
        _ragQueue.push(() => {
            _ragRunning++;
            Promise.resolve()
                .then(fn)
                .catch(() => { })
                .then(() => {
                _ragRunning--;
                resolve();
                _ragDrain();
            });
        });
        _ragDrain();
    });
}
function _ragDrain() {
    while (_ragRunning < _RAG_CONCURRENCY && _ragQueue.length) {
        const next = _ragQueue.shift();
        if (next)
            next();
    }
}
async function _bindRagStatus(co, course) {
    const courseId = course.id;
    if (!courseId)
        return;
    const sessionReady = window._sbSessionReady;
    if (sessionReady) {
        try {
            await sessionReady;
        }
        catch { /* ignore */ }
    }
    if (!window._sbToken)
        return;
    let ragDocs = [];
    try {
        ragDocs = await listCourseDocuments(courseId);
    }
    catch { /* ignore */ }
    function _statusRank(s) {
        if (s === 'ready')
            return 0;
        if (s === 'failed')
            return 1;
        return 2;
    }
    const ragMap = {};
    ragDocs.forEach((d) => {
        const key = d.file_name.toLowerCase();
        const prev = ragMap[key];
        if (!prev) {
            ragMap[key] = d;
            return;
        }
        const prevRank = _statusRank(prev.processing_status);
        const curRank = _statusRank(d.processing_status);
        if (curRank < prevRank) {
            ragMap[key] = d;
            return;
        }
        if (curRank === prevRank) {
            const prevTime = prev.updated_at || prev.created_at || '';
            const curTime = d.updated_at || d.created_at || '';
            if (curTime > prevTime)
                ragMap[key] = d;
        }
    });
    co.querySelectorAll('.co-rag-status').forEach((el) => {
        const fname = el.dataset.fname || '';
        const cacheKey = courseId + ':' + fname.toLowerCase();
        const doc = ragMap[fname.toLowerCase()];
        const f = _findUploadedFile(course, fname);
        if (_ragConfirmed[cacheKey] === 'ready') {
            _setRagStatus(el, 'ready');
            return;
        }
        if (doc) {
            _setRagStatus(el, doc.processing_status || '');
            if (doc.processing_status === 'ready') {
                _ragConfirmed[cacheKey] = 'ready';
                return;
            }
            if (doc.processing_status === 'failed') {
                const key = '_ragRetries_' + doc.id;
                const win = window;
                const attempts = win[key] || 0;
                if (f && attempts < 3) {
                    win[key] = attempts + 1;
                    _ragConfirmed[cacheKey] = 'triggered';
                    _ragEnqueue(() => _triggerRagIndex(el, fname, f, course, courseId, cacheKey));
                }
                return;
            }
            const stuckSince = doc.updated_at || doc.created_at;
            const stuckMs = stuckSince ? Date.now() - new Date(stuckSince).getTime() : 0;
            const stuckKey = '_ragStuckRetries_' + doc.id;
            const win = window;
            const stuckAttempts = win[stuckKey] || 0;
            if (stuckMs > 3 * 60 * 1000 && f && stuckAttempts < 3) {
                win[stuckKey] = stuckAttempts + 1;
                _ragConfirmed[cacheKey] = 'triggered';
                _ragEnqueue(() => _triggerRagIndex(el, fname, f, course, courseId, cacheKey));
                return;
            }
            if (doc.id)
                _pollRagStatus(el, courseId, doc.id, cacheKey);
        }
        else if (f) {
            if (_ragConfirmed[cacheKey] === 'triggered')
                return;
            _ragConfirmed[cacheKey] = 'triggered';
            _ragEnqueue(() => _triggerRagIndex(el, fname, f, course, courseId, cacheKey));
        }
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const s = el.dataset.ragStatus;
            if (s === 'ready' || s === 'uploading' || s === 'uploaded')
                return;
            const fr = _findUploadedFile(course, fname);
            if (fr) {
                _ragConfirmed[cacheKey] = 'triggered';
                _ragEnqueue(() => _triggerRagIndex(el, fname, fr, course, courseId, cacheKey));
            }
        });
    });
}
function _findUploadedFile(course, fname) {
    const files = (course.files || []);
    const found = files.find((x) => x.name === fname && x._uploaded);
    if (found)
        return found;
    const folders = course.userFolders || [];
    for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        const hit = folder.files.find((x) => x.name === fname && x._uploaded);
        if (hit)
            return hit;
    }
    return null;
}
async function _triggerRagIndex(el, fname, f, _course, courseId, cacheKey) {
    if (!f._storageName)
        return;
    _setRagStatus(el, 'uploading');
    try {
        const result = (await indexExistingDocument(courseId, f._storageName, fname, _guessSourceType(fname), f._folder || null, _guessDocMeta(fname)));
        if (result.alreadyIndexed) {
            const st = result.processingStatus || 'ready';
            _setRagStatus(el, st);
            if (st === 'ready' && cacheKey)
                _ragConfirmed[cacheKey] = 'ready';
            if (st !== 'ready' && st !== 'failed' && result.documentId) {
                _pollRagStatus(el, courseId, result.documentId, cacheKey);
            }
            return;
        }
        _setRagStatus(el, 'uploaded');
        const updatedDocs = await listCourseDocuments(courseId);
        const updated = updatedDocs.find((d) => d.file_name.toLowerCase() === fname.toLowerCase());
        if (updated) {
            _setRagStatus(el, updated.processing_status || '');
            if (updated.processing_status === 'ready' && cacheKey)
                _ragConfirmed[cacheKey] = 'ready';
            if (updated.processing_status !== 'ready' &&
                updated.processing_status !== 'failed' &&
                updated.id) {
                _pollRagStatus(el, courseId, updated.id, cacheKey);
            }
        }
    }
    catch {
        _setRagStatus(el, 'failed');
    }
}
const RAG_TITLES = {
    ready: 'Ready for AI ✓',
    failed: 'Indexing failed — click to retry',
    uploading: 'Sending to AI…',
    uploaded: 'Processing…',
    extracting_text: 'Extracting text… (click to retry if stuck)',
    chunking: 'Chunking… (click to retry if stuck)',
    embedding: 'Indexing… (click to retry if stuck)',
};
const RAG_ICONS = {
    ready: '🟢',
    failed: '🔴',
    uploading: '⏳',
    uploaded: '🔵',
    extracting_text: '🔵',
    chunking: '🔵',
    embedding: '🔵',
};
function _setRagStatus(el, status) {
    el.dataset.ragStatus = status;
    el.title = RAG_TITLES[status] || 'Preparing for AI… (click to retry if stuck)';
    el.textContent = RAG_ICONS[status] || '⏳';
    const clickable = status !== 'ready' && status !== 'uploading' && status !== 'uploaded';
    el.style.cursor = clickable ? 'pointer' : 'default';
}
async function _pollRagStatus(el, courseId, docId, cacheKey, _attempts) {
    const attempts = (_attempts || 0) + 1;
    if (attempts > 60)
        return;
    await new Promise((r) => setTimeout(r, 4000));
    try {
        const docs = await listCourseDocuments(courseId);
        const doc = docs.find((d) => d.id === docId);
        if (!doc)
            return;
        _setRagStatus(el, doc.processing_status || '');
        if (doc.processing_status === 'ready') {
            if (cacheKey)
                _ragConfirmed[cacheKey] = 'ready';
            return;
        }
        if (doc.processing_status === 'failed')
            return;
        _pollRagStatus(el, courseId, docId, cacheKey, attempts);
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=course-files.js.map