// Notifications are GLOBAL UI: they must stack above every application overlay (Profile/Settings/Subscription
// workspace modals included). Tests the intended layer relationship, not a magic number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const base = read('frontend/css/base.css');
const toastCss = read('frontend/views/toast/toast.css');
const modalCss = read('frontend/js/features/chatbot-new/workspace-modals/workspace-modal.css');

const layer = (name) => {
  const m = base.match(new RegExp('--layer-' + name + ':\\s*(\\d+)'));
  assert.ok(m, `--layer-${name} must be defined in css/base.css`);
  return Number(m[1]);
};

/** Effective z-index of the first rule for `selector`, resolving var(--layer-*) through css/base.css. */
function effectiveZ(css, selector) {
  const rule = css.match(new RegExp(selector.replace(/[.#]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}'));
  assert.ok(rule, `rule ${selector} not found`);
  const z = rule[1].match(/z-index:\s*([^;]+);/);
  assert.ok(z, `${selector} has no z-index`);
  const v = z[1].trim();
  const viaVar = v.match(/^var\(--layer-([a-z-]+)/);
  return viaVar ? layer(viaVar[1]) : Number(v);
}

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'extension') return [];
    if (statSync(p).isDirectory()) return cssFiles(p);
    return name.endsWith('.css') ? [p] : [];
  });
}

test('layer scale: drawer < modal < notification', () => {
  assert.ok(layer('drawer') < layer('modal'));
  assert.ok(layer('modal') < layer('notification'));
});

test('the toast stack and the workspace modal root take their layer from the shared tokens', () => {
  assert.match(toastCss, /#ss-toast-stack\s*\{[^}]*z-index:\s*var\(--layer-notification/);
  assert.match(modalCss, /\.mn-workspace-modal-root\s*\{[^}]*z-index:\s*var\(--layer-modal/);
});

test('a toast raised while Profile is open sits above the modal root (effective stacking, not a magic number)', () => {
  const toastZ = effectiveZ(toastCss, '#ss-toast-stack');
  const modalZ = effectiveZ(modalCss, '.mn-workspace-modal-root');
  assert.ok(toastZ > modalZ, `toast (${toastZ}) must be above the modal root (${modalZ})`);
});

test('no application stylesheet declares a literal z-index at or above the notification layer', () => {
  const ceiling = layer('notification');
  const offenders = [];
  for (const file of cssFiles(resolve(ROOT, 'frontend'))) {
    const css = readFileSync(file, 'utf8');
    for (const m of css.matchAll(/z-index:\s*(\d+)/g)) {
      if (Number(m[1]) >= ceiling) offenders.push(`${file.replace(ROOT, '')}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'only the notification layer may reach the top of the scale');
});

test('the notification root is a global body-level portal, not owned by Profile or any modal', () => {
  for (const view of ['profile', 'settings', 'subscription']) {
    assert.ok(!read(`frontend/views/${view}/${view}.html`).includes('ss-toast-stack'), `${view}.html must not host the toast stack`);
  }
  assert.match(read('frontend/views/toast/toast.html'), /id="ss-toast-stack"/);
  assert.match(read('frontend/js/loader.js'), /'views\/toast\/toast\.html'/);
  // the workspace modal mounts on <body>: both roots are siblings, so only z-index decides which is on top
  assert.match(read('frontend/js/features/chatbot-new/workspace-modals/workspace-modal-shell.ts'), /document\.body\.appendChild\(mount\)/);
});

test('the toast stack does not create a stacking context inside the modal (no transform/filter on its ancestors)', () => {
  const stackRule = toastCss.match(/#ss-toast-stack\s*\{([^}]*)\}/)[1];
  assert.match(stackRule, /position:\s*fixed/);
  assert.doesNotMatch(stackRule, /transform|filter|will-change/);
});

test('base.css (the layer tokens) is part of the app stylesheet set the loader injects', () => {
  assert.match(read('frontend/js/loader.js'), /css\/base\.css/);
});
