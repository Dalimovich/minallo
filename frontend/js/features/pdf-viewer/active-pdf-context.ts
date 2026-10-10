import { regionFromSelection, type StableRegionProvenance } from '../ai-chat/region-provenance.js';

export interface ActivePdfContext {
  courseId: string;
  documentId: string;
  fileName: string;
  visiblePage: number;
  pageCount: number;
  documentRevision?: string;
  sourceFingerprint?: string;
  viewerInstanceId?: string;
  pageText: string;
  pageTextStatus: 'ready' | 'loading' | 'empty_scanned_page' | 'failed';
  selectedRegion?: StableRegionProvenance & { text?: string };
}

export interface PdfPageCaptureRequest {
  documentId: string;
  page: number;
  format: 'image/png';
  includeFullPage: boolean;
}

export interface OpenFileImage {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
  page?: number;
  region: 'full_page' | 'selected_region' | 'formula_area' | 'drawing_area' | 'answer_grid';
}

export interface ChatGroundingSnapshot {
  capturedAt: number;
  courseId: string | null;
  activeDocument: ActivePdfContext | null;
  selectedRegion?: ActivePdfContext['selectedRegion'];
  images: OpenFileImage[];
  visualEvidenceExpected: boolean;
  sourceScope: 'active_document' | 'selected_documents' | 'whole_course' | 'general';
}

export type PdfSnapshotResult =
  | { status: 'captured'; snapshot: ChatGroundingSnapshot }
  | { status: 'no_active_pdf' }
  | { status: 'unstable'; lastDocumentId?: string; lastPage?: number }
  | { status: 'capture_failed'; reason: string };

type ViewerWindow = Window & {
  activeRagDocumentId?: string | null;
  activeDocumentRevision?: string | null;
  activeSourceFingerprint?: string | null;
  pdfPageTexts?: Record<number, string>;
  pdfPageTextErrors?: Record<number, boolean>;
  _pdfOpenSeq?: number;
  __minalloPdfViewerState?: MinalloPdfViewerState;
};

export interface MinalloPdfViewerState {
  courseId: string | null;
  documentId: string | null;
  fileName: string | null;
  pdfDoc: Window['pdfDoc'] | null;
  visiblePage: number;
  pageTexts: Record<number, string>;
  pageTextErrors: Record<number, boolean>;
  revision?: string;
  fingerprint?: string;
  openSequence: number;
}

export function setActivePdfViewerState(update: Partial<MinalloPdfViewerState>): MinalloPdfViewerState {
  const viewer = window as ViewerWindow;
  const current = viewer.__minalloPdfViewerState || {
    courseId: null, documentId: null, fileName: null, pdfDoc: null,
    visiblePage: 1, pageTexts: {}, pageTextErrors: {}, openSequence: 0
  };
  const next = { ...current, ...update };
  viewer.__minalloPdfViewerState = next;
  viewer.activeCourseId = next.courseId;
  viewer.activeRagDocumentId = next.documentId;
  viewer.activeFileName = next.fileName;
  viewer.pdfDoc = next.pdfDoc;
  viewer.pdfPage = next.visiblePage;
  viewer.pdfPageTexts = next.pageTexts;
  viewer.pdfPageTextErrors = next.pageTextErrors;
  viewer.activeDocumentRevision = next.revision || null;
  viewer.activeSourceFingerprint = next.fingerprint || null;
  viewer._pdfOpenSeq = next.openSequence;
  return next;
}

export function clearActivePdfViewerState(openSequence = Number(window._pdfOpenSeq || 0)): void {
  setActivePdfViewerState({
    courseId: null, documentId: null, fileName: null, pdfDoc: null,
    visiblePage: 1, pageTexts: {}, pageTextErrors: {},
    revision: undefined, fingerprint: undefined, openSequence
  });
}

