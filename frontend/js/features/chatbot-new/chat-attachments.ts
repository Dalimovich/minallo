export interface ChatAttachmentView {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  textContent?: string;
  fileId?: string;
  courseId?: string;
  currentPage?: number;
  status?: 'uploading' | 'processing' | 'ready' | 'failed';
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

export function renderAttachmentCard(item: ChatAttachmentView): string {
  const type = attachmentType(item);
  const image = item.mimeType?.startsWith('image/') && item.dataUrl;
  const metadata = [type, formatAttachmentSize(item.size)].filter(Boolean).join(' · ');
  const preview = image
    ? `<img class="chat-file-card__thumbnail" src="${esc(item.dataUrl!)}" alt="Preview of ${esc(item.name)}" loading="lazy">`
    : `<span class="chat-file-card__type chat-file-card__type--${type.toLowerCase()}">${esc(type.length <= 4 ? type : 'DOC')}</span>`;
  const status = item.status && item.status !== 'ready'
    ? `<span class="chat-file-card__status chat-file-card__status--${item.status}">${esc(item.status)}</span>` : '';
  return `<button type="button" class="chat-file-card" data-chat-attachment-id="${esc(item.id)}" title="${esc(item.name)}" aria-label="Open ${esc(item.name)}">
    <span class="chat-file-card__preview">${preview}</span>
    <span class="chat-file-card__content"><span class="chat-file-card__filename">${esc(item.name)}</span><span class="chat-file-card__metadata">${esc(metadata)}</span></span>
    ${status}<span class="chat-file-card__action">Open</span>
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
      ? `<iframe class="chat-file-viewer__pdf" src="${esc(item.dataUrl!)}#toolbar=1" title="${esc(item.name)}"></iframe>`
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
