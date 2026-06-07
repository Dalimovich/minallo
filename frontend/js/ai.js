// ═══════════════════════════════════════════════════════════════════════════
//  js/ai.js — Minallo AI Engine
//  Loaded after app.js; overrides askAI, chipPrompt, and runMultiSummary.
//  Edit this file to change model, prompts, token limits, or response style.
// ═══════════════════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────────────────────
var AI_CFG = (window.MinalloConfig && window.MinalloConfig.ai) || {};
var _aiUserScrolled = false; // true when user has manually scrolled up during generation
var _attachedImages = []; // array of { data: base64string, mediaType: string }, max AI_IMG_MAX
var AI_IMG_MAX = AI_CFG.imageMax || 5; // max images per message (keeps token budget sane)

// ── STREAM STATE (for flush-before-save on page unload) ──────────────────
var _curRawText = '';
var _curBubble = null;
var _curAnswWrap = null;

var AI_MODEL = AI_CFG.model || 'claude-sonnet-4-5';
var AI_MAX_TOK = AI_CFG.maxTokens || 4096; // allows long, thorough answers
var AI_PDF_CAP = AI_CFG.pdfCharacterCap || 100000; // covers long PDFs

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
function _buildSystemPrompt() {
  var docText = pdfFullText
    ? pdfFullText.slice(0, AI_PDF_CAP)
    : '(no document loaded — answer from general knowledge and note the document is not available)';

  return (
    'You are Minallo, an expert academic tutor for university engineering students.\n' +
    'The student is reading "' +
    (activeFileName || 'a document') +
    '"' +
    (currentCourseShort ? ' from the course ' + currentCourseShort + '.' : '.') +
    '\n\n' +
    'RESPONSE STYLE RULES — follow these strictly:\n' +
    '- Write in clear, explanatory prose. Do not answer with raw bullet lists unless the content is genuinely list-like (e.g. steps, a list of symbols).\n' +
    '- When explaining a concept, write complete sentences that build understanding from first principles.\n' +
    '- Be thorough and precise — explain *why* something works, not just *what* it is.\n' +
    '- For formulas: write out the expression, then define every variable in a sentence each, then explain in plain language what the formula computes and when it applies.\n' +
    '- Respond ENTIRELY in ' +
    (typeof _lang !== 'undefined' && _lang === 'de' ? 'German (Deutsch)' : 'English') +
    '. Do not switch languages mid-response.\n' +
    '- If the document does not cover a topic, say so clearly instead of inventing an answer.\n' +
    '- Use **bold** for key terms, `monospace` for code/variables, and ### headers to separate major sections.\n\n' +
    'CONTENT RULES:\n' +
    '- Base every answer on the document content below. Do not substitute general knowledge when the document covers the topic.\n' +
    '- If the student asks something not in the document, answer from general knowledge but state that clearly.\n\n' +
    'DOCUMENT CONTENT:\n' +
    docText
  );
}