export function validateActivePdfViewerState(): boolean {
  const viewer = window as ViewerWindow;
  const state = viewer.__minalloPdfViewerState;
  const visiblyOpen = isPdfViewerVisible();
  const complete = !!(
    state?.courseId && state.documentId && state.fileName && state.pdfDoc
  );
  if (visiblyOpen && !complete) {
    console.warn('active_pdf_state_incomplete', {
      courseId: state?.courseId || null,
      documentId: state?.documentId || null,
      fileName: state?.fileName || null,
      hasPdfDoc: !!state?.pdfDoc
    });
  }
  return complete;
}

export function isPdfViewerVisible(): boolean {
  const view = document.getElementById('pdfView');
  return !!view && !view.hidden && getComputedStyle(view).display !== 'none';
}

export function getActivePdfContext(): ActivePdfContext | null {
  const viewer = window as ViewerWindow;
  validateActivePdfViewerState();
  const state = viewer.__minalloPdfViewerState;
  const documentId = String(state?.documentId || '').trim();
  const courseId = String(state?.courseId || '').trim();
  const fileName = String(state?.fileName || '').trim();
  const pdfDoc = state?.pdfDoc;
  if (!documentId || !courseId || !fileName || !pdfDoc) return null;
  const visiblePage = Math.max(1, Number(viewer._pdfVisiblePage?.() || viewer.pdfPage || 1));
  const hasPageTextResult = Object.prototype.hasOwnProperty.call(state?.pageTexts || {}, visiblePage);
  const pageText = String(state?.pageTexts?.[visiblePage] || '').trim();
  const pageTextStatus: ActivePdfContext['pageTextStatus'] = state?.pageTextErrors?.[visiblePage]
    ? 'failed'
    : !hasPageTextResult
      ? 'loading'
      : pageText
        ? 'ready'
        : 'empty_scanned_page';
  const revision = String(state?.revision || '').trim() || undefined;
  const sourceFingerprint = String(state?.fingerprint || revision || '').trim() || undefined;
  const selection = window.getSelection?.() || null;
  const selected = regionFromSelection(
    selection,
    document.getElementById('pdfViewerWrap'),
    revision || '',
  );
  return {
    courseId,
    documentId,
    fileName,
    visiblePage,
    pageCount: Number(pdfDoc.numPages || 0),
    documentRevision: revision,
    sourceFingerprint,
    viewerInstanceId: String(state?.openSequence || ''),
    pageText,
    pageTextStatus,
    selectedRegion: selected ? { ...selected, text: selection?.toString().trim() || undefined } : undefined,
  };
}

const VISUAL_EVIDENCE_KEYWORD_RE = /\b(?:checked|checkbox|marked|green|arrow|diagram|drawing|figure|table|grid|option|formula|shown|visible|number\s+\d+|angekreuzt|markiert|pfeil|abbildung|zeichnung|tabelle|formel)\b/i;

export function requiresVisualPdfEvidence(question: string, context: ActivePdfContext): boolean {
  // An explicit visual keyword ("Welche Antwort ist angekreuzt?") always needs
  // the page image, even though it also reads as a self-contained "?"
  // question — checking this BEFORE the self-contained short-circuit below is
  // the whole point: that short-circuit exists for ordinary self-answerable
  // questions ("how many steps are necessary?"), not for questions that ask
  // about something only visible on the rendered page.
  if (VISUAL_EVIDENCE_KEYWORD_RE.test(question)) return true;
  if (isSelfContainedExplicitQuestionRequest(question)) return false;
  const sectionExtraction = /\b(?:all|every|alle|jede[nrsm]?|sämtliche)\b[\s\S]*\b(?:questions?|fragen|kurzfragen|aufgaben)\b/i.test(question)
    && /\b\d+\s*\.\s*(?:kurzfragen?|fragen|questions?|aufgaben)\b/i.test(question);
  return sectionExtraction || !!context.selectedRegion || context.pageTextStatus !== 'ready' || context.pageText.length < 500;
}

