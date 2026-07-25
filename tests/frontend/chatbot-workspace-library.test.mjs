import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');
const moduleSource = fs.readFileSync(
  'frontend/js/features/chatbot-new/workspace-library.ts',
  'utf8'
);
const css = fs.readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
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
const portalHtml = fs.readFileSync('frontend/pages/portal.html', 'utf8');

test('chatbot right drawer exposes Courses and Saved as primary tabs', () => {
  assert.match(html, /data-library-tab="courses"/);
  assert.match(html, /data-library-tab="saved"/);
  assert.match(html, /data-library-panel="courses"/);
  assert.match(html, /data-library-panel="saved"/);
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

test('account overlays are opaque and desktop sidebars are floating rounded surfaces', () => {
  assert.match(css, /\.ncb-workspace-dialog[\s\S]*background:\s*#0a1729/);
  assert.match(css, /\.ncb-workspace-body[\s\S]*background:\s*#0b192c/);
  assert.match(css, /\.ncb-workspace-body > \.portal-section[\s\S]*background:\s*#0d1d32 !important/);
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
  assert.doesNotMatch(html, /class="ncb-notification-trigger"/);
  assert.match(moduleSource, /getElementById\('psbNotifications'\)/);
  assert.match(moduleSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(moduleSource, /openPortalView\(root, 'notifications'\)/);
  assert.match(moduleSource, /window\.renderNotifications\?\.\(\)/);
  assert.match(notificationsTs, /item\.querySelector\('\.sb-badge'\)/);
  assert.match(css, /data-workspace-view="notifications"[\s\S]*background:\s*#091629/);
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