// ── askAI — core Q&A ──────────────────────────────────────────────────────
// `let` (not `var`!) is intentional. js/ai.js is loaded as a CLASSIC script,
// not a module, so top-level `var` still becomes a window property — which
// would clobber the RAG-first window.askAI installed by ai-ask-bridge. `let`
// at the top of a non-module script stays out of window. The name `askAI` is
// kept so the local reference at the bottom of this file (chipPrompt →
// askAI(prompt)) still resolves to this legacy implementation.
let askAI = function (question, skipUserBubble) {
  if (!question) return;
  generationStopped = false;
  currentGenId++;
  var myGenId = currentGenId;
  var _myChatKey = typeof _prevChatKey !== 'undefined' ? _prevChatKey : null; // capture now, before any async
  pinAI();

  // Snapshot + clear images before anything else
  var _imgs = _attachedImages.slice();
  _attachedImages = [];
  window._attachedImages = _attachedImages;
  _renderImgPreviews();

  if (!skipUserBubble) {
    if (_imgs.length > 0) {
      // User bubble with image thumbnails above the text
      var userWrap = document.createElement('div');
      userWrap.className = 'ai-msg-wrap user';
      var _t = typeof getTime === 'function' ? getTime() : '';
      var _safe = question.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var _imgsHtml = _imgs
        .map(function (img) {
          return (
            '<img class="ai-msg-img" src="data:' +
            img.mediaType +
            ';base64,' +
            img.data +
            '" alt="image">'
          );
        })
        .join('');
      userWrap.innerHTML =
        '<div class="msg-sender user-sender"><span class="msg-sender-dot"></span>You</div>' +
        '<div class="msg-body">' +
        '<div class="ai-msg-imgs">' +
        _imgsHtml +
        '</div>' +
        '<div class="ai-bubble user">' +
        _safe +
        '</div>' +
        '<div class="msg-meta"><span class="msg-time">' +
        _t +
        '</span></div>' +
        '</div>';
      aiMsgs.appendChild(userWrap);
      aiMsgs.scrollTop = aiMsgs.scrollHeight;
    } else {
      addUserMsg(question);
    }
  }

  var sendBtn = document.getElementById('aiSend');
  sendBtn.disabled = false; // keep clickable so stop works
  sendBtn.classList.add('is-stop');

  var thinkWrap = document.createElement('div');
  thinkWrap.className = 'ai-msg-wrap typing-wrap';
  thinkWrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
    '<div class="typing-bubble"><span></span><span></span><span></span></div>';
  aiMsgs.appendChild(thinkWrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;

  var msgContent;
  if (_imgs.length > 0) {
    msgContent = _imgs.map(function (img) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      };
    });
    msgContent.push({ type: 'text', text: question });
  } else {
    msgContent = question;
  }

  fetch(BACKEND_URL + '/api/ai', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window._sbToken || '')
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: AI_MAX_TOK,
      system: _buildSystemPrompt(),
      messages: [{ role: 'user', content: msgContent }]
    })
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (myGenId !== currentGenId) {
        thinkWrap.remove();
        return;
      }
      thinkWrap.style.transition = 'opacity .3s';
      thinkWrap.style.opacity = '0';
      setTimeout(function () {
        thinkWrap.remove();
      }, 320);

      var rawText = data.error
        ? '\u274C Error: ' + (data.error.message || JSON.stringify(data.error))
        : data.content
          ? data.content
              .map(function (b) {
                return b.text || '';
              })
              .join('')
          : 'No response';

      var ansWrap = document.createElement('div');
      ansWrap.className = 'ai-msg-wrap';
      var t = getTime();
      ansWrap.innerHTML =
        '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
        '<div class="msg-body">' +
        '<div class="ai-bubble bot" style="min-height:20px"></div>' +
        '<div class="msg-meta" style="display:none">' +
        '<span class="msg-time">' +
        t +
        '</span>' +
        '<button class="msg-action-btn" data-action="copy">Copy</button>' +
        '</div>' +
        '</div>';
      aiMsgs.appendChild(ansWrap);
      aiMsgs.scrollTop = aiMsgs.scrollHeight;
      ansWrap.querySelectorAll('.msg-action-btn[data-action="copy"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (typeof window.copyBubble === 'function') window.copyBubble(btn);
        });
      });

      var bubble = ansWrap.querySelector('.ai-bubble.bot');
      var meta = ansWrap.querySelector('.msg-meta');
      _curRawText = rawText;
      _curBubble = bubble;
      _curAnswWrap = ansWrap;

      function _finishRender(text) {
        try {
          bubble.innerHTML = renderMarkdown(text);
        } catch (e) {}
        // Clear stream state and save FIRST before anything else that might throw
        _curBubble = null;
        _curRawText = '';
        _curAnswWrap = null;
        var _keyToSave = _myChatKey || (typeof _prevChatKey !== 'undefined' ? _prevChatKey : null);
        console.log(
          '[AI] _finishRender key=',
          _keyToSave,
          'msgs in DOM=',
          typeof aiMsgs !== 'undefined' ? aiMsgs.querySelectorAll('.ai-msg-wrap').length : 'N/A'
        );
        if (typeof saveChatForFile === 'function' && _keyToSave) {
          try {
            saveChatForFile(_keyToSave);
            console.log('[AI] saveChatForFile called for', _keyToSave);
          } catch (e) {
            console.warn('chat save failed', e);
          }
        } else {
          console.warn(
            '[AI] _finishRender: save skipped — key=',
            _keyToSave,
            'saveChatForFile=',
            typeof saveChatForFile
          );
        }
        try {
          if (typeof _renderMath === 'function') _renderMath(bubble);
          meta.style.display = 'flex';
          var msgBody = ansWrap.querySelector('.msg-body');
          if (
            msgBody &&
            typeof _aiResponseActions === 'function' &&
            !ansWrap.querySelector('.ai-action-bar')
          ) {
            msgBody.appendChild(_aiResponseActions(text, 'panel'));
          }
        } catch (e) {}
      }

      window._ssPreUnloadHook = function () {
        if (_curBubble && _curRawText) {
          clearTimeout(activeTypeTimer);
          _finishRender(_curRawText);
        }
      };

      setTimeout(function () {
        var words = rawText.split(/(\s+)/);
        var wIdx = 0;
        var CHUNK = 18;
        function typeNext() {
          if (generationStopped || myGenId !== currentGenId) {
            _finishRender(words.slice(0, wIdx).join('') || rawText);
            document.getElementById('aiSend').classList.remove('is-stop');
            if (typeof deferredSave === 'function') deferredSave();
            return;
          }
          if (document.hidden || wIdx >= words.length) {
            _finishRender(rawText);
            document.getElementById('aiSend').classList.remove('is-stop');
            _aiUserScrolled = false;
            spawnConfetti();
            return;
          }
          wIdx = Math.min(wIdx + CHUNK, words.length);
          bubble.innerHTML =
            renderMarkdown(words.slice(0, wIdx).join('')) +
            '<span class="stream-cursor">\u258b</span>';
          if (!_aiUserScrolled) aiMsgs.scrollTop = aiMsgs.scrollHeight;
          activeTypeTimer = setTimeout(function () {
            window.requestAnimationFrame(typeNext);
          }, 34);
        }
        var _visHandler = function () {
          if (!document.hidden && myGenId === currentGenId) {
            clearTimeout(activeTypeTimer);
            window.requestAnimationFrame(typeNext);
          }
          document.removeEventListener('visibilitychange', _visHandler);
        };
        document.addEventListener('visibilitychange', _visHandler);
        window.requestAnimationFrame(typeNext);
      }, 340);
    })
    .catch(function (e) {
      thinkWrap.remove();
      addBotMsg('\u274C Error: ' + e.message);
      document.getElementById('aiSend').classList.remove('is-stop');
    });
};
// IMPORTANT: do NOT publish this legacy askAI as window.askAI. The TS bridge
// (frontend/js/features/ai-chat/ai-ask.ts) installs a RAG-first askAI that
// routes every course question to /ask-stream so Phase-1 verification +
// confidence-from-verification + math-template gating apply. Overwriting it
// here would silently bypass all grounding and let the model invent textbook
// formulas (the Nachgiebigkeit / Schweißnaht regression). The legacy is kept
// only as _legacyAskAI so the image-attachment hook in ai-ask-bridge can still
// reach a vision-capable path when the user snips/attaches an image.
window._legacyAskAI = askAI;

