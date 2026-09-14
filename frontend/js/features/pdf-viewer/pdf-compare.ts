import type { LegacyCourse } from '../../../globals.js';
import { getPane, clearPane } from './pdf-panes.js';
import { loadIntoRight, clearRight } from './pdf-right-renderer.js';

export interface CompareFile {
  name: string;
  _uploaded?: boolean;
  _storageName?: string;
  _folder?: string | null;
  _uid?: string;
  _course?: LegacyCourse;
}

const STORAGE_KEY = 'minallo:pdfCompare:v1';

interface PersistedCompare {
  courseId: string;
  file: CompareFile;
}

const listeners = new Set<() => void>();

export function onCompareChange(handler: () => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function emit(): void {
  for (const h of listeners) {
    try { h(); } catch { /* ignore */ }
  }
}

// Mirror pdf-tabs.ts: never rely on raw course.id alone, fall back to short/
// name so demo courses or seeded data without an id still round-trip through
// localStorage instead of silently losing the persisted split on reload.
function courseKey(course: LegacyCourse): string {
  return String(course.id || course.short || course.name || 'course');
}

function persist(courseId: string | null, file: CompareFile | null): void {
  try {
    if (!courseId || !file) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const data: PersistedCompare = { courseId, file };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota or disabled */ }
}

function readPersisted(): PersistedCompare | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedCompare;
  } catch {
    return null;
  }
}

async function fetchBytes(file: CompareFile, course: LegacyCourse): Promise<Uint8Array | null> {
  if (file._uploaded) {
    const uid =
      file._uid ||
      (window._currentUser && (window._currentUser.id || window._currentUser.sub)) ||
      undefined;
    if (!window._ufFetchBytes) return null;
    return await window._ufFetchBytes(uid, file._course || course, file._storageName || file.name, file._folder || null);
  }
  const path = window.PDF_DATA && window.PDF_DATA[file.name];
  if (!path) return null;
  const res = await fetch(path);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function extractText(bytes: Uint8Array): Promise<string> {
  if (!window._ssEnsurePdfJs || !window.pdfjsLib) {
    await window._ssEnsurePdfJs?.();
  }
  const pdf = await window.pdfjsLib!.getDocument({
    data: bytes,
    cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true,
  }).promise as { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string }> }> }> };
  const max = Math.min(pdf.numPages, 30);
  const promises: Promise<string>[] = [];
  for (let i = 1; i <= max; i++) {
    promises.push(pdf.getPage(i).then((p) => p.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))));
  }
  const pages = await Promise.all(promises);
  return pages.join('\n\n');
}

let activeLoad: Promise<void> | null = null;

function setSplitMode(on: boolean): void {
  const bodies = document.getElementById('pdfBodies');
  if (!bodies) return;
  bodies.classList.toggle('is-split', on);
  document.body.classList.toggle('pdf-compare-open', on);
  const maximizeBoth = document.getElementById('pdfMaximizeBoth');
  if (maximizeBoth) maximizeBoth.hidden = !on;
}

function showRightLoading(fileName: string): void {
  const host = document.getElementById('pdfBodyRight');
  if (!host) return;
  host.replaceChildren();
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(226,232,240,.7);font-family:inherit;font-size:13px';
  wrap.textContent = 'Loading ' + fileName + '…';
  host.appendChild(wrap);
}

