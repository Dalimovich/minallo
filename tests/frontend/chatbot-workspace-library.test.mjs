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
const pdfViewerSource = fs.readFileSync(
  'frontend/js/features/pdf-viewer/pdf-viewer.ts',
  'utf8'
);
const appSource = fs.readFileSync('frontend/js/app.ts', 'utf8');
const portalHtml = fs.readFileSync('frontend/pages/portal.html', 'utf8');

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
  assert.match(css, /\.ncb-course-row--recent\s*\{[\s\S]*min-height:\s*88px/);
  assert.match(css, /\.ncb-course-row\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\)/);
  assert.match(css, /\.ncb-file-row\s*\{[\s\S]*backdrop-filter:\s*blur\(16px\)/);
  assert.match(css, /\.ncb-folder\s*\{[\s\S]*backdrop-filter:\s*blur\(16px\)/);
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

test('Saved is grouped by resource function and course', () => {
  for (const kind of ['notes', 'summaries', 'flashcards', 'cheatsheets', 'exams']) {
    assert.match(moduleSource, new RegExp(`${kind}:`));
  }
  assert.match(moduleSource, /allCourses\.map\(\(course\)/);
  assert.match(moduleSource, /items\.filter\(\(item\) => item\.course\.id === course\.id\)/);
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

test('account overlays load both the real section HTML and its feature scripts', () => {
  assert.match(moduleSource, /window\._ssLoadFeatureSection\?\.\(view\)/);
  assert.match(moduleSource, /window\._ssLoadPortalFeature\?\.\(view\)/);
  assert.match(moduleSource, /Promise\.all/);
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
  assert.match(appSource, /document\.getElementById\('pdfViewerWrap'\)/);
  assert.match(appSource, /new MutationObserver\(refreshFloatingControls\)\.observe\(document\.body/);
  assert.match(appSource, /new ResizeObserver\(refreshFloatingControls\)\.observe\(workspaceHost\)/);
  assert.match(appSource, /placeAnnotationToolbar\(\);[\s\S]*function keepClearOfSidebar/);
  assert.match(css, /--annot-arrow-left/);
  assert.match(appSource, /document\.querySelector<HTMLElement>\('\.ncb-pdf-host'\)/);
  assert.match(appSource, /clampedLeft - \(containingRect\?\.left \|\| 0\)/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfToolbar\.is-collapsed[\s\S]*position:\s*absolute/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfAnnotateToggle[\s\S]*place-items:\s*center/);
  assert.match(css, /body\.ncb-pdf-workspace-open #pdfAnnotateToggle svg[\s\S]*display:\s*block/);
  assert.match(globalCss, /body\.pdf-maximized #pdfToolbar\.is-collapsed[\s\S]*transform:\s*none/);
  assert.match(globalCss, /\.annotate-popover\[data-placement="top"\]::before/);
});

test('opening a workspace PDF keeps the chatbot route and scopes RAG to that PDF', () => {
  assert.match(pdfViewerSource, /const inChatbotWorkspace = !!window\._ncbPdfWorkspaceActive/);
  assert.match(pdfViewerSource, /if \(!inChatbotWorkspace\) \{[\s\S]*selectTopLevelView\('file'/);
  assert.match(pdfViewerSource, /if \(!inChatbotWorkspace\) \{[\s\S]*window\._ssPushHistory\?\.\(/);
  assert.match(moduleSource, /window\.selectChatbotPdfSource\?\.\(course, file\)/);
  assert.match(shellSource, /export function selectChatbotPdfSource/);
  assert.match(shellSource, /active\.sourceMode = 'course_files'/);
  assert.match(shellSource, /active\.courseFileScope = 'specific_files'/);
  assert.match(shellSource, /documents: \[\{ name: file\.name, text: '' \}\]/);
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
  assert.match(moduleSource, /const currentCourse = courses\(\)\.find/);
  assert.match(moduleSource, /renderCourseDetail\(coursePanel, currentCourse\)/);
  assert.match(moduleSource, /sessionStorage\.removeItem\(PDF_SESSION_KEY\)/);
  const backgroundCourse = moduleSource.indexOf('void renderCourseDetail(coursePanel, course)');
  const immediatePdf = moduleSource.indexOf('openWorkspacePdf(root, file, course)', backgroundCourse);
  assert.ok(backgroundCourse >= 0 && immediatePdf > backgroundCourse);
});
