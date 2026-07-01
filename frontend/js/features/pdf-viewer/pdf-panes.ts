import type { LegacyCourse } from '../../../globals.js';

export type PaneId = 'left' | 'right';

export interface PaneState {
  activeFileName: string | null;
  activeStorageName: string | null;
  activeCourseId: string | null;
  activeCourseRef: LegacyCourse | null;
  currentCourseShort: string | undefined;
  activeRagDocumentId: string | null;
  pdfDoc: { numPages: number; getPage: (n: number) => Promise<unknown> } | null;
  pdfTotal: number;
  pdfPage: number;
  pdfScale: number;
  pdfShowAll: boolean;
  pdfFullText: string;
  imageViewerActive: boolean;
}

function emptyPane(): PaneState {
  return {
    activeFileName: null,
    activeStorageName: null,
    activeCourseId: null,
    activeCourseRef: null,
    currentCourseShort: undefined,
    activeRagDocumentId: null,
    pdfDoc: null,
    pdfTotal: 0,
    pdfPage: 1,
    pdfScale: 0.9,
    pdfShowAll: true,
    pdfFullText: '',
    imageViewerActive: false,
  };
}

const panes: Record<PaneId, PaneState> = {
  left: emptyPane(),
  right: emptyPane(),
};

let activeId: PaneId = 'left';

export function getPane(id: PaneId): PaneState {
  return panes[id];
}

export function getActivePaneId(): PaneId {
  return activeId;
}

export function isPaneOpen(id: PaneId): boolean {
  return panes[id].activeFileName != null;
}

interface WindowMirror {
  activeFileName?: string | null;
  activeStorageName?: string | null;
  activeCourseId?: string | null;
  activeCourseRef?: LegacyCourse | null;
  currentCourseShort?: string;
  activeRagDocumentId?: string | null;
  pdfDoc?: PaneState['pdfDoc'];
  pdfTotal?: number;
  pdfPage?: number;
  pdfScale?: number;
  pdfShowAll?: boolean;
  pdfFullText?: string;
  _ssImageViewerActive?: boolean;
}

function windowMirror(): WindowMirror {
  return window as unknown as WindowMirror;
}

export function snapshotWindowInto(id: PaneId): void {
  const w = windowMirror();
  const p = panes[id];
  p.activeFileName = w.activeFileName ?? null;
  p.activeStorageName = w.activeStorageName ?? null;
  p.activeCourseId = w.activeCourseId ?? null;
  p.activeCourseRef = w.activeCourseRef ?? null;
  p.currentCourseShort = w.currentCourseShort;
  p.activeRagDocumentId = w.activeRagDocumentId ?? null;
  p.pdfDoc = w.pdfDoc ?? null;
  p.pdfTotal = w.pdfTotal ?? 0;
  p.pdfPage = w.pdfPage ?? 1;
  p.pdfScale = w.pdfScale ?? 0.9;
  p.pdfShowAll = w.pdfShowAll ?? true;
  p.pdfFullText = w.pdfFullText ?? '';
  p.imageViewerActive = !!w._ssImageViewerActive;
}

export function restorePaneToWindow(id: PaneId): void {
  const w = windowMirror();
  const p = panes[id];
  w.activeFileName = p.activeFileName;
  w.activeStorageName = p.activeStorageName;
  w.activeCourseId = p.activeCourseId;
  w.activeCourseRef = p.activeCourseRef;
  w.currentCourseShort = p.currentCourseShort;
  w.activeRagDocumentId = p.activeRagDocumentId;
  w.pdfDoc = p.pdfDoc;
  w.pdfTotal = p.pdfTotal;
  w.pdfPage = p.pdfPage;
  w.pdfScale = p.pdfScale;
  w.pdfShowAll = p.pdfShowAll;
  w.pdfFullText = p.pdfFullText;
  w._ssImageViewerActive = p.imageViewerActive;
}

export function setActivePane(id: PaneId): void {
  if (activeId === id) return;
  snapshotWindowInto(activeId);
  activeId = id;
  restorePaneToWindow(id);
}

export function clearPane(id: PaneId): void {
  panes[id] = emptyPane();
  if (id === activeId) restorePaneToWindow(id);
}

export function bothPanesText(): string {
  const left = panes.left.pdfFullText || '';
  const right = panes.right.pdfFullText || '';
  if (!left && !right) return '';
  if (!right) return left;
  if (!left) return right;
  const lname = panes.left.activeFileName || 'Document 1';
  const rname = panes.right.activeFileName || 'Document 2';
  return (
    '=== ' + lname + ' ===\n' + left +
    '\n\n=== ' + rname + ' ===\n' + right
  );
}
