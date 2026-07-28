export interface StableRegionProvenance {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  id: string;
  origin: 'text_selection';
  extractionMethod: 'text';
  confidence: number;
  documentRevision: string;
  nearbyQuestionLabel?: string;
  cropHash: string;
  coordinateSpace: 'normalized_pdf_page';
  pageRotation: number;
  pdfBoundingBox: [number, number, number, number];
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function regionFromSelection(
  selection: Selection | null,
  viewerWrap: HTMLElement | null,
  documentRevision: string,
): StableRegionProvenance | null {
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed || !viewerWrap) return null;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !viewerWrap.contains(anchor) || !viewerWrap.contains(focus)) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const element = (
    anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement
  );
  const pageWrap = element?.closest<HTMLElement>('.pdf-page-wrap');
  if (!pageWrap || !viewerWrap.contains(pageWrap)) return null;
  const pageRect = pageWrap.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) return null;
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const page = Number(pageWrap.dataset.pageNum || pageWrap.dataset.page || '');
  if (!Number.isInteger(page) || page < 1) return null;
  const text = selection.toString().trim();
  const nearby = (pageWrap.textContent || '').slice(0, 2000);
  const label = nearby.match(
    /\b(?:Aufgabe|Übung|Uebung|Question|Exercise|Task)\s*(\d+(?:[.,]\d+){0,3}[a-z]?)\b/i
  )?.[1]?.replace(',', '.');
  const normalized = {
    x: clamp((rect.left - pageRect.left) / pageRect.width),
    y: clamp((rect.top - pageRect.top) / pageRect.height),
    width: clamp(rect.width / pageRect.width),
    height: clamp(rect.height / pageRect.height),
  };
  const fingerprint = [
    documentRevision, page, normalized.x.toFixed(5), normalized.y.toFixed(5),
    normalized.width.toFixed(5), normalized.height.toFixed(5), text,
  ].join('|');
  const cropHash = hashText(fingerprint);
  return {
    page,
    ...normalized,
    id: `selection:${page}:${cropHash}`,
    origin: 'text_selection',
    extractionMethod: 'text',
    // Browser text selection is strong provenance, but not independently
    // verified PDF/OCR evidence; the backend must validate it before Source 0.
    confidence: 0.85,
    documentRevision,
    nearbyQuestionLabel: label,
    cropHash,
    coordinateSpace: 'normalized_pdf_page',
    pageRotation: Number(pageWrap.dataset.rotation || '0') || 0,
    pdfBoundingBox: [
      normalized.x,
      normalized.y,
      normalized.x + normalized.width,
      normalized.y + normalized.height,
    ],
  };
}