// ── chipPrompt — quick action buttons ────────────────────────────────────
function chipPrompt(type, level) {
  var hasDoc = !!pdfFullText;
  var ref = hasDoc
    ? 'Based strictly on the document "' + activeFileName + '" provided in the system prompt, '
    : 'As a knowledgeable tutor (no document is loaded), ';
  if (!hasDoc)
    addBotMsg('\uD83D\uDCA1 Tip: open a PDF first so I can answer from the actual document!');

  var prompts = {
    summarise: {
      small:
        ref +
        'write a concise summary of the document in 4-6 sentences covering the core topic and purpose. ' +
        'Then list the 3-4 most critical takeaways as complete sentences, not fragments.',

      medium:
        ref +
        'write a structured summary with these sections:\n\n' +
        '### \uD83D\uDCDD Overview\nA paragraph of 4-6 sentences explaining what the document covers and why it matters.\n\n' +
        '### \uD83D\uDD11 Main Topics\nFor each major topic: a short heading followed by 2-3 sentences explaining what it covers — ' +
        'not just a label.\n\n' +
        '### \uD83D\uDCA1 Key Takeaways\n5-7 takeaways written as full sentences explaining the significance of each point.',

      thorough:
        ref +
        'write a comprehensive deep-dive summary of the entire document. ' +
        'For each major section write a full paragraph explaining what it covers, the underlying principles, ' +
        'and how it connects to the overall subject. ' +
        'Include a dedicated section listing every formula with variables defined and meaning explained. ' +
        'End with a "Things to Remember for the Exam" section covering the most testable concepts.'
    },

    formulas:
      ref +
      'find and explain every formula, equation and mathematical expression in the document. ' +
      'For each one: write out the expression clearly, define every variable or symbol in a sentence each, ' +
      'then write 2-3 sentences explaining what the formula computes, what it represents physically or mathematically, ' +
      'and when or how it is applied. Do not just list symbols — explain them in context.',

    quiz: {
      easy:
        ref +
        'create 6 questions that test basic understanding of the document. ' +
        'For each question: write it clearly, then write the answer as a full paragraph — ' +
        'not a one-liner. Explain *why* the answer is correct.',

      medium:
        ref +
        'create 8 questions of medium difficulty mixing conceptual and applied questions. ' +
        'Include at least one question that requires applying a formula or method from the document. ' +
        'For each question: write a complete answer paragraph that explains the concept and reasoning, not just the result.',

      hard:
        ref +
        'create 10 challenging questions requiring deep understanding, multi-step reasoning, ' +
        'or application of several concepts from the document. ' +
        'For each question: write a step-by-step answer that explains the full reasoning process. ' +
        'At least 3 questions should involve calculations or derivations.'
    },

    keyideas:
      ref +
      'identify the 8-10 most important concepts in the document. ' +
      'For each concept: use its name as a ### heading, then write 2-3 sentences explaining ' +
      'what it is, how it works, and why it matters in the context of this subject. ' +
      'Write in explanatory prose, not bullet fragments.',

    analogy:
      ref +
      'explain the 5-6 central concepts from the document using vivid real-world analogies. ' +
      'For each: state the concept name, then write the analogy as 3-4 sentences making it concrete and memorable, ' +
      'then briefly explain in 1-2 sentences how the analogy maps to the actual concept.'
  };

  var prompt = typeof prompts[type] === 'object' ? prompts[type][level || 'medium'] : prompts[type];
  closeAllOpts();
  askAI(prompt);
}
window.chipPrompt = chipPrompt;

