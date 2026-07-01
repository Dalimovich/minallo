// Document Understanding Layer — UI badge + correction helper (Stage 4).
//
// Renders the "Detected source type: Exam · Confidence: High" badge from the
// fields /api/documents/list now returns (effective_document_type,
// document_type_confidence, user_document_type_override), and — when the
// classifier is unsure and the user hasn't corrected it — a "Source type
// uncertain. Please choose:" selector that POSTs to /api/documents/set-type.
//
// Framework-agnostic: pure functions return HTML strings + small wiring helpers,
// so this drops into any file list, source picker, or the PDF drawer.

export interface DocUnderstanding {
  id?: string;
  effective_document_type?: string | null;
  document_type?: string | null;
  document_type_confidence?: number | null;
  user_document_type_override?: string | null;
}

// Below this the classifier guess is "uncertain" → surface the correction UI.
export const LOW_CONFIDENCE = 0.65;

// Backend vocabulary → UI label. cheat_sheet/formula_sheet share one label.
export const TYPE_LABEL: Record<string, string> = {
  exam: 'Exam',
  lecture: 'Lecture',
  slides: 'Slides',
  textbook_chapter: 'Textbook chapter',
  exercise_sheet: 'Exercise',
  assignment: 'Assignment',
  solution_sheet: 'Solution',
  summary: 'Summary',
  cheat_sheet: 'Cheat sheet / Formula sheet',
  formula_sheet: 'Cheat sheet / Formula sheet',
  unknown: 'Unknown',
};

// The choices offered in the correction selector (deduped labels).
export const CORRECTION_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'exam', label: 'Exam' },
  { value: 'lecture', label: 'Lecture' },
  { value: 'slides', label: 'Slides' },
  { value: 'textbook_chapter', label: 'Textbook chapter' },
  { value: 'exercise_sheet', label: 'Exercise' },
  { value: 'assignment', label: 'Assignment' },
  { value: 'solution_sheet', label: 'Solution' },
  { value: 'summary', label: 'Summary' },
  { value: 'formula_sheet', label: 'Cheat sheet / Formula sheet' },
];

export interface BadgeMeta {
  type: string;
  label: string;
  confidence: number;
  confidenceLabel: 'High' | 'Medium' | 'Low' | '';
  userSet: boolean;
  needsReview: boolean;
}

function esc(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function documentTypeMeta(doc: DocUnderstanding): BadgeMeta {
  const userSet = !!doc.user_document_type_override;
  const type =
    (doc.effective_document_type as string) ||
    (doc.user_document_type_override as string) ||
    (doc.document_type as string) ||
    'unknown';
  const conf = typeof doc.document_type_confidence === 'number' ? doc.document_type_confidence : 0;
  let confidenceLabel: BadgeMeta['confidenceLabel'] = '';
  if (!userSet && type !== 'unknown') {
    confidenceLabel = conf >= 0.85 ? 'High' : conf >= LOW_CONFIDENCE ? 'Medium' : 'Low';
  }
  // Needs review when the classifier is unsure / unknown AND the user hasn't set it.
  const needsReview = !userSet && (type === 'unknown' || conf < LOW_CONFIDENCE);
  return { type, label: TYPE_LABEL[type] || type, confidence: conf, confidenceLabel, userSet, needsReview };
}

/** Inline badge, e.g. `Detected source type: Exam · Confidence: High` (or
 *  `Source type: Exam (you set this)` after a correction). */
export function badgeHtml(doc: DocUnderstanding): string {
  const m = documentTypeMeta(doc);
  if (m.userSet) {
    return (
      '<span class="doc-type-badge doc-type-' + esc(m.type) + ' is-userset" ' +
      'title="You set this source type">Source type: ' + esc(m.label) + ' (you set this)</span>'
    );
  }
  const conf = m.confidenceLabel ? ' · Confidence: ' + m.confidenceLabel : '';
  return (
    '<span class="doc-type-badge doc-type-' + esc(m.type) +
    (m.needsReview ? ' is-uncertain' : '') + '">' +
    'Detected source type: ' + esc(m.label) + esc(conf) + '</span>'
  );
}

/** Low-confidence correction selector. Returns '' when no review is needed. */
export function correctionSelectHtml(doc: DocUnderstanding): string {
  const m = documentTypeMeta(doc);
  if (!m.needsReview || !doc.id) return '';
  const opts = CORRECTION_CHOICES.map(
    (c) => '<option value="' + esc(c.value) + '">' + esc(c.label) + '</option>'
  ).join('');
  return (
    '<div class="doc-type-review" data-doc-id="' + esc(doc.id) + '">' +
    '<span class="doc-type-review-label">Source type uncertain. Please choose:</span> ' +
    '<select class="doc-type-select" aria-label="Correct source type">' +
    '<option value="">—</option>' + opts + '</select>' +
    '</div>'
  );
}

/** POST the user's correction to /api/documents/set-type. */
export async function setDocumentTypeOverride(
  documentId: string,
  documentType: string | null,
  opts?: { backendUrl?: string; token?: string }
): Promise<{ effectiveDocumentType: string } | null> {
  const w = window as unknown as { BACKEND_URL?: string; _sbToken?: string };
  const base = opts?.backendUrl ?? w.BACKEND_URL ?? '';
  const token = opts?.token ?? w._sbToken ?? '';
  try {
    const r = await fetch(base + '/api/documents/set-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ documentId, documentType }),
    });
    if (!r.ok) return null;
    return (await r.json()) as { effectiveDocumentType: string };
  } catch {
    return null;
  }
}

