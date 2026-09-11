// Cheatsheet study tool — chatbot-popup-native workspace (Learning Agent Phase 4).
//
// A dense, exam-ready summary of the course — key formulas, definitions and
// rules, ranked by the course Topic Map's importance and grounded in the
// user's own files. Course-wide by default; an optional topic focuses it.
// Generation + grounding happen server-side (generateCheatsheet); the result
// is markdown saved as a note (type 'cheatsheet') and rendered here with
// clickable sources.
//
// This module replaces the retired legacy Course Overview "Cheatsheet" tab
// UI. It is mounted directly into the chatbot overlay by
// openStudyToolWorkspace('cheatsheet', ...) in workspace-library.ts. The
// exported openCheatsheetPaper() is also the white "paper"/PDF viewer used
// by: reopening a saved cheatsheet from Saved (workspace-library.ts), and
// the chatbot's inline cheatsheet/summary PDF cards (shell.ts) — there is no
// more standalone Course Overview tab for this tool.

import { escapeHtml } from '../../utils/escape-html.js';
import type { CourseFile, CourseFolder, LibraryCourse } from './workspace-library.js';
import type { CheatsheetResult, CourseDocument, SavedNote } from '../../services/ai-service.js';

function aiService(): Promise<typeof import('../../services/ai-service.js')> {
  return import('../../services/ai-service.js');
}

function esc(s: unknown): string {
  return escapeHtml(s == null ? '' : String(s));
}

// ── ambient bits not (yet) worth adding to globals.d.ts ───────────────────
// SortableJS (CDN) powers cross-column drag-to-reorder in the canvas editor;
// it is a cheatsheet-only dependency, so it is typed locally rather than in
// the shared globals.d.ts.
interface SortableInstance { destroy: () => void; }
interface SortableCtor { create: (el: HTMLElement, opts: Record<string, unknown>) => SortableInstance; }
interface CsWindow extends Window {
  Sortable?: SortableCtor;
  _ssSortableP?: Promise<SortableCtor | undefined> | null;
}
function csWindow(): CsWindow {
  return window as unknown as CsWindow;
}

// ── mount-time state ───────────────────────────────────────────────────────

interface Els {
  courseName: string;
  topic: HTMLInputElement | null;
  gen: HTMLButtonElement | null;
  result: HTMLElement;
  saved: HTMLElement | null;
  savedList: HTMLElement | null;
  pages: HTMLSelectElement | null;
  columns: HTMLSelectElement | null;
  style: HTMLSelectElement | null;
  fontSize: HTMLSelectElement | null;
  detail: HTMLSelectElement | null;
  lang: HTMLSelectElement | null;
  output: HTMLSelectElement | null;
  conflict: HTMLElement | null;
  _paper?: PaperOpenOpts;
  _regenerateSection?: (title: string) => void;
}

export interface CheatsheetMountOptions {
  initialParameters?: { topic?: string };
  initialDocumentIds?: string[];
  /** A saved cheatsheet (note id) to open immediately on mount — no current
   *  caller passes this yet (Saved reopens via openCheatsheetPaper directly,
   *  bypassing the mount entirely), but it is honored the same way Deep
   *  Learn honors initialExistingLessonId, for parity and future callers. */
  initialExistingNoteId?: string;
  [key: string]: unknown;
}

/** Options accepted by openCheatsheetPaper — also used (with kind:'summary')
 *  by the chatbot's inline summary PDF card in shell.ts, so keep this a
 *  superset rather than cheatsheet-only. */
export interface PaperOpenOpts {
  kind?: string;
  course?: string;
  title?: string;
  scope?: string;
  meta?: string;
  markdown?: string;
  settings?: Record<string, unknown>;
  noteId?: string | null;
  [key: string]: unknown;
}

// The real markdown+KaTeX renderer lives in the AI render bridge, which the
// app loads lazily (only when the chatbot opens). Until then window.renderMarkdown
// is a plain escapeHtml stub — so without this the cheatsheet shows raw "##" and
// "$$". Ensure the bridge AND KaTeX before rendering.
function ensureRenderers(): Promise<unknown> {
  const ps: Array<Promise<unknown>> = [];
  if (typeof window._ensureAiRenderBridge === 'function') ps.push(window._ensureAiRenderBridge());
  if (typeof window._ssEnsureKatex === 'function') ps.push(window._ssEnsureKatex());
  return Promise.all(ps);
}

const LABEL_WARN = /^(\s*)(Important:|Critical:|Warning:|Trap:)/;
const LABEL_NOTE = /^(\s*)(Note:)/;

// Apply the cheatsheet emphasis markers the generator emits, on the rendered
// DOM (after KaTeX, so formulas — which can contain == or {{ }} — are already
// .katex spans and are skipped):
//   ==fact==     → yellow highlight   {{term}} → blue key term
//   Note:/Important:/Critical: lines → orange / red
function decorate(root: HTMLElement | null): void {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const p = n.parentNode as HTMLElement | null;
    if (!p || p.closest('.katex, code, pre')) continue;
    const t = n.nodeValue || '';
    if (t.indexOf('==') === -1 && t.indexOf('{{') === -1 && !LABEL_WARN.test(t) && !LABEL_NOTE.test(t)) continue;
    targets.push(n as Text);
  }
  targets.forEach((node) => {
    const t = node.nodeValue || '';
    // Highlight body may contain a single `=` (e.g. a Merken cue
    // "==Druckguss = Großserie=="); allow any char except the closing `==`,
    // so a lone `=` no longer breaks the match and leaks raw `==` to the PDF.
    let html = esc(t)
      .replace(/==((?:[^=\n]|=(?!=))+)==/g, '<mark class="cs-hl">$1</mark>')
      .replace(/\{\{([^}]+)\}\}/g, '<span class="cs-key">$1</span>');
    if (LABEL_WARN.test(t)) html = '<span class="cs-warn">' + html + '</span>';
    else if (LABEL_NOTE.test(t)) html = '<span class="cs-note">' + html + '</span>';
    const span = document.createElement('span');
    span.innerHTML = html;
    node.parentNode?.replaceChild(span, node);
  });
}

let secSeq = 0;

// Split a section block into ATOM blocks at safe boundaries so a long section can
// continue in the next column/page instead of forcing a blank page. The heading +
// everything up to the first labelled group stays together (never split a heading
// from its first content); each subsequent **Bold label:** group (Use when /
// Formulas / Conditions / Watch out …) becomes its own atom. A section with no
// such labels, or a table (wide) section, is never split. Atoms of one section
// share data-cs-sec; continuation atoms carry data-cs-cont and the section title
// (the paginator adds a "· continued" label only when an atom actually starts a
// new column). Returns an array of atom elements (the original element is reused
// as the first atom).
function splitSectionAtoms(sectionEl: HTMLElement, wide: boolean): HTMLElement[] {
  if (wide) return [sectionEl];
  const nodes = Array.prototype.slice.call(sectionEl.childNodes).filter((nd: ChildNode) => {
    return nd.nodeType === 1 || (nd.nodeType === 3 && !!(nd.textContent || '').trim());
  }) as ChildNode[];
  const heading = sectionEl.querySelector('h2, h3');
  const title = heading ? (heading.textContent || '').trim() : '';

  function startsNewAtom(node: ChildNode): boolean {
    // A safe split point: a <p>/<div>/list that LEADS with a bold label. Never a
    // heading, a displayed formula, or a table (those must stay with their group).
    if (node.nodeType !== 1) return false;
    const el = node as HTMLElement;
    if (/^(H2|H3|TABLE)$/.test(el.tagName)) return false;
    if (el.classList && el.classList.contains('katex-display')) return false;
    const fe = el.firstElementChild;
    return !!(fe && /^(STRONG|B)$/.test(fe.tagName));
  }

  const groups: ChildNode[][] = [];
  let cur: ChildNode[] | null = null;
  nodes.forEach((node) => {
    if (cur === null || (cur.length && startsNewAtom(node))) {
      cur = [];
      groups.push(cur);
    }
    cur.push(node);
  });
  if (groups.length <= 1) return [sectionEl];

  const secId = 'sec' + (++secSeq);
  const atoms: HTMLElement[] = [];
  groups.forEach((grp, gi) => {
    let atomEl: HTMLElement;
    if (gi === 0) {
      atomEl = sectionEl; // group 0 keeps the heading + first labelled group
    } else {
      atomEl = document.createElement('div');
      atomEl.className = 'cs-block';
      grp.forEach((nd) => { atomEl.appendChild(nd); }); // MOVES nodes out
      atomEl.setAttribute('data-cs-cont', '1');
    }
    atomEl.setAttribute('data-cs-sec', secId);
    if (title) atomEl.setAttribute('data-cs-title', title);
    atoms.push(atomEl);
  });
  return atoms;
}

interface CsBlockItem {
  el: HTMLElement;
  wide: boolean;
  h: number;
  cont: boolean;
  title: string;
}

// Group each `##` section (h2 + following siblings) into a detached .cs-block,
// then split long sections into atom blocks (see splitSectionAtoms). A section
// containing a table is tagged wide (it becomes a full-width band, never split).
// Returns [{el, wide, h, cont, title}] WITHOUT re-appending.
function collectBlocks(body: HTMLElement): CsBlockItem[] {
  const kids = Array.prototype.slice.call(body.childNodes) as ChildNode[];
  const groups: HTMLElement[] = [];
  let cur: HTMLElement | null = null;
  kids.forEach((node) => {
    if ((node.nodeType === 1 && (node as HTMLElement).tagName === 'H2') || !cur) {
      cur = document.createElement('div');
      cur.className = 'cs-block';
      groups.push(cur);
    }
    cur.appendChild(node);
  });
  const out: CsBlockItem[] = [];
  groups.forEach((b) => {
    const wide = !!b.querySelector('table');
    if (wide) b.classList.add('cs-block--wide');
    splitSectionAtoms(b, wide).forEach((atomEl) => {
      addBlockTools(atomEl);
      out.push({
        el: atomEl,
        wide,
        h: 0,
        cont: atomEl.getAttribute('data-cs-cont') === '1',
        title: atomEl.getAttribute('data-cs-title') || '',
      });
    });
  });
  return out;
}

// Per-section editor chrome: a drag handle + a "page break before" toggle.
// position:absolute so it never affects the measured block height; stripped
// from the exported PDF (onclone) and from print. Wired once; survives re-packs.
function addBlockTools(b: HTMLElement): void {
  const tools = document.createElement('div');
  tools.className = 'cs-block-tools';
  tools.contentEditable = 'false';
  tools.innerHTML =
    '<button type="button" class="cs-drag" title="Drag to reorder">⠿</button>' +
    '<button type="button" class="cs-brk" title="Start a new page before this section">⤓ break</button>';
  // Don't let a tool click bubble into selection/drag of the section text.
  tools.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  const brk = tools.querySelector('.cs-brk');
  brk?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.classList.toggle('cs-break-before');
    const paper = b.closest<PaperEl>('.cs-paper');
    if (paper) repaginate(paper);
  });
  b.insertBefore(tools, b.firstChild);
}

// Break-state lives on the element's class so it survives re-packs.
function hasBreak(el: HTMLElement): boolean { return el.classList.contains('cs-break-before'); }

// Fallback (only if the paged engine throws): the old single multi-column flow.
function wrapBlocksFallback(body: HTMLElement, blocks: CsBlockItem[]): void {
  body.innerHTML = '';
  blocks.forEach((b) => { body.appendChild(b.el); });
}

// SortableJS (CDN, like html2pdf) powers cross-column drag-to-reorder.
function ensureSortable(): Promise<SortableCtor | undefined> {
  const w = csWindow();
  if (w.Sortable) return Promise.resolve(w.Sortable);
  if (w._ssSortableP) return w._ssSortableP;
  w._ssSortableP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js';
    s.onload = () => { resolve(w.Sortable); };
    s.onerror = () => {
      // Evict cache + dead tag so the next open retries (a cached rejection
      // disabled drag-to-reorder for the whole session after one CDN blip).
      w._ssSortableP = null;
      s.remove();
      reject(new Error('sortable lib failed to load'));
    };
    document.head.appendChild(s);
  });
  return w._ssSortableP;
}

type PaperEl = HTMLElement & {
  _csState?: { blocks: CsBlockItem[]; header: HTMLElement | null };
  _csImages?: PaperImage[];
  _csEditing?: boolean;
  _csSortables?: SortableInstance[];
};

function destroySortables(paper: PaperEl): void {
  (paper._csSortables || []).forEach((s) => { try { s.destroy(); } catch { /* ignore */ } });
  paper._csSortables = [];
}

// Make every column and full-width band a drop target in one shared group, so a
// section can be dragged anywhere. On drop we read the new DOM order and re-pack
// (engine refills) — so pages stay full and nothing is stranded.
function initSortables(paper: PaperEl): void {
  const w = csWindow();
  if (!w.Sortable || !paper._csState) return;
  destroySortables(paper);
  const containers = Array.prototype.slice.call(
    paper.querySelectorAll('.cs-col, .cs-band-wide')
  ) as HTMLElement[];
  paper._csSortables = containers.map((c) =>
    w.Sortable!.create(c, {
      group: 'cs-sections',
      handle: '.cs-drag',
      draggable: '.cs-block',
      animation: 130,
      ghostClass: 'cs-sortable-ghost',
      chosenClass: 'cs-sortable-chosen',
      dragClass: 'cs-sortable-drag',
      onEnd: () => {
        // Defer so Sortable finishes before we read the DOM. We do NOT re-pack:
        // the section stays exactly where it was dropped (free placement). We
        // only sync st.blocks to the new visual order so export + later re-packs
        // (column/font change) respect it.
        setTimeout(() => { syncOrderFromDom(paper); }, 0);
      },
    })
  );
}

// Sync st.blocks to the post-drag visual order (pages → bands → columns
// left-to-right, blocks top-to-bottom = document order) WITHOUT re-packing, so
// the dropped section keeps its new spot. The order is saved for export and for
// any later re-pack (column/font/padding change), which legitimately rebuilds.
function syncOrderFromDom(paper: PaperEl): void {
  const st = paper._csState;
  if (!st) return;
  const byEl = new Map<HTMLElement, CsBlockItem>();
  st.blocks.forEach((b) => byEl.set(b.el, b));
  const ordered: CsBlockItem[] = [];
  Array.prototype.slice.call(paper.querySelectorAll('.cs-page .cs-block')).forEach((el: HTMLElement) => {
    const b = byEl.get(el);
    if (b) ordered.push(b);
  });
  if (ordered.length === st.blocks.length) st.blocks = ordered;
}

