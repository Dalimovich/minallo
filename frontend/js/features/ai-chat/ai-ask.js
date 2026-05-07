import {
  sendAiRequest,
  sendRagRequest,
  courseHasRagDocs,
  listCourseDocuments,
  submitRagFeedback
} from '../../services/ai-service.js';
import { extractPdfText } from '../pdf-viewer/pdf-text-extraction.js';
import { bindMessageActionButtons } from './ai-message-actions.js';

function _getTime() {
  var d = new Date();
  return (
    d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  );
}

// ── Auto-scroll controller ──────────────────────────────────────────────────
// Tracks whether the user has scrolled up to read while the AI is still writing.
// While they're scrolled up, we DO NOT yank them back to the bottom on every
// token. As soon as they scroll back near the bottom, auto-follow resumes.
var _userScrolledUp = false;
var _scrollListenerAttached = false;
function _ensureScrollTracker() {
  if (_scrollListenerAttached) return;
  var el = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!el) return;
  el.addEventListener('scroll', function () {
    var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    _userScrolledUp = dist > 60;
  });
  _scrollListenerAttached = true;
}
function _autoScroll(el) {
  if (!el) return;
  if (_userScrolledUp) return; // user is reading — do not interrupt
  el.scrollTop = el.scrollHeight;
}
// Exported so callers (e.g. user-action handlers) can force a scroll-to-bottom.
export function _resetScrollFollow() {
  _userScrolledUp = false;
  var el = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (el) el.scrollTop = el.scrollHeight;
}

export async function pdfToImages(maxPages) {
  var pdfDoc = window.pdfDoc;
  if (!pdfDoc) return [];
  var pages = Math.min(pdfDoc.numPages, maxPages || 6);
  var imgs = [];
  for (var i = 1; i <= pages; i++) {
    try {
      var page = await pdfDoc.getPage(i);
      var vp = page.getViewport({ scale: 1.5 });
      var canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      imgs.push(dataUrl.split(',')[1]);
    } catch (e) {
      /* skip failed page */
    }
  }
  return imgs;
}

export function addTyping() {
  var aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!aiMsgs) return null;
  _ensureScrollTracker();
  var wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap typing-wrap';
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
    '<div class="typing-bubble"><span></span><span></span><span></span></div>';
  aiMsgs.appendChild(wrap);
  // Initial typing dots appear: stick to bottom unless user already scrolled up
  _autoScroll(aiMsgs);
  return wrap;
}

// ── Per-course chat history (localStorage) ──────────────────────────────────
// Saves Q&A pairs keyed by courseId so the panel can restore them on open.

var _HISTORY_MAX = 40; // pairs per course
var _HISTORY_PREFIX = 'ss_course_qa_';

function _historyKey(courseId) {
  return _HISTORY_PREFIX + (courseId || 'default');
}

function _loadCourseHistory(courseId) {
  try { return JSON.parse(localStorage.getItem(_historyKey(courseId)) || '[]'); } catch (e) { return []; }
}

function _saveCourseHistory(courseId, pairs) {
  try {
    if (pairs.length > _HISTORY_MAX) pairs = pairs.slice(pairs.length - _HISTORY_MAX);
    localStorage.setItem(_historyKey(courseId), JSON.stringify(pairs));
  } catch (e) {}
}

function _appendCourseHistory(courseId, question, answer) {
  var pairs = _loadCourseHistory(courseId);
  pairs.push({ q: question, a: answer, ts: Date.now() });
  _saveCourseHistory(courseId, pairs);
}

export function restoreCourseHistory(courseId) {
  if (!courseId) return;
  var pairs = _loadCourseHistory(courseId);
  if (!pairs.length) return;
  var aiMsgs = document.getElementById('aiMsgs') || document.querySelector('.ai-msgs');
  if (!aiMsgs) return;
  // Only restore if the panel is currently empty (no prior messages besides system)
  if (aiMsgs.querySelectorAll('.ai-msg-wrap:not(.typing-wrap)').length > 0) return;
  pairs.forEach(function (pair) {
    if (window.addUserMsg) window.addUserMsg(pair.q, true /* skipSave */);
    var wrap = document.createElement('div');
    wrap.className = 'ai-msg-wrap';
    wrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
      '<div class="msg-body"><div class="ai-bubble bot restored-answer"></div></div>';
    var bubble = wrap.querySelector('.ai-bubble.bot');
    if (bubble) {
      bubble.setAttribute('data-raw', pair.a);
      bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(pair.a) : pair.a;
      if (window._renderMath) {
        var _b = bubble;
        if (window._ssEnsureKatex) window._ssEnsureKatex().then(function () { if (window._renderMath) window._renderMath(_b); }).catch(function () {});
        else window._renderMath(_b);
      }
    }
    aiMsgs.appendChild(wrap);
  });
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
}

