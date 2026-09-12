import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const shell = read('frontend/js/features/chatbot-new/workspace-modals/workspace-modal-shell.ts');
const focus = read('frontend/js/features/chatbot-new/workspace-modals/workspace-modal-focus.ts');
const css = read('frontend/js/features/chatbot-new/workspace-modals/workspace-modal.css');
const library = read('frontend/js/features/chatbot-new/workspace-library.ts');
const profile = read('frontend/js/features/chatbot-new/workspace-modals/profile-modal.ts');
const subscription = read('frontend/js/features/chatbot-new/workspace-modals/subscription-modal.ts');
const lounge = read('frontend/js/features/chatbot-new/workspace-modals/study-lounge-modal.ts');

test('one shared modal controller owns all requested account workspaces', () => {
  assert.match(shell, /profile:\s*profileWorkspace/);
  assert.match(shell, /settings:\s*settingsWorkspace/);
  assert.match(shell, /subscription:\s*subscriptionWorkspace/);
  assert.match(shell, /'study-lounge':\s*studyLoungeWorkspace/);
  assert.match(shell, /cleanupWorkspaceModal\?\.\(\)/);
  assert.match(library, /openWorkspaceModal\(modalTypes\[view\]\)/);
  assert.match(shell, /data-layout="\$\{feature\.layout\}"/);
  assert.match(shell, /feature\.nav\?\.length \? '<nav/);
});

test('workspace dialog contains focus and restores the underlying application', () => {
  assert.match(shell, /role="dialog" aria-modal="true"/);
  assert.match(shell, /event\.key === 'Escape'/);
  assert.match(shell, /event\.target === backdrop/);
  assert.match(shell, /previousFocus\?\.focus\(\)/);
  assert.match(shell, /origin\.parentNode\.insertBefore\(section, origin\)/);
  assert.match(focus, /event\.key !== 'Tab'/);
});

test('workspace shell is contained, responsive and uses the Minallo glass tokens', () => {
  assert.match(css, /--mn-modal-bg/);
  assert.match(css, /width:\s*min\(1320px, 96vw\)/);
  assert.match(css, /height:\s*min\(860px, 94vh\)/);
  assert.match(css, /overscroll-behavior-y:\s*contain/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*width:\s*100vw[\s\S]*height:\s*100dvh/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('full workspaces occupy one explicit track without an empty shell column', () => {
  assert.match(css, /data-layout="full"[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.mn-workspace-content\s*\{[^}]*width:\s*100%[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/);
  assert.match(css, /> \.portal-section\s*\{[^}]*width:\s*100% !important[^}]*max-width:\s*none !important/);
  assert.match(profile, /layout:\s*'full'/);
  assert.match(subscription, /layout:\s*'full'/);
  assert.match(lounge, /layout:\s*'full'/);
});

test('workspace content has a definite constrained height and owns vertical scrolling', () => {
  assert.match(css, /\.mn-workspace-body\s*\{[^}]*flex:\s*1 1 0[^}]*height:\s*0[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
  assert.match(css, /\.mn-workspace-content\s*\{[^}]*height:\s*100%[^}]*max-height:\s*100%[^}]*overflow-y:\s*auto/);
  assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(shell, /workspace-modal\.css\?v=/);
  assert.match(shell, /content\.addEventListener\('wheel'/);
  assert.match(shell, /content\.scrollTop \+= event\.deltaY/);
  assert.match(shell, /passive:\s*false/);
});

test('feature adapters use real profile, billing and lounge refresh paths', () => {
  assert.match(profile, /Profile completeness/);
  assert.match(profile, /querySelectorAll.*profile-fields/);
  assert.match(subscription, /refreshSubscriptionView/);
  assert.match(lounge, /_loungeRender/);
  assert.doesNotMatch(lounge, /mock|placeholder|fake room/i);
});
