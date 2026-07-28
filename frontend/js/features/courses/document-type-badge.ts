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
  { value: 'unknown', label: 'Unknown' },
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

function typeOptions(selected: string): string {
  return CORRECTION_CHOICES.map(
    (choice) => '<option value="' + esc(choice.value) + '"' +
      (choice.value === selected ? ' selected' : '') + '>' + esc(choice.label) + '</option>'
  ).join('');
}

function editorHtml(doc: DocUnderstanding, editing = false): string {
  const m = documentTypeMeta(doc);
  const detected = doc.document_type || 'unknown';
  return (
    '<div class="doc-type-review' + (editing ? ' is-editing' : '') + '" data-doc-id="' + esc(doc.id || '') +
    '" data-detected-type="' + esc(detected) + '" data-effective-type="' + esc(m.type) + '">' +
    '<label class="doc-type-review-label" for="doc-type-' + esc(doc.id || '') + '">File type</label>' +
    '<select id="doc-type-' + esc(doc.id || '') + '" class="doc-type-select study-file-type-select" data-action="change-file-type" aria-label="File type for this document" ' +
    'title="Detected type: ' + esc(TYPE_LABEL[detected] || detected) + '. This affects retrieval.">' +
    typeOptions(m.type) + '<option value="__detected__">Use detected type (' +
    esc(TYPE_LABEL[detected] || detected) + ')</option></select>' +
    '<button type="button" class="doc-type-action doc-type-save" data-doc-type-save>' + (editing ? 'Save' : 'Confirm') + '</button>' +
    (editing ? '<button type="button" class="doc-type-action doc-type-cancel" data-doc-type-cancel>Cancel</button>' : '') +
    '</div>'
  );
}

function confirmedHtml(doc: DocUnderstanding): string {
  const m = documentTypeMeta(doc);
  const detected = doc.document_type || 'unknown';
  return '<div class="doc-type-confirmed" data-doc-id="' + esc(doc.id || '') +
    '" data-detected-type="' + esc(detected) + '" data-effective-type="' + esc(m.type) + '">' +
    '<span class="doc-type-fixed doc-type-' + esc(m.type) + '">' + esc(m.label) + '</span>' +
    '<button type="button" class="doc-type-action doc-type-edit" data-doc-type-edit aria-label="Edit file type">Edit</button>' +
    '</div>';
}

/** Unconfirmed files show a picker + Confirm; confirmed overrides show a fixed badge + Edit. */
export function correctionSelectHtml(doc: DocUnderstanding): string {
  if (!doc.id) return '';
  return documentTypeMeta(doc).userSet ? confirmedHtml(doc) : editorHtml(doc);
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

/** Match storage-file names and document rows consistently, including legacy
 * rows that retained a folder prefix or encoded filename. */
export function normalizeDocumentFileName(value: string | null | undefined): string {
  let name = String(value || '').trim();
  try { name = decodeURIComponent(name); } catch { /* keep the original text */ }
  name = name.replace(/\\/g, '/').split('/').pop() || name;
  return name.normalize('NFKC').trim().toLocaleLowerCase();
}

function unavailablePickerHtml(): string {
  return '<label class="doc-type-review doc-type-review--unavailable">' +
    '<span class="doc-type-review-label">File type</span>' +
    '<select class="doc-type-select study-file-type-select" data-action="change-file-type" aria-label="File type unavailable for this document" ' +
    'title="File type metadata is not available yet" disabled>' +
    '<option selected>Unknown</option></select></label>';
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
      const n = normalizeDocumentFileName(d.file_name || d.fileName);
      if (n) byName.set(n, d);
    }
    root.querySelectorAll<HTMLElement>('.co-file[data-fname]').forEach((row) => {
      const fname = normalizeDocumentFileName(row.getAttribute('data-fname'));
      const doc = byName.get(fname);
      if (!doc) return;
      if (row.querySelector('.co-file-doctype')) return; // already decorated
      const textEl = row.querySelector('.co-file-text');
      if (!textEl) return;
      const wrap = document.createElement('div');
      wrap.className = 'co-file-doctype';
      wrap.innerHTML = badgeHtml(doc) + correctionSelectHtml(doc);
      textEl.appendChild(wrap);
    });
    root.querySelectorAll<HTMLElement>('[data-file-type-slot]').forEach((slot) => {
      const fname = normalizeDocumentFileName(slot.getAttribute('data-file-type-slot'));
      const doc = byName.get(fname);
      if (slot.querySelector('.doc-type-select:not([disabled])')) return;
      slot.innerHTML = doc
        ? badgeHtml(doc) + correctionSelectHtml(doc)
        : unavailablePickerHtml();
    });
    wireCorrectionSelectors(root, (documentId, effectiveType) => {
      const review = root.querySelector('.doc-type-review[data-doc-id="' + documentId + '"]');
      const wrap = review?.closest('.co-file-doctype');
      if (wrap) {
        const doc = docs.find((item) => item.id === documentId);
        if (doc) {
          doc.effective_document_type = effectiveType;
          doc.user_document_type_override = effectiveType;
          const badge = wrap.querySelector('.doc-type-badge');
          if (badge) badge.outerHTML = badgeHtml(doc);
        }
      }
      if (onApplied) onApplied(documentId, effectiveType);
    });
  } catch {
    /* badges are additive — never break the file list */
  }
}

