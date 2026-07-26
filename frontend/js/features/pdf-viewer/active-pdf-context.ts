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
  selectedRegion?: StableRegionProvenance & { text?: string };
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

type ViewerWindow = Window & {
  activeRagDocumentId?: string | null;
  activeDocumentRevision?: string | null;
  activeSourceFingerprint?: string | null;
  pdfPageTexts?: Record<number, string>;
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
  const pageText = String(viewer.pdfPageTexts?.[visiblePage] || '').trim();
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
    selectedRegion: selected ? { ...selected, text: selection?.toString().trim() || undefined } : undefined,
  };
}

export function requiresVisualPdfEvidence(question: string, context: ActivePdfContext): boolean {
  return !!context.selectedRegion || context.pageText.length < 500 || /\b(?:checked|checkbox|marked|green|arrow|diagram|drawing|figure|table|grid|option|formula|shown|visible|number\s+\d+|angekreuzt|markiert|pfeil|abbildung|zeichnung|tabelle|formel)\b/i.test(question);
}

export async function captureCurrentPdfEvidence(
  context: ActivePdfContext,
  question: string,
): Promise<OpenFileImage[]> {
  if (!requiresVisualPdfEvidence(question, context) || !window._pdfToImages) return [];
  const rendered = await window._pdfToImages(1, true);
  return rendered
    .filter((image) => image.page === context.visiblePage)
    .map((image) => ({ ...image, mediaType: image.mediaType as 'image/png' | 'image/jpeg' }))
    .slice(0, 3);
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
): Promise<ChatGroundingSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = getActivePdfContext();
    if (!before) return {
      capturedAt: Date.now(), courseId: null, activeDocument: null,
      images: [], visualEvidenceExpected: false, sourceScope,
    };
    const visualEvidenceExpected = requiresVisualPdfEvidence(question, before);
    const images = await captureCurrentPdfEvidence(before, question);
    const after = getActivePdfContext();
    if (sameViewerPage(before, after)) return {
      capturedAt: Date.now(), courseId: before.courseId, activeDocument: before,
      selectedRegion: before.selectedRegion, images, visualEvidenceExpected, sourceScope,
    };
  }
  return {
    capturedAt: Date.now(), courseId: null, activeDocument: null,
    images: [], visualEvidenceExpected: false, sourceScope,
  };
}
