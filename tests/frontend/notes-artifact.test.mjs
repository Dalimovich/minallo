import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source-level checks for the Notes generatedDoc artifact wiring (widening
// GeneratedDoc.kind to include 'notes', the cross-chat reopen pointer, and
// the follow-up-grounding regexes). Consistent with how every other
// shell.ts-touching test in this repo verifies non-DOM control flow — see
// notes-intent-flow.test.mjs for the actually-executed behavioral coverage
// of the parts that don't require a browser DOM.
const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test("GeneratedDoc.kind includes 'notes' as a first-class artifact kind, not a bolted-on string", () => {
  assert.match(shell, /kind: 'cheatsheet' \| 'summary' \| 'notes';/);
});

test('a successful Notes generation with a persisted id becomes a generatedDoc, not plain text', () => {
  const fn = shell.slice(
    shell.indexOf('function notesIntentRouteResult'),
    shell.indexOf('function notesIntentRouteResult') + 800
  );
  assert.match(fn, /if \(!notes\.noteId \|\| !notes\.fileName\) return \{ text: notes\.text \};/);
  assert.match(fn, /kind: 'notes'/);
  assert.match(fn, /noteId: notes\.noteId/);
});

test('both Notes call sites (fresh command and resumed pending reply) route through the same generatedDoc wrapper', () => {
  const matches = [...shell.matchAll(/notesIntentRouteResult\(notes, [^)]+\)/g)];
  assert.equal(matches.length, 2, 'expected exactly one call site for the pending-resume branch and one for the fresh-command branch');
});

test('a persisted note writes the same cross-chat reopen pointer cheatsheet/summary already use', () => {
  const fn = shell.slice(
    shell.indexOf('async function handleNotesIntent'),
    shell.indexOf('} catch (err) {', shell.indexOf('async function handleNotesIntent'))
  );
  assert.match(fn, /localStorage\.setItem\('minallo_notes_last_' \+ courseId/);
});

test('restoreGeneratedDocForCourse can find a Notes doc across chats/after a refresh, not just cheatsheet/summary', () => {
  const fn = shell.slice(
    shell.indexOf('async function restoreGeneratedDocForCourse'),
    shell.indexOf('async function resolveFollowUpDoc')
  );
  assert.match(fn, /tryNotes = \(\): Promise<GeneratedDoc \| null> =>/);
  assert.match(fn, /minallo_notes_last_.*courseId/);
  assert.match(fn, /mentionsNotes/);
});

test('generatedDocLabel and the follow-up regexes recognise notes phrasing, not just cheatsheet/summary', () => {
  assert.match(shell, /const kind = doc\.kind === 'summary' \? 'Summary' : doc\.kind === 'notes' \? 'Notes' : 'Cheatsheet';/);
  const refRe = shell.slice(shell.indexOf('const GENERATED_DOC_REF_RE'), shell.indexOf('const GENERATED_DOC_REF_RE') + 300);
  assert.match(refRe, /notes\?\|notizen/);
  const kindRe = shell.slice(shell.indexOf('const GENERATED_DOC_KIND_RE'), shell.indexOf('const GENERATED_DOC_KIND_RE') + 300);
  assert.match(kindRe, /notes\?\|notizen/);
});