// ── runMultiSummary — combined PDF summary ────────────────────────────────
async function runMultiSummary(fnames, course) {
  var modal = document.getElementById('multiSumModal');
  var body = document.getElementById('msmBody');
  var title = document.getElementById('msmTitle');
  msmCurrentText = '';
  msmCurrentTitle = '';
  document.getElementById('msmSaveBtn').style.display = 'none';

  var shortNames = fnames.map(function (n) {
    return n.replace(/\.pdf$/i, '').slice(0, 30);
  });
  msmCurrentTitle = course.short + ' \u2014 Combined: ' + shortNames.join(', ');
  title.textContent = '\u2728 Combined Summary (' + fnames.length + ' files)';

  var tagsHtml =
    '<div class="msm-files-list">' +
    fnames
      .map(function (n) {
        return '<span class="msm-file-tag">\uD83D\uDCC4 ' + n + '</span>';
      })
      .join('') +
    '</div>';

  body.innerHTML =
    tagsHtml +
    '<div class="msm-loading"><div class="msm-dots"><span></span><span></span><span></span></div>' +
    '<p>Extracting text from ' +
    fnames.length +
    ' files\u2026</p></div>';
  modal.classList.add('show');

  // Extract full text from all selected PDFs (no page cap)
  var promises = fnames.map(function (fname) {
    return new Promise(function (resolve) {
      var pdfPath = PDF_DATA[fname];
      if (!pdfPath) {
        resolve('[' + fname + ': not available]');
        return;
      }
      _fetchPdfBytes(
        pdfPath,
        function (bytes) {
          (window._ssEnsurePdfJs ? window._ssEnsurePdfJs() : Promise.resolve())
            .then(function () {
              return pdfjsLib
                .getDocument({ data: bytes })
                .promise.then(function (pdf) {
                  var pagePromises = [];
                  for (var p = 1; p <= pdf.numPages; p++) {
                    pagePromises.push(
                      pdf.getPage(p).then(function (page) {
                        return page.getTextContent().then(function (tc) {
                          return tc.items
                            .map(function (it) {
                              return it.str;
                            })
                            .join(' ');
                        });
                      })
                    );
                  }
                  Promise.all(pagePromises).then(function (pages) {
                    resolve('=== ' + fname + ' ===\n' + pages.join('\n'));
                  });
                })
                .catch(function () {
                  resolve('[' + fname + ': error reading]');
                });
            })
            .catch(function () {
              resolve('[' + fname + ': could not load PDF.js]');
            });
        },
        function () {
          resolve('[' + fname + ': error loading]');
        }
      );
    });
  });

  Promise.all(promises).then(function (parts) {
    var combined = parts.join('\n\n').slice(0, 60000);
    body.innerHTML =
      tagsHtml +
      '<div class="msm-loading"><div class="msm-dots"><span></span><span></span><span></span></div>' +
      '<p>Asking AI to synthesise all files\u2026</p></div>';

    fetch(BACKEND_URL + '/api/ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (window._sbToken || '')
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOK,
        system:
          'You are Minallo, an expert AI tutor for university engineering students. ' +
          'The student has selected multiple related course files and needs a single unified study guide. ' +
          'Synthesise all content into one coherent document written in explanatory prose — not bullet lists. ' +
          'Respond ENTIRELY in ' +
          (typeof _lang !== 'undefined' && _lang === 'de' ? 'German (Deutsch)' : 'English') +
          '. Do not switch languages.',
        messages: [
          {
            role: 'user',
            content:
              'These are ' +
              fnames.length +
              ' related course files from ' +
              course.name +
              ':\n\n' +
              combined +
              '\n\n---\n' +
              'Write a single unified study guide covering all files with these sections:\n\n' +
              '### \uD83D\uDCDD Overview\n' +
              'A paragraph summarising what these files collectively cover and how they relate.\n\n' +
              '### \uD83D\uDD11 Key Concepts\n' +
              'For each important concept: a ### sub-heading followed by 2-3 sentences explaining it thoroughly.\n\n' +
              '### \uD83D\uDD22 Formulas & Definitions\n' +
              'Every formula and key definition — written out with all variables explained in prose.\n\n' +
              '### \uD83D\uDCC2 File Breakdown\n' +
              'A short paragraph for each file explaining what it specifically contributes.\n\n' +
              '### \u2753 Exam Questions\n' +
              '6 questions spanning the combined content with full answer explanations.'
          }
        ]
      })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.error) {
          body.innerHTML =
            tagsHtml +
            '<p style="color:#ff6b35">\u274C ' +
            (data.error.message || 'API error') +
            '</p>';
          return;
        }
        msmCurrentText = data.content
          ? data.content
              .map(function (b) {
                return b.text || '';
              })
              .join('')
          : '';
        body.innerHTML = tagsHtml + renderMarkdown(msmCurrentText);
        document.getElementById('msmSaveBtn').style.display = '';
      })
      .catch(function (e) {
        body.innerHTML = tagsHtml + '<p style="color:#ff6b35">\u274C ' + e.message + '</p>';
      });
  });
}
window.runMultiSummary = runMultiSummary;

