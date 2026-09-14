// Pure Notes-intent source resolution, split out of shell.ts so it can be
// unit-tested directly (shell.ts's DOM/window dependencies make it
// unexecutable in the plain Node test runner this repo uses).

export interface NotesRouteInfo {
  explicitSourceReference: boolean;
  sourcePhrase?: string;
}

export interface NotesCourseSource {
  id: string;
  courseId: string;
  documents: Array<{ name: string }>;
}

export interface NotesActivePdf {
  courseId: string;
  fileName: string;
}

/** Matches a free-text reply (a bare filename, "make notes from X", or a
 *  filename typed with minor punctuation/case differences) against the
 *  course's actual file list. Exact match (with/without extension) wins;
 *  otherwise falls back to a substring match in either direction so close
 *  paraphrases of a long filename still resolve. */
export function resolveNotesFileNameFromText(files: string[], text: string): string | null {
  const norm = (s: string): string => s.toLowerCase().trim().replace(/^["'*_\s]+|["'*_\s]+$/g, '');
  const t = norm(text);
  if (!t) return null;
  for (const f of files) {
    const fn = norm(f);
    if (t === fn || t === fn.replace(/\.pdf$/, '')) return f;
  }
  for (const f of files) {
    const fnNoExt = norm(f).replace(/\.pdf$/, '');
    if (fnNoExt.length > 3 && (t.includes(fnNoExt) || fnNoExt.includes(t))) return f;
  }
  return null;
}

/** Source priority for a fresh "make notes…" command (before any pending
 *  clarification exists): an explicit filename the user named beats an
 *  explicitly selected Course file, which beats whatever PDF is currently
 *  open. Returns raw text to resolve against the file list — not a filename
 *  itself, since e.g. route.sourcePhrase can be loosely worded. */
export function pickExplicitNotesCandidate(
  route: NotesRouteInfo,
  selectedSourceIds: string[],
  sourceLibraryItems: NotesCourseSource[],
  activePdf: NotesActivePdf | null,
  courseId: string
): string | undefined {
  if (
    route.explicitSourceReference && route.sourcePhrase &&
    !/^(?:open_document|this (?:pdf|document)|current page|whole course)$/i.test(route.sourcePhrase)
  ) {
    return route.sourcePhrase;
  }
  if (selectedSourceIds.length) {
    const docs = sourceLibraryItems
      .filter((item) => selectedSourceIds.includes(item.id) && item.courseId === courseId)
      .flatMap((item) => item.documents || []);
    if (docs.length === 1 && docs[0]?.name) return docs[0].name;
  }
  if (activePdf?.courseId === courseId && activePdf.fileName) return activePdf.fileName;
  return undefined;
}
