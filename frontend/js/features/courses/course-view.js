import { panelHide } from '../../core/panels.js';
import { bindFileEvents } from './course-files.js';
import { bindFolderEvents } from './course-folders.js';
import { escapeHtml } from '../../utils/escape-html.js';
function fileRowHtml(f, inFolder) {
    const icon = f._uploaded
        ? '&#x1F4CE;'
        : f.name.includes('Lösung')
            ? '&#x2705;'
            : f.name.includes('Aufgabe')
                ? '&#x1F4CB;'
                : '&#x1F4CA;';
    const eName = escapeHtml(f.name);
    const eSname = f._storageName ? escapeHtml(f._storageName) : '';
    const eFolder = inFolder ? escapeHtml(inFolder) : '';
    const fa = eFolder ? ' data-folder="' + eFolder + '"' : '';
    const sna = eSname ? ' data-sname="' + eSname + '"' : '';
    const delBtn = f._uploaded
        ? '<span class="co-del-btn" data-fname="' + eName + '"' + sna + fa +
            ' title="Delete" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(239,68,68,.12);color:rgba(239,68,68,.85);border:1px solid rgba(239,68,68,.25);cursor:pointer;flex-shrink:0">&#x1F5D1;</span>'
        : '';
    const eSize = escapeHtml(f.size || '');
    const eDate = escapeHtml(f.date || '');
    const isPdf = f.name.toLowerCase().endsWith('.pdf');
    const ragBtn = isPdf && f._uploaded
        ? '<span class="co-rag-status" data-fname="' + eName + '" style="display:none"></span>'
        : '';
    const reindexBtn = isPdf && f._uploaded && f._storageName
        ? '<span class="co-reindex-btn" data-fname="' + eName + '"' + sna + fa +
            ' title="Re-index this PDF" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(99,102,241,.13);color:rgba(99,102,241,.9);border:1px solid rgba(99,102,241,.3);cursor:pointer;flex-shrink:0">&#x21BA;</span>'
        : '';
    return ('<div class="co-file' + (f._uploaded ? ' co-file-uploaded' : '') +
        '" data-fname="' + eName + '"' + fa + '>' +
        '<div class="co-file-cb" data-fname="' + eName + '"></div>' +
        '<span class="co-file-icon">' + icon + '</span>' +
        '<div style="flex:1;min-width:0">' +
        '<div class="co-file-name">' + eName + '</div>' +
        '<div class="co-file-meta">' + eSize + ' &middot; ' + eDate + '</div>' +
        '</div>' +
        ragBtn +
        reindexBtn +
        '<span class="co-open-btn" style="font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(59,130,246,.18);color:rgba(59,130,246,.9);border:1px solid rgba(59,130,246,.3);cursor:pointer;flex-shrink:0">Open</span>' +
        (f._uploaded
            ? delBtn
            : '<span class="co-dl-btn" data-fname="' + eName +
                '" title="Download" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(6,214,160,.15);color:rgba(6,214,160,.9);border:1px solid rgba(6,214,160,.3);cursor:pointer;flex-shrink:0">&#x2B07;</span>') +
        '</div>');
}
function buildFilesContent(course) {
    const foldersHtml = (course.userFolders || [])
        .map((fd) => {
        const eFdName = escapeHtml(fd.name);
        const fileCount = fd.files.length;
        return ('<div class="co-folder-section collapsed" data-folder="' + eFdName + '">' +
            '<div class="co-folder-header">' +
            '<span class="co-folder-toggle-icon">&#x25B8;</span>' +
            '<span style="font-size:1.1rem;flex-shrink:0">&#x1F4C1;</span>' +
            '<span class="co-folder-name-label">' + eFdName + '</span>' +
            '<span class="co-folder-count-label">' + fileCount + ' file' + (fileCount !== 1 ? 's' : '') + '</span>' +
            '<button class="co-folder-select-all-btn" data-folder="' + eFdName + '" title="Select all files in folder" style="display:none">Select all</button>' +
            '<button class="co-folder-up-btn" data-folder="' + eFdName + '" title="Upload to folder">&#x2B06; Upload</button>' +
            '<button class="co-folder-del-btn" data-folder="' + eFdName + '" title="Delete folder">&#x1F5D1;</button>' +
            '</div>' +
            '<div class="co-folder-files">' +
            (fileCount
                ? fd.files.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
                    .map((f) => fileRowHtml(f, fd.name)).join('')
                : '<div class="co-folder-empty">No files yet &mdash; click &#x2B06; Upload to add some</div>') +
            '</div>' +
            '</div>');
    })
        .join('');
    const hasFolders = !!(course.userFolders && course.userFolders.length > 0);
    const courseFiles = (course.files || []);
    let filesHtml;
    if (courseFiles.length) {
        filesHtml = courseFiles.slice().sort((a, b) => a.name.localeCompare(b.name))
            .map((f) => fileRowHtml(f, null)).join('');
    }
    else if (hasFolders) {
        filesHtml = '';
    }
    else if (course._filesLoading) {
        filesHtml =
            '<div class="co-files-loading" style="opacity:.6;padding:14px 4px;font-size:.92rem">' +
                '<span class="co-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid rgba(96,165,250,.25);border-top-color:rgba(96,165,250,.85);border-radius:50%;animation:co-spin 0.8s linear infinite;vertical-align:-2px;margin-right:8px"></span>' +
                'Loading your files&hellip;' +
                '</div>' +
                '<style>@keyframes co-spin{to{transform:rotate(360deg)}}</style>';
    }
    else {
        filesHtml = '<div class="co-files-loading" style="opacity:.5">No files yet &mdash; click Upload files to add some</div>';
    }
    return ('<div class="co-course-tabs" role="tablist" aria-label="Course sections">' +
        '<button class="co-course-tab active" type="button" data-course-tab="files" role="tab" aria-selected="true">Files</button>' +
        '<button class="co-course-tab" type="button" data-course-tab="quiz" role="tab" aria-selected="false">Quiz</button>' +
        '<button class="co-course-tab" type="button" data-course-tab="flashcards" role="tab" aria-selected="false">Flashcards</button>' +
        '</div>' +
        '<div class="co-course-panel active" id="coFilesPanel" data-course-panel="files">' +
        '<div class="co-files-toolbar">' +
        '<button class="co-select-toggle" id="coSelectToggle">&#x2611; Select multiple</button>' +
        '<button class="co-new-folder-btn" id="coNewFolderBtn">&#x1F4C1; New folder</button>' +
        '<input type="file" id="coUploadInput" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" multiple style="display:none">' +
        '<input type="file" id="coFolderUploadInput" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" multiple style="display:none">' +
        '<button class="co-upload-btn" id="coUploadBtn">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' +
        ' Upload files' +
        '</button>' +
        '<button id="coReindexAllBtn" title="Re-process all PDFs with updated AI extraction" style="font-size:.75rem;padding:5px 12px;border-radius:20px;background:rgba(99,102,241,.13);color:rgba(99,102,241,.9);border:1px solid rgba(99,102,241,.3);cursor:pointer;white-space:nowrap">&#x21BA; Reindex all</button>' +
        '</div>' +
        foldersHtml +
        '<div id="coFilesList">' + filesHtml + '</div>' +
        '<div class="co-multi-bar" id="coMultiBar">' +
        '<span class="co-multi-count"><b id="coSelCount">0</b> files selected</span>' +
        '<span class="co-multi-clear" id="coMultiClear">Clear</span>' +
        '<button class="co-multi-delete" id="coMultiDeleteBtn">&#x1F5D1; Delete</button>' +
        '<button class="co-multi-move" id="coMultiMoveBtn">&#x1F4C2; Move</button>' +
        '<button class="co-multi-summarise" id="coMultiSumBtn">&#x2728; AI Chat</button>' +
        '</div>' +
        '</div>' +
        '<div class="co-course-panel" id="coQuizPanel" data-course-panel="quiz"></div>' +
        '<div class="co-course-panel" id="coFlashPanel" data-course-panel="flashcards"></div>');
}
export function openCourse(course) {
    if (!course.files)
        course.files = [];
    window.activeCourseId = course.id;
    window.activeFileName = null;
    panelHide(document.getElementById('welcomeState'));
    panelHide(document.getElementById('pdfView'));
    const co = document.getElementById('courseOverview');
    if (co)
        co.style.display = 'block';
    const crumb = document.getElementById('breadcrumb');
    if (crumb) {
        crumb.textContent = '';
        const b = document.createElement('b');
        b.textContent = course.name;
        crumb.appendChild(b);
    }
    const ufCacheKey = 'ss_uf_cache_' + course.id;
    try {
        const cached = JSON.parse(localStorage.getItem(ufCacheKey) || 'null');
        if (cached && Array.isArray(cached.files)) {
            const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
            const filesArr = course.files;
            cached.files.forEach((f) => {
                if (!filesArr.find((x) => x.name === f.name && x._uploaded)) {
                    filesArr.unshift({
                        name: f.name,
                        _storageName: f.storageName,
                        size: f.size,
                        date: f.date,
                        _uploaded: true,
                        _uid: uid,
                        _course: course,
                    });
                }
            });
            course.userFolders = (cached.folders || []).map((fd) => ({
                name: fd.name,
                files: fd.files.map((f) => ({
                    name: f.name,
                    _storageName: f.storageName,
                    size: f.size,
                    date: f.date,
                    _uploaded: true,
                    _uid: uid,
                    _course: course,
                    _folder: fd.name,
                })),
            }));
        }
    }
    catch { /* corrupted cache — render without */ }
    const hasCache = (course.files?.length ?? 0) > 0 ||
        (course.userFolders || []).some((fd) => fd.files && fd.files.length > 0);
    if (!hasCache)
        course._filesLoading = true;
    showCourseSection(course, 'files');
    if (typeof window._setAiChipsVisible === 'function')
        window._setAiChipsVisible(false);
    if (typeof window.renderCourses === 'function')
        window.renderCourses();
    const myCourseSeq = ++window._courseOpenSeq;
    window._ufMerge?.(course)
        .then(() => {
        course._filesLoading = false;
        const stillOnThisCourse = myCourseSeq === window._courseOpenSeq;
        if (stillOnThisCourse) {
            window._ssRestoring = true;
            showCourseSection(course, 'files');
            window._ssRestoring = false;
        }
        try {
            const courseFilesArr = (course.files || []);
            const toCache = {
                files: courseFilesArr
                    .filter((f) => f._uploaded && !f._folder)
                    .map((f) => ({
                    name: f.name,
                    storageName: f._storageName,
                    size: f.size,
                    date: f.date,
                })),
                folders: (course.userFolders || []).map((fd) => ({
                    name: fd.name,
                    files: fd.files.map((f) => ({
                        name: f.name,
                        storageName: f._storageName,
                        size: f.size,
                        date: f.date,
                    })),
                })),
            };
            localStorage.setItem(ufCacheKey, JSON.stringify(toCache));
            const total = (course.files?.length || 0) +
                (course.userFolders || []).reduce((s, fd) => s + (fd.files ? fd.files.length : 0), 0);
            localStorage.setItem('ss_fc_' + course.id, String(total));
        }
        catch { /* quota or stringify */ }
    })
        .catch(() => {
        course._filesLoading = false;
    });
}
export function showCourseSection(course, section) {
    const sec = ['files', 'quiz', 'flashcards'].includes(section) ? section : 'files';
    window.activeCourseRef = course;
    window.activeCourseSection = sec;
    const leavingFile = window.activeFileName;
    const leavingPage = window.pdfPage;
    if (leavingFile && leavingPage && leavingPage > 1) {
        try {
            sessionStorage.setItem('ss_page_' + leavingFile, String(leavingPage));
        }
        catch { /* ignore */ }
    }
    window.activeFileName = null;
    if (window._notesPanel && typeof window._notesPanel.close === 'function') {
        window._notesPanel.close();
    }
    const pdfView = document.getElementById('pdfView');
    if (pdfView)
        pdfView.style.display = 'none';
    const welcome = document.getElementById('welcomeState');
    if (welcome)
        welcome.style.display = 'none';
    const co = document.getElementById('courseOverview');
    if (!co)
        return;
    let prevTab = null;
    const prevActivePanel = co.querySelector('[data-course-panel].active');
    if (prevActivePanel)
        prevTab = prevActivePanel.getAttribute('data-course-panel');
    co.style.display = 'block';
    co.innerHTML =
        '<div class="co-inner">' +
            '<div class="co-logo">📚 Minallo</div>' +
            (course.meta ? '<p class="co-tag">' + course.name + ' · ' + course.meta + '</p>' : '') +
            '<div class="co-card" style="margin-top:0">' +
            buildFilesContent(course) +
            '</div>' +
            '</div>';
    const coInner = co.querySelector('.co-inner');
    if (coInner) {
        coInner.classList.remove('panel-enter');
        void coInner.offsetWidth;
        coInner.classList.add('panel-enter');
    }
    bindFileEvents(co, course);
    bindFolderEvents(co, course);
    const targetTab = sec !== 'files' ? sec : prevTab && prevTab !== 'files' ? prevTab : null;
    if (targetTab) {
        co.querySelectorAll('[data-course-tab]').forEach((tab) => {
            const isActive = tab.getAttribute('data-course-tab') === targetTab;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        co.querySelectorAll('[data-course-panel]').forEach((panel) => {
            panel.classList.toggle('active', panel.getAttribute('data-course-panel') === targetTab);
        });
        if (targetTab === 'quiz') {
            const qp = co.querySelector('#coQuizPanel');
            if (qp && typeof window.mountQuiz === 'function') {
                window.mountQuiz(qp, course, { generate: window._generateStudyTool });
            }
        }
        else if (targetTab === 'flashcards') {
            const fp = co.querySelector('#coFlashPanel');
            if (fp && typeof window.mountFlashcards === 'function') {
                window.mountFlashcards(fp, course, { generate: window._generateStudyTool });
            }
        }
    }
}
//# sourceMappingURL=course-view.js.map