// ── File chip sync ────────────────────────────────────────────────────────
// Mirrors #aiFileLabel text into the file chip bar whenever it changes
(function () {
  var label = document.getElementById('aiFileLabel');
  var chip = document.getElementById('aiFileChip');
  var name = document.getElementById('aiFileChipName');
  if (!label || !chip || !name) return;

  function syncChip() {
    var fname = window.activeFileName || '';
    var isEmpty = !fname;
    name.textContent = isEmpty ? 'No file open' : fname;
    chip.className = 'ai-file-chip' + (isEmpty ? ' empty' : '');
    // NOTE: do NOT set label.textContent here — this function is called from a
    // MutationObserver watching label, so writing back to label would cause an
    // infinite mutation loop that freezes the browser.
  }
  syncChip();
  // Re-sync whenever the label changes (openFile sets it) or language is applied
  new MutationObserver(syncChip).observe(label, {
    childList: true,
    characterData: true,
    subtree: true
  });
})();

// ── Image attachment helpers ──────────────────────────────────────────────
function _renderImgPreviews() {
  var preview = document.getElementById('aiImgPreview');
  if (!preview) return;
  if (_attachedImages.length === 0) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  preview.style.display = 'flex';
  preview.innerHTML = '';
  _attachedImages.forEach(function (img, idx) {
    var wrap = document.createElement('div');
    wrap.className = 'ai-img-thumb-wrap';
    var image = document.createElement('img');
    image.src = 'data:' + img.mediaType + ';base64,' + img.data;
    image.alt = 'Image ' + (idx + 1);
    var btn = document.createElement('button');
    btn.className = 'ai-img-remove';
    btn.title = 'Remove';
    btn.textContent = '\u2715';
    btn.addEventListener(
      'click',
      (function (i) {
        return function () {
          _attachedImages.splice(i, 1);
          window._attachedImages = _attachedImages;
          _renderImgPreviews();
        };
      })(idx)
    );
    wrap.appendChild(image);
    wrap.appendChild(btn);
    preview.appendChild(wrap);
  });
}

