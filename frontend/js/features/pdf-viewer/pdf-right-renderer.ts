import { getPane } from './pdf-panes.js';

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number; scale: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown; transform?: number[] | null }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
};

const STATE_KEY = 'minallo:pdfRightState:v1';

interface RightState {
  pdfDoc: PdfDoc | null;
  pdfPage: number;
  pdfScale: number;
  pdfShowAll: boolean;
  pdfTotal: number;
  renderedScale: number;
  observer: IntersectionObserver | null;
}

const state: RightState = {
  pdfDoc: null,
  pdfPage: 1,
  pdfScale: 0.9,
  pdfShowAll: true,
  pdfTotal: 0,
  renderedScale: 0.9,
  observer: null,
};

function persist(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      pdfPage: state.pdfPage,
      pdfScale: state.pdfScale,
      pdfShowAll: state.pdfShowAll,
    }));
  } catch { /* ignore */ }
}

function loadPersisted(): void {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as { pdfPage?: number; pdfScale?: number; pdfShowAll?: boolean };
    if (data.pdfPage && data.pdfPage > 0) state.pdfPage = data.pdfPage;
    if (data.pdfScale && data.pdfScale > 0.2 && data.pdfScale < 4) state.pdfScale = data.pdfScale;
    if (typeof data.pdfShowAll === 'boolean') state.pdfShowAll = data.pdfShowAll;
  } catch { /* ignore */ }
}

loadPersisted();

function bodyEl(): HTMLElement | null {
  return document.getElementById('pdfBodyRight');
}

function renderPageIntoWrap(wrap: HTMLElement, num: number): void {
  if (!state.pdfDoc) return;
  if (wrap.dataset.rendered === '1') return;
  wrap.dataset.rendered = '1';
  state.pdfDoc.getPage(num).then((page) => {
    const body = bodyEl();
    const cW = ((body && body.clientWidth) || wrap.clientWidth) - 32;
    const vp0 = page.getViewport({ scale: 1 });
    const scale = state.pdfScale * (cW / vp0.width);
    const vp = page.getViewport({ scale });
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';

    // Render at device pixel ratio for crisp text on high-DPI displays.
    // In split view the page is rendered at ~half width, so without DPR
    // scaling the text comes out blurry.
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const textDiv = document.createElement('div');
    textDiv.className = 'pdf-text-layer';
    textDiv.style.width = vp.width + 'px';
    textDiv.style.height = vp.height + 'px';
    wrap.insertBefore(textDiv, wrap.firstChild);
    wrap.insertBefore(canvas, textDiv);

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, transform }).promise.then(() => {
      return page.getTextContent();
    }).then((tc) => {
      textDiv.style.setProperty('--scale-factor', String(vp.scale));
      const pdfjs = window.pdfjsLib as unknown as {
        renderTextLayer: (opts: { textContentSource: unknown; container: HTMLElement; viewport: unknown; textDivs: unknown[] }) => { promise?: Promise<void> } | null;
      };
      const rl = pdfjs.renderTextLayer({
        textContentSource: tc,
        container: textDiv,
        viewport: vp,
        textDivs: [],
      });
      if (rl?.promise) rl.promise.catch(() => { /* ignore */ });
    });
  });
}

export function renderRightPages(): void {
  const body = bodyEl();
  if (!body || !state.pdfDoc) return;
  body.style.removeProperty('--pdf-wheel-zoom');
  state.renderedScale = state.pdfScale;
  body.innerHTML = '';
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  body.classList.add('pdf-body-right-rendered');

  updateRightToolbar();

  if (!state.pdfShowAll) {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.pageNum = String(state.pdfPage);
    body.appendChild(wrap);
    renderPageIntoWrap(wrap, state.pdfPage);
    return;
  }

  const pageCount = state.pdfTotal;
  state.pdfDoc.getPage(1).then((page1) => {
    const cW = body.clientWidth - 32;
    const vp0 = page1.getViewport({ scale: 1 });
    const scale = state.pdfScale * (cW / vp0.width);
    const vp = page1.getViewport({ scale });
    const phHeight = vp.height;

    for (let i = 1; i <= pageCount; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.pageNum = String(i);
      wrap.style.width = vp.width + 'px';
      wrap.style.height = phHeight + 'px';
      body.appendChild(wrap);
    }

    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const wrap = entry.target as HTMLElement;
          const num = parseInt(wrap.dataset.pageNum || '0', 10);
          if (num > 0) renderPageIntoWrap(wrap, num);
        }
      }
    }, { root: body, rootMargin: '300px 0px' });

    body.querySelectorAll<HTMLElement>('.pdf-page-wrap').forEach((w) => state.observer!.observe(w));
  });
}

