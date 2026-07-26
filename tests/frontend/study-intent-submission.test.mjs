import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
const workflow = fs.readFileSync('frontend/js/features/chatbot-new/study-tool-workflow.ts', 'utf8');

test('chat submission gates study tools before RAG and never falls through after routing', () => {
  const gate = shell.indexOf('await handleIntentRoute(state, bubble, thinking, controller)');
  const rag = shell.indexOf('const rag = ragEligibility(originMessages)', gate);
  assert.ok(gate > 0 && rag > gate);
  assert.match(shell.slice(gate, rag), /if \(routed\)[\s\S]*return(?: true)?;/);
});

test('interactive commands render structured configuration and suppress RAG', () => {
  assert.match(shell, /route\.intent === 'examforge'/);
  assert.match(shell, /renderStudyToolConfiguration\(bubble, marker\)/);
  assert.match(shell, /normalRagSuppressed:\s*true/);
  assert.match(shell, /studyToolConfiguration\?: StudyToolConfigurationMarker/);
});

test('configuration is editable inline and generation does not open a workspace', () => {
  assert.match(workflow, /data-field=/);
  assert.match(workflow, /data-source/);
  assert.match(workflow, /Create exam/);
  assert.match(workflow, /await generate\(marker\)/);
  const configurationHandler = workflow.slice(workflow.indexOf('export function renderStudyToolConfiguration'));
  assert.doesNotMatch(configurationHandler, /openStudyToolWorkspace/);
});

test('only persisted typed artifacts open canonical production mounts', () => {
  assert.match(workflow, /persistedResourceId/);
  assert.match(workflow, /rendererVersion:\s*1/);
  assert.match(workflow, /if \(!artifact\?\.persistedResourceId\) return/);
  assert.match(workflow, /data-open-artifact/);
  assert.match(workspace, /openStudyToolWorkspace/);
  assert.match(workspace, /window\.mountExamForge/);
  assert.match(workspace, /window\.mountFlashcards/);
  assert.match(workspace, /window\.mountDeepLearn/);
});

test('study cards reuse active PDF context and hydrate the canonical document API', () => {
  assert.match(shell, /resolveStudyToolSource\([\s\S]*getActivePdfContext\(\)/);
  assert.match(workflow, /listCourseDocuments\(marker\.courseId\)/);
  assert.match(workflow, /processing_status/);
  assert.match(workflow, /Open document/);
  assert.match(workflow, /Course files/);
  assert.match(workflow, /Whole course/);
});

test('source selector supports ready-state multi-selection without resetting parameters', () => {
  assert.match(workflow, /data-source-document/);
  assert.match(workflow, /Select all ready/);
  assert.match(workflow, /doc\.readiness !== 'ready'.*disabled/s);
  assert.match(workflow, /marker\.parameters = \{ \.\.\.definition\.defaults, \.\.\.marker\.parameters \}/);
  assert.match(workflow, /documentIds, count: Number\(p\.count\)/);
});

test('source selector is a compact collapsible card control', () => {
  assert.match(workflow, /ncb-source-trigger/);
  assert.match(workflow, /aria-expanded/);
  assert.match(workflow, /ncb-source-popover/);
  assert.match(workflow, /panel\.hidden = !marker\.sourcePickerOpen/);
});

test('an open PDF discovered after card creation enables the live source option', () => {
  assert.match(workflow, /getActivePdfContext\(\)/);
  assert.match(workflow, /window\.setInterval/);
  assert.match(workflow, /nextId === marker\.activePdf\?\.documentId/);
  assert.match(workflow, /renderStudyToolConfiguration\(host, marker\)/);
});