function _addAttachedImage(img) {
  if (_attachedImages.length >= AI_IMG_MAX) {
    if (typeof showToast === 'function')
      showToast('Limit reached', 'Max ' + AI_IMG_MAX + ' images per message');
    return;
  }
  _attachedImages.push(img);
  window._attachedImages = _attachedImages; // keep global in sync
  _renderImgPreviews();
}

// Crops the selected viewport region from all visible PDF canvases
function _captureSnipRegion(x1, y1, x2, y2) {
  var selX = Math.min(x1, x2),
    selY = Math.min(y1, y2);
  var selW = Math.abs(x2 - x1),
    selH = Math.abs(y2 - y1);
  if (selW < 8 || selH < 8) return null;

  var dpr = window.devicePixelRatio || 1;
  var out = document.createElement('canvas');
  out.width = Math.round(selW * dpr);
  out.height = Math.round(selH * dpr);
  var ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  var canvases = document.querySelectorAll('#pdfBody canvas');
  var drawn = 0;
  canvases.forEach(function (c) {
    var cr = c.getBoundingClientRect();
    var ix = Math.max(selX, cr.left);
    var iy = Math.max(selY, cr.top);
    var iw = Math.min(selX + selW, cr.right) - ix;
    var ih = Math.min(selY + selH, cr.bottom) - iy;
    if (iw <= 0 || ih <= 0) return;

    var scaleX = c.width / cr.width;
    var scaleY = c.height / cr.height;

    ctx.drawImage(
      c,
      (ix - cr.left) * scaleX,
      (iy - cr.top) * scaleY,
      iw * scaleX,
      ih * scaleY,
      (ix - selX) * dpr,
      (iy - selY) * dpr,
      iw * dpr,
      ih * dpr
    );
    drawn++;
  });

  if (drawn === 0) return null;
  return { data: out.toDataURL('image/png').split(',')[1], mediaType: 'image/png' };
}