export function clearCourseHistory(courseId) {
  try { localStorage.removeItem(_historyKey(courseId)); } catch (e) {}
}

export function initAskAI(state) {
  // state: { generationStopped, currentGenId, activeTypeTimer, activeThinkTimer, aiPanel, aiMsgs, BACKEND_URL }
  // Returns the askAI function bound to app-level mutable state refs via callbacks

  return function askAI(question, skipUserBubble) {
    if (!question) return;
    // Abort any in-flight stream before starting a new one so the old backend
    // request is cancelled, not just orphaned in the background.
    if (window._abortCurrentStream) window._abortCurrentStream();
    state.generationStopped = false;
    state.currentGenId++;
    var myGenId = state.currentGenId;

    if (window.pinAI) window.pinAI();

    var _chatHistory = window.serializeChatDOM ? window.serializeChatDOM() : [];
    if (!skipUserBubble && window.addUserMsg) window.addUserMsg(question);

    var _aiSendBtn = document.getElementById('aiSend');
    var _stopBtn = document.getElementById('stopBtn');
    if (_aiSendBtn) _aiSendBtn.disabled = true;
    if (_stopBtn) {
      _stopBtn.style.display = 'flex';
      // Bind abort once per button instance so stop truly cancels the backend request
      if (!_stopBtn.__ssAbortBound) {
        _stopBtn.addEventListener('click', function () {
          if (window._abortCurrentStream) window._abortCurrentStream();
        });
        _stopBtn.__ssAbortBound = true;
      }
    }

    var aiMsgs = document.getElementById('aiMsgs');
    var aiPanel = document.getElementById('aiPanel');
    _ensureScrollTracker();
    // New question: reset auto-follow so the user sees the start of the answer.
    _userScrolledUp = false;

    var thinkWrap = document.createElement('div');
    thinkWrap.className = 'ai-msg-wrap typing-wrap';
    thinkWrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
      '<div class="typing-bubble"><span></span><span></span><span></span></div>';
    aiMsgs.appendChild(thinkWrap);
    aiMsgs.scrollTop = aiMsgs.scrollHeight;

    var pdfDoc = window.pdfDoc;
    var pdfFullText = window.pdfFullText || '';
    var _lang = window._lang || localStorage.getItem('ss_lang') || 'en';
    var activeFileName = window.activeFileName || '';
    var currentCourseShort = window.currentCourseShort || '';
    var _MATH_PROMPT = window._MATH_PROMPT || '';
    var sysPrompt =
      (window._userType === 'learner'
        ? 'You are StudySphere, a German language tutor helping a student prepare for ' +
          (window._germanTest || 'a German exam') +
          (window._germanLevel ? ' at level ' + window._germanLevel : '') +
          '. Always reply in ' +
          (_lang === 'de' ? 'German' : 'English') +
          '. The student is reading "' +
          activeFileName +
          '". ALWAYS base your answers on the actual document content below. Be thorough but concise.'
        : 'You are StudySphere, a friendly tutor for TU Braunschweig engineering students. Always reply in ' +
          (_lang === 'de' ? 'German' : 'English') +
          '. The student is reading "' +
          activeFileName +
          '" from ' +
          currentCourseShort +
          '. ALWAYS base your answers on the actual document content provided below. Do not use general knowledge when the document covers the topic. Be thorough but concise.') +
      _MATH_PROMPT;

    // If a PDF is open but text extraction hasn't finished yet, do it now so the AI can read the file.
    var _textReady =
      pdfDoc && !pdfFullText.trim()
        ? extractPdfText(pdfDoc, 30).then(function (t) {
            if (t) {
              window.pdfFullText = t;
              pdfFullText = t;
            }
          })
        : Promise.resolve();

    _textReady
      .then(function () {
        var isHandwritten = pdfDoc && pdfFullText.trim().length < 100;
        return isHandwritten ? pdfToImages(6) : [];
      })
      .then(async function (pageImages) {
        var userContent;
        if (pageImages.length) {
          sysPrompt +=
            '\n\nThis document is handwritten or scanned. Pages are provided as images — read all handwritten text, equations, and diagrams carefully.';
          userContent = [{ type: 'text', text: question }].concat(
            pageImages.map(function (b64) {
              return { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } };
            })
          );
        } else {
          sysPrompt +=
            '\n\nDOCUMENT CONTENT:\n' + (pdfFullText || '(document text not yet extracted)');
          userContent = question;
        }

        // Use RAG if this course has indexed documents — always search across ALL course docs
        var _courseId = window.activeCourseId || window.currentCourseId || '';
        var _hasRag = false;
        var _activeDocId = window.activeRagDocumentId || null; // only set when explicitly pinned by user
        if (_courseId) {
          try {
            var _docs = await listCourseDocuments(_courseId);
            var _readyDocs = _docs.filter(function (d) { return d.processing_status === 'ready'; });
            _hasRag = _readyDocs.length > 0;
          } catch (e) { _hasRag = false; }
        }

        // Extract a focused excerpt from the open PDF around the mentioned exercise/topic.
        // Sent to the backend so the AI always sees the problem statement even if vector
        // search returns only solution chunks.
        var _openFileCtx = '';
        if (pdfFullText && pdfFullText.trim().length > 50) {
          var _rawText = pdfFullText;
          // Ordered by specificity — first match wins
          var _exercisePatterns = [
            // German compound: Aufgabe 1.1b, Übung 2, Uebung 2, Beispiel 3, Lösung 4, Loesung 4
            /\b(aufgabe\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(aufgabe\s*\d+\s*[a-z]\b)/i,
            /\b(ü?bung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(uebung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(beispiel\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(l[oö]sung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(loesung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(teilaufgabe\s+[a-z\d])\b/i,
            // English
            /\b(exercise\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(task\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(problem\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(example\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            // Pure numbered: 1.1b, 1.1, 3b)
            /\b(\d+\.\d+[a-z]?)\b/i,
            /\b(\d+\s*[a-z]\s*\))/i,  // 3b)
            /\b(\d+[a-z])\b/i           // 1b, 3b
          ];
          var _matchTerm = null;
          for (var _pi = 0; _pi < _exercisePatterns.length; _pi++) {
            var _m = question.match(_exercisePatterns[_pi]);
            if (_m) { _matchTerm = _m[0].trim(); break; }
          }
          if (_matchTerm) {
            // Normalize ü/ö/ß for search (PDF text may use different encoding)
            function _normDe(s) {
              return s.replace(/ü/g, 'ue').replace(/ö/g, 'oe').replace(/ä/g, 'ae')
                      .replace(/Ü/g, 'Ue').replace(/Ö/g, 'Oe').replace(/Ä/g, 'Ae')
                      .replace(/ß/g, 'ss').toLowerCase();
            }
            var _normTerm = _normDe(_matchTerm);
            var _normText = _normDe(_rawText);
            var _idx = _normText.indexOf(_normTerm);
            if (_idx < 0) {
              // Try searching without spaces (e.g. "Aufgabe1.1" vs "Aufgabe 1.1")
              var _compactTerm = _normTerm.replace(/\s+/g, '');
              var _compactText = _normText.replace(/\s+/g, '');
              var _cidx = _compactText.indexOf(_compactTerm);
              if (_cidx >= 0) {
                // Map compact index back to raw text index (approximate)
                var _charCount = 0, _rawIdx = 0;
                for (var _ri = 0; _ri < _rawText.length && _charCount < _cidx; _ri++) {
                  if (_rawText[_ri].trim()) _charCount++;
                  _rawIdx = _ri;
                }
                _idx = _rawIdx;
              }
            }
            if (_idx >= 0) {
              _openFileCtx = _rawText.slice(Math.max(0, _idx - 200), _idx + 2000);
            }
          }
          if (!_openFileCtx) _openFileCtx = _rawText.slice(0, 2000);
        }

        if (_hasRag) {
          var _modeToggle = document.getElementById('aiModeStrict');
          var _ragMode = !_modeToggle || _modeToggle.checked ? 'strict' : 'general';

          // Use streaming endpoint — renders tokens progressively
          return new Promise(function (resolve) {
            var BACKEND_URL = window.BACKEND_URL || '';
            var token = window._sbToken || '';

            // Keep typing dots visible until the first token arrives
            var ansWrap = null;
            var bubble = null;
            var rawText = '';
            var metaPattern = /<!--META-->[\s\S]*?<!--\/META-->/g;
            // Token render queue — drains at ~40ms per token so text flows naturally.
            // pendingMeta is set when the SSE 'done' event arrives; the queue keeps
            // draining at the same pace and calls finalize only when empty.
            var _tokenQueue = [];
            var _renderTimer = null;
            var _pendingMeta = undefined;
            var CFG = window.AI_TYPING || {};
            var TOKEN_INTERVAL = CFG.streamTokenInterval || 38;

            // ── Block-by-block rendering ──────────────────────────────────────
            // Split accumulated text into logical blocks (paragraphs, math, code,
            // headings, lists). Completed blocks are rendered with markdown+KaTeX.
            // The block currently being typed shows as plain text.
            // KaTeX never sees partial text, so expressions always render correctly.

            var _renderedBlockCount = 0; // how many blocks already have a rendered div

            function splitBlocks(text) {
              // Split on double newline boundaries but keep fenced code, $$ and \[..\] together
              var blocks = [];
              var lines = text.split('\n');
              var buf = [];
              var inCode = false;
              var inMath = false; // $$ block
              var inLatex = false; // \[ block

              for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!inCode && /^```/.test(line)) inCode = true;
                else if (inCode && /^```/.test(line)) { buf.push(line); inCode = false; blocks.push(buf.join('\n')); buf = []; continue; }
                if (!inLatex && /^\s*\\\[/.test(line)) inLatex = true;
                else if (inLatex && /\\\]/.test(line)) { buf.push(line); inLatex = false; blocks.push(buf.join('\n')); buf = []; continue; }
                if (!inMath && /^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) inMath = true;
                else if (inMath && /\$\$/.test(line)) { buf.push(line); inMath = false; blocks.push(buf.join('\n')); buf = []; continue; }

                if (!inCode && !inMath && !inLatex && line.trim() === '' && buf.length) {
                  blocks.push(buf.join('\n'));
                  buf = [];
                } else {
                  buf.push(line);
                }
              }
              if (buf.length) blocks.push(buf.join('\n'));
              return blocks.filter(function (b) { return b.trim(); });
            }

            function renderBlock(text) {
              // Render a single completed block with markdown+KaTeX, faded in
              var div = document.createElement('div');
              div.className = 'ss-rendered-block';
              div.style.opacity = '0';
              div.style.transition = 'opacity 0.2s ease';
              div.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : text;
              return div;
            }

            function applyKatexToBlock(div) {
              if (window._ssEnsureKatex) {
                window._ssEnsureKatex().then(function () {
                  if (window._renderMath && div) {
                    window._renderMath(div);
                    div.style.opacity = '1';
                    _autoScroll(aiMsgs);
                  }
                }).catch(function () { div.style.opacity = '1'; });
              } else {
                div.style.opacity = '1';
              }
            }

            function updateBlockRender() {
              if (!bubble) return;
              var display = rawText.replace(metaPattern, '').trimEnd();
              var blocks = splitBlocks(display);
              // blocks[0..n-2] = completed, blocks[n-1] = currently typing

              // Ensure typing span exists BEFORE inserting completed blocks
              var typingSpan = bubble.querySelector('.ss-typing-span');
              if (!typingSpan) {
                typingSpan = document.createElement('span');
                typingSpan.className = 'ss-typing-span';
                typingSpan.style.whiteSpace = 'pre-wrap';
                bubble.appendChild(typingSpan);
              }

              // Add rendered divs for newly completed blocks, always before typing span
              var completedCount = blocks.length - 1; // last block still in progress
              while (_renderedBlockCount < completedCount) {
                var div = renderBlock(blocks[_renderedBlockCount]);
                bubble.insertBefore(div, typingSpan);
                applyKatexToBlock(div);
                _renderedBlockCount++;
              }

              // Strip any partial META block before showing in typing span
              var typingText = (blocks[blocks.length - 1] || '').replace(/<!--META-->[\s\S]*$/, '');
              typingSpan.textContent = typingText;
              _autoScroll(aiMsgs);
            }

            // Final render: clear streaming artifacts and do one clean markdown render.
            // We don't reuse _renderedBlockCount here because finalize may prepend a
            // warning block to fullAnswer, shifting all block indices vs what was
            // rendered incrementally. A clean innerHTML replacement is safe at this
            // point — the streaming typing effect has already been shown.
            function fullRender(text) {
              if (!bubble) return;
              var display = text.replace(metaPattern, '').trim();
              if (!display) return;
              bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(display) : display;
              if (window._ssEnsureKatex) {
                window._ssEnsureKatex().then(function () {
                  if (window._renderMath && bubble) window._renderMath(bubble);
                  _autoScroll(aiMsgs);
                }).catch(function () {});
              } else if (window._renderMath) {
                window._renderMath(bubble);
              }
              _autoScroll(aiMsgs);
            }

            function drainQueue() {
              if (!_tokenQueue.length) {
                _renderTimer = null;
                if (_pendingMeta !== undefined) finalize(_pendingMeta);
                return;
              }
              var tok = _tokenQueue.shift();
              rawText += tok;
              if (bubble) updateBlockRender();
              _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
            }

            function queueToken(tok) {
              _tokenQueue.push(tok);
              if (!_renderTimer) _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
            }

            // Expose so stopGeneration can trigger a final render on interrupt
            window._activeStreamRender = function () {
              if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
              while (_tokenQueue.length) rawText += _tokenQueue.shift();
              fullRender(rawText);
            };

            function ensureBubble() {
              if (ansWrap) return;
              // Fade out dots, insert answer bubble
              thinkWrap.style.transition = 'opacity .15s';
              thinkWrap.style.opacity = '0';
              setTimeout(function () { thinkWrap.remove(); }, 160);

              ansWrap = document.createElement('div');
              ansWrap.className = 'ai-msg-wrap';
              ansWrap.innerHTML =
                '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
                '<div class="msg-body"><div class="ai-bubble bot" style="min-height:20px"></div></div>';
              aiMsgs.appendChild(ansWrap);
              _autoScroll(aiMsgs);
              // Scope to ansWrap — id="streamBubble" was non-unique across multiple answers,
              // causing follow-up questions to stream into the FIRST (oldest) bubble.
              bubble = ansWrap.querySelector('.ai-bubble.bot');
            }

            var _streamController = new AbortController();
            window._abortCurrentStream = function () { _streamController.abort(); };

            fetch(BACKEND_URL + '/api/ai/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              signal: _streamController.signal,
              body: JSON.stringify({
                courseId: _courseId,
                question: question,
                mode: _ragMode,
                documentId: _activeDocId || undefined,
                activeFileName: activeFileName || undefined,
                openFileContext: _openFileCtx || undefined
              })
            }).then(function (res) {
              if (!res.ok) { fallbackToRag(); return; }
              var reader = res.body.getReader();
              var decoder = new TextDecoder();
              var sseBuffer = '';

              function read() {
                reader.read().then(function (result) {
                  if (result.done) { finalize(null); return; }
                  sseBuffer += decoder.decode(result.value, { stream: true });
                  var lines = sseBuffer.split('\n');
                  sseBuffer = lines.pop();
                  lines.forEach(function (line) {
                    if (!line.startsWith('data: ')) return;
                    try {
                      var evt = JSON.parse(line.slice(6));
                      if (evt.t) {
                        ensureBubble(); // swap dots → bubble on first token
                        queueToken(evt.t);
                      }
                      if (evt.done) {
                        _pendingMeta = evt;
                        if (!_renderTimer && !_tokenQueue.length) finalize(_pendingMeta);
                      }
                      if (evt.error) { fallbackToRag(); }
                    } catch (e) {}
                  });
                  read();
                }).catch(function () { fallbackToRag(); });
              }
              read();
            }).catch(function (err) {
              if (err && err.name === 'AbortError') {
                if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                var _sb = document.getElementById('aiSend'); if (_sb) _sb.disabled = false;
                var _st = document.getElementById('stopBtn'); if (_st) _st.style.display = 'none';
                resolve({ content: [{ text: '' }] });
              } else { fallbackToRag(); }
            });

            function fallbackToRag() {
              // Stream failed — fall back to non-streaming ai-ask endpoint
              if (ansWrap) ansWrap.remove();
              if (thinkWrap && !thinkWrap.parentNode) {
                thinkWrap.className = 'ai-msg-wrap typing-wrap';
                thinkWrap.innerHTML =
                  '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
                  '<div class="typing-bubble"><span></span><span></span><span></span></div>';
                aiMsgs.appendChild(thinkWrap);
              }
              sendRagRequest(_courseId, question, _ragMode, _activeDocId || undefined, activeFileName || undefined, _openFileCtx || undefined).then(function (data) {
                if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                var answer = data.answer || 'No answer found.';
                var confEmoji = data.confidence === 'high' ? '🟢' : data.confidence === 'medium' ? '🟡' : '🔴';
                if (data.sources && data.sources.length) {
                  answer += '\n\n**Sources:**\n' + data.sources.map(function (s) {
                    var l = '- ' + s.file_name;
                    if (s.pages) l += ', p.' + s.pages;
                    if (s.section) l += ' · *' + s.section + '*';
                    return l;
                  }).join('\n');
                }
                answer += '\n\n' + confEmoji + ' Confidence: ' + (data.confidence || 'medium');
                resolve({ content: [{ text: answer }], _ragData: data });
              }).catch(function () {
                if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                resolve({ content: [{ text: '❌ Could not reach the AI. Please try again.' }] });
              });
            }

            function finalize(meta) {
              window._activeStreamRender = null; // no longer stoppable
              var sources = (meta && meta.sources) || [];
              var confidence = (meta && meta.confidence) || 'medium';
              var qType = (meta && meta.question_type) || '';
              var unsupported = !!(meta && meta.unsupported);

              // Final rendered text — strip META tag then apply markdown
              var cleanText = rawText.replace(metaPattern, '').trim();
              if (!cleanText) cleanText = 'No answer received.';

              var confEmoji = confidence === 'high' ? '🟢' : confidence === 'medium' ? '🟡' : '🔴';
              var footer = confEmoji + ' Confidence: ' + confidence;
              if (_ragMode === 'general') footer += ' · 🌐 general mode';

              var fullAnswer = cleanText;
              if (unsupported && !sources.length) {
                fullAnswer = '⚠️ *No matching course materials found — answering from general knowledge.*\n\n' + fullAnswer;
              }
              if (sources.length) {
                fullAnswer += '\n\n**Sources:**\n' + sources.map(function (s) {
                  var line = '- ' + s.file_name;
                  if (s.pages) line += ', p.' + s.pages;
                  if (s.section) line += ' · *' + s.section + '*';
                  return line;
                }).join('\n');
              }
              fullAnswer += '\n\n' + footer;

              var _cacheId = (meta && meta.answerCacheId) || null;
              window._lastRagMeta = { courseId: _courseId, question: question, answerCacheId: _cacheId };

              // Persist Q&A to localStorage for history restoration
              _appendCourseHistory(_courseId, question, fullAnswer);

              // Store raw markdown on bubble so serializeChatDOM can read it correctly
              if (bubble) bubble.setAttribute('data-raw', fullAnswer);

              // Render all remaining blocks with markdown+KaTeX
              fullRender(fullAnswer);

              // Feedback bar for streaming answers (uses cacheId so ratings are properly linked)
              if (ansWrap && !ansWrap.querySelector('.rag-feedback-bar')) {
                var _mb = ansWrap.querySelector('.msg-body');
                if (_mb) _mb.appendChild(_buildRagFeedbackBar({ courseId: _courseId, question: question, answerCacheId: _cacheId }));
              }

              resolve({ content: [{ text: fullAnswer }], _streamWrap: ansWrap, _ragData: meta });
            }
          });
        }

        var prior = _chatHistory.slice(-20);
        var firstUser = 0;
        while (firstUser < prior.length && prior[firstUser].role !== 'user') firstUser++;
        prior = prior.slice(firstUser);
        var messages = [];
        prior.forEach(function (m) {
          messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text || '' });
        });
        messages.push({ role: 'user', content: userContent });

        return sendAiRequest({ max_tokens: 1024, system: sysPrompt, messages: messages });
      })
      .then(function (data) {
        if (myGenId !== state.currentGenId) {
          if (!data._streamWrap) thinkWrap.remove();
          return;
        }

        // Streaming path already rendered the bubble — just do final markdown render
        if (data._streamWrap) {
          var streamBubble = data._streamWrap.querySelector('.ai-bubble.bot');
          var rawFinal = data.content ? data.content.map(function (b) { return b.text || ''; }).join('') : '';
          // fullRender was already called inside finalize's queue drain.
          // Just ensure the typing span is cleaned up and math is applied.
          if (streamBubble) {
            var _typingSpan = streamBubble.querySelector('.ss-typing-span');
            if (_typingSpan) _typingSpan.remove();
            if (window._ssEnsureKatex) {
              var _sbEl = streamBubble;
              window._ssEnsureKatex().then(function () {
                if (window._renderMath && _sbEl) window._renderMath(_sbEl);
                _sbEl.querySelectorAll('.ss-rendered-block').forEach(function (d) { d.style.opacity = '1'; });
                _autoScroll(aiMsgs);
              }).catch(function () {});
            }
          }
          if (window._aiResponseActions && rawFinal && !data._streamWrap.querySelector('.ai-action-bar')) {
            var mb = data._streamWrap.querySelector('.msg-body');
            if (mb) mb.appendChild(window._aiResponseActions(rawFinal, 'panel'));
          }
          var _sb0 = document.getElementById('aiSend');
          if (_sb0) _sb0.disabled = false;
          var _st0 = document.getElementById('stopBtn');
          if (_st0) _st0.style.display = 'none';
          if (window.spawnConfetti) window.spawnConfetti();
          _autoScroll(aiMsgs);
          return;
        }

        // Non-streaming fallback: dots still showing, fade them out now
        if (thinkWrap && thinkWrap.parentNode) {
          thinkWrap.style.transition = 'opacity .3s';
          thinkWrap.style.opacity = '0';
          setTimeout(function () { thinkWrap.remove(); }, 320);
        }

        var _ragMeta = data._ragData
          ? {
              courseId: window.activeCourseId || '',
              question: question,
              answerCacheId: data._ragData.id || null
            }
          : null;

        var rawText = data.error
          ? '❌ Error: ' + (data.error.message || JSON.stringify(data.error))
          : data.content
            ? data.content
                .map(function (b) {
                  return b.text || '';
                })
                .join('')
            : 'No response';

        var ansWrap = document.createElement('div');
        ansWrap.className = 'ai-msg-wrap';
        var t = _getTime();
        ansWrap.innerHTML =
          '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>StudySphere AI</div>' +
          '<div class="msg-body">' +
          '<div class="ai-bubble bot" style="min-height:20px"></div>' +
          '<div class="msg-meta" style="display:none">' +
          '<span class="msg-time">' +
          t +
          '</span>' +
          '<button class="msg-action-btn" data-action="copy">' +
          (window._t ? window._t('copy_btn') : 'Copy') +
          '</button>' +
          '</div>' +
          '</div>';
        bindMessageActionButtons(ansWrap);
        aiMsgs.appendChild(ansWrap);
        _autoScroll(aiMsgs);

        setTimeout(function () {
          var bubble = ansWrap.querySelector('.ai-bubble.bot');
          var meta = ansWrap.querySelector('.msg-meta');
          var tokens = rawText.match(/\S+\s*/g) || [];
          var idx = 0;
          var displayed = '';
          var _fbCfg = window.AI_TYPING || {};
          var WORDS_PER_FRAME = _fbCfg.fallbackWordsPerFrame || 1;
          var FRAME_INTERVAL = _fbCfg.fallbackFrameInterval || 38;

          function frame() {
            if (state.generationStopped || myGenId !== state.currentGenId) {
              bubble.innerHTML = window.renderMarkdown
                ? window.renderMarkdown(displayed)
                : displayed;
              meta.style.display = 'flex';
              var eb = ansWrap.querySelector('.ai-action-bar');
              if (!eb && displayed.trim() && window._aiResponseActions)
                ansWrap
                  .querySelector('.msg-body')
                  .appendChild(window._aiResponseActions(displayed, 'panel'));
              return;
            }
            if (idx >= tokens.length) {
              bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(rawText) : rawText;
              if (window._renderMath) window._renderMath(bubble);
              meta.style.display = 'flex';
              if (!ansWrap.querySelector('.ai-action-bar') && window._aiResponseActions)
                ansWrap
                  .querySelector('.msg-body')
                  .appendChild(window._aiResponseActions(rawText, 'panel'));
              // RAG feedback bar
              if (_ragMeta && !ansWrap.querySelector('.rag-feedback-bar')) {
                ansWrap.querySelector('.msg-body').appendChild(_buildRagFeedbackBar(_ragMeta));
              }
              var _sb1 = document.getElementById('aiSend');
              if (_sb1) _sb1.disabled = false;
              var _st1 = document.getElementById('stopBtn');
              if (_st1) _st1.style.display = 'none';
              if (window.spawnConfetti) window.spawnConfetti();
              state.activeTypeTimer = null;
              return;
            }
            var appEl = document.getElementById('app');
            var panelHidden =
              document.hidden ||
              (appEl && appEl.style.display === 'none') ||
              !aiPanel.classList.contains('visible');
            var batch = panelHidden ? tokens.length : WORDS_PER_FRAME;
            for (var w = 0; w < batch && idx < tokens.length; w++) displayed += tokens[idx++];
            bubble.innerHTML =
              (window.renderMarkdown ? window.renderMarkdown(displayed) : displayed) +
              (idx < tokens.length ? '<span class="stream-cursor">▋</span>' : '');
            if (!panelHidden && aiMsgs.scrollHeight - aiMsgs.scrollTop - aiMsgs.clientHeight < 80)
              aiMsgs.scrollTop = aiMsgs.scrollHeight;
            state.activeTypeTimer = setTimeout(frame, panelHidden ? 0 : FRAME_INTERVAL);
          }

          state.activeTypeTimer = setTimeout(frame, FRAME_INTERVAL);
        }, 60);
      })
      .catch(function (e) {
        thinkWrap.remove();
        if (window.addBotMsg) window.addBotMsg('❌ Error: ' + e.message);
        var _sb2 = document.getElementById('aiSend');
        if (_sb2) _sb2.disabled = false;
        var _st2 = document.getElementById('stopBtn');
        if (_st2) _st2.style.display = 'none';
      });
  };
}

function _buildRagFeedbackBar(meta) {
  var bar = document.createElement('div');
  bar.className = 'rag-feedback-bar';
  bar.innerHTML =
    '<span class="rag-fb-label">Was this helpful?</span>' +
    '<button class="rag-fb-btn rag-fb-yes" title="Helpful">👍</button>' +
    '<button class="rag-fb-btn rag-fb-no" title="Not helpful">👎</button>' +
    '<button class="rag-fb-btn rag-fb-wrong" title="Wrong answer">⚠️</button>' +
    '<button class="rag-fb-btn rag-fb-cite" title="Missing citation">📄</button>';

  function _send(rating) {
    bar.querySelectorAll('.rag-fb-btn').forEach(function (b) {
      b.disabled = true;
    });
    bar.querySelector('.rag-fb-label').textContent = 'Thanks for your feedback!';
    submitRagFeedback(meta.courseId, meta.question, rating, meta.answerCacheId).catch(
      function () {}
    );
  }

  bar.querySelector('.rag-fb-yes').addEventListener('click', function () {
    _send('helpful');
  });
  bar.querySelector('.rag-fb-no').addEventListener('click', function () {
    _send('not_helpful');
  });
  bar.querySelector('.rag-fb-wrong').addEventListener('click', function () {
    _send('wrong_answer');
  });
  bar.querySelector('.rag-fb-cite').addEventListener('click', function () {
    _send('missing_citation');
  });

  return bar;
}