// ── Paged layout engine ────────────────────────────────────────────────────
// Measures each section block and PACKS blocks into explicit A4-landscape pages:
// a table section becomes a full-width band, runs of cards become multi-column
// bands. Pages fill (top-down, column by column) before spilling to the next, so
// there are no blank trailing pages, no section cut across a page, and no lonely
// block stranded on an empty page. Re-runnable on column/font change.
const COL_GAP = 18;
const BLOCK_GAP = 10;
const BAND_GAP = 12;
const SAFETY = 8;

interface BandItem { el: HTMLElement; h: number; cont: boolean; title: string; }
interface ColState { items: BandItem[]; h: number; }
interface OpenBand { type: 'cols'; maxH: number; cur: number; cols: ColState[]; }
interface WideBand { type: 'wide'; el: HTMLElement; h: number; }
interface PageState { first: boolean; used: number; bands: Array<OpenBand | WideBand>; }
interface SectionUnit { wide: boolean; brk: boolean; h: number; items: BandItem[]; }
interface PackPlan { pages: PageState[]; pageCount: number; lastFill: number; }

function layoutPages(paper: PaperEl): void {
  const st = paper._csState;
  if (!st || !st.blocks.length) return;
  const nCols = parseInt(paper.style.getPropertyValue('--cs-columns'), 10) || 3;

  // Tear down drag instances before we rebuild the DOM they were bound to.
  destroySortables(paper);

  // Detach header + all blocks from any previous layout, then clear old pages.
  if (st.header && st.header.parentNode) st.header.parentNode.removeChild(st.header);
  st.blocks.forEach((b) => { if (b.el.parentNode) b.el.parentNode.removeChild(b.el); });
  Array.prototype.slice.call(paper.querySelectorAll('.cs-page')).forEach((n: HTMLElement) => n.remove());
  paper.classList.add('is-paged');

  // Geometry: measure a real (hidden) page's inner content box in px.
  const probe = document.createElement('div');
  probe.className = 'cs-page';
  probe.style.cssText = 'visibility:hidden;position:absolute;left:-99999px;top:0;margin:0;';
  const probeInner = document.createElement('div');
  probeInner.className = 'cs-page-inner';
  probe.appendChild(probeInner);
  paper.appendChild(probe);
  const innerW = probeInner.clientWidth;
  const innerH = probeInner.clientHeight;
  paper.removeChild(probe);
  if (!innerW || !innerH) throw new Error('cs: zero page geometry');

  const colW = Math.floor((innerW - (nCols - 1) * COL_GAP) / nCols);
  const budget = innerH - SAFETY;

  // Measure every block + pack into pages at a given font-fit SCALE, returning a
  // plan. Re-run per scale: a smaller font changes wrapping and block heights, so
  // heights must be re-measured to pack correctly. Measuring happens inside the
  // real paper (so fonts/styles apply); flow-root on .cs-block means offsetHeight
  // already contains child margins.
  function measureAndPack(scale: number): PackPlan {
    paper.style.setProperty('--cs-fit', String(scale));
    const mhost = document.createElement('div');
    // Match the rendered wrapping so measured heights equal rendered heights
    // (a long compound word that wraps at render must also wrap when measured).
    mhost.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;'
      + 'overflow-wrap:break-word;word-break:break-word;';
    paper.appendChild(mhost);
    let headerH = 0;
    if (st!.header) {
      mhost.style.width = innerW + 'px';
      mhost.appendChild(st!.header);
      headerH = st!.header.offsetHeight;
      mhost.removeChild(st!.header);
    }
    const headerGap = st!.header ? 14 : 0;
    st!.blocks.forEach((b) => {
      mhost.style.width = (b.wide ? innerW : colW) + 'px';
      mhost.appendChild(b.el);
      b.h = b.el.offsetHeight;
      mhost.removeChild(b.el);
    });
    paper.removeChild(mhost);

    // ── Pack into pages: whole-section placement; split only when oversized ──
    // A SECTION is placed as ONE unit (all its atoms in a single column → no
    // "continued" label) using shortest-column balancing, so short/medium
    // sections never fragment. A section that doesn't fit a column is moved whole
    // to another column/page; a later short section is pulled forward to fill the
    // gap (backfill). ONLY a section taller than a FULL column is split at atom
    // boundaries across columns/pages, with a continuation label. Tables stay
    // full-width; manual page breaks anchor a new page.
    const pages: PageState[] = [];
    let page: PageState | null = null;
    let open: OpenBand | null = null;
    function newPage(first: boolean): void {
      page = { first, used: first ? headerH + headerGap : 0, bands: [] };
      pages.push(page);
    }
    function remaining(): number { return budget - page!.used; }
    function openBandFn(): void {
      open = { type: 'cols', maxH: remaining(), cur: 0, cols: [] };
      for (let i = 0; i < nCols; i++) open.cols.push({ items: [], h: 0 });
    }
    function bandItem(b: { el: HTMLElement; h: number; cont: boolean; title: string }): BandItem {
      return { el: b.el, h: b.h, cont: !!b.cont, title: b.title || '' };
    }
    function finalizeOpen(): void {
      if (!open) return;
      let maxH = 0;
      let any = false;
      open.cols.forEach((c) => { if (c.items.length) any = true; if (c.h > maxH) maxH = c.h; });
      if (any) { page!.bands.push(open); page!.used += maxH + BAND_GAP; }
      open = null;
    }
    function pageHasContent(): boolean {
      if (page!.bands.length) return true;
      return !!(open && open.cols.some((c) => c.items.length));
    }

    // Group atoms back into sections: consecutive blocks sharing data-cs-sec are
    // one section; a block with no sec id is its own section. Each section keeps
    // its atoms and total height (incl. inter-atom gaps).
    const sections: SectionUnit[] = [];
    (function groupSections(): void {
      let cur: SectionUnit | null = null;
      let curSec: string | null = null;
      st!.blocks.forEach((b) => {
        if (b.wide) {
          sections.push({ wide: true, brk: hasBreak(b.el), h: b.h, items: [bandItem(b)] });
          cur = null; curSec = null;
          return;
        }
        const sec = b.el.getAttribute('data-cs-sec') || null;
        if (cur && sec && sec === curSec) {
          cur.items.push(bandItem(b));
          cur.h += BLOCK_GAP + b.h;
        } else {
          cur = { wide: false, brk: hasBreak(b.el), h: b.h, items: [bandItem(b)] };
          curSec = sec;
          sections.push(cur);
        }
      });
    })();

    // Place a whole section into the shortest column that fits ALL of it.
    function placeUnit(S: SectionUnit): boolean {
      if (!open) openBandFn();
      let best = -1;
      let bestH = Infinity;
      for (let i = 0; i < nCols; i++) {
        const c = open!.cols[i]!;
        const add = (c.items.length ? BLOCK_GAP : 0) + S.h;
        if (c.h + add <= open!.maxH && c.h < bestH) { best = i; bestH = c.h; }
      }
      if (best < 0) return false;
      const col = open!.cols[best]!;
      S.items.forEach((it) => {
        if (col.items.length) col.h += BLOCK_GAP;
        col.items.push(it);
        col.h += it.h;
      });
      return true;
    }

    // Split an OVERSIZED section sequentially across columns/pages (atoms in
    // order). A continuation atom that starts a new column gets a label (build).
    function placeSplit(S: SectionUnit): void {
      S.items.forEach((it) => {
        if (!open) openBandFn();
        let placed = false;
        while (open!.cur < nCols) {
          const c = open!.cols[open!.cur]!;
          const add = (c.items.length ? BLOCK_GAP : 0) + it.h;
          if (!c.items.length || c.h + add <= open!.maxH) {
            if (c.items.length) c.h += BLOCK_GAP;
            c.items.push(it); c.h += it.h; placed = true; break;
          }
          open!.cur++;
        }
        if (!placed) {
          finalizeOpen(); newPage(false); openBandFn();
          open!.cols[0]!.items.push(it); open!.cols[0]!.h += it.h;
        }
      });
    }

    newPage(true);
    const n = sections.length;
    const consumed: boolean[] = new Array(n).fill(false);
    let done = 0;
    let i = 0;
    let guard = 0;
    while (done < n && guard++ < n * 4 + 50) {
      while (i < n && consumed[i]) i++;
      if (i >= n) break;
      const S = sections[i]!;
      if (S.brk && pageHasContent()) { finalizeOpen(); newPage(false); }
      if (S.wide) {
        finalizeOpen();
        if (page!.used > 0 && S.h + BAND_GAP > remaining()) newPage(false);
        page!.bands.push({ type: 'wide', el: S.items[0]!.el, h: S.h });
        page!.used += S.h + BAND_GAP;
        consumed[i] = true; done++; i++;
        continue;
      }
      // Oversized (taller than a full column) AND splittable → split it. Start on a
      // clean band so the split reads top-to-bottom across fresh columns.
      if (S.h > budget && S.items.length > 1) {
        if (pageHasContent()) { finalizeOpen(); newPage(false); }
        if (!open) openBandFn();
        placeSplit(S);
        consumed[i] = true; done++; i++;
        continue;
      }
      if (!open) openBandFn();
      if (placeUnit(S)) { consumed[i] = true; done++; i++; continue; }
      // S doesn't fit any column as a unit. Backfill the gap with the earliest
      // later short section that DOES fit, then retry S (likely on a new page).
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        if (consumed[j]) continue;
        const T = sections[j]!;
        if (T.wide || T.brk || (T.h > budget && T.items.length > 1)) continue;
        if (placeUnit(T)) { consumed[j] = true; done++; filled = true; break; }
      }
      if (filled) continue;
      const bandEmpty = open!.cols.every((c) => !c.items.length);
      finalizeOpen();
      if (bandEmpty) {
        // Unsplittable section taller than a full column → force-place so it is
        // never dropped (rare; e.g. one giant unlabelled block).
        if (page!.used > 0) newPage(false);
        openBandFn();
        S.items.forEach((it) => {
          if (open!.cols[0]!.items.length) open!.cols[0]!.h += BLOCK_GAP;
          open!.cols[0]!.items.push(it); open!.cols[0]!.h += it.h;
        });
        consumed[i] = true; done++; i++;
      } else {
        newPage(false);
      }
    }
    finalizeOpen();

    // Last-page fill ratio → drives auto-fit.
    const last = pages[pages.length - 1];
    let lastUsed = 0;
    if (last) {
      lastUsed = last.first ? headerH + headerGap : 0;
      last.bands.forEach((band) => {
        if (band.type === 'wide') { lastUsed += band.h + BAND_GAP; return; }
        let m = 0;
        band.cols.forEach((c) => { if (c.h > m) m = c.h; });
        lastUsed += m + BAND_GAP;
      });
    }
    const lastFill = Math.min(1, lastUsed / budget);
    return { pages, pageCount: pages.length, lastFill };
  }

  // AUTO-FIT. Pack at full size first. If the LAST page is a sparse orphan (well
  // under FILL_MIN of the page), try progressively smaller font scales and keep
  // the first that actually REMOVES a page — so a lone block on a near-empty page
  // gets absorbed into the previous pages. Never shrink text unless it eliminates
  // a page; if no step helps, stay at full size (no worse than before).
  const FIT_STEPS = [1, 0.96, 0.92, 0.88, 0.84, 0.8];
  const FILL_MIN = 0.72;
  const basePlan = measureAndPack(1);
  let chosen = basePlan;
  let chosenScale = 1;
  if (basePlan.pageCount > 1 && basePlan.lastFill < FILL_MIN) {
    for (let si = 1; si < FIT_STEPS.length; si++) {
      const plan = measureAndPack(FIT_STEPS[si]!);
      if (plan.pageCount < basePlan.pageCount) { chosen = plan; chosenScale = FIT_STEPS[si]!; break; }
    }
  }
  paper.style.setProperty('--cs-fit', String(chosenScale));
  const pages = chosen.pages;

  // Build the page DOM.
  pages.forEach((pg) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'cs-page';
    const inner = document.createElement('div');
    inner.className = 'cs-page-inner';
    if (pg.first && st!.header) inner.appendChild(st!.header);
    pg.bands.forEach((band) => {
      if (band.type === 'wide') {
        const w = document.createElement('div');
        w.className = 'cs-band-wide';
        w.appendChild(band.el);
        inner.appendChild(w);
      } else {
        const cc = document.createElement('div');
        cc.className = 'cs-cols';
        cc.style.gap = COL_GAP + 'px';
        band.cols.forEach((col) => {
          const colEl = document.createElement('div');
          colEl.className = 'cs-col';
          colEl.style.gap = BLOCK_GAP + 'px';
          col.items.forEach((it, idx) => {
            // A continuation atom that STARTS a column gets a subtle "· continued"
            // label; an atom that simply follows its sibling in the same column
            // flows seamlessly with no label.
            if (idx === 0 && it.cont && it.title) {
              const lab = document.createElement('div');
              lab.className = 'cs-cont';
              lab.setAttribute('aria-hidden', 'true');
              lab.textContent = it.title + ' · continued';
              colEl.appendChild(lab);
            }
            colEl.appendChild(it.el);
          });
          cc.appendChild(colEl);
        });
        inner.appendChild(cc);
      }
    });
    // If the page ends in a table band (or has no column band at all), it has no
    // .cs-col to drag a section into. Append an empty, full-height column band as
    // a visible drop zone (stripped on export).
    const lastBand = pg.bands[pg.bands.length - 1];
    if (!lastBand || lastBand.type !== 'cols') {
      const dz = document.createElement('div');
      dz.className = 'cs-cols cs-dropzone';
      dz.style.gap = COL_GAP + 'px';
      for (let di = 0; di < nCols; di++) {
        const dcol = document.createElement('div');
        dcol.className = 'cs-col';
        dcol.style.gap = BLOCK_GAP + 'px';
        dz.appendChild(dcol);
      }
      inner.appendChild(dz);
    }
    pageEl.appendChild(inner);
    paper.appendChild(pageEl);
  });

  // Re-enable drag-to-reorder on the freshly built columns/bands.
  initSortables(paper);

  // A re-pack destroys and rebuilds the page DOM: put the user's images back on
  // their pages and restore the contentEditable state of the (reused) blocks.
  attachPaperImages(paper);
  applyEditable(paper);
}

