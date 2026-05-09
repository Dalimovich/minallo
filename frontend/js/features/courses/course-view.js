import { panelShow, panelHide } from '../../core/panels.js';
import { bindFileEvents } from './course-files.js?v=3';
import { bindFolderEvents } from './course-folders.js?v=3';
import { escapeHtml } from '../../utils/escape-html.js';

function fileRowHtml(f, inFolder) {
  var icon = f._uploaded
    ? '&#x1F4CE;'
    : f.name.includes('Lösung')
      ? '&#x2705;'
      : f.name.includes('Aufgabe')
        ? '&#x1F4CB;'
        : '&#x1F4CA;';
  var eName = escapeHtml(f.name);
  var eSname = f._storageName ? escapeHtml(f._storageName) : '';
  var eFolder = inFolder ? escapeHtml(inFolder) : '';
  var fa = eFolder ? ' data-folder="' + eFolder + '"' : '';
  var sna = eSname ? ' data-sname="' + eSname + '"' : '';
  var delBtn = f._uploaded
    ? '<span class="co-del-btn" data-fname="' + eName + '"' + sna + fa +
      ' title="Delete" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(239,68,68,.12);color:rgba(239,68,68,.85);border:1px solid rgba(239,68,68,.25);cursor:pointer;flex-shrink:0">&#x1F5D1;</span>'
    : '';
  var eSize = escapeHtml(f.size || '');
  var eDate = escapeHtml(f.date || '');
  var isPdf = f.name.toLowerCase().endsWith('.pdf');
  var ragBtn = isPdf && f._uploaded
    ? '<span class="co-rag-status" data-fname="' + eName + '" style="display:none"></span>'
    : '';
  var reindexBtn = isPdf && f._uploaded && f._storageName
    ? '<span class="co-reindex-btn" data-fname="' + eName + '"' + sna + fa +
      ' title="Re-index this PDF" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(99,102,241,.13);color:rgba(99,102,241,.9);border:1px solid rgba(99,102,241,.3);cursor:pointer;flex-shrink:0">&#x21BA;</span>'
    : '';
  return (
    '<div class="co-file' + (f._uploaded ? ' co-file-uploaded' : '') +
    '" data-fname="' + eName + '"' + fa + '>' +
    '<div class="co-file-cb" data-fname="' + eName + '"></div>' +
    '<span class="co-file-icon">' + icon + '</span>' +
    '<div style="flex:1;min-width:0">' +
      '<div class="co-file-name">' + eName + '</div>' +
      '<div class="co-file-meta">' + eSize + ' &middot; ' + eDate + '</div>' +
    '</div>' +
    ragBtn +
    reindexBtn +
    '<span class="co-open-btn" style="font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(192,132,252,.18);color:rgba(192,132,252,.9);border:1px solid rgba(192,132,252,.3);cursor:pointer;flex-shrink:0">Open</span>' +
    (f._uploaded
      ? delBtn
      : '<span class="co-dl-btn" data-fname="' + eName +
        '" title="Download" style="margin-left:6px;font-size:.69rem;font-weight:800;padding:3px 10px;border-radius:20px;background:rgba(6,214,160,.15);color:rgba(6,214,160,.9);border:1px solid rgba(6,214,160,.3);cursor:pointer;flex-shrink:0">&#x2B07;</span>') +
    '</div>'
  );
}

