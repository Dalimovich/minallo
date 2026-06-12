import { panelHide, selectTopLevelView } from '../../core/panels.js';
import { bindFileEvents } from './course-files.js';
import { bindFolderEvents } from './course-folders.js';
import { escapeHtml } from '../../utils/escape-html.js';
import { computeCourseProgress } from './courses-render.js';
import type { LegacyCourse } from '../../../globals.js';

interface InCourseProgress {
  unreadFilesCount: number;
  aiSessions: number;
  files: number;
}
function _buildCourseNextSteps(course: LegacyCourse, progress: InCourseProgress): string {
  const eyeSvg =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const brainSvg =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3v0a3 3 0 0 0-3 3c0 1 .5 2 1 3a3 3 0 0 0 0 4c-.5 1-1 2-1 3a3 3 0 0 0 3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V5z"/><path d="M12 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1 3 3c0 1-.5 2-1 3a3 3 0 0 1 0 4c.5 1 1 2 1 3a3 3 0 0 1-3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3V5z"/></svg>';
  const timerSvg =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="9" y1="2" x2="15" y2="2"/></svg>';

  const steps: Array<{ icon: string; title: string; sub: string; action: string }> = [];
  if (progress.unreadFilesCount > 0) {
    const n = progress.unreadFilesCount;
    steps.push({
      icon: eyeSvg,
      title: 'Review ' + n + ' unread file' + (n > 1 ? 's' : ''),
      sub: 'Continue with course material you have not reviewed yet.',
      action: 'review-files',
    });
  }
  steps.push({
    icon: brainSvg,
    title: 'Ask AI about ' + escapeHtml(course.name || 'this course'),
    sub: progress.aiSessions > 0
      ? 'Pick up where you left off in your AI tutor session.'
      : 'Open the AI tutor and ask anything about this course.',
    action: 'open-ai',
  });
  steps.push({
    icon: timerSvg,
    title: '25 min focus session',
    sub: 'Start a Pomodoro for this course and keep building momentum.',
    action: 'focus-session',
  });

  return (
    '<section class="co-next-steps">' +
      '<div class="co-next-steps-head">' +
        '<h2 class="co-next-steps-title">Next steps</h2>' +
        '<p class="co-next-steps-sub">Suggestions based on your course activity</p>' +
      '</div>' +
      '<div class="co-next-steps-list">' +
        steps.map((s) =>
          '<button type="button" class="co-next-step" data-action="' + s.action + '">' +
            '<span class="co-next-step-icon">' + s.icon + '</span>' +
            '<span class="co-next-step-body">' +
              '<span class="co-next-step-title">' + s.title + '</span>' +
              '<span class="co-next-step-sub">' + s.sub + '</span>' +
            '</span>' +
          '</button>'
        ).join('') +
      '</div>' +
    '</section>'
  );
}

interface CourseFileLike {
  name: string;
  _uploaded?: boolean;
  _storageName?: string;
  _folder?: string | null;
  size?: string;
  date?: string;
}

function _isFileStudied(courseId: string, fileName: string): boolean {
  try {
    const raw = localStorage.getItem('ss_opened_' + courseId);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.includes(fileName);
  } catch { return false; }
}

