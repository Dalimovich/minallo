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
  page: number;
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
};

export function getActivePdfContext(): ActivePdfContext | null {
  const viewer = window as ViewerWindow;
  const documentId = String(viewer.activeRagDocumentId || '').trim();
  const courseId = String(viewer.activeCourseId || '').trim();
  const fileName = String(viewer.activeFileName || '').trim();
  const pdfDoc = viewer.pdfDoc;
  if (!documentId || !courseId || !fileName || !pdfDoc) return null;
  const visiblePage = Math.max(1, Number(viewer._pdfVisiblePage?.() || viewer.pdfPage || 1));
  const hasPageTextResult = Object.prototype.hasOwnProperty.call(viewer.pdfPageTexts || {}, visiblePage);
  const pageText = String(viewer.pdfPageTexts?.[visiblePage] || '').trim();
  const pageTextStatus: ActivePdfContext['pageTextStatus'] = viewer.pdfPageTextErrors?.[visiblePage]
    ? 'failed'
    : !hasPageTextResult
      ? 'loading'
      : pageText
        ? 'ready'
        : 'empty_scanned_page';
  const revision = String(viewer.activeDocumentRevision || '').trim() || undefined;
  const sourceFingerprint = String(viewer.activeSourceFingerprint || revision || '').trim() || undefined;
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
    viewerInstanceId: String(viewer._pdfOpenSeq || ''),
    pageText,
    pageTextStatus,
    selectedRegion: selected ? { ...selected, text: selection?.toString().trim() || undefined } : undefined,
  };
}

export function requiresVisualPdfEvidence(question: string, context: ActivePdfContext): boolean {
  return !!context.selectedRegion || context.pageTextStatus !== 'ready' || context.pageText.length < 500 || /\b(?:checked|checkbox|marked|green|arrow|diagram|drawing|figure|table|grid|option|formula|shown|visible|number\s+\d+|angekreuzt|markiert|pfeil|abbildung|zeichnung|tabelle|formel)\b/i.test(question);
}

export async function capturePdfPage(request: PdfPageCaptureRequest): Promise<OpenFileImage[]> {
  const context = getActivePdfContext();
  if (!context || context.documentId !== request.documentId) {
    throw new Error('active_document_changed');
  }
  const pdfDoc = window.pdfDoc as {
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
