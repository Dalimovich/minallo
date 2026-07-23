import type { LegacyCourse } from '../../../globals.js';
import { loadCompareDoc, clearCompareDoc, getCompareFileName, isCompareLoading, onCompareChange } from './pdf-compare.js';
import { persistablePdfFile } from './pdf-tab-persistence.js';

interface PdfTabFile {
  name: string;
  _uploaded?: boolean;
  _storageName?: string;
  _folder?: string | null;
  _uid?: string;
  _course?: LegacyCourse;
}

interface PdfTab {
  key: string;
  courseId: string;
  file: PdfTabFile;
}

interface PersistedTab {
  key: string;
  courseId: string;
  file: PdfTabFile;
}

interface PersistedState {
  tabs: PersistedTab[];
  activeKey: string | null;
}

const STORAGE_KEY = 'minallo:pdfTabs:v1';

const tabs: PdfTab[] = [];
let activeKey: string | null = null;
let menuOpen = false;
let suppressNextNote = false;
let restored = false;

let barEl: HTMLElement | null = null;
let stripEl: HTMLElement | null = null;
let addBtnEl: HTMLButtonElement | null = null;
let menuEl: HTMLElement | null = null;
let compareChipEl: HTMLElement | null = null;
const tabNodes = new Map<string, HTMLButtonElement>();

// ── helpers ───────────────────────────────────────────────────────────────

function isPdfFile(file: unknown): file is PdfTabFile {
  return (
    !!file &&
    typeof file === 'object' &&
    typeof (file as { name?: unknown }).name === 'string' &&
    /\.pdf$/i.test((file as { name: string }).name)
  );
}

function courseId(course: LegacyCourse): string {
  return String(course.id || course.short || course.name || 'course');
}

function fileKey(file: PdfTabFile, course: LegacyCourse): string {
  const folder = file._folder || '';
  const storage = file._storageName || file.name || '';
  return courseId(course) + '::' + folder + '::' + storage;
}

function allSems(): Array<{ courses: LegacyCourse[] }> {
  const sems = window.SEMS || window._SEMS;
  if (!sems) return [];
  return Object.values(sems);
}

function findCourseById(id: string): LegacyCourse | null {
  for (const sem of allSems()) {
    for (const course of sem.courses || []) {
      if (courseId(course) === id) return course;
    }
  }
  return null;
}

function tabCourse(tab: PdfTab): LegacyCourse | null {
  return findCourseById(tab.courseId);
}

function pdfsForCourse(course: LegacyCourse | null | undefined): PdfTabFile[] {
  if (!course) return [];
  const out: PdfTabFile[] = [];
  (course.files || []).forEach((file) => {
    if (isPdfFile(file)) out.push({ ...file, _folder: null });
  });
  (course.userFolders || []).forEach((folder) => {
    (folder.files || []).forEach((file) => {
      if (isPdfFile(file)) out.push({ ...file, _folder: folder.name || null });
    });
  });
  return out;
}

export function pdfCourseSections(
  activeCourse: LegacyCourse | null,
  sems: Array<{ courses: LegacyCourse[] }>
): Array<{ course: LegacyCourse; files: PdfTabFile[] }> {
  const courses = new Map<string, { course: LegacyCourse; files: PdfTabFile[] }>();
  const addCourse = (course: LegacyCourse | null | undefined): void => {
    if (!course) return;
    const id = courseId(course);
    const files = pdfsForCourse(course);
    const existing = courses.get(id);
    if (!existing || files.length > existing.files.length) courses.set(id, { course, files });
  };

  addCourse(activeCourse);
  for (const sem of sems) {
    for (const course of sem.courses || []) addCourse(course);
  }
  return Array.from(courses.values()).filter((section) => section.files.length);
}

function currentCourse(): LegacyCourse | null {
  const active = window.activeCourseRef || null;
  if (active) return active;
  const activeTab = tabs.find((tab) => tab.key === activeKey);
  if (activeTab) {
    const course = tabCourse(activeTab);
    if (course) return course;
  }
  for (const tab of tabs) {
    const course = tabCourse(tab);
    if (course) return course;
  }
  return null;
}

// ── persistence ───────────────────────────────────────────────────────────