// Re-pack on column/font/padding change or after a drag/break edit (geometry or
// order changed). Keeps the last good layout if the engine throws.
function repaginate(paper: PaperEl | null): void {
  if (!paper || !paper._csState) return;
  try { layoutPages(paper); } catch { /* keep last good layout */ }
}

function paginatePaper(body: HTMLElement): void {
  const paper = body.closest<PaperEl>('.cs-paper');
  if (!paper) return;
  const blocks = collectBlocks(body);
  const header = paper.querySelector<HTMLElement>('.cs-paper-head');
  paper._csState = { blocks, header };
  try {
    layoutPages(paper);
    if (body.parentNode) body.parentNode.removeChild(body); // old multicol container
    // Load the drag library (async); init once it's ready (and on later re-packs).
    ensureSortable().then(() => initSortables(paper)).catch(() => { /* drag reorder unavailable */ });
  } catch {
    // Engine failed → fall back to the original single multi-column flow.
    paper.classList.remove('is-paged');
    wrapBlocksFallback(body, blocks);
  }
}

function renderMarkdownInto(el: HTMLElement | null, md: string, paper?: boolean, onDone?: () => void): void {
  if (!el) return;
  const doRender = (): void => {
    el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : esc(md);
    window._renderMath?.(el);
    window._renderCode?.(el);
    decorate(el);
    if (paper) paginatePaper(el);
    onDone?.();
  };
  ensureRenderers().then(doRender).catch(doRender);
}

// ── white "paper" view (Hyperknow-style) + print/PDF ───────────────────────

let csRun = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BuildProgress { id: number; stop: () => void; }

function startBuildSteps(els: Els, topic: string): BuildProgress {
  const runId = ++csRun;
  const steps = [
    'Finding the strongest course evidence',
    'Grouping formulas, definitions, and rules',
    'Drafting exam-ready sections',
    'Checking source coverage',
    'Preparing the cheatsheet view',
  ];
  let idx = 0;
  els.result.innerHTML =
    '<div class="cs-build" data-run="' + runId + '">' +
      '<div class="cs-build-title">Writing ' + esc(topic || 'the course cheatsheet') + '</div>' +
      '<div class="cs-build-steps">' + steps.map((s, i) =>
        '<div class="cs-build-step' + (i === 0 ? ' is-active' : '') + '" data-step="' + i + '">' +
          '<span class="cs-step-dot"></span><span>' + esc(s) + '</span></div>'
      ).join('') + '</div>' +
    '</div>';
  const timer = window.setInterval(() => {
    if (runId !== csRun || !els.result.querySelector('.cs-build')) {
      window.clearInterval(timer);
      return;
    }
    idx = Math.min(idx + 1, steps.length - 1);
    els.result.querySelectorAll('.cs-build-step').forEach((el, i) => {
      el.classList.toggle('is-done', i < idx);
      el.classList.toggle('is-active', i === idx);
    });
  }, 1100);
  return {
    id: runId,
    stop: () => { window.clearInterval(timer); },
  };
}

interface SectionSplit { title: string; markdown: string; }

function splitSections(md: string): SectionSplit[] {
  const text = String(md || '').trim();
  if (!text) return [];
  const chunks = text.split(/\n(?=##\s+)/g).filter((x) => x && x.trim());
  return chunks.map((chunk, i) => {
    const m = chunk.match(/^##\s+(.+?)(?:\n|$)/);
    return {
      title: m ? m[1]!.trim() : (i === 0 ? 'Overview' : 'Section ' + (i + 1)),
      markdown: chunk,
    };
  });
}

function sectionToolsHtml(): string {
  return '<div class="cs-section-tools">' +
    '<button type="button" data-sec-act="condense">Condense</button>' +
    '<button type="button" data-sec-act="expand">Expand</button>' +
    '<button type="button" data-sec-act="remove">Remove</button>' +
    '<button type="button" data-sec-act="up">Up</button>' +
    '<button type="button" data-sec-act="down">Down</button>' +
    '<button type="button" data-sec-act="lock">Lock</button>' +
    '<button type="button" data-sec-act="regen">Regenerate</button>' +
  '</div>';
}

function sectionTitle(block: HTMLElement | null): string {
  const h = block?.querySelector('h2, h3');
  return h ? (h.textContent || '').trim() : '';
}

function condenseSection(block: HTMLElement | null): void {
  if (!block || block.classList.contains('is-locked')) return;
  const content = block.querySelector<HTMLElement>('.cs-section-content') || block;
  if (!content.dataset.fullHtml) content.dataset.fullHtml = content.innerHTML;
  content.querySelectorAll('p, li').forEach((el) => {
    const txt = el.textContent || '';
    const keep = el.querySelector('.katex, code, pre') ||
      /important:|critical:|trap:|source:|p\.\d+|=|\\frac|\\int|\\sum|const|valid/i.test(txt);
    if (!keep) el.classList.add('cs-pruned-line');
  });
  block.classList.add('is-condensed');
}

function expandSection(block: HTMLElement | null): void {
  if (!block) return;
  const content = block.querySelector<HTMLElement>('.cs-section-content') || block;
  if (content.dataset.fullHtml) content.innerHTML = content.dataset.fullHtml;
  block.classList.remove('is-condensed');
}

function wireSectionTools(scope: HTMLElement | null, els: Els): void {
  if (!scope) return;
  scope.querySelectorAll<HTMLElement>('.cs-progress-section, .cs-edit-section').forEach((block) => {
    if (block.dataset.toolsWired) return;
    block.dataset.toolsWired = '1';
    if (!block.querySelector('.cs-section-tools')) block.insertAdjacentHTML('afterbegin', sectionToolsHtml());
  });
  scope.querySelectorAll<HTMLButtonElement>('.cs-section-tools button').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-sec-act');
      const block = btn.closest<HTMLElement>('.cs-progress-section, .cs-edit-section');
      if (!block) return;
      if (act !== 'lock' && block.classList.contains('is-locked')) return;
      if (act === 'condense') condenseSection(block);
      else if (act === 'expand') expandSection(block);
      else if (act === 'remove') block.remove();
      else if (act === 'up' && block.previousElementSibling) block.parentNode?.insertBefore(block, block.previousElementSibling);
      else if (act === 'down' && block.nextElementSibling) block.parentNode?.insertBefore(block.nextElementSibling, block);
      else if (act === 'lock') {
        block.classList.toggle('is-locked');
        btn.textContent = block.classList.contains('is-locked') ? 'Unlock' : 'Lock';
      } else if (act === 'regen') {
        els._regenerateSection?.(sectionTitle(block));
      }
    });
  });
}

function renderResultProgressive(els: Els, res: CheatsheetResult | null | undefined, runId: number): void {
  if (runId !== csRun) return;
  if (!res || res.error || !res.text || !res.text.trim()) {
    renderResult(els, res);
    return;
  }
  const topics = (res.topicsCovered || []).filter(Boolean);
  const sources = res.groundedSources || [];
  const nFiles = sources.reduce((set: Record<string, 1>, s) => { if (s.fileName) set[s.fileName] = 1; return set; }, {} as Record<string, 1>);
  const fileCount = Object.keys(nFiles).length;
  let sections = splitSections(res.text);
  if (!sections.length) sections = [{ title: res.title || 'Cheatsheet', markdown: res.text }];
  els._paper = {
    kind: 'cheatsheet',
    course: els.courseName || 'Cheatsheet',
    title: res.title || 'Cheatsheet',
    scope: res.title || 'Course cheatsheet',
    meta: (fileCount ? 'Based on ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' · ' : '') + 'generated cheatsheet',
    markdown: res.text,
    settings: res.settings as Record<string, unknown> | undefined,
  };
  els.result.innerHTML =
    '<div class="cs-sheet">' +
      '<div class="cs-sheet-head">' +
        '<h3>' + esc(res.title || 'Cheatsheet') + '</h3>' +
        (res.noteId ? '<span class="cs-saved">Saved to your notes</span>' : '') +
        '<button type="button" class="cs-btn cs-view-print" data-cs-view disabled>View / Print</button>' +
        '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit disabled>✎ Edit</button>' +
      '</div>' +
      '<div class="cs-writing-line">Writing section 1 of ' + sections.length + '</div>' +
      '<div class="cs-sheet-body"></div>' +
      '<div class="cs-after" hidden>' +
        (res.citationWarning ? '<div class="cs-cite-warn">' + esc(res.citationWarning) + '</div>' : '') +
        (topics.length ? '<div class="cs-topics">Topics: ' + topics.map(esc).join(' · ') + '</div>' : '') +
        sourcesHtml(sources, res.grounding) +
      '</div>' +
    '</div>';
  const body = els.result.querySelector<HTMLElement>('.cs-sheet-body');
  const line = els.result.querySelector<HTMLElement>('.cs-writing-line');
  const viewBtn = els.result.querySelector<HTMLButtonElement>('[data-cs-view]');
  const editBtn = els.result.querySelector<HTMLButtonElement>('[data-cs-edit]');
  const after = els.result.querySelector<HTMLElement>('.cs-after');
  viewBtn?.addEventListener('click', () => { if (els._paper) openCheatsheetPaper(els._paper); });
  wireInlineEdit(els, res.noteId || null);
  (async () => {
    for (let i = 0; i < sections.length; i += 1) {
      if (runId !== csRun || !body || !body.isConnected) return;
      if (line) line.textContent = 'Writing section ' + (i + 1) + ' of ' + sections.length + ': ' + sections[i]!.title;
      const block = document.createElement('div');
      block.className = 'cs-progress-section';
      block.innerHTML = '<div class="cs-section-writing">Writing...</div><div class="cs-section-content"></div>';
      body.appendChild(block);
      await sleep(i === 0 ? 120 : 420);
      if (runId !== csRun || !block.isConnected) return;
      renderMarkdownInto(block.querySelector('.cs-section-content'), sections[i]!.markdown);
      const writing = block.querySelector('.cs-section-writing');
      if (writing) writing.remove();
      block.classList.add('is-written');
      wireSectionTools(body, els);
      await sleep(360);
    }
    if (runId !== csRun) return;
    if (line) line.textContent = completionLabel(res);
    after?.removeAttribute('hidden');
    if (viewBtn) viewBtn.disabled = false;
    if (editBtn) editBtn.disabled = false;
    bindSourceClicks(els.result);
  })();
}

let paperEl: HTMLElement | null = null;
let paperEsc: ((e: KeyboardEvent) => void) | null = null;

function closePaper(): void {
  if (paperEsc) { document.removeEventListener('keydown', paperEsc); paperEsc = null; }
  if (paperEl) { paperEl.remove(); paperEl = null; }
}

// Lazy-load html2pdf (jsPDF + html2canvas) once, so "Download PDF" produces a
// file directly — no browser print dialog.
function ensureHtml2Pdf(): Promise<NonNullable<Window['html2pdf']>> {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  if (window._ssHtml2PdfP) return window._ssHtml2PdfP as Promise<NonNullable<Window['html2pdf']>>;
  window._ssHtml2PdfP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';
    s.onload = () => { resolve(window.html2pdf); };
    s.onerror = () => {
      // Evict cache + dead tag so the next download retries instead of
      // failing for the rest of the session.
      window._ssHtml2PdfP = null;
      s.remove();
      reject(new Error('pdf lib failed to load'));
    };
    document.head.appendChild(s);
  });
  return window._ssHtml2PdfP as Promise<NonNullable<Window['html2pdf']>>;
}

function safeName(s: string): string {
  return String(s || 'document').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'document';
}

function downloadPdf(el: HTMLElement, filename: string): Promise<void> {
  // is-exporting hides the editor chrome via CSS; onclone also strips the tool
  // nodes from the rendered clone so they can never appear in the PDF.
  el.classList.add('is-exporting');
  return ensureHtml2Pdf().then((h2p) => {
    return h2p().set({
      // margin MUST be 0: the captured .cs-paper is already a full A4-landscape
      // page (297mm) with its own 10mm padding for margins. A non-zero html2pdf
      // margin offsets that page-width element to the right, pushing its right
      // edge past the page boundary so the last table column / right text column
      // is clipped on every page ("Druckkontrol…" truncated). 0 maps it 1:1.
      margin: 0,
      filename,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        onclone: (doc: Document) => {
          Array.prototype.slice.call(doc.querySelectorAll('.cs-block-tools, .cs-img-del, .cs-img-resize'))
            .forEach((n: HTMLElement) => { n.parentNode?.removeChild(n); });
        },
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      // The paged engine lays out exact 210mm .cs-page tiles (margin 0); html2pdf
      // slices the canvas every 210mm so each tile = one PDF page. No explicit
      // page-breaks and no `avoid` — those caused drift/blank pages. Pure tiling.
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(el).save();
  }).then(() => {
    el.classList.remove('is-exporting');
  }, (err: unknown) => {
    el.classList.remove('is-exporting');
    throw err;
  });
}

function hasQualityWarnings(res: CheatsheetResult | null | undefined): boolean {
  const q = res?.quality || {};
  return !!(
    res?.citationWarning ||
    q.droppedMalformedFormulas ||
    q.droppedUnsupportedFormulas ||
    q.droppedGenericNotes ||
    q.evidenceNormalization?.dropped_formula_lines
  );
}

function completionLabel(res: CheatsheetResult | null | undefined): string {
  return hasQualityWarnings(res) ? 'Cheatsheet generated with quality warnings' : 'Cheatsheet complete';
}

function wireDownload(btn: HTMLButtonElement | null, getEl: () => HTMLElement | null, filename: string): void {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const el = getEl();
    if (!el) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    downloadPdf(el, filename).then(() => {
      btn.disabled = false;
      btn.textContent = label;
    }).catch(() => {
      btn.disabled = false;
      btn.textContent = label;
      window.showToast?.('Download failed', 'Could not generate the PDF. Please try again.');
    });
  });
}

