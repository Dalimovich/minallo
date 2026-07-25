import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');
const moduleSource = fs.readFileSync(
  'frontend/js/features/chatbot-new/workspace-library.ts',
  'utf8'
);
const css = fs.readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('chatbot right drawer exposes Courses and Saved as primary tabs', () => {
  assert.match(html, /data-library-tab="courses"/);
  assert.match(html, /data-library-tab="saved"/);
  assert.match(html, /data-library-panel="courses"/);
  assert.match(html, /data-library-panel="saved"/);
});

test('course drawer reuses the real course registry, hydration, and file opener', () => {
  assert.match(moduleSource, /window\.SEMS \|\| window\._SEMS/);
  assert.match(moduleSource, /window\._ufMerge/);
  assert.match(moduleSource, /window\.openFile\?\.\(file, course\)/);
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
});

test('account overlays are opaque and desktop sidebars are floating rounded surfaces', () => {
  assert.match(css, /\.ncb-workspace-dialog[\s\S]*background:\s*#0a1729/);
  assert.match(css, /\.ncb-workspace-body[\s\S]*background:\s*#0b192c/);
  assert.match(css, /\.ncb-workspace-body > \.portal-section[\s\S]*background:\s*#0d1d32 !important/);
  assert.match(css, /@media \(min-width: 1025px\)[\s\S]*\.ncb-sidebar,[\s\S]*\.ncb-context[\s\S]*border-radius:\s*24px/);
});