function persist(): void {
  try {
    const state: PersistedState = {
      tabs: tabs.map((tab) => ({
        key: tab.key,
        courseId: tab.courseId,
        file: persistablePdfFile(tab.file),
      })),
      activeKey,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or disabled */
  }
}

function readPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tryRestore(): boolean {
  if (restored) return true;
  const state = readPersisted();
  if (!state) {
    restored = true;
    return true;
  }
  if (!allSems().length) return false;

  for (const entry of state.tabs) {
    if (!entry || !entry.key || !entry.courseId || !entry.file) continue;
    if (!findCourseById(entry.courseId)) continue;
    if (tabs.some((tab) => tab.key === entry.key)) continue;
    tabs.push({ key: entry.key, courseId: entry.courseId, file: { ...entry.file } });
  }
  activeKey = state.activeKey && tabs.some((tab) => tab.key === state.activeKey)
    ? state.activeKey
    : tabs[0]?.key || null;
  restored = true;
  renderTabsStrip();
  return true;
}

function scheduleRestore(): void {
  if (tryRestore()) return;
  let tries = 0;
  const id = window.setInterval(() => {
    tries += 1;
    if (tryRestore() || tries >= 150) window.clearInterval(id);
  }, 200);
}

// ── menu ──────────────────────────────────────────────────────────────────

function closeMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  if (menuEl) menuEl.hidden = true;
  if (addBtnEl) addBtnEl.setAttribute('aria-expanded', 'false');
}

function openMenu(): void {
  if (menuOpen) return;
  menuOpen = true;
  renderMenu();
  if (menuEl) menuEl.hidden = false;
  if (addBtnEl) addBtnEl.setAttribute('aria-expanded', 'true');
}

function makeEmpty(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'pdf-tabs-empty';
  div.textContent = text;
  return div;
}

function makeMenuItem(file: PdfTabFile, course: LegacyCourse, withCourseLabel: boolean): HTMLButtonElement {
  const key = fileKey(file, course);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pdf-tabs-menu-item';
  btn.dataset.pdfOpenCourse = courseId(course);
  btn.dataset.pdfOpenKey = key;

  const name = document.createElement('span');
  name.className = 'pdf-tabs-menu-name';
  name.textContent = file.name;
  btn.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'pdf-tabs-menu-meta';
  if (withCourseLabel) {
    const c = document.createElement('span');
    c.textContent = course.short || course.name;
    meta.appendChild(c);
  }
  if (file._folder) {
    const f = document.createElement('span');
    f.textContent = String(file._folder);
    meta.appendChild(f);
  }
  if (tabs.some((tab) => tab.key === key)) {
    const open = document.createElement('span');
    open.textContent = 'Open';
    meta.appendChild(open);
  }
  btn.appendChild(meta);
  return btn;
}

function renderMenu(): void {
  if (!menuEl) return;
  menuEl.replaceChildren();

  // The active course is the authoritative, hydrated object while a PDF is
  // open. On a restored/deep-linked viewer route, the SEMS copy can still be
  // the lightweight course record without its remotely loaded folders.
  const sections = pdfCourseSections(currentCourse(), allSems());
  if (!sections.length) {
    menuEl.appendChild(makeEmpty('No PDFs in your courses yet.'));
    return;
  }

  const active = currentCourse();
  const activeId = active ? courseId(active) : null;
  const ordered = sections.slice().sort((a, b) => {
    const aActive = courseId(a.course) === activeId ? 0 : 1;
    const bActive = courseId(b.course) === activeId ? 0 : 1;
    return aActive - bActive;
  });
  const showCourseLabel = ordered.length > 1;

  for (const section of ordered) {
    if (showCourseLabel) {
      const heading = document.createElement('div');
      heading.className = 'pdf-tabs-menu-group';
      heading.textContent = section.course.name;
      menuEl.appendChild(heading);
    }
    for (const file of section.files) {
      menuEl.appendChild(makeMenuItem(file, section.course, showCourseLabel));
    }
  }
}

// ── tabs strip ────────────────────────────────────────────────────────────

function makeTabNode(tab: PdfTab): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pdf-tab';
  btn.setAttribute('role', 'tab');
  btn.dataset.pdfTabKey = tab.key;

  const name = document.createElement('span');
  name.className = 'pdf-tab-name';
  name.textContent = tab.file.name;
  btn.appendChild(name);

  const compare = document.createElement('span');
  compare.className = 'pdf-tab-compare';
  compare.setAttribute('role', 'button');
  compare.setAttribute('tabindex', '0');
  compare.setAttribute('aria-label', `Open ${tab.file.name} in split view`);
  compare.setAttribute('title', 'Open in split view (AI reads both)');
  compare.dataset.pdfCompareKey = tab.key;
  compare.textContent = '⛶';
  btn.appendChild(compare);

  const close = document.createElement('span');
  close.className = 'pdf-tab-close';
  close.setAttribute('role', 'button');
  close.setAttribute('tabindex', '0');
  close.setAttribute('aria-label', `Close ${tab.file.name}`);
  close.dataset.pdfCloseKey = tab.key;
  close.textContent = 'x';
  btn.appendChild(close);

  return btn;
}