// ── Canvas edit mode: in-place text editing + (cheatsheet only) images ─────
// Edits live on the open canvas and flow into the downloaded PDF. Text edits
// mutate the section blocks themselves, so they survive every re-pack; images
// are kept in paper._csImages and re-attached after each layout rebuild.

// Toggle contentEditable on the section blocks + header. KaTeX formulas are
// pinned non-editable so a stray keystroke can't shred a rendered formula —
// they move/delete as one unit instead.
function applyEditable(paper: PaperEl | null): void {
  if (!paper) return;
  const on = !!paper._csEditing;
  Array.prototype.slice.call(paper.querySelectorAll('.cs-block, .cs-paper-head')).forEach((el: HTMLElement) => {
    if (on) el.setAttribute('contenteditable', 'true');
    else el.removeAttribute('contenteditable');
  });
  Array.prototype.slice.call(paper.querySelectorAll('.katex')).forEach((el: HTMLElement) => {
    if (on) el.setAttribute('contenteditable', 'false');
    else el.removeAttribute('contenteditable');
  });
}

function setPaperEditing(ov: HTMLElement, paper: PaperEl | null, on: boolean): void {
  if (!paper) return;
  paper._csEditing = !!on;
  paper.classList.toggle('is-editing', !!on);
  applyEditable(paper);
  const imgBtn = ov.querySelector<HTMLElement>('[data-act="img"]');
  if (imgBtn) imgBtn.hidden = !on;
  const editBtn = ov.querySelector<HTMLElement>('[data-act="edit"]');
  if (editBtn) {
    editBtn.textContent = on ? '✓ Done' : '✎ Edit';
    editBtn.classList.toggle('is-on', !!on);
  }
  const hint = ov.querySelector<HTMLElement>('.cs-paper-hint');
  if (hint) {
    hint.textContent = on
      ? 'Editing: click any text to change it' + (imgBtn ? ' · 🖼 Image adds a picture (drag to move, corner to resize)' : '')
      : 'Edit: drag ⠿ to move · ⤓ break = new page';
  }
  // Leaving edit mode: edited text changed block heights → re-measure + re-pack.
  if (!on) repaginate(paper);
}

// Which page is in the middle of the viewport (new images land there).
function visiblePageIndex(ov: HTMLElement, paper: HTMLElement): number {
  const scroll = ov.querySelector('.cs-paper-scroll');
  const pages = paper.querySelectorAll('.cs-page');
  if (!scroll || !pages.length) return 0;
  const rect = scroll.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  for (let i = 0; i < pages.length; i++) {
    const r = pages[i]!.getBoundingClientRect();
    if (r.top <= mid && r.bottom >= mid) return i;
  }
  return 0;
}

interface PaperImage {
  src: string;
  page: number;
  x: number;
  y: number;
  w: number;
  el?: HTMLElement;
}

function wirePaperImage(paper: PaperEl, im: PaperImage, fig: HTMLElement, page: HTMLElement): void {
  function apply(): void {
    const pw = page.clientWidth;
    const ph = page.clientHeight;
    im.w = Math.max(36, Math.min(im.w, pw));
    fig.style.width = im.w + 'px';
    const fw = fig.offsetWidth;
    const fh = fig.offsetHeight;
    im.x = Math.max(0, Math.min(im.x, pw - Math.min(fw, pw)));
    im.y = Math.max(0, Math.min(im.y, ph - Math.min(fh, ph)));
    fig.style.left = im.x + 'px';
    fig.style.top = im.y + 'px';
  }
  fig.addEventListener('pointerdown', (e) => {
    if (!paper._csEditing) return;
    const target = e.target as HTMLElement;
    if (target.closest('.cs-img-del')) return;
    const isResize = !!target.closest('.cs-img-resize');
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = im.x;
    const oy = im.y;
    const ow = im.w;
    try { fig.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    fig.classList.add('is-active');
    function move(ev: PointerEvent): void {
      if (isResize) {
        im.w = ow + (ev.clientX - sx);
      } else {
        im.x = ox + (ev.clientX - sx);
        im.y = oy + (ev.clientY - sy);
      }
      apply();
    }
    function up(ev: PointerEvent): void {
      fig.removeEventListener('pointermove', move);
      fig.removeEventListener('pointerup', up);
      fig.removeEventListener('pointercancel', up);
      fig.classList.remove('is-active');
      try { fig.releasePointerCapture(ev.pointerId); } catch { /* unsupported */ }
    }
    fig.addEventListener('pointermove', move);
    fig.addEventListener('pointerup', up);
    fig.addEventListener('pointercancel', up);
  });
  const del = fig.querySelector('.cs-img-del');
  del?.addEventListener('click', (e) => {
    e.stopPropagation();
    paper._csImages = (paper._csImages || []).filter((x) => x !== im);
    fig.remove();
  });
  apply();
}

// (Re)build the DOM for every stored image on its page. Safe to call after any
// re-pack: old elements are dropped with the old pages and recreated here.
function attachPaperImages(paper: PaperEl): void {
  const imgs = paper._csImages;
  if (!imgs || !imgs.length) return;
  const pages = paper.querySelectorAll<HTMLElement>('.cs-page');
  if (!pages.length) return;
  imgs.forEach((im) => {
    if (im.el && im.el.parentNode) im.el.parentNode.removeChild(im.el);
    im.page = Math.min(im.page || 0, pages.length - 1);
    const page = pages[im.page]!;
    const fig = document.createElement('div');
    fig.className = 'cs-img';
    fig.setAttribute('contenteditable', 'false');
    fig.style.left = im.x + 'px';
    fig.style.top = im.y + 'px';
    fig.style.width = im.w + 'px';
    fig.innerHTML =
      '<img src="' + im.src + '" alt="" draggable="false">' +
      '<button type="button" class="cs-img-del" title="Remove image">×</button>' +
      '<span class="cs-img-resize" title="Drag to resize"></span>';
    page.appendChild(fig);
    im.el = fig;
    wirePaperImage(paper, im, fig, page);
  });
}

function addPaperImage(ov: HTMLElement, paper: PaperEl, file: File): void {
  if (!file || !/^image\//.test(file.type || '')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = String(reader.result || '');
    if (!src) return;
    const probe = new Image();
    probe.onload = () => {
      const pages = paper.querySelectorAll('.cs-page');
      if (!pages.length) {
        window.showToast?.('Images unavailable', 'The paged view is required to place images.');
        return;
      }
      paper._csImages = paper._csImages || [];
      // Stagger drop position slightly so stacked inserts stay visible.
      const n = paper._csImages.length;
      paper._csImages.push({
        src,
        page: visiblePageIndex(ov, paper),
        x: 60 + (n % 5) * 24,
        y: 60 + (n % 5) * 24,
        w: Math.min(260, probe.naturalWidth || 260),
      });
      attachPaperImages(paper);
    };
    probe.src = src;
  };
  reader.readAsDataURL(file);
}

/** Open the white "paper"/PDF view: in-place canvas editing (text + images),
 *  drag-to-reorder sections, column/font/padding controls, and PDF download.
 *  Shared by the cheatsheet result view, Saved (reopening a saved
 *  cheatsheet), and the chatbot's inline cheatsheet/summary PDF cards
 *  (kind: 'summary' hides the image button — images are a cheatsheet-only
 *  canvas feature; a summary still gets in-place text editing). */
export function openCheatsheetPaper(opts: PaperOpenOpts = {}): void {
  closePaper();
  const kind = opts.kind || 'cheatsheet';
  const ov = document.createElement('div');
  ov.className = 'cs-paper-overlay ss-print-root';
  ov.innerHTML =
    '<div class="cs-paper-bar">' +
      '<span class="cs-paper-bar-title">' + esc(opts.title || 'Cheatsheet') + '</span>' +
      '<span class="cs-paper-hint" title="Drag a section by its ⠿ handle to reorder; ⤓ break starts a new page before a section">Edit: drag ⠿ to move · ⤓ break = new page</span>' +
      '<div class="cs-paper-bar-actions">' +
        '<select class="cs-paper-select" data-act="columns" title="Change columns"><option value="2">2 cols</option><option value="3">3 cols</option><option value="4">4 cols</option></select>' +
        '<select class="cs-paper-select" data-act="pad" title="Change page padding"><option value="6mm">Tight</option><option value="10mm">Normal</option><option value="16mm">Wide</option></select>' +
        '<select class="cs-paper-select" data-act="font" title="Change font size"><option value="0.72rem">Small</option><option value="0.78rem">Medium</option><option value="0.86rem">Large</option></select>' +
        '<button type="button" class="cs-paper-btn" data-act="edit" title="Edit the text directly on the sheet">✎ Edit</button>' +
        (kind === 'cheatsheet'
          ? '<button type="button" class="cs-paper-btn" data-act="img" hidden title="Add a picture to the sheet">🖼 Image</button>' +
            '<input type="file" accept="image/*" data-cs-img-input hidden>'
          : '') +
        '<button type="button" class="cs-paper-btn" data-act="download">⤓ Download PDF</button>' +
        '<button type="button" class="cs-paper-btn cs-paper-close" data-act="close">Close</button>' +
      '</div>' +
    '</div>' +
    '<div class="cs-paper-scroll">' +
      '<div class="cs-paper-veil" data-cs-veil>' +
        '<div class="cs-paper-veil-spinner" aria-hidden="true"></div>' +
        '<div>Preparing your sheet…</div>' +
      '</div>' +
      '<article class="cs-paper">' +
        '<header class="cs-paper-head">' +
          '<h1>' + esc(opts.course || 'Cheatsheet') + '</h1>' +
          (opts.scope ? '<div class="cs-paper-scope">' + esc(opts.scope) + '</div>' : '') +
          (opts.meta ? '<div class="cs-paper-meta">' + esc(opts.meta) + '</div>' : '') +
        '</header>' +
        '<div class="cs-paper-body"></div>' +
      '</article>' +
    '</div>';
  document.body.appendChild(ov);
  paperEl = ov;
  // Settings drive the existing dense paper layout via CSS custom properties.
  const paper = ov.querySelector<PaperEl>('.cs-paper');
  const st = (opts.settings || {}) as { columns?: number; font?: 'xs' | 'sm' | 'md'; pad?: string; style?: string };
  const initialPad = st.pad || '10mm';
  if (paper) {
    if (st.columns) paper.style.setProperty('--cs-columns', String(st.columns));
    const fontEm = ({ xs: '0.72rem', sm: '0.78rem', md: '0.86rem' } as Record<string, string>)[st.font || 'sm'];
    if (fontEm) paper.style.setProperty('--cs-font', fontEm);
    paper.style.setProperty('--cs-pad', initialPad);
    if (st.style) paper.setAttribute('data-style', st.style);
  }
  const colSel = ov.querySelector<HTMLSelectElement>('[data-act="columns"]');
  const fontSel = ov.querySelector<HTMLSelectElement>('[data-act="font"]');
  const padSel = ov.querySelector<HTMLSelectElement>('[data-act="pad"]');
  if (colSel && st.columns) colSel.value = String(st.columns);
  if (fontSel) fontSel.value = ({ xs: '0.72rem', sm: '0.78rem', md: '0.86rem' } as Record<string, string>)[st.font || 'sm'] || '0.78rem';
  if (padSel) padSel.value = initialPad;
  colSel?.addEventListener('change', () => {
    if (!paper) return;
    paper.style.setProperty('--cs-columns', colSel.value);
    repaginate(paper); // geometry changed → re-pack the pages
  });
  fontSel?.addEventListener('change', () => {
    if (!paper) return;
    paper.style.setProperty('--cs-font', fontSel.value);
    repaginate(paper); // font size changed → re-measure + re-pack
  });
  padSel?.addEventListener('change', () => {
    if (!paper) return;
    paper.style.setProperty('--cs-pad', padSel.value);
    repaginate(paper); // padding changed → inner height changed → re-pack
  });
  const body = ov.querySelector<HTMLElement>('.cs-paper-body');
  let veil = ov.querySelector<HTMLElement>('[data-cs-veil]');
  // Open INSTANTLY: paint the overlay (with a loading veil) first, then run the
  // heavy synchronous KaTeX + pagination work on a later frame. Rendering
  // inline here blocked the click handler, so the whole page froze before the
  // overlay ever appeared.
  if (body) {
    requestAnimationFrame(() => {
      setTimeout(() => {
        renderMarkdownInto(body, opts.markdown || '', true, () => {
          if (veil) { veil.remove(); veil = null; }
        });
      }, 30);
    });
  } else if (veil) {
    veil.remove();
    veil = null;
  }
  ov.querySelector('[data-act="close"]')?.addEventListener('click', closePaper);
  const editBtn = ov.querySelector<HTMLButtonElement>('[data-act="edit"]');
  editBtn?.addEventListener('click', () => {
    setPaperEditing(ov, paper, !(paper && paper._csEditing));
  });
  const imgBtn = ov.querySelector<HTMLButtonElement>('[data-act="img"]');
  const imgInput = ov.querySelector<HTMLInputElement>('[data-cs-img-input]');
  if (imgBtn && imgInput) {
    imgBtn.addEventListener('click', () => { imgInput.click(); });
    imgInput.addEventListener('change', () => {
      const f = imgInput.files?.[0];
      if (f && paper) addPaperImage(ov, paper, f);
      imgInput.value = '';
    });
  }
  wireDownload(
    ov.querySelector<HTMLButtonElement>('[data-act="download"]'),
    () => {
      const p = ov.querySelector<PaperEl>('.cs-paper');
      // Mid-edit download: re-measure the edited text so nothing overflows a page.
      if (p && p._csEditing) repaginate(p);
      return p;
    },
    safeName((opts.course || 'cheatsheet') + ' ' + kind) + '.pdf'
  );
  paperEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePaper(); };
  document.addEventListener('keydown', paperEsc);
}

