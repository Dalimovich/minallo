// ── CHATBOT PAGE ─────────────────────────────────────────────────────────────
(function () {
  var container = document.getElementById('psec-aipage');
  if (!container) return;

  fetch('features/chatbot/chatbot.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      container.innerHTML = html;
      _init();
    })
    .catch(function (err) {
      console.error('chatbot.html load failed:', err);
    });

  var _history = [];
  var _currentId = null;
  var _busy = false;
  var _inChat = false;
  var _stopTyping = false;
  var _typeTimer = null;
  var _userScrolledUp = false;

  // ── Storage helpers ──────────────────────────────────────────────────────
  function _storageKey() {
    var cu = window._currentUser;
    if (cu && cu.id) return 'ss_chatbot_' + cu.id;
    var nameEl = document.getElementById('authName');
    var nm = nameEl ? nameEl.textContent.trim() : '';
    if (nm && nm !== 'Loading…' && nm !== 'Loading...') return 'ss_chatbot_name_' + nm;
    return 'ss_chatbot_default';
  }
  function _loadAll() {
    try {
      return JSON.parse(localStorage.getItem(_storageKey()) || '[]');
    } catch (e) {
      return [];
    }
  }
  function _saveAll(arr) {
    try {
      localStorage.setItem(_storageKey(), JSON.stringify(arr));
    } catch (e) {}
  }

  function _persistCurrent() {
    if (!_history.length) return;
    var all = _loadAll();
    var title = _history[0].content.slice(0, 48) + (_history[0].content.length > 48 ? '…' : '');
    if (_currentId) {
      var idx = all.findIndex(function (c) {
        return c.id === _currentId;
      });
      if (idx > -1) {
        all[idx].history = _history.slice();
        all[idx].title = title;
      } else {
        all.unshift({ id: _currentId, title: title, history: _history.slice(), ts: Date.now() });
      }
    } else {
      _currentId = 'cb_' + Date.now();
      all.unshift({ id: _currentId, title: title, history: _history.slice(), ts: Date.now() });
    }
    if (all.length > 50) all = all.slice(0, 50);
    _saveAll(all);
    _renderSidebar();
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────
  function _renderSidebar() {
    var list = document.getElementById('aipHistoryList');
    if (!list) return;
    var all = _loadAll();
    if (!all.length) {
      list.innerHTML = '<div class="aip-history-empty">' + _t('aip_no_chats') + '</div>';
      return;
    }
    list.innerHTML = '';
    all.forEach(function (chat) {
      var item = document.createElement('div');
      item.className = 'aip-history-item' + (chat.id === _currentId ? ' active' : '');
      item.innerHTML =
        '<span class="aip-history-item-title">' +
        _esc2(chat.title || 'Chat') +
        '</span>' +
        '<button class="aip-history-del" data-id="' +
        chat.id +
        '" title="Delete">&#x2715;</button>';
      item.querySelector('.aip-history-item-title').addEventListener('click', function () {
        _openChat(chat.id);
      });
      item.querySelector('.aip-history-del').addEventListener('click', function (e) {
        e.stopPropagation();
        _confirmDeleteChat(chat.id);
      });
      list.appendChild(item);
    });
  }

  function _openChat(id) {
    var all = _loadAll();
    var chat = all.find(function (c) {
      return c.id === id;
    });
    if (!chat) return;
    _currentId = id;
    _history = chat.history.slice();
    _busy = false;
    var landing = document.getElementById('aipLanding');
    var chatView = document.getElementById('aipChatView');
    if (landing) landing.style.display = 'none';
    if (chatView) chatView.style.display = 'flex';
    _inChat = true;
    var msgs = document.getElementById('aipMsgs');
    if (msgs) {
      msgs.innerHTML = '';
      _history.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'aip-msg-row ' + (m.role === 'user' ? 'user' : 'bot');
        row.innerHTML =
          '<div class="aip-sender">' +
          (m.role === 'user' ? 'You' : 'StudySphere AI') +
          '</div>' +
          '<div class="aip-bubble ' +
          (m.role === 'user' ? 'user' : 'bot') +
          '">' +
          (m.role === 'user' ? _esc(m.content) : _rm(m.content)) +
          '</div>';
        if (m.role === 'assistant') {
          var bubble = row.querySelector('.aip-bubble.bot');
          _renderMath(bubble);
          row.appendChild(_aiResponseActions(m.content, 'chatbot'));
        }
        msgs.appendChild(row);
      });
      msgs.scrollTop = msgs.scrollHeight;
    }
    var titleEl = document.getElementById('aipChatTitle');
    if (titleEl) titleEl.textContent = chat.title || 'Chat';
    _stopTyping = true;
    if (_typeTimer) {
      clearTimeout(_typeTimer);
      _typeTimer = null;
    }
    _stopTyping = false;
    _busy = false;
    _setStopMode(false);
    _renderSidebar();
  }

  function _confirmDeleteChat(id) {
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText =
      'background:#1e1e2e;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 28px 22px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5)';
    box.innerHTML =
      '<div style="font-size:1.05rem;font-weight:600;color:#fff;margin-bottom:10px">Delete chat?</div>' +
      '<div style="font-size:.85rem;color:rgba(255,255,255,.55);margin-bottom:22px">This chat will be permanently deleted and cannot be recovered.</div>' +
      '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button id="_aipDelCancel" style="flex:1;padding:9px 0;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:rgba(255,255,255,.8);font-size:.9rem;cursor:pointer">Cancel</button>' +
      '<button id="_aipDelConfirm" style="flex:1;padding:9px 0;border-radius:8px;border:none;background:#ef4444;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer">Delete</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
    box.querySelector('#_aipDelCancel').addEventListener('click', function () {
      document.body.removeChild(overlay);
    });
    box.querySelector('#_aipDelConfirm').addEventListener('click', function () {
      document.body.removeChild(overlay);
      _deleteChat(id);
    });
  }

  function _deleteChat(id) {
    var all = _loadAll().filter(function (c) {
      return c.id !== id;
    });
    _saveAll(all);
    if (_currentId === id) {
      _startNew();
    } else {
      _renderSidebar();
    }
  }

  // ── Markdown / escape ────────────────────────────────────────────────────
  function _rm(txt) {
    if (typeof renderMarkdown === 'function') return renderMarkdown(txt);
    return txt
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  function _esc(t) {
    return t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
  function _esc2(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Views ────────────────────────────────────────────────────────────────
  function _enterChat(title) {
    if (_inChat) return;
    _inChat = true;
    var landing = document.getElementById('aipLanding');
    var chatView = document.getElementById('aipChatView');
    if (landing) landing.style.display = 'none';
    if (chatView) chatView.style.display = 'flex';
    var titleEl = document.getElementById('aipChatTitle');
    if (titleEl) titleEl.textContent = title || 'Chat';
  }

  function _startNew() {
    _stopTyping = true;
    if (_typeTimer) {
      clearTimeout(_typeTimer);
      _typeTimer = null;
    }
    _history = [];
    _currentId = null;
    _busy = false;
    _inChat = false;
    _stopTyping = false;
    var msgs = document.getElementById('aipMsgs');
    if (msgs) msgs.innerHTML = '';
    var landing = document.getElementById('aipLanding');
    var chatView = document.getElementById('aipChatView');
    if (landing) landing.style.display = '';
    if (chatView) chatView.style.display = 'none';
    var sb = document.getElementById('aipSend');
    if (sb) sb.disabled = false;
    _setGreeting();
    _renderSidebar();
  }

  // ── Message helpers ──────────────────────────────────────────────────────
  function _appendMsg(role, html) {
    var msgs = document.getElementById('aipMsgs');
    if (!msgs) return null;
    var row = document.createElement('div');
    row.className = 'aip-msg-row ' + role;
    row.innerHTML =
      '<div class="aip-sender">' +
      (role === 'user' ? 'You' : 'StudySphere AI') +
      '</div>' +
      '<div class="aip-bubble ' +
      role +
      '">' +
      html +
      '</div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function _appendThinking() {
    var msgs = document.getElementById('aipMsgs');
    if (!msgs) return null;
    var row = document.createElement('div');
    row.className = 'aip-msg-row bot';
    row.innerHTML =
      '<div class="aip-sender">StudySphere AI</div>' +
      '<div class="aip-thinking"><span></span><span></span><span></span></div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  // ── Send button state ────────────────────────────────────────────────────
  var SEND_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  var STOP_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';

  function _setStopMode(on) {
    var btn = document.getElementById('aipSend');
    if (!btn) return;
    if (on) {
      btn.innerHTML = STOP_SVG;
      btn.classList.add('is-stop');
      btn.disabled = false;
      btn.title = 'Stop generating';
    } else {
      btn.innerHTML = SEND_SVG;
      btn.classList.remove('is-stop');
      btn.disabled = false;
      btn.title = '';
    }
  }

  var _activeFetchController = null;

  function _stopGeneration(bubble, raw) {
    // Abort in-flight fetch if still pending
    if (_activeFetchController) {
      _activeFetchController.abort();
      _activeFetchController = null;
    }
    _stopTyping = true;
    if (_typeTimer) {
      clearTimeout(_typeTimer);
      _typeTimer = null;
    }
    if (bubble) bubble.innerHTML = _rm(raw || '');
    _busy = false;
    _setStopMode(false);
  }

  // ── Greeting ─────────────────────────────────────────────────────────────
  function _setGreeting() {
    var el = document.getElementById('aipGreeting');
    if (!el) return;
    var nameEl = document.getElementById('authName');
    var name = nameEl ? nameEl.textContent.trim() : '';
    if (name && name !== 'Loading…' && name !== 'Loading...') el.textContent = 'Hi ' + name + ' 👋';
    else el.textContent = 'Hi there 👋';
  }

  // ── File upload ──────────────────────────────────────────────────────────
  var _pendingFiles = [];

  function _renderFilePreview(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    _pendingFiles.forEach(function (f, idx) {
      var item = document.createElement('div');
      if (f.kind === 'image') {
        item.className = 'aip-file-thumb-wrap';
        item.innerHTML =
          '<img class="aip-file-thumb" src="data:' +
          f.mediaType +
          ';base64,' +
          f.data +
          '" alt="' +
          _esc2(f.name) +
          '">' +
          '<button class="aip-file-chip-del" data-idx="' +
          idx +
          '" title="Remove">&#x2715;</button>';
      } else {
        item.className = 'aip-file-chip' + (f.loading ? ' aip-file-chip-loading' : '');
        var label = f.loading
          ? 'Reading PDF…'
          : _esc2(f.name.length > 24 ? f.name.slice(0, 22) + '…' : f.name);
        item.innerHTML =
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
          '<span title="' +
          _esc2(f.name) +
          '">' +
          label +
          '</span>' +
          (f.loading
            ? ''
            : '<button class="aip-file-chip-del" data-idx="' +
              idx +
              '" title="Remove">&#x2715;</button>');
      }
      var delBtn = item.querySelector('.aip-file-chip-del');
      if (delBtn)
        delBtn.addEventListener('click', function () {
          _pendingFiles.splice(+this.getAttribute('data-idx'), 1);
          _renderFilePreview('aipLandingFilePreview');
          _renderFilePreview('aipChatFilePreview');
        });
      el.appendChild(item);
    });
  }

  function _refreshPreviews() {
    _renderFilePreview('aipLandingFilePreview');
    _renderFilePreview('aipChatFilePreview');
  }

  var PDF_PAGE_LIMIT = 80;
  var PDF_CHAR_LIMIT = 60000;

  function _extractPdfText(arrayBuffer) {
    var ensure = window._ssEnsurePdfJs ? window._ssEnsurePdfJs() : Promise.resolve();
    return ensure.then(function () {
      return pdfjsLib
        .getDocument({
          data: new Uint8Array(arrayBuffer),
          cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
          cMapPacked: true
        })
        .promise.then(function (pdf) {
          var total = pdf.numPages;
          var pagesToRead = Math.min(total, PDF_PAGE_LIMIT);
          var pageNums = [];
          for (var p = 1; p <= pagesToRead; p++) pageNums.push(p);
          return pageNums.reduce(function (chain, pageNum) {
            return chain.then(function (acc) {
              return pdf.getPage(pageNum).then(function (page) {
                return page.getTextContent().then(function (tc) {
                  var str = tc.items
                    .map(function (it) {
                      return it.str;
                    })
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                  if (str) acc.push('--- Page ' + pageNum + ' ---\n' + str);
                  return acc;
                });
              });
            });
          }, Promise.resolve([]));
        })
        .then(function (pages) {
          var full = pages.join('\n\n');
          var truncated = full.length > PDF_CHAR_LIMIT;
          if (truncated) full = full.slice(0, PDF_CHAR_LIMIT);
          return full + (truncated ? '\n\n[Content truncated — document is very large]' : '');
        });
    });
  }

  function _handleFileSelect(e) {
    var files = Array.from(e.target.files || []);
    var canAdd = 10 - _pendingFiles.length;
    var pending = files
      .filter(function (f) {
        return !_pendingFiles.find(function (x) {
          return x.name === f.name;
        });
      })
      .slice(0, canAdd > 0 ? canAdd : 0);
    pending = pending.filter(function (f) {
      try {
        if (f.type && f.type.startsWith('image/')) {
          if (window._ssValidateImageFile) window._ssValidateImageFile(f);
        } else if (window._ssValidateUploadFile) {
          window._ssValidateUploadFile(f);
        }
        return true;
      } catch (err) {
        if (typeof showToast === 'function') showToast('File blocked', f.name + ': ' + err.message);
        return false;
      }
    });
    var done = 0;
    if (!pending.length) {
      e.target.value = '';
      return;
    }
    function tick() {
      if (++done === pending.length) {
        e.target.value = '';
        _refreshPreviews();
      }
    }
    pending.forEach(function (f) {
      var reader = new FileReader();
      if (f.type.startsWith('image/')) {
        reader.onload = function (ev) {
          _pendingFiles.push({
            name: f.name,
            kind: 'image',
            data: ev.target.result.split(',')[1],
            mediaType: f.type
          });
          tick();
        };
        reader.readAsDataURL(f);
      } else if (f.type === 'text/plain' || f.name.endsWith('.txt')) {
        reader.onload = function (ev) {
          _pendingFiles.push({ name: f.name, kind: 'text', data: ev.target.result });
          tick();
        };
        reader.readAsText(f);
      } else if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        var placeholder = { name: f.name, kind: 'file', data: null, loading: true };
        _pendingFiles.push(placeholder);
        _refreshPreviews();
        reader.onload = function (ev) {
          _extractPdfText(ev.target.result)
            .then(function (text) {
              var idx = _pendingFiles.indexOf(placeholder);
              if (idx > -1)
                _pendingFiles[idx] = {
                  name: f.name,
                  kind: 'text',
                  data: text || '(no text content extracted)'
                };
              tick();
            })
            .catch(function () {
              var idx = _pendingFiles.indexOf(placeholder);
              if (idx > -1)
                _pendingFiles[idx] = {
                  name: f.name,
                  kind: 'text',
                  data: '(could not extract text from this PDF)'
                };
              tick();
            });
        };
        reader.readAsArrayBuffer(f);
      } else {
        _pendingFiles.push({ name: f.name, kind: 'file', data: null });
        tick();
      }
    });
  }

  // ── Import from Course ───────────────────────────────────────────────────
  var _aipImportSelected = [];
  var _aipActiveCourse = null;
  var _aipOpenFolder = null;

  function _aipOpenCourseModal() {
    var overlay = document.getElementById('aipCourseOverlay');
    var courseSel = document.getElementById('aipCourseSel');
    if (!overlay || !courseSel) return;
    _aipImportSelected = [];
    _aipUpdateImportCount();
    var sem = SEMS && activeSemId && SEMS[activeSemId];
    var courses = (sem && sem.courses) || [];
    courseSel.innerHTML = courses.length
      ? courses
          .map(function (c) {
            return '<option value="' + c.id + '">' + c.name + '</option>';
          })
          .join('')
      : '<option value="">No courses available</option>';
    overlay.style.display = 'flex';
    if (courses.length) _aipLoadCourseFiles(courses[0]);
    courseSel.onchange = function () {
      var c = courses.find(function (x) {
        return x.id === courseSel.value;
      });
      if (c) _aipLoadCourseFiles(c);
    };
  }

  function _aipLoadCourseFiles(course) {
    _aipActiveCourse = course;
    _aipOpenFolder = null;
    var search = document.getElementById('aipCourseSearch');
    if (search) search.value = '';
    _aipRenderLevel();
    var uid = _currentUser && (_currentUser.id || _currentUser.sub);
    var filesEl = document.getElementById('aipCourseFiles');
    var loading = document.getElementById('aipCourseLoading');
    if (loading) loading.style.display = 'flex';
    if (filesEl) filesEl.innerHTML = '';
    var _thisCourse = course;
    var mergePromise = uid ? _ufMerge(course) : Promise.resolve();
    mergePromise
      .catch(function () {})
      .then(function () {
        if (_aipActiveCourse !== _thisCourse) return; // course changed while merging
        if (loading) loading.style.display = 'none';
        _aipRenderLevel();
      });
  }

  function _aipRenderLevel() {
    var course = _aipActiveCourse;
    var filesEl = document.getElementById('aipCourseFiles');
    var empty = document.getElementById('aipCourseEmpty');
    var crumb = document.getElementById('aipCourseBreadcrumb');
    var crumbLbl = document.getElementById('aipCourseBreadcrumbLabel');
    if (!filesEl || !course) return;
    var query = ((document.getElementById('aipCourseSearch') || {}).value || '')
      .trim()
      .toLowerCase();
    filesEl.innerHTML = '';
    if (empty) empty.style.display = 'none';
    if (_aipOpenFolder !== null) {
      if (crumb) crumb.style.display = 'flex';
      if (crumbLbl) crumbLbl.textContent = '📁 ' + _aipOpenFolder;
      var fd = (course.userFolders || []).find(function (x) {
        return x.name === _aipOpenFolder;
      });
      var folderFiles = fd ? fd.files || [] : [];
      if (query)
        folderFiles = folderFiles.filter(function (f) {
          return f.name.toLowerCase().indexOf(query) !== -1;
        });
      if (!folderFiles.length) {
        if (empty) {
          empty.textContent = 'No files in this folder.';
          empty.style.display = 'flex';
        }
        return;
      }
      folderFiles.forEach(function (f, i) {
        _aipAppendFileRow(
          filesEl,
          {
            label: f.name,
            name: f.name,
            sname: f._storageName || null,
            folder: _aipOpenFolder,
            course: course
          },
          'aipCfF_' + i
        );
      });
      return;
    }
    if (crumb) crumb.style.display = 'none';
    var rootFiles = (course.files || []).filter(function (f) {
      return !query || f.name.toLowerCase().indexOf(query) !== -1;
    });
    if (query) {
      var flatResults = [];
      rootFiles.forEach(function (f) {
        flatResults.push({
          label: f.name,
          name: f.name,
          sname: f._storageName || null,
          folder: null,
          course: course
        });
      });
      (course.userFolders || []).forEach(function (fd) {
        (fd.files || []).forEach(function (f) {
          if (f.name.toLowerCase().indexOf(query) !== -1)
            flatResults.push({
              label: fd.name + ' / ' + f.name,
              name: f.name,
              sname: f._storageName || null,
              folder: fd.name,
              course: course
            });
        });
      });
      if (!flatResults.length) {
        if (empty) {
          empty.textContent = 'No results for "' + query + '".';
          empty.style.display = 'flex';
        }
        return;
      }
      flatResults.forEach(function (f, i) {
        _aipAppendFileRow(filesEl, f, 'aipCfS_' + i);
      });
      return;
    }
    var folders = course.userFolders || [];
    if (!rootFiles.length && !folders.length) {
      if (empty) {
        empty.textContent = 'No files found in this course.';
        empty.style.display = 'flex';
      }
      return;
    }
    folders.forEach(function (fd) {
      var row = document.createElement('div');
      row.className = 'aip-course-folder-row';
      var fileCount = (fd.files || []).length;
      row.innerHTML =
        '<span class="aip-course-folder-icon">📁</span>' +
        '<span class="aip-course-folder-name">' +
        (fd.name.length > 36 ? fd.name.slice(0, 34) + '…' : fd.name) +
        '</span>' +
        '<span class="aip-course-folder-count">' +
        fileCount +
        ' file' +
        (fileCount !== 1 ? 's' : '') +
        '</span>' +
        '<span class="aip-course-folder-arrow">›</span>';
      row.addEventListener('click', function () {
        _aipOpenFolder = fd.name;
        _aipRenderLevel();
      });
      filesEl.appendChild(row);
    });
    rootFiles.forEach(function (f, i) {
      _aipAppendFileRow(
        filesEl,
        {
          label: f.name,
          name: f.name,
          sname: f._storageName || null,
          folder: null,
          course: course
        },
        'aipCfR_' + i
      );
    });
  }

  function _aipAppendFileRow(container, f, id) {
    var item = document.createElement('div');
    item.className = 'aip-course-file-item';
    var alreadySel = !!_aipImportSelected.find(function (s) {
      return s.name === f.name && s.folder === f.folder;
    });
    item.innerHTML =
      '<input type="checkbox" id="' +
      id +
      '" ' +
      (alreadySel ? 'checked' : '') +
      '>' +
      '<label class="aip-course-file-item-name" for="' +
      id +
      '" title="' +
      f.label +
      '">' +
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-right:5px"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
      (f.label.length > 42 ? f.label.slice(0, 40) + '…' : f.label) +
      '</label>';
    var cb = item.querySelector('input[type=checkbox]');
    cb.addEventListener('change', function () {
      if (cb.checked) {
        if (
          !_aipImportSelected.find(function (s) {
            return s.name === f.name && s.folder === f.folder;
          })
        )
          _aipImportSelected.push(f);
      } else {
        _aipImportSelected = _aipImportSelected.filter(function (s) {
          return !(s.name === f.name && s.folder === f.folder);
        });
      }
      _aipUpdateImportCount();
    });
    container.appendChild(item);
  }

  function _aipUpdateImportCount() {
    var n = _aipImportSelected.length;
    var cnt = document.getElementById('aipCourseSelCount');
    var btn = document.getElementById('aipCourseImport');
    if (cnt) cnt.textContent = n + ' file' + (n !== 1 ? 's' : '') + ' selected';
    if (btn) btn.disabled = n === 0;
  }

  function _aipDoImport() {
    var btn = document.getElementById('aipCourseImport');
    if (btn) {
      btn.textContent = 'Importing…';
      btn.disabled = true;
    }
    var uid = _currentUser && (_currentUser.id || _currentUser.sub);
    var toImport = _aipImportSelected.slice();
    var done = 0;
    toImport.forEach(function (f) {
      if (
        _pendingFiles.find(function (p) {
          return p.name === f.name;
        })
      ) {
        if (++done === toImport.length) _aipImportFinish();
        return;
      }
      var placeholder = { name: f.name, kind: 'text', data: null, loading: true };
      _pendingFiles.push(placeholder);
      _refreshPreviews();
      function onBytes(bytes) {
        _extractPdfText(bytes.buffer || bytes)
          .then(function (text) {
            var idx = _pendingFiles.indexOf(placeholder);
            if (idx > -1)
              _pendingFiles[idx] = {
                name: f.name,
                kind: 'text',
                data: text || '(no text extracted)'
              };
            _refreshPreviews();
            if (++done === toImport.length) _aipImportFinish();
          })
          .catch(function () {
            var idx = _pendingFiles.indexOf(placeholder);
            if (idx > -1)
              _pendingFiles[idx] = { name: f.name, kind: 'text', data: '(could not extract text)' };
            _refreshPreviews();
            if (++done === toImport.length) _aipImportFinish();
          });
      }
      if (f.sname && uid) {
        _ufFetchBytes(uid, f.course, f.sname, f.folder || null)
          .then(function (bytes) {
            onBytes(bytes);
          })
          .catch(function () {
            var idx = _pendingFiles.indexOf(placeholder);
            if (idx > -1)
              _pendingFiles[idx] = { name: f.name, kind: 'text', data: '(fetch failed)' };
            _refreshPreviews();
            if (++done === toImport.length) _aipImportFinish();
          });
      } else {
        var path = PDF_DATA && PDF_DATA[f.name];
        if (path) {
          _fetchPdfBytes(path, onBytes, function () {
            var idx = _pendingFiles.indexOf(placeholder);
            if (idx > -1)
              _pendingFiles[idx] = { name: f.name, kind: 'text', data: '(not available)' };
            _refreshPreviews();
            if (++done === toImport.length) _aipImportFinish();
          });
        } else {
          var idx = _pendingFiles.indexOf(placeholder);
          if (idx > -1)
            _pendingFiles[idx] = { name: f.name, kind: 'text', data: '(not available in demo)' };
          _refreshPreviews();
          if (++done === toImport.length) _aipImportFinish();
        }
      }
    });
    if (!toImport.length) _aipImportFinish();
  }

  function _aipImportFinish() {
    var overlay = document.getElementById('aipCourseOverlay');
    if (overlay) overlay.style.display = 'none';
    var btn = document.getElementById('aipCourseImport');
    if (btn) {
      btn.textContent = 'Import';
      btn.disabled = false;
    }
    _aipImportSelected = [];
  }

  function _appendUserMsgWithFiles(text, files) {
    var msgs = document.getElementById('aipMsgs');
    if (!msgs) return null;
    var row = document.createElement('div');
    row.className = 'aip-msg-row user';
    var attachHtml = '';
    files.forEach(function (f) {
      if (f.kind === 'image') {
        attachHtml +=
          '<img class="aip-msg-thumb" src="data:' +
          f.mediaType +
          ';base64,' +
          f.data +
          '" alt="' +
          _esc2(f.name) +
          '">';
      } else {
        attachHtml +=
          '<div class="aip-msg-file-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
          _esc2(f.name) +
          '</div>';
      }
    });
    row.innerHTML =
      '<div class="aip-sender">You</div>' +
      (attachHtml ? '<div class="aip-msg-attachments">' + attachHtml + '</div>' : '') +
      (text ? '<div class="aip-bubble user">' + _esc(text) + '</div>' : '');
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function _send(text) {
    text = (text || '').trim();
    var filesToSend = _pendingFiles.slice();
    if (!text && !filesToSend.length) return;
    if (_busy) return;
    if (
      filesToSend.some(function (f) {
        return f.loading;
      })
    ) {
      showToast('PDF still reading', 'Wait a moment then try again.');
      return;
    }
    _pendingFiles = [];
    _renderFilePreview('aipLandingFilePreview');
    _renderFilePreview('aipChatFilePreview');
    var displayText =
      text ||
      (filesToSend.length
        ? '[' +
          filesToSend
            .map(function (f) {
              return f.name;
            })
            .join(', ') +
          ']'
        : '');
    var title = displayText.slice(0, 48) + (displayText.length > 48 ? '…' : '');
    _enterChat(title);
    var apiContent = [];
    filesToSend.forEach(function (f) {
      if (f.kind === 'image') {
        apiContent.push({
          type: 'image',
          source: { type: 'base64', media_type: f.mediaType, data: f.data }
        });
      } else if (f.kind === 'text') {
        apiContent.push({
          type: 'text',
          text: '<document filename="' + f.name + '">\n' + f.data + '\n</document>'
        });
      } else {
        apiContent.push({
          type: 'text',
          text: '(The file "' + f.name + '" is a binary format that could not be read as text.)'
        });
      }
    });
    if (text) apiContent.push({ type: 'text', text: text });
    var historyText =
      filesToSend
        .map(function (f) {
          if (f.kind === 'image') return '[Image: ' + f.name + ']';
          if (f.kind === 'text')
            return '<document filename="' + f.name + '">\n' + f.data + '\n</document>';
          return '(The file "' + f.name + '" is a binary format that could not be read as text.)';
        })
        .join('\n') + (text ? '\n' + text : '');
    _history.push({ role: 'user', content: historyText.trim() });
    if (filesToSend.length) {
      _appendUserMsgWithFiles(text, filesToSend);
    } else {
      _appendMsg('user', _esc(text));
    }
    var te = document.getElementById('aipChatTitle');
    if (te) te.textContent = title;
    _persistCurrent();
    var li = document.getElementById('aipLandingInput');
    if (li) {
      li.value = '';
      li.style.height = 'auto';
    }
    var ci = document.getElementById('aipInput');
    if (ci) {
      ci.value = '';
      ci.style.height = 'auto';
    }
    var sb2 = document.getElementById('aipLandingSend');
    if (sb2) sb2.disabled = true;
    _busy = true;
    _stopTyping = false;
    _userScrolledUp = false;
    _setStopMode(true);
    var thinkRow = _appendThinking();
    var apiMessages = _history.slice(-20, -1).map(function (m) {
      return { role: m.role, content: m.content };
    });
    apiMessages.push({
      role: 'user',
      content:
        apiContent.length === 1 && apiContent[0].type === 'text' ? apiContent[0].text : apiContent
    });
    var _fetchDone = false;
    var _fetchController = new AbortController();
    _activeFetchController = _fetchController;
    function _releaseBusy() {
      if (_fetchDone) return;
      _fetchDone = true;
      _busy = false;
      _setStopMode(false);
      if (sb2) sb2.disabled = false;
    }
    fetch(BACKEND_URL + '/api/ai', {
      method: 'POST',
      signal: _fetchController.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (window._sbToken || '')
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system:
          'You are StudySphere AI, a friendly and knowledgeable assistant for university students. Always reply in ' +
          (window._lang === 'de' ? 'German' : 'English') +
          ". Answer any question clearly and helpfully. Be concise but thorough.\n\nIMPORTANT: When the user's message contains <document> tags, those tags contain the FULL extracted text of an uploaded file. You CAN read and answer questions about this content — treat it as the complete document. Never say you cannot read a file when its content is provided inside <document> tags." +
          _MATH_PROMPT,
        messages: apiMessages
      })
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error('Server ' + r.status + ': ' + t.slice(0, 200));
          });
        }
        return r.json();
      })
      .then(function (data) {
        if (thinkRow) thinkRow.remove();
        _activeFetchController = null;
        var raw = data.error
          ? '❌ Error: ' + (data.error.message || JSON.stringify(data.error))
          : data.content
            ? data.content
                .map(function (b) {
                  return b.text || '';
                })
                .join('')
            : 'No response.';
        _history.push({ role: 'assistant', content: raw });
        _persistCurrent();
        var row = document.createElement('div');
        row.className = 'aip-msg-row bot';
        row.innerHTML =
          '<div class="aip-sender">StudySphere AI</div><div class="aip-bubble bot"></div>';
        var msgsEl = document.getElementById('aipMsgs');
        if (msgsEl) {
          msgsEl.appendChild(row);
          msgsEl.scrollTop = msgsEl.scrollHeight;
        }
        var bubble = row.querySelector('.aip-bubble.bot');
        // Use word-index stepping so markdown is shown as plain text during
        // animation (avoids the flicker of re-parsing HTML on every character).
        // On finish we do one clean innerHTML + math render.
        var _words = raw.match(/\S+\s*/g) || [];
        var _wi = 0;
        var _CBW = (window.AI_TYPING && window.AI_TYPING.chatbotWordsPerFrame) || 2;
        var _CBI = (window.AI_TYPING && window.AI_TYPING.chatbotFrameInterval) || 22;
        function _finishBubble(text) {
          bubble.innerHTML = _rm(text);
          _renderMath(bubble);
          if (!row.querySelector('.ai-action-bar') && text.trim())
            row.appendChild(_aiResponseActions(text, 'chatbot'));
          _releaseBusy();
          var m = document.getElementById('aipMsgs');
          if (m && !_userScrolledUp) m.scrollTop = m.scrollHeight;
        }
        function typeNext() {
          if (_stopTyping) {
            var partial = _words.slice(0, _wi).join('');
            _history[_history.length - 1].content = partial || raw;
            _persistCurrent();
            _finishBubble(partial || raw);
            return;
          }
          if (_wi >= _words.length) {
            _history[_history.length - 1].content = raw;
            _persistCurrent();
            _finishBubble(raw);
            return;
          }
          var sec = document.getElementById('psec-aipage');
          var hidden = document.hidden || (sec && sec.style.display === 'none');
          if (hidden) {
            _wi = _words.length;
            _typeTimer = setTimeout(typeNext, 0);
            return;
          }
          _wi = Math.min(_wi + _CBW, _words.length);
          // Plain text during animation — no markdown flicker
          bubble.textContent = _words.slice(0, _wi).join('');
          var m = document.getElementById('aipMsgs');
          if (m && !_userScrolledUp) m.scrollTop = m.scrollHeight;
          _typeTimer = setTimeout(typeNext, _CBI + (Math.random() > 0.93 ? 40 : 0));
        }
        typeNext();
      })
      .catch(function (e) {
        if (thinkRow) thinkRow.remove();
        _activeFetchController = null;
        if (e && e.name === 'AbortError') { _releaseBusy(); return; }
        _appendMsg('bot', '❌ Error: ' + e.message);
        _releaseBusy();
      });
  }

  // ── Init (called after chatbot.html is injected) ─────────────────────────
  function _init() {
    var msgsEl2 = document.getElementById('aipMsgs');
    if (msgsEl2) {
      msgsEl2.addEventListener('scroll', function () {
        var d = this.scrollHeight - this.scrollTop - this.clientHeight;
        _userScrolledUp = d > 60;
      });
    }

    var landingInput = document.getElementById('aipLandingInput');
    if (landingInput) {
      landingInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _send(this.value);
        }
      });
      landingInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 140) + 'px';
      });
    }
    var landingSend = document.getElementById('aipLandingSend');
    if (landingSend)
      landingSend.addEventListener('click', function () {
        var inp = document.getElementById('aipLandingInput');
        if (inp) _send(inp.value);
      });

    var chatInput = document.getElementById('aipInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _send(this.value);
        }
      });
      chatInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 140) + 'px';
      });
    }
    var chatSend = document.getElementById('aipSend');
    if (chatSend)
      chatSend.addEventListener('click', function () {
        if (this.classList.contains('is-stop')) {
          _stopGeneration(null, '');
          return;
        }
        var inp = document.getElementById('aipInput');
        if (inp) _send(inp.value);
      });

    var clearBtn = document.getElementById('aipClearBtn');
    if (clearBtn)
      clearBtn.addEventListener('click', function () {
        if (_currentId) {
          _confirmDeleteChat(_currentId);
        } else {
          _startNew();
        }
      });
    var newChatBtn = document.getElementById('aipNewChatBtn');
    if (newChatBtn) newChatBtn.addEventListener('click', _startNew);

    var sugg = document.getElementById('aipSuggestions');
    if (sugg)
      sugg.addEventListener('click', function (e) {
        var chip = e.target.closest('.aip-chip');
        if (!chip) return;
        var prompt = chip.getAttribute('data-prompt');
        if (prompt) _send(prompt);
      });

    var sbToggle = document.getElementById('aipSbToggle');
    if (sbToggle)
      sbToggle.addEventListener('click', function () {
        var sb = document.getElementById('aipSidebar');
        if (sb) sb.classList.toggle('collapsed');
      });

    var lfi = document.getElementById('aipLandingFileInput');
    if (lfi) lfi.addEventListener('change', _handleFileSelect);
    var cfi = document.getElementById('aipChatFileInput');
    if (cfi) cfi.addEventListener('change', _handleFileSelect);

    ['aipImportCourseBtn', 'aipImportCourseBtnChat'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', _aipOpenCourseModal);
    });
    var aipCourseClose = document.getElementById('aipCourseClose');
    if (aipCourseClose)
      aipCourseClose.addEventListener('click', function () {
        document.getElementById('aipCourseOverlay').style.display = 'none';
      });
    var aipCourseCancel = document.getElementById('aipCourseCancel');
    if (aipCourseCancel)
      aipCourseCancel.addEventListener('click', function () {
        document.getElementById('aipCourseOverlay').style.display = 'none';
      });
    var aipCourseImport = document.getElementById('aipCourseImport');
    if (aipCourseImport) aipCourseImport.addEventListener('click', _aipDoImport);
    var aipCourseOverlay = document.getElementById('aipCourseOverlay');
    if (aipCourseOverlay)
      aipCourseOverlay.addEventListener('click', function (e) {
        if (e.target === aipCourseOverlay) aipCourseOverlay.style.display = 'none';
      });
    var aipCourseBack = document.getElementById('aipCourseBack');
    if (aipCourseBack)
      aipCourseBack.addEventListener('click', function () {
        _aipOpenFolder = null;
        _aipRenderLevel();
      });
    var aipCourseSearch = document.getElementById('aipCourseSearch');
    if (aipCourseSearch)
      aipCourseSearch.addEventListener('input', function () {
        _aipRenderLevel();
      });

    _setGreeting();
    setTimeout(function () {
      _setGreeting();
      _renderSidebar();
    }, 800);
  }

  window._aipRefreshSidebar = function () {
    _setGreeting();
    _renderSidebar();
  };
})();