function renderCompareChip(): void {
  if (!compareChipEl) return;
  const name = getCompareFileName();
  if (!name) {
    compareChipEl.hidden = true;
    compareChipEl.replaceChildren();
    return;
  }
  compareChipEl.hidden = false;
  compareChipEl.replaceChildren();
  const label = document.createElement('span');
  label.className = 'pdf-compare-chip-label';
  label.textContent = isCompareLoading() ? 'Loading ' + name + '…' : 'Split: ' + name;
  compareChipEl.appendChild(label);
  if (!isCompareLoading()) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pdf-compare-chip-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Stop comparing');
    x.dataset.pdfCompareClear = '1';
    compareChipEl.appendChild(x);
  }
}

function tabIsBeingCompared(tab: PdfTab): boolean {
  const compareName = getCompareFileName();
  if (!compareName) return false;
  return (tab.file.name === compareName) || (tab.file._storageName === compareName);
}

function renderTabsStrip(): void {
  if (!stripEl) return;
  renderCompareChip();
  const hasMultiple = tabs.length > 1;
  barEl?.classList.toggle('has-multiple', hasMultiple);
  stripEl.hidden = !hasMultiple;
  const seen = new Set<string>();

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    seen.add(tab.key);
    let node = tabNodes.get(tab.key);
    if (!node) {
      node = makeTabNode(tab);
      tabNodes.set(tab.key, node);
    } else {
      const nameEl = node.querySelector('.pdf-tab-name');
      if (nameEl && nameEl.textContent !== tab.file.name) nameEl.textContent = tab.file.name;
    }
    const isActive = tab.key === activeKey;
    node.classList.toggle('is-active', isActive);
    node.classList.toggle('is-comparing', tabIsBeingCompared(tab));
    node.setAttribute('aria-selected', isActive ? 'true' : 'false');

    const existing = stripEl.children[i];
    if (existing !== node) {
      if (existing) stripEl.insertBefore(node, existing);
      else stripEl.appendChild(node);
    }
  }

  for (const [key, node] of tabNodes) {
    if (!seen.has(key)) {
      node.remove();
      tabNodes.delete(key);
    }
  }

  while (stripEl.children.length > tabs.length) {
    stripEl.removeChild(stripEl.lastChild!);
  }
}

// ── actions ───────────────────────────────────────────────────────────────

function switchToTab(key: string): void {
  const tab = tabs.find((item) => item.key === key);
  if (!tab) return;
  const course = tabCourse(tab);
  if (!course || typeof window.openFile !== 'function') return;
  closeMenu();
  suppressNextNote = true;
  activeKey = key;
  renderTabsStrip();
  try {
    window.openFile(tab.file, course);
  } finally {
    suppressNextNote = false;
  }
  persist();
}

function closeTab(key: string): void {
  const idx = tabs.findIndex((tab) => tab.key === key);
  if (idx === -1) return;
  const closing = tabs[idx]!;
  const closingCourse = tabCourse(closing);
  const wasActive = activeKey === key;
  tabs.splice(idx, 1);

  if (!tabs.length) {
    activeKey = null;
    closeMenu();
    renderTabsStrip();
    persist();
    window.activeFileName = null;
    window.activeStorageName = null;
    window.pdfDoc = null;
    window.pdfFullText = '';
    (window as unknown as { activeRagDocumentId?: string | null }).activeRagDocumentId = null;
    if (typeof window.resetAiPanelChat === 'function') window.resetAiPanelChat();
    if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(false);
    if (closingCourse && typeof window.showCourseSection === 'function') {
      window.showCourseSection(closingCourse, 'files');
    }
    return;
  }

  if (wasActive) {
    const next = tabs[Math.max(0, idx - 1)] || tabs[0];
    if (next) {
      switchToTab(next.key);
      return;
    }
  }
  renderTabsStrip();
  persist();
}

function openFromMenu(file: PdfTabFile, course: LegacyCourse): void {
  closeMenu();
  if (typeof window.openFile === 'function') window.openFile(file, course);
}

function handleCompareClick(key: string): void {
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  if (tab.key === activeKey) return;
  const course = tabCourse(tab);
  if (!course) return;
  if (tabIsBeingCompared(tab)) {
    clearCompareDoc();
    return;
  }
  void loadCompareDoc(tab.file, course);
}

// ── public API ────────────────────────────────────────────────────────────