// Honest sources block. The chips are the files/pages where these TOPICS
// appear in the user's materials — not a per-formula verification. When the
// mechanical grounding check passed for most formulas we say so, modestly.
function sourcesHtml(sources: CheatsheetResult['groundedSources'], grounding: CheatsheetResult['grounding']): string {
  if (!sources || !sources.length) return '';
  const chips = sources.map((s) => {
    const pg = s.pageStart == null ? '' : s.pageStart;
    return '<span class="src-cite" title="Open this source" data-src-file="' + esc(s.fileName || '') +
      '" data-src-page="' + esc(pg) + '">' + esc(s.fileName || 'Source') +
      (pg ? ', p.' + esc(pg) : '') + '</span>';
  }).join(' · ');
  let note = '';
  if (grounding && grounding.ratio != null && grounding.total >= 3) {
    note = grounding.ratio >= 0.8
      ? '<div class="cs-ground cs-ground-ok">✓ ' + grounding.grounded + '/' + grounding.total + ' formulas matched to your source text</div>'
      : '<div class="cs-ground cs-ground-weak">' + grounding.grounded + '/' + grounding.total + ' formulas matched to your source text — verify the rest</div>';
  }
  return '<div class="cs-sources"><span class="cs-sources-label">From your files (where these topics appear):</span> ' +
    chips + '</div>' + note;
}

function bindSourceClicks(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('.cs-sources .src-cite').forEach((el) => {
    el.addEventListener('click', () => {
      const fn = el.getAttribute('data-src-file');
      if (!fn || typeof window.openCitedSource !== 'function') return;
      const pageAttr = el.getAttribute('data-src-page');
      window.openCitedSource({ fileName: fn, page: pageAttr ? Number(pageAttr) : null }, 'popup');
    });
  });
}

// ── Durable editing: edit the cheatsheet markdown and save it to the note ──
// The canvas edit mode is visual (layout/images for the PDF); this editor
// changes the stored content itself, so the edits persist and feed every
// later render (inline sheet, canvas, PDF).
function wireInlineEdit(els: Els, noteId: string | null): void {
  const sheet = els.result.querySelector<HTMLElement>('.cs-sheet');
  const btn = sheet?.querySelector<HTMLButtonElement>('[data-cs-edit]');
  const body = sheet?.querySelector<HTMLElement>('.cs-sheet-body');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    if (sheet!.querySelector('.cs-md-edit')) return;
    const md = els._paper?.markdown || '';
    const wrap = document.createElement('div');
    wrap.className = 'cs-md-edit';
    wrap.innerHTML =
      '<textarea class="cs-md-ta" spellcheck="false" placeholder="Cheatsheet markdown…"></textarea>' +
      '<div class="cs-md-actions">' +
        '<button type="button" class="cs-btn cs-btn-primary cs-md-save">Save changes</button>' +
        '<button type="button" class="cs-btn cs-md-cancel">Cancel</button>' +
        '<span class="cs-md-status"></span>' +
      '</div>';
    (wrap.querySelector('.cs-md-ta') as HTMLTextAreaElement).value = md;
    body.style.display = 'none';
    body.parentNode?.insertBefore(wrap, body);
    btn.disabled = true;
    const status = wrap.querySelector<HTMLElement>('.cs-md-status');
    function closeEditor(): void {
      wrap.remove();
      body!.style.display = '';
      btn!.disabled = false;
    }
    wrap.querySelector('.cs-md-cancel')?.addEventListener('click', closeEditor);
    wrap.querySelector('.cs-md-save')?.addEventListener('click', () => {
      const newMd = (wrap.querySelector('.cs-md-ta') as HTMLTextAreaElement).value;
      if (status) status.textContent = 'Saving…';
      aiService()
        .then((svc) => {
          // No note id (unsaved result) → keep the edit locally; it still
          // drives the canvas + PDF for this session.
          return noteId && typeof svc.updateNote === 'function'
            ? svc.updateNote(noteId, { content_markdown: newMd })
            : true;
        })
        .then((ok) => {
          if (noteId && !ok) { if (status) status.textContent = 'Save failed — please try again.'; return; }
          if (els._paper) els._paper.markdown = newMd;
          closeEditor();
          renderMarkdownInto(body, newMd);
        })
        .catch(() => { if (status) status.textContent = 'Save failed — please try again.'; });
    });
  });
}

function renderResult(els: Els, res: CheatsheetResult | null | undefined): void {
  if (!res || res.error) {
    els.result.innerHTML =
      '<div class="cs-msg cs-error">I couldn\'t create that cheatsheet just now. Please try again in a moment.</div>';
    return;
  }
  if (!res.text || !res.text.trim()) {
    els.result.innerHTML =
      '<div class="cs-msg">' + esc(res.warning || 'No cheatsheet could be generated from your course materials yet.') + '</div>';
    return;
  }
  const topics = (res.topicsCovered || []).filter(Boolean);
  const sources = res.groundedSources || [];
  const nFiles = sources.reduce((set: Record<string, 1>, s) => { if (s.fileName) set[s.fileName] = 1; return set; }, {} as Record<string, 1>);
  const fileCount = Object.keys(nFiles).length;
  els._paper = {
    kind: 'cheatsheet',
    course: els.courseName || 'Cheatsheet',
    title: res.title || 'Cheatsheet',
    scope: res.title || 'Course cheatsheet',
    meta: (fileCount ? 'Based on ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' · ' : '') + 'generated cheatsheet',
    markdown: res.text,
    settings: res.settings as Record<string, unknown> | undefined,
  };
  els.result.innerHTML =
    '<div class="cs-sheet">' +
      '<div class="cs-sheet-head">' +
        '<h3>' + esc(res.title || 'Cheatsheet') + '</h3>' +
        (res.noteId ? '<span class="cs-saved">Saved to your notes</span>' : '') +
        '<button type="button" class="cs-btn cs-view-print" data-cs-view>View / Print</button>' +
        '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit>✎ Edit</button>' +
      '</div>' +
      '<div class="cs-sheet-body"></div>' +
      (res.citationWarning ? '<div class="cs-cite-warn">' + esc(res.citationWarning) + '</div>' : '') +
      (topics.length ? '<div class="cs-topics">Topics: ' + topics.map(esc).join(' · ') + '</div>' : '') +
      sourcesHtml(sources, res.grounding) +
    '</div>';
  const body = els.result.querySelector<HTMLElement>('.cs-sheet-body');
  if (body) renderMarkdownInto(body, res.text);
  const viewBtn = els.result.querySelector<HTMLButtonElement>('[data-cs-view]');
  viewBtn?.addEventListener('click', () => { if (els._paper) openCheatsheetPaper(els._paper); });
  wireInlineEdit(els, res.noteId || null);
  bindSourceClicks(els.result);
}

// ── saved cheatsheets (persisted as notes of type 'cheatsheet') ────────────

function fmtDate(s: string | undefined): string {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function viewSaved(svc: typeof import('../../services/ai-service.js'), els: Els, id: string): void {
  if (!id || !svc.getNoteById) return;
  els.result.innerHTML = '<div class="cs-msg cs-loading">Loading cheatsheet…</div>';
  svc.getNoteById(id).then((note) => {
    if (!note) { els.result.innerHTML = '<div class="cs-msg cs-error">Could not load this cheatsheet.</div>'; return; }
    els._paper = {
      kind: 'cheatsheet',
      course: els.courseName || 'Cheatsheet',
      title: note.title || 'Cheatsheet',
      scope: note.title || 'Saved cheatsheet',
      meta: 'Saved cheatsheet',
      markdown: note.content_markdown || '',
    };
    els.result.innerHTML =
      '<div class="cs-sheet"><div class="cs-sheet-head"><h3>' + esc(note.title || 'Cheatsheet') + '</h3>' +
      '<button type="button" class="cs-btn cs-view-print" data-cs-view>View / Print</button>' +
      '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit>✎ Edit</button></div>' +
      '<div class="cs-sheet-body"></div></div>';
    const body = els.result.querySelector<HTMLElement>('.cs-sheet-body');
    if (body) renderMarkdownInto(body, note.content_markdown || '');
    const viewBtn = els.result.querySelector<HTMLButtonElement>('[data-cs-view]');
    viewBtn?.addEventListener('click', () => { if (els._paper) openCheatsheetPaper(els._paper); });
    wireInlineEdit(els, note.id || id);
  }).catch(() => {
    els.result.innerHTML = '<div class="cs-msg cs-error">Could not load this cheatsheet.</div>';
  });
}

function renderSavedList(
  svc: typeof import('../../services/ai-service.js'),
  els: Els,
  courseId: string,
  sheets: SavedNote[]
): void {
  if (!els.saved || !els.savedList) return;
  if (!sheets || !sheets.length) {
    els.saved.setAttribute('hidden', '');
    els.savedList.innerHTML = '';
    return;
  }
  els.saved.removeAttribute('hidden');
  els.savedList.innerHTML = sheets.map((n) =>
    '<div class="cs-saved-item">' +
      '<button type="button" class="cs-saved-open" data-id="' + esc(n.id) + '">' +
        '<span class="cs-saved-title">' + esc(n.title || 'Cheatsheet') + '</span>' +
        '<span class="cs-saved-date">' + esc(fmtDate(n.created_at || n.updated_at)) + '</span>' +
      '</button>' +
      '<button type="button" class="cs-saved-del" data-id="' + esc(n.id) + '" title="Delete cheatsheet" aria-label="Delete cheatsheet">×</button>' +
    '</div>'
  ).join('');
  els.savedList.querySelectorAll<HTMLButtonElement>('.cs-saved-open').forEach((b) => {
    b.addEventListener('click', () => { viewSaved(svc, els, b.getAttribute('data-id') || ''); });
  });
  els.savedList.querySelectorAll<HTMLButtonElement>('.cs-saved-del').forEach((b) => {
    b.addEventListener('click', () => {
      b.disabled = true;
      svc.deleteNote(b.getAttribute('data-id') || '').then(() => { loadSaved(svc, els, courseId); });
    });
  });
}

function loadSaved(svc: typeof import('../../services/ai-service.js'), els: Els, courseId: string): void {
  if (!svc.listCourseNotes || !courseId) return;
  svc.listCourseNotes(courseId).then((notes) => {
    const sheets = (notes || []).filter((n) => n.type === 'cheatsheet');
    renderSavedList(svc, els, courseId, sheets);
  }).catch(() => { /* non-fatal: saved list is additive */ });
}

// Source picker — pick which indexed PDFs to build the cheatsheet from.
// All files start checked (one click = whole course); selecting a small
// subset triggers the backend's per-PDF sectioned + deduped mode.
interface FolderIndex { fileToFolder: Record<string, string>; live: Record<string, boolean>; }

function courseFileFolderIndex(course: LibraryCourse): FolderIndex {
  const fileToFolder: Record<string, string> = {};
  const live: Record<string, boolean> = {};
  ((course?.files || []) as CourseFile[]).forEach((f) => { if (f?.name) live[f.name] = true; });
  ((course?.userFolders || []) as CourseFolder[]).forEach((fd) => {
    (fd.files || []).forEach((f) => {
      if (!f?.name) return;
      live[f.name] = true;
      fileToFolder[f.name] = fd.name || 'Folder';
    });
  });
  return { fileToFolder, live };
}

interface GroupedDocs { map: Record<string, CourseDocument[]>; order: string[]; other: CourseDocument[]; }

function groupDocsByFolder(docs: CourseDocument[], course: LibraryCourse): GroupedDocs {
  const idx = courseFileFolderIndex(course);
  const liveNames = Object.keys(idx.live);
  let list = docs;
  if (liveNames.length) {
    list = (docs || []).filter((d) => !!idx.live[d.file_name || d.fileName || '']);
  }
  const map: Record<string, CourseDocument[]> = {};
  const order: string[] = [];
  const other: CourseDocument[] = [];
  (list || []).forEach((d) => {
    const name = d.file_name || d.fileName || '';
    const folder = idx.fileToFolder[name];
    if (folder) {
      if (!map[folder]) { map[folder] = []; order.push(folder); }
      map[folder]!.push(d);
    } else {
      other.push(d);
    }
  });
  return { map, order, other };
}

function showSourcePicker(docs: CourseDocument[], course: LibraryCourse, onConfirm: (documentIds: string[] | null) => void): void {
  document.getElementById('csSourcePickerOverlay')?.remove();
  const grouped = groupDocsByFolder(docs, course);
  function itemHtml(d: CourseDocument): string {
    return '<label class="qzsp-item">' +
      '<input type="checkbox" class="qzsp-cb" value="' + esc(d.id) + '" checked>' +
      '<span class="qzsp-name">' + esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
    '</label>';
  }
  function folderHtml(name: string, docsInFolder: CourseDocument[], idx: number | string): string {
    return '<div class="qzsp-folder" data-folder-idx="' + esc(idx) + '">' +
      '<div class="qzsp-folder-header open">' +
        '<span class="qzsp-folder-toggle">&#x25BE;</span>' +
        '<span class="qzsp-folder-name">' + esc(name) + '</span>' +
        '<span class="qzsp-folder-count">' + docsInFolder.length + ' file' + (docsInFolder.length === 1 ? '' : 's') + '</span>' +
        '<button class="qzsp-folder-selall" data-folder-act="all" type="button">Select all</button>' +
        '<button class="qzsp-folder-selall qzsp-folder-clear" data-folder-act="none" type="button">Clear</button>' +
      '</div>' +
      '<div class="qzsp-folder-files">' + docsInFolder.map(itemHtml).join('') + '</div>' +
    '</div>';
  }
  let sections = grouped.order.map((name, i) => folderHtml(name, grouped.map[name]!, i)).join('');
  if (grouped.other.length) sections += folderHtml('Other files', grouped.other, 'other');
  const visibleCount = grouped.order.reduce((n, name) => n + grouped.map[name]!.length, grouped.other.length);
  const ov = document.createElement('div');
  ov.id = 'csSourcePickerOverlay';
  ov.className = 'qzsp-overlay';
  ov.innerHTML =
    '<div class="qzsp-modal">' +
      '<div class="qzsp-head"><span class="qzsp-title">Choose source PDFs</span>' +
        '<button class="qzsp-close" type="button" aria-label="Close">&times;</button></div>' +
      '<p class="qzsp-sub">All files are selected by default. Use each folder\'s controls to select or clear only the files inside that folder.</p>' +
      '<div class="qzsp-list qzsp-folder-list">' + sections + '</div>' +
      '<div class="qzsp-actions">' +
        '<button class="qzsp-btn-ghost" id="csSpAll" type="button">Select all</button>' +
        '<button class="qzsp-btn-ghost" id="csSpClear" type="button">Clear</button>' +
        '<button class="qzsp-btn-primary" id="csSpConfirm" type="button">Generate from selected</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  function close(): void { ov.remove(); }
  ov.querySelector('.qzsp-close')?.addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll<HTMLElement>('.qzsp-folder-header').forEach((head) => {
    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-folder-act]')) return;
      const folder = head.closest<HTMLElement>('.qzsp-folder');
      const files = folder?.querySelector<HTMLElement>('.qzsp-folder-files');
      const open = files && files.style.display !== 'none';
      if (files) files.style.display = open ? 'none' : 'flex';
      const toggle = head.querySelector('.qzsp-folder-toggle');
      if (toggle) toggle.innerHTML = open ? '&#x25B8;' : '&#x25BE;';
      head.classList.toggle('open', !open);
    });
  });
  ov.querySelectorAll<HTMLButtonElement>('[data-folder-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = btn.closest<HTMLElement>('.qzsp-folder');
      const checked = btn.getAttribute('data-folder-act') === 'all';
      folder?.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = checked; });
    });
  });
  ov.querySelector('#csSpAll')?.addEventListener('click', () => {
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = true; });
  });
  ov.querySelector('#csSpClear')?.addEventListener('click', () => {
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = false; });
  });
  ov.querySelector('#csSpConfirm')?.addEventListener('click', () => {
    const ids: string[] = [];
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb:checked').forEach((cb) => ids.push(cb.value));
    if (!ids.length) {
      window.showToast?.('No files selected', 'Select at least one PDF.');
      return;
    }
    close();
    // Small selection (incl. a small all-checked course) → pass ids so the
    // backend runs per-PDF mode (≤5 docs). A large all-checked selection →
    // null = whole-course topic sheet (also avoids the proxy's 25-doc cap).
    const allChecked = ids.length === visibleCount;
    onConfirm(allChecked && ids.length > 5 ? null : ids);
  });
}

