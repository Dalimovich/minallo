import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Coverage for the Saved panel's per-item delete feature. These are source
// assertions (this repo's established pattern for workspace-library.ts —
// see the other chatbot-workspace-library.test.mjs cases), not a live
// browser+backend run. A best-effort Playwright spec covering the actual
// user flow lives at tests/e2e/17-saved-delete.spec.ts, but it needs a real
// authenticated session against a live backend/DB to execute — that
// combination isn't available in this environment, so it could not be run
// here. These tests instead pin the exact contract that spec depends on.

const moduleSource = readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
const shellSource = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('the delete control is never nested inside the open button', () => {
  const rowStart = moduleSource.indexOf('function savedKindHtml(');
  const rowEnd = moduleSource.indexOf('\nfunction setSavedRowConfirming', rowStart);
  const row = moduleSource.slice(rowStart, rowEnd);
  // The row wrapper is a <div>, and .ncb-saved-open / .ncb-saved-delete are
  // SIBLING <button> elements — assert the delete button opens only after
  // .ncb-saved-open's closing tag, not before it (which would mean nesting).
  const openBtnClose = row.indexOf('</button>');
  const deleteBtnOpen = row.indexOf('class="ncb-saved-delete');
  assert.ok(openBtnClose > 0 && deleteBtnOpen > openBtnClose,
    'ncb-saved-delete must be a sibling of ncb-saved-open, not nested inside it');
  assert.match(row, /<div class="ncb-saved-row"/);
  assert.doesNotMatch(row, /<button[^>]*class="ncb-saved-row"/);
});

test('delete uses the site\'s existing trash icon and library-delete styling, not an emoji', () => {
  const rowStart = moduleSource.indexOf('function savedKindHtml(');
  const rowEnd = moduleSource.indexOf('\nfunction setSavedRowConfirming', rowStart);
  const row = moduleSource.slice(rowStart, rowEnd);
  assert.match(row, /class="ncb-saved-delete ncb-library-delete"/);
  assert.match(row, /\$\{trashIcon\(\)\}/);
  assert.doesNotMatch(row, /🗑|🗑️/);
});

