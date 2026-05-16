// New chatbot shell. Flag-gated behind localStorage.ss_new_chatbot === '1'.
// PR-01: hide #aipOuter, reveal #ncbRoot.
// PR-02: sidebar interactivity (collapse, chat-row selection, new chat, search).
// PR-03: conversation (input, send/pause, paste, render, abort).
// PR-04: AI bubble actions, import modal, context tabs, title gen.
// PR-05: chat store + persistence + multi-chat sidebar.
// PR-06: real markdown (KaTeX), file upload (img/.txt/.pdf), real Regenerate.
import { renderMarkdown } from '../ai-chat/ai-markdown.js';
export function initNewChatbotShell() {
    const newRoot = document.getElementById('ncbRoot');
    if (!newRoot)
        return;
    newRoot.hidden = false;
    newRoot.style.display = '';
    loadChatStore(); // PR-05 — must run before rendering sidebar or conversation.
    initSidebar(newRoot);
    initConversation(newRoot);
    initImportModal(newRoot);
    initContextTabs(newRoot);
    initContextCollapse(newRoot);
    initUploads(newRoot);
    initAiTools(newRoot);
    initClearAll(newRoot);
    initTextareaAutoSize(newRoot);
    initActionCards(newRoot);
    initKeyboardShortcuts(newRoot);
    initFullbleed();
    renderSidebar(newRoot);
    loadActiveChatIntoCenter(newRoot);
}
// PR-02 — sidebar behavior. Idempotent: each binding tags the node with
// data-ncb-bound so we don't double-bind across repeat init calls.
function initSidebar(root) {
    const sidebar = root.querySelector('.ncb-sidebar');
    if (!sidebar)
        return;
    bindCollapse(sidebar);
    bindChatItems(sidebar);
    bindNewChat(sidebar);
    bindSearch(sidebar);
}
function bindCollapse(sidebar) {
    const btn = sidebar.querySelector('.ncb-collapse-btn');
    if (!btn || btn.dataset.ncbBound === '1')
        return;
    btn.dataset.ncbBound = '1';
    btn.addEventListener('click', () => {
        const collapsed = sidebar.dataset.collapsed === 'true';
        setCollapsed(sidebar, !collapsed);
    });
}
function setCollapsed(sidebar, collapsed) {
    sidebar.dataset.collapsed = collapsed ? 'true' : 'false';
}
function bindChatItems(sidebar) {
    const list = sidebar.querySelector('.ncb-chat-list');
    if (!list || list.dataset.ncbBound === '1')
        return;
    list.dataset.ncbBound = '1';
    // Event delegation: re-renders of the list (PR-05) keep the binding alive.
    list.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!target)
            return;
        // PR-10: three-dots → open chat-row menu instead of selecting the chat.
        const moreBtn = target.closest('.ncb-chat-more');
        if (moreBtn) {
            ev.stopPropagation();
            const ownerItem = moreBtn.closest('.ncb-chat-item');
            const ownerId = ownerItem?.dataset.chatId;
            const root = sidebar.closest('.ncb-root');
            if (ownerId && root)
                openChatRowMenu(root, ownerId, moreBtn);
            return;
        }
        const item = target.closest('.ncb-chat-item');
        if (!item)
            return;
        if (sidebar.dataset.collapsed === 'true')
            setCollapsed(sidebar, false);
        const chatId = item.dataset.chatId;
        const root = sidebar.closest('.ncb-root');
        if (chatId && root) {
            switchActiveChat(root, chatId);
        }
        else {
            selectChatItem(list, item);
        }
    });
}
function selectChatItem(list, item) {
    list.querySelectorAll('.ncb-chat-item').forEach((el) => {
        el.classList.remove('ncb-chat-item--active');
    });
    item.classList.add('ncb-chat-item--active');
}
function bindNewChat(sidebar) {
    const btn = sidebar.querySelector('.ncb-new-chat-btn');
    if (!btn || btn.dataset.ncbBound === '1')
        return;
    btn.dataset.ncbBound = '1';
    btn.addEventListener('click', () => {
        if (sidebar.dataset.collapsed === 'true')
            setCollapsed(sidebar, false);
        const root = sidebar.closest('.ncb-root');
        if (!root)
            return;
        // PR-05: de-dupe — if there's already an empty draft chat, just switch to it
        // instead of creating a second one (matches the React preview's handleNewChat).
        const existingDraft = chatStore.chats.find((c) => c.messages.length === 0 && c.title === 'New chat');
        if (existingDraft) {
            switchActiveChat(root, existingDraft.id);
            return;
        }
        const created = chatStore.newChat();
        chatStore.activeId = created.id;
        saveChatStore();
        renderSidebar(root);
        loadActiveChatIntoCenter(root);
    });
}
function bindSearch(sidebar) {
    const input = sidebar.querySelector('.ncb-search-input');
    const list = sidebar.querySelector('.ncb-chat-list');
    if (!input || !list || input.dataset.ncbBound === '1')
        return;
    input.dataset.ncbBound = '1';
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const items = list.querySelectorAll('.ncb-chat-item');
        items.forEach((item) => {
            const titleEl = item.querySelector('.ncb-chat-title');
            const text = (titleEl?.textContent || '').toLowerCase();
            item.style.display = !q || text.includes(q) ? '' : 'none';
        });
        // Hide section labels whose section has no visible items.
        const labels = list.querySelectorAll('.ncb-chat-section-label');
        labels.forEach((label) => {
            let visible = 0;
            let sib = label.nextElementSibling;
            while (sib && !sib.classList.contains('ncb-chat-section-label')) {
                if (sib.classList.contains('ncb-chat-item') && sib.style.display !== 'none')
                    visible++;
                sib = sib.nextElementSibling;
            }
            label.style.display = visible === 0 ? 'none' : '';
        });
    });
}
function initConversation(root) {
    const stage = root.querySelector('.ncb-empty');
    const textarea = root.querySelector('.ncb-input-textarea');
    const sendBtn = root.querySelector('.ncb-send-btn');
    const pasteRow = root.querySelector('.ncb-paste-row');
    const msgs = root.querySelector('.ncb-msgs');
    if (!stage || !textarea || !sendBtn || !pasteRow || !msgs)
        return;
    if (stage.dataset.ncbConvBound === '1')
        return;
    stage.dataset.ncbConvBound = '1';
    // PR-05: state.messages is initialised to the active chat's messages array
    // by reference, and re-pointed on chat switch by loadActiveChatIntoCenter.
    // Pasted images / controller / isSending are transient and reset per chat.
    const state = getOrInitLiveState();
    state.messages = chatStore.getActive().messages;
    liveState = state;
    // Send / pause toggle
    sendBtn.addEventListener('click', () => {
        if (state.isSending) {
            abortSend(state);
        }
        else {
            void doSend(state, stage, textarea, sendBtn, pasteRow, msgs);
        }
    });
    // Enter to send (Shift+Enter = newline)
    textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            if (!state.isSending) {
                void doSend(state, stage, textarea, sendBtn, pasteRow, msgs);
            }
        }
    });
    // Paste inside textarea
    textarea.addEventListener('paste', (ev) => {
        const files = collectImageFiles(ev.clipboardData);
        if (files.length === 0)
            return;
        ev.preventDefault();
        void absorbPastedImages(files, state, pasteRow);
    });
    // Global paste when not in an input — only react when chatbot route is visible
    window.addEventListener('paste', (ev) => {
        if (root.hidden || root.offsetParent === null)
            return;
        const active = document.activeElement;
        const inField = !!active &&
            (active.tagName === 'TEXTAREA' ||
                active.tagName === 'INPUT' ||
                active.isContentEditable);
        if (inField)
            return;
        const files = collectImageFiles(ev.clipboardData);
        if (files.length === 0)
            return;
        ev.preventDefault();
        void absorbPastedImages(files, state, pasteRow);
    });
}
function collectImageFiles(cd) {
    if (!cd)
        return [];
    const out = [];
    for (let i = 0; i < cd.files.length; i++) {
        const f = cd.files[i];
        if (f && f.type && f.type.startsWith('image/'))
            out.push(f);
    }
    return out;
}
function readAsDataUrl(file) {
    return new Promise((resolve) => {
        try {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        }
        catch {
            resolve(null);
        }
    });
}
async function absorbPastedImages(files, state, pasteRow) {
    const added = [];
    for (const f of files) {
        const dataUrl = await readAsDataUrl(f);
        if (!dataUrl)
            continue;
        added.push({
            id: (f.name || 'pasted') +
                '-' +
                (f.lastModified || Date.now()) +
                '-' +
                Math.random().toString(36).slice(2, 8),
            name: f.name || 'Pasted screenshot',
            mediaType: f.type || 'image/png',
            dataUrl,
        });
    }
    if (!added.length)
        return;
    state.pasted.push(...added);
    renderPasteRow(state, pasteRow);
}
function renderPasteRow(state, pasteRow) {
    if (state.pasted.length === 0) {
        pasteRow.hidden = true;
        pasteRow.innerHTML = '';
        return;
    }
    pasteRow.hidden = false;
    pasteRow.innerHTML = state.pasted
        .map((img) => `
      <div class="ncb-paste-thumb" data-id="${escapeAttr(img.id)}" title="${escapeAttr(img.name)}">
        <img alt="${escapeAttr(img.name)}" src="${escapeAttr(img.dataUrl)}" />
        <button type="button" class="ncb-paste-remove" aria-label="Remove ${escapeAttr(img.name)}">
          <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    `)
        .join('');
    pasteRow.querySelectorAll('.ncb-paste-remove').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const wrap = btn.closest('.ncb-paste-thumb');
            const id = wrap?.dataset.id;
            if (!id)
                return;
            state.pasted = state.pasted.filter((p) => p.id !== id);
            renderPasteRow(state, pasteRow);
        });
    });
}
async function doSend(state, stage, textarea, sendBtn, pasteRow, msgs) {
    const text = textarea.value.trim();
    const images = state.pasted.slice();
    const files = state.files.slice();
    if (!text && images.length === 0 && files.length === 0)
        return;
    // Switch to active-chat state on first send
    if (stage.dataset.state !== 'active')
        stage.dataset.state = 'active';
    // Append user bubble
    state.messages.push({ role: 'user', text, images, files });
    appendUserBubble(msgs, text, images, files);
    touchActiveChat();
    saveChatStore();
    // Reset input
    textarea.value = '';
    state.pasted = [];
    state.files = [];
    renderPasteRow(state, pasteRow);
    renderFilesRow(stage.closest('.ncb-root'), state);
    await streamAiReply(state, sendBtn, msgs);
}
async function streamAiReply(state, sendBtn, msgs) {
    state.isSending = true;
    setSendBtnMode(sendBtn, 'pause');
    const aiRow = appendAiBubble(msgs);
    const bubble = aiRow.querySelector('.ncb-bubble-body');
    showTyping(bubble);
    const apiMessages = buildApiMessages(state.messages);
    const controller = new AbortController();
    state.controller = controller;
    try {
        const resp = await fetch('/api/ai', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + (getSbToken() || ''),
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                max_tokens: 6000,
                system: buildSystemPrompt(),
                messages: apiMessages,
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error('Server ' + resp.status + ': ' + errText.slice(0, 200));
        }
        const data = (await resp.json());
        const raw = data.error
            ? '❌ Error: ' + (data.error.message || JSON.stringify(data.error))
            : data.content
                ? data.content.map((b) => b.text || '').join('')
                : 'No response.';
        state.messages.push({ role: 'assistant', text: raw });
        touchActiveChat();
        saveChatStore();
        await typeIntoBubble(bubble, raw, () => controller.signal.aborted);
        appendBubbleActions(aiRow, raw);
        // After the first AI reply, ask the model for a 4-6 word title.
        if (state.messages.filter((m) => m.role === 'assistant').length === 1) {
            void generateChatTitle(state).then((title) => {
                if (title)
                    updateChatTitle(title);
            });
        }
    }
    catch (err) {
        if (bubble) {
            const isAbort = err?.name === 'AbortError';
            bubble.innerHTML = isAbort
                ? '<em class="ncb-bubble-aborted">Response stopped.</em>'
                : renderInlineMarkdown('❌ ' + (err?.message || 'Request failed.'));
            if (!isAbort)
                attachErrorRetry(aiRow, bubble);
        }
    }
    finally {
        state.controller = null;
        state.isSending = false;
        setSendBtnMode(sendBtn, 'send');
        scrollMsgsToBottom(msgs);
    }
}
function abortSend(state) {
    if (state.controller)
        state.controller.abort();
}
function appendUserBubble(msgs, text, images, files = []) {
    const row = document.createElement('div');
    row.className = 'ncb-msg-row ncb-msg-row--user';
    const attachments = images
        .map((img) => `<img class="ncb-bubble-image" src="${escapeAttr(img.dataUrl)}" alt="${escapeAttr(img.name)}" />`)
        .join('');
    const fileChips = files
        .map((f) => `<span class="ncb-bubble-file-chip"><svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>${escapeHtml(f.name)}</span>`)
        .join('');
    row.innerHTML = `
    <div class="ncb-bubble ncb-bubble--user">
      ${attachments ? `<div class="ncb-bubble-images">${attachments}</div>` : ''}
      ${fileChips ? `<div class="ncb-bubble-files">${fileChips}</div>` : ''}
      ${text ? `<p class="ncb-bubble-text">${escapeHtml(text)}</p>` : ''}
    </div>
  `;
    msgs.appendChild(row);
    scrollMsgsToBottom(msgs);
}
function appendAiBubble(msgs) {
    const row = document.createElement('div');
    row.className = 'ncb-msg-row ncb-msg-row--ai';
    row.innerHTML = `
    <div class="ncb-avatar" aria-hidden="true">
      <svg class="ncb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
        <path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>
      </svg>
    </div>
    <div class="ncb-bubble ncb-bubble--ai">
      <div class="ncb-bubble-head">
        <div>
          <p class="ncb-bubble-sender">Minallo AI</p>
          <p class="ncb-bubble-subtitle">Answered using course context</p>
        </div>
      </div>
      <div class="ncb-bubble-body"></div>
    </div>
  `;
    msgs.appendChild(row);
    scrollMsgsToBottom(msgs);
    return row;
}
function showTyping(bubble) {
    if (!bubble)
        return;
    bubble.innerHTML =
        '<span class="ncb-typing"><span class="ncb-typing-dot"></span><span class="ncb-typing-dot"></span><span class="ncb-typing-dot"></span></span>';
}
function typeIntoBubble(bubble, raw, isAborted) {
    return new Promise((resolve) => {
        if (!bubble) {
            resolve();
            return;
        }
        bubble.innerHTML = '';
        const words = raw.match(/\S+\s*/g) || [];
        let i = 0;
        const STEP = 2;
        const INTERVAL = 22;
        const tick = () => {
            if (isAborted()) {
                bubble.innerHTML = renderInlineMarkdown(words.slice(0, i).join('') || raw);
                resolve();
                return;
            }
            if (i >= words.length) {
                bubble.innerHTML = renderInlineMarkdown(raw);
                resolve();
                return;
            }
            i = Math.min(i + STEP, words.length);
            bubble.textContent = words.slice(0, i).join('');
            const msgs = bubble.closest('.ncb-msgs');
            if (msgs)
                scrollMsgsToBottom(msgs);
            window.setTimeout(tick, INTERVAL);
        };
        tick();
    });
}
function setSendBtnMode(btn, mode) {
    if (mode === 'pause') {
        btn.classList.add('ncb-send-btn--pause');
        btn.setAttribute('aria-label', 'Pause AI response');
        btn.innerHTML =
            '<svg class="ncb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
    }
    else {
        btn.classList.remove('ncb-send-btn--pause');
        btn.setAttribute('aria-label', 'Send message');
        btn.innerHTML =
            '<svg class="ncb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';
    }
}
function scrollMsgsToBottom(msgs) {
    const scroller = msgs.closest('.ncb-center');
    if (scroller)
        scroller.scrollTop = scroller.scrollHeight;
}
function buildApiMessages(messages) {
    // Mirror chatbot.js: keep last ~20 messages, and inline images as Claude-shaped image blocks.
    const trimmed = messages.slice(-20);
    return trimmed.map((m) => {
        if (m.role === 'assistant')
            return { role: 'assistant', content: m.text };
        const blocks = [];
        (m.images || []).forEach((img) => {
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: img.mediaType,
                    data: img.dataUrl.replace(/^data:[^;]+;base64,/, ''),
                },
            });
        });
        (m.files || []).forEach((f) => {
            if (f.kind === 'image' && f.base64 && f.mediaType) {
                blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: f.mediaType, data: f.base64 },
                });
            }
            else if (f.kind === 'text' && f.textContent) {
                blocks.push({
                    type: 'text',
                    text: '<document filename="' + f.name + '">\n' + f.textContent + '\n</document>',
                });
            }
            else {
                blocks.push({
                    type: 'text',
                    text: '(The file "' + f.name + '" is a binary format that could not be read as text.)',
                });
            }
        });
        if (m.text)
            blocks.push({ type: 'text', text: m.text });
        return {
            role: 'user',
            content: blocks.length === 1 && blocks[0].type === 'text'
                ? blocks[0].text
                : blocks,
        };
    });
}
function buildSystemPrompt() {
    const lang = window._lang === 'de' ? 'German' : 'English';
    return ('You are Minallo AI, a friendly and knowledgeable assistant for university students. Always reply in ' +
        lang +
        '. Answer any question clearly and helpfully. Be concise but thorough.\n\n' +
        'IMAGE POLICY: Any image the user uploads or pastes is part of their course material — a lecture slide, a textbook page, a screenshot of an exercise, a hand-written note, a diagram, a formula, or a chart. ' +
        'Help them understand it: read the text, transcribe equations, explain diagrams, work through the exercise, identify the concept, summarise the slide. Do NOT refuse with "I cannot help with identifying or analyzing the content of images" — that\'s wrong for this product. ' +
        'If the image is unclear, ask what specifically the student wants help with rather than refusing.\n\n' +
        'DOCUMENT TAGS: When the user\'s message contains <document> tags, those tags contain the FULL extracted text of an uploaded file. You CAN read and answer questions about this content — treat it as the complete document. Never say you cannot read a file when its content is provided inside <document> tags.');
}
function getSbToken() {
    return window._sbToken || null;
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttr(s) {
    return escapeHtml(s);
}
// PR-06: delegates to the shared ai-markdown renderer, which handles headings,
// code blocks, lists, blockquotes, inline emphasis, and KaTeX math.
function renderInlineMarkdown(raw) {
    return renderMarkdown(raw);
}
// ============ PR-04: AI bubble actions, import modal, context tabs, title gen ============
function appendBubbleActions(aiRow, raw) {
    if (aiRow.querySelector('.ncb-bubble-actions'))
        return;
    const bubble = aiRow.querySelector('.ncb-bubble--ai');
    if (!bubble)
        return;
    const bar = document.createElement('div');
    bar.className = 'ncb-bubble-actions';
    bar.innerHTML = `
    <button type="button" class="ncb-bubble-action" data-action="copy" title="Copy">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      <span>Copy</span>
    </button>
    <button type="button" class="ncb-bubble-action" data-action="regen" title="Regenerate">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      <span>Regenerate</span>
    </button>
    <button type="button" class="ncb-bubble-action" data-action="save" title="Bookmark this reply">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
      <span>Bookmark</span>
    </button>
    <button type="button" class="ncb-bubble-action ncb-bubble-action--icon" data-action="thumb-up" aria-label="Thumbs up">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7"/></svg>
    </button>
    <button type="button" class="ncb-bubble-action ncb-bubble-action--icon" data-action="thumb-down" aria-label="Thumbs down">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17"/></svg>
    </button>
  `;
    bubble.appendChild(bar);
    bar.addEventListener('click', (ev) => {
        const target = ev.target?.closest('.ncb-bubble-action');
        if (!target)
            return;
        const action = target.dataset.action;
        if (action === 'copy')
            copyToClipboard(raw, target);
        else if (action === 'regen')
            regenerateLast(aiRow);
        else if (action === 'save')
            saveReplyToNotes(aiRow, raw, target);
        else if (action === 'thumb-up' || action === 'thumb-down') {
            target.classList.add('ncb-bubble-action--picked');
        }
    });
}
function copyToClipboard(text, btn) {
    try {
        void navigator.clipboard.writeText(text).then(() => flashAck(btn, 'Copied'));
    }
    catch {
        // older browsers — fall through quietly
    }
}
function regenerateLast(aiRow) {
    const root = aiRow.closest('.ncb-root');
    if (!root)
        return;
    regenerateLastReal(aiRow, root);
}
function flashAck(btn, msg) {
    const label = btn.querySelector('span');
    if (!label) {
        btn.classList.add('ncb-bubble-action--ack');
        window.setTimeout(() => btn.classList.remove('ncb-bubble-action--ack'), 1200);
        return;
    }
    const prev = label.textContent;
    label.textContent = msg;
    btn.classList.add('ncb-bubble-action--ack');
    window.setTimeout(() => {
        label.textContent = prev;
        btn.classList.remove('ncb-bubble-action--ack');
    }, 1200);
}
function getSems() {
    const w = window;
    return w.SEMS || w._SEMS || {};
}
function getActiveSemId() {
    const w = window;
    return w.activeSemesterId || w._activeSemesterId;
}
function listCourses() {
    const sems = getSems();
    const active = getActiveSemId();
    const seen = new Set();
    const out = [];
    const push = (c) => {
        if (!c || !c.id || seen.has(c.id))
            return;
        seen.add(c.id);
        out.push(c);
    };
    if (active && sems[active])
        (sems[active].courses || []).forEach(push);
    Object.keys(sems).forEach((sid) => {
        if (sid === active)
            return;
        (sems[sid].courses || []).forEach(push);
    });
    return out;
}
function courseLabel(c) {
    return c.name || c.title || c.id || 'Untitled course';
}
function initImportModal(root) {
    const trigger = root.querySelector('.ncb-import-btn');
    const overlay = document.getElementById('ncbImportModal');
    if (!trigger || !overlay || trigger.dataset.ncbBound === '1')
        return;
    trigger.dataset.ncbBound = '1';
    const closeBtn = overlay.querySelector('.ncb-modal-close');
    const cancelBtn = overlay.querySelector('.ncb-modal-cancel');
    const importBtn = overlay.querySelector('.ncb-modal-import');
    const select = overlay.querySelector('.ncb-modal-select');
    const searchInput = overlay.querySelector('.ncb-modal-search-input');
    const listEl = overlay.querySelector('.ncb-folder-list');
    const crumb = overlay.querySelector('.ncb-folder-breadcrumb');
    const crumbPath = overlay.querySelector('.ncb-folder-crumb-path');
    const crumbBack = overlay.querySelector('.ncb-folder-back');
    const countLabel = overlay.querySelector('.ncb-modal-count');
    if (!select || !listEl)
        return;
    // Modal-local state — reset every time the modal opens.
    const picked = new Map();
    let activeCourse = null;
    let activeFolder = null;
    let searchTerm = '';
    const syncCount = () => {
        const n = picked.size;
        const word = n === 1 ? 'item' : 'items';
        if (countLabel) {
            countLabel.innerHTML = `<span class="ncb-modal-count-num">${n}</span> ${word} selected`;
        }
        if (importBtn)
            importBtn.disabled = n === 0;
    };
    const renderEmpty = (msg) => {
        listEl.innerHTML = `<p class="ncb-folder-empty">${escapeHtml(msg)}</p>`;
    };
    const renderList = () => {
        if (!activeCourse) {
            renderEmpty('Open a course on Minallo first to import its files here.');
            if (crumb)
                crumb.hidden = true;
            return;
        }
        const q = searchTerm.toLowerCase();
        const courseId = activeCourse.id;
        if (activeFolder) {
            const files = (activeFolder.files || []).filter((f) => !q || (f.name || '').toLowerCase().includes(q));
            if (crumb)
                crumb.hidden = false;
            if (crumbPath)
                crumbPath.textContent = activeFolder.name;
            if (!files.length) {
                renderEmpty('No files in this folder.');
                return;
            }
            listEl.innerHTML = files.map((f) => fileRow(f, courseId, activeFolder.id)).join('');
        }
        else {
            if (crumb)
                crumb.hidden = true;
            const folders = (activeCourse.userFolders || []).filter((fd) => !q || (fd.name || '').toLowerCase().includes(q));
            const rootFiles = (activeCourse.files || []).filter((f) => !q || (f.name || '').toLowerCase().includes(q));
            if (!folders.length && !rootFiles.length) {
                renderEmpty(searchTerm ? 'No matches.' : 'No files in this course.');
                return;
            }
            const folderHtml = folders.map((fd) => folderRow(fd, courseId)).join('');
            const fileHtml = rootFiles.map((f) => fileRow(f, courseId, '')).join('');
            listEl.innerHTML = folderHtml + fileHtml;
        }
        bindRows();
    };
    const fileRow = (f, courseId, folderId) => {
        const itemId = courseId + ':' + folderId + ':' + f.name;
        const sel = picked.has(itemId);
        return `
      <div class="ncb-folder-row ncb-folder-row--file ${sel ? 'ncb-folder-row--selected' : ''}"
           data-kind="file" data-item-id="${escapeAttr(itemId)}"
           data-name="${escapeAttr(f.name)}" data-meta="File" role="button" tabindex="0">
        <span class="ncb-folder-icon ncb-folder-icon--file">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
        </span>
        <div class="ncb-folder-text">
          <p class="ncb-folder-name">${escapeHtml(f.name)}</p>
          <p class="ncb-folder-sub">File</p>
        </div>
        <span class="ncb-folder-pick">
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? 'hidden' : ''}><path d="M20 6 9 17l-5-5"/></svg>
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? '' : 'hidden'}><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      </div>`;
    };
    const folderRow = (fd, courseId) => {
        const itemId = courseId + ':folder:' + fd.id;
        const sel = picked.has(itemId);
        const count = (fd.files || []).length;
        const meta = count + ' file' + (count === 1 ? '' : 's');
        return `
      <div class="ncb-folder-row ${sel ? 'ncb-folder-row--selected' : ''}"
           data-kind="folder" data-folder-id="${escapeAttr(fd.id)}"
           data-item-id="${escapeAttr(itemId)}"
           data-name="${escapeAttr(fd.name)}" data-meta="${escapeAttr(meta)}"
           role="button" tabindex="0">
        <span class="ncb-folder-icon">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>
        </span>
        <div class="ncb-folder-text">
          <p class="ncb-folder-name">${escapeHtml(fd.name)}</p>
          <p class="ncb-folder-sub">Folder</p>
        </div>
        <span class="ncb-folder-count">${escapeHtml(meta)}</span>
        <button type="button" class="ncb-folder-open" aria-label="Open ${escapeAttr(fd.name)}">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <span class="ncb-folder-pick">
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? 'hidden' : ''}><path d="M20 6 9 17l-5-5"/></svg>
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? '' : 'hidden'}><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      </div>`;
    };
    const togglePick = (rowEl) => {
        const id = rowEl.dataset.itemId;
        const kind = rowEl.dataset.kind;
        if (!id || !kind || !activeCourse)
            return;
        if (picked.has(id)) {
            picked.delete(id);
            rowEl.classList.remove('ncb-folder-row--selected');
        }
        else {
            picked.set(id, {
                id,
                kind,
                name: rowEl.dataset.name || '',
                meta: rowEl.dataset.meta || '',
                courseId: activeCourse.id,
            });
            rowEl.classList.add('ncb-folder-row--selected');
        }
        const chev = rowEl.querySelector('.ncb-folder-pick-chev');
        const check = rowEl.querySelector('.ncb-folder-pick-check');
        if (chev)
            chev.hidden = picked.has(id);
        if (check)
            check.hidden = !picked.has(id);
        syncCount();
    };
    const drillInto = (folderId) => {
        if (!activeCourse)
            return;
        const fd = (activeCourse.userFolders || []).find((x) => x.id === folderId);
        if (!fd)
            return;
        activeFolder = fd;
        searchTerm = '';
        if (searchInput)
            searchInput.value = '';
        renderList();
    };
    const bindRows = () => {
        listEl.querySelectorAll('.ncb-folder-row').forEach((row) => {
            // Open arrow on folders drills in without toggling selection.
            const openBtn = row.querySelector('.ncb-folder-open');
            openBtn?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const fid = row.dataset.folderId;
                if (fid)
                    drillInto(fid);
            });
            row.addEventListener('click', () => togglePick(row));
        });
    };
    // Open/close lifecycle
    const open = () => {
        picked.clear();
        activeFolder = null;
        searchTerm = '';
        if (searchInput)
            searchInput.value = '';
        // PR-10: eagerly hydrate any course whose folder list is empty so the
        // user doesn't have to "open the course first" before importing.
        void eagerlyHydrateCourses(() => {
            if (overlay.hidden) return;
            renderList();
        });
        // Build the course list each open so newly-added courses appear.
        const courses = listCourses();
        select.innerHTML = courses.length
            ? courses.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(courseLabel(c))}</option>`).join('')
            : '<option value="">No courses loaded</option>';
        activeCourse = courses[0] || null;
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        renderList();
        syncCount();
    };
    const close = () => {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
    };
    select.addEventListener('change', () => {
        const courses = listCourses();
        activeCourse = courses.find((c) => c.id === select.value) || null;
        activeFolder = null;
        picked.clear();
        syncCount();
        renderList();
        if (activeCourse && (!activeCourse.userFolders || activeCourse.userFolders.length === 0)) {
            const w = window;
            if (w._ufMerge) {
                try {
                    Promise.resolve(w._ufMerge(activeCourse))
                        .then(() => { if (!overlay.hidden) renderList(); })
                        .catch(() => { /* ignore */ });
                }
                catch { /* ignore */ }
            }
        }
    });
    searchInput?.addEventListener('input', () => {
        searchTerm = searchInput.value.trim();
        renderList();
    });
    crumbBack?.addEventListener('click', () => {
        activeFolder = null;
        searchTerm = '';
        if (searchInput)
            searchInput.value = '';
        renderList();
    });
    trigger.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    cancelBtn?.addEventListener('click', close);
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay)
            close();
    });
    document.addEventListener('keydown', (ev) => {
        if (!overlay.hidden && ev.key === 'Escape')
            close();
    });
    importBtn?.addEventListener('click', () => {
        if (!picked.size)
            return;
        const items = Array.from(picked.values()).map((p) => ({
            id: p.courseId + ':' + p.id, // stable, scoped to course so two courses can each have "lecture"
            name: p.name,
            count: p.meta,
        }));
        attachImportedFolders(root, items);
        close();
    });
}
function attachImportedFolders(root, folders) {
    const row = root.querySelector('.ncb-attach-row');
    if (!row)
        return;
    // PR-05: persist into active chat's attachedFolders, then render from there.
    const active = chatStore.getActive();
    const existingIds = new Set(active.attachedFolders.map((f) => f.id));
    folders.forEach((f) => {
        if (!existingIds.has(f.id))
            active.attachedFolders.push(f);
    });
    saveChatStore();
    renderAttachChips(root);
    updateContextPill(root);
}
function updateContextPill(root) {
    const pill = root.querySelector('.ncb-chat-context-pill');
    if (!pill)
        return;
    const active = chatStore.getActive();
    const folders = active.attachedFolders;
    if (!folders.length) {
        pill.hidden = true;
        pill.textContent = '';
        return;
    }
    const first = folders[0].name;
    pill.textContent = folders.length === 1
        ? first
        : first + ' +' + (folders.length - 1) + ' more';
    pill.hidden = false;
}
function renderAttachChips(root) {
    const row = root.querySelector('.ncb-attach-row');
    if (!row)
        return;
    const active = chatStore.getActive();
    if (!active.attachedFolders.length) {
        row.hidden = true;
        row.innerHTML = '';
        return;
    }
    row.innerHTML = active.attachedFolders
        .map((f) => `
      <span class="ncb-attach-chip" data-id="${escapeAttr(f.id)}">
        <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>
        <span class="ncb-attach-chip-name">${escapeHtml(f.name)}</span>
        <span class="ncb-attach-chip-meta">${escapeHtml(f.count)}</span>
        <button type="button" class="ncb-attach-chip-x" aria-label="Remove ${escapeAttr(f.name)}">
          <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </span>
    `)
        .join('');
    row.hidden = false;
    row.querySelectorAll('.ncb-attach-chip-x').forEach((x) => {
        x.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const id = x.closest('.ncb-attach-chip')?.dataset.id;
            if (!id)
                return;
            const active2 = chatStore.getActive();
            active2.attachedFolders = active2.attachedFolders.filter((f) => f.id !== id);
            saveChatStore();
            renderAttachChips(root);
            updateContextPill(root);
        });
    });
}
// ---- Context-panel tabs ----
function initContextTabs(root) {
    const tabs = Array.from(root.querySelectorAll('.ncb-mini-tab'));
    if (!tabs.length || tabs[0]?.dataset.ncbBound === '1')
        return;
    const sourcesCard = root.querySelector('.ncb-sources-card');
    const notesCard = root.querySelector('.ncb-notes-card');
    tabs.forEach((tab, idx) => {
        tab.dataset.ncbBound = '1';
        tab.dataset.tabIdx = String(idx);
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('ncb-mini-tab--active'));
            tab.classList.add('ncb-mini-tab--active');
            const label = (tab.querySelector('span')?.textContent || '').trim();
            const showNotes = label === 'Notes';
            // PR-07: Notes tab shows saved replies; Files/Sources still share the
            // "Sources used" card (real per-tab Files/Sources content is future work).
            if (sourcesCard)
                sourcesCard.hidden = showNotes;
            if (notesCard)
                notesCard.hidden = !showNotes;
            const cardTitle = sourcesCard?.querySelector('.ncb-context-card-title');
            if (cardTitle && !showNotes)
                cardTitle.textContent = label === 'Sources' ? 'Sources used' : label;
            if (showNotes)
                renderNotesTab(root);
        });
    });
}
function saveReplyToNotes(aiRow, raw, btn) {
    const chat = chatStore.getActive();
    // De-dupe by exact text — Save twice should refuse, not double-add.
    const already = chat.savedReplies.find((r) => r.text === raw);
    if (already) {
        flashAck(btn, 'Already saved');
        return;
    }
    chat.savedReplies.unshift({
        id: 'rep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        text: raw,
        createdAt: Date.now(),
    });
    touchActiveChat();
    saveChatStore();
    flashAck(btn, 'Saved');
    // If the Notes tab is currently visible, refresh it inline.
    const root = aiRow.closest('.ncb-root');
    if (root) {
        const notesCard = root.querySelector('.ncb-notes-card');
        if (notesCard && !notesCard.hidden)
            renderNotesTab(root);
        // Always keep the count pill fresh — visible only when Notes tab is open
        // but cheap to update so we don't desync if user opens it later.
        const count = root.querySelector('.ncb-notes-count');
        if (count)
            count.textContent = String(chat.savedReplies.length);
    }
}
function renderNotesTab(root) {
    const notesCard = root.querySelector('.ncb-notes-card');
    if (!notesCard)
        return;
    const list = notesCard.querySelector('.ncb-notes-list');
    const count = notesCard.querySelector('.ncb-notes-count');
    if (!list)
        return;
    const chat = chatStore.getActive();
    if (count)
        count.textContent = String(chat.savedReplies.length);
    if (chat.savedReplies.length === 0) {
        list.innerHTML =
            '<p class="ncb-notes-empty">Bookmark useful AI replies here by tapping the Bookmark button under any reply.</p>';
        return;
    }
    list.innerHTML = chat.savedReplies
        .map((r) => `
      <article class="ncb-saved-card" data-id="${escapeAttr(r.id)}">
        <div class="ncb-saved-body">${renderInlineMarkdown(r.text)}</div>
        <div class="ncb-saved-foot">
          <span class="ncb-saved-time">${escapeHtml(relativeTime(r.createdAt))}</span>
          <div class="ncb-saved-actions">
            <button type="button" class="ncb-saved-copy" title="Copy">
              <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
            <button type="button" class="ncb-saved-remove" title="Remove" aria-label="Remove saved reply">
              <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
      </article>
    `)
        .join('');
    list.querySelectorAll('.ncb-saved-card').forEach((card) => {
        const id = card.dataset.id;
        if (!id)
            return;
        card.querySelector('.ncb-saved-remove')?.addEventListener('click', () => {
            chat.savedReplies = chat.savedReplies.filter((r) => r.id !== id);
            touchActiveChat();
            saveChatStore();
            renderNotesTab(root);
        });
        card.querySelector('.ncb-saved-copy')?.addEventListener('click', (ev) => {
            const target = ev.currentTarget;
            const reply = chat.savedReplies.find((r) => r.id === id);
            if (reply)
                copyToClipboard(reply.text, target);
        });
    });
}
// ---- Chat title generation ----
async function generateChatTitle(state) {
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    const lastAi = [...state.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastUser && !lastAi)
        return null;
    const seed = (lastUser?.text || '') +
        (lastUser?.images?.length ? ' [' + lastUser.images.length + ' image(s)]' : '') +
        '\n\n' +
        (lastAi?.text || '').slice(0, 400);
    try {
        const resp = await fetch('/api/ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + (getSbToken() || ''),
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                max_tokens: 30,
                system: 'You title chat conversations. Reply with ONLY a 3-6 word title in Title Case. ' +
                    'No quotes, no punctuation at the end, no preamble. Match the language of the user.',
                messages: [{ role: 'user', content: seed }],
            }),
        });
        if (!resp.ok)
            return null;
        const data = (await resp.json());
        const title = (data.content || [])
            .map((b) => b.text || '')
            .join('')
            .trim()
            .replace(/^["'`]+|["'`.!?]+$/g, '');
        return title || null;
    }
    catch {
        return null;
    }
}
function updateChatTitle(title) {
    // PR-05: persist into store + re-render header and sidebar row from data.
    const active = chatStore.getActive();
    active.title = title;
    active.updatedAt = Date.now();
    saveChatStore();
    const root = document.getElementById('ncbRoot');
    if (root) {
        const headerTitle = root.querySelector('.ncb-chat-header-title');
        if (headerTitle)
            headerTitle.textContent = title;
        renderSidebar(root);
    }
}
const NCB_STORE_KEY = 'ss_ncb_chats_v1';
const NCB_ACTIVE_KEY = 'ss_ncb_active_v1';
let liveState = null;
const chatStore = {
    chats: [],
    activeId: '',
    getActive() {
        let c = chatStore.chats.find((ch) => ch.id === chatStore.activeId);
        if (c)
            return c;
        // Self-heal: pick the most recent, or create a fresh one.
        c = chatStore.chats[0];
        if (c) {
            chatStore.activeId = c.id;
            return c;
        }
        const fresh = chatStore.newChat();
        chatStore.activeId = fresh.id;
        return fresh;
    },
    newChat() {
        const now = Date.now();
        const chat = {
            id: 'ncb_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8),
            title: 'New chat',
            messages: [],
            attachedFolders: [],
            savedReplies: [],
            pinned: false,
            createdAt: now,
            updatedAt: now,
        };
        chatStore.chats.unshift(chat);
        return chat;
    },
};
function getOrInitLiveState() {
    if (liveState)
        return liveState;
    const fresh = {
        messages: [],
        pasted: [],
        files: [],
        controller: null,
        isSending: false,
    };
    liveState = fresh;
    return fresh;
}
function loadChatStore() {
    try {
        const raw = localStorage.getItem(NCB_STORE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                chatStore.chats = parsed;
        }
        const activeRaw = localStorage.getItem(NCB_ACTIVE_KEY);
        if (typeof activeRaw === 'string' && activeRaw)
            chatStore.activeId = activeRaw;
    }
    catch {
        // private mode / corrupt storage — start fresh
    }
    // Migrate any missing fields on legacy entries.
    chatStore.chats.forEach((c) => {
        if (!Array.isArray(c.messages))
            c.messages = [];
        if (!Array.isArray(c.attachedFolders))
            c.attachedFolders = [];
        if (!Array.isArray(c.savedReplies))
            c.savedReplies = [];
        if (typeof c.pinned !== 'boolean')
            c.pinned = false;
        if (typeof c.createdAt !== 'number')
            c.createdAt = Date.now();
        if (typeof c.updatedAt !== 'number')
            c.updatedAt = c.createdAt;
        if (typeof c.title !== 'string' || !c.title)
            c.title = 'New chat';
    });
    // Ensure there is always at least one chat and an activeId pointing somewhere.
    if (chatStore.chats.length === 0) {
        const fresh = chatStore.newChat();
        chatStore.activeId = fresh.id;
    }
    else if (!chatStore.chats.find((c) => c.id === chatStore.activeId)) {
        chatStore.activeId = chatStore.chats[0].id;
    }
}
let _saveTimer = null;
let _quotaToastShown = false;
function saveChatStore() {
    if (_saveTimer != null)
        window.clearTimeout(_saveTimer);
    _saveTimer = window.setTimeout(() => {
        try {
            localStorage.setItem(NCB_STORE_KEY, JSON.stringify(chatStore.chats));
            localStorage.setItem(NCB_ACTIVE_KEY, chatStore.activeId);
        }
        catch (err) {
            if (_quotaToastShown) return;
            _quotaToastShown = true;
            const isQuota = err && err.name === 'QuotaExceededError';
            if (typeof window.showToast === 'function') {
                window.showToast(
                    isQuota ? 'Chat storage full' : 'Chats not saved',
                    isQuota
                        ? 'Browser storage is full. Delete some chats to keep new ones from being lost on reload.'
                        : 'Your browser blocked storage (private mode?). Chats will not persist across reloads.'
                );
            }
        }
    }, 200);
}
function touchActiveChat() {
    const c = chatStore.getActive();
    c.updatedAt = Date.now();
}
function relativeTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1)
        return 'Just now';
    if (min < 60)
        return min + ' min ago';
    const hr = Math.floor(min / 60);
    if (hr < 24)
        return hr + ' hr ago';
    const d = Math.floor(hr / 24);
    if (d < 7)
        return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    return new Date(ts).toLocaleDateString();
}
function chatMeta(c) {
    const attached = c.attachedFolders.length;
    const fragment = attached > 0
        ? attached + ' folder' + (attached === 1 ? '' : 's')
        : c.messages.length === 0
            ? 'Empty draft'
            : c.messages.length + ' msg' + (c.messages.length === 1 ? '' : 's');
    return fragment + ' · ' + relativeTime(c.updatedAt);
}
function renderSidebar(root) {
    const list = root.querySelector('.ncb-chat-list');
    if (!list)
        return;
    const pinned = chatStore.chats.filter((c) => c.pinned);
    const recent = chatStore.chats.filter((c) => !c.pinned);
    const sections = [];
    if (pinned.length) {
        sections.push('<p class="ncb-chat-section-label">Pinned</p>');
        pinned.forEach((c) => sections.push(buildSidebarRow(c)));
    }
    if (recent.length) {
        sections.push('<p class="ncb-chat-section-label">Recent</p>');
        recent.forEach((c) => sections.push(buildSidebarRow(c)));
    }
    list.innerHTML = sections.join('');
}
function buildSidebarRow(c) {
    const isActive = c.id === chatStore.activeId;
    const iconPath = c.pinned
        ? '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'
        : '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
    return `
    <button type="button" class="ncb-chat-item${isActive ? ' ncb-chat-item--active' : ''}" data-chat-id="${escapeAttr(c.id)}">
      <span class="ncb-chat-icon">
        <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
      </span>
      <span class="ncb-chat-text">
        <span class="ncb-chat-title">${escapeHtml(c.title)}</span>
        <span class="ncb-chat-meta">${escapeHtml(chatMeta(c))}</span>
      </span>
      <span class="ncb-chat-more" aria-hidden="true">
        <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </span>
    </button>
  `;
}
function switchActiveChat(root, chatId) {
    if (chatId === chatStore.activeId)
        return;
    // Abort in-flight response on the old chat.
    if (liveState?.controller)
        liveState.controller.abort();
    chatStore.activeId = chatId;
    saveChatStore();
    renderSidebar(root);
    loadActiveChatIntoCenter(root);
}
function loadActiveChatIntoCenter(root) {
    const stage = root.querySelector('.ncb-empty');
    const msgs = root.querySelector('.ncb-msgs');
    const headerTitle = root.querySelector('.ncb-chat-header-title');
    const textarea = root.querySelector('.ncb-input-textarea');
    const sendBtn = root.querySelector('.ncb-send-btn');
    const pasteRow = root.querySelector('.ncb-paste-row');
    if (!stage || !msgs)
        return;
    const chat = chatStore.getActive();
    // Reset transient live state.
    const state = getOrInitLiveState();
    state.messages = chat.messages;
    state.pasted = [];
    state.files = [];
    state.controller = null;
    state.isSending = false;
    if (sendBtn)
        setSendBtnMode(sendBtn, 'send');
    if (textarea)
        textarea.value = '';
    if (pasteRow)
        renderPasteRow(state, pasteRow);
    renderFilesRow(root, state);
    // Header title.
    if (headerTitle)
        headerTitle.textContent = chat.title;
    updateContextPill(root);
    // Stage mode: active iff there are any messages.
    stage.dataset.state = chat.messages.length > 0 ? 'active' : 'empty';
    // Re-render messages from persisted state.
    msgs.innerHTML = '';
    chat.messages.forEach((m) => {
        if (m.role === 'user') {
            appendUserBubble(msgs, m.text, m.images || [], m.files || []);
        }
        else {
            const row = appendAiBubble(msgs);
            const bubble = row.querySelector('.ncb-bubble-body');
            if (bubble)
                bubble.innerHTML = renderInlineMarkdown(m.text);
            appendBubbleActions(row, m.text);
        }
    });
    // Re-render attached folders + saved-replies count for this chat.
    renderAttachChips(root);
    const count = root.querySelector('.ncb-notes-count');
    if (count)
        count.textContent = String(chat.savedReplies.length);
    const notesCard = root.querySelector('.ncb-notes-card');
    if (notesCard && !notesCard.hidden)
        renderNotesTab(root);
}
// ============ PR-06: file upload + pdf extraction + files row + regenerate ============
const NCB_FILE_LIMIT = 10;
const NCB_TEXT_CHAR_LIMIT = 60000;
const NCB_PDF_PAGE_LIMIT = 80;
function initUploads(root) {
    const trigger = root.querySelector('.ncb-upload-btn');
    const input = root.querySelector('.ncb-file-input');
    if (!trigger || !input || trigger.dataset.ncbBound === '1')
        return;
    trigger.dataset.ncbBound = '1';
    trigger.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (!files.length)
            return;
        void absorbUploadedFiles(files, root);
    });
}
async function absorbUploadedFiles(files, root) {
    const state = getOrInitLiveState();
    const remaining = NCB_FILE_LIMIT - state.files.length;
    if (remaining <= 0)
        return;
    const accepted = files.slice(0, remaining);
    for (const f of accepted) {
        const pending = await readUploadedFile(f);
        if (pending)
            state.files.push(pending);
        renderFilesRow(root, state);
    }
}
function readUploadedFile(f) {
    const id = (f.name || 'file') + '-' + (f.lastModified || Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
    const baseMeta = { id, name: f.name || 'file', size: f.size };
    // Image — encode as base64 (strip the data: prefix).
    if (f.type && f.type.startsWith('image/')) {
        return readAsDataUrl(f).then((dataUrl) => {
            if (!dataUrl)
                return null;
            return {
                ...baseMeta,
                kind: 'image',
                mediaType: f.type,
                base64: dataUrl.replace(/^data:[^;]+;base64,/, ''),
            };
        });
    }
    // .txt / .md / text/plain — read as text directly.
    if (f.type === 'text/plain' || /\.(txt|md)$/i.test(f.name)) {
        return new Promise((resolve) => {
            try {
                const reader = new FileReader();
                reader.onload = () => {
                    const raw = typeof reader.result === 'string' ? reader.result : '';
                    resolve({
                        ...baseMeta,
                        kind: 'text',
                        textContent: raw.length > NCB_TEXT_CHAR_LIMIT ? raw.slice(0, NCB_TEXT_CHAR_LIMIT) + '\n\n[Content truncated]' : raw,
                    });
                };
                reader.onerror = () => resolve(null);
                reader.readAsText(f);
            }
            catch {
                resolve(null);
            }
        });
    }
    // PDF — pdfjsLib + the same page/char limits the existing chatbot uses.
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        return extractPdfText(f).then((text) => ({
            ...baseMeta,
            kind: 'text',
            textContent: text,
        }));
    }
    // Anything else — store as binary stub so the user sees the chip but the AI
    // gets an honest "couldn't read" hint.
    return Promise.resolve({ ...baseMeta, kind: 'binary' });
}
function extractPdfText(f) {
    const ensurePdf = window._ssEnsurePdfJs;
    const ensure = typeof ensurePdf === 'function' ? ensurePdf() : Promise.resolve();
    return ensure
        .then(() => new Promise((resolve) => {
        try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsArrayBuffer(f);
        }
        catch {
            resolve(null);
        }
    }))
        .then(async (buf) => {
        const pdfjs = window.pdfjsLib;
        if (!buf || !pdfjs)
            return '(could not extract text from this PDF)';
        try {
            const pdf = await pdfjs.getDocument({
                data: new Uint8Array(buf),
                cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
                cMapPacked: true,
            }).promise;
            const pages = Math.min(pdf.numPages, NCB_PDF_PAGE_LIMIT);
            const out = [];
            for (let p = 1; p <= pages; p++) {
                const page = await pdf.getPage(p);
                const tc = await page.getTextContent();
                const str = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
                if (str)
                    out.push('--- Page ' + p + ' ---\n' + str);
            }
            let full = out.join('\n\n');
            const truncated = full.length > NCB_TEXT_CHAR_LIMIT;
            if (truncated)
                full = full.slice(0, NCB_TEXT_CHAR_LIMIT);
            return full + (truncated ? '\n\n[Content truncated — document is very large]' : '');
        }
        catch {
            return '(could not extract text from this PDF)';
        }
    });
}
function renderFilesRow(root, state) {
    const row = root.querySelector('.ncb-files-row');
    if (!row)
        return;
    if (!state.files.length) {
        row.hidden = true;
        row.innerHTML = '';
        return;
    }
    row.hidden = false;
    row.innerHTML = state.files
        .map((f) => {
        const icon = f.kind === 'image'
            ? '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="13" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>'
            : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>';
        const kindLabel = f.kind === 'image' ? 'Image' : f.kind === 'text' ? 'Document' : 'File';
        return `
        <span class="ncb-file-chip" data-id="${escapeAttr(f.id)}" title="${escapeAttr(f.name)}">
          <span class="ncb-file-chip-icon">
            <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          </span>
          <span class="ncb-file-chip-text">
            <span class="ncb-file-chip-name">${escapeHtml(f.name)}</span>
            <span class="ncb-file-chip-kind">${kindLabel}</span>
          </span>
          <button type="button" class="ncb-file-chip-x" aria-label="Remove ${escapeAttr(f.name)}">
            <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
      `;
    })
        .join('');
    row.querySelectorAll('.ncb-file-chip-x').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const id = btn.closest('.ncb-file-chip')?.dataset.id;
            if (!id)
                return;
            state.files = state.files.filter((x) => x.id !== id);
            renderFilesRow(root, state);
        });
    });
}
// Override the PR-04 stub with a real implementation.
function regenerateLastReal(aiRow, root) {
    const msgs = root.querySelector('.ncb-msgs');
    const sendBtn = root.querySelector('.ncb-send-btn');
    if (!msgs || !sendBtn)
        return;
    const state = liveState;
    if (!state || state.isSending)
        return;
    // Drop the trailing assistant message from the active chat.
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== 'assistant')
        return;
    state.messages.pop();
    touchActiveChat();
    saveChatStore();
    // Remove the corresponding DOM row (the bubble the user clicked Regenerate on).
    aiRow.remove();
    void streamAiReply(state, sendBtn, msgs);
}
// ============ Context panel collapse ============
const NCB_CTX_KEY = 'ss_ncb_context_open';
function initContextCollapse(root) {
    const card = root.querySelector('.ncb-card');
    const closeBtn = root.querySelector('.ncb-context-close-btn');
    const openBtn = root.querySelector('.ncb-panel-open-btn');
    if (!card || !closeBtn || !openBtn)
        return;
    if (card.dataset.ncbCtxBound === '1')
        return;
    card.dataset.ncbCtxBound = '1';
    // Viewport-aware default: small screens (≤1024) default to closed since
    // the panel becomes an overlay sheet at that width. User toggle wins
    // forever after via NCB_CTX_KEY.
    let open = true;
    try {
        const raw = localStorage.getItem(NCB_CTX_KEY);
        if (raw === '0')
            open = false;
        else if (raw === '1')
            open = true;
        else if (window.matchMedia && window.matchMedia('(max-width: 1024px)').matches) {
            open = false;
        }
    }
    catch {
        // ignore — default to open
    }
    apply(open);
    closeBtn.addEventListener('click', () => apply(false));
    openBtn.addEventListener('click', () => apply(true));
    function apply(isOpen) {
        card.dataset.contextOpen = isOpen ? 'true' : 'false';
        openBtn.hidden = isOpen;
        try {
            localStorage.setItem(NCB_CTX_KEY, isOpen ? '1' : '0');
        }
        catch {
            // ignore
        }
    }
}
// Toggle body.ncb-fullbleed whenever #psec-aipage is visible. Watches the
// section's style attribute so we react to portal route changes without
// touching the portal navigation code.
let _ncbFullbleedBound = false;
function initFullbleed() {
    if (_ncbFullbleedBound)
        return;
    const section = document.getElementById('psec-aipage');
    if (!section)
        return;
    _ncbFullbleedBound = true;
    const apply = () => {
        const visible = section.style.display !== 'none' && section.offsetParent !== null;
        document.body.classList.toggle('ncb-fullbleed', visible);
    };
    apply();
    try {
        new MutationObserver(apply).observe(section, { attributes: true, attributeFilter: ['style'] });
    }
    catch {
        // older browsers without MutationObserver — fullbleed just won't toggle
    }
}
// ============ PR-08: AI tools (Quiz me / Flashcards / Summary / Export) ============
const NCB_TOOL_PROMPTS = {
    quiz: 'Generate a 5-question quiz based on the material we have discussed in this conversation and any attached files. Mix difficulty levels. Show questions first, then the answers in a separate section at the bottom.',
    flashcards: 'Create 10 concise flashcards from our conversation and attached materials. Format each as **Q:** ... / **A:** ...',
    summary: 'Summarize our conversation so far in clear bullet points: the key concepts covered, important formulas or definitions, and any open questions.',
};
function initAiTools(root) {
    const buttons = root.querySelectorAll('.ncb-tool-btn');
    if (!buttons.length || buttons[0]?.dataset.ncbBound === '1')
        return;
    buttons.forEach((btn) => {
        btn.dataset.ncbBound = '1';
        btn.addEventListener('click', () => {
            const tool = btn.dataset.tool || '';
            if (tool === 'export')
                exportActiveChat(btn);
            else
                runToolPrompt(root, tool, btn);
        });
    });
}
function runToolPrompt(root, tool, btn) {
    const prompt = NCB_TOOL_PROMPTS[tool];
    if (!prompt)
        return;
    const stage = root.querySelector('.ncb-empty');
    const sendBtn = root.querySelector('.ncb-send-btn');
    const msgs = root.querySelector('.ncb-msgs');
    const state = liveState;
    if (!stage || !sendBtn || !msgs || !state || state.isSending) {
        if (state?.isSending)
            flashAck(btn, 'Busy');
        return;
    }
    if (stage.dataset.state !== 'active')
        stage.dataset.state = 'active';
    state.messages.push({ role: 'user', text: prompt, images: [], files: [] });
    appendUserBubble(msgs, prompt, [], []);
    touchActiveChat();
    saveChatStore();
    void streamAiReply(state, sendBtn, msgs);
}
function exportActiveChat(btn) {
    const chat = chatStore.getActive();
    if (!chat.messages.length) {
        flashAck(btn, 'Nothing to export');
        return;
    }
    const lines = [`# ${chat.title}`, ''];
    chat.messages.forEach((m) => {
        if (m.role === 'user') {
            lines.push('## You');
            if (m.text)
                lines.push(m.text);
            const fileNames = (m.files || []).map((f) => '- ' + f.name);
            if (fileNames.length)
                lines.push('', '**Attached files:**', ...fileNames);
            if ((m.images || []).length)
                lines.push('', `_(${m.images.length} pasted image(s))_`);
        }
        else {
            lines.push('## Minallo AI');
            if (m.text)
                lines.push(m.text);
        }
        lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (chat.title || 'chat').replace(/[^a-z0-9-_ ]/gi, '_').slice(0, 64);
    a.href = url;
    a.download = safeTitle + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashAck(btn, 'Exported');
}
// ============ PR-10: chat-row menu, rename, delete, pin, clear-all ============
let _ncbMenuEl = null;
function ensureMenuEl() {
    if (_ncbMenuEl)
        return _ncbMenuEl;
    const el = document.createElement('div');
    el.className = 'ncb-row-menu';
    el.hidden = true;
    document.body.appendChild(el);
    document.addEventListener('click', (ev) => {
        if (!_ncbMenuEl || _ncbMenuEl.hidden)
            return;
        const t = ev.target;
        if (t && (_ncbMenuEl === t || _ncbMenuEl.contains(t)))
            return;
        closeChatRowMenu();
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape')
            closeChatRowMenu();
    });
    _ncbMenuEl = el;
    return el;
}
function closeChatRowMenu() {
    if (_ncbMenuEl)
        _ncbMenuEl.hidden = true;
}
function openChatRowMenu(root, chatId, anchor) {
    const chat = chatStore.chats.find((c) => c.id === chatId);
    if (!chat)
        return;
    const menu = ensureMenuEl();
    menu.innerHTML = `
    <button type="button" class="ncb-row-menu-item" data-act="pin">${chat.pinned ? 'Unpin' : 'Pin'}</button>
    <button type="button" class="ncb-row-menu-item" data-act="rename">Rename</button>
    <button type="button" class="ncb-row-menu-item ncb-row-menu-item--danger" data-act="delete">Delete</button>
  `;
    // Position below the anchor, right-aligned to its right edge.
    const r = anchor.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.left = Math.round(Math.max(8, r.right - 160)) + 'px';
    menu.hidden = false;
    menu.querySelectorAll('.ncb-row-menu-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            closeChatRowMenu();
            if (act === 'pin')
                togglePin(root, chatId);
            else if (act === 'rename')
                beginRename(root, chatId);
            else if (act === 'delete')
                deleteChat(root, chatId);
        });
    });
}
function togglePin(root, chatId) {
    const chat = chatStore.chats.find((c) => c.id === chatId);
    if (!chat)
        return;
    chat.pinned = !chat.pinned;
    chat.updatedAt = Date.now();
    saveChatStore();
    renderSidebar(root);
}
function beginRename(root, chatId) {
    const row = root.querySelector(`.ncb-chat-item[data-chat-id="${cssEscape(chatId)}"]`);
    const titleEl = row?.querySelector('.ncb-chat-title');
    if (!row || !titleEl)
        return;
    const chat = chatStore.chats.find((c) => c.id === chatId);
    if (!chat)
        return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = chat.title;
    input.className = 'ncb-chat-rename-input';
    input.setAttribute('aria-label', 'Rename chat');
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = (save) => {
        if (committed)
            return;
        committed = true;
        const next = input.value.trim();
        if (save && next && next !== chat.title) {
            chat.title = next;
            chat.updatedAt = Date.now();
            saveChatStore();
            // If this is the active chat, the header title needs to sync too.
            if (chat.id === chatStore.activeId) {
                const hdr = root.querySelector('.ncb-chat-header-title');
                if (hdr)
                    hdr.textContent = next;
            }
        }
        renderSidebar(root);
    };
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            commit(true);
        }
        else if (ev.key === 'Escape') {
            ev.preventDefault();
            commit(false);
        }
        ev.stopPropagation();
    });
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('blur', () => commit(true));
}
function deleteChat(root, chatId) {
    const chat = chatStore.chats.find((c) => c.id === chatId);
    if (!chat)
        return;
    const ok = window.confirm(`Delete "${chat.title}"? This can't be undone.`);
    if (!ok)
        return;
    const wasActive = chat.id === chatStore.activeId;
    chatStore.chats = chatStore.chats.filter((c) => c.id !== chatId);
    if (!chatStore.chats.length)
        chatStore.newChat();
    if (wasActive)
        chatStore.activeId = chatStore.chats[0].id;
    saveChatStore();
    renderSidebar(root);
    if (wasActive)
        loadActiveChatIntoCenter(root);
}
function cssEscape(s) {
    // CSS.escape isn't in older TS lib types; fall back to a regex.
    const css = window.CSS;
    if (css?.escape)
        return css.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}