export async function loadIntoRight(bytes: Uint8Array): Promise<void> {
  if (!window._ssEnsurePdfJs) return;
  await window._ssEnsurePdfJs();
  if (!window.pdfjsLib) return;
  const pdf = await window.pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true,
  }).promise as PdfDoc;
  state.pdfDoc = pdf;
  state.pdfTotal = pdf.numPages;
  if (state.pdfPage > pdf.numPages || state.pdfPage < 1) state.pdfPage = 1;
  const right = getPane('right');
  right.pdfDoc = pdf;
  right.pdfTotal = pdf.numPages;
  right.pdfPage = state.pdfPage;
  right.pdfScale = state.pdfScale;
  right.pdfShowAll = state.pdfShowAll;
  renderRightPages();
}

export function clearRight(): void {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  state.pdfDoc = null;
  state.pdfTotal = 0;
  const body = bodyEl();
  if (body) body.innerHTML = '';
  hideRightToolbar();
}

export function rightPrev(): void {
  if (!state.pdfDoc) return;
  if (state.pdfShowAll) return;
  if (state.pdfPage <= 1) return;
  state.pdfPage--;
  persist();
  renderRightPages();
}

export function rightNext(): void {
  if (!state.pdfDoc) return;
  if (state.pdfShowAll) return;
  if (state.pdfPage >= state.pdfTotal) return;
  state.pdfPage++;
  persist();
  renderRightPages();
}

export function rightZoomIn(): void {
  applyRightZoom(state.pdfScale + 0.1);
}

export function rightZoomOut(): void {
  applyRightZoom(state.pdfScale - 0.1);
}

export function rightToggleShowAll(): void {
  if (!state.pdfDoc) return;
  state.pdfShowAll = !state.pdfShowAll;
  persist();
  renderRightPages();
}

export function rightFit(): void {
  applyRightZoom(0.9);
}

function applyRightZoom(targetScale: number): void {
  if (!state.pdfDoc) return;
  const body = bodyEl();
  const previousScale = state.pdfScale;
  state.pdfScale = Math.min(3, Math.max(0.3, Math.round(targetScale * 100) / 100));
  if (state.pdfScale === previousScale) return;

  const previousTop = body?.scrollTop || 0;
  persist();
  if (body) {
    body.style.setProperty('--pdf-wheel-zoom', String(state.pdfScale / state.renderedScale));
  }
  updateRightToolbar();

  // Keep the content under the pointer at roughly the same vertical position,
  // matching the left viewer's anchored Ctrl/Cmd + wheel zoom behaviour.
  if (body && previousScale > 0) {
    body.scrollTop = previousTop * (state.pdfScale / previousScale);
  }
}

function bindRightWheelZoom(): void {
  const body = bodyEl();
  if (!body || body.dataset.wheelZoomBound === '1') return;
  body.dataset.wheelZoomBound = '1';
  body.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyRightZoom(state.pdfScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false }
  );
}

function updateRightToolbar(): void {
  const tb = document.getElementById('pdfRightToolbar');
  if (!tb) return;
  tb.hidden = false;
  const info = document.getElementById('pdfRightPageInfo');
  if (info) info.textContent = 'Page ' + state.pdfPage + ' / ' + state.pdfTotal;
  const zoom = document.getElementById('pdfRightZoomPct');
  if (zoom) zoom.textContent = Math.round(state.pdfScale * 100) + '%';
  const all = document.getElementById('pdfRightAll');
  if (all) all.textContent = state.pdfShowAll ? 'All pages' : 'Single page';
  const navStyle = state.pdfShowAll ? 'none' : 'inline-flex';
  const prev = document.getElementById('pdfRightPrev');
  const next = document.getElementById('pdfRightNext');
  if (prev) (prev as HTMLElement).style.display = navStyle;
  if (next) (next as HTMLElement).style.display = navStyle;
}

function hideRightToolbar(): void {
  const tb = document.getElementById('pdfRightToolbar');
  if (tb) tb.hidden = true;
}

function initRightToolbar(): void {
  const tb = document.getElementById('pdfRightToolbar');
  if (!tb) return;
  if ((tb as HTMLElement).dataset.bound === '1') return;
  (tb as HTMLElement).dataset.bound = '1';
  document.getElementById('pdfRightPrev')?.addEventListener('click', rightPrev);
  document.getElementById('pdfRightNext')?.addEventListener('click', rightNext);
  document.getElementById('pdfRightZoomIn')?.addEventListener('click', rightZoomIn);
  document.getElementById('pdfRightZoomOut')?.addEventListener('click', rightZoomOut);
  document.getElementById('pdfRightAll')?.addEventListener('click', rightToggleShowAll);
  document.getElementById('pdfRightFit')?.addEventListener('click', rightFit);
  bindRightWheelZoom();
}

function scheduleToolbarInit(): void {
  if (document.getElementById('pdfRightToolbar')) {
    initRightToolbar();
    return;
  }
  const obs = new MutationObserver(() => {
    if (document.getElementById('pdfRightToolbar')) {
      obs.disconnect();
      initRightToolbar();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleToolbarInit(), { once: true });
  } else {
    queueMicrotask(() => scheduleToolbarInit());
  }
}