// ── CSS injection ────────────────────────────────────────────────────────

const STYLE_ID = 'cheatsheetWorkspaceCss';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CHEATSHEET_CSS;
  document.head.appendChild(style);
}

// ── mount ───────────────────────────────────────────────────────────────

const ROOT_HTML =
  '<div class="cs-root" data-cheatsheet-root>' +
    '<div class="cs-head">' +
      '<h2>Cheatsheet</h2>' +
      '<p>A dense, exam-ready summary of this course — the key formulas, definitions and rules, ranked by importance and grounded in your uploaded files.</p>' +
    '</div>' +
    '<div class="cs-settings" id="csSettings">' +
      '<div class="cs-preset-row" role="group" aria-label="Cheatsheet preset">' +
        '<button type="button" class="cs-preset" data-preset="exam_night">Exam Night</button>' +
        '<button type="button" class="cs-preset" data-preset="open_book_exam">Open-book Exam</button>' +
        '<button type="button" class="cs-preset" data-preset="formula_reference">Formula Reference</button>' +
        '<button type="button" class="cs-preset is-active" data-preset="balanced">Balanced Study</button>' +
        '<button type="button" class="cs-preset" data-preset="deep_revision">Deep Revision</button>' +
        '<button type="button" class="cs-preset" data-preset="topic_mastery">Topic Mastery</button>' +
      '</div>' +
      '<div class="cs-opt-row">' +
        '<label class="cs-opt">Pages' +
          '<select id="csPages"><option value="">Auto</option><option>1</option><option>2</option><option>3</option><option>4</option></select>' +
        '</label>' +
        '<label class="cs-opt">Columns' +
          '<select id="csColumns"><option value="">Auto</option><option>2</option><option selected>3</option><option>4</option></select>' +
        '</label>' +
        '<label class="cs-opt">Style' +
          '<select id="csStyle"><option value="academic">Academic</option><option value="modern">Modern</option><option value="compact">Compact</option><option value="classic">Classic</option></select>' +
        '</label>' +
        '<label class="cs-opt">Text' +
          '<select id="csFontSize"><option value="auto">Auto</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select>' +
        '</label>' +
        '<label class="cs-opt">Detail' +
          '<select id="csDetail"><option value="general">General</option><option value="balanced" selected>Balanced</option><option value="specific">Specific</option><option value="very_thorough">Very Thorough</option></select>' +
        '</label>' +
        '<label class="cs-opt">Language' +
          '<select id="csLang"><option value="source">Same as material</option><option value="en">English</option><option value="de">Deutsch</option><option value="de_terms_en_explanations">German terms + English</option></select>' +
        '</label>' +
        '<label class="cs-opt">Output' +
          '<select id="csOutput"><option value="both">Both</option><option value="web">Web view</option><option value="pdf">PDF</option></select>' +
        '</label>' +
        '<span class="cs-conflict" id="csConflict" hidden></span>' +
      '</div>' +
    '</div>' +
    '<div class="cs-controls">' +
      '<input type="text" id="csTopic" class="cs-topic" placeholder="Focus on one topic (optional) — leave blank for the whole course">' +
      '<button class="cs-btn cs-btn-primary" id="csGenerate" type="button">Generate cheatsheet</button>' +
    '</div>' +
    '<div class="cs-saved-wrap" id="csSaved" hidden>' +
      '<div class="cs-saved-head">Saved cheatsheets</div>' +
      '<div class="cs-saved-list" id="csSavedList"></div>' +
    '</div>' +
    '<div class="cs-result" id="csResult"></div>' +
  '</div>';

interface PresetDefaults { pages: string; columns: string; style: string; fontSize: string; detail: string; }
const PRESET_DEFAULTS: Record<string, PresetDefaults> = {
  exam_night:        { pages: '1', columns: '3', style: 'compact',  fontSize: 'small',  detail: 'general' },
  open_book_exam:    { pages: '2', columns: '3', style: 'academic', fontSize: 'auto',   detail: 'balanced' },
  formula_reference: { pages: '2', columns: '3', style: 'compact',  fontSize: 'small',  detail: 'specific' },
  balanced:          { pages: '2', columns: '3', style: 'academic', fontSize: 'auto',   detail: 'balanced' },
  deep_revision:     { pages: '4', columns: '2', style: 'academic', fontSize: 'medium', detail: 'very_thorough' },
  topic_mastery:     { pages: '2', columns: '2', style: 'modern',   fontSize: 'medium', detail: 'specific' },
};

/** Mount the Cheatsheet study tool into `target`. Synchronous: sets
 *  target.innerHTML before returning (openStudyToolWorkspace checks
 *  target.firstElementChild immediately after calling this). */
export function mountCheatsheetWorkspace(
  target: HTMLElement,
  course: LibraryCourse,
  options: Record<string, unknown> = {}
): void {
  if (!target) return;
  ensureStyles();
  target.innerHTML = ROOT_HTML;
  const root = target.querySelector<HTMLElement>('[data-cheatsheet-root]');
  if (!root) return;
  const courseId = course.id || window.activeCourseId || '';
  const els: Els = {
    courseName: course.name || course.short || '',
    topic: root.querySelector('#csTopic'),
    gen: root.querySelector('#csGenerate'),
    result: root.querySelector('#csResult')!,
    saved: root.querySelector('#csSaved'),
    savedList: root.querySelector('#csSavedList'),
    pages: root.querySelector('#csPages'),
    columns: root.querySelector('#csColumns'),
    style: root.querySelector('#csStyle'),
    fontSize: root.querySelector('#csFontSize'),
    detail: root.querySelector('#csDetail'),
    lang: root.querySelector('#csLang'),
    output: root.querySelector('#csOutput'),
    conflict: root.querySelector('#csConflict'),
  };
  if (!els.gen) return;

  const opts = (options || {}) as CheatsheetMountOptions;
  const state = { preset: 'balanced' };
  let docsPromise: Promise<CourseDocument[]> | null = null;
  function loadCourseDocs(): Promise<CourseDocument[]> {
    if (!docsPromise) {
      docsPromise = aiService()
        .then((svc) => {
          const list = typeof svc.prefetchCourseDocuments === 'function'
            ? svc.prefetchCourseDocuments(courseId)
            : svc.listCourseDocuments(courseId);
          return list.then((docs) =>
            typeof svc.filterDocsByCourseFiles === 'function'
              ? svc.filterDocsByCourseFiles(docs, courseId) : docs
          );
        })
        .catch((err) => {
          docsPromise = null;
          throw err;
        });
    }
    return docsPromise;
  }

  // Recommended layout per mode — applied to the controls when a preset is
  // picked so each mode also *looks* distinct (the user can still override).
  function applyPresetDefaults(name: string): void {
    const d = PRESET_DEFAULTS[name];
    if (!d) return;
    if (els.pages) els.pages.value = d.pages;
    if (els.columns) els.columns.value = d.columns;
    if (els.style) els.style.value = d.style;
    if (els.fontSize) els.fontSize.value = d.fontSize;
    if (els.detail) els.detail.value = d.detail;
  }

  // ── settings panel ──
  function readSettings(): Record<string, unknown> {
    const s: Record<string, unknown> = { preset: state.preset };
    const p = els.pages?.value;
    if (p) s.pages = parseInt(p, 10);
    const c = els.columns?.value;
    if (c) s.columns = parseInt(c, 10);
    if (els.style?.value) s.style = els.style.value;
    if (els.fontSize?.value) s.fontSize = els.fontSize.value;
    if (els.detail?.value) s.detailLevel = els.detail.value;
    const l = els.lang?.value;
    if (l && l !== 'source') s.language = l;
    if (els.output?.value) s.output = els.output.value;
    return s;
  }
  function checkConflicts(): void {
    if (!els.conflict) return;
    const topic = (els.topic?.value || '').trim();
    const pages = els.pages?.value ? parseInt(els.pages.value, 10) : null;
    const columns = els.columns?.value ? parseInt(els.columns.value, 10) : null;
    const fontSize = els.fontSize?.value;
    const detail = els.detail?.value;
    let msg = '';
    if (pages === 1 && columns === 4 && fontSize === 'large') {
      msg = '4 columns + Large text + 1 page may not fit. Use Small text or 2 pages.';
    } else if (pages === 1 && detail === 'very_thorough') {
      msg = 'Very Thorough + 1 page will keep only highest-priority details.';
    } else if (state.preset === 'topic_mastery' && !topic) {
      msg = 'Topic Mastery works best with a topic in the focus box.';
    } else if (state.preset === 'deep_revision' && pages === 1) {
      msg = 'Deep Revision on 1 page will be very cramped — consider 2+ pages.';
    } else if (state.preset === 'exam_night' && pages && pages >= 3) {
      msg = 'Exam Night is tuned for 1 dense page; more pages dilute it.';
    }
    els.conflict.textContent = msg;
    els.conflict.hidden = !msg;
  }
  root.querySelectorAll<HTMLButtonElement>('.cs-preset').forEach((b) => {
    b.addEventListener('click', () => {
      state.preset = b.getAttribute('data-preset') || 'balanced';
      root.querySelectorAll('.cs-preset').forEach((x) => { x.classList.toggle('is-active', x === b); });
      applyPresetDefaults(state.preset);
      checkConflicts();
    });
  });
  els.pages?.addEventListener('change', checkConflicts);
  els.columns?.addEventListener('change', checkConflicts);
  els.fontSize?.addEventListener('change', checkConflicts);
  els.detail?.addEventListener('change', checkConflicts);
  els.topic?.addEventListener('input', checkConflicts);

  if (els.topic && opts.initialParameters?.topic) els.topic.value = opts.initialParameters.topic;

  aiService().then((svc) => {
    loadSaved(svc, els, courseId);
    if (opts.initialExistingNoteId) viewSaved(svc, els, opts.initialExistingNoteId);
  });
  if (courseId) loadCourseDocs().catch(() => { /* retry on click */ });

  function doGenerate(documentIds: string[] | null): void {
    const topic = (els.topic?.value || '').trim();
    const settings = readSettings();
    settings.focusMode = documentIds && documentIds.length
      ? 'selected_files'
      : (topic ? 'specific_topic' : 'whole_course');
    if (els.gen) els.gen.disabled = true;
    els.result.innerHTML = '<div class="cs-msg cs-loading">Generating cheatsheet… this can take a moment.</div>';
    const progress = startBuildSteps(els, topic);
    aiService()
      .then((svc) => {
        const genOpts: { settings: Record<string, unknown>; topic?: string; documentIds?: string[] } = { settings };
        if (topic) genOpts.topic = topic;
        if (documentIds && documentIds.length) genOpts.documentIds = documentIds;
        return svc.generateCheatsheet(courseId, genOpts).then((res) => {
          if (els.gen) els.gen.disabled = false;
          progress.stop();
          renderResultProgressive(els, res, progress.id);
          // A new cheatsheet was just saved — refresh the saved list.
          if (res?.noteId) loadSaved(svc, els, courseId);
          return res;
        });
      })
      .catch(() => {
        if (els.gen) els.gen.disabled = false;
        progress.stop();
        els.result.innerHTML =
          '<div class="cs-msg cs-error">I couldn\'t create that cheatsheet just now. Please try again in a moment.</div>';
      });
  }

  els._regenerateSection = (title: string) => {
    if (title && els.topic) els.topic.value = title.replace(/^Method Picker$/i, '').trim();
    doGenerate(null);
  };

  els.gen.addEventListener('click', () => {
    if (!courseId) return;
    els.gen!.disabled = true;
    loadCourseDocs()
      .then((docs) => {
        els.gen!.disabled = false;
        const ready = (docs || []).filter((d) => d.processing_status === 'ready');
        if (!ready.length) {
          els.result.innerHTML = '<div class="cs-msg">No indexed files yet — upload and index a PDF first.</div>';
          return;
        }
        showSourcePicker(ready, course, (documentIds) => { doGenerate(documentIds); });
      })
      .catch(() => {
        els.gen!.disabled = false;
        els.result.innerHTML = '<div class="cs-msg cs-error">Could not load your files. Please try again.</div>';
      });
  });
}

