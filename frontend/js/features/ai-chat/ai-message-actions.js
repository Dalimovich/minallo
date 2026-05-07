export function copyBubble(btn) {
  var bubble = btn.closest('.msg-body').querySelector('.ai-bubble');
  var text = bubble.innerText || bubble.textContent;
  var orig = btn.textContent;
  function done() {
    btn.textContent = '✅';
    setTimeout(function () {
      btn.textContent = orig;
    }, 1400);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(function () {
        fallbackCopy(text);
        done();
      });
  } else {
    fallbackCopy(text);
    done();
  }
}

export function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}

export function regenMsg(btn) {
  var wrap = btn.closest('.ai-msg-wrap');
  var q = wrap.getAttribute('data-q');
  if (!q) return;
  if (typeof window.stopGeneration === 'function') window.stopGeneration();
  var next = wrap.nextElementSibling;
  while (next && !next.classList.contains('user')) {
    var rem = next;
    next = next.nextElementSibling;
    rem.remove();
  }
  var sendBtn = document.getElementById('aiSend');
  if (sendBtn) sendBtn.disabled = false;
  if (typeof window.askAI === 'function') window.askAI(q, true, { forceRefresh: true });
}

export function bindMessageActionButtons(wrap) {
  if (!wrap) return wrap;
  wrap.querySelectorAll('.msg-action-btn[data-action="copy"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      copyBubble(btn);
    });
  });
  wrap.querySelectorAll('.msg-action-btn[data-action="regen"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      regenMsg(btn);
    });
  });
  return wrap;
}

export function addBotMsg(text) {
  var aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!aiMsgs) return null;
  var wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap';
  var t = getTime();
  var _botHtml = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(text) : text;
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
    '<div class="msg-body">' +
    '<div class="ai-bubble bot">' +
    _botHtml +
    '</div>' +
    '<div class="msg-meta">' +
    '<span class="msg-time">' +
    t +
    '</span>' +
    '<button class="msg-action-btn" data-action="copy">' +
    (window._t ? window._t('copy_btn') : 'Copy') +
    '</button>' +
    '</div>' +
    '</div>';
  bindMessageActionButtons(wrap);
  aiMsgs.appendChild(wrap);
  // Store raw markdown so serializeChatDOM reads text, not KaTeX HTML
  var _botBubble = wrap.querySelector('.ai-bubble.bot');
  if (_botBubble) {
    _botBubble.setAttribute('data-raw', text);
    // Apply KaTeX to any math in this message
    if (window._ssEnsureKatex) {
      window._ssEnsureKatex().then(function () {
        if (window._renderMath && _botBubble) window._renderMath(_botBubble);
      }).catch(function () {});
    }
  }
  var msgBody = wrap.querySelector('.msg-body');
  if (msgBody && typeof window._aiResponseActions === 'function')
    msgBody.appendChild(window._aiResponseActions(text, 'panel'));
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  return wrap;
}

export function addUserMsg(text) {
  var aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!aiMsgs) return null;
  if (typeof window._statsTrackAI === 'function') window._statsTrackAI();
  var wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap user';
  var t = getTime();
  var safe = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  wrap.innerHTML =
    '<div class="msg-sender user-sender"><span class="msg-sender-dot"></span>' +
    (window._t ? window._t('you_label') : 'You') +
    '</div>' +
    '<div class="msg-body">' +
    '<div class="ai-bubble user">' +
    safe +
    '</div>' +
    '<div class="msg-meta">' +
    '<span class="msg-time">' +
    t +
    '</span>' +
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

export function setAiChipsVisible(v) {
  var el = document.querySelector('.ai-chips');
  if (el) el.style.display = v ? '' : 'none';
  if (!v) {
    var lbl = document.getElementById('aiFileLabel');
    if (lbl) lbl.textContent = window._t ? window._t('ai_ready') : 'Ready to help';
    var chip = document.getElementById('aiFileChip');
    if (chip) chip.classList.add('empty');
    var chipName = document.getElementById('aiFileChipName');
    if (chipName) chipName.textContent = window._t ? window._t('no_file_open') : 'No file open';
  }
}

function getTime() {
  var d = new Date();
  return (
    d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  );
}
window.getTime = getTime;

// Reads the current AI panel message history from the DOM.
// Used by askAI to include prior messages as context.
export function serializeChatDOM() {
  var msgs = [];
  var aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!aiMsgs) return msgs;
  aiMsgs.querySelectorAll('.ai-msg-wrap').forEach(function (wrap) {
    if (wrap.classList.contains('typing-wrap')) return;
    if (wrap.getAttribute('data-restored') === 'true') return;
    var bubble = wrap.querySelector('.ai-bubble');
    if (!bubble) return;
    var role = bubble.classList.contains('user') ? 'user' : 'assistant';
    // Prefer data-raw (original markdown) over innerText which is garbled by KaTeX HTML
    var text = (bubble.getAttribute('data-raw') || bubble.innerText || bubble.textContent || '').trim();
    if (text) msgs.push({ role: role, text: text });
  });
  return msgs;
}
window.serializeChatDOM = serializeChatDOM;