const EXPLICIT_VISUAL_REFERENCE_RE = /\b(?:this|that)\s+(?:image|page|diagram|figure|table|marked question|highlighted area|selection)|\b(?:explain|show|read)\s+this\b|\b(?:dieses|diese|dieser)\s+(?:bild|seite|abbildung|diagramm|tabelle)|\b(?:die\s+)?markierte(?:n|r|s)?\s+(?:aufgabe|frage|bereich)|\b(?:der\s+)?markierte(?:n|r|s)?\s+bereich|\b(?:erkl[aä]re|lies|zeige)\s+(?:mir\s+)?das\s+hier\b/i;

export function isSelfContainedExplicitQuestionRequest(question: string): boolean {
  const questionCount = (question.match(/\?/g) || []).length;
  return questionCount > 0 && !EXPLICIT_VISUAL_REFERENCE_RE.test(question);
}

export function currentMessageUsesSelectedRegion(question: string): boolean {
  return !isSelfContainedExplicitQuestionRequest(question)
    && EXPLICIT_VISUAL_REFERENCE_RE.test(question);
}

export async function capturePdfPage(request: PdfPageCaptureRequest): Promise<OpenFileImage[]> {
  const context = getActivePdfContext();
  if (!context || context.documentId !== request.documentId) {
    throw new Error('active_document_changed');
  }
  const pdfDoc = (window as ViewerWindow).__minalloPdfViewerState?.pdfDoc as {
    getPage?: (page: number) => Promise<{
      getViewport: (options: { scale: number }) => { width: number; height: number };
      render: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<unknown> };
    }>;
  } | null | undefined;
  if (!pdfDoc?.getPage) throw new Error('pdf_renderer_unavailable');
  const page = await pdfDoc.getPage(request.page);
  let scale = 2.4;
  let viewport = page.getViewport({ scale });
  const maxPixels = 6_000_000;
  if (viewport.width * viewport.height > maxPixels) {
    scale *= Math.sqrt(maxPixels / (viewport.width * viewport.height));
    viewport = page.getViewport({ scale });
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) throw new Error('canvas_unavailable');
  await page.render({ canvasContext, viewport }).promise;
  const data = canvas.toDataURL(request.format).split(',')[1] || '';
  if (!data) throw new Error('page_capture_empty');
  return request.includeFullPage ? [{
    mediaType: request.format,
    data,
    page: request.page,
    region: 'full_page',
  }] : [];
}

export async function captureCurrentPdfEvidence(
  context: ActivePdfContext,
  question: string,
): Promise<OpenFileImage[]> {
  if (!requiresVisualPdfEvidence(question, context)) return [];
  return capturePdfPage({
    documentId: context.documentId,
    page: context.visiblePage,
    format: 'image/png',
    includeFullPage: true,
  });
}

function sameViewerPage(a: ActivePdfContext | null, b: ActivePdfContext | null): boolean {
  return !!a && !!b
    && a.documentId === b.documentId
    && a.visiblePage === b.visiblePage
    && a.documentRevision === b.documentRevision
    && a.viewerInstanceId === b.viewerInstanceId;
}

export async function captureStablePdfSnapshot(
  question: string,
  sourceScope: ChatGroundingSnapshot['sourceScope'],
): Promise<PdfSnapshotResult> {
  let lastContext: ActivePdfContext | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = getActivePdfContext();
    if (!before) return { status: 'no_active_pdf' };
    lastContext = before;
    const visualEvidenceExpected = requiresVisualPdfEvidence(question, before);
    let images: OpenFileImage[];
    try {
      images = await captureCurrentPdfEvidence(before, question);
    } catch (error) {
      return {
        status: 'capture_failed',
        reason: error instanceof Error ? error.message : 'unknown_capture_failure',
      };
    }
    const after = getActivePdfContext();
    if (sameViewerPage(before, after)) return {
      status: 'captured',
      snapshot: {
        capturedAt: Date.now(), courseId: before.courseId, activeDocument: before,
        selectedRegion: before.selectedRegion, images, visualEvidenceExpected, sourceScope,
      },
    };
  }
  return {
    status: 'unstable',
    lastDocumentId: lastContext?.documentId,
    lastPage: lastContext?.visiblePage,
  };
}
