export interface ChatAttachmentView {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  textContent?: string;
  fileId?: string;
  documentId?: string;
  courseId?: string;
  currentPage?: number;
  status?: 'uploading' | 'processing' | 'ready' | 'failed';
  refreshPreviewUrl?: () => Promise<string>;
}

const esc = (value: string): string => value.replace(/[&<>'"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]!));

export function formatAttachmentSize(bytes?: number): string {
  if (!Number.isFinite(bytes) || !bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function attachmentType(item: ChatAttachmentView): string {
  const ext = item.name.split('.').pop()?.toUpperCase() || 'FILE';
  if (item.mimeType === 'application/pdf' || ext === 'PDF') return 'PDF';
  if (item.mimeType?.startsWith('image/')) return ext === 'JPEG' ? 'JPG' : ext;
  if (ext === 'MD') return 'Markdown';
  if (ext === 'TXT') return 'Text';
  return ext;
}

export function renderAttachmentCard(item: ChatAttachmentView, messageId?: string): string {
  const type = attachmentType(item);
  const image = item.mimeType?.startsWith('image/') && item.dataUrl;
  const metadata = [type, formatAttachmentSize(item.size)].filter(Boolean).join(' · ');
  const preview = image
    ? `<img class="chat-file-card__thumbnail" src="${esc(item.dataUrl!)}" alt="Preview of ${esc(item.name)}" loading="lazy">`
    : `<span class="chat-file-card__type chat-file-card__type--${type.toLowerCase()}">${esc(type.length <= 4 ? type : 'DOC')}</span>`;
  const status = item.status && item.status !== 'ready'
    ? `<span class="chat-file-card__status chat-file-card__status--${item.status}">${esc(item.status)}</span>` : '';
  return `<button type="button" class="chat-file-card chat-file-card--${type.toLowerCase()}" data-chat-attachment-id="${esc(item.id)}" data-file-id="${esc(item.fileId || '')}" data-message-id="${esc(messageId || '')}" title="${esc(item.name)}" aria-label="Open ${esc(item.name)}">
    <span class="chat-file-card__preview">${preview}</span>
    <span class="chat-file-card__content"><span class="chat-file-card__filename">${esc(item.name)}</span><span class="chat-file-card__metadata">${esc(metadata)}</span></span>
    ${status}<span class="chat-file-card__action" aria-hidden="true">Open <span>›</span></span>
  </button>`;
}

let activeOverlay: HTMLElement | null = null;

export function openAttachmentViewer(
  item: ChatAttachmentView,
  trigger: HTMLElement,
  onAsk: (question: string, item: ChatAttachmentView) => Promise<void>
): void {
  activeOverlay?.remove();
  const type = attachmentType(item);
  const overlay = document.createElement('div');
  overlay.className = 'chat-file-viewer-overlay';
  overlay.setAttribute('role', 'presentation');
  const isImage = item.mimeType?.startsWith('image/') && item.dataUrl;
  const isPdf = (item.mimeType === 'application/pdf' || type === 'PDF') && item.dataUrl;
  const body = isImage
    ? `<div class="chat-file-viewer__image-stage"><img class="chat-file-viewer__image" src="${esc(item.dataUrl!)}" alt="${esc(item.name)}"></div>`
    : isPdf
      ? `<section class="chat-file-viewer__pdf" data-testid="chat-file-pdf-host">
          <nav class="chat-file-viewer__pdf-toolbar" aria-label="PDF controls">
            <button type="button" data-pdf-action="previous" aria-label="Previous page">‹</button>
            <span><input type="number" min="1" value="1" aria-label="Current page"> / <b>–</b></span>
            <button type="button" data-pdf-action="next" aria-label="Next page">›</button>
            <button type="button" data-pdf-action="zoom-out" aria-label="Zoom out">−</button>
            <button type="button" data-pdf-action="fit">Fit</button>
            <button type="button" data-pdf-action="zoom-in" aria-label="Zoom in">+</button>
          </nav>
          <div class="chat-file-viewer__pdf-stage"><div class="chat-file-viewer__pdf-status">Resolving file…</div><canvas hidden></canvas></div>
        </section>`
      : item.textContent != null
        ? `<pre class="chat-file-viewer__text">${esc(item.textContent)}</pre>`
        : `<div class="chat-file-viewer__unsupported"><span>${esc(type)}</span><p>A preview is not available for this file type.</p></div>`;
  overlay.innerHTML = `<section class="chat-file-viewer" role="dialog" aria-modal="true" aria-labelledby="chatFileViewerTitle">
    <header class="chat-file-viewer__header"><span class="chat-file-card__type">${esc(type.length <= 4 ? type : 'DOC')}</span><span class="chat-file-viewer__details"><strong id="chatFileViewerTitle" title="${esc(item.name)}">${esc(item.name)}</strong><small>${esc([type, formatAttachmentSize(item.size)].filter(Boolean).join(' · '))}</small></span><button type="button" class="chat-file-viewer__close" aria-label="Close viewer">×</button></header>
    <main class="chat-file-viewer__body">${body}</main>
    <footer class="chat-file-viewer__composer"><textarea rows="2" placeholder="Ask Minallo about this file…" aria-label="Ask Minallo about this file"></textarea><div class="chat-file-viewer__composer-row"><span>${esc(item.name)}${item.currentPage ? ` · Page ${item.currentPage}` : ''}</span><button type="button" class="chat-file-viewer__send">Send <span aria-hidden="true">↑</span></button></div><p class="chat-file-viewer__error" role="alert" hidden></p></footer>
  </section>`;
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  const dialog = overlay.querySelector<HTMLElement>('.chat-file-viewer')!;
  const close = (): void => { overlay.remove(); activeOverlay = null; trigger.focus(); };
  overlay.querySelector<HTMLButtonElement>('.chat-file-viewer__close')!.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
    if (ev.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button,textarea,iframe,[tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  const textarea = overlay.querySelector<HTMLTextAreaElement>('textarea')!;
  const send = overlay.querySelector<HTMLButtonElement>('.chat-file-viewer__send')!;
  const error = overlay.querySelector<HTMLElement>('.chat-file-viewer__error')!;
  if (isPdf) void mountPdfJsViewer(overlay, item, error);
  const submit = async (): Promise<void> => {
    const question = textarea.value.trim();
    if (!question || send.disabled) return;
    send.disabled = true; error.hidden = true;
    try { await onAsk(question, item); textarea.value = ''; close(); }
    catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Could not send this question.'; error.hidden = false; send.disabled = false; }
  };
  send.addEventListener('click', () => { void submit(); });
  textarea.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void submit(); } });
  window.requestAnimationFrame(() => textarea.focus());
}

interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void>; cancel?: () => void };
}

interface PdfDocumentLike {
  numPages: number;
  getPage(page: number): Promise<PdfPageLike>;
  destroy?: () => Promise<void>;
}

async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`PDF request failed (HTTP ${response.status})`);
  return response.arrayBuffer();
}