/** Wire the explicit Confirm/Edit/Save/Cancel lifecycle. Selecting alone never persists. */
export function wireCorrectionSelectors(
  root: ParentNode,
  onApplied?: (documentId: string, effectiveType: string) => void
): void {
  const stop = (element: HTMLElement): void => {
    for (const eventName of ['click', 'pointerdown', 'mousedown'] as const) {
      element.addEventListener(eventName, (event) => event.stopPropagation());
    }
  };
  root.querySelectorAll<HTMLElement>('.doc-type-review, .doc-type-confirmed').forEach((control) => {
    if ((control as unknown as { _dtBound?: boolean })._dtBound) return;
    (control as unknown as { _dtBound?: boolean })._dtBound = true;
    control.querySelectorAll<HTMLElement>('select, button').forEach(stop);
    const docId = control.dataset.docId || '';
    const detectedType = control.dataset.detectedType || 'unknown';
    const effectiveType = control.dataset.effectiveType || detectedType;
    control.querySelector<HTMLButtonElement>('[data-doc-type-edit]')?.addEventListener('click', () => {
      control.outerHTML = editorHtml({ id: docId, document_type: detectedType, effective_document_type: effectiveType, user_document_type_override: effectiveType }, true);
      wireCorrectionSelectors(root, onApplied);
      root.querySelector<HTMLSelectElement>('.doc-type-review[data-doc-id="' + docId + '"] .doc-type-select')?.focus();
    });
    const cancel = (): void => {
      control.outerHTML = confirmedHtml({ id: docId, document_type: detectedType, effective_document_type: effectiveType, user_document_type_override: effectiveType });
      wireCorrectionSelectors(root, onApplied);
    };
    control.querySelector<HTMLButtonElement>('[data-doc-type-cancel]')?.addEventListener('click', cancel);
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && control.classList.contains('is-editing')) cancel();
    });
    control.querySelector<HTMLButtonElement>('[data-doc-type-save]')?.addEventListener('click', async () => {
      const select = control.querySelector<HTMLSelectElement>('.doc-type-select');
      const save = control.querySelector<HTMLButtonElement>('[data-doc-type-save]');
      if (!select || !save || !docId) return;
      const requested = select.value;
      const resetToDetected = requested === '__detected__';
      select.disabled = true;
      save.disabled = true;
      try {
        const res = await setDocumentTypeOverride(docId, resetToDetected ? null : requested);
        if (!res) throw new Error('save failed');
        const nextDoc = { id: docId, document_type: detectedType, effective_document_type: res.effectiveDocumentType,
          user_document_type_override: resetToDetected ? null : requested };
        control.outerHTML = resetToDetected ? editorHtml(nextDoc) : confirmedHtml(nextDoc);
        wireCorrectionSelectors(root, onApplied);
        if (onApplied) onApplied(docId, res.effectiveDocumentType);
        window.dispatchEvent(new CustomEvent('minallo:document-type-changed', {
          detail: { documentId: docId, effectiveDocumentType: res.effectiveDocumentType },
        }));
      } catch {
        select.disabled = false;
        save.disabled = false;
        const w = window as unknown as { showToast?: (title: string, message: string) => void };
        w.showToast?.('Could not update the file type.', 'Your selection was kept. Please retry.');
      }
    });
  });
}