// ── Snip tool ─────────────────────────────────────────────────────────────
(function () {
  var btn = document.getElementById('aiSnipBtn');
  if (!btn) return;

  btn.addEventListener('click', function () {
    if (typeof forceCloseAI === 'function') forceCloseAI();
    var overlay = document.createElement('div');
    overlay.id = 'snipOverlay';
    var hint = document.createElement('div');
    hint.id = 'snipHint';
    hint.textContent = 'Drag to select an area — Esc to cancel';
    var sel = document.createElement('div');
    sel.id = 'snipSel';
    overlay.appendChild(hint);
    overlay.appendChild(sel);
    document.body.appendChild(overlay);

    var startX = 0,
      startY = 0,
      dragging = false;

    overlay.addEventListener('mousedown', function (e) {
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      hint.style.display = 'none';
      sel.style.cssText =
        'left:' + startX + 'px;top:' + startY + 'px;width:0;height:0;display:block';
    });

    overlay.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var x = Math.min(e.clientX, startX),
        y = Math.min(e.clientY, startY);
      var w = Math.abs(e.clientX - startX),
        h = Math.abs(e.clientY - startY);
      sel.style.cssText =
        'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;display:block';
    });

    overlay.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      var endX = e.clientX,
        endY = e.clientY;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      var result = _captureSnipRegion(startX, startY, endX, endY);
      if (!result) {
        if (typeof showToast === 'function')
          showToast('Nothing captured', 'Select an area over the PDF');
        return;
      }
      _addAttachedImage(result);
      var ta = document.getElementById('aiInput');
      if (ta) ta.focus();
    });

    function onKey(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    }
    document.addEventListener('keydown', onKey);
  });
})();