function _waitForCourseFileMerge(course: LegacyCourse): Promise<void> {
  const startedAt = Date.now();
  const TIMEOUT_MS = 6000;

  return new Promise((resolve, reject) => {
    const tryStart = (): void => {
      const user = window._currentUser;
      const hasUser = !!(user && (user.id || user.sub));
      if (hasUser && typeof window._ufMerge === 'function') {
        try {
          Promise.resolve(window._ufMerge(course)).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        reject(new Error('Course files are not ready yet'));
        return;
      }
      window.setTimeout(tryStart, 120);
    };
    tryStart();
  });
}

function _courseFileCount(course: LegacyCourse): number {
  const rootCount = course.files?.length || 0;
  const folderCount = (course.userFolders || []).reduce(
    (sum, fd) => sum + (fd.files ? fd.files.length : 0),
    0
  );
  return rootCount + folderCount;
}

function fileRowHtml(f: CourseFileLike, inFolder: string | null, courseId?: string): string {
  const eName = escapeHtml(f.name);
  const eSname = f._storageName ? escapeHtml(f._storageName) : '';
  const eFolder = inFolder ? escapeHtml(inFolder) : '';
  const fa = eFolder ? ' data-folder="' + eFolder + '"' : '';
  const sna = eSname ? ' data-sname="' + eSname + '"' : '';
  const eSize = escapeHtml(f.size || '');
  const eDate = escapeHtml(f.date || '');
  const isPdf = f.name.toLowerCase().endsWith('.pdf');
  const studied = courseId ? _isFileStudied(courseId, f.name) : false;

  // SVG icons (file, download, trash) keep visual weight consistent with the
  // other pill controls. Emoji glyphs render inconsistently across platforms.
  const fileIconSvg =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const dlSvg =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const trashSvg =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  const refreshSvg =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

  const ragStatusEl = isPdf && f._uploaded
    ? '<span class="co-rag-status co-file-chip" data-fname="' + eName + '" style="display:none"></span>'
    : '';
  const studiedChip = f._uploaded
    ? '<span class="co-file-chip ' + (studied ? 'co-file-chip-studied' : 'co-file-chip-muted') + '">' +
        (studied ? 'Studied' : 'Not studied') +
      '</span>'
    : '';
  const reindexBtn = isPdf && f._uploaded && f._storageName
    ? '<button type="button" class="co-file-action co-file-action-reindex co-reindex-btn" data-fname="' + eName + '"' + sna + fa + ' title="Re-index this PDF">' + refreshSvg + '</button>'
    : '';
  const sizeMeta = eSize ? eSize : '';
  const dateMeta = eDate ? 'Uploaded ' + eDate : '';
  const metaParts = [isPdf ? 'PDF' : '', sizeMeta, dateMeta].filter((s) => s);
  const metaLine = metaParts.join(' · ');

  return (
    '<div class="co-file co-file-v2' + (f._uploaded ? ' co-file-uploaded' : '') +
    '" data-fname="' + eName + '"' + fa + '>' +
    '<div class="co-file-cb" data-fname="' + eName + '"></div>' +
    '<div class="co-file-icon-wrap">' + fileIconSvg + '</div>' +
    '<div class="co-file-text">' +
      '<div class="co-file-name">' + eName + '</div>' +
      '<div class="co-file-meta">' + escapeHtml(metaLine) + '</div>' +
    '</div>' +
    '<div class="co-file-actions">' +
      ragStatusEl +
      studiedChip +
      reindexBtn +
      '<button type="button" class="co-file-action co-file-action-open co-open-btn">Open</button>' +
      (f._uploaded
        ? '<button type="button" class="co-file-action co-file-action-icon co-del-btn" data-fname="' + eName + '"' + sna + fa + ' title="Delete">' + trashSvg + '</button>'
        : '<button type="button" class="co-file-action co-file-action-icon co-dl-btn" data-fname="' + eName + '" title="Download">' + dlSvg + '</button>') +
    '</div>' +
    '</div>'
  );
}

const _folderIconSvg =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
const _chevronSvg =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
const _folderTints = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'];

interface FileStats {
  totalFiles: number;
  studiedTotal: number;
  unreadTotal: number;
}

function _computeFileStats(course: LegacyCourse): FileStats {
  const allFiles: CourseFileLike[] = ((course.files || []) as unknown as CourseFileLike[]).slice();
  (course.userFolders || []).forEach((fd) => {
    (fd.files as unknown as CourseFileLike[]).forEach((f) => allFiles.push(f));
  });
  const totalFiles = allFiles.length;
  const studiedTotal = allFiles.reduce(
    (acc, f) => acc + (_isFileStudied(course.id, f.name) ? 1 : 0), 0
  );
  return { totalFiles, studiedTotal, unreadTotal: Math.max(0, totalFiles - studiedTotal) };
}

function _buildFilesListHtml(course: LegacyCourse): string {
  const foldersHtml = (course.userFolders || [])
    .map((fd, fi) => {
      const eFdName = escapeHtml(fd.name);
      const fileCount = fd.files.length;
      const tint = _folderTints[fi % _folderTints.length];
      const studiedInFolder = fd.files.reduce((acc, ff) => {
        return acc + (_isFileStudied(course.id, (ff as { name?: string }).name || '') ? 1 : 0);
      }, 0);
      const unreadInFolder = Math.max(0, fileCount - studiedInFolder);
      const updatedLabel = 'Updated recently';
      const metaBits = [
        fileCount + ' file' + (fileCount !== 1 ? 's' : ''),
        studiedInFolder + ' studied',
        unreadInFolder + ' unread',
        updatedLabel,
      ];
      return (
        '<div class="co-folder-section co-folder-v2 collapsed" data-folder="' + eFdName + '" style="--co-folder-accent:' + tint + '">' +
        '<div class="co-folder-header">' +
          '<span class="co-folder-toggle-icon">' + _chevronSvg + '</span>' +
          '<span class="co-folder-icon-wrap">' + _folderIconSvg + '</span>' +
          '<div class="co-folder-text">' +
            '<div class="co-folder-name-label">' + eFdName + '</div>' +
            '<div class="co-folder-sub">' + metaBits.join(' &middot; ') + '</div>' +
          '</div>' +
          '<button class="co-folder-select-all-btn" data-folder="' + eFdName + '" title="Select all files in folder" style="display:none">Select all</button>' +
          '<button class="co-folder-toggle-btn co-folder-up-btn" data-folder="' + eFdName + '" title="Upload to folder">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
            '<span>Upload here</span>' +
          '</button>' +
          '<button class="co-folder-toggle-btn co-folder-reindex-btn" data-folder="' + eFdName + '" title="Reindex folder">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
            '<span>Reindex folder</span>' +
          '</button>' +
          '<button class="co-folder-open-btn" data-folder="' + eFdName + '">Open folder</button>' +
          '<div class="co-folder-more">' +
            '<button class="co-folder-more-btn" data-folder="' + eFdName + '" type="button" aria-haspopup="menu" aria-label="More actions">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>' +
            '</button>' +
            '<div class="co-folder-more-menu" role="menu">' +
              '<button class="co-folder-rename-btn co-folder-more-item" data-folder="' + eFdName + '" type="button" title="Rename folder">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>' +
                '<span>Rename</span>' +
              '</button>' +
              '<button class="co-folder-del-btn co-folder-more-item" data-folder="' + eFdName + '" type="button" title="Delete folder">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                '<span>Delete folder</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="co-folder-files">' +
          (fileCount
            ? fd.files.slice().sort((a, b) =>
                String(a.name).localeCompare(String(b.name))
              )
              .map((f) => fileRowHtml(f as unknown as CourseFileLike, fd.name, course.id)).join('')
            : '<div class="co-folder-empty">No files yet &mdash; click <b>Upload here</b> to add some</div>') +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  const hasFolders = !!(course.userFolders && course.userFolders.length > 0);
  const courseFiles = (course.files || []) as unknown as CourseFileLike[];
  let filesHtml: string;
  if (courseFiles.length) {
    filesHtml = courseFiles.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => fileRowHtml(f, null, course.id)).join('');
  } else if (hasFolders) {
    filesHtml = '';
  } else if (course._filesLoading) {
    filesHtml =
      '<div class="co-files-loading" style="opacity:.6;padding:14px 4px;font-size:.92rem">' +
      '<span class="co-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid rgba(96,165,250,.25);border-top-color:rgba(96,165,250,.85);border-radius:50%;animation:co-spin 0.8s linear infinite;vertical-align:-2px;margin-right:8px"></span>' +
      'Loading your files&hellip;' +
      '</div>' +
      '<style>@keyframes co-spin{to{transform:rotate(360deg)}}</style>';
  } else {
    filesHtml = '<div class="co-files-loading" style="opacity:.5">No files yet &mdash; click Upload files to add some</div>';
  }

  return (
    (courseFiles.length || (!hasFolders && filesHtml)
      ? '<div class="co-separate-files">' +
          '<div class="co-separate-files-head">' +
            '<div>' +
              '<div class="co-separate-files-title">Separate files</div>' +
              '<div class="co-separate-files-sub">Files that are not inside a folder</div>' +
            '</div>' +
            (courseFiles.length
              ? '<span class="co-folder-count-label">' + courseFiles.length + ' file' + (courseFiles.length !== 1 ? 's' : '') + '</span>'
              : '') +
          '</div>' +
          '<div id="coFilesList">' + filesHtml + '</div>' +
        '</div>'
      : '<div id="coFilesList" style="display:none">' + filesHtml + '</div>') +
    foldersHtml
  );
}

function buildFilesContent(course: LegacyCourse): string {
  const { totalFiles, studiedTotal, unreadTotal } = _computeFileStats(course);

  return (
    '<div class="co-course-tabs" role="tablist" aria-label="Course sections">' +
      '<button class="co-course-tab active" type="button" data-course-tab="files" role="tab" aria-selected="true">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
        '<span>Files</span>' +
      '</button>' +
      '<button class="co-course-tab" type="button" data-course-tab="quiz" role="tab" aria-selected="false">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span>Quiz</span>' +
      '</button>' +
      '<button class="co-course-tab" type="button" data-course-tab="flashcards" role="tab" aria-selected="false">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>' +
        '<span>Flashcards</span>' +
      '</button>' +
      '<button class="co-course-tab" type="button" data-course-tab="examforge" role="tab" aria-selected="false">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-5"/></svg>' +
        '<span>ExamForge</span>' +
      '</button>' +
      '<button class="co-course-tab" type="button" data-course-tab="cheatsheet" role="tab" aria-selected="false">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>' +
        '<span>Cheatsheet</span>' +
      '</button>' +
      '<button class="co-course-tab" type="button" data-course-tab="deeplearn" role="tab" aria-selected="false">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14l9-5-9-5-9 5 9 5z"/><path d="M12 14l6.16-3.42A12 12 0 0 1 12 21a12 12 0 0 1-6.16-10.42L12 14z"/></svg>' +
        '<span>Deep Learn</span>' +
      '</button>' +
    '</div>' +
    '<div class="co-course-panel active" id="coFilesPanel" data-course-panel="files">' +
      '<div class="co-files-inner-card">' +
      '<div class="co-panel-header co-panel-header-v2">' +
        '<div class="co-panel-header-text">' +
          '<h2 class="co-panel-title">Files</h2>' +
          '<p class="co-panel-sub">' +
            'Folders and course documents · ' +
            '<b>' + totalFiles + '</b> total · ' +
            '<b>' + studiedTotal + '</b> studied · ' +
            '<b>' + unreadTotal + '</b> unread' +
          '</p>' +
        '</div>' +
        '<div class="co-files-toolbar co-files-actions">' +
          '<input type="file" id="coUploadInput" data-testid="upload-files-input" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" multiple style="display:none">' +
          '<input type="file" id="coFolderUploadInput" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" multiple style="display:none">' +
          '<button class="co-select-toggle co-tool-btn" id="coSelectToggle">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
            '<span>Select multiple</span>' +
          '</button>' +
          '<button class="co-new-folder-btn co-tool-btn" id="coNewFolderBtn">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>' +
            '<span>New folder</span>' +
          '</button>' +
          '<button class="co-upload-btn co-tool-btn co-tool-btn-primary" id="coUploadBtn" data-testid="upload-files">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
            '<span>Upload files</span>' +
          '</button>' +
          '<button id="coReindexAllBtn" class="co-tool-btn" title="Make your PDFs searchable by the AI tutor">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
            '<span>Update AI index</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="co-files-search-row">' +
        '<div class="co-files-search-wrap">' +
          '<svg class="co-files-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
          '<input type="text" id="coFilesSearchInput" class="co-files-search-input" placeholder="Search files, folders, formulas, exercises…" autocomplete="off">' +
        '</div>' +
      '</div>' +
      '<div class="co-files-list">' +
      _buildFilesListHtml(course) +
      '</div>' +
      '</div>' +
      '<div class="co-multi-bar" id="coMultiBar">' +
        '<span class="co-multi-count"><b id="coSelCount">0</b> files selected</span>' +
        '<span class="co-multi-clear" id="coMultiClear">Clear</span>' +
        '<button class="co-multi-delete" id="coMultiDeleteBtn">&#x1F5D1; Delete</button>' +
        '<button class="co-multi-move" id="coMultiMoveBtn">&#x1F4C2; Move</button>' +
        '<button class="co-multi-summarise" id="coMultiSumBtn">&#x2728; AI Chat</button>' +
      '</div>' +
    '</div>' +
    '<div class="co-course-panel" id="coQuizPanel" data-course-panel="quiz"></div>' +
    '<div class="co-course-panel" id="coFlashPanel" data-course-panel="flashcards"></div>' +
    '<div class="co-course-panel" id="coExamForgePanel" data-course-panel="examforge"></div>' +
    '<div class="co-course-panel" id="coCheatsheetPanel" data-course-panel="cheatsheet"></div>' +
    '<div class="co-course-panel" id="coDeepLearnPanel" data-course-panel="deeplearn"></div>'
  );
}

export function openCourse(course: LegacyCourse): void {
  if (!course.files) course.files = [];
  window.activeCourseId = course.id;
  window.activeFileName = null;

  // Top-level switch first — clears portal-section orphans and studip view.
  // The course overview lives inside #app (the file-view container), so we want
  // the 'file' top-level.
  selectTopLevelView('file');
  panelHide(document.getElementById('welcomeState'));
  panelHide(document.getElementById('pdfView'));
  (window as unknown as {
    __minalloDocRail?: { setRouteVisibility: (route: 'pdf' | 'courses' | 'other') => void };
  }).__minalloDocRail?.setRouteVisibility('courses');
  const co = document.getElementById('courseOverview');
  if (co) co.style.display = 'block';

  const crumb = document.getElementById('breadcrumb');
  if (crumb) {
    crumb.textContent = '';
    const b = document.createElement('b');
    b.textContent = course.name;
    crumb.appendChild(b);
  }

  const ufCacheKey = 'ss_uf_cache_' + course.id;
  // Track whether a cache *entry* exists (vs. has files). An empty cache from a
  // prior successful list is authoritative — skip the full spinner for it.
  const hadCacheEntry = (() => {
    try { return localStorage.getItem(ufCacheKey) != null; } catch { return false; }
  })();
  try {
    const cached = JSON.parse(localStorage.getItem(ufCacheKey) || 'null');
    if (cached && Array.isArray(cached.files)) {
      const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      const filesArr = course.files as unknown as CourseFileLike[];
      (cached.files as Array<{ name: string; storageName?: string; size?: string; date?: string }>).forEach((f) => {
        if (!filesArr.find((x) => x.name === f.name && x._uploaded)) {
          filesArr.unshift({
            name: f.name,
            _storageName: f.storageName,
            size: f.size,
            date: f.date,
            _uploaded: true,
            _uid: uid,
            _course: course,
          } as CourseFileLike & Record<string, unknown>);
        }
      });
      course.userFolders = (cached.folders || []).map(
        (fd: { name: string; files: Array<{ name: string; storageName?: string; size?: string; date?: string }> }) => ({
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
        })
      );
    }
  } catch { /* corrupted cache — render without */ }

  const hasAnyFiles =
    (course.files?.length ?? 0) > 0 ||
    (course.userFolders || []).some((fd) => fd.files && fd.files.length > 0);
  // Full-panel spinner only when we have neither a prior cache entry nor any files.
  // When a cache entry exists (even empty), trust it for first paint and show a
  // small "refreshing" pill while the background _ufMerge runs.
  course._filesLoading = !hadCacheEntry && !hasAnyFiles;
  course._filesRefreshing = hadCacheEntry;

  showCourseSection(course, 'files');
  if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(false);
  if (typeof window.renderCourses === 'function') window.renderCourses();

  if (typeof window._courseOpenSeq !== 'number') window._courseOpenSeq = 0;
  const myCourseSeq = ++window._courseOpenSeq;

  // Render the root-level files the moment they arrive — folder listings keep
  // running in the background. Without this, the spinner persists until the
  // slowest folder list returns (often seconds longer than necessary).
  const onRootDone = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ courseId?: string }>).detail;
    if (!detail || detail.courseId !== course.id) return;
    if (myCourseSeq !== window._courseOpenSeq) return;
    course._filesLoading = false;
    const co2 = document.getElementById('courseOverview');
    if (co2) _refreshFilesPanel(co2, course);
  };
  window.addEventListener('uf-merge-root-done', onRootDone);

  let lastSeenFileCount = _courseFileCount(course);
  const repaintIfFilesArrive = (): void => {
    if (myCourseSeq !== window._courseOpenSeq) return;
    const nextCount = _courseFileCount(course);
    if (nextCount <= 0 || nextCount === lastSeenFileCount) return;
    lastSeenFileCount = nextCount;
    course._filesLoading = false;
    const co2 = document.getElementById('courseOverview');
    if (co2) _refreshFilesPanel(co2, course);
  };
  const repaintTimer = window.setInterval(repaintIfFilesArrive, 150);

  const fallbackTimer = window.setTimeout(() => {
    if (myCourseSeq !== window._courseOpenSeq) return;
    if (!course._filesLoading) return;
    course._filesLoading = false;
    course._filesRefreshing = false;
    const co2 = document.getElementById('courseOverview');
    if (co2) _refreshFilesPanel(co2, course);
  }, 10000);

  const cleanup = (): void => {
    window.removeEventListener('uf-merge-root-done', onRootDone);
    window.clearTimeout(fallbackTimer);
    window.clearInterval(repaintTimer);
  };

  _waitForCourseFileMerge(course)
    .then(() => {
      cleanup();
      course._filesLoading = false;
      course._filesRefreshing = false;
      const stillOnThisCourse = myCourseSeq === window._courseOpenSeq;
      if (stillOnThisCourse) {
        const co2 = document.getElementById('courseOverview');
        if (co2) _refreshFilesPanel(co2, course);
      }
      try {
        const courseFilesArr = (course.files || []) as unknown as CourseFileLike[];
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
            files: (fd.files as unknown as CourseFileLike[]).map((f) => ({
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
      } catch { /* quota or stringify */ }
    })
    .catch(() => {
      cleanup();
      course._filesLoading = false;
      course._filesRefreshing = false;
      const stillOnThisCourse = myCourseSeq === window._courseOpenSeq;
      if (stillOnThisCourse) {
        const co2 = document.getElementById('courseOverview');
        if (co2) _refreshFilesPanel(co2, course);
      }
    });

  // Preload study-tool modules so tab switches are instant
  const preload = (window as unknown as {
    _ssLoadPortalFeature?: (name: string) => Promise<void>;
  })._ssLoadPortalFeature;
  if (typeof preload === 'function') {
    void preload('quiz');
    void preload('flashcards');
    void preload('examforge');
    void preload('cheatsheet');
    void preload('deeplearn');
  }

  // Warm the topic-map / saved-notes cache in the background so the first
  // visit to Deep Learn or Cheatsheet doesn't show a "Loading…" flash —
  // the data is usually already resolved by the time the tab mounts.
  void import('../../services/ai-service.js')
    .then((svc) => {
      void svc.getCourseTopicMap?.(course.id).catch(() => undefined);
      void svc.listCourseNotes?.(course.id).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Fetch the course's document-understanding data and decorate ready file rows
 *  with the source-type badge + correction selector. Additive + silent so it
 *  never blocks or breaks the list render. Called on BOTH the full course render
 *  and the lighter files-panel refresh, so the badges survive navigating away
 *  (e.g. opening a PDF) and coming back. */
function _decorateDocTypeBadges(filesList: HTMLElement | null, course: LegacyCourse): void {
  if (!filesList || !course.id || !window._sbToken) return;
  void (async () => {
    try {
      // Silent direct fetch on purpose: do NOT go through listCourseDocuments,
      // which dispatches a `session-expired` event on 401. Badges are cosmetic
      // and must never log the user out or add auth noise — swallow any error.
      const res = await fetch(
        (window.BACKEND_URL || '') + '/api/documents/list?courseId=' + encodeURIComponent(course.id),
        { headers: { Authorization: 'Bearer ' + (window._sbToken || '') } }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { documents?: unknown[] };
      if (!data.documents || !data.documents.length) return;
      const { decorateFileTypeBadges } = await import('./document-type-badge.js');
      decorateFileTypeBadges(filesList, data.documents as Parameters<typeof decorateFileTypeBadges>[1]);
    } catch {
      /* badges are optional — ignore */
    }
  })();
}

function _refreshFilesPanel(co: HTMLElement, course: LegacyCourse): void {
  const { totalFiles, studiedTotal, unreadTotal } = _computeFileStats(course);
  const sub = co.querySelector<HTMLElement>('#coFilesPanel .co-panel-sub');
  if (sub) {
    sub.innerHTML =
      'Folders and course documents · ' +
      '<b>' + totalFiles + '</b> total · ' +
      '<b>' + studiedTotal + '</b> studied · ' +
      '<b>' + unreadTotal + '</b> unread';
  }
  const filesList = co.querySelector<HTMLElement>('#coFilesPanel .co-files-list');
  if (filesList) {
    filesList.innerHTML = _buildFilesListHtml(course);
    bindFileEvents(co, course);
    bindFolderEvents(co, course);
    // Document Understanding Layer: decorate ready file rows with the detected
    // source-type badge + low-confidence correction selector.
    _decorateDocTypeBadges(filesList, course);
    co.querySelectorAll<HTMLButtonElement>('.co-folder-more-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = btn.parentElement?.querySelector<HTMLElement>('.co-folder-more-menu');
        if (!menu) return;
        const wasOpen = menu.classList.contains('open');
        co.querySelectorAll<HTMLElement>('.co-folder-more-menu.open').forEach((m) => m.classList.remove('open'));
        if (!wasOpen) menu.classList.add('open');
      });
    });
  }
}

function _mountFeaturePanel(co: HTMLElement, sec: string, course: LegacyCourse): void {
  const panelSelector =
    sec === 'quiz' ? '#coQuizPanel' :
    sec === 'flashcards' ? '#coFlashPanel' :
    sec === 'examforge' ? '#coExamForgePanel' :
    sec === 'cheatsheet' ? '#coCheatsheetPanel' :
    '#coDeepLearnPanel';
  const panel = co.querySelector<HTMLElement>(panelSelector);
  if (panel && panel.getAttribute('data-mounted-course') === course.id) return;
  const loadFeature = (window as unknown as {
    _ssLoadPortalFeature?: (name: string) => Promise<void>;
  })._ssLoadPortalFeature;
  if (typeof loadFeature === 'function') void loadFeature(sec);
  const mountWhenReady = (tries: number): void => {
    const mountFn =
      sec === 'quiz' ? window.mountQuiz :
      sec === 'flashcards' ? window.mountFlashcards :
      sec === 'examforge' ? window.mountExamForge :
      sec === 'cheatsheet' ? window.mountCheatsheet :
      window.mountDeepLearn;
    if (typeof mountFn === 'function') {
      if (panel && panel.isConnected) {
        mountFn(panel, course, { generate: window._generateStudyTool });
        panel.setAttribute('data-mounted-course', course.id);
      }
    } else if (tries > 0) {
      setTimeout(() => mountWhenReady(tries - 1), 80);
    }
  };
  mountWhenReady(80);
}

function _switchTabOnly(co: HTMLElement, sec: string, course: LegacyCourse): void {
  co.querySelectorAll<HTMLElement>('[data-course-tab]').forEach((tab) => {
    const isActive = tab.getAttribute('data-course-tab') === sec;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  co.querySelectorAll<HTMLElement>('[data-course-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-course-panel') === sec);
  });
  const inner = co.querySelector<HTMLElement>('.co-inner');
  if (inner) {
    inner.classList.toggle(
      'co-inner-wide',
      sec === 'quiz' || sec === 'flashcards' || sec === 'examforge' ||
      sec === 'cheatsheet' || sec === 'deeplearn'
    );
  }
  if (sec === 'quiz' || sec === 'flashcards' || sec === 'examforge' || sec === 'cheatsheet' || sec === 'deeplearn') {
    _mountFeaturePanel(co, sec, course);
  }
}

export function showCourseSection(course: LegacyCourse, section: string): void {
  const sec = ['files', 'quiz', 'flashcards', 'examforge', 'cheatsheet', 'deeplearn'].includes(section) ? section : 'files';

  const co = document.getElementById('courseOverview');
  // "Already rendered" must compare against the course whose DOM is actually
  // on screen (stamped at full-render time below), NOT window.activeCourseId —
  // openCourse() updates that global to the NEW course before delegating here,
  // so comparing against it made every open of a different course look like a
  // same-course refresh: the files panel updated but the header kept the first
  // course's name.
  const alreadyRendered = co && co.style.display === 'block' &&
      co.getAttribute('data-rendered-course') === String(course.id) &&
      !window.activeFileName &&
      co.querySelector('.co-inner-v2');

  // Fast path 1: switching tabs within the same course — just toggle visibility.
  if (alreadyRendered && sec !== window.activeCourseSection) {
    window.activeCourseRef = course;
    window.activeCourseSection = sec;
    _switchTabOnly(co, sec, course);
    return;
  }

  // Fast path 2: same course, same section — data refresh only (files arrived).
  if (alreadyRendered && sec === window.activeCourseSection) {
    window.activeCourseRef = course;
    _refreshFilesPanel(co, course);
    return;
  }

  window.activeCourseRef = course;
  window.activeCourseSection = sec;

  const leavingFile = window.activeFileName;
  const leavingStorage = window.activeStorageName;
  const leavingPage = window.pdfPage;
  if (leavingFile && leavingPage && leavingPage > 1) {
    try {
      const _id = leavingStorage || leavingFile;
      const _cid = course.id != null && course.id !== '' ? String(course.id) : 'demo';
      sessionStorage.setItem('ss_page_' + _cid + '::' + _id, String(leavingPage));
    } catch { /* ignore */ }
  }

  window.activeFileName = null;
  window.activeStorageName = null;

  if (window._notesPanel && typeof window._notesPanel.close === 'function') {
    window._notesPanel.close();
  }

  const pdfView = document.getElementById('pdfView');
  if (pdfView) pdfView.style.display = 'none';
  (window as unknown as {
    __minalloDocRail?: { setRouteVisibility: (route: 'pdf' | 'courses' | 'other') => void };
  }).__minalloDocRail?.setRouteVisibility('courses');
  const welcome = document.getElementById('welcomeState');
  if (welcome) welcome.style.display = 'none';
  if (!co) return;

  co.style.display = 'block';

  const _semsLookup = (window as unknown as { SEMS?: Record<string, { color: string }> }).SEMS || {};
  const _semColor =
    _semsLookup[(window as unknown as { activeSemId?: string }).activeSemId || '']?.color || '#2563EB';
  const _safeName = escapeHtml(course.name || '');

  // Resolve file count for progress (same lookup priority as the courses grid).
  const _folderCount = (course.userFolders || []).reduce(
    (s, fd) => s + (fd.files ? fd.files.length : 0), 0
  );
  const _liveCount = (course.files?.length || 0) + _folderCount;
  let _cachedCount = 0;
  if (!_liveCount) {
    try {
      const ufc = JSON.parse(localStorage.getItem('ss_uf_cache_' + course.id) || 'null');
      if (ufc) {
        _cachedCount =
          (ufc.files || []).length +
          (ufc.folders || []).reduce(
            (s: number, fd: { files?: unknown[] }) => s + (fd.files ? fd.files.length : 0), 0
          );
      }
    } catch { /* corrupted cache */ }
  }
  const _fileCount =
    _liveCount || _cachedCount || parseInt(localStorage.getItem('ss_fc_' + course.id) || '0', 10);
  const _progress = computeCourseProgress(course.id, _fileCount);

  // Stamp which course this DOM belongs to — the alreadyRendered fast paths
  // above key off this attribute.
  co.setAttribute('data-rendered-course', String(course.id));
  co.innerHTML =
    '<div class="co-inner co-inner-v2" style="--co-hero-accent:' + _semColor + '">' +
    // ── Top nav strip: Back · title chip · Study ────────────────────────
    '<div class="co-topnav">' +
      '<button type="button" class="co-back-btn" id="coBackBtn" aria-label="Back to courses">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
        '<span>Back</span>' +
      '</button>' +
      '<div class="co-topnav-title">' + _safeName + '</div>' +
      // Position-relative wrapper so the Study popup, when re-parented
      // here, anchors directly under the button and scrolls with it.
      '<div class="co-study-wrap" id="coStudyWrap">' +
        '<button type="button" class="co-study-btn" id="coStudyBtn" title="Open Study Lounge">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>' +
          '<span>Study</span>' +
        '</button>' +
      '</div>' +
    '</div>' +
    // ── Big hero card with progress block on the right ──────────────────
    '<section class="co-hero">' +
      '<div class="co-hero-glow" aria-hidden="true"></div>' +
      '<div class="co-hero-grid">' +
        '<div class="co-hero-left">' +
          '<div class="co-hero-body">' +
            '<h1 class="co-hero-title">' + _safeName + '</h1>' +
            '<p class="co-hero-sub">Manage files, generate quizzes, study flashcards, and open AI or notes inside this course.</p>' +
          '</div>' +
        '</div>' +
        '<aside class="co-hero-progress">' +
          '<div class="co-hero-progress-head">' +
            '<span class="co-hero-progress-label">Study progress</span>' +
            '<span class="co-hero-progress-value">' + _progress.total + '%</span>' +
          '</div>' +
          '<div class="co-hero-progress-track">' +
            '<div class="co-hero-progress-fill" style="width:' + _progress.total + '%"></div>' +
          '</div>' +
          '<div class="co-hero-progress-stats">' +
            '<span class="co-hero-stat-pill">Read ' + _progress.readingProgress + '%</span>' +
            '<span class="co-hero-stat-pill">Notes ' + (_progress.notesProgress ?? 0) + '%</span>' +
            '<span class="co-hero-stat-pill">Practice ' + (_progress.practiceProgress ?? 0) + '%</span>' +
            '<span class="co-hero-stat-pill">AI ' + (_progress.aiReviewProgress ?? 0) + '%</span>' +
          '</div>' +
        '</aside>' +
      '</div>' +
    '</section>' +
    '<div class="co-card co-card-v2" style="margin-top:0">' +
    buildFilesContent(course) +
    '</div>' +
    // In-course Next steps section. Suggestions are derived from the same
    // signals the courses-grid panel uses; "weak topics" remains a static
    // placeholder until we have the underlying tracking.
    _buildCourseNextSteps(course, _progress) +
    '</div>';
  document.body.classList.add('minallo-in-course');

  const backBtn = co.querySelector<HTMLButtonElement>('#coBackBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      // Route back to the section the user entered the course view from
      // (e.g. the German practice dashboard) instead of always falling
      // through to the regular courses overview.
      //
      // Hash isn't usable as the signal — the router replaces it with
      // `#course=...&section=files` when a course/skill is opened. The
      // router does keep `ss_portal_tab` (session) / `ss_last_section`
      // (local) up to date with the portal section though, so prefer
      // those. 'courses' is the URL alias for the internal 'studip'.
      let backSection = 'studip';
      try {
        const stored =
          sessionStorage.getItem('ss_portal_tab') ||
          localStorage.getItem('ss_last_section') ||
          '';
        if (stored && stored !== 'dashboard') backSection = stored;
      } catch { /* storage unavailable */ }
      if (backSection === 'courses') backSection = 'studip';
      // Bug 1 fix: use _navigatePortal so the URL hash and sidebar highlight
      // are updated together, keeping browser back/forward in sync.
      if (typeof (window as unknown as { _navigatePortal?: (s: string) => void })._navigatePortal === 'function') {
        (window as unknown as { _navigatePortal: (s: string) => void })._navigatePortal(backSection);
      } else if (typeof window.showPortalSection === 'function') {
        window.showPortalSection(backSection);
      } else {
        window.history.back();
      }
    });
  }
  // If a focus session is already running when this view (re)renders, swap
  // the Study button for the in-session controls cluster.
  const _syncStudy = (window as unknown as { _syncCourseStudyBtn?: () => void })._syncCourseStudyBtn;
  if (typeof _syncStudy === 'function') _syncStudy();

  const studyBtn = co.querySelector<HTMLButtonElement>('#coStudyBtn');
  if (studyBtn) {
    studyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const popup = document.getElementById('stPopup');
      const isOpen = popup && popup.style.display === 'block';
      const w = window as unknown as {
        openStudyPopup?: () => void;
        closeStudyPopup?: () => void;
      };
      if (isOpen) {
        if (typeof w.closeStudyPopup === 'function') w.closeStudyPopup();
        else if (popup) popup.style.display = 'none';
        return;
      }
      if (typeof w.openStudyPopup === 'function') w.openStudyPopup();
    });
  }

  // Wire in-course Next steps card buttons. Each action maps to an existing
  // entry point: file rail focus, AI panel open, or Study Lounge.
  co.querySelectorAll<HTMLButtonElement>('.co-next-step').forEach((stepBtn) => {
    stepBtn.addEventListener('click', () => {
      const action = stepBtn.getAttribute('data-action') || '';
      if (action === 'open-ai') {
        if (typeof window.openAI === 'function') window.openAI();
        else if (typeof window.pinAI === 'function') window.pinAI();
      } else if (action === 'focus-session') {
        const w = window as unknown as { startQuickPomodoro?: (m?: number) => void };
        if (typeof w.startQuickPomodoro === 'function') w.startQuickPomodoro(25);
      } else if (action === 'review-files') {
        // Switch to Files tab and scroll the panel into view.
        const filesTab = co.querySelector<HTMLElement>('[data-course-tab="files"]');
        if (filesTab) filesTab.click();
        const filesPanel = document.getElementById('coFilesPanel');
        if (filesPanel) filesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  const coInner = co.querySelector<HTMLElement>('.co-inner');
  if (coInner) {
    coInner.classList.add('panel-enter');
  }

  bindFileEvents(co, course);
  bindFolderEvents(co, course);

  // Re-apply the source-type badges on every full render too (not just the
  // lighter refresh path), so they don't vanish after opening a PDF and
  // returning to the course.
  _decorateDocTypeBadges(co.querySelector<HTMLElement>('#coFilesPanel .co-files-list'), course);

  // Files panel search: filter folders + file rows by name as the user types.
  const filesSearchInput = co.querySelector<HTMLInputElement>('#coFilesSearchInput');
  if (filesSearchInput) {
    const _applyFilter = (): void => {
      const q = (filesSearchInput.value || '').trim().toLowerCase();
      // Match against folder header label and inline file rows.
      co.querySelectorAll<HTMLElement>('.co-folder-section').forEach((sec) => {
        const name = (sec.getAttribute('data-folder') || '').toLowerCase();
        const folderHit = !q || name.includes(q);
        let anyFileHit = false;
        sec.querySelectorAll<HTMLElement>('.co-folder-files .co-file').forEach((row) => {
          const fname = (row.getAttribute('data-fname') || '').toLowerCase();
          const hit = !q || fname.includes(q);
          row.style.display = hit ? '' : 'none';
          if (hit) anyFileHit = true;
        });
        sec.style.display = folderHit || anyFileHit ? '' : 'none';
      });
      co.querySelectorAll<HTMLElement>('#coFilesList > .co-file').forEach((row) => {
        const fname = (row.getAttribute('data-fname') || '').toLowerCase();
        row.style.display = !q || fname.includes(q) ? '' : 'none';
      });
    };
    filesSearchInput.addEventListener('input', _applyFilter);
  }

  // Folder ⋯ menu toggle. Click ⋯ to open/close; outside-click to close.
  co.querySelectorAll<HTMLButtonElement>('.co-folder-more-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement?.querySelector<HTMLElement>('.co-folder-more-menu');
      if (!menu) return;
      const wasOpen = menu.classList.contains('open');
      // Close any other open menus first.
      co.querySelectorAll<HTMLElement>('.co-folder-more-menu.open').forEach((m) => m.classList.remove('open'));
      if (!wasOpen) menu.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    co.querySelectorAll<HTMLElement>('.co-folder-more-menu.open').forEach((m) => m.classList.remove('open'));
  }, { once: false });

  const targetTab = sec !== 'files' ? sec : null;
  if (targetTab) {
    co.querySelectorAll<HTMLElement>('[data-course-tab]').forEach((tab) => {
      const isActive = tab.getAttribute('data-course-tab') === targetTab;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    co.querySelectorAll<HTMLElement>('[data-course-panel]').forEach((panel) => {
      panel.classList.toggle('active', panel.getAttribute('data-course-panel') === targetTab);
    });
    if (targetTab === 'quiz' || targetTab === 'flashcards' || targetTab === 'examforge' || targetTab === 'cheatsheet' || targetTab === 'deeplearn') {
      _mountFeaturePanel(co, targetTab, course);
    }
  }
}
