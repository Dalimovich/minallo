(function () {
  var container = document.getElementById('psec-chat');
  if (!container) return;
  // Retry the markup fetch a couple of times: this dispatcher only runs once
  // (the loader won't re-inject the script on re-navigation), so a single
  // transient network failure here would leave the page blank until a full
  // reload. Retrying self-heals the common flaky-connection case.
  function _ssFetchText(url, tries) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).catch(function (err) {
      if (tries > 0) {
        return new Promise(function (res) { setTimeout(res, 400); }).then(function () {
          return _ssFetchText(url, tries - 1);
        });
      }
      throw err;
    });
  }
  _ssFetchText('views/chat/chat.html', 2)
    .then(function (html) {
      container.innerHTML = html;
      _init();
    })
    .catch(function (err) {
      console.error('chat.html load failed:', err);
    });
  function _init() {
    // aiMsgs is module-scoped inside app.js (an ES module) so it doesn't leak
    // to window. Look it up locally — app.js exposes window._aiMsgs as a
    // fallback when this script loads before app.js has run.
    function _msgs() { return window._aiMsgs || document.getElementById('aiMsgs'); }

    var chatSidebarSettingsBtn = document.getElementById('chatSidebarSettingsBtn');
    if (chatSidebarSettingsBtn) {
      chatSidebarSettingsBtn.addEventListener('click', function () {
        var settingsBtn = document.getElementById('psbSettings');
        if (settingsBtn) settingsBtn.click();
      });
    }

    // ── PER-PDF CHAT PERSISTENCE ──────────────────────────────────────────────
    var CHAT_PREFIX = 'ss_chat_';

    // Build a stable storage key from file name + course
    function chatKeyFor(fileName, courseShort) {
      return (courseShort || '') + '||' + (fileName || '');
    }

    // Track the active file key
    var _prevChatKey = null;

    // Register an unload hook so settings.js can trigger chat save without accessing this IIFE's private var
    window._ssPreUnloadHook = function () {
      if (_prevChatKey) saveChatForFile(_prevChatKey);
    };

    // Serialize all visible messages from the DOM
    function serializeChatDOM() {
      var out = [];
      var _m = _msgs();
      if (!_m) return out;
      _m.querySelectorAll('.ai-msg-wrap').forEach(function (wrap) {
        // Skip typing indicators and thinking bubbles
        if (wrap.classList.contains('typing-wrap')) return;
        var bubble = wrap.querySelector('.ai-bubble');
        if (!bubble) return;
        // Skip bubbles that are still streaming so an in-progress save (panel
        // close, course switch, refresh) doesn't persist a cropped half-stream
        // on top of the prior complete answer. finalize() removes the flag.
        if (bubble.getAttribute('data-streaming') === 'true') return;
        var isUser = bubble.classList.contains('user');
        // For user messages store plain text (stored in data-q on the wrap or inner text)
        if (isUser) {
          var txt = wrap.getAttribute('data-q') || bubble.textContent || '';
          out.push({ role: 'user', text: txt.trim() });
        } else {
          // Bot: store the raw markdown source (set on data-raw at write time).
          // textContent flattens KaTeX + rendered HTML into a corrupted glob.
          out.push({ role: 'bot', text: bubble.getAttribute('data-raw') || bubble.textContent || '' });
        }
      });
      return out;
    }

    // Save current chat to localStorage
    function saveChatForFile(fileKey) {
      if (!fileKey) return;
      try {
        var msgs = serializeChatDOM();
        if (msgs.length === 0) {
          localStorage.removeItem(CHAT_PREFIX + fileKey);
        } else {
          localStorage.setItem(CHAT_PREFIX + fileKey, JSON.stringify(msgs));
        }
      } catch (e) {
        console.warn('Chat save failed:', e);
      }
    }

    // Load and re-render saved chat; returns true if history was found
    function renderRestoredBotBubble(botBubble, text) {
      if (!botBubble) return;
      botBubble.setAttribute('data-raw', text || '');
      var doRender = function () {
        if (typeof window.renderMarkdown === 'function') {
          botBubble.innerHTML = window.renderMarkdown(text || '');
        } else {
          botBubble.textContent = text || '';
        }
        var doMath = function () {
          if (typeof window._renderMath === 'function') window._renderMath(botBubble);
          if (typeof window._renderCode === 'function') window._renderCode(botBubble);
        };
        if (typeof window._ssEnsureKatex === 'function') {
          window._ssEnsureKatex().then(doMath).catch(doMath);
        } else {
          doMath();
        }
      };
      if (!window._minalloRenderMarkdownReady && typeof window._ensureAiRenderBridge === 'function') {
        window._ensureAiRenderBridge().then(doRender).catch(doRender);
      } else {
        doRender();
      }
    }

    function loadChatForFile(fileKey) {
      if (!fileKey) return false;
      try {
        var raw = localStorage.getItem(CHAT_PREFIX + fileKey);
        if (!raw) return false;
        var msgs = JSON.parse(raw);
        if (!msgs || !msgs.length) return false;
        var _m = _msgs();
        if (!_m) return false;
        _m.innerHTML = '';
        var t = getTime();
        msgs.forEach(function (m) {
          if (m.role === 'user') {
            // Rebuild user bubble
            var wrap = document.createElement('div');
            wrap.className = 'ai-msg-wrap user';
            // Restored history must not re-pop interactive forms (see
            // promoteAiInputToModal's [data-restored] guard in ai-markdown.ts).
            wrap.setAttribute('data-restored', 'true');
            var safe = (m.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            wrap.setAttribute('data-q', m.text || '');
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
            wrap.querySelectorAll('.msg-action-btn[data-action="copy"]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                if (typeof window.copyBubble === 'function') window.copyBubble(btn);
              });
            });
            wrap.querySelectorAll('.msg-action-btn[data-action="regen"]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                if (typeof window.regenMsg === 'function') window.regenMsg(btn);
              });
            });
            _m.appendChild(wrap);
          } else {
            // Rebuild bot bubble — render from raw text, never inject stored HTML
            var wrap = document.createElement('div');
            wrap.className = 'ai-msg-wrap';
            // Keep restored minallo-input forms inline in the side panel
            // instead of re-popping the modal on every file open.
            wrap.setAttribute('data-restored', 'true');
            wrap.innerHTML =
              '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
              '<div class="msg-body">' +
              '<div class="ai-bubble bot"></div>' +
              '<div class="msg-meta">' +
              '<span class="msg-time">' +
              t +
              '</span>' +
              '<button class="msg-action-btn" data-action="copy">' +
              (window._t ? window._t('copy_btn') : 'Copy') +
              '</button>' +
              '</div>' +
              '</div>';
            var botBubble = wrap.querySelector('.ai-bubble.bot');
            renderRestoredBotBubble(botBubble, m.text || '');
            var msgBody = wrap.querySelector('.msg-body');
            if (typeof window._aiResponseActions === 'function') {
              msgBody.appendChild(window._aiResponseActions(m.text || '', 'panel'));
            }
            wrap.querySelectorAll('.msg-action-btn[data-action="copy"]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                if (typeof window.copyBubble === 'function') window.copyBubble(btn);
              });
            });
            _m.appendChild(wrap);
          }
        });
        _m.scrollTop = _m.scrollHeight;
        return true;
      } catch (e) {
        console.warn('Chat load failed:', e);
        return false;
      }
    }

    // Delete saved chat
    function deleteChatForFile(fileKey) {
      if (!fileKey) return;
      try {
        localStorage.removeItem(CHAT_PREFIX + fileKey);
      } catch (e) {}
    }

    // Deferred save helper (used after streaming completes)
    deferredSave = function () {
      if (!_prevChatKey) return;
      setTimeout(function () {
        saveChatForFile(_prevChatKey);
      }, 300);
    };

    // ── PATCH openFile: save old chat → clear → load new chat ─────────────────
    var _origOpenFileChat = window.openFile;
    window.openFile = function (f, c) {
      // 1. Save outgoing chat before navigating away
      if (_prevChatKey) saveChatForFile(_prevChatKey);

      // 2. Compute new key early
      var newKey = chatKeyFor(f.name, c.short);
      _prevChatKey = newKey;

      // 3. Open the file (renders PDF, sets activeFileName etc.)
      if (typeof _origOpenFileChat === 'function') _origOpenFileChat(f, c);

      // 4. Clear panel and load saved history (or show welcome)
      var _m4 = _msgs();
      if (_m4) _m4.innerHTML = '';
      var hadHistory = loadChatForFile(newKey);
      if (!hadHistory) {
        addBotMsg(
          '📄 <strong>' +
            f.name +
            '</strong> ' +
            (window._t ? window._t('ai_file_loaded_post') : 'has been loaded. Ask me anything!')
        );
      } else {
        // Subtle "restored" separator
        var note = document.createElement('div');
        note.className = 'chat-restore-note';
        note.style.cssText =
          'text-align:center;font-size:.67rem;color:rgba(37,99,235,.45);padding:6px 0 2px;font-style:italic;letter-spacing:.02em';
        note.textContent = window._t ? window._t('chat_restored') : '— Chat history restored —';
        if (_m4) {
          _m4.appendChild(note);
          _m4.scrollTop = _m4.scrollHeight;
        }
      }
      saveState();
    };

    // ── PATCH addUserMsg: save after user sends a message ─────────────────────
    var _origAddUserMsg = window.addUserMsg;
    window.addUserMsg = function (text) {
      var result = typeof _origAddUserMsg === 'function' ? _origAddUserMsg(text) : undefined;
      if (_prevChatKey)
        setTimeout(function () {
          saveChatForFile(_prevChatKey);
        }, 100);
      return result;
    };

    // ── PATCH askAI: save after streaming finishes ────────────────────────────
    // We hook into the typeNext completion point by patching spawnConfetti
    // (called exactly when streaming ends successfully)
    var _origSpawnConfetti = window.spawnConfetti;
    window.spawnConfetti = function () {
      if (typeof _origSpawnConfetti === 'function') _origSpawnConfetti();
      if (typeof window.deferredSave === 'function') window.deferredSave();
    };

    // Also save when user manually stops generation
    var _origStopGeneration = window.stopGeneration;
    window.stopGeneration = function () {
      // Flush in-progress animation to full text before clearing the timer
      if (typeof window._ssPreUnloadHook === 'function') window._ssPreUnloadHook();
      if (typeof _origStopGeneration === 'function') _origStopGeneration();
      if (_prevChatKey)
        setTimeout(function () {
          saveChatForFile(_prevChatKey);
        }, 50);
    };

    // ── PATCH showPortal: flush and save before leaving files view ───────────
    var _origShowPortalChat = window.showPortal;
    window.showPortal = function () {
      if (typeof window._ssPreUnloadHook === 'function') window._ssPreUnloadHook();
      if (_prevChatKey) {
        try {
          saveChatForFile(_prevChatKey);
        } catch (e) {}
      }
      if (typeof _origShowPortalChat === 'function') _origShowPortalChat();
    };

    // ── PATCH Clear button: wipe DOM + localStorage ───────────────────────────
    (
      document.getElementById('aiClearBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var _mc = _msgs();
      if (_mc) _mc.innerHTML = '';
      if (_prevChatKey) deleteChatForFile(_prevChatKey);
      // Also clear the course-scoped Q&A history (localStorage + the synced
      // chat_history rows). Without this the PDF AI panel restores the old
      // answers from Supabase on the next refresh, so "Clear chat" looked
      // like it did nothing.
      if (typeof window.clearCourseHistory === 'function') {
        window.clearCourseHistory(
          window.activeCourseId || window.currentCourseId || '',
          window.activeRagDocumentId || null
        );
      }
      if (typeof window.addBotMsg === 'function') {
        window.addBotMsg(window._t ? window._t('ai_chat_cleared_msg') : 'Chat cleared');
      }
      // aiPinned lives inside app.js's module scope — use the exposed bridge
      // so this unpin actually sticks (bare `aiPinned = false` only created a
      // global of the same name and didn't affect the module).
      if (window._aiPanelBridge && typeof window._aiPanelBridge.setAiPinned === 'function') {
        window._aiPanelBridge.setAiPinned(false);
      }
      if (typeof window.forceCloseAI === 'function') window.forceCloseAI();
      setTimeout(function () { if (typeof window.openAI === 'function') window.openAI(); }, 100);
    });

    // ── CHAT ──────────────────────────────────────────────────────────────────
    var _chatRoomId = null;
    var _chatPollTimer = null;
    var _chatLoadSeq = 0;
    var _chatLoadInFlight = false;
    var _chatLastTs = null;
    var _chatFriends = []; // [{id, otherId, status, isSender, profile:{id,full_name,programme}}]
    var _chatUsername = window._chatUsername || null;

    function _chatEsc(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function _chatDmRoomId(uid1, uid2) {
      return 'dm_' + [uid1, uid2].sort().join('_');
    }
    function _chatAttachmentIsExternal(value) {
      return /^https?:\/\//i.test(String(value || ''));
    }
    function _chatSafeStoragePart(value) {
      return String(value || '')
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    }
    function _chatEncodeStoragePath(path) {
      return String(path || '')
        .split('/')
        .map(function (part) {
          return encodeURIComponent(part);
        })
        .join('/');
    }
    function _chatStorageRoomId(roomId) {
      var value = String(roomId || '');
      return value.indexOf('custom_') === 0 ? value.replace('custom_', '') : value;
    }
    async function _chatSignAttachmentPath(path) {
      if (!path || _chatAttachmentIsExternal(path)) return path;
      var token = _sbToken || sessionStorage.getItem('sb_sess_token') || SUPA_KEY;
      var res = await fetch(
        SUPA_URL + '/storage/v1/object/sign/chat-attachments/' + _chatEncodeStoragePath(path),
        {
          method: 'POST',
          headers: {
            apikey: SUPA_KEY,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ expiresIn: 300 })
        }
      );
      if (!res.ok) throw new Error('Could not load attachment');
      var data = await res.json();
      var signed = data.signedURL || data.signedUrl || data.signed_url || '';
      if (!signed) throw new Error('Attachment URL missing');
      if (!signed.startsWith('http'))
        signed = SUPA_URL + (signed.startsWith('/storage') ? '' : '/storage/v1') + signed;
      return signed;
    }
    function _chatLoadAttachmentElement(el, rawUrl) {
      _chatSignAttachmentPath(rawUrl)
        .then(function (url) {
          if (!el || !url) return;
          if (el.tagName === 'A') el.href = url;
          else el.src = url;
        })
        .catch(function () {
          if (el && el.parentElement)
            el.parentElement.innerHTML =
              '<span style="font-size:.75rem;color:#f87171;font-weight:700">Attachment unavailable</span>';
        });
    }

    // ── Friends loading ────────────────────────────────────────────────────────
    async function _chatLoadFriends() {
      if (!_currentUser) return;
      try {
        var friendsRes = await fetch('/api/chat-friends', {
          headers: { Authorization: 'Bearer ' + (_sbToken || '') }
        });
        var friendsData = await friendsRes.json().catch(function () {
          return {};
        });
        if (!friendsRes.ok) throw new Error(friendsData.error || 'Could not load friends');
        _chatFriends = Array.isArray(friendsData.friends) ? friendsData.friends : [];
        return;
      } catch (e) {
        console.warn('Load friends error:', e);
        _chatFriends = [];
      }
    }

    async function _chatAcceptFriend(friendshipId) {
      try {
        await fetch(SUPA_URL + '/rest/v1/friendships?id=eq.' + encodeURIComponent(friendshipId), {
          method: 'PATCH',
          headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
          body: JSON.stringify({ status: 'accepted' })
        });
        await _chatLoadFriends();
        _chatRenderRooms();
      } catch (e) {
        console.warn('Accept friend error:', e);
      }
    }

    // ── Custom rooms ───────────────────────────────────────────────────────────
    var _customRooms = [];
    var _editingRoomId = null;
    var _editingRoomData = null;
    var _selectedVisibility = 'public';
    var _roomMembers = {}; // roomId -> true if current user is member

    async function _chatLoadCustomRooms() {
      if (!_currentUser) return;
      try {
        var res = await fetch(SUPA_URL + '/rest/v1/custom_rooms?order=created_at.asc', {
          headers: _sbHeaders()
        });
        var all = await res.json();
        if (!Array.isArray(all)) return;

        // Load user's memberships
        var memRes = await fetch(
          SUPA_URL +
            '/rest/v1/room_members?user_id=eq.' +
            encodeURIComponent(_currentUser.id) +
            '&select=room_id',
          { headers: _sbHeaders() }
        );
        var memData = await memRes.json();
        _roomMembers = {};
        if (Array.isArray(memData))
          memData.forEach(function (m) {
            _roomMembers[m.room_id] = true;
          });

        // Filter rooms by visibility
        var friendIds = _chatFriends
          .filter(function (f) {
            return f.status === 'accepted';
          })
          .map(function (f) {
            return f.otherId;
          });
        _customRooms = all.filter(function (r) {
          if (r.created_by === _currentUser.id) return true; // creator always sees own rooms
          if (r.visibility === 'public') return true;
          if (r.visibility === 'friends') return friendIds.indexOf(r.created_by) !== -1;
          if (r.visibility === 'invite') return !!_roomMembers[r.id];
          return false;
        });
        _chatRenderRooms();
      } catch (e) {
        console.warn('Load custom rooms error:', e);
      }
    }

    function _chatSetVisibility(vis) {
      _selectedVisibility = vis;
      document.querySelectorAll('.chat-vis-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.vis === vis);
      });
      var invRow = document.getElementById('chatRoomInviteRow');
      if (invRow) invRow.style.display = vis === 'invite' && _editingRoomId ? '' : 'none';
      var friendPicker = document.getElementById('chatRoomFriendPicker');
      if (friendPicker) friendPicker.style.display = vis === 'friends' ? '' : 'none';
    }

    function _chatPopulateFriendPicker(existingMemberIds) {
      var list = document.getElementById('chatRoomFriendList');
      if (!list) return;
      list.innerHTML = '';
      var accepted = _chatFriends.filter(function (f) {
        return f.status === 'accepted';
      });
      if (!accepted.length) {
        list.innerHTML =
          '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:6px">No friends yet — add some first</div>';
        return;
      }
      accepted.forEach(function (f) {
        var name = f.profile.full_name || 'Student';
        var isAdded = existingMemberIds && existingMemberIds.indexOf(f.otherId) !== -1;
        var row = document.createElement('label');
        row.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;cursor:pointer;font-family: var(--font-main);font-size:.82rem;font-weight:700;color:var(--on-glass)";
        row.innerHTML =
          '<input type="checkbox" data-friend-id="' +
          f.otherId +
          '" ' +
          (isAdded ? 'checked' : '') +
          ' style="accent-color:#3b82f6"/>' +
          '<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#0ea5e9);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.78rem;color:#fff;flex-shrink:0">' +
          name.charAt(0).toUpperCase() +
          '</div>' +
          name;
        list.appendChild(row);
      });
    }

    document.querySelectorAll('.chat-vis-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        _chatSetVisibility(b.dataset.vis);
      });
    });

    function _chatShowRoomModal(room) {
      _editingRoomId = room ? room.id : null;
      _editingRoomData = room || null;
      var modal = document.getElementById('chatRoomModal');
      var title = document.getElementById('chatRoomModalTitle');
      var nameInp = document.getElementById('chatRoomNameInput');
      var descInp = document.getElementById('chatRoomDescInput');
      var saveBtn = document.getElementById('chatRoomSaveBtn');
      var delBtn = document.getElementById('chatRoomDeleteBtn');
      var err = document.getElementById('chatRoomModalErr');
      if (!modal) return;
      var topicInp = document.getElementById('chatRoomTopicInput');
      var slowSel = document.getElementById('chatRoomSlowmodeSelect');
      var nsfwCheck = document.getElementById('chatRoomNsfwCheck');
      title.textContent = room ? '✏️ Edit Room' : '+ Create Room';
      nameInp.value = room ? room.name : '';
      descInp.value = room ? room.description || '' : '';
      if (topicInp) topicInp.value = room ? room.topic || '' : '';
      if (slowSel) slowSel.value = room ? String(room.slowmode_seconds || 0) : '0';
      if (nsfwCheck) nsfwCheck.checked = !!(room && room.is_nsfw);
      saveBtn.textContent = room ? 'Save →' : 'Create →';
      if (delBtn)
        delBtn.style.display =
          room && room.created_by === (_currentUser && _currentUser.id) ? '' : 'none';
      if (err) err.style.display = 'none';
      _chatSetVisibility(room ? room.visibility || 'public' : 'public');
      // Populate friend picker — fetch existing members if editing
      if (room && room.visibility === 'friends') {
        fetch(
          SUPA_URL +
            '/rest/v1/room_members?room_id=eq.' +
            encodeURIComponent(room.id) +
            '&select=user_id',
          { headers: _sbHeaders() }
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var ids = Array.isArray(data)
              ? data.map(function (m) {
                  return m.user_id;
                })
              : [];
            _chatPopulateFriendPicker(ids);
          })
          .catch(function () {
            _chatPopulateFriendPicker([]);
          });
      } else {
        _chatPopulateFriendPicker([]);
      }
      modal.style.display = 'flex';
      nameInp.focus();
    }

    function _chatHideRoomModal() {
      var modal = document.getElementById('chatRoomModal');
      if (modal) modal.style.display = 'none';
      _editingRoomId = null;
    }

    (
      document.getElementById('chatCreateRoomBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      _chatShowRoomModal(null);
    });
    (
      document.getElementById('chatRoomModalClose') || { addEventListener: function () {} }
    ).addEventListener('click', _chatHideRoomModal);

    (
      document.getElementById('chatRoomSaveBtn') || { addEventListener: function () {} }
    ).addEventListener('click', async function () {
      var name = (document.getElementById('chatRoomNameInput') || {}).value.trim();
      var desc = (document.getElementById('chatRoomDescInput') || {}).value.trim();
      var topic = (document.getElementById('chatRoomTopicInput') || {}).value.trim();
      var slowmode = parseInt(
        (document.getElementById('chatRoomSlowmodeSelect') || {}).value || '0',
        10
      );
      var isNsfw = !!(document.getElementById('chatRoomNsfwCheck') || {}).checked;
      var err = document.getElementById('chatRoomModalErr');
      if (!name) {
        if (err) {
          err.textContent = 'Room name is required.';
          err.style.display = '';
        }
        return;
      }
      if (!_currentUser) return;
      try {
        if (_editingRoomId) {
          await fetch(
            SUPA_URL + '/rest/v1/custom_rooms?id=eq.' + encodeURIComponent(_editingRoomId),
            {
              method: 'PATCH',
              headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
              body: JSON.stringify({
                name: name,
                description: desc,
                topic: topic,
                visibility: _selectedVisibility,
                slowmode_seconds: slowmode,
                is_nsfw: isNsfw
              })
            }
          );
        } else {
          var createRes = await fetch(SUPA_URL + '/rest/v1/custom_rooms', {
            method: 'POST',
            headers: Object.assign(_sbHeaders(), {
              Prefer: 'return=representation',
              'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
              name: name,
              description: desc,
              topic: topic,
              created_by: _currentUser.id,
              visibility: _selectedVisibility,
              slowmode_seconds: slowmode,
              is_nsfw: isNsfw
            })
          });
          var created = await createRes.json();
          // Auto-add creator as member
          if (Array.isArray(created) && created[0]) {
            await fetch(SUPA_URL + '/rest/v1/room_members', {
              method: 'POST',
              headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
              body: JSON.stringify({ room_id: created[0].id, user_id: _currentUser.id })
            });
          }
        }
        // Add selected friends as members (for friends-only rooms)
        if (_selectedVisibility === 'friends') {
          var checkedFriends = document.querySelectorAll(
            '#chatRoomFriendList input[type="checkbox"]:checked'
          );
          var targetRoomId =
            _editingRoomId ||
            (typeof created !== 'undefined' && Array.isArray(created) && created[0]
              ? created[0].id
              : null);
          if (targetRoomId && checkedFriends.length) {
            var addPromises = Array.from(checkedFriends).map(function (cb) {
              return fetch(SUPA_URL + '/rest/v1/room_members', {
                method: 'POST',
                headers: Object.assign(_sbHeaders(), {
                  Prefer: 'resolution=merge-duplicates,return=minimal'
                }),
                body: JSON.stringify({ room_id: targetRoomId, user_id: cb.dataset.friendId })
              });
            });
            await Promise.all(addPromises);
          }
        }
        _chatHideRoomModal();
        await _chatLoadCustomRooms();
      } catch (e) {
        if (err) {
          err.textContent = 'Error saving room.';
          err.style.display = '';
        }
      }
    });

    (
      document.getElementById('chatCopyInviteBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      if (!_editingRoomData || !_editingRoomData.invite_code) return;
      var link = location.origin + location.pathname + '?join=' + _editingRoomData.invite_code;
      navigator.clipboard.writeText(link).then(function () {
        var btn = document.getElementById('chatCopyInviteBtn');
        if (btn) {
          btn.textContent = '✅ Copied!';
          setTimeout(function () {
            btn.textContent = '🔗 Copy invite link';
          }, 2000);
        }
      });
    });

    (
      document.getElementById('chatRoomDeleteBtn') || { addEventListener: function () {} }
    ).addEventListener('click', async function () {
      if (!_editingRoomId || !confirm('Delete this room and all its messages?')) return;
      try {
        await fetch(
          SUPA_URL + '/rest/v1/custom_rooms?id=eq.' + encodeURIComponent(_editingRoomId),
          {
            method: 'DELETE',
            headers: _sbHeaders()
          }
        );
        _chatHideRoomModal();
        if (_chatRoomId === 'custom_' + _editingRoomId) {
          _chatRoomId = null;
          document.getElementById('chatRoomName').textContent = 'Select a room';
          document.getElementById('chatMsgs').innerHTML =
            '<div class="chat-empty">Select a room to start chatting 💬</div>';
        }
        await _chatLoadCustomRooms();
      } catch (e) {
        console.warn('Delete room error:', e);
      }
    });

    // ── Rooms + friends render ─────────────────────────────────────────────────
    function _chatGetRooms() {
      var rooms = [{ id: 'general', name: '# General', icon: '&#x1F310;' }];
      var seen = {};
      Object.keys(SEMS).forEach(function (sid) {
        var sem = SEMS[sid];
        if (!sem.courses || !sem.courses.length) return;
        sem.courses.forEach(function (c) {
          if (seen[c.id]) return;
          seen[c.id] = true;
          rooms.push({
            id: 'course_' + c.id,
            name: c.short || c.name,
            icon: '&#x1F4DA;',
            fullName: c.name
          });
        });
      });
      return rooms;
    }

    function _chatRenderMembers() {
      var onlineList = document.getElementById('chatOnlineList');
      var offlineList = document.getElementById('chatOfflineList');
      var onlineCount = document.getElementById('chatOnlineCount');
      var offlineCount = document.getElementById('chatOfflineCount');
      if (!onlineList || !offlineList) return;

      var accepted = _chatFriends.filter(function (f) {
        return f.status === 'accepted';
      });
      onlineList.innerHTML = '';
      offlineList.innerHTML = '';

      if (!accepted.length) {
        offlineList.innerHTML =
          '<div style="font-size:.72rem;color:rgba(255,255,255,.3);padding:6px 8px">No friends yet</div>';
        if (onlineCount) onlineCount.textContent = '0';
        if (offlineCount) offlineCount.textContent = '0';
        return;
      }

      var now = Date.now();
      var onlineCnt = 0,
        offlineCnt = 0;

      accepted.forEach(function (f) {
        var name =
          f.profile && f.profile.full_name
            ? f.profile.full_name
            : f.profile && f.profile.chat_username
              ? '@' + f.profile.chat_username
              : 'User';
        var initial = name.charAt(0).toUpperCase();
        var hue = (name.charCodeAt(0) * 37 + name.charCodeAt(name.length - 1) * 13) % 360;

        // Consider online if last_seen within 3 minutes
        var lastSeen =
          f.profile && f.profile.last_seen ? new Date(f.profile.last_seen).getTime() : 0;
        var isOnline = lastSeen && now - lastSeen < 3 * 60 * 1000;
        var statusClass = isOnline ? 'online' : 'offline';
        var statusText = isOnline ? 'Online' : 'Offline';

        var dmId = _chatDmRoomId(_currentUser.id, f.otherId);
        var item = document.createElement('div');
        item.className = 'dc-member-item';
        item.style.cursor = 'pointer';
        item.innerHTML =
          '<div class="dc-member-av" style="background:hsl(' +
          hue +
          ',60%,45%)">' +
          _chatEsc(initial) +
          '<span class="dc-member-av-status ' +
          statusClass +
          '"></span>' +
          '</div>' +
          '<div class="dc-member-meta">' +
          '<div class="dc-member-name">' +
          _chatEsc(name) +
          '</div>' +
          '<div class="dc-member-status-text">' +
          statusText +
          '</div>' +
          '</div>';
        item.addEventListener('click', function () {
          _chatOpenRoom(dmId, name);
        });

        if (isOnline) {
          onlineList.appendChild(item);
          onlineCnt++;
        } else {
          offlineList.appendChild(item);
          offlineCnt++;
        }
      });

      if (onlineCount) onlineCount.textContent = String(onlineCnt);
      if (offlineCount) offlineCount.textContent = String(offlineCnt);
    }

    function _chatRenderRooms() {
      var list = document.getElementById('chatRoomsList');
      if (!list) return;
      var rooms = _chatGetRooms();
      list.innerHTML = '';

      // ── General section ──
      var genLabel = document.createElement('div');
      genLabel.className = 'chat-rooms-section-label';
      genLabel.textContent = 'General';
      list.appendChild(genLabel);

      var genDiv = document.createElement('div');
      genDiv.className = 'chat-room-item' + ('general' === _chatRoomId ? ' active' : '');
      genDiv.innerHTML =
        '<span class="chat-room-icon">&#x1F310;</span><span class="chat-room-label"># General</span>';
      genDiv.addEventListener('click', function () {
        _chatOpenRoom('general', '# General');
      });
      list.appendChild(genDiv);

      // ── Custom Rooms section ──
      var crLabel = document.createElement('div');
      crLabel.className = 'chat-rooms-section-label';
      crLabel.style.marginTop = '8px';
      crLabel.textContent = 'Rooms';
      list.appendChild(crLabel);

      if (_customRooms.length) {
        _customRooms.forEach(function (r) {
          var rid = 'custom_' + r.id;
          var isCreator = r.created_by === (_currentUser && _currentUser.id);
          var row = document.createElement('div');
          row.className = 'chat-room-item' + (rid === _chatRoomId ? ' active' : '');
          row.style.justifyContent = 'space-between';
          row.innerHTML =
            '<span style="display:flex;align-items:center;gap:6px;overflow:hidden"><span class="chat-room-icon">&#x1F4AC;</span><span class="chat-room-label" title="' +
            _chatEsc(r.description || r.name) +
            '">' +
            _chatEsc(r.name) +
            '</span></span>' +
            (isCreator
              ? '<button style="background:none;border:none;color:rgba(59,130,246,.5);cursor:pointer;font-size:.8rem;padding:2px 4px;flex-shrink:0" title="Edit">&#x270E;</button>'
              : '');
          row.addEventListener('click', function () {
            _chatOpenRoom(rid, r.name);
          });
          if (isCreator) {
            row.querySelector('button').addEventListener('click', function (e) {
              e.stopPropagation();
              _chatShowRoomModal(r);
            });
          }
          list.appendChild(row);
        });
      } else {
        var noRooms = document.createElement('div');
        noRooms.style.cssText =
          'font-size:.72rem;color:var(--on-glass-faint);padding:6px 10px;font-weight:700';
        noRooms.textContent = 'No rooms yet — create one!';
        list.appendChild(noRooms);
      }

      // ── Course Rooms section ──
      var courseRooms = rooms.slice(1);
      if (courseRooms.length) {
        var courseLabel = document.createElement('div');
        courseLabel.className = 'chat-rooms-section-label';
        courseLabel.style.marginTop = '8px';
        courseLabel.textContent = 'Courses';
        list.appendChild(courseLabel);
        courseRooms.forEach(function (r) {
          var div = document.createElement('div');
          div.className = 'chat-room-item' + (r.id === _chatRoomId ? ' active' : '');
          div.innerHTML =
            '<span class="chat-room-icon">' +
            r.icon +
            '</span><span class="chat-room-label" title="' +
            _chatEsc(r.fullName || r.name) +
            '">' +
            _chatEsc(r.name) +
            '</span>';
          div.addEventListener('click', function () {
            _chatOpenRoom(r.id, r.fullName || r.name);
          });
          list.appendChild(div);
        });
      }

      // ── Direct Messages section ──
      var dmLabel = document.createElement('div');
      dmLabel.className = 'chat-rooms-section-label';
      dmLabel.style.marginTop = '8px';
      dmLabel.textContent = 'Direct Messages';
      list.appendChild(dmLabel);

      var accepted = _chatFriends.filter(function (f) {
        return f.status === 'accepted';
      });
      var pending = _chatFriends.filter(function (f) {
        return f.status === 'pending' && !f.isSender;
      }); // received requests

      if (!accepted.length && !pending.length) {
        var dm0 = document.createElement('div');
        dm0.style.cssText =
          'font-size:.72rem;color:var(--on-glass-faint);padding:6px 10px 4px;font-weight:700';
        dm0.textContent = 'No friends yet — use + to add one';
        list.appendChild(dm0);
      }

      // Pending incoming requests — show with Accept button
      pending.forEach(function (f) {
        var name = f.profile.full_name || 'Student';
        var row = document.createElement('div');
        row.className = 'chat-friend-pending';
        row.innerHTML =
          '<span class="chat-friend-pending-name" title="' +
          _chatEsc(name) +
          '">&#x23F3; ' +
          _chatEsc(name) +
          '</span>' +
          '<button class="chat-friend-accept-btn">Accept</button>';
        row.querySelector('button').addEventListener('click', function (e) {
          e.stopPropagation();
          _chatAcceptFriend(f.id);
        });
        list.appendChild(row);
      });

      // Accepted friends — DM rooms
      accepted.forEach(function (f) {
        var name = f.profile.full_name || 'Student';
        var initial = name.charAt(0).toUpperCase();
        var dmId = _chatDmRoomId(_currentUser.id, f.otherId);
        var row = document.createElement('div');
        row.className = 'chat-friend-item' + (dmId === _chatRoomId ? ' active' : '');
        row.dataset.rid = dmId;
        row.innerHTML =
          '<div class="chat-friend-avatar">' +
          _chatEsc(initial) +
          '</div>' +
          '<span class="chat-friend-name" title="' +
          _chatEsc(name) +
          '">' +
          _chatEsc(name) +
          '</span>';
        row.addEventListener('click', function () {
          _chatOpenRoom(dmId, name);
        });
        list.appendChild(row);
      });

      _chatRenderMembers();
    }

    // ── Chat state ─────────────────────────────────────────────────────────────
    var _chatReplyTo = null; // { id, display_name, content }
    var _chatSlowmode = 0;
    var _chatLastSent = 0;
    var _chatSlowTimer = null;
    var _chatTypingTimer = null;
    var _chatTypingPollTimer = null;
    var _chatNsfwAccepted = {};
    var _chatCurrentRoomData = null;

    // ── Markdown for chat (bold, italic, code, mentions) ──────────────────────
    function _chatMd(text) {
      var s = _chatEsc(text);
      // code blocks
      s = s.replace(
        /`([^`]+)`/g,
        '<code style="background:rgba(59,130,246,.15);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:.88em">$1</code>'
      );
      // bold
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // italic
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      // strikethrough
      s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
      // mentions @name
      s = s.replace(
        /@(\w[\w\s]*\w|\w)/g,
        '<span style="color:#3b82f6;font-weight:800;background:rgba(59,130,246,.12);border-radius:4px;padding:0 3px">@$1</span>'
      );
      return s;
    }

    // ── Room open ──────────────────────────────────────────────────────────────
    async function _chatOpenRoom(roomId, roomName) {
      if (_chatRoomId === roomId) return;
      clearInterval(_chatPollTimer);
      clearInterval(_chatTypingPollTimer);
      _chatClearTyping();
      _chatRoomId = roomId;
      _chatLastTs = null;
      _chatReplyTo = null;
      _chatCurrentRoomData = null;

      // Get room data for custom rooms
      if (roomId.startsWith('custom_')) {
        var rid = roomId.replace('custom_', '');
        _chatCurrentRoomData =
          _customRooms.find(function (r) {
            return r.id === rid;
          }) || null;
      }

      var nameEl = document.getElementById('chatRoomName');
      if (nameEl) nameEl.textContent = roomName;

      // Topic
      var topicEl = document.getElementById('chatRoomTopic');
      if (topicEl) {
        var topic = _chatCurrentRoomData && _chatCurrentRoomData.topic;
        if (topic) {
          topicEl.textContent = topic;
          topicEl.style.display = '';
        } else topicEl.style.display = 'none';
      }

      // Settings button (creator only)
      var isCreator =
        _chatCurrentRoomData &&
        _chatCurrentRoomData.created_by === (_currentUser && _currentUser.id);
      var settBtn = document.getElementById('chatRoomSettingsBtn');
      if (settBtn) settBtn.style.display = isCreator ? '' : 'none';

      // Invite button (visible to all members of invite-only rooms)
      var invHdrBtn = document.getElementById('chatCopyInviteHdrBtn');
      if (invHdrBtn)
        invHdrBtn.style.display =
          _chatCurrentRoomData && _chatCurrentRoomData.visibility === 'invite' ? '' : 'none';

      // Pins + nickname buttons (visible in any room)
      var pinsBtn = document.getElementById('chatPinsBtn');
      var nickBtn = document.getElementById('chatNicknameBtn');
      var inRoom = !!roomId;
      if (pinsBtn) pinsBtn.style.display = inRoom ? '' : 'none';
      if (nickBtn) nickBtn.style.display = inRoom ? '' : 'none';

      // Close pins panel when switching rooms
      var pinsPanel = document.getElementById('chatPinsPanel');
      if (pinsPanel) pinsPanel.style.display = 'none';

      // Enable attach + gif buttons
      var attachBtn = document.getElementById('chatAttachBtn');
      var gifBtn = document.getElementById('chatGifBtn');
      if (attachBtn) attachBtn.disabled = false;
      if (gifBtn) gifBtn.disabled = false;

      // Load nicknames and blocked users for this room
      _chatLoadNicknames();
      _chatLoadBlocked();

      // Slowmode
      _chatSlowmode = (_chatCurrentRoomData && _chatCurrentRoomData.slowmode_seconds) || 0;
      var slowBar = document.getElementById('chatSlowmodeBar');
      if (slowBar) slowBar.style.display = _chatSlowmode ? '' : 'none';

      // Hide reply bar
      var replyBar = document.getElementById('chatReplyBar');
      if (replyBar) replyBar.style.display = 'none';

      document.querySelectorAll('.chat-room-item, .chat-friend-item').forEach(function (el) {
        el.classList.toggle('active', el.dataset.rid === roomId);
      });

      var inp = document.getElementById('chatInput');
      var btn = document.getElementById('chatSendBtn');
      if (inp) {
        inp.disabled = false;
        inp.placeholder = 'Message ' + roomName + '...';
      }
      if (btn) btn.disabled = false;

      // NSFW gate
      var isNsfw = _chatCurrentRoomData && _chatCurrentRoomData.is_nsfw;
      var gate = document.getElementById('chatNsfwGate');
      if (gate) gate.style.display = isNsfw && !_chatNsfwAccepted[roomId] ? 'flex' : 'none';

      var msgs = document.getElementById('chatMsgs');
      if (msgs) msgs.innerHTML = '<div class="chat-loading">Loading&#x2026;</div>';

      await _chatLoad(true);
      if (_chatRoomId !== roomId) return; // another room opened while this one was loading
      var _reconcileTick = 0;
      _chatPollTimer = setInterval(function () {
        _chatLoad(false);
        _chatPollTyping();
        // Reconcile deletions/edits every ~9s. _chatLoad only fetches NEWER
        // rows, so without this a message another user deleted or edited would
        // linger in this view until a full reload.
        if (++_reconcileTick % 3 === 0) _chatReconcileRendered();
      }, 3000);
    }

    // Compares the messages currently on screen against the server and applies
    // deletions (row gone → remove from view) and edits (edited_at changed →
    // re-render the bubble). Scoped to the rendered ids so the query stays small.
    async function _chatReconcileRendered() {
      if (!_chatRoomId || !_currentUser) return;
      var msgsEl = document.getElementById('chatMsgs');
      if (!msgsEl) return;
      var els = Array.prototype.slice.call(msgsEl.querySelectorAll('.chat-msg[data-mid]'));
      if (!els.length) return;
      var ids = els
        .map(function (el) { return el.dataset.mid; })
        .filter(function (id) { return id; });
      if (!ids.length) return;
      try {
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/messages?id=in.(' +
            ids.map(encodeURIComponent).join(',') +
            ')&select=id,content,edited_at',
          { headers: _sbHeaders() }
        );
        if (!res.ok) return;
        var rows = await res.json();
        if (!Array.isArray(rows)) return;
        var byId = {};
        rows.forEach(function (r) { byId[r.id] = r; });
        els.forEach(function (el) {
          var id = el.dataset.mid;
          var row = byId[id];
          if (!row) {
            // Deleted on the server by its author — drop it from this view too.
            el.remove();
            return;
          }
          var serverEdited = row.edited_at || '';
          if (serverEdited !== (el.dataset.editedAt || '')) {
            el.dataset.editedAt = serverEdited;
            var bubble = el.querySelector('.chat-msg-bubble');
            if (bubble) {
              bubble.innerHTML =
                _chatContentHTML(row.content || '') + (serverEdited ? _CHAT_EDITED_MARK : '');
            }
          }
        });
      } catch (e) {}
    }

    // Renders message text → safe HTML with clickable links.
    // The URL regex must exclude characters that could break out of the href
    // attribute after entity decoding (because _chatMd already ran _chatEsc, a
    // raw `"` is now `&quot;`, which would decode back inside the attribute and
    // enable injection). Stopping at `&`, `"`, `'`, `<`, `>` blocks that path.
    function _chatContentHTML(content) {
      return content
        ? _chatMd(content).replace(
            /(https?:\/\/[^\s<>&"']+)/g,
            '<a href="$1" target="_blank" rel="noopener" style="color:#3b82f6;text-decoration:underline;word-break:break-all">$1</a>'
          )
        : '';
    }

    var _CHAT_EDITED_MARK = ' <span style="font-size:.65rem;opacity:.5">(edited)</span>';

    // ── Message rendering ──────────────────────────────────────────────────────
    function _chatRenderMsg(m, msgs) {
      if (document.querySelector('[data-mid="' + m.id + '"]')) return;
      if (_blockedUsers.has(m.user_id)) return; // hide blocked users
      var isMe = m.user_id === _currentUser.id;
      var wrap = document.createElement('div');
      wrap.className = 'chat-msg' + (isMe ? ' chat-msg-me' : '');
      wrap.dataset.mid = m.id;
      wrap.dataset.senderId = m.user_id;
      wrap.dataset.editedAt = m.edited_at || '';

      var d = new Date(m.created_at);
      var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var editedMark = m.edited_at ? _CHAT_EDITED_MARK : '';

      // Reply reference
      var replyHTML = '';
      if (m.reply_to_id && m._replyRef) {
        replyHTML =
          '<div class="chat-reply-ref"><span class="chat-reply-ref-name">' +
          _chatEsc(m._replyRef.display_name || 'User') +
          '</span>: ' +
          _chatEsc((m._replyRef.content || '').slice(0, 60)) +
          '</div>';
      }

      // Display name (use nickname if set)
      var displayName = _chatNicknames[m.user_id] || m.display_name || 'Student';
      var nameHTML = isMe ? '' : '<div class="chat-msg-name">' + _chatEsc(displayName) + '</div>';

      // Attachment
      var attachHTML = '';
      if (m.attachment_url) {
        var t = m.attachment_type || '';
        if (t.startsWith('image/')) {
          attachHTML =
            '<div style="margin-top:6px"><img src="' +
            _chatEsc(m.attachment_url) +
            '" style="max-width:260px;max-height:200px;border-radius:10px;display:block;cursor:pointer"/></div>';
        } else if (t.startsWith('video/')) {
          attachHTML =
            '<div style="margin-top:6px"><video src="' +
            _chatEsc(m.attachment_url) +
            '" controls style="max-width:260px;border-radius:10px"></video></div>';
        } else {
          attachHTML =
            '<div style="margin-top:6px"><a href="' +
            _chatEsc(m.attachment_url) +
            '" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:10px;color:#3b82f6;font-size:.8rem;font-weight:700;text-decoration:none">📎 ' +
            _chatEsc(m.attachment_name || 'File') +
            '</a></div>';
        }
      }

      if (m.attachment_url) {
        var attachId = 'chat-att-' + _chatSafeStoragePart(m.id || Date.now() + '');
        var attachType = m.attachment_type || '';
        if (attachType.startsWith('image/')) {
          attachHTML =
            '<div style="margin-top:6px"><img id="' +
            attachId +
            '" alt="' +
            _chatEsc(m.attachment_name || 'Attachment') +
            '" style="max-width:260px;max-height:200px;border-radius:10px;display:block;cursor:pointer"/></div>';
        } else {
          attachHTML =
            '<div style="margin-top:6px"><a id="' +
            attachId +
            '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:10px;color:#3b82f6;font-size:.8rem;font-weight:700;text-decoration:none">Attachment: ' +
            _chatEsc(m.attachment_name || 'File') +
            '</a></div>';
        }
      }

      var contentHTML = _chatContentHTML(m.content);

      var escName = _chatEsc(m.display_name || 'Student');
      var escContent = _chatEsc(m.content || '');

      wrap.innerHTML =
        replyHTML +
        nameHTML +
        (contentHTML ? '<div class="chat-msg-bubble">' + contentHTML + editedMark + '</div>' : '') +
        attachHTML +
        '<div class="chat-msg-time">' +
        time +
        '</div>' +
        '<div class="chat-msg-actions">' +
        '<button class="chat-action-btn" data-act="react" data-mid="' +
        m.id +
        '" title="React">😊</button>' +
        '<button class="chat-action-btn" data-act="reply" data-mid="' +
        m.id +
        '" data-name="' +
        escName +
        '" data-content="' +
        escContent +
        '" title="Reply">↩</button>' +
        '<button class="chat-action-btn" data-act="pin" data-mid="' +
        m.id +
        '" data-name="' +
        escName +
        '" data-content="' +
        escContent +
        '" title="Pin">📌</button>' +
        (isMe
          ? '<button class="chat-action-btn" data-act="edit" data-mid="' +
            m.id +
            '" data-content="' +
            escContent +
            '" title="Edit">✏️</button>'
          : '') +
        (isMe
          ? '<button class="chat-action-btn" data-act="delete" data-mid="' +
            m.id +
            '" title="Delete">🗑</button>'
          : '') +
        (!isMe
          ? '<button class="chat-action-btn" data-act="block" data-uid="' +
            m.user_id +
            '" data-name="' +
            escName +
            '" title="Block user">🚫</button>'
          : '') +
        '</div>' +
        '<div class="chat-reactions" id="reactions-' +
        m.id +
        '"></div>';

      msgs.appendChild(wrap);
      if (m.attachment_url) {
        var attachmentEl = document.getElementById('chat-att-' + _chatSafeStoragePart(m.id || ''));
        if (attachmentEl) {
          _chatLoadAttachmentElement(attachmentEl, m.attachment_url);
          if ((m.attachment_type || '').startsWith('image/')) {
            attachmentEl.addEventListener('click', function () {
              if (attachmentEl.src) window.open(attachmentEl.src, '_blank');
            });
          }
        }
      }
    }

    async function _chatLoad(initial) {
      if (!_chatRoomId || !_currentUser) return;
      if (!initial && _chatLoadInFlight) return;
      var _myLoadSeq = ++_chatLoadSeq;
      _chatLoadInFlight = true;
      try {
        var url = SUPA_URL + '/rest/v1/messages?room_id=eq.' + encodeURIComponent(_chatRoomId);
        if (!initial && _chatLastTs) url += '&created_at=gt.' + encodeURIComponent(_chatLastTs);
        url += '&order=created_at.asc&limit=' + (initial ? '60' : '30');

        var res = await fetch(url, { headers: _sbHeaders() });
        var data = await res.json();
        if (_myLoadSeq !== _chatLoadSeq) return; // stale response superseded by newer request
        if (!Array.isArray(data)) return;

        var msgs = document.getElementById('chatMsgs');
        if (!msgs) return;

        if (initial) {
          msgs.innerHTML = '';
          if (!data.length) {
            msgs.innerHTML = '<div class="chat-empty">No messages yet 👋 Say hello!</div>';
            return;
          }
        }
        if (!data.length) return;

        _chatLastTs = data[data.length - 1].created_at;
        var atBottom = msgs.scrollHeight - msgs.scrollTop <= msgs.clientHeight + 80;

        // Fetch reply references for messages that have reply_to_id
        var replyIds = data
          .filter(function (m) {
            return m.reply_to_id;
          })
          .map(function (m) {
            return m.reply_to_id;
          });
        var replyMap = {};
        if (replyIds.length) {
          try {
            var rRes = await fetch(
              SUPA_URL +
                '/rest/v1/messages?id=in.(' +
                replyIds.map(encodeURIComponent).join(',') +
                ')&select=id,display_name,content',
              { headers: _sbHeaders() }
            );
            var rData = await rRes.json();
            if (Array.isArray(rData))
              rData.forEach(function (r) {
                replyMap[r.id] = r;
              });
          } catch (e) {}
        }

        var lastDate = null;
        data.forEach(function (m) {
          var d = new Date(m.created_at);
          var dateStr = d.toLocaleDateString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
          });
          if (dateStr !== lastDate) {
            lastDate = dateStr;
            if (!document.querySelector('.chat-date-divider[data-date="' + dateStr + '"]')) {
              var div = document.createElement('div');
              div.className = 'chat-date-divider';
              div.dataset.date = dateStr;
              div.textContent = dateStr;
              msgs.appendChild(div);
            }
          }
          if (m.reply_to_id) m._replyRef = replyMap[m.reply_to_id] || null;
          _chatRenderMsg(m, msgs);
        });

        // One batched reaction fetch for the whole page instead of one request
        // per message — this is what made opening a conversation crawl.
        var _reactIds = data.map(function (mm) { return mm.id; }).filter(Boolean);
        if (_reactIds.length) _chatLoadReactionsBatch(_reactIds);

        if (initial || atBottom) msgs.scrollTop = msgs.scrollHeight;
      } catch (e) {
        console.warn('Chat load error:', e);
      } finally {
        if (_myLoadSeq === _chatLoadSeq) _chatLoadInFlight = false;
      }
    }

    // ── Reactions ──────────────────────────────────────────────────────────────
    function _chatRenderReactions(msgId, rows) {
      var el = document.getElementById('reactions-' + msgId);
      if (!el) return;
      var counts = {};
      var mine = {};
      (rows || []).forEach(function (r) {
        counts[r.emoji] = (counts[r.emoji] || 0) + 1;
        if (r.user_id === _currentUser.id) mine[r.emoji] = true;
      });
      el.innerHTML = '';
      Object.keys(counts).forEach(function (emoji) {
        var btn = document.createElement('button');
        btn.className = 'chat-reaction-pill' + (mine[emoji] ? ' mine' : '');
        btn.textContent = emoji + ' ' + counts[emoji];
        btn.addEventListener('click', function () {
          _chatToggleReaction(msgId, emoji);
        });
        el.appendChild(btn);
      });
    }

    // Single-message refresh — used after the current user toggles a reaction.
    async function _chatLoadReactions(msgId) {
      try {
        var res = await fetch(
          SUPA_URL + '/rest/v1/message_reactions?message_id=eq.' + encodeURIComponent(msgId),
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        if (Array.isArray(data)) _chatRenderReactions(msgId, data);
      } catch (e) {}
    }

    // Batched load for a whole page of messages — one request that fetches every
    // message's reactions at once, then distributes them, instead of a fetch per
    // message (opening a 60-message chat used to fire 60 requests).
    async function _chatLoadReactionsBatch(ids) {
      if (!ids || !ids.length) return;
      try {
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/message_reactions?message_id=in.(' +
            ids.map(encodeURIComponent).join(',') +
            ')',
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        if (!Array.isArray(data)) return;
        var byMsg = {};
        data.forEach(function (r) {
          (byMsg[r.message_id] = byMsg[r.message_id] || []).push(r);
        });
        ids.forEach(function (id) {
          _chatRenderReactions(id, byMsg[id] || []);
        });
      } catch (e) {}
    }

    async function _chatToggleReaction(msgId, emoji) {
      try {
        // Check if user already reacted
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/message_reactions?message_id=eq.' +
            encodeURIComponent(msgId) +
            '&user_id=eq.' +
            encodeURIComponent(_currentUser.id) +
            '&emoji=eq.' +
            encodeURIComponent(emoji),
          { headers: _sbHeaders() }
        );
        var existing = await res.json();
        if (Array.isArray(existing) && existing.length) {
          await fetch(
            SUPA_URL +
              '/rest/v1/message_reactions?message_id=eq.' +
              encodeURIComponent(msgId) +
              '&user_id=eq.' +
              encodeURIComponent(_currentUser.id) +
              '&emoji=eq.' +
              encodeURIComponent(emoji),
            { method: 'DELETE', headers: _sbHeaders() }
          );
        } else {
          await fetch(SUPA_URL + '/rest/v1/message_reactions', {
            method: 'POST',
            headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
            body: JSON.stringify({ message_id: msgId, user_id: _currentUser.id, emoji: emoji })
          });
        }
        _chatLoadReactions(msgId);
      } catch (e) {}
    }

    // Reaction picker
    var _chatReactTargetMsgId = null;
    document.addEventListener('click', function (e) {
      var picker = document.getElementById('chatReactionPicker');
      if (!picker) return;
      var actBtn = e.target.closest('[data-act="react"]');
      if (actBtn) {
        _chatReactTargetMsgId = actBtn.dataset.mid;
        var rect = actBtn.getBoundingClientRect();
        var chatMain = document.querySelector('.chat-main');
        var mainRect = chatMain ? chatMain.getBoundingClientRect() : { left: 0, top: 0 };
        picker.style.left = rect.left - mainRect.left + 'px';
        picker.style.top = rect.top - mainRect.top - 52 + 'px';
        picker.style.display = 'block';
        e.stopPropagation();
        return;
      }
      if (!picker.contains(e.target)) picker.style.display = 'none';
    });

    document.querySelectorAll('.chat-react-emoji').forEach(function (el) {
      el.addEventListener('click', function () {
        if (_chatReactTargetMsgId) {
          _chatToggleReaction(_chatReactTargetMsgId, el.dataset.emoji);
          document.getElementById('chatReactionPicker').style.display = 'none';
        }
      });
    });

    // ── Reply ──────────────────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="reply"]');
      if (!btn) return;
      _chatReplyTo = {
        id: btn.dataset.mid,
        display_name: btn.dataset.name,
        content: btn.dataset.content
      };
      var bar = document.getElementById('chatReplyBar');
      var nameEl = document.getElementById('chatReplyName');
      var prevEl = document.getElementById('chatReplyPreview');
      if (bar) bar.style.display = 'flex';
      if (nameEl) nameEl.textContent = _chatReplyTo.display_name;
      if (prevEl) prevEl.textContent = (_chatReplyTo.content || '').slice(0, 60);
      var inp = document.getElementById('chatInput');
      if (inp) inp.focus();
    });

    (
      document.getElementById('chatReplyCancelBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      _chatReplyTo = null;
      var bar = document.getElementById('chatReplyBar');
      if (bar) bar.style.display = 'none';
    });

    // ── Edit message ───────────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="edit"]');
      if (!btn) return;
      var msgId = btn.dataset.mid;
      var current = btn.dataset.content;
      var inp = document.getElementById('chatInput');
      if (!inp) return;
      inp.value = current;
      inp.dataset.editingMsgId = msgId;
      inp.placeholder = 'Editing message... (press Enter)';
      inp.focus();
    });

    // ── Typing indicator ───────────────────────────────────────────────────────
    function _chatClearTyping() {
      var bar = document.getElementById('chatTypingBar');
      if (bar) bar.textContent = '';
    }

    async function _chatPollTyping() {
      if (!_chatRoomId || !_currentUser) return;
      try {
        var cutoff = new Date(Date.now() - 4000).toISOString();
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/typing_indicators?room_id=eq.' +
            encodeURIComponent(_chatRoomId) +
            '&user_id=neq.' +
            encodeURIComponent(_currentUser.id) +
            '&updated_at=gt.' +
            encodeURIComponent(cutoff),
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        var bar = document.getElementById('chatTypingBar');
        if (!bar) return;
        if (!Array.isArray(data) || !data.length) {
          bar.textContent = '';
          return;
        }
        var names = data.map(function (t) {
          return t.display_name || 'Someone';
        });
        bar.textContent =
          names.join(', ') + (names.length === 1 ? ' is typing...' : ' are typing...');
      } catch (e) {}
    }

    async function _chatSendTyping() {
      if (!_chatRoomId || !_currentUser) return;
      var displayName = (document.getElementById('authName') || {}).textContent || 'Student';
      try {
        await fetch(SUPA_URL + '/rest/v1/typing_indicators', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), { Prefer: 'resolution=merge-duplicates' }),
          body: JSON.stringify({
            room_id: _chatRoomId,
            user_id: _currentUser.id,
            display_name: displayName,
            updated_at: new Date().toISOString()
          })
        });
      } catch (e) {}
    }

    async function _chatClearTypingIndicator() {
      if (!_chatRoomId || !_currentUser) return;
      try {
        await fetch(
          SUPA_URL +
            '/rest/v1/typing_indicators?room_id=eq.' +
            encodeURIComponent(_chatRoomId) +
            '&user_id=eq.' +
            encodeURIComponent(_currentUser.id),
          { method: 'DELETE', headers: _sbHeaders() }
        );
      } catch (e) {}
    }

    // Wire typing to input
    (function () {
      var inp = document.getElementById('chatInput');
      if (!inp) return;
      inp.addEventListener('input', function () {
        if (inp.dataset.editingMsgId) return;
        clearTimeout(_chatTypingTimer);
        _chatSendTyping();
        _chatTypingTimer = setTimeout(_chatClearTypingIndicator, 3000);
      });
    })();

    // ── Slowmode ───────────────────────────────────────────────────────────────
    function _chatCheckSlowmode() {
      if (!_chatSlowmode) return true;
      var elapsed = (Date.now() - _chatLastSent) / 1000;
      if (elapsed >= _chatSlowmode) return true;
      var remaining = Math.ceil(_chatSlowmode - elapsed);
      var bar = document.getElementById('chatSlowmodeBar');
      if (bar)
        bar.textContent = '🐌 Slowmode: wait ' + remaining + 's before sending another message';
      var inp = document.getElementById('chatInput');
      var btn = document.getElementById('chatSendBtn');
      if (inp) inp.disabled = true;
      if (btn) btn.disabled = true;
      clearInterval(_chatSlowTimer);
      _chatSlowTimer = setInterval(function () {
        var rem = Math.ceil(_chatSlowmode - (Date.now() - _chatLastSent) / 1000);
        if (rem <= 0) {
          clearInterval(_chatSlowTimer);
          if (inp) {
            inp.disabled = false;
            inp.placeholder = 'Type a message...';
          }
          if (btn) btn.disabled = false;
          if (bar) {
            bar.textContent = '';
            bar.style.display = 'none';
          }
        } else {
          if (bar)
            bar.textContent = '🐌 Slowmode: wait ' + rem + 's before sending another message';
        }
      }, 1000);
      return false;
    }

    // ── NSFW gate ──────────────────────────────────────────────────────────────
    (
      document.getElementById('chatNsfwEnterBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      if (_chatRoomId) _chatNsfwAccepted[_chatRoomId] = true;
      var gate = document.getElementById('chatNsfwGate');
      if (gate) gate.style.display = 'none';
    });

    // ── Members panel toggle ───────────────────────────────────────────────────
    // The members panel (#chatMembersPanel) is rendered alongside the chat by
    // default. The header 👥 icon toggles its visibility — useful on narrow
    // viewports where the right rail crowds the message list, and as a
    // privacy nudge for shared screens.
    (
      document.getElementById('chatMembersToggleBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var panel = document.getElementById('chatMembersPanel');
      if (!panel) return;
      var hidden = panel.style.display === 'none';
      panel.style.display = hidden ? '' : 'none';
      var btn = document.getElementById('chatMembersToggleBtn');
      if (btn) btn.classList.toggle('is-active', hidden);
    });

    // ── Room settings button ───────────────────────────────────────────────────
    (
      document.getElementById('chatRoomSettingsBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      if (_chatCurrentRoomData) _chatShowRoomModal(_chatCurrentRoomData);
    });

    // ── Invite button in header ────────────────────────────────────────────────
    (
      document.getElementById('chatCopyInviteHdrBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      if (!_chatCurrentRoomData || !_chatCurrentRoomData.invite_code) return;
      var link = location.origin + location.pathname + '?join=' + _chatCurrentRoomData.invite_code;
      navigator.clipboard.writeText(link).then(function () {
        var btn = document.getElementById('chatCopyInviteHdrBtn');
        if (btn) {
          btn.textContent = '✅ Copied!';
          setTimeout(function () {
            btn.innerHTML = '&#x1F517; Invite';
          }, 2000);
        }
      });
    });

    // ── Join Room modal ────────────────────────────────────────────────────────
    (function () {
      var openBtn = document.getElementById('chatJoinRoomBtn');
      var modal = document.getElementById('chatJoinRoomModal');
      var closeBtn = document.getElementById('chatJoinRoomModalClose');
      var inp = document.getElementById('chatJoinRoomInput');
      var results = document.getElementById('chatJoinRoomResults');
      var errEl = document.getElementById('chatJoinRoomErr');
      if (!modal) return;

      function showModal() {
        modal.style.display = 'flex';
        if (inp) {
          inp.value = '';
          inp.focus();
        }
        if (results)
          results.innerHTML =
            '<div style="font-size:.75rem;color:var(--on-glass-faint);font-weight:700;padding:6px 4px">Type a room name to search public rooms, or paste an invite link</div>';
        if (errEl) errEl.style.display = 'none';
      }
      function hideModal() {
        modal.style.display = 'none';
      }

      if (openBtn) openBtn.addEventListener('click', showModal);
      if (closeBtn) closeBtn.addEventListener('click', hideModal);
      modal.addEventListener('click', function (e) {
        if (e.target === modal) hideModal();
      });

      async function _joinByInviteCode(code) {
        if (!_currentUser) return;
        if (errEl) errEl.style.display = 'none';
        try {
          var res = await fetch('/api/join-room-by-code', {
            method: 'POST',
            headers: _sbHeaders(),
            body: JSON.stringify({ code: code })
          });
          var data = await res.json();
          if (!res.ok || !data || !data.room) {
            if (errEl) {
              errEl.textContent = (data && data.error) || 'Invalid invite link or code.';
              errEl.style.display = '';
            }
            return;
          }
          var room = data.room;
          hideModal();
          showToast('Joined ' + room.name, 'You can now access this room.');
          await _chatLoadCustomRooms();
          _chatOpenRoom('custom_' + room.id, room.name);
        } catch (e) {
          if (errEl) {
            errEl.textContent = 'Could not join room. Try again.';
            errEl.style.display = '';
          }
        }
      }

      async function _searchPublicRooms(query) {
        if (!results) return;
        results.innerHTML =
          '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:8px">Searching...</div>';
        try {
          var res = await fetch(
            SUPA_URL +
              '/rest/v1/custom_rooms?visibility=eq.public&name=ilike.*' +
              encodeURIComponent(query) +
              '*&select=id,name,description&limit=10',
            { headers: _sbHeaders() }
          );
          var data = await res.json();
          results.innerHTML = '';
          if (!Array.isArray(data) || !data.length) {
            results.innerHTML =
              '<div style="font-size:.75rem;color:var(--on-glass-faint);font-weight:700;padding:8px">No public rooms found</div>';
            return;
          }
          data.forEach(function (r) {
            var alreadyIn = _customRooms.some(function (cr) {
              return cr.id === r.id;
            });
            var row = document.createElement('div');
            row.style.cssText =
              'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:var(--row-bg);gap:10px';
            row.innerHTML =
              '<div style="min-width:0"><div style="font-weight:800;font-size:.85rem;color:var(--on-glass)">' +
              _chatEsc(r.name) +
              '</div>' +
              (r.description
                ? '<div style="font-size:.72rem;color:var(--on-glass-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
                  _chatEsc(r.description) +
                  '</div>'
                : '') +
              '</div>' +
              '<button style="flex-shrink:0;padding:5px 14px;background:' +
              (alreadyIn ? 'rgba(34,197,94,.15)' : 'linear-gradient(135deg,#3b82f6,#0ea5e9)') +
              ";border:none;border-radius:20px;font-family: var(--font-main);font-weight:800;font-size:.75rem;color:" +
              (alreadyIn ? '#22c55e' : '#fff') +
              ';cursor:pointer">' +
              (alreadyIn ? '✅ Joined' : 'Join') +
              '</button>';
            if (!alreadyIn) {
              row.querySelector('button').addEventListener('click', async function () {
                await fetch(SUPA_URL + '/rest/v1/room_members', {
                  method: 'POST',
                  headers: Object.assign(_sbHeaders(), {
                    Prefer: 'resolution=merge-duplicates,return=minimal'
                  }),
                  body: JSON.stringify({ room_id: r.id, user_id: _currentUser.id })
                });
                hideModal();
                showToast('Joined ' + r.name, '');
                await _chatLoadCustomRooms();
                _chatOpenRoom('custom_' + r.id, r.name);
              });
            }
            results.appendChild(row);
          });
        } catch (e) {
          if (results)
            results.innerHTML =
              '<div style="font-size:.75rem;color:#ef4444;padding:8px">Search failed. Try again.</div>';
        }
      }

      var _joinSearchTimer = null;
      if (inp)
        inp.addEventListener('input', function () {
          var val = inp.value.trim();
          if (errEl) errEl.style.display = 'none';
          // Detect invite link
          var linkMatch = val.match(/[?&]join=([a-f0-9-]{8,})/);
          if (linkMatch) {
            _joinByInviteCode(linkMatch[1]);
            return;
          }
          // Plain invite code (looks like a UUID fragment)
          if (/^[a-f0-9-]{8,36}$/.test(val)) {
            clearTimeout(_joinSearchTimer);
            _joinSearchTimer = setTimeout(function () {
              _joinByInviteCode(val);
            }, 600);
            return;
          }
          // Room name search
          if (val.length >= 2) {
            clearTimeout(_joinSearchTimer);
            _joinSearchTimer = setTimeout(function () {
              _searchPublicRooms(val);
            }, 400);
          } else {
            if (results)
              results.innerHTML =
                '<div style="font-size:.75rem;color:var(--on-glass-faint);font-weight:700;padding:6px 4px">Type a room name to search public rooms, or paste an invite link</div>';
          }
        });
    })();

    // ── Send ───────────────────────────────────────────────────────────────────
    async function _chatSend() {
      if (!_currentUser || !_chatRoomId) return;
      if (_chatSending) return;
      var inp = document.getElementById('chatInput');
      if (!inp) return;
      var content = inp.value.trim();
      // Allow sending a bare attachment with no caption. The backend accepts an
      // empty content as long as attachment_url is present; without this guard a
      // file added with no text was silently dropped here before it was ever
      // uploaded — "upload works but sending doesn't".
      if (!content && !_chatPendingFile) return;

      // Edit mode
      if (inp.dataset.editingMsgId) {
        var editId = inp.dataset.editingMsgId;
        inp.value = '';
        inp.dataset.editingMsgId = '';
        inp.placeholder = 'Type a message...';
        try {
          await fetch(SUPA_URL + '/rest/v1/messages?id=eq.' + encodeURIComponent(editId), {
            method: 'PATCH',
            headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
            body: JSON.stringify({ content: content, edited_at: new Date().toISOString() })
          });
          // Update the message in place. The poll's _chatLoad is incremental
          // (only fetches rows newer than the last timestamp), so removing +
          // reloading would make the edited message vanish until a full
          // refresh. Other users pick up the edit via _chatReconcileRendered.
          var msgEl = document.querySelector('[data-mid="' + editId + '"]');
          if (msgEl) {
            msgEl.dataset.editedAt = new Date().toISOString();
            var b = msgEl.querySelector('.chat-msg-bubble');
            if (b) b.innerHTML = _chatContentHTML(content) + _CHAT_EDITED_MARK;
          }
        } catch (e) {
          console.warn('Edit error:', e);
        }
        return;
      }

      if (!_chatCheckSlowmode()) return;
      inp.value = '';

      var displayName =
        _chatNicknames[_currentUser.id] ||
        (document.getElementById('authName') || {}).textContent ||
        'Student';
      var payload = {
        room_id: _chatRoomId,
        user_id: _currentUser.id,
        display_name: displayName,
        content: content
      };

      // Handle file attachment
      if (_chatPendingFile) {
        try {
          var att = await _chatUploadFile(_chatPendingFile);
          payload.attachment_url = att.url;
          payload.attachment_type = att.type;
          payload.attachment_name = att.name;
        } catch (e) {
          showToast('Upload failed', e.message);
          return;
        }
        _chatPendingFile = null;
        var bar = document.getElementById('chatFilePreviewBar');
        if (bar) bar.style.display = 'none';
      }
      if (_chatReplyTo) {
        payload.reply_to_id = _chatReplyTo.id;
      }

      // Parse mentions
      var mentionMatches = content.match(/@(\w[\w\s]*\w|\w)/g) || [];
      if (mentionMatches.length) payload.mentions = mentionMatches;

      _chatReplyTo = null;
      var replyBar = document.getElementById('chatReplyBar');
      if (replyBar) replyBar.style.display = 'none';
      _chatLastSent = Date.now();
      _chatClearTypingIndicator();

      _chatSending = true;
      try {
        await _chatPostMessage(payload);
        await _chatLoad(false);
        if (_chatSlowmode) {
          var bar = document.getElementById('chatSlowmodeBar');
          if (bar) {
            bar.style.display = '';
            _chatCheckSlowmode();
          }
        }
      } catch (e) {
        console.warn('Chat send error:', e);
        if (e && e.status === 429) showToast('Slow down', e.message);
      } finally {
        _chatSending = false;
      }
    }

    // ── Blocked users ──────────────────────────────────────────────────────────
    var _blockedUsers = new Set();
    async function _chatLoadBlocked() {
      if (!_currentUser) return;
      try {
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/blocked_users?blocker_id=eq.' +
            encodeURIComponent(_currentUser.id) +
            '&select=blocked_id',
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        _blockedUsers = new Set(
          Array.isArray(data)
            ? data.map(function (b) {
                return b.blocked_id;
              })
            : []
        );
      } catch (e) {}
    }
    async function _chatBlockUser(userId, name) {
      if (!confirm('Block ' + name + '? Their messages will be hidden.')) return;
      try {
        await fetch(SUPA_URL + '/rest/v1/blocked_users', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
          body: JSON.stringify({ blocker_id: _currentUser.id, blocked_id: userId })
        });
        _blockedUsers.add(userId);
        document.querySelectorAll('[data-sender-id="' + userId + '"]').forEach(function (el) {
          el.style.display = 'none';
        });
        showToast('User blocked', name + ' has been blocked.');
      } catch (e) {}
    }

    // ── Message deletion ────────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="block"]');
      if (btn) _chatBlockUser(btn.dataset.uid, btn.dataset.name);
    });

    document.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-act="delete"]');
      if (!btn) return;
      // This listener is scoped to chat-room MESSAGE delete buttons, which
      // carry the row id in `data-mid`. The chatbot sidebar also emits
      // `data-act="delete"` (to delete a CHAT, not a message), and that
      // button has no `data-mid` — without this guard, the chatbot's
      // delete click would fall through here and DELETE
      // /rest/v1/messages?id=eq.undefined, surfacing as
      // "Could not delete — Permission denied or server error" (400 22P02).
      var msgId = btn.dataset.mid;
      if (!msgId) return;
      if (!confirm('Delete this message?')) return;
      try {
        var res = await fetch(SUPA_URL + '/rest/v1/messages?id=eq.' + encodeURIComponent(msgId), {
          method: 'DELETE',
          headers: _sbHeaders()
        });
        if (!res.ok) {
          var errBody = await res.text();
          console.warn('Delete failed:', res.status, errBody);
          showToast('Could not delete', 'Permission denied or server error.');
          return;
        }
        var el = document.querySelector('[data-mid="' + msgId + '"]');
        if (el) el.remove();
      } catch (e) {
        console.warn('Delete error:', e);
        showToast('Could not delete', e.message || String(e));
      }
    });

    // ── Pinned messages ─────────────────────────────────────────────────────────
    async function _chatPinMessage(msgId, content, senderName) {
      if (!_currentUser || !_chatRoomId) return;
      try {
        await fetch(SUPA_URL + '/rest/v1/pinned_messages', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), {
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify({
            room_id: _chatRoomId,
            message_id: msgId,
            pinned_by: _currentUser.id
          })
        });
        showToast('Message pinned', '');
        _chatLoadPins();
      } catch (e) {}
    }

    async function _chatLoadPins() {
      if (!_chatRoomId) return;
      var list = document.getElementById('chatPinsList');
      if (!list) return;
      try {
        var res = await fetch(
          SUPA_URL +
            '/rest/v1/pinned_messages?room_id=eq.' +
            encodeURIComponent(_chatRoomId) +
            '&order=pinned_at.desc&select=id,message_id,messages(id,content,display_name)',
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        list.innerHTML = '';
        if (!Array.isArray(data) || !data.length) {
          list.innerHTML =
            '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:8px;font-weight:700">No pinned messages</div>';
          return;
        }
        data.forEach(function (p) {
          var m = p.messages || {};
          var div = document.createElement('div');
          div.style.cssText =
            'padding:10px;border-radius:10px;background:var(--row-bg);margin-bottom:8px';
          div.innerHTML =
            '<div style="font-size:.7rem;font-weight:800;color:rgba(59,130,246,.9);margin-bottom:4px">' +
            _chatEsc(m.display_name || 'User') +
            '</div>' +
            '<div style="font-size:.8rem;color:var(--on-glass);line-height:1.4">' +
            _chatEsc((m.content || '').slice(0, 120)) +
            '</div>' +
            '<button data-pin-id="' +
            p.id +
            '" style="margin-top:6px;background:none;border:none;font-size:.7rem;color:rgba(239,68,68,.6);cursor:pointer;font-family:\'Nunito\',sans-serif;font-weight:700">Unpin</button>';
          div.querySelector('button').addEventListener('click', async function () {
            await fetch(SUPA_URL + '/rest/v1/pinned_messages?id=eq.' + encodeURIComponent(p.id), {
              method: 'DELETE',
              headers: _sbHeaders()
            });
            _chatLoadPins();
          });
          list.appendChild(div);
        });
      } catch (e) {}
    }

    (
      document.getElementById('chatPinsBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var panel = document.getElementById('chatPinsPanel');
      if (!panel) return;
      var showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'flex';
      if (!showing) _chatLoadPins();
    });
    (
      document.getElementById('chatPinsPanelClose') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var panel = document.getElementById('chatPinsPanel');
      if (panel) panel.style.display = 'none';
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="pin"]');
      if (!btn) return;
      _chatPinMessage(btn.dataset.mid, btn.dataset.content, btn.dataset.name);
    });

    // ── Nicknames ────────────────────────────────────────────────────────────────
    var _chatNicknames = {}; // userId -> nickname for current room
    async function _chatLoadNicknames() {
      if (!_chatRoomId || !_currentUser) return;
      try {
        var res = await fetch(
          SUPA_URL + '/rest/v1/room_nicknames?room_id=eq.' + encodeURIComponent(_chatRoomId),
          { headers: _sbHeaders() }
        );
        var data = await res.json();
        _chatNicknames = {};
        if (Array.isArray(data))
          data.forEach(function (n) {
            _chatNicknames[n.user_id] = n.nickname;
          });
      } catch (e) {}
    }

    (
      document.getElementById('chatNicknameBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var modal = document.getElementById('chatNicknameModal');
      var inp = document.getElementById('chatNicknameInput');
      if (!modal) return;
      if (inp) inp.value = _chatNicknames[_currentUser && _currentUser.id] || '';
      modal.style.display = 'flex';
      if (inp) inp.focus();
    });
    (
      document.getElementById('chatNicknameModalClose') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var m = document.getElementById('chatNicknameModal');
      if (m) m.style.display = 'none';
    });

    (
      document.getElementById('chatNicknameSaveBtn') || { addEventListener: function () {} }
    ).addEventListener('click', async function () {
      var inp = document.getElementById('chatNicknameInput');
      var val = inp ? inp.value.trim() : '';
      if (!val || !_currentUser || !_chatRoomId) return;
      try {
        await fetch(SUPA_URL + '/rest/v1/room_nicknames', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), {
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify({ room_id: _chatRoomId, user_id: _currentUser.id, nickname: val })
        });
        _chatNicknames[_currentUser.id] = val;
        var m = document.getElementById('chatNicknameModal');
        if (m) m.style.display = 'none';
        showToast('Nickname set', 'You appear as "' + val + '" in this room.');
      } catch (e) {}
    });
    (
      document.getElementById('chatNicknameClearBtn') || { addEventListener: function () {} }
    ).addEventListener('click', async function () {
      if (!_currentUser || !_chatRoomId) return;
      try {
        await fetch(
          SUPA_URL +
            '/rest/v1/room_nicknames?room_id=eq.' +
            encodeURIComponent(_chatRoomId) +
            '&user_id=eq.' +
            encodeURIComponent(_currentUser.id),
          { method: 'DELETE', headers: _sbHeaders() }
        );
        delete _chatNicknames[_currentUser.id];
        var m = document.getElementById('chatNicknameModal');
        if (m) m.style.display = 'none';
        showToast('Nickname cleared', '');
      } catch (e) {}
    });

    // ── File sharing ─────────────────────────────────────────────────────────────
    var _chatPendingFile = null;
    var _chatSending = false;

    async function _chatPostMessage(payload) {
      var res = await fetch('/api/send-chat-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (_sbToken || '')
        },
        body: JSON.stringify(payload)
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        var err = new Error(data.error || 'Could not send message');
        err.status = res.status;
        throw err;
      }
      return data;
    }

    (
      document.getElementById('chatAttachBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var fi = document.getElementById('chatFileInput');
      if (fi) fi.click();
    });
    (
      document.getElementById('chatFileInput') || { addEventListener: function () {} }
    ).addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      try {
        _chatValidateFile(file);
      } catch (err) {
        showToast('File blocked', file.name + ': ' + err.message);
        e.target.value = '';
        return;
      }
      _chatPendingFile = file;
      var bar = document.getElementById('chatFilePreviewBar');
      var name = document.getElementById('chatFilePreviewName');
      if (bar) bar.style.display = 'flex';
      if (name)
        name.textContent =
          file.name +
          ' (' +
          (file.size > 1048576
            ? (file.size / 1048576).toFixed(1) + 'MB'
            : (file.size / 1024).toFixed(0) + 'KB') +
          ')';
      e.target.value = '';
    });
    (
      document.getElementById('chatFileCancelBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      _chatPendingFile = null;
      var bar = document.getElementById('chatFilePreviewBar');
      if (bar) bar.style.display = 'none';
    });

    // Chat attachments are downloaded by the recipient, not indexed like course
    // uploads — so we don't use the strict course whitelist (which blocks .zip
    // and only allows pdf/txt/docx/images). Allow any file friends want to share
    // (pdf, zip, photos, docs, audio, video…) but still block active/executable
    // content that could run when opened from the signed storage URL.
    function _chatValidateFile(file) {
      if (!file) throw new Error('No file selected');
      var MAX = 25 * 1024 * 1024;
      if (file.size > MAX) throw new Error('File is too large. Max 25 MB.');
      var name = String(file.name || '').toLowerCase();
      var dot = name.lastIndexOf('.');
      var ext = dot >= 0 ? name.slice(dot) : '';
      var blocked = [
        '.html', '.htm', '.js', '.mjs', '.svg', '.exe', '.bat', '.cmd',
        '.sh', '.php', '.ps1', '.vbs', '.msi', '.jar', '.com', '.scr'
      ];
      if (blocked.indexOf(ext) !== -1) throw new Error("This file type can't be shared in chat.");
      return true;
    }

    async function _chatUploadFile(file) {
      _chatValidateFile(file);
      // Long-lived tabs burn through the 1-hour Supabase JWT; refresh it first
      // so the storage write isn't rejected with a 403 surfaced as a generic
      // "Upload failed".
      if (typeof _ufEnsureFreshToken === 'function') {
        try { await _ufEnsureFreshToken(); } catch (e) {}
      }
      var safeName = _chatSafeStoragePart(file.name) || 'attachment';
      var path =
        _chatSafeStoragePart(_chatStorageRoomId(_chatRoomId)) +
        '/' +
        _currentUser.id +
        '/' +
        Date.now() +
        '_' +
        safeName;
      var token = _sbToken || sessionStorage.getItem('sb_sess_token') || SUPA_KEY;
      var res = await fetch(
        SUPA_URL + '/storage/v1/object/chat-attachments/' + _chatEncodeStoragePath(path),
        {
          method: 'POST',
          headers: {
            apikey: SUPA_KEY,
            Authorization: 'Bearer ' + token,
            'x-upsert': 'true',
            'Content-Type': file.type || 'application/octet-stream'
          },
          body: file
        }
      );
      if (!res.ok) {
        // Surface the real reason (status + Supabase message) instead of a
        // generic toast — e.g. a 403 here means the chat-attachments bucket is
        // missing an INSERT policy for authenticated users.
        var detail = '';
        try { detail = (await res.text()) || ''; } catch (e) {}
        var msg = 'HTTP ' + res.status;
        try {
          var j = JSON.parse(detail);
          if (j && (j.message || j.error)) msg += ' — ' + (j.message || j.error);
        } catch (e) {
          if (detail) msg += ' — ' + detail.slice(0, 140);
        }
        throw new Error(msg);
      }
      return { url: path, type: file.type, name: file.name };
    }

    // ── GIF search (Giphy) ────────────────────────────────────────────────────
    var GIPHY_KEY = 'dc6zaTOxFJmzC';
    var _gifSearchSeq = 0;
    (
      document.getElementById('chatGifBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var panel = document.getElementById('chatGifPanel');
      if (!panel) return;
      var showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'block';
      if (!showing) {
        var s = document.getElementById('chatGifSearch');
        if (s) {
          s.value = '';
          s.focus();
        }
        _chatLoadTrendingGifs();
      }
    });

    async function _chatLoadTrendingGifs() {
      var results = document.getElementById('chatGifResults');
      if (!results) return;
      results.innerHTML =
        '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:4px">Loading...</div>';
      try {
        var res = await fetch(
          'https://api.giphy.com/v1/gifs/trending?api_key=' + GIPHY_KEY + '&limit=12&rating=g'
        );
        var data = await res.json();
        _chatRenderGifs(data.data || []);
      } catch (e) {
        results.innerHTML =
          '<div style="font-size:.75rem;color:#ef4444;padding:4px">Could not load GIFs</div>';
      }
    }

    async function _chatSearchGifs(q) {
      var results = document.getElementById('chatGifResults');
      if (!results) return;
      var mySeq = ++_gifSearchSeq;
      results.innerHTML =
        '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:4px">Searching...</div>';
      try {
        var res = await fetch(
          'https://api.giphy.com/v1/gifs/search?api_key=' +
            GIPHY_KEY +
            '&q=' +
            encodeURIComponent(q) +
            '&limit=12&rating=g'
        );
        var data = await res.json();
        if (mySeq !== _gifSearchSeq) return; // newer search supersedes this one
        _chatRenderGifs(data.data || []);
      } catch (e) {}
    }

    function _chatRenderGifs(gifs) {
      var results = document.getElementById('chatGifResults');
      if (!results) return;
      results.innerHTML = '';
      gifs.forEach(function (g) {
        var url = g.images && g.images.fixed_height_small && g.images.fixed_height_small.url;
        var orig = g.images && g.images.original && g.images.original.url;
        if (!url || !orig) return;
        var img = document.createElement('img');
        img.src = url;
        img.style.cssText = 'height:80px;border-radius:6px;cursor:pointer;object-fit:cover';
        img.addEventListener('click', function () {
          document.getElementById('chatGifPanel').style.display = 'none';
          _chatSendGif(orig, g.title || 'GIF');
        });
        results.appendChild(img);
      });
    }

    async function _chatSendGif(gifUrl, title) {
      if (!_currentUser || !_chatRoomId) return;
      var displayName =
        _chatNicknames[_currentUser.id] ||
        (document.getElementById('authName') || {}).textContent ||
        'Student';
      try {
        await _chatPostMessage({
          room_id: _chatRoomId,
          user_id: _currentUser.id,
          display_name: displayName,
          content: '',
          attachment_url: gifUrl,
          attachment_type: 'image/gif',
          attachment_name: title
        });
        await _chatLoad(false);
      } catch (e) {
        if (e && e.status === 429) showToast('Slow down', e.message);
      }
    }

    var _gifSearchTimer = null;
    (
      document.getElementById('chatGifSearch') || { addEventListener: function () {} }
    ).addEventListener('input', function () {
      var val = this.value.trim();
      clearTimeout(_gifSearchTimer);
      _gifSearchTimer = setTimeout(function () {
        val ? _chatSearchGifs(val) : _chatLoadTrendingGifs();
      }, 400);
    });

    // ── Message search ────────────────────────────────────────────────────────────
    (
      document.getElementById('chatSearchToggleBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var bar = document.getElementById('chatSearchBar');
      if (!bar) return;
      var showing = bar.style.display !== 'none';
      bar.style.display = showing ? 'none' : 'flex';
      bar.style.flexDirection = 'column';
      if (!showing) {
        var inp = document.getElementById('chatSearchInput');
        if (inp) inp.focus();
      }
    });

    var _searchTimer = null;
    (
      document.getElementById('chatSearchInput') || { addEventListener: function () {} }
    ).addEventListener('input', function () {
      clearTimeout(_searchTimer);
      var val = this.value.trim();
      _searchTimer = setTimeout(function () {
        if (val.length >= 2) _chatSearch(val);
      }, 400);
    });

    async function _chatSearch(query) {
      var results = document.getElementById('chatSearchResults');
      if (!results || !_chatRoomId) return;
      results.innerHTML =
        '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:4px">Searching...</div>';

      // Parse filters: from:name has:link
      var fromFilter = (query.match(/from:(\S+)/) || [])[1];
      var hasLink = /has:link/.test(query);
      var cleanQ = query
        .replace(/from:\S+/g, '')
        .replace(/has:\S+/g, '')
        .trim();

      var url =
        SUPA_URL +
        '/rest/v1/messages?room_id=eq.' +
        encodeURIComponent(_chatRoomId) +
        '&order=created_at.desc&limit=20';
      if (cleanQ) url += '&content=ilike.*' + encodeURIComponent(cleanQ) + '*';
      if (fromFilter) url += '&display_name=ilike.*' + encodeURIComponent(fromFilter) + '*';

      try {
        var res = await fetch(url, { headers: _sbHeaders() });
        var data = await res.json();
        if (hasLink)
          data = (data || []).filter(function (m) {
            return /https?:\/\//.test(m.content);
          });
        results.innerHTML = '';
        if (!Array.isArray(data) || !data.length) {
          results.innerHTML =
            '<div style="font-size:.75rem;color:var(--on-glass-faint);padding:4px;font-weight:700">No results</div>';
          return;
        }
        data.forEach(function (m) {
          var d = document.createElement('div');
          d.style.cssText =
            'padding:7px 10px;border-radius:8px;background:var(--row-bg);cursor:pointer';
          d.innerHTML =
            '<div style="font-size:.68rem;font-weight:800;color:rgba(59,130,246,.8)">' +
            _chatEsc(m.display_name || 'User') +
            ' · ' +
            new Date(m.created_at).toLocaleDateString() +
            '</div>' +
            '<div style="font-size:.8rem;color:var(--on-glass);margin-top:2px">' +
            _chatEsc((m.content || '').slice(0, 100)) +
            '</div>';
          results.appendChild(d);
        });
      } catch (e) {}
    }

    // ── Add Friend modal ───────────────────────────────────────────────────────
    (function () {
      var modal = document.getElementById('chatFriendModal');
      var openBtn = document.getElementById('chatAddFriendBtn');
      var closeBtn = document.getElementById('chatFriendModalClose');
      var searchInp = document.getElementById('chatFriendSearchInput');
      var results = document.getElementById('chatFriendResults');
      if (!modal || !openBtn) return;

      openBtn.addEventListener('click', function () {
        modal.classList.add('open');
        if (searchInp) {
          searchInp.value = '';
          searchInp.focus();
        }
        if (results)
          results.innerHTML =
            '<div class="chat-friend-hint">Type a name to search for students</div>';
      });
      if (closeBtn)
        closeBtn.addEventListener('click', function () {
          modal.classList.remove('open');
        });
      modal.addEventListener('click', function (e) {
        if (e.target === modal) modal.classList.remove('open');
      });

      var _searchTimer = null;
      if (searchInp) {
        searchInp.addEventListener('input', function () {
          clearTimeout(_searchTimer);
          var q = searchInp.value.trim();
          if (!q) {
            results.innerHTML =
              '<div class="chat-friend-hint">Type a name to search for students</div>';
            return;
          }
          _searchTimer = setTimeout(function () {
            _chatDoSearch(q, results);
          }, 350);
        });
      }
    })();

    async function _chatDoSearch(q, resultsEl) {
      if (!resultsEl) return;
      resultsEl.innerHTML = '<div class="chat-friend-hint">Searching&#x2026;</div>';
      try {
        var res = await fetch('/api/chat-user-search?q=' + encodeURIComponent(q), {
          headers: { Authorization: 'Bearer ' + (_sbToken || '') }
        });
        var payload = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) throw new Error((payload.error && payload.error.message) || 'Search failed');
        var filtered = Array.isArray(payload.users) ? payload.users : [];
        if (!filtered.length) {
          resultsEl.innerHTML = '<div class="chat-friend-hint">No students found</div>';
          return;
        }

        resultsEl.innerHTML = '';
        filtered.forEach(function (p) {
          var existing = _chatFriends.find(function (f) {
            return f.otherId === p.id;
          });
          var initial = (p.full_name || '?').charAt(0).toUpperCase();
          var row = document.createElement('div');
          row.className = 'chat-friend-result-row';
          var btnHtml;
          if (existing && existing.status === 'accepted') {
            btnHtml = '<button class="chat-friend-req-btn" disabled>Friends &#x2713;</button>';
          } else if (existing && existing.isSender) {
            btnHtml = '<button class="chat-friend-req-btn" disabled>Pending&#x2026;</button>';
          } else if (existing && !existing.isSender) {
            btnHtml =
              '<button class="chat-friend-req-btn" data-fid="' +
              _chatEsc(existing.id) +
              '" data-action="accept">Accept</button>';
          } else {
            btnHtml =
              '<button class="chat-friend-req-btn" data-uid="' +
              _chatEsc(p.id) +
              '" data-action="add">Add Friend</button>';
          }
          row.innerHTML =
            '<div class="chat-friend-result-avatar">' +
            _chatEsc(initial) +
            '</div>' +
            '<div class="chat-friend-result-info"><div class="chat-friend-result-name">' +
            _chatEsc(p.full_name || 'Student') +
            '</div>' +
            '<div class="chat-friend-result-prog">' +
            _chatEsc((p.chat_username ? '@' + p.chat_username + ' - ' : '') + (p.programme || '')) +
            '</div></div>' +
            btnHtml;

          var btn = row.querySelector('button[data-action]');
          if (btn) {
            btn.addEventListener('click', async function () {
              btn.disabled = true;
              if (btn.dataset.action === 'add') {
                await _chatSendFriendReq(btn.dataset.uid);
                btn.textContent = 'Pending\u2026';
              } else if (btn.dataset.action === 'accept') {
                await _chatAcceptFriend(btn.dataset.fid);
                btn.textContent = 'Friends \u2713';
              }
            });
          }
          resultsEl.appendChild(row);
        });
      } catch (e) {
        resultsEl.innerHTML = '<div class="chat-friend-hint">Search failed</div>';
      }
    }

    async function _chatSendFriendReq(friendId) {
      if (!_currentUser) return;
      try {
        await fetch(SUPA_URL + '/rest/v1/friendships', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
          body: JSON.stringify({ user_id: _currentUser.id, friend_id: friendId, status: 'pending' })
        });
        await _chatLoadFriends();
        _chatRenderRooms();
      } catch (e) {
        console.warn('Send friend req error:', e);
      }
    }

    // ── Username setup modal ───────────────────────────────────────────────────
    function _chatShowUsernameModal() {
      var modal = document.getElementById('chatUsernameModal');
      if (modal) {
        modal.style.display = 'flex';
      }
    }

    function _chatHideUsernameModal() {
      var modal = document.getElementById('chatUsernameModal');
      if (modal) {
        modal.style.display = 'none';
      }
    }

    async function _chatSaveUsername() {
      var inp = document.getElementById('chatUsernameInput');
      var err = document.getElementById('chatUsernameErr');
      var btn = document.getElementById('chatUsernameSaveBtn');
      if (!inp) return;
      var val = inp.value.trim().replace(/\s+/g, '_').toLowerCase();
      if (!val || val.length < 3) {
        if (err) {
          err.textContent = 'Username must be at least 3 characters.';
          err.style.display = 'block';
        }
        return;
      }
      if (!/^[a-z0-9_]+$/.test(val)) {
        if (err) {
          err.textContent = 'Only letters, numbers, and underscores allowed.';
          err.style.display = 'block';
        }
        return;
      }
      if (err) err.style.display = 'none';
      if (btn) btn.disabled = true;
      try {
        // Check uniqueness
        var chk = await fetch('/api/chat-username-check?username=' + encodeURIComponent(val), {
          headers: { Authorization: 'Bearer ' + (_sbToken || '') }
        });
        var chkData = await chk.json().catch(function () {
          return {};
        });
        if (!chk.ok)
          throw new Error((chkData.error && chkData.error.message) || 'Username check failed');
        if (!chkData.available) {
          if (err) {
            err.textContent = 'That username is already taken.';
            err.style.display = 'block';
          }
          if (btn) btn.disabled = false;
          return;
        }
        await fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(_currentUser.id), {
          method: 'PATCH',
          headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
          body: JSON.stringify({ chat_username: val })
        });
        _chatUsername = val;
        window._chatUsername = val;
        _chatHideUsernameModal();
        _chatRenderRooms();
        _chatLoadFriends().then(function () {
          _chatRenderRooms();
        });
        _chatLoadCustomRooms();
        if (!_chatRoomId) _chatOpenRoom('general', '# General');
      } catch (e) {
        if (err) {
          err.textContent = 'Something went wrong. Try again.';
          err.style.display = 'block';
        }
      }
      if (btn) btn.disabled = false;
    }

    (function () {
      document.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'chatUsernameSaveBtn') _chatSaveUsername();
      });
      document.addEventListener('keydown', function (e) {
        var modal = document.getElementById('chatUsernameModal');
        if (modal && modal.style.display === 'flex' && e.key === 'Enter') _chatSaveUsername();
      });
    })();

    // ── Invite link handler ────────────────────────────────────────────────────
    (function () {
      var joinCode = new URLSearchParams(location.search).get('join');
      if (!joinCode) return;
      // Remove param from URL without reload
      var url = new URL(location.href);
      url.searchParams.delete('join');
      history.replaceState({}, '', url.toString());
      // Wait for user session then join the room
      function _tryJoinRoom() {
        if (!_currentUser) {
          setTimeout(_tryJoinRoom, 500);
          return;
        }
        fetch('/api/join-room-by-code', {
          method: 'POST',
          headers: _sbHeaders(),
          body: JSON.stringify({ code: joinCode })
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (!data || !data.room) {
              showToast('Invalid invite link', 'This invite link is not valid.');
              return;
            }
            var room = data.room;
            showToast('Joined ' + room.name, 'You can now access this room in Chat.');
            _chatLoadCustomRooms();
          })
          .catch(function (e) {
            console.warn('Join room error:', e);
          });
      }
      _tryJoinRoom();
    })();

    // ── Init ───────────────────────────────────────────────────────────────────
    function _chatInit() {
      if (!_chatUsername) {
        // Fetch fresh from DB to be sure (profile may not have loaded yet)
        if (_currentUser) {
          fetch(
            SUPA_URL +
              '/rest/v1/profiles?id=eq.' +
              encodeURIComponent(_currentUser.id) +
              '&select=chat_username',
            { headers: _sbHeaders() }
          )
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              if (Array.isArray(d) && d[0] && d[0].chat_username) {
                _chatUsername = d[0].chat_username;
                window._chatUsername = _chatUsername;
                _chatRenderRooms();
                _chatLoadFriends().then(function () {
                  _chatRenderRooms();
                });
                _chatLoadCustomRooms();
                if (!_chatRoomId) _chatOpenRoom('general', '# General');
              } else {
                _chatShowUsernameModal();
              }
            })
            .catch(function () {
              _chatShowUsernameModal();
            });
        }
      } else {
        _chatRenderRooms();
        _chatLoadFriends().then(function () {
          _chatRenderRooms();
        });
        _chatLoadCustomRooms();
        if (!_chatRoomId) _chatOpenRoom('general', '# General');
      }

      // Refresh presence every 90 s so online/offline status stays current
      clearInterval(window._presencePollTimer);
      window._presencePollTimer = setInterval(function () {
        _chatLoadFriends().then(function () {
          _chatRenderMembers();
        });
      }, 90000);
    }
    window._chatInit = _chatInit;

    // Chat input wiring
    (function () {
      var inp = document.getElementById('chatInput');
      var btn = document.getElementById('chatSendBtn');
      if (!inp || !btn) return;
      btn.addEventListener('click', _chatSend);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _chatSend();
        }
      });
    })();

    // Stop polling when leaving chat section. Both pollers must be cleared:
    // the 3s message poll (_chatPollTimer) AND the 90s presence poll
    // (window._presencePollTimer). The presence poll used to be left running,
    // so it kept hitting the network/DB every 90s forever on every other page.
    // _chatInit() re-creates both on re-entry, so clearing here is safe.
    var _origShowPortalSectionForChat = window.showPortalSection;
    window.showPortalSection = function (sec) {
      if (sec !== 'chat') {
        if (_chatPollTimer) {
          clearInterval(_chatPollTimer);
          _chatPollTimer = null;
        }
        if (window._presencePollTimer) {
          clearInterval(window._presencePollTimer);
          window._presencePollTimer = null;
        }
      }
      if (typeof _origShowPortalSectionForChat === 'function') _origShowPortalSectionForChat(sec);
    };

    // First-click init. This script is lazy-loaded, and the router's
    // _ssAfterFeature('chat', …) callback that calls window._chatInit fires on
    // script load — which is BEFORE this async fetch resolves and _chatInit
    // exists, so the first click used to leave the panel blank until a second
    // click. If the user is already on the Chat section now (the section is
    // visible), initialise immediately. When chat.js is merely prewarmed in the
    // background the section is hidden, so we skip and let the navigation call.
    var _chatSec = document.getElementById('psec-chat');
    if (_chatSec && _chatSec.style.display !== 'none') _chatInit();
  } // end _init
})();
