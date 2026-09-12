import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');
const moduleSource = fs.readFileSync(
  'frontend/js/features/chatbot-new/workspace-library.ts',
  'utf8'
);
const css = fs.readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
const globalCss = fs.readFileSync('frontend/css/styles.css', 'utf8');
const subscriptionHtml = fs.readFileSync('frontend/views/subscription/subscription.html', 'utf8');
const subscriptionJs = fs.readFileSync('frontend/views/subscription/subscription.js', 'utf8');
const notificationsTs = fs.readFileSync(
  'frontend/js/features/notifications/notifications.ts',
  'utf8'
);
const shellSource = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('Study Panel file cards render document-bound type controls without post-render decoration', () => {
  assert.match(moduleSource, /data-document-id=/);
  assert.match(moduleSource, /correctionSelectHtml\(doc\)/);
  assert.match(moduleSource, /bindDocumentsToCourseFiles\(course, docs\)/);
  assert.match(moduleSource, /wireCorrectionSelectors\(detail\)/);
  assert.doesNotMatch(moduleSource, /data-file-type-slot=/);
  assert.doesNotMatch(moduleSource, /decorateFileTypeBadges\(detail/);
});

test('Study Panel distinguishes authoritative indexing failure from network uncertainty', () => {
  assert.match(moduleSource, /failure\.processingStatus === 'failed'/);
  assert.match(moduleSource, /Backend indexing failed:/);
  assert.match(moduleSource, /Status unavailable · Retry/);
  assert.match(moduleSource, /<em>Status unavailable<\/em>/);
  assert.match(moduleSource, /reconcilePendingIndexState/);
  assert.doesNotMatch(moduleSource, /state === 'error' \|\| state === 'unknown'/);
});

test('new Study Panel rows wire their picker and uploads do not claim to be lectures', () => {
  assert.match(moduleSource, /wireCorrectionSelectors\(row\)/);
  assert.match(moduleSource, /sourceType: 'unknown'/);
  assert.doesNotMatch(moduleSource, /sourceType: 'lecture'/);
  assert.match(moduleSource, /study_panel_file_type_picker_missing/);
});

test('Study Panel file cards keep filename identity separate from type actions', () => {
  assert.match(moduleSource, /study-file-card__identity/);
  assert.match(moduleSource, /study-file-card__filename/);
  assert.match(moduleSource, /study-file-card__actions/);
  assert.match(moduleSource, /file\.name \|\| file\._storageName/);
  assert.match(moduleSource, /study_file_missing_filename/);
  assert.match(moduleSource, /item\._document\?\.id === documentId/);
  assert.match(moduleSource, /data-library-file="" data-document-id=/);
  assert.match(css, /\.study-file-card\.ncb-file-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(css, /\.study-file-card\.ncb-file-row\s*\{[^}]*box-sizing:\s*border-box/);
  assert.match(css, /\.study-file-card__content\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.study-file-card__meta\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.ncb-file-doctype \.doc-type-select\s*\{[^}]*max-width:\s*150px/);
});
const pdfViewerSource = fs.readFileSync(
  'frontend/js/features/pdf-viewer/pdf-viewer.ts',
  'utf8'
);
const appSource = fs.readFileSync('frontend/js/app.ts', 'utf8');
const portalHtml = fs.readFileSync('frontend/pages/portal.html', 'utf8');
const examforgeSource = fs.readFileSync('frontend/views/examforge/examforge.js', 'utf8');
const chatbotCss = fs.readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('chatbot right drawer exposes Courses and Saved as primary tabs', () => {
  assert.match(html, /data-library-tab="courses"/);
  assert.match(html, /data-library-tab="saved"/);
  assert.match(html, /data-library-panel="courses"/);
  assert.match(html, /data-library-panel="saved"/);
});

test('course library has glass cards and persists a larger most-recent course', () => {
  assert.match(moduleSource, /const RECENT_COURSE_KEY = 'minallo:chatbot-recent-course'/);
  assert.match(moduleSource, /localStorage\.setItem\(RECENT_COURSE_KEY, course\.id\)/);
  assert.match(moduleSource, /const ordered = recent \? \[recent, \.\.\.all\.filter/);
  assert.match(moduleSource, /ncb-course-row--recent/);
  assert.match(css, /\.ncb-course-row--recent\s*\{[\s\S]*min-height:\s*76px/);
  assert.match(css, /\.ncb-course-row\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\)/);
  assert.match(css, /\.ncb-file-row\s*\{[\s\S]*backdrop-filter:\s*blur\(16px\)/);
  assert.match(css, /\.ncb-folder\s*\{[\s\S]*backdrop-filter:\s*blur\(16px\)/);
});

test('Study Panel course selection binds the active chat course before rendering', () => {
  assert.match(moduleSource, /function bindCourseToActiveChat\(course: LibraryCourse\)/);
  assert.match(moduleSource, /window\.activeCourseId = course\.id/);
  assert.match(moduleSource, /minallo:active-chat-course-changed/);
  assert.match(moduleSource, /bindCourseToActiveChat\(course\);[\s\S]*rememberCourse\(course\);[\s\S]*renderCourseDetail\(panel, course\)/);
  assert.match(shellSource, /chat\.courseId = courseId/);
  assert.match(shellSource, /restoreActiveChatCourse\(\)/);
});

test('chatbot removes the legacy icon rail and uses a slimmer AI chats sidebar', () => {
  assert.match(css, /body\.ncb-fullbleed #portal \.sidebar \{ display:\s*none !important; \}/);
  assert.match(css, /@media \(min-width: 1025px\)[\s\S]*\.ncb-sidebar \{ width:\s*252px;/);
});

test('collapsed sidebar stacks notification and avatar controls without clipping', () => {
  assert.match(css, /data-collapsed="true"\] \.ncb-account[\s\S]*flex-direction:\s*column/);
  assert.match(css, /data-collapsed="true"\] \.ncb-notification-trigger,[\s\S]*\.ncb-account-trigger[\s\S]*width:\s*44px/);
});

test('widgets launcher mounts selected dashboard widgets in an animated anchored popup', () => {
  assert.match(html, /class="ncb-widgets-btn"/);
  assert.match(html, /class="ncb-widget-menu"/);
  assert.match(html, /class="ncb-widget-float"/);
  assert.match(moduleSource, /function bindWidgetLauncher/);
  assert.match(moduleSource, /_ssLoadFeatureSection\?\.\('dashboard'\)/);
  assert.match(moduleSource, /#dashCanvas \.dash-widget/);
  assert.match(moduleSource, /floatingBody\.appendChild\(widget\)/);
  assert.match(moduleSource, /widgetOrigin\.parentNode\.insertBefore\(mountedWidget, widgetOrigin\)/);
  assert.match(moduleSource, /if \(!launcher\.contains\(event\.target as Node\)\) closeAll\(\)/);
  assert.match(css, /\.ncb-widget-menu, \.ncb-widget-float[\s\S]*backdrop-filter:\s*blur\(28px/);
  assert.match(css, /\.ncb-widget-menu, \.ncb-widget-float[\s\S]*left:\s*calc\(100% \+ 34px\)/);
  assert.match(css, /data-collapsed="true"\] \.ncb-widget-menu,[\s\S]*left:\s*116px/);
  assert.match(css, /@keyframes ncb-float-pop/);
});

test('account menu closes on outside click and workspace dialogs float on glass', () => {
  assert.match(moduleSource, /if \(!root\.querySelector<HTMLElement>\('\.ncb-account'\)\?\.contains\(event\.target as Node\)\)/);
  assert.match(html, /data-admin-page hidden>Admin page<\/button>/);
  assert.match(moduleSource, /checkAdminStatus\(\)/);
  assert.match(moduleSource, /localStorage\.getItem\('sb_sess_token'\)[\s\S]*sessionStorage\.getItem\('sb_sess_token'\)/);
  assert.match(moduleSource, /if \(open\) await resolveAdminAccess\?\.\(\)/);
  assert.match(moduleSource, /window\.location\.assign\('\/admin\.html'\)/);
  assert.match(css, /\.ncb-account-menu[\s\S]*backdrop-filter:\s*blur\(28px\) saturate\(145%\)/);
  assert.match(css, /\.ncb-workspace-dialog[\s\S]*backdrop-filter:\s*blur\(34px\) saturate\(140%\)/);
  assert.match(css, /@keyframes ncb-dialog-float-in/);
});

test('course drawer reuses the real course registry, hydration, and file opener', () => {
  assert.match(moduleSource, /window\.SEMS \|\| window\._SEMS/);
  assert.match(moduleSource, /window\._ufMerge/);
  assert.match(moduleSource, /window\.openFile\(file, course\)/);
});

test('Study Library keeps cached course and Saved content visible while revalidating', () => {
  assert.match(moduleSource, /if \(cached\) paintCourseDetail\(panel, course, cached\.scrollTop\)/);
  assert.match(moduleSource, /if \(isCourseFresh\(cached\)\) return/);
  assert.match(moduleSource, /dedupeStudyRequest\(`course:\$\{course\.id\}`/);
  assert.match(moduleSource, /if \(cachedItems\.length \|\| state\.savedStatus === 'ready'\)/);
  assert.match(moduleSource, /state\.savedStatus = 'refreshing'/);
  assert.doesNotMatch(moduleSource, /panel\.dataset\.loaded/);
});

test('closing the workspace PDF restores the preserved drawer DOM without course hydration', () => {
  const closeBody = moduleSource.slice(
    moduleSource.indexOf('function closeWorkspacePdf'),
    moduleSource.indexOf('function openWorkspacePdf')
  );
  assert.match(closeBody, /pdfContextInner\.hidden = false/);
  assert.doesNotMatch(closeBody, /renderCourseDetail|ensureCourseHydrated|_ufMerge/);
});

test('closing the workspace PDF clears the canonical active-PDF state and deselects its source', () => {
  // Without this, nothing resets getActivePdfContext()'s underlying state on
  // close — the AI kept treating a PDF the user had closed as still open,
  // and the Sources card kept showing it as selected.
  const closeBody = moduleSource.slice(
    moduleSource.indexOf('function closeWorkspacePdf'),
    moduleSource.indexOf('function openWorkspacePdf')
  );
  assert.match(closeBody, /clearActivePdfViewerState\(\)/);
  assert.match(closeBody, /window\.deselectChatbotSource\?\.\(openWorkspacePdfSourceId\)/);
  assert.match(moduleSource, /import \{ clearActivePdfViewerState \} from '\.\.\/pdf-viewer\/active-pdf-context\.js'/);
  assert.match(moduleSource, /let openWorkspacePdfSourceId: string \| null = null/);
  assert.match(
    moduleSource,
    /openWorkspacePdfSourceId = 'workspace-pdf:' \+ course\.id \+ ':' \+ file\.name/
  );
});

test('Study Library remount removes document listeners before binding replacements', () => {
  assert.match(moduleSource, /let workspaceLibraryCleanup: \(\(\) => void\) \| null = null/);
  assert.match(moduleSource, /workspaceLibraryCleanup\?\.\(\)/);
  assert.match(moduleSource, /removeEventListener\('minallo:saved-replies-changed'/);
  assert.match(moduleSource, /removeEventListener\('minallo:auth:signed-in'/);
});

test('persistent Study Library cache is user-scoped, survives remount, and deduplicates requests', async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  globalThis.window = { _currentUser: { id: 'library-user-a' } };
  try {
    const store = await import('../../frontend/js/features/chatbot-new/study-library-store.ts');
    store.resetStudyLibraryMemory();
    store.setCourseEntry('course-a', {
      files: [], folders: [], hydrated: true, status: 'ready', fetchedAt: Date.now(),
      error: null, scrollTop: 84,
    });
    const state = store.studyLibraryState();
    state.savedItems = [{
      id: 'saved-1', kind: 'summaries', title: 'Summary', courseId: 'course-a',
      courseName: 'Course A', meta: 'today',
    }];
    state.savedStatus = 'ready';
    state.savedFetchedAt = Date.now();
    store.persistStudyLibrary();

    store.resetStudyLibraryMemory();
    assert.equal(store.courseEntry('course-a').scrollTop, 84);
    assert.equal(store.studyLibraryState().savedItems[0].id, 'saved-1');

    let requests = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const first = store.dedupeStudyRequest('course:course-a', async () => { requests += 1; await pending; return 1; });
    const second = store.dedupeStudyRequest('course:course-a', async () => { requests += 1; return 2; });
    assert.equal(requests, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);

    globalThis.window._currentUser = { id: 'library-user-b' };
    assert.equal(store.courseEntry('course-a'), null);
    assert.equal(store.studyLibraryState().savedItems.length, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

test('an empty Study cache cannot overwrite known Fertigungstechnik files', () => {
  assert.match(moduleSource, /inMemoryCount > cachedCourseFileCount\(cached\)/);
  assert.match(moduleSource, /cachedCourseFileCount\(cached\) === 0\) && restoreCanonicalCourseCache/);
  assert.match(moduleSource, /cachedCourseFileCount\(cached\) === 0 && expectedCourseFileCount\(course\.id\) > 0/);
  assert.match(moduleSource, /cached\.fetchedAt = null/);
});

test('course drawer can add subjects and manage course files in place', () => {
  assert.match(moduleSource, /class="ncb-add-subject"/);
  assert.match(moduleSource, /id="ncbSubjectSearch" type="search"/);
  assert.match(moduleSource, /canonicalButton\.click\(\)/);
  assert.match(moduleSource, /class="ncb-course-action ncb-course-new-folder"/);
  assert.match(moduleSource, /class="ncb-course-action ncb-course-upload"/);
  assert.match(moduleSource, /window\._ufCreateFolder/);
  assert.match(moduleSource, /window\._ufUpload/);
  assert.match(css, /\.ncb-course-detail-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(moduleSource, /ncb-course-manage/);
  assert.doesNotMatch(moduleSource, /window\.openCourse\?\.\(course\)/);
});

test('avatar and notification controls share the same glass button shell', () => {
  assert.match(css, /\.ncb-notification-trigger\s*\{[\s\S]*width:\s*46px;[\s\S]*border-radius:\s*15px/);
  assert.match(css, /\.ncb-account-trigger\s*\{[\s\S]*width:\s*46px;[\s\S]*border-radius:\s*15px/);
  assert.match(html, /class="ncb-account-avatar"[\s\S]*<circle cx="12" cy="8" r="4"/);
  assert.match(css, /\.ncb-account-avatar\s*\{[\s\S]*background:\s*transparent/);
});

test('course and folder drop targets clearly identify the upload destination', () => {
  assert.match(moduleSource, /data-drop-folder=/);
  assert.match(moduleSource, /addEventListener\('dragenter'/);
  assert.match(moduleSource, /addEventListener\('dragover'/);
  assert.match(moduleSource, /addEventListener\('dragleave'/);
  assert.match(moduleSource, /addEventListener\('drop'/);
  assert.match(moduleSource, /classList\.add\('is-drag-target'\)/);
  assert.match(css, /\.ncb-root-drop\.is-drag-target,[\s\S]*\.ncb-folder\.is-drag-target[\s\S]*border-color:\s*#60a5fa/);
});

test('Saved is grouped by resource function and course', () => {
  for (const kind of ['notes', 'summaries', 'flashcards', 'cheatsheets', 'exams', 'responses']) {
    assert.match(moduleSource, new RegExp(`${kind}:`));
  }
  assert.match(moduleSource, /allCourses\.map\(\(course\)/);
  assert.match(moduleSource, /items\.filter\(\(item\) => item\.course\.id === course\.id\)/);
});

test('bookmarked AI responses load from the durable database endpoint', () => {
  assert.match(moduleSource, /authenticatedFetch\('\/api\/chat-saved-replies'/);
  assert.match(moduleSource, /kind: 'responses'/);
  assert.match(moduleSource, /renderMarkdown\(text\)/);
  assert.match(shellSource, /syncSavedReplyCreate\(chat\.id, reply\)/);
  assert.match(moduleSource, /localBookmarkedResponses\(\)/);
  assert.match(moduleSource, /\[\.\.\.serverRows, \.\.\.localRows\]/);
});

test('course library provides permanent delete actions for files, folders, and courses', () => {
  assert.match(moduleSource, /data-delete-file=/);
  assert.match(moduleSource, /data-delete-folder=/);
  assert.match(moduleSource, /data-delete-course=/);
  assert.match(moduleSource, /\/api\/documents\/delete/);
  assert.match(moduleSource, /\/api\/course-delete/);
  assert.match(css, /\.ncb-library-delete\s*\{[\s\S]*margin-left:\s*auto/);
  assert.match(css, /\.ncb-course-row-main > span:not\(\.ncb-library-icon\)/);
});

test('course upload popup indexes uploaded PDFs for chatbot retrieval', () => {
  assert.match(moduleSource, /class="ncb-upload-popup"/);
  assert.match(moduleSource, /\/api\/documents\/index-existing/);
  assert.match(moduleSource, /Upload complete\. Indexing files for AI search/);
  assert.match(moduleSource, /className = 'ncb-file-row ncb-file-row--pending'/);
  assert.match(moduleSource, /setPendingFileState\(pendingRow, 'indexing', 'Indexing for AI'\)/);
  assert.match(moduleSource, /setPendingFileState\(pendingRow, 'ready', 'Indexed'\)/);
  assert.match(moduleSource, /window\.setTimeout\(\(\) => replacePendingWithFileRow[\s\S]*?, 2200\)/);
  assert.match(css, /\.ncb-index-state i\s*\{[\s\S]*animation:\s*ncb-index-spin/);
  const uploadBody = moduleSource.slice(moduleSource.indexOf('async function uploadIntoCourse'), moduleSource.indexOf('function courseCollectionHost'));
  assert.doesNotMatch(uploadBody, /renderCourseDetail\(/);
});

test('file and folder deletion update only their affected drawer rows', () => {
  const fileDelete = moduleSource.slice(moduleSource.indexOf('async function deleteFileCompletely'), moduleSource.indexOf('async function deleteFolderCompletely'));
  const folderDelete = moduleSource.slice(moduleSource.indexOf('async function deleteFolderCompletely'), moduleSource.indexOf('async function deleteCourseCompletely'));
  assert.match(fileDelete, /row\.remove\(\)/);
  assert.match(folderDelete, /details\?\.remove\(\)/);
  assert.doesNotMatch(fileDelete, /renderCourseDetail\(/);
  assert.doesNotMatch(folderDelete, /renderCourseDetail\(/);
});

test('folder deletion is server-confirmed before browser state is removed', () => {
  const folderDelete = moduleSource.slice(moduleSource.indexOf('async function deleteFolderCompletely'), moduleSource.indexOf('async function deleteCourseCompletely'));
  assert.match(folderDelete, /authenticatedFetch\('\/api\/folder-delete'/);
  assert.match(folderDelete, /body: JSON\.stringify\(\{ courseId: course\.id, folderName: name \}\)/);
  assert.match(folderDelete, /if \(!response\.ok\) throw new Error/);
  assert.ok(folderDelete.indexOf("authenticatedFetch('/api/folder-delete'") < folderDelete.indexOf('window._ufDeleteFolder'));
  assert.match(folderDelete, /showToast\?\.\('Delete failed'/);
});

test('course deletion surfaces the failed server stage', () => {
  const courseDelete = moduleSource.slice(moduleSource.indexOf('async function deleteCourseCompletely'), moduleSource.indexOf('function rootFor'));
  assert.match(courseDelete, /payload\?\.error\?\.message/);
  assert.match(courseDelete, /Server stage:/);
  assert.match(courseDelete, /study_panel_course_delete_failed/);
});

test('tutor modes allow one selection or no selection', () => {
  assert.match(shellSource, /const selected = next === currentTutorMode \? null : next/);
  assert.match(shellSource, /currentTutorMode = selected/);
  assert.match(shellSource, /getCurrentTutorMode[\s\S]*currentTutorMode \|\| TUTOR_MODE_DEFAULT/);
});

test('courses and saved resources use replacement-style drill-down navigation', () => {
  assert.match(moduleSource, /renderCourseDetail\(panel, course\)/);
  assert.match(moduleSource, /renderCourses\(panel\)/);
  assert.match(moduleSource, /class="ncb-saved-kind-btn"/);
  assert.match(moduleSource, /renderSavedKind\(panel, root, items, allCourses, kind\)/);
  assert.match(moduleSource, /renderSavedKinds\(panel, root, items, allCourses\)/);
  assert.match(moduleSource, /class="ncb-library-back"/);
});

test('saved resources and account destinations use the workspace overlay', () => {
  assert.match(html, /data-workspace-overlay/);
  assert.match(moduleSource, /openSaved\(root, item\)/);
  assert.match(moduleSource, /openPortalView\(root, button\.dataset\.accountView/);
  assert.match(html, /data-account-view="profile"/);
  assert.match(html, /data-account-view="subscription"/);
  assert.match(html, /data-account-view="lounge"/);
  assert.match(html, /data-account-view="settings"/);
});

test('workspace popup sections are restored from the detached host and forced visible', () => {
  assert.match(moduleSource, /section\.style\.setProperty\('display', 'block', 'important'\)/);
  assert.match(css, /\.ncb-workspace-body > \.portal-section\s*\{[\s\S]*display:\s*block !important/);
  assert.match(moduleSource, /if \(!overlay\.hidden && overlay\.dataset\.movedSection\) closeOverlay\(overlay\)/);
});

test('account overlays load both the real section HTML and its feature scripts', () => {
  assert.match(moduleSource, /window\._ssLoadFeatureSection\?\.\(view\)/);
  assert.match(moduleSource, /window\._ssLoadPortalFeature\?\.\(view\)/);
  assert.match(moduleSource, /await window\._ssLoadFeatureSection[\s\S]*await window\._ssLoadPortalFeature/);
  assert.match(moduleSource, /window\.refreshSubscriptionView\?\.\(\)/);
});

test('subscription popup refreshes into a current-plan view for Pro accounts', () => {
  assert.match(subscriptionHtml, /id="subPlanBadge"/);
  assert.match(subscriptionHtml, /id="subPlanPrice"/);
  assert.match(subscriptionJs, /window\.refreshSubscriptionView\s*=/);
  assert.match(subscriptionJs, /Current subscription/);
  assert.match(subscriptionJs, /everything included with it/);
  assert.match(subscriptionJs, /legalBlock\.style\.display = paypalResubscribe \? '' : 'none'/);
});

test('account overlays are glassy and desktop sidebars are floating rounded surfaces', () => {
  assert.match(css, /\.ncb-workspace-dialog[\s\S]*rgba\(8, 22, 40, 0\.82\)/);
  assert.match(css, /\.ncb-workspace-body[\s\S]*background:\s*rgba\(9, 24, 43, 0\.48\)/);
  assert.match(css, /\.ncb-workspace-body > \.portal-section[\s\S]*background:\s*rgba\(13, 32, 55, 0\.62\) !important/);
  assert.match(css, /@media \(min-width: 1025px\)[\s\S]*\.ncb-sidebar,[\s\S]*\.ncb-context[\s\S]*border-radius:\s*24px/);
});

test('saved category buttons are large full-width cards with separated content', () => {
  assert.match(css, /\.ncb-saved-kind-list[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.ncb-saved-kind-btn\s*\{[\s\S]*min-height:\s*78px/);
  assert.match(css, /\.ncb-saved-kind-btn \.ncb-library-icon[\s\S]*width:\s*46px/);
  assert.match(css, /\.ncb-saved-kind-btn > b[\s\S]*flex:\s*0 0 30px/);
});

test('workspace popups have no separate header and use a floating close control', () => {
  assert.doesNotMatch(html, /ncb-workspace-head/);
  assert.doesNotMatch(html, /ncbWorkspaceTitle/);
  assert.match(html, /class="ncb-workspace-close"/);
  assert.match(css, /\.ncb-workspace-close\s*\{[\s\S]*position:\s*absolute/);
  assert.match(moduleSource, /dialog\.setAttribute\('aria-label', title\)/);
});

test('the original square navigation item opens notifications in the workspace popup', () => {
  assert.match(html, /class="ncb-notification-trigger"/);
  assert.match(moduleSource, /querySelector<HTMLButtonElement>\('\.ncb-notification-trigger'\)/);
  assert.match(moduleSource, /openPortalView\(root, 'notifications'\)/);
  assert.match(moduleSource, /getElementById\('psbNotifications'\)/);
  assert.match(moduleSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(moduleSource, /openPortalView\(root, 'notifications'\)/);
  assert.match(moduleSource, /window\.renderNotifications\?\.\(\)/);
  assert.match(notificationsTs, /item\.querySelector\('\.sb-badge'\)/);
  assert.match(css, /data-workspace-view="notifications"[\s\S]*rgba\(7, 20, 37, 0\.82\)/);
  assert.match(css, /\.notif-tab\.active[\s\S]*background:\s*#245ca8 !important/);
});

test('course files replace the right drawer with the canonical rounded PDF viewer', () => {
  assert.match(moduleSource, /function openWorkspacePdf/);
  assert.match(moduleSource, /pdfHost\.appendChild\(wrap\)/);
  assert.match(moduleSource, /toolbar\?\.classList\.add\('is-collapsed'\)/);
  assert.match(moduleSource, /aiPanel\.style\.display = 'none'/);
  assert.match(css, /\.ncb-pdf-host #pdfViewerWrap[\s\S]*border-radius:\s*inherit/);
  assert.match(css, /body\.ncb-pdf-workspace-open #drRail,[\s\S]*#drDrawer/);
  assert.doesNotMatch(portalHtml, /<\/svg>\s*Annotate\s*<\/button>/);
});

test('workspace PDF is resizable and reflows its rendered page content', () => {
  assert.match(moduleSource, /class="ncb-pdf-resize"/);
  assert.match(moduleSource, /addEventListener\('pointermove', onMove\)/);
  assert.match(moduleSource, /context\.style\.flexBasis = `\$\{next\}px`/);
  assert.match(moduleSource, /_refitPdfWidth\?: \(\) => void/);
  assert.match(moduleSource, /localStorage\.setItem\(PDF_WIDTH_KEY/);
  assert.match(moduleSource, /new ResizeObserver/);
  assert.match(css, /\.ncb-pdf-resize\s*\{[\s\S]*cursor:\s*ew-resize/);
  assert.match(css, /\.ncb-context\.ncb-pdf-resizing[\s\S]*transition:\s*none !important/);
});

test('workspace PDF toolbar stays movable and keeps annotation controls visible', () => {
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfToolbar \.pdf-toolbar-top[\s\S]*display:\s*none !important/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfToolbar\.is-collapsed #pdfFit/);
  assert.match(appSource, /if \(document\.body\.classList\.contains\('ncb-pdf-workspace-open'\)\) collapsed = true/);
  assert.match(appSource, /function placeAnnotationToolbar/);
  assert.match(appSource, /buttonRect\.bottom \+ gap/);
  assert.match(appSource, /const opensAbove = belowTop \+ popoverRect\.height > maxBottom/);
  assert.match(appSource, /left:\s*0, right:\s*window\.innerWidth, top:\s*0, bottom:\s*window\.innerHeight/);
  assert.match(appSource, /place\(rect\.left, rect\.top\)/);
  assert.doesNotMatch(appSource, /const distances = \[[\s\S]*edge:\s*'left'/);
  assert.match(appSource, /new MutationObserver\(refreshFloatingControls\)\.observe\(document\.body/);
  assert.match(appSource, /new ResizeObserver\(refreshFloatingControls\)\.observe\(workspaceHost\)/);
  assert.match(appSource, /placeAnnotationToolbar\(\);[\s\S]*function keepClearOfSidebar/);
  assert.match(css, /--annot-arrow-left/);
  assert.match(appSource, /document\.querySelector<HTMLElement>\('\.ncb-pdf-host'\)/);
  assert.match(appSource, /const useViewportCoordinates = maximized \|\| !workspaceOpen/);
  assert.match(appSource, /setProperty\('position', useViewportCoordinates \? 'fixed' : 'absolute', 'important'\)/);
  assert.match(appSource, /setProperty\('right', 'auto', 'important'\)/);
  assert.match(appSource, /setProperty\('transform', 'none', 'important'\)/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfToolbar\.is-collapsed[\s\S]*position:\s*absolute/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfAnnotateToggle[\s\S]*place-items:\s*center/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfAnnotateToggle svg[\s\S]*display:\s*block/);
  assert.match(globalCss, /body\.pdf-maximized #pdfToolbar\.is-collapsed[\s\S]*transform:\s*none/);
  assert.match(globalCss, /\.annotate-popover\[data-placement="top"\]::before/);
});

test('opening a workspace PDF keeps the chatbot route and grounds RAG on that PDF without excluding the rest of the course', () => {
  assert.match(pdfViewerSource, /const inChatbotWorkspace = !!window\._ncbPdfWorkspaceActive/);
  assert.match(pdfViewerSource, /if \(!inChatbotWorkspace\) \{[\s\S]*selectTopLevelView\('file'/);
  assert.match(pdfViewerSource, /if \(!inChatbotWorkspace\) \{[\s\S]*window\._ssPushHistory\?\.\(/);
  assert.match(moduleSource, /window\.selectChatbotPdfSource\?\.\(course, file\)/);
  assert.match(shellSource, /export function selectChatbotPdfSource/);
  assert.match(shellSource, /active\.selectedSourceIds = \[sourceId\]/);
  assert.match(shellSource, /active\.sourceMode = 'course_files'/);
  // The real document id rides along when the caller has it, so duplicate
  // filenames in the same course can still be told apart (the backend
  // otherwise has to fall back to ambiguous filename-only resolution).
  assert.match(shellSource, /documents: \[\{ id: file\._document\?\.id, name: file\.name, text: '' \}\]/);
  // Opening a PDF must NOT force 'specific_files' scope: that used to hard-scope
  // every later question in the chat to just this one file, and once the PDF
  // was closed, to zero files ("No files are selected for this request") until
  // the user noticed and manually switched back. The open PDF still grounds
  // answers via activeDocumentId (a retrieval ranking boost, not a filter).
  const selectChatbotPdfSourceBody = shellSource.slice(
    shellSource.indexOf('export function selectChatbotPdfSource'),
    shellSource.indexOf('export function selectChatbotPdfSource') + 1100
  );
  assert.doesNotMatch(selectChatbotPdfSourceBody, /active\.courseFileScope = 'specific_files'/);
});

test('refresh restores the chatbot PDF and Back restores its originating course', () => {
  assert.match(moduleSource, /const PDF_SESSION_KEY = 'minallo:chatbot-open-pdf'/);
  assert.match(moduleSource, /sessionStorage\.setItem\(PDF_SESSION_KEY/);
  assert.match(moduleSource, /sessionStorage\.setItem\('ss_portal_tab', 'aipage'\)/);
  assert.match(moduleSource, /localStorage\.setItem\('ss_last_section', 'aipage'\)/);
  assert.match(moduleSource, /localStorage\.removeItem\('ss_state'\)/);
  assert.match(moduleSource, /restoreWorkspacePdf\(root, coursePanel\)/);
  assert.match(moduleSource, /attempt < 80/);
  assert.match(moduleSource, /setTimeout\(\(\) => restoreWorkspacePdf\(root, coursePanel, attempt \+ 1\), 100\)/);
  assert.doesNotMatch(moduleSource, /await renderCourseDetail\(coursePanel, course\)/);
  assert.match(moduleSource, /openWorkspacePdf\(root, file, course\)/);
  const closeBody = moduleSource.slice(moduleSource.indexOf('function closeWorkspacePdf'), moduleSource.indexOf('function openWorkspacePdf'));
  assert.match(closeBody, /pdfContextInner\.hidden = false/);
  assert.doesNotMatch(closeBody, /renderCourseDetail|_ufMerge/);
  assert.match(moduleSource, /sessionStorage\.removeItem\(PDF_SESSION_KEY\)/);
  const backgroundCourse = moduleSource.indexOf('void renderCourseDetail(coursePanel, course)');
  const immediatePdf = moduleSource.indexOf('openWorkspacePdf(root, file, course)', backgroundCourse);
  assert.ok(backgroundCourse >= 0 && immediatePdf > backgroundCourse);
});

// ── Saved artifacts must reliably open their actual content ────────────────
// Regression coverage for: clicking a Saved item either shows the exact
// artifact clicked, or a visible retry-capable error — never a stuck
// "Opening resource…" state, an empty overlay, or the wrong artifact.

test('opening a Saved item always resolves to either content or a visible retry error', () => {
  const openSavedBody = moduleSource.slice(
    moduleSource.indexOf('async function openSaved'),
    moduleSource.indexOf('async function renderResolvedSaved')
  );
  assert.match(openSavedBody, /try \{[\s\S]*resolveCachedSavedItem\(item\)[\s\S]*renderResolvedSaved\(overlay, resolved\)[\s\S]*\} catch \(error\) \{/);
  assert.match(openSavedBody, /renderSavedOpenError\(overlay, error, \(\) => void openSaved\(root, item\)\)/);
  assert.match(moduleSource, /function renderSavedOpenError\(overlay: HTMLElement, error: unknown, retry: \(\) => void\)/);
  assert.match(moduleSource, /class="ncb-saved-retry">Retry<\/button>/);
  assert.match(moduleSource, /querySelector<HTMLButtonElement>\('\.ncb-saved-retry'\)\?\.addEventListener\('click', retry\)/);
  assert.match(chatbotCss, /\.ncb-saved-retry\s*\{/);
});

test('a saved AI response with no resolvable payload never renders a blank article', () => {
  const responsesBranch = moduleSource.slice(
    moduleSource.indexOf("if (item.kind === 'responses') {", moduleSource.indexOf('async function renderResolvedSaved')),
    moduleSource.indexOf('async function renderResolvedSaved') + 900
  );
  assert.match(responsesBranch, /if \(!text \|\| !text\.trim\(\)\) throw new SavedOpenError\('invalid'/);
  assert.doesNotMatch(responsesBranch, /renderMarkdown\(response\.text \|\| ''\)/);
});

test('a local-only bookmarked AI response reopens without hitting the server', () => {
  const resolveBody = moduleSource.slice(
    moduleSource.indexOf('async function resolveCachedSavedItem'),
    moduleSource.length
  );
  assert.match(resolveBody, /const local = localBookmarkedResponses\(\)\.find\(\(row\) => row\.id === item\.id\)/);
  assert.match(resolveBody, /if \(local\) return \{ \.\.\.item, payload: \{ text: local\.reply_text \|\| '' \} \}/);
  // Local lookup must come before the network round trip, not after/instead.
  assert.ok(resolveBody.indexOf('localBookmarkedResponses()') < resolveBody.indexOf('authenticatedFetch(`/api/chat-saved-replies'));
});

test('a saved flashcard deck is validated before mounting, never handed undefined', () => {
  const flashcardBranch = moduleSource.slice(
    moduleSource.indexOf("if (item.kind === 'flashcards') {", moduleSource.indexOf('async function renderResolvedSaved')),
    moduleSource.indexOf("if (item.kind === 'exams') {")
  );
  assert.match(flashcardBranch, /if \(!deck \|\| !Array\.isArray\(deck\.cards\)\) throw new SavedOpenError\('not_found'/);
  assert.match(flashcardBranch, /if \(!deck\.cards\.length\) throw new SavedOpenError\('invalid'/);
  assert.match(flashcardBranch, /mount\(player, deck, \{ embedded: false, mode: 'study' \}\)/);
  assert.doesNotMatch(flashcardBranch, /mount\(player, item\.payload/);
});

test('opening a saved practice exam mounts that exact session, not a generic empty workspace', () => {
  const examBranch = moduleSource.slice(
    moduleSource.indexOf("if (item.kind === 'exams') {", moduleSource.indexOf('async function renderResolvedSaved')),
    moduleSource.indexOf("throw new SavedOpenError('invalid', 'This saved resource type is not supported.")
  );
  assert.match(examBranch, /mountCourseFeature\(overlay, item\.course, 'examforge', \{ initialSessionId: item\.id \}\)/);
  assert.match(moduleSource, /function mountCourseFeature\(\s*target: HTMLElement,\s*course: LibraryCourse,\s*kind: 'examforge',\s*extra: Record<string, unknown> = \{\}/);
  assert.match(moduleSource, /generate: window\._generateStudyTool, \.\.\.extra/);

  // resolveCachedSavedItem must refuse to open a deleted session rather than
  // silently falling through to whatever session ExamForge picks by default.
  const resolveBody = moduleSource.slice(moduleSource.indexOf('async function resolveCachedSavedItem'), moduleSource.length);
  assert.match(resolveBody, /if \(!payload\) throw new SavedOpenError\('not_found'/);

  // ExamForge itself must honor the requested session id: select it, and
  // reset any in-progress answers left over from a different session.
  assert.match(examforgeSource, /var initialSessionId = options\.initialSessionId \|\| null;/);
  assert.match(examforgeSource, /var requested = initialSessionId && st\.sessions\.some\(function \(s\) \{ return s\.id === initialSessionId; \}\);/);
  assert.match(examforgeSource, /if \(requested && st\.activeId !== initialSessionId\) \{[\s\S]{0,120}st\.activeId = initialSessionId;/);
});

test('saved cheatsheet opening never deletes the shared workspace body node', () => {
  const cheatsheetBranch = moduleSource.slice(
    moduleSource.indexOf("if (item.kind === 'cheatsheets' && item.note) {"),
    moduleSource.indexOf("if (item.note) {", moduleSource.indexOf("if (item.kind === 'cheatsheets' && item.note) {"))
  );
  // The cheatsheet-workspace module (which exports openCheatsheetPaper) must
  // be loaded BEFORE the paper viewer is invoked, and the workspace overlay
  // must not be dismissed until AFTER openCheatsheetPaper() has run and its
  // .cs-paper-overlay is confirmed mounted. Closing first (the old order) meant
  // an exception from openCheatsheetPaper() rendered its error into an overlay
  // that had already been closed/emptied, so the user saw nothing. Dismissal
  // itself must go through closeOverlay (which restores the persistent
  // .ncb-workspace-body for reuse) rather than .remove() (which deleted that
  // singleton node outright and broke every later "open" click in the session
  // until a full page reload).
  const noteIdx = cheatsheetBranch.indexOf('if (!note)');
  const moduleLoadIdx = cheatsheetBranch.indexOf("await import('./cheatsheet-workspace.js')");
  const invokeIdx = cheatsheetBranch.indexOf('cheatsheetModule.openCheatsheetPaper({');
  const mountCheckIdx = cheatsheetBranch.indexOf("document.querySelector('.cs-paper-overlay')");
  const closeIdx = cheatsheetBranch.indexOf('closeOverlay(overlay.closest');
  assert.ok(
    noteIdx >= 0 && moduleLoadIdx > noteIdx && invokeIdx > moduleLoadIdx
    && mountCheckIdx > invokeIdx && closeIdx > mountCheckIdx
  );
  // Only the explanatory comment may mention the old call; no live statement may.
  assert.doesNotMatch(cheatsheetBranch, /[^`]overlay\.remove\(\);/);
});

test('saved notes and summaries distinguish a deleted note from a load failure', () => {
  const notesBranch = moduleSource.slice(
    moduleSource.indexOf('if (item.note) {', moduleSource.indexOf("if (item.kind === 'cheatsheets' && item.note) {")),
    moduleSource.indexOf("if (item.kind === 'flashcards') {")
  );
  assert.match(notesBranch, /if \(!note\) throw new SavedOpenError\('not_found', 'This saved resource is no longer available\.'\)/);
  // A thrown network/session error from getNoteById is not caught locally —
  // it propagates to openSaved's try/catch, which renders the generic
  // "could not load, retry" message instead of misreporting it as deleted.
  assert.doesNotMatch(notesBranch, /catch/);
});

test('fetchRows surfaces a failed request instead of a fake empty result', () => {
  const fetchRowsBody = moduleSource.slice(
    moduleSource.indexOf('async function fetchRows'),
    moduleSource.indexOf('function formatDate')
  );
  assert.match(fetchRowsBody, /if \(!response\.ok\) throw new Error\(`fetchRows\(\$\{table\}\) failed: \$\{response\.status\}`\)/);
});

// ── Saved refresh must degrade per-resource, per-course ─────────────────────
// Regression coverage for: fetchRows() now correctly throws on a failed
// request (see the test above), which fixed "an empty result silently looks
// like success" — but the OLD Saved refresh wrapped every course's three
// requests, and every course's own Promise, in nested Promise.all(). One
// flaky flashcard_decks/exam_sessions/notes request for ANY course rejected
// the whole thing, replacing content that had already loaded successfully
// for every other course with a blanket error screen.

test('one failed resource category never rejects that course\'s other categories', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function loadSavedForCourse'),
    moduleSource.indexOf('interface SavedLoadResult')
  );
  assert.match(fn, /await Promise\.allSettled\(\[\s*listCourseNotes\(course\.id\),\s*fetchRows\('flashcard_decks', course\.id\),\s*fetchRows\('exam_sessions', course\.id\)\s*\]\)/);
  assert.match(fn, /if \(notesResult\.status === 'fulfilled'\)/);
  assert.match(fn, /failedCategories\.push\('notes'\)/);
  assert.match(fn, /if \(decksResult\.status === 'fulfilled'\)/);
  assert.match(fn, /failedCategories\.push\('flashcards'\)/);
  assert.match(fn, /if \(examsResult\.status === 'fulfilled'\)/);
  assert.match(fn, /failedCategories\.push\('exams'\)/);
});

test('one course failing entirely never rejects loadAllSaved and never touches other courses', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function loadAllSaved'),
    moduleSource.indexOf('function withCachedFallback')
  );
  // loadSavedForCourse (tested above) can only ever resolve, so mapping it
  // across every course and awaiting with Promise.all cannot reject because
  // of any single course — this is the fix for "Course A's failure blanked
  // Course B and Course C too".
  assert.match(fn, /const courseLoads = await Promise\.all\(allCourses\.map\(loadSavedForCourse\)\)/);
  assert.match(fn, /const \[responsesSettled\] = await Promise\.allSettled\(\[loadBookmarkedResponses\(\)\]\)/);
});

test('cached rows are restored for exactly the (course, category) pairs that failed, never for ones that succeeded', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('function withCachedFallback'),
    moduleSource.indexOf('function renderSavedTotalError')
  );
  assert.match(fn, /if \(!result\.failedCourseCategories\.length && !result\.responsesFailed\) return freshItems/);
  assert.match(fn, /const fallback = previousCachedItems\.filter\(\(item\) => item\.courseId === courseId && kinds\.includes\(item\.kind as SavedKind\)\)/);
  assert.match(fn, /merged\.push\(\.\.\.savedItemsFromCache\(fallback, allCourses\)\)/);
  // "notes" covers notes/summaries/cheatsheets as one unit, since they share
  // a single underlying request and fail/succeed together.
  assert.match(moduleSource, /if \(category === 'notes'\) return \['notes', 'summaries', 'cheatsheets'\]/);
});

test('a partial failure renders everything that loaded and shows a non-blocking warning, never an error screen', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function renderSaved'),
    moduleSource.length
  );
  assert.match(fn, /const hasFailures = result\.failedCourseCategories\.length > 0 \|\| result\.responsesFailed/);
  assert.match(fn, /const mergedItems = withCachedFallback\(result\.items, result, previousCachedItems, allCourses\)/);
  assert.match(fn, /paintSavedState\(panel, root, mergedItems, savedGroupsFor\(mergedItems, allCourses\)\)/);
  assert.match(fn, /if \(hasFailures\) \{\s*window\.showToast\?\.\('Some saved resources could not be refreshed', 'Showing everything that loaded successfully\.'\)/);
});

test('total failure (nothing usable, fresh or cached) shows a visible error with Retry — a partial success never does', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function renderSaved'),
    moduleSource.length
  );
  assert.match(fn, /if \(!mergedItems\.length && hasFailures\) \{/);
  assert.match(fn, /renderSavedTotalError\(panel, root\);\s*return;/);
  assert.match(moduleSource, /function renderSavedTotalError\(panel: HTMLElement, root: HTMLElement\): void \{/);
  assert.match(moduleSource, /class="ncb-saved-retry">Retry<\/button>/);
  assert.match(moduleSource, /void renderSaved\(panel, root, true\)/);
});

test('a fully clean refresh marks Saved fresh; a partial refresh leaves the freshness clock alone so failed categories retry on next visit', () => {
  // The freshness write must be gated behind !hasFailures — not unconditional
  // — so a partial load doesn't get treated as good-for-SAVED_TTL and skip
  // retrying the categories that actually failed on the next visit.
  assert.match(moduleSource, /if \(!hasFailures\) state\.savedFetchedAt = Date\.now\(\);/);
});

// ── Saved pagination: a course with >50 decks/exams must stay fully reachable ──

test('fetchRows pages with offset and reports whether a full page came back', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function fetchRows'),
    moduleSource.indexOf('async function fetchRowById')
  );
  assert.match(fn, /async function fetchRows\(table: string, courseId: string, offset = 0\)/);
  assert.match(fn, /limit=\$\{SAVED_PAGE_SIZE\}&offset=\$\{offset\}/);
  assert.match(fn, /return \{ rows, hasMore: rows\.length === SAVED_PAGE_SIZE \}/);
});

test('opening an old saved deck/exam beyond the first page resolves by id directly, not by searching a capped listing', () => {
  // This is the actual bug the P2 audit predicted: resolveCachedSavedItem
  // used to reuse fetchRows' top-SAVED_PAGE_SIZE listing and search it for
  // the clicked id — a deck/exam older than that page was visible in Saved
  // but "not found" the instant you opened it.
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function resolveCachedSavedItem'),
    moduleSource.length
  );
  assert.match(fn, /payload = await dedupeStudyRequest\(`saved:\$\{table\}:\$\{item\.id\}`, \(\) => fetchRowById\(table, item\.id\)\)/);
  assert.doesNotMatch(fn, /rows\.find\(\(row\) => String\(row\.id\) === item\.id\)/);
  const fetchRowByIdFn = moduleSource.slice(
    moduleSource.indexOf('async function fetchRowById'),
    moduleSource.indexOf('function formatDate')
  );
  assert.match(fetchRowByIdFn, /\?id=eq\.\$\{encodeURIComponent\(id\)\}&limit=1/);
});

test('a course with a full first page of flashcards/exams offers Load more, and loading more appends rather than replaces', () => {
  const htmlFn = moduleSource.slice(
    moduleSource.indexOf('function savedKindHtml'),
    moduleSource.indexOf('function bindSaved(')
  );
  assert.match(htmlFn, /const paginated = kind === 'flashcards' \|\| kind === 'exams'/);
  assert.match(htmlFn, /cursor\?\.hasMore/);
  assert.match(htmlFn, /class="ncb-saved-load-more"/);

  const loadMoreFn = moduleSource.slice(
    moduleSource.indexOf('async function loadMoreSavedCategory'),
    moduleSource.length
  );
  assert.match(loadMoreFn, /const offset = savedPageCursors\.get\(key\)\?\.offset \?\? SAVED_PAGE_SIZE/);
  assert.match(loadMoreFn, /state\.savedItems = \[\.\.\.state\.savedItems, \.\.\.newItems\.map\(savedItemCache\)\]/);
  // Notes/summaries/cheatsheets never paginate — no evidence they share the
  // same capped-listing shape as the two direct Supabase-table fetches.
  assert.match(moduleSource, /if \(kind !== 'flashcards' && kind !== 'exams'\) return;/);
});

// ── First-load hydration: unknown must never collapse into a false zero ────

test('a course file count only shows 0 when something positively confirms it, otherwise it shows unknown', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('function resolveCourseFileCount'),
    moduleSource.indexOf('function fileCountLabel')
  );
  assert.match(fn, /const live = fileCount\(course\);\s*if \(live > 0\) return live;/);
  assert.match(fn, /if \(entryCount > 0\) return entryCount;/);
  // hydrated + ready is the ONLY path that returns a confirmed zero — the
  // mere absence of a cache entry must fall through to unknown, not 0.
  assert.match(fn, /if \(entry\.hydrated && entry\.status === 'ready'\) return 0;/);
  assert.match(fn, /return null;/);
  assert.match(moduleSource, /function fileCountLabel\(course: LibraryCourse\): string \{\s*const count = resolveCourseFileCount\(course\);\s*return count === null \? '— files' : `\$\{count\} files`;/);
  // The two first-paint course-count displays must use the unknown-aware
  // label, not the raw fileCount() that silently treats "not loaded" as 0.
  assert.match(moduleSource, /<small>\$\{fileCountLabel\(course\)\}<\/small>/);
  assert.match(moduleSource, /<span>\$\{fileCountLabel\(course\)\}<\/span>/);
});

test('a stale ss_fc_ hint is used as a last resort, and an explicit stored 0 is trusted (not treated as absent)', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('function resolveCourseFileCount'),
    moduleSource.indexOf('function fileCountLabel')
  );
  assert.match(fn, /localStorage\.getItem\(`ss_fc_\$\{course\.id\}`\)/);
  // Reads the raw string first so a present-but-zero value ("0") is
  // distinguishable from a missing key (null) — expectedCourseFileCount()
  // alone can't tell those apart, since it defaults a missing key to 0 too.
  assert.match(fn, /if \(rawExpected !== null\) \{/);
});

// ── Course-registry-ready: closes the boot race that cached a false-empty Saved ──

test('Saved never commits a fresh empty result while the course registry is still unconfirmed', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('async function renderSaved'),
    moduleSource.indexOf('function paintSavedState')
  );
  assert.match(fn, /if \(!allCourses\.length && !courseRegistryReady\) \{/);
  // Must return before reaching the network scan / savedStatus='ready' commit.
  const guardBlock = fn.slice(fn.indexOf('if (!allCourses.length && !courseRegistryReady) {'));
  const guardEnd = guardBlock.indexOf('\n  }\n');
  assert.match(guardBlock.slice(0, guardEnd), /return;/);
});

test('the workspace library listens for minallo:course-registry-ready and reconciles Courses + Saved on it', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('export function initWorkspaceLibrary'),
    moduleSource.indexOf('export type StudyWorkspaceKind')
  );
  assert.match(fn, /window\.addEventListener\('minallo:course-registry-ready', handleCourseRegistryReady\)/);
  assert.match(fn, /window\.removeEventListener\('minallo:course-registry-ready', handleCourseRegistryReady\)/);
  // A Saved result that was committed "ready" with zero items must be
  // invalidated once the registry is confirmed — that's the exact false-
  // empty snapshot this event exists to correct.
  assert.match(fn, /if \(state\.savedStatus === 'ready' && state\.savedItems\.length === 0\) \{\s*invalidateSaved\(\);/);
  assert.match(fn, /if \(courses\(\)\.length > 0\) courseRegistryReady = true;/);
});

test('Saved metadata starts warming when the workspace mounts, not only after the Saved tab is clicked', () => {
  const fn = moduleSource.slice(
    moduleSource.indexOf('export function initWorkspaceLibrary'),
    moduleSource.indexOf('export type StudyWorkspaceKind')
  );
  assert.match(fn, /if \(libraryState\.activeTab !== 'saved'\) void renderSaved\(savedPanel, root\);/);
});

test('app-data.js dispatches course-registry-ready only once the registry actually reflects reality, including the confirmed-empty case', () => {
  const appData = fs.readFileSync('frontend/js/app-data.js', 'utf8');
  assert.match(appData, /function _dispatchCourseRegistryReady\(courseIds\) \{/);
  assert.match(appData, /window\.dispatchEvent\(new CustomEvent\('minallo:course-registry-ready', \{/);
  // Both the "no courses at all" early-return AND the normal populate path
  // must dispatch — a user with zero courses is a real, confirmed answer.
  const fn = appData.slice(appData.indexOf('function _loadUserCourses'), appData.length);
  const earlyReturn = fn.slice(0, fn.indexOf('return;\n  }'));
  assert.match(earlyReturn, /_dispatchCourseRegistryReady\(\[\]\)/);
  assert.match(fn, /_dispatchCourseRegistryReady\(Object\.keys\(SEMS\)\.reduce/);
});

test('cached course data applies on the next microtask, not an arbitrary 1500ms/300ms wait', () => {
  const userData = fs.readFileSync('frontend/js/features/auth/user-data.ts', 'utf8');
  assert.match(userData, /function scheduleUserCoursesLoad\(courses: unknown\): void \{/);
  assert.match(userData, /queueMicrotask\(\(\) => \{/);
  assert.doesNotMatch(userData, /scheduleUserCoursesLoad\([^)]*,\s*1500\)/);
  assert.doesNotMatch(userData, /scheduleUserCoursesLoad\([^)]*,\s*300\)/);
});
