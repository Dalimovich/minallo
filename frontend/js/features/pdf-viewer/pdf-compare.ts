import type { LegacyCourse } from '../../../globals.js';
import { getPane, clearPane } from './pdf-panes.js';

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

export async function loadCompareDoc(file: CompareFile, course: LegacyCourse): Promise<void> {
  const right = getPane('right');
  right.activeFileName = file.name;
  right.activeStorageName = file._storageName || null;
  right.activeCourseId = course.id || null;
  right.activeCourseRef = course;
  right.pdfFullText = '';
  emit();

  const task = (async () => {
    try {
      const bytes = await fetchBytes(file, course);
      if (!bytes) {
        right.pdfFullText = '';
        return;
      }
      const text = await extractText(bytes);
      if (getPane('right').activeFileName !== file.name) return;
      right.pdfFullText = text;
      persist(course.id || null, file);
      emit();
    } catch {
      right.pdfFullText = '';
      emit();
    }
  })();
  activeLoad = task;
  await task;
  if (activeLoad === task) activeLoad = null;
}

export function clearCompareDoc(): void {
  clearPane('right');
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

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleRestoreCompare(), { once: true });
  } else {
    queueMicrotask(() => scheduleRestoreCompare());
  }
}
