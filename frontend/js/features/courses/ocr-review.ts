// OCR review / correction modal.
//
// Opened from the 🟡 "needs review" status dot on a course file. Lists the
// pages the OCR pipeline flagged for review (handwriting pages, or pages with
// [unclear] markers / low confidence) and lets the student fix the extracted
// text. Saving sends the correction to /api/documents/correct-page, which
// updates the page and re-embeds the document so retrieval uses the fix.

import { escapeHtml } from '../../utils/escape-html.js';
import type { OcrReviewPage } from '../../services/ai-service.js';

type AiServiceModule = typeof import('../../services/ai-service.js');
let _aiServicePromise: Promise<AiServiceModule> | null = null;
function _aiService(): Promise<AiServiceModule> {
  if (!_aiServicePromise) {
    _aiServicePromise = import('../../services/ai-service.js');
  }
  return _aiServicePromise;
}

function _toast(title: string, sub?: string): void {
  window.showToast?.(title, sub);
}

let _openOverlay: HTMLElement | null = null;

export async function openOcrReviewModal(
  courseId: string,
  documentId: string,
  fileName: string
): Promise<void> {
  // Only one at a time.
  if (_openOverlay) _close();

  const overlay = document.createElement('div');
  overlay.className = 'ocr-review-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.55);padding:16px;';

  overlay.innerHTML =
    '<div class="ocr-review-modal" style="background:var(--bg-card,#fff);color:var(--text,#111);' +
    'max-width:760px;width:100%;max-height:88vh;display:flex;flex-direction:column;' +
    'border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden;">' +
      '<div style="display:flex;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid rgba(127,127,127,.2);">' +
        '<div style="flex:1;min-width:0;">' +
          '<h2 style="margin:0;font-size:1.05rem;">Review OCR text</h2>' +
          '<p style="margin:4px 0 0;font-size:.82rem;opacity:.7;word-break:break-word;">' +
            escapeHtml(fileName) +
          '</p>' +
        '</div>' +
        '<button class="ocr-review-close" aria-label="Close" ' +
          'style="border:0;background:transparent;font-size:1.4rem;cursor:pointer;line-height:1;color:inherit;">×</button>' +
      '</div>' +
      '<div class="ocr-review-body" style="padding:16px 20px;overflow:auto;">' +
        '<p style="opacity:.7;font-size:.9rem;">Loading flagged pages…</p>' +
      '</div>';

  document.body.appendChild(overlay);
  _openOverlay = overlay;

  overlay.querySelector<HTMLButtonElement>('.ocr-review-close')
    ?.addEventListener('click', () => _close());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) _close();
  });
  document.addEventListener('keydown', _onKeydown);

  const body = overlay.querySelector<HTMLElement>('.ocr-review-body')!;

  try {
    const mod = await _aiService();
    const pages = await mod.getDocumentReviewPages(documentId);
    if (overlay !== _openOverlay) return; // closed while loading
    _renderPages(body, courseId, documentId, pages);
  } catch (e: unknown) {
    if (overlay !== _openOverlay) return;
    const msg = e instanceof Error ? e.message : String(e);
    body.innerHTML =
      '<p style="color:#c0392b;font-size:.9rem;">Could not load pages: ' +
      escapeHtml(msg) + '</p>';
  }
}

function _renderPages(
  body: HTMLElement,
  courseId: string,
  documentId: string,
  pages: OcrReviewPage[]
): void {
  if (!pages.length) {
    body.innerHTML =
      '<p style="opacity:.8;font-size:.92rem;">No individual pages are flagged for review. ' +
      'If this document still extracts poorly, try re-indexing it from the file’s status dot.</p>';
    return;
  }

  const intro =
    '<p style="margin:0 0 14px;font-size:.88rem;opacity:.8;">' +
    'These pages were transcribed by OCR and may contain mistakes. Fix the text ' +
    'below and save — the document is re-indexed so the AI uses your corrected version. ' +
    'Leave <code>[unclear]</code> where text is genuinely unreadable.</p>';

  const cards = pages.map((p) => _pageCardHtml(p)).join('');
  body.innerHTML = intro + cards;

  pages.forEach((p) => {
    const card = body.querySelector<HTMLElement>(
      '.ocr-review-card[data-page="' + p.pageNumber + '"]'
    );
    if (!card) return;
    const textarea = card.querySelector<HTMLTextAreaElement>('textarea')!;
    const saveBtn = card.querySelector<HTMLButtonElement>('.ocr-review-save')!;
    const statusEl = card.querySelector<HTMLElement>('.ocr-review-status')!;

    saveBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) {
        statusEl.textContent = 'Text cannot be empty.';
        statusEl.style.color = '#c0392b';
        return;
      }
      saveBtn.disabled = true;
      textarea.disabled = true;
      saveBtn.textContent = 'Saving…';
      statusEl.style.color = '';
      statusEl.textContent = '';
      try {
        const mod = await _aiService();
        await mod.correctDocumentPage(courseId, documentId, p.pageNumber, text);
        card.dataset.saved = 'true';
        saveBtn.textContent = 'Saved ✓';
        statusEl.style.color = '#27ae60';
        statusEl.textContent = 'Saved — re-indexing in the background.';
        _toast('Correction saved', 'Page ' + p.pageNumber + ' re-indexing…');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        saveBtn.disabled = false;
        textarea.disabled = false;
        saveBtn.textContent = 'Save page ' + p.pageNumber;
        statusEl.style.color = '#c0392b';
        statusEl.textContent = msg;
      }
    });
  });
}

function _pageCardHtml(p: OcrReviewPage): string {
  const meta: string[] = ['Page ' + p.pageNumber];
  if (p.mode === 'handwriting') meta.push('handwriting');
  else if (p.provider) meta.push(escapeHtml(p.provider));
  if (typeof p.confidence === 'number') {
    meta.push(Math.round(p.confidence * 100) + '% confidence');
  }
  if (p.unclearCount) meta.push(p.unclearCount + ' unclear');

  return (
    '<div class="ocr-review-card" data-page="' + p.pageNumber + '" ' +
      'style="border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:12px;margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">' +
        '<strong style="font-size:.85rem;opacity:.85;">' + meta.join(' · ') + '</strong>' +
      '</div>' +
      '<textarea spellcheck="true" ' +
        'style="width:100%;min-height:150px;resize:vertical;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
        'padding:10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);' +
        'background:var(--bg-input,#fafafa);color:inherit;box-sizing:border-box;">' +
        escapeHtml(p.text) +
      '</textarea>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">' +
        '<button class="ocr-review-save" ' +
          'style="border:0;border-radius:8px;padding:7px 14px;font-size:.85rem;cursor:pointer;' +
          'background:var(--accent,#4f46e5);color:#fff;">Save page ' + p.pageNumber + '</button>' +
        '<span class="ocr-review-status" style="font-size:.8rem;"></span>' +
      '</div>' +
    '</div>'
  );
}

function _onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') _close();
}

function _close(): void {
  document.removeEventListener('keydown', _onKeydown);
  if (_openOverlay?.parentNode) _openOverlay.parentNode.removeChild(_openOverlay);
  _openOverlay = null;
}