function buildFilesContent(course) {
  var foldersHtml = (course.userFolders || [])
    .map(function (fd) {
      var eFdName = escapeHtml(fd.name);
      var fileCount = fd.files.length;
      return (
        '<div class="co-folder-section collapsed" data-folder="' + eFdName + '">' +
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
            ? fd.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
                .map(function (f) { return fileRowHtml(f, fd.name); }).join('')
            : '<div class="co-folder-empty">No files yet &mdash; click &#x2B06; Upload to add some</div>') +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  var hasFolders = course.userFolders && course.userFolders.length > 0;
  var filesHtml = course.files.length
    ? course.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (f) { return fileRowHtml(f, null); }).join('')
    : course._filesLoading || hasFolders
      ? ''
      : '<div class="co-files-loading" style="opacity:.5">No files yet &mdash; click Upload files to add some</div>';

  return (
    '<div class="co-course-tabs" role="tablist" aria-label="Course sections">' +
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
    '<div class="co-course-panel" id="coQuizPanel" data-course-panel="quiz">' +
      '<div class="co-study-tools co-study-tools-quiz">' +
        '<div class="co-study-head">' +
          '<div><div class="co-study-title">Quiz</div>' +
          '<div class="co-study-sub">Answer course questions and review explanations</div></div>' +
          '<button class="co-study-generate primary" id="coGenerateQuiz" type="button">Generate quiz</button>' +
        '</div>' +
        '<div class="co-study-body" id="coQuizBody"></div>' +
      '</div>' +
    '</div>' +
    '<div class="co-course-panel" id="coFlashPanel" data-course-panel="flashcards">' +
      '<div class="co-study-tools co-study-tools-flashcards">' +
        '<div class="co-study-head">' +
          '<div><div class="co-study-title">Flashcards</div>' +
          '<div class="co-study-sub">Review generated decks from this course</div></div>' +
          '<button class="co-study-generate" id="coGenerateFlashcards" type="button">Generate cards</button>' +
        '</div>' +
        '<div class="co-study-body" id="coFlashBody"></div>' +
      '</div>' +
    '</div>'
  );
}

export function openCourse(course) {
  if (!course.files) course.files = [];
  window.activeCourseId = course.id;
  window.activeFileName = null;

  panelHide(document.getElementById('welcomeState'));
  panelHide(document.getElementById('pdfView'));
  var co = document.getElementById('courseOverview');
  if (co) co.style.display = 'block';

  var crumb = document.getElementById('breadcrumb');
  if (crumb) {
    crumb.textContent = '';
    var b = document.createElement('b');
    b.textContent = course.name;
    crumb.appendChild(b);
  }

  // Apply cached uploaded files immediately so the list shows without waiting for network
  var ufCacheKey = 'ss_uf_cache_' + course.id;
  try {
    var cached = JSON.parse(localStorage.getItem(ufCacheKey) || 'null');
    if (cached && Array.isArray(cached.files)) {
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      cached.files.forEach(function (f) {
        if (
          !course.files.find(function (x) {
            return x.name === f.name && x._uploaded;
          })
        )
          course.files.unshift({
            name: f.name,
            _storageName: f.storageName,
            size: f.size,
            date: f.date,
            _uploaded: true,
            _uid: uid,
            _course: course
          });
      });
      course.userFolders = (cached.folders || []).map(function (fd) {
        return {
          name: fd.name,
          files: fd.files.map(function (f) {
            return {
              name: f.name,
              _storageName: f.storageName,
              size: f.size,
              date: f.date,
              _uploaded: true,
              _uid: uid,
              _course: course,
              _folder: fd.name
            };
          })
        };
      });
    }
  } catch (e) {}

  // Mark loading only if there's nothing in cache to show yet
  var hasCache =
    course.files.length > 0 ||
    (course.userFolders || []).some(function (fd) {
      return fd.files && fd.files.length > 0;
    });
  if (!hasCache) course._filesLoading = true;

  showCourseSection(course, 'files');
  if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(false);
  if (typeof window.renderCourses === 'function') window.renderCourses();

  // Refresh from network in background and update cache
  var _myCourseSeq = ++window._courseOpenSeq;
  window
    ._ufMerge(course)
    .then(function () {
      course._filesLoading = false;
      if (_myCourseSeq !== window._courseOpenSeq) return;
      window._ssRestoring = true;
      showCourseSection(course, 'files');
      window._ssRestoring = false;
      try {
        var toCache = {
          files: course.files
            .filter(function (f) {
              return f._uploaded && !f._folder;
            })
            .map(function (f) {
              return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
            }),
          folders: (course.userFolders || []).map(function (fd) {
            return {
              name: fd.name,
              files: fd.files.map(function (f) {
                return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
              })
            };
          })
        };
        localStorage.setItem(ufCacheKey, JSON.stringify(toCache));
        var _totalCount =
          course.files.length +
          (course.userFolders || []).reduce(function (s, fd) {
            return s + (fd.files ? fd.files.length : 0);
          }, 0);
        localStorage.setItem('ss_fc_' + course.id, _totalCount + '');
      } catch (e) {}
    })
    .catch(function () {
      course._filesLoading = false;
    });
}

export function showCourseSection(course, section) {
  section = ['files', 'quiz', 'flashcards'].includes(section) ? section : 'files';
  window.activeCourseRef = course;
  window.activeCourseSection = section;

  // Save page bookmark before clearing activeFileName
  var leavingFile = window.activeFileName;
  var leavingPage = window.pdfPage;
  if (leavingFile && leavingPage && leavingPage > 1) {
    try { sessionStorage.setItem('ss_page_' + leavingFile, String(leavingPage)); } catch (e) {}
  }

  window.activeFileName = null;

  // Close notes panel when leaving PDF view
  if (window._notesPanel && typeof window._notesPanel.close === 'function') {
    window._notesPanel.close();
  }

  document.getElementById('pdfView').style.display = 'none';
  document.getElementById('welcomeState').style.display = 'none';
  var co = document.getElementById('courseOverview');

  // Preserve active tab before re-rendering so background refreshes don't kick user back to Files
  var prevTab = null;
  var prevActivePanel = co.querySelector('[data-course-panel].active');
  if (prevActivePanel) prevTab = prevActivePanel.getAttribute('data-course-panel');

  co.style.display = 'block';
  co.innerHTML =
    '<div class="co-inner">' +
    '<div class="co-logo">📚 StudySphere</div>' +
    (course.meta ? '<p class="co-tag">' + course.name + ' · ' + course.meta + '</p>' : '') +
    '<div class="co-card" style="margin-top:0">' +
    buildFilesContent(course) +
    '</div>' +
    '</div>';

  var coInner = co.querySelector('.co-inner');
  if (coInner) {
    coInner.classList.remove('panel-enter');
    void coInner.offsetWidth;
    coInner.classList.add('panel-enter');
  }

  bindFileEvents(co, course);
  bindFolderEvents(co, course);

  // Activate the requested tab without triggering click handlers (avoids infinite recursion)
  var targetTab = (section !== 'files') ? section : (prevTab && prevTab !== 'files' ? prevTab : null);
  if (targetTab) {
    co.querySelectorAll('[data-course-tab]').forEach(function (tab) {
      var isActive = tab.getAttribute('data-course-tab') === targetTab;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    co.querySelectorAll('[data-course-panel]').forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-course-panel') === targetTab);
    });
  }
}
