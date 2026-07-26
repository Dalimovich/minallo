import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');

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

test('configuration opens canonical production mounts in the chatbot overlay', () => {
  assert.match(workspace, /openStudyToolWorkspace/);
  assert.match(workspace, /window\.mountExamForge/);
  assert.match(workspace, /window\.mountFlashcards/);
  assert.match(workspace, /window\.mountDeepLearn/);
});