test('deletion requires an inline confirm — no native confirm() and no immediate delete on first click', () => {
  const rowStart = moduleSource.indexOf('function savedKindHtml(');
  const rowEnd = moduleSource.indexOf('\nfunction bindSaved(', rowStart);
  const savedDeleteFlow = moduleSource.slice(rowStart, rowEnd);
  // Scoped to the new Saved-delete code (savedKindHtml..bindSaved) — the
  // legacy course/folder/file delete buttons elsewhere in this file already
  // use native confirm() and are out of scope for this feature.
  assert.doesNotMatch(savedDeleteFlow, /[^.]\bconfirm\(/);
  const row = savedDeleteFlow;
  assert.match(row, /class="ncb-saved-confirm" hidden/);
  assert.match(row, /class="ncb-saved-confirm-cancel"/);
  assert.match(row, /class="ncb-saved-confirm-delete"/);
  // The clicked item's title must be shown in the confirm text.
  assert.match(row, /Delete &ldquo;<b>\$\{escapeHtml\(item\.title\)\}<\/b>&rdquo;/);

  const bindStart = moduleSource.indexOf('function bindSaved(');
  const bindEnd = moduleSource.indexOf('\nfunction bindSavedLoadMore', bindStart);
  const bind = moduleSource.slice(bindStart, bindEnd);
  assert.match(bind, /'\.ncb-saved-delete'\)\?\.addEventListener\('click', \(ev\) => \{[\s\S]{0,80}setSavedRowConfirming\(row, true\)/);
  assert.match(bind, /ev\.key === 'Escape'[\s\S]{0,80}setSavedRowConfirming\(row, false\)/);
});

test('one dispatcher routes each kind to its own canonical deletion path — no raw API calls inline', () => {
  const dispatchStart = moduleSource.indexOf('async function deleteSavedItem(');
  const dispatchEnd = moduleSource.indexOf('\nfunction bindSaved(', dispatchStart);
  const dispatch = moduleSource.slice(dispatchStart, dispatchEnd);
  assert.match(dispatch, /case 'notes':\s*\n\s*case 'summaries':\s*\n\s*case 'cheatsheets': \{/);
  assert.match(dispatch, /await deleteNote\(noteId\)/);
  assert.match(dispatch, /case 'flashcards':\s*\n\s*return deleteRowById\('flashcard_decks', item\.id\)/);
  assert.match(dispatch, /case 'exams':\s*\n\s*return deleteRowById\('exam_sessions', item\.id\)/);
  assert.match(dispatch, /case 'responses': \{/);
  assert.match(dispatch, /return deleteSavedReplyById\(chatId, item\.id\)/);
  // No inline fetch/XHR to a raw REST/API path inside the dispatcher itself —
  // every branch must delegate to a named helper.
  assert.doesNotMatch(dispatch, /authenticatedFetch\(|authenticatedSupabaseFetch\(/);
});

test('Notes/Summaries/Cheatsheets deletion reuses deleteNote() and invalidates the course notes cache', () => {
  assert.match(moduleSource, /import \{ clearCourseDocumentCache, deleteNote, getNoteById, indexExistingDocument, invalidateCourseNotesCache,/);
  const dispatchStart = moduleSource.indexOf('async function deleteSavedItem(');
  const dispatchEnd = moduleSource.indexOf('\nfunction bindSaved(', dispatchStart);
  const dispatch = moduleSource.slice(dispatchStart, dispatchEnd);
  assert.match(dispatch, /invalidateCourseNotesCache\(item\.course\.id\)/);
});

test('deleting a Summary/Cheatsheet clears the minallo_(sum|cs)_last_<courseId> identity cache only when it points at the deleted note', () => {
  const fnStart = moduleSource.indexOf('function clearArtifactIdentityCacheIfMatches(');
  const fnEnd = moduleSource.indexOf('\n}', fnStart) + 2;
  const fn = moduleSource.slice(fnStart, fnEnd);
  assert.match(fn, /minallo_cs_last_/);
  assert.match(fn, /minallo_sum_last_/);
  assert.match(fn, /stored\?\.noteId === noteId/); // only clears on an exact match — never a different/newer artifact
  assert.match(fn, /localStorage\.removeItem\(key\)/);
  const dispatchStart = moduleSource.indexOf('async function deleteSavedItem(');
  const dispatchEnd = moduleSource.indexOf('\nfunction bindSaved(', dispatchStart);
  assert.match(moduleSource.slice(dispatchStart, dispatchEnd), /clearArtifactIdentityCacheIfMatches\(item\.kind, item\.course\.id, noteId\)/);
});

test('flashcard decks and practice exams delete the real flashcard_decks/exam_sessions row via the same authenticatedSupabaseFetch pattern this file already uses to read them', () => {
  const fnStart = moduleSource.indexOf('async function deleteRowById(');
  const fnEnd = moduleSource.indexOf('\n}', fnStart) + 2;
  const fn = moduleSource.slice(fnStart, fnEnd);
  assert.match(fn, /authenticatedSupabaseFetch\(/);
  assert.match(fn, /method: 'DELETE'/);
  assert.match(fn, /\/rest\/v1\/\$\{table\}\?id=eq\.\$\{encodeURIComponent\(id\)\}/);
});

test('AI response deletion goes through the canonical saved-reply system, not a separate localStorage-only removal', () => {
  assert.match(moduleSource, /import \{ deleteSavedReplyById \} from '\.\/shell\.js';/);
  const fnStart = shellSource.indexOf('export async function deleteSavedReplyById(');
  const fnEnd = shellSource.indexOf('\n}', fnStart) + 2;
  const fn = shellSource.slice(fnStart, fnEnd);
  // Awaits the real DELETE and only mutates local state / fires the shared
  // 'deleted' event AFTER the server confirms success.
  assert.match(fn, /method: 'DELETE'/);
  assert.match(fn, /if \(!response \|\| !response\.ok\) return false;/);
  assert.match(fn, /chat\.savedReplies = chat\.savedReplies\.filter/);
  assert.match(fn, /dispatchSavedReplyChanged\(\{ id, action: 'deleted' \}\)/);
  // The Saved panel already listens for this exact event to drop the id from
  // deletedResponseIds so it can never resurrect via the server-reconcile
  // merge in loadBookmarkedResponses.
  assert.match(moduleSource, /detail\?\.action === 'deleted' && changedId/);
});

test('a failed delete keeps the row, re-enables the confirm buttons, and reports an error — never a silent catch', () => {
  const fnStart = moduleSource.indexOf('async function runSavedDelete(');
  const fnEnd = moduleSource.indexOf('\nfunction bindSaved(', fnStart);
  const fn = moduleSource.slice(fnStart, fnEnd);
  assert.doesNotMatch(fn, /catch\s*\(\s*\)\s*\{\s*\}/); // no silent .catch(() => {})
  assert.match(fn, /console\.error\('\[saved-delete-error\]'/);
  assert.match(fn, /if \(!ok\) \{/);
  assert.match(fn, /deleteBtn\.disabled = false/);
  assert.match(fn, /cancelBtn\.disabled = false/);
  assert.match(fn, /showToast\?\.\('Could not delete'/);
  // Only on success does the item get spliced out of the in-memory list AND
  // the persisted Saved cache, and only then does the panel re-render.
  const successIdx = fn.indexOf('items.splice(index, 1)');
  const notOkIdx = fn.indexOf('if (!ok) {');
  assert.ok(successIdx > notOkIdx, 'items must not be mutated before the failure branch is checked');
});

test('a successful delete updates the in-memory list, the persisted Saved cache, and invalidates the server-backed cache', () => {
  const fnStart = moduleSource.indexOf('async function runSavedDelete(');
  const fnEnd = moduleSource.indexOf('\nfunction bindSaved(', fnStart);
  const fn = moduleSource.slice(fnStart, fnEnd);
  assert.match(fn, /items\.splice\(index, 1\)/);
  assert.match(fn, /state\.savedItems = state\.savedItems\.filter/);
  assert.match(fn, /persistStudyLibrary\(\)/);
  assert.match(fn, /invalidateSaved\(\)/);
  assert.match(fn, /renderSavedKind\(panel, root, items, allCourses, kind\)/);
});

test('the delete control is quiet until hover/focus on desktop but stays a comfortable touch target on mobile', () => {
  assert.match(css, /\.ncb-saved-row \.ncb-saved-delete \{[^}]*opacity:\s*0\.55/);
  assert.match(css, /\.ncb-saved-row:hover \.ncb-saved-delete,[\s\S]{0,80}opacity:\s*1/);
  assert.match(css, /@media \(hover: none\) \{[\s\S]{0,300}width:\s*36px/);
});

test('the row itself never turns red — only the delete icon/confirm bar do', () => {
  // .ncb-saved-row's own hover rule (shared with course/file rows) stays the
  // neutral blue tint; red only appears on .ncb-library-delete's hover state
  // and the confirm bar, both scoped to the delete control itself.
  const hoverBlock = css.slice(css.indexOf('.ncb-course-row:hover,'), css.indexOf('.ncb-course-row:hover,') + 250);
  assert.doesNotMatch(hoverBlock, /rgba\(1[25]\d, \d+, \d+/); // no red channel dominant in the shared row hover
  assert.match(css, /\.ncb-library-delete:hover \{ border-color: rgba\(248, 113, 113/);
});
