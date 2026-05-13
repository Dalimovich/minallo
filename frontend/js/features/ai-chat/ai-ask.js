import { sendAiRequest, sendRagRequest, listCourseDocuments, submitRagFeedback, } from '../../services/ai-service.js';
import { extractPdfText } from '../pdf-viewer/pdf-text-extraction.js';
import { bindMessageActionButtons } from './ai-message-actions.js';
function _getTime() {
    const d = new Date();
    return (d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'));
}
// ── Auto-scroll controller ──────────────────────────────────────────────────
let _userScrolledUp = false;
let _scrollListenerAttached = false;
function _ensureScrollTracker() {
    if (_scrollListenerAttached)
        return;
    const el = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
    if (!el)
        return;
    el.addEventListener('scroll', () => {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        _userScrolledUp = dist > 60;
    });
    _scrollListenerAttached = true;
}
function _autoScroll(el) {
    if (!el)
        return;
    if (_userScrolledUp)
        return;
    el.scrollTop = el.scrollHeight;
}
export function _resetScrollFollow() {
    _userScrolledUp = false;
    const el = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
    if (el)
        el.scrollTop = el.scrollHeight;
}
export async function pdfToImages(maxPages) {
    const pdfDoc = window.pdfDoc;
    if (!pdfDoc)
        return [];
    const limit = maxPages || 6;
    const total = pdfDoc.numPages;
    const currentPage = window.pdfPage && window.pdfPage >= 1 ? window.pdfPage : 1;
    const half = Math.floor(limit / 2);
    let startPage = Math.max(1, currentPage - half);
    const endPage = Math.min(total, startPage + limit - 1);
    if (endPage - startPage + 1 < limit)
        startPage = Math.max(1, endPage - limit + 1);
    const imgs = [];
    for (let i = startPage; i <= endPage; i++) {
        try {
            const page = await pdfDoc.getPage(i);
            const vp = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            const ctx = canvas.getContext('2d');
            if (!ctx)
                continue;
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            const b64 = dataUrl.split(',')[1];
            if (b64)
                imgs.push(b64);
        }
        catch { /* skip failed page */ }
    }
    return imgs;
}
export function addTyping() {
    const aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
    if (!aiMsgs)
        return null;
    _ensureScrollTracker();
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg-wrap typing-wrap';
    wrap.innerHTML =
        '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
            '<div class="typing-bubble"><span></span><span></span><span></span></div>';
    aiMsgs.appendChild(wrap);
    _autoScroll(aiMsgs);
    return wrap;
}
// ── Per-course chat history (localStorage) ──────────────────────────────────
const _HISTORY_MAX = 40;
const _HISTORY_PREFIX = 'ss_course_qa_';
function _historyKey(courseId) {
    return _HISTORY_PREFIX + (courseId || 'default');
}
function _loadCourseHistory(courseId) {
    try {
        return JSON.parse(localStorage.getItem(_historyKey(courseId)) || '[]');
    }
    catch {
        return [];
    }
}
function _saveCourseHistory(courseId, pairs) {
    try {
        let trimmed = pairs;
        if (trimmed.length > _HISTORY_MAX)
            trimmed = trimmed.slice(trimmed.length - _HISTORY_MAX);
        localStorage.setItem(_historyKey(courseId), JSON.stringify(trimmed));
    }
    catch { /* quota */ }
}
function _appendCourseHistory(courseId, question, answer) {
    const pairs = _loadCourseHistory(courseId);
    pairs.push({ q: question, a: answer, ts: Date.now() });
    _saveCourseHistory(courseId, pairs);
}
function _renderHistoryPairs(pairs, aiMsgs) {
    if (!pairs || !pairs.length)
        return;
    pairs.forEach((pair) => {
        const uWrap = window.addUserMsg ? window.addUserMsg(pair.q, true) : null;
        if (uWrap)
            uWrap.setAttribute('data-restored', 'true');
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg-wrap';
        wrap.setAttribute('data-restored', 'true');
        wrap.innerHTML =
            '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                '<div class="msg-body"><div class="ai-bubble bot restored-answer"></div></div>';
        const bubble = wrap.querySelector('.ai-bubble.bot');
        if (bubble) {
            bubble.setAttribute('data-raw', pair.a);
            const _doRender = () => {
                bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(pair.a) : pair.a;
            };
            if (window._ssEnsureKatex) {
                window._ssEnsureKatex().then(_doRender).catch(_doRender);
            }
            else {
                _doRender();
            }
        }
        aiMsgs.appendChild(wrap);
    });
    aiMsgs.scrollTop = aiMsgs.scrollHeight;
}
export function restoreCourseHistory(courseId) {
    if (!courseId)
        return;
    const aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
    if (!aiMsgs)
        return;
    if (aiMsgs.querySelectorAll('.ai-msg-wrap:not(.typing-wrap)').length > 0)
        return;
    const supaUrl = window._SUPA || '';
    const tok = window._sbToken || '';
    if (supaUrl && tok) {
        fetch(supaUrl + '/rest/v1/chat_history?course_id=eq.' + encodeURIComponent(courseId) +
            '&order=created_at.asc&limit=40', {
            headers: {
                apikey: window._SAKEY || '',
                Authorization: 'Bearer ' + tok,
            },
        })
            .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
            .then((rows) => {
            if (rows && rows.length) {
                const pairs = rows.map((r) => ({ q: r.question, a: r.answer }));
                _renderHistoryPairs(pairs, aiMsgs);
            }
            else {
                _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
            }
        })
            .catch(() => {
            _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
        });
    }
    else {
        _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
    }
}
export function clearCourseHistory(courseId) {
    try {
        localStorage.removeItem(_historyKey(courseId));
    }
    catch { /* ignore */ }
}
export function initAskAI(state) {
    return function askAI(question, skipUserBubble, opts) {
        if (!question)
            return;
        if (window._abortCurrentStream)
            window._abortCurrentStream();
        state.generationStopped = false;
        state.currentGenId++;
        const myGenId = state.currentGenId;
        if (window.pinAI)
            window.pinAI();
        const _chatHistory = window.serializeChatDOM ? window.serializeChatDOM() : [];
        if (!skipUserBubble && window.addUserMsg)
            window.addUserMsg(question);
        const _aiSendBtn = document.getElementById('aiSend');
        const _stopBtn = document.getElementById('stopBtn');
        if (_aiSendBtn)
            _aiSendBtn.disabled = true;
        if (_stopBtn) {
            _stopBtn.style.display = 'flex';
            if (!_stopBtn.__ssAbortBound) {
                _stopBtn.addEventListener('click', () => {
                    if (window._abortCurrentStream)
                        window._abortCurrentStream();
                });
                _stopBtn.__ssAbortBound = true;
            }
        }
        const aiMsgs = document.getElementById('aiMsgs');
        const aiPanel = document.getElementById('aiPanel');
        _ensureScrollTracker();
        _userScrolledUp = false;
        const thinkWrap = document.createElement('div');
        thinkWrap.className = 'ai-msg-wrap typing-wrap';
        thinkWrap.innerHTML =
            '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                '<div class="typing-bubble"><span></span><span></span><span></span></div>';
        aiMsgs.appendChild(thinkWrap);
        aiMsgs.scrollTop = aiMsgs.scrollHeight;
        const pdfDoc = window.pdfDoc;
        let pdfFullText = window.pdfFullText || '';
        const _lang = window._lang || localStorage.getItem('ss_lang') || 'en';
        const activeFileName = window.activeFileName || '';
        const currentCourseShort = window.currentCourseShort || '';
        const _MATH_PROMPT = window._MATH_PROMPT || '';
        let sysPrompt = (window._userType === 'learner'
            ? 'You are Minallo, a German language tutor helping a student prepare for ' +
                (window._germanTest || 'a German exam') +
                (window._germanLevel ? ' at level ' + window._germanLevel : '') +
                '. Always reply in ' + (_lang === 'de' ? 'German' : 'English') +
                '. The student is reading "' + activeFileName +
                '". ALWAYS base your answers on the actual document content below. Be thorough but concise.'
            : 'You are Minallo, a friendly tutor for TU Braunschweig engineering students. Always reply in ' +
                (_lang === 'de' ? 'German' : 'English') +
                '. The student is reading "' + activeFileName + '" from ' + currentCourseShort +
                '. ALWAYS base your answers on the actual document content provided below. Do not use general knowledge when the document covers the topic. Be thorough but concise.') +
            _MATH_PROMPT;
        const _textReady = pdfDoc && !pdfFullText.trim()
            ? extractPdfText(pdfDoc, 30).then((t) => {
                if (t) {
                    window.pdfFullText = t;
                    pdfFullText = t;
                }
            })
            : Promise.resolve();
        _textReady
            .then(() => (pdfDoc ? pdfToImages(8) : []))
            .then(async (pageImages) => {
            let userContent;
            const isHandwritten = pdfFullText.trim().length < 100;
            if (pageImages.length) {
                sysPrompt += isHandwritten
                    ? '\n\nThis document is handwritten or scanned. Pages are provided as images — read all handwritten text, equations, and diagrams carefully.'
                    : '\n\nThe open PDF pages are included as images below. The document may contain handwritten solutions, diagrams, or worked examples alongside printed text. Read both the extracted text AND the images — if the images show a worked solution with specific values, use those exact values.';
                userContent = [{ type: 'text', text: question }].concat(pageImages.map((b64) => ({
                    type: 'image_url',
                    image_url: { url: 'data:image/jpeg;base64,' + b64 },
                })));
            }
            else {
                sysPrompt +=
                    '\n\nDOCUMENT CONTENT:\n' + (pdfFullText || '(document text not yet extracted)');
                userContent = question;
            }
            const _courseId = window.activeCourseId || window.currentCourseId || '';
            let _hasRag = false;
            const _activeDocId = window.activeRagDocumentId || null;
            if (_courseId) {
                try {
                    const _docs = await listCourseDocuments(_courseId);
                    const _readyDocs = _docs.filter((d) => d.processing_status === 'ready');
                    _hasRag = _readyDocs.length > 0;
                }
                catch {
                    _hasRag = false;
                }
            }
            // Extract a focused excerpt from the open PDF around the mentioned exercise/topic.
            let _openFileCtx = '';
            if (pdfFullText && pdfFullText.trim().length > 50) {
                const _rawText = pdfFullText;
                const _exercisePatterns = [
                    /\b(aufgabe\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(aufgabe\s*\d+\s*[a-z]\b)/i,
                    /\b(ü?bung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(uebung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(beispiel\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(l[oö]sung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(loesung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(teilaufgabe\s+[a-z\d])\b/i,
                    /\b(exercise\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(task\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(problem\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(example\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
                    /\b(\d+\.\d+[a-z]?)\b/i,
                    /\b(\d+\s*[a-z]\s*\))/i,
                    /\b(\d+[a-z])\b/i,
                ];
                const _subqPattern = /\b([a-d])\s*\)?$|\b(?:question|teil|part|aufgabe|mach|solve|löse)\s+([a-d])\b/i;
                const _subqMatch = question.match(_subqPattern);
                let _matchTerm = null;
                for (const pat of _exercisePatterns) {
                    const _m = question.match(pat);
                    if (_m && _m[0]) {
                        _matchTerm = _m[0].trim();
                        break;
                    }
                }
                if (_matchTerm) {
                    const _normDe = (s) => s.replace(/ü/g, 'ue').replace(/ö/g, 'oe').replace(/ä/g, 'ae')
                        .replace(/Ü/g, 'Ue').replace(/Ö/g, 'Oe').replace(/Ä/g, 'Ae')
                        .replace(/ß/g, 'ss').toLowerCase();
                    const _normTerm = _normDe(_matchTerm);
                    const _normText = _normDe(_rawText);
                    let _idx = _normText.indexOf(_normTerm);
                    if (_idx < 0) {
                        const _compactTerm = _normTerm.replace(/\s+/g, '');
                        const _compactText = _normText.replace(/\s+/g, '');
                        const _cidx = _compactText.indexOf(_compactTerm);
                        if (_cidx >= 0) {
                            let _charCount = 0;
                            let _rawIdx = 0;
                            for (let _ri = 0; _ri < _rawText.length && _charCount < _cidx; _ri++) {
                                if (_rawText[_ri].trim())
                                    _charCount++;
                                _rawIdx = _ri;
                            }
                            _idx = _rawIdx;
                        }
                    }
                    if (_idx >= 0) {
                        window._lastExerciseIdx = _idx;
                        _openFileCtx = _rawText.slice(Math.max(0, _idx - 200), _idx + 3000);
                    }
                }
                const _lastExerciseIdx = window._lastExerciseIdx;
                if (!_openFileCtx && _subqMatch && _lastExerciseIdx != null) {
                    const _subqLetter = (_subqMatch[1] || _subqMatch[2] || '').toLowerCase();
                    const _exerciseSlice = _rawText.slice(_lastExerciseIdx, _lastExerciseIdx + 4000);
                    const _subqRel = _subqLetter
                        ? _exerciseSlice.search(new RegExp('\\b' + _subqLetter + '\\s*[\\)\\.]', 'i'))
                        : -1;
                    if (_subqRel > 0) {
                        const _subqAbs = _lastExerciseIdx + _subqRel;
                        _openFileCtx = _rawText.slice(Math.max(0, _subqAbs - 300), _subqAbs + 2500);
                    }
                    else {
                        _openFileCtx = _rawText.slice(Math.max(0, _lastExerciseIdx - 200), _lastExerciseIdx + 3000);
                    }
                }
                if (!_openFileCtx)
                    _openFileCtx = _rawText.slice(0, 3000);
            }
            if (_hasRag) {
                const _modeToggle = document.getElementById('aiModeStrict');
                const _ragMode = !_modeToggle || _modeToggle.checked ? 'strict' : 'general';
                return new Promise((resolve) => {
                    const token = window._sbToken || '';
                    let ansWrap = null;
                    let bubble = null;
                    let rawText = '';
                    const metaPattern = /<!--META-->[\s\S]*?<!--\/META-->/g;
                    const _tokenQueue = [];
                    let _renderTimer = null;
                    let _pendingMeta = undefined;
                    const CFG = window.AI_TYPING || {};
                    const TOKEN_INTERVAL = CFG.streamTokenInterval || 38;
                    let _renderedBlockCount = 0;
                    function splitBlocks(text) {
                        const blocks = [];
                        const lines = text.split('\n');
                        let buf = [];
                        let inCode = false;
                        let inMath = false;
                        let inLatex = false;
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i] ?? '';
                            if (!inCode && /^```/.test(line))
                                inCode = true;
                            else if (inCode && /^```/.test(line)) {
                                buf.push(line);
                                inCode = false;
                                blocks.push(buf.join('\n'));
                                buf = [];
                                continue;
                            }
                            if (!inLatex && /^\s*\\\[/.test(line))
                                inLatex = true;
                            else if (inLatex && /\\\]/.test(line)) {
                                buf.push(line);
                                inLatex = false;
                                blocks.push(buf.join('\n'));
                                buf = [];
                                continue;
                            }
                            if (!inMath && /^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line))
                                inMath = true;
                            else if (inMath && /\$\$/.test(line)) {
                                buf.push(line);
                                inMath = false;
                                blocks.push(buf.join('\n'));
                                buf = [];
                                continue;
                            }
                            if (!inCode && !inMath && !inLatex && line.trim() === '' && buf.length) {
                                blocks.push(buf.join('\n'));
                                buf = [];
                            }
                            else {
                                buf.push(line);
                            }
                        }
                        if (buf.length)
                            blocks.push(buf.join('\n'));
                        return blocks.filter((b) => b.trim());
                    }
                    function renderBlock(_text) {
                        const div = document.createElement('div');
                        div.className = 'ss-rendered-block';
                        div.style.opacity = '0';
                        div.style.transition = 'opacity 0.2s ease';
                        return div;
                    }
                    function applyKatexToBlock(div, text) {
                        const done = () => {
                            div.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : text;
                            div.style.opacity = '1';
                            _autoScroll(aiMsgs);
                        };
                        if (window._ssEnsureKatex) {
                            window._ssEnsureKatex().then(done).catch(() => {
                                div.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : text;
                                div.style.opacity = '1';
                            });
                        }
                        else {
                            done();
                        }
                    }
                    function updateBlockRender() {
                        if (!bubble)
                            return;
                        const display = rawText.replace(metaPattern, '').trimEnd();
                        const blocks = splitBlocks(display);
                        let typingSpan = bubble.querySelector('.ss-typing-span');
                        if (!typingSpan) {
                            typingSpan = document.createElement('span');
                            typingSpan.className = 'ss-typing-span';
                            typingSpan.style.whiteSpace = 'pre-wrap';
                            bubble.appendChild(typingSpan);
                        }
                        const completedCount = blocks.length - 1;
                        while (_renderedBlockCount < completedCount) {
                            const blockText = blocks[_renderedBlockCount] || '';
                            const div = renderBlock(blockText);
                            bubble.insertBefore(div, typingSpan);
                            applyKatexToBlock(div, blockText);
                            _renderedBlockCount++;
                        }
                        const typingText = (blocks[blocks.length - 1] || '').replace(/<!--META-->[\s\S]*$/, '');
                        typingSpan.textContent = typingText;
                        _autoScroll(aiMsgs);
                    }
                    function fullRender(text) {
                        if (!bubble)
                            return;
                        const display = text.replace(metaPattern, '').trim();
                        if (!display)
                            return;
                        const _doFullRender = () => {
                            if (!bubble)
                                return;
                            bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(display) : display;
                            _autoScroll(aiMsgs);
                        };
                        if (window._ssEnsureKatex) {
                            window._ssEnsureKatex().then(_doFullRender).catch(_doFullRender);
                        }
                        else {
                            _doFullRender();
                        }
                    }
                    function drainQueue() {
                        if (!_tokenQueue.length) {
                            _renderTimer = null;
                            if (_pendingMeta !== undefined)
                                finalize(_pendingMeta);
                            return;
                        }
                        const tok = _tokenQueue.shift();
                        rawText += tok;
                        if (bubble)
                            updateBlockRender();
                        _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
                    }
                    function queueToken(tok) {
                        _tokenQueue.push(tok);
                        if (!_renderTimer)
                            _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
                    }
                    window._activeStreamRender = function () {
                        if (_renderTimer) {
                            clearTimeout(_renderTimer);
                            _renderTimer = null;
                        }
                        while (_tokenQueue.length)
                            rawText += _tokenQueue.shift();
                        fullRender(rawText);
                    };
                    function ensureBubble() {
                        if (ansWrap)
                            return;
                        thinkWrap.style.transition = 'opacity .15s';
                        thinkWrap.style.opacity = '0';
                        setTimeout(() => thinkWrap.remove(), 160);
                        ansWrap = document.createElement('div');
                        ansWrap.className = 'ai-msg-wrap';
                        ansWrap.innerHTML =
                            '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                                '<div class="msg-body"><div class="ai-bubble bot" style="min-height:20px"></div></div>';
                        aiMsgs.appendChild(ansWrap);
                        _autoScroll(aiMsgs);
                        bubble = ansWrap.querySelector('.ai-bubble.bot');
                    }
                    const _streamController = new AbortController();
                    window._abortCurrentStream = () => _streamController.abort();
                    // (prevQuestion lookup retained from JS for parity — currently unused in payload)
                    try {
                        const _chatMsgs = typeof window.serializeChatDOM === 'function' ? window.serializeChatDOM() : [];
                        for (let _ci = _chatMsgs.length - 1; _ci >= 0; _ci--) {
                            const m = _chatMsgs[_ci];
                            if (m.role === 'user' && m.text !== question)
                                break;
                        }
                    }
                    catch { /* ignore */ }
                    const _aiHost = (window.AI_SERVICE_URL || '').replace(/\/$/, '');
                    if (!_aiHost) {
                        fallbackToRag();
                        return;
                    }
                    fetch(_aiHost + '/ask-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                        signal: _streamController.signal,
                        body: JSON.stringify({
                            courseId: _courseId,
                            question: question,
                            documentIds: _activeDocId ? [_activeDocId] : undefined,
                            bypassCache: opts && opts.forceRefresh ? true : undefined,
                        }),
                    })
                        .then((res) => {
                        if (!res.ok || !res.body || !res.body.getReader) {
                            fallbackToRag();
                            return;
                        }
                        const reader = res.body.getReader();
                        const decoder = new TextDecoder();
                        let sseBuffer = '';
                        function read() {
                            reader.read().then((result) => {
                                if (result.done) {
                                    finalize(_pendingMeta || null);
                                    return;
                                }
                                sseBuffer += decoder.decode(result.value, { stream: true });
                                const lines = sseBuffer.split('\n');
                                sseBuffer = lines.pop() || '';
                                lines.forEach((line) => {
                                    if (!line.startsWith('data: '))
                                        return;
                                    try {
                                        const evt = JSON.parse(line.slice(6));
                                        if (evt.t) {
                                            ensureBubble();
                                            queueToken(evt.t);
                                        }
                                        if (evt.done) {
                                            _pendingMeta = evt;
                                            if (!_renderTimer && !_tokenQueue.length)
                                                finalize(_pendingMeta);
                                        }
                                        if (evt.error)
                                            fallbackToRag();
                                    }
                                    catch { /* ignore malformed line */ }
                                });
                                read();
                            }).catch(() => fallbackToRag());
                        }
                        read();
                    })
                        .catch((err) => {
                        if (err && err.name === 'AbortError') {
                            if (thinkWrap && thinkWrap.parentNode)
                                thinkWrap.remove();
                            const _sb = document.getElementById('aiSend');
                            if (_sb)
                                _sb.disabled = false;
                            const _st = document.getElementById('stopBtn');
                            if (_st)
                                _st.style.display = 'none';
                            resolve({ content: [{ text: '' }] });
                        }
                        else {
                            fallbackToRag();
                        }
                    });
                    function fallbackToRag() {
                        if (ansWrap)
                            ansWrap.remove();
                        if (thinkWrap && !thinkWrap.parentNode) {
                            thinkWrap.className = 'ai-msg-wrap typing-wrap';
                            thinkWrap.innerHTML =
                                '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                                    '<div class="typing-bubble"><span></span><span></span><span></span></div>';
                            aiMsgs.appendChild(thinkWrap);
                        }
                        sendRagRequest(_courseId, question, _ragMode, _activeDocId || undefined, activeFileName || undefined, _openFileCtx || undefined)
                            .then((data) => {
                            if (thinkWrap && thinkWrap.parentNode)
                                thinkWrap.remove();
                            let answer = data.answer || 'No answer found.';
                            const confEmoji = data.confidence === 'high' ? '🟢' : data.confidence === 'medium' ? '🟡' : '🔴';
                            if (data.sources && data.sources.length) {
                                answer += '\n\n**Sources:**\n' +
                                    data.sources.map((s) => {
                                        let l = '- ' + (s.file_name || '');
                                        if (s.pages)
                                            l += ', p.' + s.pages;
                                        if (s.section)
                                            l += ' · *' + s.section + '*';
                                        return l;
                                    }).join('\n');
                            }
                            answer += '\n\n' + confEmoji + ' Confidence: ' + (data.confidence || 'medium');
                            resolve({ content: [{ text: answer }], _ragData: data });
                        })
                            .catch((err) => {
                            if (thinkWrap && thinkWrap.parentNode)
                                thinkWrap.remove();
                            const msg = err instanceof Error ? ' (' + err.message + ')' : '';
                            resolve({ content: [{ text: '❌ Could not reach the AI' + msg + '. Please try again.' }] });
                        });
                    }
                    function finalize(meta) {
                        window._activeStreamRender = null;
                        const sources = (meta && meta.sources) || [];
                        const confidence = (meta && meta.confidence) || 'medium';
                        const unsupported = !!(meta && meta.unsupported);
                        const cleanText = rawText.replace(metaPattern, '').trim();
                        if (!cleanText) {
                            if (ansWrap) {
                                ansWrap.remove();
                                ansWrap = null;
                            }
                            fallbackToRag();
                            return;
                        }
                        const confEmoji = confidence === 'high' ? '🟢' : confidence === 'medium' ? '🟡' : '🔴';
                        let footer = confEmoji + ' Confidence: ' + confidence;
                        if (_ragMode === 'general')
                            footer += ' · 🌐 general mode';
                        let fullAnswer = cleanText;
                        if (unsupported && !sources.length) {
                            fullAnswer =
                                '⚠️ *No matching course materials found — answering from general knowledge.*\n\n' +
                                    fullAnswer;
                        }
                        if (sources.length) {
                            fullAnswer += '\n\n**Sources:**\n' +
                                sources.map((s) => {
                                    let line = '- ' + (s.file_name || '');
                                    if (s.pages)
                                        line += ', p.' + s.pages;
                                    if (s.section)
                                        line += ' · *' + s.section + '*';
                                    return line;
                                }).join('\n');
                        }
                        fullAnswer += '\n\n' + footer;
                        const _cacheId = (meta && meta.answerCacheId) || null;
                        window._lastRagMeta = {
                            courseId: _courseId,
                            question,
                            answerCacheId: _cacheId,
                        };
                        _appendCourseHistory(_courseId, question, fullAnswer);
                        if (bubble)
                            bubble.setAttribute('data-raw', fullAnswer);
                        fullRender(fullAnswer);
                        if (ansWrap && !ansWrap.querySelector('.rag-feedback-bar')) {
                            const _mb = ansWrap.querySelector('.msg-body');
                            if (_mb) {
                                _mb.appendChild(_buildRagFeedbackBar({ courseId: _courseId, question, answerCacheId: _cacheId }));
                            }
                        }
                        resolve({
                            content: [{ text: fullAnswer }],
                            _streamWrap: ansWrap,
                            _ragData: meta,
                        });
                    }
                });
            }
            let prior = _chatHistory.slice(-20);
            let firstUser = 0;
            while (firstUser < prior.length && prior[firstUser].role !== 'user')
                firstUser++;
            prior = prior.slice(firstUser);
            const messages = [];
            prior.forEach((m) => {
                messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text || '' });
            });
            messages.push({ role: 'user', content: userContent });
            return sendAiRequest({ max_tokens: 1024, system: sysPrompt, messages });
        })
            .then((data) => {
            const d = data;
            if (myGenId !== state.currentGenId) {
                if (!d._streamWrap)
                    thinkWrap.remove();
                return;
            }
            if (d._streamWrap) {
                const streamBubble = d._streamWrap.querySelector('.ai-bubble.bot');
                const rawFinal = d.content ? d.content.map((b) => b.text || '').join('') : '';
                if (streamBubble) {
                    const _typingSpan = streamBubble.querySelector('.ss-typing-span');
                    if (_typingSpan)
                        _typingSpan.remove();
                    if (window._ssEnsureKatex) {
                        window._ssEnsureKatex().then(() => {
                            if (window._renderMath && streamBubble)
                                window._renderMath(streamBubble);
                            streamBubble.querySelectorAll('.ss-rendered-block').forEach((sd) => {
                                sd.style.opacity = '1';
                            });
                            _autoScroll(aiMsgs);
                        }).catch(() => { });
                    }
                }
                if (window._aiResponseActions && rawFinal && !d._streamWrap.querySelector('.ai-action-bar')) {
                    const mb = d._streamWrap.querySelector('.msg-body');
                    if (mb) {
                        const actions = window._aiResponseActions(rawFinal, 'panel');
                        if (actions)
                            mb.appendChild(actions);
                    }
                }
                const _sb0 = document.getElementById('aiSend');
                if (_sb0)
                    _sb0.disabled = false;
                const _st0 = document.getElementById('stopBtn');
                if (_st0)
                    _st0.style.display = 'none';
                if (window.spawnConfetti)
                    window.spawnConfetti();
                _autoScroll(aiMsgs);
                return;
            }
            if (thinkWrap && thinkWrap.parentNode) {
                thinkWrap.style.transition = 'opacity .3s';
                thinkWrap.style.opacity = '0';
                setTimeout(() => thinkWrap.remove(), 320);
            }
            const _ragMeta = d._ragData
                ? {
                    courseId: window.activeCourseId || '',
                    question,
                    answerCacheId: d._ragData.id || null,
                }
                : null;
            const rawTextLocal = d.error
                ? '❌ Error: ' + (d.error.message || JSON.stringify(d.error))
                : d.content
                    ? d.content.map((b) => b.text || '').join('')
                    : 'No response';
            const ansWrap = document.createElement('div');
            ansWrap.className = 'ai-msg-wrap';
            const tNow = _getTime();
            ansWrap.innerHTML =
                '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                    '<div class="msg-body">' +
                    '<div class="ai-bubble bot" style="min-height:20px"></div>' +
                    '<div class="msg-meta" style="display:none">' +
                    '<span class="msg-time">' + tNow + '</span>' +
                    '<button class="msg-action-btn" data-action="copy">' +
                    (window._t ? window._t('copy_btn') : 'Copy') +
                    '</button>' +
                    '</div>' +
                    '</div>';
            bindMessageActionButtons(ansWrap);
            aiMsgs.appendChild(ansWrap);
            _autoScroll(aiMsgs);
            setTimeout(() => {
                const bubble = ansWrap.querySelector('.ai-bubble.bot');
                const meta = ansWrap.querySelector('.msg-meta');
                if (!bubble || !meta)
                    return;
                const tokens = rawTextLocal.match(/\S+\s*/g) || [];
                let idx = 0;
                let displayed = '';
                const _fbCfg = window.AI_TYPING || {};
                const WORDS_PER_FRAME = _fbCfg.fallbackWordsPerFrame || 1;
                const FRAME_INTERVAL = _fbCfg.fallbackFrameInterval || 38;
                function frame() {
                    if (state.generationStopped || myGenId !== state.currentGenId) {
                        bubble.innerHTML = window.renderMarkdown
                            ? window.renderMarkdown(displayed)
                            : displayed;
                        meta.style.display = 'flex';
                        const eb = ansWrap.querySelector('.ai-action-bar');
                        if (!eb && displayed.trim() && window._aiResponseActions) {
                            const mb = ansWrap.querySelector('.msg-body');
                            const actions = window._aiResponseActions(displayed, 'panel');
                            if (mb && actions)
                                mb.appendChild(actions);
                        }
                        return;
                    }
                    if (idx >= tokens.length) {
                        bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(rawTextLocal) : rawTextLocal;
                        if (window._renderMath)
                            window._renderMath(bubble);
                        meta.style.display = 'flex';
                        if (!ansWrap.querySelector('.ai-action-bar') && window._aiResponseActions) {
                            const mb = ansWrap.querySelector('.msg-body');
                            const actions = window._aiResponseActions(rawTextLocal, 'panel');
                            if (mb && actions)
                                mb.appendChild(actions);
                        }
                        if (_ragMeta && !ansWrap.querySelector('.rag-feedback-bar')) {
                            const mb = ansWrap.querySelector('.msg-body');
                            if (mb)
                                mb.appendChild(_buildRagFeedbackBar(_ragMeta));
                        }
                        const _sb1 = document.getElementById('aiSend');
                        if (_sb1)
                            _sb1.disabled = false;
                        const _st1 = document.getElementById('stopBtn');
                        if (_st1)
                            _st1.style.display = 'none';
                        if (window.spawnConfetti)
                            window.spawnConfetti();
                        state.activeTypeTimer = null;
                        return;
                    }
                    const appEl = document.getElementById('app');
                    const panelHidden = document.hidden ||
                        !!(appEl && appEl.style.display === 'none') ||
                        !aiPanel.classList.contains('visible');
                    const batch = panelHidden ? tokens.length : WORDS_PER_FRAME;
                    for (let w = 0; w < batch && idx < tokens.length; w++)
                        displayed += tokens[idx++];
                    bubble.innerHTML =
                        (window.renderMarkdown ? window.renderMarkdown(displayed) : displayed) +
                            (idx < tokens.length ? '<span class="stream-cursor">▋</span>' : '');
                    if (!panelHidden && aiMsgs.scrollHeight - aiMsgs.scrollTop - aiMsgs.clientHeight < 80) {
                        aiMsgs.scrollTop = aiMsgs.scrollHeight;
                    }
                    state.activeTypeTimer = setTimeout(frame, panelHidden ? 0 : FRAME_INTERVAL);
                }
                state.activeTypeTimer = setTimeout(frame, FRAME_INTERVAL);
            }, 60);
        })
            .catch((e) => {
            thinkWrap.remove();
            const msg = e instanceof Error ? e.message : String(e);
            if (window.addBotMsg)
                window.addBotMsg('❌ Error: ' + msg);
            const _sb2 = document.getElementById('aiSend');
            if (_sb2)
                _sb2.disabled = false;
            const _st2 = document.getElementById('stopBtn');
            if (_st2)
                _st2.style.display = 'none';
        });
    };
}
function _buildRagFeedbackBar(meta) {
    const bar = document.createElement('div');
    bar.className = 'rag-feedback-bar';
    bar.innerHTML =
        '<span class="rag-fb-label">Was this helpful?</span>' +
            '<button class="rag-fb-btn rag-fb-yes" title="Helpful">👍</button>' +
            '<button class="rag-fb-btn rag-fb-no" title="Not helpful">👎</button>' +
            '<button class="rag-fb-btn rag-fb-wrong" title="Wrong answer">⚠️</button>' +
            '<button class="rag-fb-btn rag-fb-cite" title="Missing citation">📄</button>';
    function _send(rating) {
        bar.querySelectorAll('.rag-fb-btn').forEach((b) => {
            b.disabled = true;
        });
        const label = bar.querySelector('.rag-fb-label');
        if (label)
            label.textContent = 'Thanks for your feedback!';
        submitRagFeedback(meta.courseId, meta.question, rating, meta.answerCacheId || null).catch(() => { });
    }
    bar.querySelector('.rag-fb-yes')?.addEventListener('click', () => _send('helpful'));
    bar.querySelector('.rag-fb-no')?.addEventListener('click', () => _send('not_helpful'));
    bar.querySelector('.rag-fb-wrong')?.addEventListener('click', () => _send('wrong_answer'));
    bar.querySelector('.rag-fb-cite')?.addEventListener('click', () => _send('missing_citation'));
    return bar;
}
//# sourceMappingURL=ai-ask.js.map