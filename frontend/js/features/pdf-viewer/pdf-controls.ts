export interface PdfControlsOptions {
  getPdfPage: () => number;
  setPdfPage: (n: number) => void;
  getPdfTotal: () => number;
  getPdfScale: () => number;
  setPdfScale: (n: number) => void;
  getPdfShowAll: () => boolean;
  setPdfShowAll: (v: boolean) => void;
  getActiveFileName: () => string | null;
  showSelectionBanner: (text: string) => void;
  updatePageInfo: () => void;
  renderPages: () => void;
  downloadFile: (fname: string) => unknown;
}

export function initPdfControls(options: PdfControlsOptions): {
  updateZoomPct: () => void;
  pdfVisiblePage: () => number;
  pdfScrollToPage: (n: number) => void;
} {
  function updateZoomPct(): void {
    const el = document.getElementById('pdfZoomPct');
    if (el) el.textContent = Math.round(options.getPdfScale() * 100) + '%';
  }

  function pdfVisiblePage(): number {
    if (!options.getPdfShowAll()) return options.getPdfPage();
    const body = document.getElementById('pdfBody');
    if (!body) return options.getPdfPage();
    const scrollTop = body.scrollTop;
    const wraps = body.querySelectorAll<HTMLElement>('.pdf-page-wrap');
    let best = options.getPdfPage();
    let bestDist = Infinity;
    wraps.forEach((w) => {
      const dist = Math.abs(w.offsetTop - scrollTop);
      if (dist < bestDist) {
        bestDist = dist;
        best = parseInt(w.dataset.pageNum || '', 10) || options.getPdfPage();
      }
    });
    return best;
  }

  function pdfScrollToPage(num: number): void {
    const body = document.getElementById('pdfBody');
    if (!body) return;
    const wrap = body.querySelector<HTMLElement>('[data-page-num="' + num + '"]');
    if (wrap) body.scrollTop = wrap.offsetTop;
  }

  const pdfBody = document.getElementById('pdfBody');
  pdfBody?.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 3) {
        options.showSelectionBanner(sel.toString().trim());
      }
    }, 30);
  });

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  pdfBody?.addEventListener('scroll', () => {
    if (!options.getPdfShowAll()) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(options.updatePageInfo, 80);
  });

  document.getElementById('pdfPrev')?.addEventListener('click', () => {
    if (options.getPdfPage() > 1) {
      options.setPdfPage(options.getPdfPage() - 1);
      options.setPdfShowAll(false);
      options.updatePageInfo();
      options.renderPages();
    }
  });

  document.getElementById('pdfNext')?.addEventListener('click', () => {
    if (options.getPdfPage() < options.getPdfTotal()) {
      options.setPdfPage(options.getPdfPage() + 1);
      options.setPdfShowAll(false);
      options.updatePageInfo();
      options.renderPages();
    }
  });

  const inp = document.getElementById('pdfPageInput') as HTMLInputElement | null;
  if (inp) {
    inp.addEventListener('focus', function (this: HTMLInputElement) {
      this.select();
    });
    inp.addEventListener('keydown', function (this: HTMLInputElement, e: KeyboardEvent) {
      if (e.key === 'Enter') {
        this.blur();
        return;
      }
      if (e.key === 'Escape') {
        this.value = String(options.getPdfShowAll() ? pdfVisiblePage() : options.getPdfPage());
        this.blur();
      }
    });
    inp.addEventListener('blur', function (this: HTMLInputElement) {
      const n = parseInt(this.value, 10);
      if (n >= 1 && n <= options.getPdfTotal() && options.getPdfTotal() > 0) {
        options.setPdfPage(n);
        options.setPdfShowAll(false);
        options.updatePageInfo();
        options.renderPages();
      } else {
        this.value = String(options.getPdfShowAll() ? pdfVisiblePage() : options.getPdfPage());
      }
    });
  }

  document.getElementById('pdfZoomIn')?.addEventListener('click', () => {
    const pg = pdfVisiblePage();
    options.setPdfScale(Math.min(Math.round((options.getPdfScale() + 0.1) * 10) / 10, 3));
    updateZoomPct();
    options.renderPages();
    setTimeout(() => pdfScrollToPage(pg), 120);
  });

  document.getElementById('pdfZoomOut')?.addEventListener('click', () => {
    const pg = pdfVisiblePage();
    options.setPdfScale(Math.max(Math.round((options.getPdfScale() - 0.1) * 10) / 10, 0.2));
    updateZoomPct();
    options.renderPages();
    setTimeout(() => pdfScrollToPage(pg), 120);
  });

  document.getElementById('pdfFit')?.addEventListener('click', () => {
    const pg = pdfVisiblePage();
    options.setPdfScale(0.9);
    updateZoomPct();
    options.renderPages();
    setTimeout(() => pdfScrollToPage(pg), 120);
  });

  document.getElementById('pdfDownload')?.addEventListener('click', () => {
    const fileName = options.getActiveFileName();
    if (fileName) options.downloadFile(fileName);
  });

  document.getElementById('pdfBack')?.addEventListener('click', () => {
    const w = window as unknown as {
      activeCourseRef?: { id?: string } & Record<string, unknown>;
      activeFileName?: string | null;
      pdfDoc?: unknown;
      pdfFullText?: string;
      _setAiChipsVisible?: (visible: boolean) => void;
      showCourseSection?: (course: unknown, section: string) => void;
      showPortalSection?: (section: string) => void;
    };
    if (w.activeCourseRef && typeof w.showCourseSection === 'function') {
      // Clear file state BEFORE delegating to showCourseSection. Its
      // router.js wrapper calls saveState() immediately after, which
      // reads activeFileName/pdfDoc and persists them to ss_state. If
      // we don't clear first, ss_state keeps pointing at the file and
      // reload sends the user back into the PDF reader. The matching
      // goPortal handler in router.js does the same cleanup.
      w.activeFileName = null;
      w.pdfDoc = null;
      w.pdfFullText = '';
      if (typeof w._setAiChipsVisible === 'function') w._setAiChipsVisible(false);
      const pdfView = document.getElementById('pdfView');
      const courseOverview = document.getElementById('courseOverview');
      if (pdfView) pdfView.style.display = 'none';
      if (courseOverview) courseOverview.style.display = 'block';
      w.showCourseSection(w.activeCourseRef, 'files');
      return;
    }
    if (typeof w.showPortalSection === 'function') w.showPortalSection('courses');
  });

  document.getElementById('pdfAll')?.addEventListener('click', () => {
    options.setPdfShowAll(!options.getPdfShowAll());
    const btn = document.getElementById('pdfAll');
    if (btn) btn.textContent = options.getPdfShowAll() ? 'Single page' : 'All pages';
    options.renderPages();
  });

  window.updateZoomPct = updateZoomPct;
  window._pdfVisiblePage = pdfVisiblePage;
  window._pdfScrollToPage = pdfScrollToPage;

  return { updateZoomPct, pdfVisiblePage, pdfScrollToPage };
}