export function notePdfTabOpen(file: PdfTabFile, course: LegacyCourse): void {
  if (suppressNextNote) return;
  if (!isPdfFile(file)) {
    renderTabsStrip();
    return;
  }
  const key = fileKey(file, course);
  const existing = tabs.find((tab) => tab.key === key);
  if (existing) {
    existing.file = { ...existing.file, ...file };
    existing.courseId = courseId(course);
  } else {
    tabs.push({ key, courseId: courseId(course), file: { ...file } });
  }
  activeKey = key;
  renderTabsStrip();
  persist();
  requestAnimationFrame(() => {
    tabNodes.get(key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

export function renderPdfTabs(): void {
  renderTabsStrip();
  if (menuOpen) renderMenu();
}

let pdfTabsObserver: MutationObserver | null = null;

export function initPdfTabs(): void {
  const el = document.getElementById('pdfTabsBar');
  if (el && el !== barEl) {
    mountPdfTabs(el);
    return;
  }
  if (el) return;
  if (pdfTabsObserver) return;
  pdfTabsObserver = new MutationObserver(() => {
    const found = document.getElementById('pdfTabsBar');
    if (found && found !== barEl) mountPdfTabs(found);
  });
  pdfTabsObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function mountPdfTabs(host: HTMLElement): void {
  barEl = host;

  barEl.replaceChildren();

  stripEl = document.createElement('div');
  stripEl.className = 'pdf-tabs-scroll';
  stripEl.id = 'pdfTabsScroll';
  stripEl.setAttribute('role', 'tablist');
  stripEl.setAttribute('aria-label', 'Open PDFs');
  barEl.appendChild(stripEl);

  const addWrap = document.createElement('div');
  addWrap.className = 'pdf-tabs-add-wrap';

  addBtnEl = document.createElement('button');
  addBtnEl.type = 'button';
  addBtnEl.className = 'pdf-tabs-add';
  addBtnEl.id = 'pdfTabsAdd';
  addBtnEl.setAttribute('aria-haspopup', 'menu');
  addBtnEl.setAttribute('aria-expanded', 'false');
  addBtnEl.title = 'Add PDF tab';
  addBtnEl.textContent = '+';
  addWrap.appendChild(addBtnEl);

  menuEl = document.createElement('div');
  menuEl.className = 'pdf-tabs-menu';
  menuEl.id = 'pdfTabsMenu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  addWrap.appendChild(menuEl);

  barEl.appendChild(addWrap);

  compareChipEl = document.createElement('div');
  compareChipEl.className = 'pdf-compare-chip';
  compareChipEl.hidden = true;
  barEl.appendChild(compareChipEl);

  onCompareChange(() => renderTabsStrip());

  barEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const clearChip = target?.closest<HTMLElement>('[data-pdf-compare-clear]');
    if (clearChip) {
      event.stopPropagation();
      clearCompareDoc();
      return;
    }
    const compareBtn = target?.closest<HTMLElement>('[data-pdf-compare-key]');
    if (compareBtn) {
      event.stopPropagation();
      handleCompareClick(compareBtn.dataset.pdfCompareKey || '');
      return;
    }
    const close = target?.closest<HTMLElement>('[data-pdf-close-key]');
    if (close) {
      event.stopPropagation();
      closeTab(close.dataset.pdfCloseKey || '');
      return;
    }
    const tab = target?.closest<HTMLElement>('[data-pdf-tab-key]');
    if (tab) {
      switchToTab(tab.dataset.pdfTabKey || '');
      return;
    }
    if (target?.closest('#pdfTabsAdd')) {
      menuOpen ? closeMenu() : openMenu();
      return;
    }
    const open = target?.closest<HTMLElement>('[data-pdf-open-key]');
    if (open) {
      const id = open.dataset.pdfOpenCourse || '';
      const key = open.dataset.pdfOpenKey || '';
      const course = findCourseById(id);
      if (!course) return;
      const file = pdfsForCourse(course).find((item) => fileKey(item, course) === key);
      if (file) openFromMenu(file, course);
    }
  });

  barEl.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (event.key === 'Escape') {
      closeMenu();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && target?.matches('[data-pdf-close-key]')) {
      event.preventDefault();
      closeTab(target.dataset.pdfCloseKey || '');
    }
  });

  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    const target = event.target as Node | null;
    if (target && barEl && barEl.contains(target)) return;
    closeMenu();
  });

  renderTabsStrip();
  scheduleRestore();
}

// Normal tab actions persist immediately. These lifecycle hooks are a final
// safeguard for abrupt navigation/browser shutdown after the last UI update.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persist);
  window.addEventListener('beforeunload', persist);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initPdfTabs(), { once: true });
  } else {
    queueMicrotask(() => initPdfTabs());
  }
}
