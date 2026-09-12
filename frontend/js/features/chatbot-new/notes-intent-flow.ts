// Notes-intent orchestration, pulled out of shell.ts so the full two-turn
// "create a note -> which file? -> generate" flow can be exercised with
// plain dependency-injected mocks in the Node test runner (shell.ts itself
// can't be executed there — it's full of DOM/window/dynamic-import calls).
//
// This module owns the DECISION logic only (what file, whether to call
// generation, what text/state to return); shell.ts supplies the real
// window/course-data/network functions as `NotesFlowDeps` and is
// responsible for AbortSignal wiring and rendering the returned text.

import { resolveNotesFileNameFromText } from './notes-intent-resolver.js';

export interface PendingNotesAction {
  courseId: string;
  createdAt: number;
}

/** A course file resolved to its real indexed-document identity, when one
 *  exists. `documentId` is null (not just absent) when the file has no
 *  indexed document yet, or isn't indexed for RAG chunk retrieval — the
 *  caller must fall back to raw text extraction in that case. */
export interface ResolvedNotesDocument {
  documentId: string | null;
  ready: boolean;
}

export interface NotesGenerateResult {
  error?: unknown;
  note?: { id: string | null; content_markdown?: string };
}

export interface NotesFlowDeps {
  /** Course PDF filenames available for notes (fast/synchronous — used only
   *  to match free-text replies against, not to resolve a documentId). */
  getCourseFiles: (courseId: string) => string[];
  /** Resolves a filename to its indexed document identity, if any. */
  resolveDocument: (courseId: string, fileName: string) => Promise<ResolvedNotesDocument>;
  /** Raw-text fallback when no ready indexed document exists. */
  extractPdfText: (fileName: string, maxPages: number) => Promise<string>;
  generateNotes: (
    courseId: string,
    opts: { fileName: string; documentId: string | null; pdfText: string }
  ) => Promise<NotesGenerateResult>;
  /** Called once generation succeeds and is actually persisted — clears the
   *  Notes list cache and tells the Saved panel to refresh. */
  onNoteSaved: (courseId: string) => void;
  /** Optional: fired the moment a file is resolved, before document
   *  resolution/generation begins — lets the caller show a "Reading X…"
   *  progress message without this module knowing about rendering at all. */
  onFileResolved?: (fileName: string) => void;
}

export interface NotesFlowInput {
  courseId: string;
  /** The latest user message text (a bare filename reply, a full command
   *  like "make notes from X", or an unrelated message while a Notes
   *  clarification is pending). */
  latestText: string;
  pendingNotesAction: PendingNotesAction | null;
  now: number;
  ttlMs: number;
  /** An explicit source resolved for THIS turn's command (route.sourcePhrase,
   *  an explicitly selected Course file, or the currently open PDF) — tried
   *  before falling back to "only file in the course". Not used while a
   *  pending clarification reply is being resolved. */
  explicitCandidate?: string;
}

export interface NotesFlowOutcome {
  /** Empty string + generationAttempted:false means "not a notes reply at
   *  all" — the caller should silently fall through to normal routing
   *  instead of rendering anything. */
  text: string;
  fileName?: string;
  noteId?: string | null;
  pendingNotesAction: PendingNotesAction | null;
  generationAttempted: boolean;
}

/** Only extracted for a file with no indexed/ready document — generous
 *  enough that a real lecture is never silently truncated (the old fixed
 *  cap of 20 pages was the exact bug reported: a 70-page lecture would
 *  generate notes from pages 1-20 only, with no indication anything was
 *  cut off). This is a client-side safety ceiling for raw extraction, not a
 *  content limit — the indexed/chunk path above has no page cap at all. */
export const NOTES_FALLBACK_MAX_PAGES = 500;

const CLARIFY_NO_FILES =
  'I can make notes from a course file. Open the source you want, then ask "make notes from this lecture".';

function clarifyText(files: string[]): string {
  return files.length
    ? 'Which file should I make notes from?\n\n' +
      files.slice(0, 8).map((n) => '• ' + n).join('\n') +
      '\n\nOpen the file you want, then ask me again — e.g. "make notes from this lecture".'
    : CLARIFY_NO_FILES;
}

/** Runs one turn of the Notes flow: resolves a source file (from a pending
 *  clarification reply, an explicit command, or the course's only file),
 *  asks for clarification when still ambiguous, and otherwise generates and
 *  persists the note. Never falls through to a generic chat answer for a
 *  turn it recognises as notes-related. */
export async function runNotesFlow(input: NotesFlowInput, deps: NotesFlowDeps): Promise<NotesFlowOutcome> {
  const pending = input.pendingNotesAction;
  const pendingFresh = !!pending && input.now - pending.createdAt < input.ttlMs;
  const files = deps.getCourseFiles(input.courseId);

  let fileName: string | null = null;
  if (pendingFresh) {
    fileName = resolveNotesFileNameFromText(files, input.latestText);
    if (!fileName) {
      // Doesn't look like a file selection — abandon the pending flow
      // rather than trap every later message as a failed notes reply.
      return { text: '', pendingNotesAction: null, generationAttempted: false };
    }
  } else {
    if (input.explicitCandidate) fileName = resolveNotesFileNameFromText(files, input.explicitCandidate);
    if (!fileName && files.length === 1) fileName = files[0] ?? null;
  }

  if (!fileName) {
    return {
      text: clarifyText(files),
      pendingNotesAction: { courseId: input.courseId, createdAt: input.now },
      generationAttempted: false,
    };
  }

  deps.onFileResolved?.(fileName);
  const doc = await deps.resolveDocument(input.courseId, fileName);
  const pdfText = doc.documentId && doc.ready
    ? ''
    : (await deps.extractPdfText(fileName, NOTES_FALLBACK_MAX_PAGES)).replace(/^=== .*? ===\n/, '');

  const result = await deps.generateNotes(input.courseId, { fileName, documentId: doc.documentId, pdfText });
  if (result.error === 'persist_failed') {
    return {
      text: 'I generated the notes for ' + fileName + ', but they could not be saved. Please try again.',
      fileName, pendingNotesAction: null, generationAttempted: true,
    };
  }
  if (result.error || !result.note?.content_markdown || !result.note?.id) {
    return {
      text: 'I could not generate notes from ' + fileName + ' right now. Please try again from the Notes tab.',
      fileName, pendingNotesAction: null, generationAttempted: true,
    };
  }

  deps.onNoteSaved(input.courseId);
  return {
    text: 'Notes from ' + fileName + ' (saved to your Notes tab):\n\n' + result.note.content_markdown,
    fileName, noteId: result.note.id, pendingNotesAction: null, generationAttempted: true,
  };
}