// ---- Clear-all-chats ----
function initClearAll(root) {
    const sidebar = root.querySelector('.ncb-sidebar');
    if (!sidebar || sidebar.querySelector('.ncb-clear-all'))
        return;
    // Inject the clear-all button just before the safe-card.
    const safe = sidebar.querySelector('.ncb-safe-card');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ncb-clear-all';
    btn.innerHTML = `
    <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    <span>Clear all chats</span>
  `;
    btn.addEventListener('click', () => {
        const ok = window.confirm('Delete every chat in the sidebar? This can\'t be undone.');
        if (!ok)
            return;
        chatStore.chats = [];
        const fresh = chatStore.newChat();
        chatStore.activeId = fresh.id;
        saveChatStore();
        renderSidebar(root);
        loadActiveChatIntoCenter(root);
    });
    if (safe)
        sidebar.insertBefore(btn, safe);
    else
        sidebar.appendChild(btn);
}
// ---- Textarea auto-resize ----
function initTextareaAutoSize(root) {
    const ta = root.querySelector('.ncb-input-textarea');
    if (!ta || ta.dataset.ncbAutoSize === '1')
        return;
    ta.dataset.ncbAutoSize = '1';
    const MAX = 220;
    const resize = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(MAX, ta.scrollHeight) + 'px';
        ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden';
    };
    ta.addEventListener('input', resize);
    // Reset on send (textarea is cleared by doSend) — observe the value change
    // via a MutationObserver on the value-set side isn't reliable, so we hook
    // a paste/cut/blur for good measure.
    ta.addEventListener('blur', resize);
    resize();
}
// ---- Error retry ----
function attachErrorRetry(aiRow, bubble) {
    if (!bubble)
        return;
    const existing = aiRow.querySelector('.ncb-retry-btn');
    if (existing)
        return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ncb-retry-btn';
    btn.innerHTML = `
    <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
    <span>Retry</span>
  `;
    btn.addEventListener('click', () => {
        const root = aiRow.closest('.ncb-root');
        if (!root)
            return;
        const msgs = root.querySelector('.ncb-msgs');
        const sendBtn = root.querySelector('.ncb-send-btn');
        const state = liveState;
        if (!msgs || !sendBtn || !state || state.isSending)
            return;
        aiRow.remove();
        void streamAiReply(state, sendBtn, msgs);
    });
    bubble.appendChild(btn);
}
// ---- Course folder hydration ----
function eagerlyHydrateCourses(onProgress) {
    const sems = getSems();
    const w = window;
    const trigger = w._ufMerge || w.listUserFolders;
    if (!trigger)
        return Promise.resolve();
    const promises = [];
    Object.values(sems).forEach((sem) => {
        (sem.courses || []).forEach((c) => {
            const empty = !c.userFolders || c.userFolders.length === 0;
            if (empty && c.id) {
                try {
                    const r = trigger(c);
                    const p = Promise.resolve(r)
                        .then(() => { try { onProgress && onProgress(c); } catch { /* ignore */ } })
                        .catch(() => { /* tolerate per-course failure */ });
                    promises.push(p);
                }
                catch { /* tolerate per-course failure */ }
            }
        });
    });
    return Promise.all(promises).then(() => undefined);
}
// ---- Empty-state action cards ----
function initActionCards(root) {
    if (root.dataset.ncbActionsBound === '1')
        return;
    root.dataset.ncbActionsBound = '1';
    const cards = root.querySelectorAll('.ncb-action-card[data-prefill]');
    cards.forEach((card) => {
        card.addEventListener('click', () => {
            const prefill = card.dataset.prefill || '';
            if (!prefill)
                return;
            const ta = root.querySelector('.ncb-input-textarea');
            if (!ta)
                return;
            ta.value = prefill;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus();
            const end = ta.value.length;
            try { ta.setSelectionRange(end, end); } catch { /* old browsers */ }
        });
    });
}

// ---- Keyboard shortcuts ----
function initKeyboardShortcuts(root) {
    if (root.dataset.ncbKbBound === '1')
        return;
    root.dataset.ncbKbBound = '1';
    document.addEventListener('keydown', (ev) => {
        if (root.hidden || root.offsetParent === null)
            return;
        const meta = ev.metaKey || ev.ctrlKey;
        if (!meta)
            return;
        // Cmd/Ctrl+K → new chat (and focus the input)
        if (ev.key === 'k' || ev.key === 'K') {
            ev.preventDefault();
            const newBtn = root.querySelector('.ncb-new-chat-btn');
            newBtn?.click();
            const ta = root.querySelector('.ncb-input-textarea');
            ta?.focus();
            return;
        }
        // Cmd/Ctrl+/ → focus the input
        if (ev.key === '/') {
            ev.preventDefault();
            const ta = root.querySelector('.ncb-input-textarea');
            ta?.focus();
        }
    });
}
window.initNewChatbotShell = initNewChatbotShell;
//# sourceMappingURL=shell.js.map