// ── styles ──────────────────────────────────────────────────────────────
// Ported ~1:1 from the retired views/cheatsheet/cheatsheet.css. The .cs-sp-*
// "source picker" rules were dropped: the picker's actual markup uses the
// shared .qzsp-* classes (see showSourcePicker above), never .cs-sp-* — the
// same dead-CSS pattern the Deep Learn migration found and pruned in its own
// legacy stylesheet (.dl-sp-*). The picker is styled by the always-loaded
// global rules in frontend/css/styles.css exactly like the other study tools.
const CHEATSHEET_CSS = `
.cs-root {
  padding: 18px 20px;
  color: var(--text, #e2e8f0);
}
.cs-head h2 {
  margin: 0 0 4px;
  font-size: 1.25rem;
}
.cs-head p {
  margin: 0 0 16px;
  opacity: 0.75;
  font-size: 0.9rem;
  max-width: 60ch;
}
.cs-controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 18px;
}
.cs-topic {
  flex: 1 1 320px;
  min-width: 220px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: var(--card-inner, rgba(255, 255, 255, 0.05));
  color: var(--text, #e2e8f0);
  font-size: 0.9rem;
}
.cs-btn {
  padding: 9px 18px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}
.cs-btn-primary {
  background: #6366f1;
  color: #fff;
}
.cs-btn-primary:hover { background: #5457e6; }
.cs-btn-primary:disabled { opacity: 0.55; cursor: default; }

/* Settings panel (presets + two overrides) */
.cs-settings { margin-bottom: 14px; }
.cs-preset-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.cs-preset {
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border, #334155);
  background: var(--card-inner, rgba(255, 255, 255, 0.04));
  color: var(--text, #e2e8f0);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}
.cs-preset:hover { background: rgba(255, 255, 255, 0.08); }
.cs-preset.is-active {
  background: #6366f1;
  border-color: #6366f1;
  color: #fff;
}
.cs-opt-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.cs-opt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 0.82rem;
  opacity: 0.85;
}
.cs-opt select {
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #334155);
  background: var(--card-inner, rgba(255, 255, 255, 0.05));
  color: var(--text, #e2e8f0);
  font-size: 0.82rem;
}
.cs-conflict {
  font-size: 0.78rem;
  color: #fbbf24;
}

.cs-msg {
  padding: 18px;
  border-radius: 8px;
  background: var(--card-inner, rgba(255, 255, 255, 0.05));
  font-size: 0.9rem;
}
.cs-msg.cs-error { color: #fca5a5; }
.cs-msg.cs-loading { opacity: 0.8; }

.cs-sheet {
  border: 1px solid var(--border, #1e293b);
  border-radius: 10px;
  background: var(--card, #0f172a);
  padding: 16px 18px;
}
.cs-sheet-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.cs-sheet-head h3 { margin: 0; font-size: 1.05rem; }
.cs-saved {
  font-size: 0.72rem;
  opacity: 0.7;
  white-space: nowrap;
}
.cs-sheet-body {
  font-size: 0.92rem;
  line-height: 1.5;
}
.cs-sheet-body h2,
.cs-sheet-body h3 { margin: 14px 0 6px; }
.cs-sheet-body ul { margin: 4px 0 10px; padding-left: 20px; }
.cs-topics,
.cs-sources {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #1e293b);
  font-size: 0.8rem;
  opacity: 0.85;
}

.cs-sources-label { opacity: 0.7; }
/* Honest mechanical grounding note (formula tokens matched to source text). */
.cs-ground {
  margin-top: 6px;
  font-size: 0.76rem;
}
.cs-ground-ok { color: #34d399; }
.cs-ground-weak { color: #fbbf24; }

/* Honest note when the sanitizer dropped garbled source formulas. */
.cs-cite-warn {
  margin-top: 12px;
  padding: 8px 10px;
  border-left: 3px solid #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  border-radius: 4px;
  font-size: 0.8rem;
  color: #fbbf24;
}

/* Emphasis markers (dark preview defaults; overridden lighter-on-white inside .cs-paper) */
.cs-hl { background: #fde68a; color: #1f2937; padding: 0 2px; border-radius: 2px; }
.cs-key { color: #60a5fa; font-weight: 600; }
.cs-warn { color: #f87171; font-weight: 600; }
.cs-note { color: #fbbf24; }

.cs-view-print {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--border, #334155);
  color: var(--text, #e2e8f0);
  padding: 5px 12px;
  font-size: 0.82rem;
}
.cs-view-print:hover { background: rgba(255, 255, 255, 0.07); }
/* "✎ Edit" sits next to View / Print and opens the markdown editor. */
.cs-sheet-edit {
  background: transparent;
  border: 1px solid var(--border, #334155);
  color: var(--text, #e2e8f0);
  padding: 5px 12px;
  font-size: 0.82rem;
}
.cs-sheet-edit:hover { background: rgba(255, 255, 255, 0.07); }
.cs-sheet-edit:disabled { opacity: 0.45; cursor: default; }

/* Inline markdown editor (durable edits saved back to the note) */
.cs-md-edit { display: grid; gap: 10px; }
.cs-md-ta {
  width: 100%;
  min-height: 320px;
  resize: vertical;
  box-sizing: border-box;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--cs-line, #334155);
  background: var(--cs-nested, rgba(255, 255, 255, 0.05));
  color: var(--text, #e2e8f0);
  font: 0.85rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cs-md-actions { display: flex; gap: 8px; align-items: center; }
.cs-md-cancel {
  background: transparent;
  border: 1px solid var(--cs-line, #334155);
  color: var(--text, #e2e8f0);
}
.cs-md-cancel:hover { background: rgba(255, 255, 255, 0.07); }
.cs-md-status { font-size: 0.8rem; opacity: 0.8; }
.cs-sheet-head { display: flex; align-items: center; gap: 10px; }

.cs-progress-section,
.cs-edit-section {
  position: relative;
}
.cs-section-tools {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin: 8px 0 4px;
  opacity: 0.72;
}
.cs-section-tools button {
  border: 1px solid var(--border, #334155);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text, #e2e8f0);
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 0.7rem;
  cursor: pointer;
}
.cs-section-tools button:hover { background: rgba(255, 255, 255, 0.09); }
.cs-progress-section.is-locked {
  outline: 1px dashed rgba(99, 102, 241, 0.55);
  outline-offset: 3px;
}
.cs-pruned-line { display: none; }

/* ── White Hyperknow-style paper view + print ─────────────────────────────── */
.cs-paper-overlay {
  position: fixed;
  inset: 0;
  z-index: 4200;
  display: flex;
  flex-direction: column;
  background: #5b6066;
}
.cs-paper-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: #0f172a;
  color: #e2e8f0;
  border-bottom: 1px solid #1e293b;
}
.cs-paper-bar-title { font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-paper-bar-actions { margin-left: auto; display: flex; gap: 8px; }
.cs-paper-btn {
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.85rem;
  cursor: pointer;
}
.cs-paper-select {
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 0.8rem;
}
.cs-paper-btn:hover { background: #334155; }
.cs-paper-btn.is-on { background: #6366f1; border-color: #6366f1; color: #fff; }
.cs-paper-close { background: transparent; }
.cs-paper-scroll { flex: 1 1 auto; overflow: auto; padding: 22px; }

/* Instant-open loading veil: the overlay paints immediately; the heavy KaTeX +
   pagination work runs on a later frame behind this. transform-based spin so the
   compositor keeps it animating even while the main thread is busy. */
.cs-paper-veil {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 55vh;
  color: #e2e8f0;
  font-size: 0.9rem;
}
.cs-paper-veil-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.22);
  border-top-color: #818cf8;
  animation: csSpin 0.8s linear infinite;
}
@keyframes csSpin { to { transform: rotate(360deg); } }

.cs-paper {
  width: 297mm;
  min-height: 210mm;
  max-width: none;
  margin: 0 auto;
  background: #fff;
  color: #111827;
  padding: 10mm;
  border-radius: 4px;
  box-shadow: 0 6px 30px rgba(0, 0, 0, 0.4);
  /* --cs-fit is the auto-fit multiplier the layout engine lowers (down to ~0.8)
     only when shrinking removes an otherwise near-empty orphan page. */
  font-size: calc(var(--cs-font, 0.78rem) * var(--cs-fit, 1));
  line-height: 1.32;
  box-sizing: border-box;
}
.cs-paper-head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 14px; }
.cs-paper-head h1 { font-size: 1.35rem; margin: 0; color: #111827; }
.cs-paper-scope { font-size: 0.95rem; font-weight: 600; color: #374151; margin-top: 2px; }
.cs-paper-meta { font-size: 0.72rem; color: #6b7280; margin-top: 3px; }

.cs-paper-body {
  column-count: var(--cs-columns, 3);
  column-gap: 18px;
  column-rule: 1px solid #e5e7eb;
  /* The PDF is html2canvas of the real layout: if ANY descendant (a wide table,
     a long German compound word, a wide formula) pushes the content past the
     page width, the right edge is clipped on EVERY page (observed: "Materialeffi…"
     truncated). Force long content to wrap so the body can never exceed its width. */
  overflow-wrap: break-word;
  word-break: break-word;
}
/* Scanability: never split a section, a formula, a table, or a list item across
   a column or printed page; keep a heading glued to the content under it.
   display: flow-root establishes a BFC so child margins are contained in the
   block's offsetHeight — essential for the JS layout engine to measure heights
   accurately (otherwise collapsing h2/p margins under-report and pages overflow). */
.cs-block { break-inside: avoid; page-break-inside: avoid; margin-bottom: 12px; max-width: 100%; display: flow-root; }

/* ── JS paged layout (engine in cheatsheet-workspace.ts layoutPages) ────────────
   The paper is split into explicit A4-landscape pages, each packed by measured
   height: full-width bands for tables, multi-column bands for cards. This replaces
   the single tall CSS-multicolumn flow (which left blank trailing pages, cut
   sections mid-block, and stranded lone blocks when html2canvas sliced it). */
.cs-paper.is-paged { padding: 0; min-height: 0; background: transparent; box-shadow: none; }
/* EXACT 210mm tiles, ZERO vertical margin, NO page-break dividers. html2pdf
   renders the whole stack to one canvas and slices it every 210mm — so each
   .cs-page (exactly 210mm, tiled at 210mm boundaries) maps to exactly one PDF
   page. The packer keeps each page's content < 210mm, so nothing is near a slice
   boundary. The earlier blank pages came from combining fixed heights WITH
   explicit page-break dividers AND inter-page margins, which double-paginated
   and drifted — all three are gone now. */
.cs-page {
  width: 297mm;
  height: 210mm;
  box-sizing: border-box;
  padding: var(--cs-pad, 10mm);
  margin: 0 auto;
  background: #fff;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px #eef0f3;
}
.cs-page-inner {
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* long German compounds / URLs must wrap, never widen a column past the page. */
  overflow-wrap: break-word;
  word-break: break-word;
}
/* SCREEN ONLY: stack header + bands top-down so the last band can grow and fill
   the page, turning the empty space below the content into a full-height drop
   target. This must NOT apply during export — a flex column lets html2canvas
   shrink/clip the 210mm tiles, which drops whole pages of sections and leaves a
   blank page. Export keeps the proven block-flow tiling. */
.cs-paper:not(.is-exporting) .cs-page-inner {
  display: flex;
  flex-direction: column;
}

/* ── Layout editor (screen only; stripped from the exported PDF in onclone) ──── */
.cs-block { position: relative; }
.cs-block-tools {
  position: absolute;
  top: 1px;
  right: 1px;
  display: none;
  gap: 3px;
  z-index: 6;
}
.cs-block:hover .cs-block-tools { display: flex; }
.cs-block-tools button {
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #334155;
  border-radius: 4px;
  font-size: 0.66rem;
  line-height: 1.5;
  padding: 0 5px;
  cursor: pointer;
}
.cs-block-tools button:hover { background: #eef2ff; border-color: #6366f1; }
.cs-block-tools .cs-drag { cursor: grab; font-size: 0.8rem; padding: 0 4px; }
/* A section flagged to start a new page: indigo spine + active toggle. */
.cs-block.cs-break-before { box-shadow: -4px 0 0 0 #6366f1; }
.cs-block.cs-break-before .cs-brk { background: #6366f1; color: #fff; border-color: #6366f1; }
/* SortableJS drag states */
.cs-sortable-ghost { opacity: 0.35; }
.cs-sortable-chosen { outline: 2px solid #6366f1; outline-offset: 2px; border-radius: 4px; }
.cs-sortable-drag { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
/* Drop the editor chrome (and break spine) when exporting/printing. */
.cs-paper.is-exporting .cs-block-tools { display: none !important; }
.cs-paper.is-exporting .cs-block.cs-break-before { box-shadow: none; }
@media print { .cs-block-tools { display: none !important; } }

/* ── Canvas edit mode: in-place text + (cheatsheet) images ─────────────────── */
.cs-page { position: relative; }
.cs-paper.is-editing [contenteditable='true'] { border-radius: 3px; }
.cs-paper.is-editing [contenteditable='true']:hover { outline: 1px dashed #c7d2fe; outline-offset: 2px; }
.cs-paper.is-editing [contenteditable='true']:focus { outline: 1.5px solid #6366f1; outline-offset: 2px; }
/* User-placed images: absolutely positioned on their page; interactive only in
   edit mode. Handles are stripped from the exported PDF (onclone + is-exporting). */
.cs-img { position: absolute; z-index: 5; line-height: 0; }
.cs-img img { width: 100%; height: auto; display: block; }
.cs-paper.is-editing .cs-img { cursor: move; outline: 1px dashed #94a3b8; touch-action: none; }
.cs-paper.is-editing .cs-img:hover,
.cs-paper.is-editing .cs-img.is-active { outline: 1.5px solid #6366f1; }
.cs-img-del {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #334155;
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
  display: none;
}
.cs-img-del:hover { background: #fee2e2; color: #b91c1c; border-color: #fca5a5; }
.cs-img-resize {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1.5px solid #6366f1;
  background: #fff;
  cursor: nwse-resize;
  display: none;
}
.cs-paper.is-editing .cs-img-del,
.cs-paper.is-editing .cs-img-resize { display: block; }
.cs-paper.is-exporting .cs-img-del,
.cs-paper.is-exporting .cs-img-resize { display: none !important; }
.cs-paper.is-exporting .cs-img { outline: none !important; }
.cs-paper.is-exporting [contenteditable='true'] { outline: none !important; }
@media print { .cs-img-del, .cs-img-resize { display: none !important; } }
/* A run of normal blocks → a multi-column band; the columns are exact equal
   widths (flex: 1 + min-width: 0) so nothing overflows the page. */
.cs-cols { display: flex; align-items: flex-start; margin-bottom: 12px; }
.cs-cols:last-child { margin-bottom: 0; }
.cs-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
/* SCREEN ONLY drop-target fill (export keeps flex-start / no grow, see above):
   stretch makes every column as tall as its band so the empty area below a short
   column is part of the droppable .cs-col; the last band grows to fill the rest
   of the page, turning the big blank band at the bottom into a drop target.
   flex: 0 0 auto on the other bands stops them being shrunk/clipped. */
.cs-paper:not(.is-exporting) .cs-cols,
.cs-paper:not(.is-exporting) .cs-band-wide { flex: 0 0 auto; }
.cs-paper:not(.is-exporting) .cs-cols { align-items: stretch; }
.cs-paper:not(.is-exporting) .cs-cols:last-child { flex: 1 1 auto; }
/* A visible drop target spawned on table-only / leftover-space pages so a section
   can be dragged there even when the page has no normal column band. */
.cs-dropzone { flex: 1 1 auto; min-height: 60px; }
.cs-dropzone .cs-col { min-height: 60px; }
.cs-paper:not(.is-exporting) .cs-dropzone .cs-col {
  border: 1px dashed #cbd5e1;
  border-radius: 6px;
}
.cs-paper.is-exporting .cs-dropzone { display: none; }
/* Continuation label: shown atop a column where a split section resumes. Small,
   muted, with a hairline rule — clearly a "continued", not a new heading. */
.cs-cont {
  font-size: 0.74em;
  font-weight: 600;
  font-style: italic;
  color: #6b7280;
  border-top: 1px dotted #cbd5e1;
  padding-top: 3px;
  margin-bottom: 1px;
  break-inside: avoid;
}
.cs-band-wide { margin-bottom: 12px; }
.cs-band-wide:last-child { margin-bottom: 0; }
.cs-page .cs-block { margin: 0; }
/* Content styling targets .cs-paper (not .cs-paper-body) so it applies in BOTH
   the JS paged layout (.cs-page > .cs-page-inner) and the multicol fallback. */
.cs-paper .katex-display,
.cs-paper .md-table,
.cs-paper li { break-inside: avoid; page-break-inside: avoid; }
.cs-paper h2,
.cs-paper h3 { break-after: avoid; page-break-after: avoid; }
.cs-paper h2 {
  font-size: 0.92rem;
  font-weight: 700;
  color: #111827;
  margin: 4px 0 4px;
  padding-bottom: 2px;
  border-bottom: 1px solid #d1d5db;
}
.cs-paper h3 { font-size: 0.82rem; font-weight: 700; margin: 6px 0 2px; }
.cs-paper p { margin: 3px 0; }
.cs-paper ul, .cs-paper ol { margin: 3px 0 3px; padding-left: 16px; }
.cs-paper li { margin: 1px 0; }
.cs-paper .katex { font-size: 0.95em; }
/* A wide formula must scroll/clip WITHIN its own box, never push the column
   (and thus the page) wider. max-width caps it to the column. */
.cs-paper .katex-display { margin: 4px 0; max-width: 100%; overflow-x: auto; }
.cs-paper .katex-display > .katex { max-width: 100%; }
/* GFM tables — comparison/classification grids. A wide multi-column table CANNOT
   shrink below its min-content width, so inside a ~1/3-wide CSS column it would
   overflow and overlap the next column. Two structural guards make overlap
   impossible, regardless of render engine (the PDF is html2canvas of the real
   browser layout):
     1) table-layout: fixed + word-wrap → the table can never be wider than its
        container; long cell text wraps instead of forcing the table wider.
     2) a block that CONTAINS a table spans ALL columns (.cs-block--wide, tagged
        in JS), so comparison tables get the full landscape width and read well. */
.md-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin: 5px 0;
  font-size: 0.94em;
  break-inside: avoid;
}
.md-table th, .md-table td {
  border: 1px solid #d1d5db;
  padding: 2px 6px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: break-word;
  word-break: break-word;
  hyphens: auto;
}
/* A section that contains a table breaks out of the multi-column flow and spans
   the full page width, so the table is never crammed into one narrow column. */
.cs-paper-body .cs-block--wide {
  column-span: all;
  -webkit-column-span: all;
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 6px 0 14px;
}
.md-table thead th {
  background: #f1f5f9;
  font-weight: 700;
  color: #111827;
}
.md-table tbody tr:nth-child(even) td { background: #f8fafc; }
/* Inline (dark card) result view keeps the same shape on a dark surface. */
.cs-sheet-body .md-table th, .cs-sheet-body .md-table td { border-color: var(--border, #334155); }
.cs-sheet-body .md-table thead th { background: rgba(255, 255, 255, 0.06); color: var(--text, #e2e8f0); }
.cs-sheet-body .md-table tbody tr:nth-child(even) td { background: rgba(255, 255, 255, 0.03); }
/* Print-friendly marker colors on white */
.cs-paper .cs-hl { background: #fef08a; color: #111827; }
.cs-paper .cs-key { color: #1d4ed8; }
.cs-paper .cs-warn { color: #b91c1c; }
.cs-paper .cs-note { color: #b45309; }

.cs-paper[data-style="compact"] {
  line-height: 1.22;
}
.cs-paper[data-style="compact"] .cs-paper-head {
  margin-bottom: 9px;
  padding-bottom: 5px;
}
.cs-paper[data-style="compact"] .cs-block {
  margin-bottom: 8px;
}
.cs-paper[data-style="classic"] {
  font-family: Georgia, "Times New Roman", serif;
}
.cs-paper[data-style="classic"] .cs-paper-body {
  column-rule-color: #cbd5e1;
}
.cs-paper[data-style="modern"] h2 {
  border-bottom-color: #2563eb;
}

@media (max-width: 1100px) { .cs-paper-body { column-count: 3; } }
@media (max-width: 820px)  { .cs-paper-body { column-count: 2; } }
@media (max-width: 560px)  { .cs-paper-body { column-count: 1; } }

/* Pages carry their own 10mm padding, so the print margin is 0 in paged mode. */
@page {
  size: A4 landscape;
  margin: 0;
}

@media print {
  .cs-paper-overlay,
  .cs-paper-scroll {
    position: static;
    display: block;
    overflow: visible;
    padding: 0;
    background: #fff;
  }
  .cs-paper-bar,
  .cs-section-tools,
  .cs-settings,
  .cs-controls {
    display: none;
  }
  .cs-paper {
    width: auto;
    min-height: auto;
    padding: 0;
    box-shadow: none;
    border-radius: 0;
  }
  /* Multicol fallback (engine off): restore the page margin via paper padding. */
  .cs-paper:not(.is-paged) { padding: 10mm; }
  .cs-page {
    box-shadow: none;
    border-radius: 0;
    margin: 0;
    break-after: page;
  }
  .cs-page:last-child { break-after: auto; }
}

/* Saved cheatsheets */
.cs-saved-wrap { margin-bottom: 18px; }
.cs-saved-head {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 8px;
}
.cs-saved-list { display: flex; flex-direction: column; gap: 6px; }
.cs-saved-item { display: flex; align-items: stretch; gap: 6px; }
.cs-saved-open {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: var(--card-inner, rgba(255, 255, 255, 0.04));
  color: var(--text, #e2e8f0);
  font-size: 0.88rem;
  cursor: pointer;
  text-align: left;
}
.cs-saved-open:hover { background: rgba(255, 255, 255, 0.07); }
.cs-saved-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-saved-date { flex: 0 0 auto; opacity: 0.55; font-size: 0.8rem; }
.cs-saved-del {
  flex: 0 0 auto;
  width: 34px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: transparent;
  color: var(--text, #e2e8f0);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}
.cs-saved-del:hover { background: rgba(248, 113, 113, 0.15); color: #fca5a5; opacity: 1; }

/* Unified course-tool redesign */
.cs-root {
  --cs-accent: #6366f1;
  --cs-accent-2: #0ea5e9;
  --cs-surface: color-mix(in srgb, var(--card, #0f172a) 88%, transparent);
  --cs-nested: var(--card-inner, rgba(255, 255, 255, 0.05));
  --cs-line: var(--border, #1e293b);
  display: grid;
  gap: 14px;
}

.cs-head {
  display: grid;
  gap: 4px;
}

.cs-head h2 {
  color: var(--text, #e2e8f0);
  letter-spacing: 0;
}

.cs-head p {
  color: var(--muted, #94a3b8);
  opacity: 1;
}

.cs-settings,
.cs-controls,
.cs-saved-wrap,
.cs-sheet,
.cs-msg,
.cs-build {
  border: 1px solid var(--cs-line);
  border-radius: 12px;
  background: var(--cs-surface);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

.cs-settings,
.cs-controls {
  padding: 14px;
  margin-bottom: 0;
}

.cs-controls {
  align-items: stretch;
}

.cs-topic {
  border-radius: 10px;
}

.cs-preset {
  border-radius: 10px;
  font-weight: 750;
}

.cs-preset.is-active,
.cs-btn-primary {
  background: linear-gradient(135deg, var(--cs-accent), var(--cs-accent-2));
  border-color: transparent;
  color: #fff;
  box-shadow: 0 12px 28px rgba(99, 102, 241, 0.18);
}

.cs-opt {
  color: var(--muted, #94a3b8);
  opacity: 1;
}

.cs-opt select,
.cs-topic {
  background: var(--cs-nested);
  border-color: var(--cs-line);
  color: var(--text, #e2e8f0);
}

.cs-sheet,
.cs-build {
  padding: 16px;
}

.cs-sheet-head {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--cs-line);
}

.cs-progress-section {
  padding: 12px 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}

.cs-progress-section:last-child {
  border-bottom: 0;
}

.cs-section-tools {
  opacity: 1;
}

.cs-section-tools button {
  border-radius: 7px;
  color: var(--muted, #94a3b8);
}

.cs-saved-wrap {
  padding: 14px;
}

body:not(.night) .cs-root {
  --cs-accent: #2563eb;
  --cs-accent-2: #0ea5e9;
  --cs-surface: var(--lm-card-bg);
  --cs-nested: var(--lm-nested-bg);
  --cs-line: var(--lm-card-border);
  color: var(--lm-text);
}

body:not(.night) .cs-head h2,
body:not(.night) .cs-sheet-head h3,
body:not(.night) .cs-saved-title,
body:not(.night) .cs-build-title {
  color: var(--lm-text) !important;
}

body:not(.night) .cs-head p,
body:not(.night) .cs-opt,
body:not(.night) .cs-saved-date,
body:not(.night) .cs-topics,
body:not(.night) .cs-sources,
body:not(.night) .cs-sources-label,
body:not(.night) .cs-build-step {
  color: var(--lm-muted) !important;
}

body:not(.night) .cs-settings,
body:not(.night) .cs-controls,
body:not(.night) .cs-saved-wrap,
body:not(.night) .cs-sheet,
body:not(.night) .cs-msg,
body:not(.night) .cs-build {
  background: var(--lm-card-bg) !important;
  border-color: var(--lm-card-border) !important;
  box-shadow: var(--lm-card-shadow) !important;
  color: var(--lm-text) !important;
}

body:not(.night) .cs-topic,
body:not(.night) .cs-opt select,
body:not(.night) .cs-preset,
body:not(.night) .cs-view-print,
body:not(.night) .cs-sheet-edit,
body:not(.night) .cs-md-ta,
body:not(.night) .cs-md-cancel,
body:not(.night) .cs-saved-open,
body:not(.night) .cs-section-tools button {
  background: var(--lm-nested-bg) !important;
  border-color: var(--lm-nested-border) !important;
  color: var(--lm-text) !important;
  box-shadow: var(--lm-nested-shadow) !important;
}

body:not(.night) .cs-preset:hover,
body:not(.night) .cs-view-print:hover,
body:not(.night) .cs-sheet-edit:hover,
body:not(.night) .cs-md-cancel:hover,
body:not(.night) .cs-saved-open:hover,
body:not(.night) .cs-section-tools button:hover {
  background: rgba(239, 246, 255, 0.96) !important;
  border-color: var(--lm-card-border-strong) !important;
}

body:not(.night) .cs-preset.is-active,
body:not(.night) .cs-btn-primary {
  color: #fff !important;
  border-color: rgba(37, 99, 235, 0.70) !important;
  background: linear-gradient(135deg, #2563eb, #0ea5e9) !important;
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.22) !important;
}

body:not(.night) .cs-cite-warn {
  background: rgba(245, 158, 11, 0.10) !important;
  border-left-color: rgba(245, 158, 11, 0.55) !important;
  color: #92400e !important;
}

/* Progressive generation */
.cs-build {
  padding: 16px 18px;
  border: 1px solid var(--border, #1e293b);
  border-radius: 10px;
  background: var(--card, #0f172a);
}
.cs-build-title {
  margin-bottom: 12px;
  font-weight: 700;
}
.cs-build-steps {
  display: grid;
  gap: 8px;
}
.cs-build-step {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--muted, #94a3b8);
  font-size: 0.88rem;
}
.cs-step-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 1px solid #64748b;
}
.cs-build-step.is-active {
  color: var(--text, #e2e8f0);
}
.cs-build-step.is-active .cs-step-dot {
  border-color: #93c5fd;
  background: #60a5fa;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.14);
}
.cs-build-step.is-done .cs-step-dot {
  border-color: #34d399;
  background: #34d399;
}
.cs-writing-line {
  margin: 4px 0 12px;
  color: #93c5fd;
  font-size: 0.82rem;
  font-weight: 700;
}
.cs-progress-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
  animation: csFadeIn 180ms ease-out;
}
.cs-progress-section:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.cs-section-writing {
  color: var(--muted, #94a3b8);
  font-size: 0.86rem;
}
.cs-view-print:disabled {
  opacity: 0.45;
  cursor: default;
}
@keyframes csFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
`;