async function mountPdfJsViewer(overlay: HTMLElement, item: ChatAttachmentView, error: HTMLElement): Promise<void> {
  const host = overlay.querySelector<HTMLElement>('.chat-file-viewer__pdf');
  const stage = overlay.querySelector<HTMLElement>('.chat-file-viewer__pdf-stage');
  const status = overlay.querySelector<HTMLElement>('.chat-file-viewer__pdf-status');
  const canvas = overlay.querySelector<HTMLCanvasElement>('.chat-file-viewer__pdf canvas');
  const pageInput = overlay.querySelector<HTMLInputElement>('.chat-file-viewer__pdf-toolbar input');
  const pageTotal = overlay.querySelector<HTMLElement>('.chat-file-viewer__pdf-toolbar b');
  if (!host || !stage || !status || !canvas || !pageInput || !pageTotal) return;

  let source = item.dataUrl!;
  let bytes: ArrayBuffer;
  try {
    status.textContent = 'Loading PDF…';
    try {
      bytes = await fetchPdfBytes(source);
    } catch (firstError) {
      if (!item.refreshPreviewUrl) throw firstError;
      source = await item.refreshPreviewUrl();
      item.dataUrl = source;
      bytes = await fetchPdfBytes(source);
    }
    await window._ssEnsurePdfJs?.();
    if (!window.pdfjsLib) throw new Error('PDF.js could not be loaded.');
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise as PdfDocumentLike;
    pageTotal.textContent = String(pdf.numPages);
    pageInput.max = String(pdf.numPages);
    let pageNumber = Math.min(Math.max(item.currentPage || 1, 1), pdf.numPages);
    let zoom = 1;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;

    const render = async (fit = false): Promise<void> => {
      renderTask?.cancel?.();
      status.hidden = false;
      status.textContent = `Rendering page ${pageNumber} of ${pdf.numPages}…`;
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      if (fit) zoom = Math.min(2.5, Math.max(0.35, (stage.clientWidth - 40) / base.width));
      const viewport = page.getViewport({ scale: zoom });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      renderTask = page.render({ canvasContext: context, viewport });
      await renderTask.promise;
      if (!overlay.isConnected) return;
      canvas.hidden = false;
      status.hidden = true;
      pageInput.value = String(pageNumber);
      item.currentPage = pageNumber;
      const composerContext = overlay.querySelector<HTMLElement>('.chat-file-viewer__composer-row > span');
      if (composerContext) composerContext.textContent = `${item.name} · Page ${pageNumber}`;
    };

    host.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pdf-action]')?.dataset.pdfAction;
      if (!action) return;
      if (action === 'previous') pageNumber = Math.max(1, pageNumber - 1);
      if (action === 'next') pageNumber = Math.min(pdf.numPages, pageNumber + 1);
      if (action === 'zoom-out') zoom = Math.max(0.35, zoom - 0.15);
      if (action === 'zoom-in') zoom = Math.min(3, zoom + 0.15);
      void render(action === 'fit').catch(showPdfError);
    });
    pageInput.addEventListener('change', () => {
      pageNumber = Math.min(pdf.numPages, Math.max(1, Number(pageInput.value) || 1));
      void render().catch(showPdfError);
    });
    const observer = new ResizeObserver(() => { if (overlay.isConnected) void render(true).catch(showPdfError); });
    observer.observe(stage);
    new MutationObserver(() => { if (!overlay.isConnected) { observer.disconnect(); renderTask?.cancel?.(); void pdf.destroy?.(); } }).observe(document.body, { childList: true });
    await render(true);
  } catch (cause) {
    showPdfError(cause);
  }

  function showPdfError(cause: unknown): void {
    status!.hidden = false;
    status!.textContent = cause instanceof Error ? `Could not open this PDF. ${cause.message}` : 'Could not open this PDF.';
    error.textContent = 'The PDF preview could not be loaded. Close and reopen the attachment to retry.';
    error.hidden = false;
  }
}