// ── Image file upload ─────────────────────────────────────────────────────
(function () {
  var input = document.getElementById('aiFileInput');
  if (!input) return;

  function isImageFile(file) {
    return /^image\//i.test(file.type || '') || /\.(png|jpe?g)$/i.test(file.name || '');
  }

  function getActiveCourseForUpload() {
    return window.activeCourseRef || null;
  }

  function getActiveUserId() {
    return window._currentUser && (window._currentUser.id || window._currentUser.sub);
  }

  function guessSourceType(fileName) {
    var n = (fileName || '').toLowerCase();
    if (/\b(seminar|exercise|aufgabe|solution|sol|uebung|übung)\b/.test(n)) return 'exercise';
    if (/\b(formula|formel|cheat|sheet|zusammenfassung|summary)\b/.test(n)) return 'formula_sheet';
    return 'lecture';
  }

  function findMergedUpload(course, fileName) {
    var files = Array.isArray(course.files) ? course.files : [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f && f.name === fileName && f._uploaded && f._storageName) return f;
    }
    var folders = Array.isArray(course.userFolders) ? course.userFolders : [];
    for (var j = 0; j < folders.length; j++) {
      var list = Array.isArray(folders[j].files) ? folders[j].files : [];
      for (var k = 0; k < list.length; k++) {
        var ff = list[k];
        if (ff && ff.name === fileName && ff._uploaded && ff._storageName) return ff;
      }
    }
    return null;
  }

  async function indexCourseDocument(course, file) {
    if (!course || !course.id) return;
    var name = file && file.name;
    if (!name || !/\.(pdf|txt|docx)$/i.test(name)) return;
    var merged = findMergedUpload(course, name);
    if (!merged || !merged._storageName) return;
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, 12000);
    try {
      var res = await fetch((window.BACKEND_URL || '') + '/api/documents/index-existing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (window._sbToken || '')
        },
        body: JSON.stringify({
          courseId: course.id,
          storageName: merged._storageName,
          fileName: merged.name || name,
          sourceType: guessSourceType(merged.name || name),
          folder: merged._folder || null
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error('Index failed (' + res.status + ')');
    } catch (e) {
      console.warn('[ai-panel] document indexing failed', e);
      if (typeof showToast === 'function')
        showToast('Uploaded, indexing delayed', 'The file is saved. Try again shortly if AI cannot see it yet.');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function uploadCourseDocument(file) {
    var course = getActiveCourseForUpload();
    var uid = getActiveUserId();
    if (!course || !course.id) {
      if (typeof showToast === 'function')
        showToast('Open a course first', 'Documents from the AI panel are added to the active course.');
      return;
    }
    if (!uid) {
      if (typeof showToast === 'function') showToast('Not signed in', 'Sign in to upload files.');
      return;
    }
    if (typeof window._ufUpload !== 'function') {
      if (typeof showToast === 'function') showToast('Upload unavailable', 'Please try from the Files tab.');
      return;
    }

    try {
      if (typeof showToast === 'function') showToast('Uploading document', file.name);
      await window._ufUpload(uid, course, file, null, null);
      if (typeof window._ufMerge === 'function') await window._ufMerge(course);
      await indexCourseDocument(course, file);
      if (typeof showToast === 'function')
        showToast('Document uploaded', file.name + ' was added to this course.');
    } catch (e) {
      if (typeof showToast === 'function')
        showToast('Upload failed', file.name + ': ' + (e && e.message ? e.message : e));
    }
  }

  // Downscale + re-encode any image to a vision-friendly JPEG before attaching.
  // The strict _ssValidateImageFile (1 MB cap, png/jpg only) is meant for course
  // uploads to storage — real screenshots/photos routinely exceed 1 MB and may
  // be .webp/HEIC, so they were being rejected with a "File blocked" toast. For
  // AI vision attachments we normalise the image client-side instead.
  function _attachImageFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var MAX = 1568; // Anthropic's recommended max edge for vision
      var w = img.naturalWidth || img.width || 1;
      var h = img.naturalHeight || img.height || 1;
      var scale = Math.min(1, MAX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d');
      // White matte so transparent PNGs don't turn black when flattened to JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      var dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      } catch (e) {
        if (typeof showToast === 'function') showToast('Could not read image', file.name || '');
        return;
      }
      _addAttachedImage({ data: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      if (typeof showToast === 'function')
        showToast('Could not read image', (file.name || '') + ' — unsupported or corrupt.');
    };
    img.src = url;
  }

  input.addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files);
    this.value = ''; // reset so same file can be re-selected
    files.forEach(function (file) {
      if (isImageFile(file)) _attachImageFile(file);
      else uploadCourseDocument(file);
    });
    var ta = document.getElementById('aiInput');
    if (ta) ta.focus();
  });
})();

// ── AI panel resize ───────────────────────────────────────────────────────
// Removed: the legacy free-floating #aiPanel and its drag-resize handles
// (#aiResizeHandle / Top / Corner) are retired. #aiPanel now only appears
// docked inside the document-rail drawer, which manages its own width via
// #drResize (see document-rail.ts wireResize). No panel-level resize here.

// ── Scroll-to-bottom button ───────────────────────────────────────────────
(function () {
  var msgs = document.getElementById('aiMsgs');
  var btn = document.getElementById('aiScrollBtn');
  if (!msgs || !btn) return;

  function updateBtn() {
    var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    btn.classList.toggle('visible', !atBottom);
  }

  msgs.addEventListener('scroll', updateBtn, { passive: true });

  btn.addEventListener('click', function () {
    msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
  });
})();

console.log(
  '\u2713 js/ai.js loaded — model: ' +
    AI_MODEL +
    ', max_tokens: ' +
    AI_MAX_TOK +
    ', pdf_cap: ' +
    AI_PDF_CAP
);