export async function loadCompareDoc(file: CompareFile, course: LegacyCourse): Promise<void> {
  const right = getPane('right');
  right.activeFileName = file.name;
  right.activeStorageName = file._storageName || null;
  right.activeCourseId = courseKey(course);
  right.activeCourseRef = course;
  right.pdfFullText = '';
  setSplitMode(true);
  showRightLoading(file.name);
  emit();

  const task = (async () => {
    let failed = false;
    try {
      const bytes = await fetchBytes(file, course);
      if (!bytes) {
        console.error('[pdf-compare] fetchBytes returned no bytes for', file.name, file);
        failed = true;
        return;
      }
      if (getPane('right').activeFileName !== file.name) return;
      // pdfjs's getDocument transfers the underlying ArrayBuffer to its
      // worker (detaching it on the main thread). Give each consumer its
      // own copy so the second call doesn't get a dead buffer
      // (DataCloneError: ArrayBuffer is already detached).
      const bytesForRender = new Uint8Array(bytes);
      const bytesForExtract = new Uint8Array(bytes);
      await loadIntoRight(bytesForRender);
      if (getPane('right').activeFileName !== file.name) return;
      const text = await extractText(bytesForExtract);
      if (getPane('right').activeFileName !== file.name) return;
      right.pdfFullText = text;
      persist(courseKey(course), file);
      emit();
    } catch (err) {
      console.error('[pdf-compare] failed loading', file.name, err);
      failed = true;
    } finally {
      if (failed && getPane('right').activeFileName === file.name) {
        // Don't leave the chip stuck on "Loading X…" forever. Clear the pane
        // and surface a toast so the user can recover.
        clearPane('right');
        setSplitMode(false);
        clearRight();
        persist(null, null);
        emit();
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Could not load',
            'Failed to open ' + file.name + ' in the right pane.'
          );
        }
      }
    }
  })();
  activeLoad = task;
  await task;
  if (activeLoad === task) activeLoad = null;
}

export function clearCompareDoc(): void {
  clearPane('right');
  setSplitMode(false);
  clearRight();
  persist(null, null);
  emit();
}

export function getCompareFileName(): string | null {
  return getPane('right').activeFileName;
}

export function isCompareLoading(): boolean {
  const right = getPane('right');
  return !!right.activeFileName && !right.pdfFullText;
}

function findCourseById(id: string): LegacyCourse | null {
  const sems = window.SEMS || window._SEMS;
  if (!sems) return null;
  for (const sem of Object.values(sems)) {
    for (const course of sem.courses || []) {
      const cid = String(course.id || course.short || course.name || 'course');
      if (cid === id) return course;
    }
  }
  return null;
}

export function tryRestoreCompare(): boolean {
  if (getPane('right').activeFileName) return true;
  const persisted = readPersisted();
  if (!persisted) return true;
  const course = findCourseById(persisted.courseId);
  if (!course) return false;
  void loadCompareDoc(persisted.file, course);
  return true;
}

export function scheduleRestoreCompare(): void {
  if (tryRestoreCompare()) return;
  let tries = 0;
  const id = window.setInterval(() => {
    tries += 1;
    if (tryRestoreCompare() || tries >= 25) window.clearInterval(id);
  }, 200);
}

const SPLIT_RATIO_KEY = 'minallo:pdfSplitRatio:v1';

function initDividerDrag(): void {
  const divider = document.getElementById('pdfPaneDivider');
  const bodies = document.getElementById('pdfBodies');
  if (!divider || !bodies) return;
  if ((divider as HTMLElement).dataset.dragInit === '1') return;
  (divider as HTMLElement).dataset.dragInit = '1';

  const saved = (() => {
    try { return localStorage.getItem(SPLIT_RATIO_KEY); } catch { return null; }
  })();
  if (saved) {
    const n = parseFloat(saved);
    if (!Number.isNaN(n) && n >= 20 && n <= 80) {
      (bodies as HTMLElement).style.setProperty('--pdf-split-left', n + '%');
    }
  }

  let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    divider.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = (bodies as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0) return;
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    if (pct < 20) pct = 20;
    if (pct > 80) pct = 80;
    (bodies as HTMLElement).style.setProperty('--pdf-split-left', pct.toFixed(2) + '%');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('is-dragging');
    document.body.style.cursor = '';
    const current = (bodies as HTMLElement).style.getPropertyValue('--pdf-split-left');
    if (current) {
      try { localStorage.setItem(SPLIT_RATIO_KEY, parseFloat(current).toFixed(2)); } catch { /* ignore */ }
    }
  });
}

function scheduleDividerInit(): void {
  if (document.getElementById('pdfPaneDivider')) {
    initDividerDrag();
    return;
  }
  const obs = new MutationObserver(() => {
    if (document.getElementById('pdfPaneDivider')) {
      obs.disconnect();
      initDividerDrag();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scheduleRestoreCompare();
      scheduleDividerInit();
    }, { once: true });
  } else {
    queueMicrotask(() => {
      scheduleRestoreCompare();
      scheduleDividerInit();
    });
  }
}