export interface RowDoc extends DocUnderstanding {
  file_name?: string;
  fileName?: string;
  processing_status?: string;
}

/** Decorate already-rendered `.co-file[data-fname]` rows with the source-type
 *  badge + (when uncertain) the correction selector, matching docs by file name.
 *  Purely additive and self-contained — never throws into the caller. */
export function decorateFileTypeBadges(
  root: ParentNode,
  docs: RowDoc[],
  onApplied?: (documentId: string, effectiveType: string) => void
): void {
  if (typeof document === 'undefined') return;
  try {
    const byName = new Map<string, RowDoc>();
    for (const d of docs || []) {
      const n = (d.file_name || d.fileName || '').toLowerCase();
      if (n) byName.set(n, d);
    }
    root.querySelectorAll<HTMLElement>('.co-file[data-fname]').forEach((row) => {
      const fname = (row.getAttribute('data-fname') || '').toLowerCase();
      const doc = byName.get(fname);
      if (!doc || doc.processing_status !== 'ready') return;
      if (row.querySelector('.co-file-doctype')) return; // already decorated
      const textEl = row.querySelector('.co-file-text');
      if (!textEl) return;
      const wrap = document.createElement('div');
      wrap.className = 'co-file-doctype';
      wrap.innerHTML = badgeHtml(doc) + correctionSelectHtml(doc);
      textEl.appendChild(wrap);
    });
    wireCorrectionSelectors(root, (documentId, effectiveType) => {
      const review = root.querySelector('.doc-type-review[data-doc-id="' + documentId + '"]');
      const wrap = review?.closest('.co-file-doctype');
      if (wrap) {
        wrap.innerHTML = badgeHtml({
          id: documentId,
          effective_document_type: effectiveType,
          user_document_type_override: effectiveType,
        });
      }
      if (onApplied) onApplied(documentId, effectiveType);
    });
  } catch {
    /* badges are additive — never break the file list */
  }
}

/** Wire change-handlers for any correction selectors inside `root`. On a choice
 *  it persists the override and calls `onApplied` so the list can refresh. */
export function wireCorrectionSelectors(
  root: ParentNode,
  onApplied?: (documentId: string, effectiveType: string) => void
): void {
  root.querySelectorAll<HTMLSelectElement>('.doc-type-review .doc-type-select').forEach((sel) => {
    if ((sel as unknown as { _dtBound?: boolean })._dtBound) return;
    (sel as unknown as { _dtBound?: boolean })._dtBound = true;
    sel.addEventListener('change', async () => {
      const wrap = sel.closest('.doc-type-review') as HTMLElement | null;
      const docId = wrap?.getAttribute('data-doc-id');
      const value = sel.value;
      if (!docId || !value) return;
      sel.disabled = true;
      const res = await setDocumentTypeOverride(docId, value);
      sel.disabled = false;
      if (res && onApplied) onApplied(docId, res.effectiveDocumentType || value);
    });
  });
}
