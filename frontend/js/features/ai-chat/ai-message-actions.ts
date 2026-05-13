export function copyBubble(btn: HTMLElement): void {
  const body = btn.closest('.msg-body');
  const bubble = body?.querySelector('.ai-bubble') as HTMLElement | null;
  if (!bubble) return;
  const text = bubble.innerText || bubble.textContent || '';
  const orig = btn.textContent || '';
  function done(): void {
    btn.textContent = '✅';
    setTimeout(() => {
      btn.textContent = orig;
    }, 1400);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => {
        fallbackCopy(text);
        done();
      });
  } else {
    fallbackCopy(text);
    done();
  }
}

export function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* ignore — older browsers */
  }
  document.body.removeChild(ta);
}

export function regenMsg(btn: HTMLElement): void {
  const wrap = btn.closest('.ai-msg-wrap') as HTMLElement | null;
  if (!wrap) return;
  const q = wrap.getAttribute('data-q');
  if (!q) return;
  if (typeof window.stopGeneration === 'function') window.stopGeneration();
  let next = wrap.nextElementSibling;
  while (next && !next.classList.contains('user')) {
    const rem = next;
    next = next.nextElementSibling;
    rem.remove();
  }
  const sendBtn = document.getElementById('aiSend') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
  if (typeof window.askAI === 'function') window.askAI(q, true, { forceRefresh: true });
}

export function bindMessageActionButtons<T extends HTMLElement | null>(wrap: T): T {
  if (!wrap) return wrap;
  wrap.querySelectorAll<HTMLElement>('.msg-action-btn[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', () => copyBubble(btn));
  });
  wrap.querySelectorAll<HTMLElement>('.msg-action-btn[data-action="regen"]').forEach((btn) => {
    btn.addEventListener('click', () => regenMsg(btn));
  });
  return wrap;
}

function getTime(): string {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}
window.getTime = getTime;

export function addBotMsg(text: string): HTMLElement | null {
  const aiMsgs =
    document.getElementById('aiMsgs') || (document.querySelector('.ai-msgs') as HTMLElement | null);
  if (!aiMsgs) return null;
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap';
  const t = getTime();
  const botHtml = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(text) : text;
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
    '<div class="msg-body">' +
    '<div class="ai-bubble bot">' + botHtml + '</div>' +
    '<div class="msg-meta">' +
    '<span class="msg-time">' + t + '</span>' +
    '<button class="msg-action-btn" data-action="copy">' +
    (window._t ? window._t('copy_btn') : 'Copy') +
    '</button>' +
    '</div>' +
    '</div>';
  bindMessageActionButtons(wrap);
  aiMsgs.appendChild(wrap);
  const botBubble = wrap.querySelector('.ai-bubble.bot') as HTMLElement | null;
  if (botBubble) {
    botBubble.setAttribute('data-raw', text);
    if (window._ssEnsureKatex) {
      window
        ._ssEnsureKatex()
        .then(() => {
          if (window._renderMath && botBubble) window._renderMath(botBubble);
        })
        .catch(() => {});
    }
  }
  const msgBody = wrap.querySelector('.msg-body') as HTMLElement | null;
  if (msgBody && typeof window._aiResponseActions === 'function') {
    const actions = window._aiResponseActions(text, 'panel') as Node | null;
    if (actions) msgBody.appendChild(actions);
  }
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  return wrap;
}

export function addUserMsg(text: string): HTMLElement | null {
  const aiMsgs =
    document.getElementById('aiMsgs') || (document.querySelector('.ai-msgs') as HTMLElement | null);
  if (!aiMsgs) return null;
  if (typeof window._statsTrackAI === 'function') window._statsTrackAI();
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap user';
  const t = getTime();
  const safe = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  wrap.innerHTML =
    '<div class="msg-sender user-sender"><span class="msg-sender-dot"></span>' +
    (window._t ? window._t('you_label') : 'You') +
    '</div>' +
    '<div class="msg-body">' +
    '<div class="ai-bubble user">' + safe + '</div>' +
    '<div class="msg-meta">' +
    '<span class="msg-time">' + t + '</span>' +
    '<button class="msg-action-btn user-btn" data-action="copy">Copy</button>' +
    '<button class="msg-action-btn user-btn" data-action="regen">Regenerate</button>' +
    '</div>' +
    '</div>';
  wrap.setAttribute('data-q', text);
  bindMessageActionButtons(wrap);
  aiMsgs.appendChild(wrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  return wrap;
}

export function setAiChipsVisible(v: boolean): void {
  const el = document.querySelector('.ai-chips') as HTMLElement | null;
  if (el) el.style.display = v ? '' : 'none';
  if (!v) {
    const lbl = document.getElementById('aiFileLabel');
    if (lbl) lbl.textContent = window._t ? window._t('ai_ready') : 'Ready to help';
    const chip = document.getElementById('aiFileChip');
    if (chip) chip.classList.add('empty');
    const chipName = document.getElementById('aiFileChipName');
    if (chipName) chipName.textContent = window._t ? window._t('no_file_open') : 'No file open';
  }
}

export function serializeChatDOM(): Array<{ role: string; text: string }> {
  const msgs: Array<{ role: string; text: string }> = [];
  const aiMsgs =
    document.getElementById('aiMsgs') || (document.querySelector('.ai-msgs') as HTMLElement | null);
  if (!aiMsgs) return msgs;
  aiMsgs.querySelectorAll('.ai-msg-wrap').forEach((wrap) => {
    if (wrap.classList.contains('typing-wrap')) return;
    if (wrap.getAttribute('data-restored') === 'true') return;
    const bubble = wrap.querySelector('.ai-bubble') as HTMLElement | null;
    if (!bubble) return;
    const role = bubble.classList.contains('user') ? 'user' : 'assistant';
    const text = (
      bubble.getAttribute('data-raw') ||
      bubble.innerText ||
      bubble.textContent ||
      ''
    ).trim();
    if (text) msgs.push({ role, text });
  });
  return msgs;
}
window.serializeChatDOM = serializeChatDOM;
