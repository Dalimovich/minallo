(function () {
  var feature = {
    sectionId: 'psec-settings',
    html: 'views/settings/settings.html',
    css: 'views/settings/settings.css'
  };
  if (window.Minallo) {
    window.Minallo.registerFeature('settings', feature);
  } else {
    window.MinalloFeatures = window.MinalloFeatures || {};
    window.MinalloFeatures.settings = feature;
  }

  var section = document.getElementById('psec-settings');
  if (section) section.dataset.feature = 'settings';

  // This file runs right after settings.html is injected. The YouTube playlist
  // UI is owned by music-services.js, which renders into #ytPlaylistList — but
  // it may have initialised before this HTML existed, so populate the list now.
  // (Click handling is document-delegated there, so it works regardless.)
  if (typeof window._ytRenderList === 'function') window._ytRenderList();
})();

var _autoOpenEnabled = true;
var _saveChatEnabled = true;
window._autoOpenEnabled = _autoOpenEnabled;
window._saveChatEnabled = _saveChatEnabled;

function applyRuntimeSettings(settings) {
  settings = settings || {};
  if (typeof settings.auto_open_ai === 'boolean') {
    _autoOpenEnabled = settings.auto_open_ai;
    window._autoOpenEnabled = _autoOpenEnabled;
    var autoOpen = document.getElementById('settingsAutoOpen');
    if (autoOpen) autoOpen.checked = _autoOpenEnabled;
  }
  if (typeof settings.save_chat_history === 'boolean') {
    _saveChatEnabled = settings.save_chat_history;
    window._saveChatEnabled = _saveChatEnabled;
    var saveChat = document.getElementById('settingsSaveChat');
    if (saveChat) saveChat.checked = _saveChatEnabled;
  }
}
window.addEventListener('ss-settings-applied', function (event) {
  applyRuntimeSettings(event.detail);
});

async function saveSettings(patch) {
  if (!_currentUser) return;
  var data = Object.assign({ id: _currentUser.id, updated_at: new Date().toISOString() }, patch);
  var result = await _sb.from('settings').upsert(data);
  if (result && result.error && Object.prototype.hasOwnProperty.call(data, 'dark_mode')) {
    var fallback = Object.assign({}, data);
    delete fallback.dark_mode;
    result = await _sb.from('settings').upsert(fallback);
  }
  if (result && result.error) console.error('saveSettings error:', result.error);
}

// Named (not an IIFE) so it can be re-run when the lazy settings HTML mounts —
// otherwise the controls + Save button never bind (the elements don't exist at
// script-eval time). All bindings here are idempotent set-operations, so the
// extra run is harmless. See the calls at the bottom of this block.
function bindSettingsControls() {
  function _markDirty() {
    var el = document.getElementById('settingsSaveState');
    if (el) { el.textContent = _t('set_unsaved'); el.className = 'settings-save-state dirty'; }
  }

  var settingsLanguage = document.getElementById('settingsLanguage');

  var feedbackForm = document.getElementById('feedbackForm');
  if (feedbackForm && !feedbackForm.dataset.bound) {
    feedbackForm.dataset.bound = '1';
    feedbackForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var typeEl = document.getElementById('feedbackType');
      var messageEl = document.getElementById('feedbackMessage');
      var statusEl = document.getElementById('feedbackStatus');
      var submitEl = document.getElementById('feedbackSubmit');
      var message = messageEl ? messageEl.value.trim() : '';
      if (message.length < 10) {
        statusEl.textContent = 'Please write at least 10 characters.';
        statusEl.className = 'feedback-status error';
        return;
      }
      submitEl.disabled = true;
      submitEl.textContent = 'Sending…';
      statusEl.textContent = '';
      try {
        var response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (window._sbToken || '') },
          body: JSON.stringify({ type: typeEl.value, message: message, pageUrl: window.location.href })
        });
        if (!response.ok) {
          var errorBody = await response.json().catch(function () { return null; });
          var serverMessage = errorBody && errorBody.error &&
            (typeof errorBody.error === 'string' ? errorBody.error : errorBody.error.message);
          throw new Error(serverMessage || 'Could not send your message. Please try again.');
        }
        messageEl.value = '';
        statusEl.textContent = 'Thank you — your message was sent.';
        statusEl.className = 'feedback-status success';
      } catch (error) {
        statusEl.textContent = error && error.message ? error.message : 'Could not send your message.';
        statusEl.className = 'feedback-status error';
      } finally {
        submitEl.disabled = false;
        submitEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg><span>Send feedback</span>';
      }
    });
  }
  if (settingsLanguage) {
    settingsLanguage.value = window._lang || localStorage.getItem('ss_lang') || 'en';
    settingsLanguage.addEventListener('change', function () {
      if (typeof window.applyLanguage === 'function') window.applyLanguage(this.value);
      _markDirty();
    });
  }

  if (typeof window.applyLanguage === 'function')
    window.applyLanguage(window._lang || localStorage.getItem('ss_lang') || 'en');

  var dmToggle = document.getElementById('settingsDarkMode');
  if (dmToggle) {
    dmToggle.checked =
      typeof window.nightOn !== 'undefined'
        ? window.nightOn
        : typeof nightOn !== 'undefined'
          ? !!nightOn
          : true;
    dmToggle.addEventListener('change', function () {
      if (typeof window._applyTheme === 'function') window._applyTheme(this.checked, this);
      else if (typeof _applyTheme === 'function') _applyTheme(this.checked, this);
      _markDirty();
    });
    var nightBtn = document.getElementById('nightBtn');
    if (nightBtn) {
      nightBtn.addEventListener('click', function () {
        setTimeout(function () {
          if (dmToggle)
            dmToggle.checked =
              typeof window.nightOn !== 'undefined'
                ? window.nightOn
                : typeof nightOn !== 'undefined'
                  ? !!nightOn
                  : true;
        }, 650);
      });
    }
  }

  var settingsAutoOpen = document.getElementById('settingsAutoOpen');
  if (settingsAutoOpen) {
    if (typeof window._autoOpenEnabled === 'boolean') settingsAutoOpen.checked = window._autoOpenEnabled;
    settingsAutoOpen.addEventListener('change', function () {
      _autoOpenEnabled = this.checked;
      window._autoOpenEnabled = _autoOpenEnabled;
      _markDirty();
    });
  }

  var pdfBody = document.getElementById('pdfBody');
  if (pdfBody) {
    pdfBody.addEventListener('mouseup', function () {
      if (!window._autoOpenEnabled) {
        setTimeout(function () {
          var banner =
            document.getElementById('aiMsgs') &&
            document.getElementById('aiMsgs').querySelector('.ai-sel-banner');
          if (banner) banner.remove();
          var _pinned = window._aiPanelBridge && typeof window._aiPanelBridge.getAiPinned === 'function'
            ? window._aiPanelBridge.getAiPinned() : false;
          if (!_pinned) forceCloseAI();
        }, 50);
      }
    });
  }

  var settingsSaveChat = document.getElementById('settingsSaveChat');
  if (settingsSaveChat) {
    if (typeof window._saveChatEnabled === 'boolean') settingsSaveChat.checked = window._saveChatEnabled;
    settingsSaveChat.addEventListener('change', function () {
      _saveChatEnabled = this.checked;
      window._saveChatEnabled = _saveChatEnabled;
      _markDirty();
    });
  }

  var _origDeferredSave = window.deferredSave;
  window.deferredSave = function () {
    if (window._saveChatEnabled && typeof _origDeferredSave === 'function') _origDeferredSave();
  };

  function _ssUnloadSave() {
    if (typeof window._ssPreUnloadHook === 'function') window._ssPreUnloadHook();
    saveState();
  }
  window.addEventListener('beforeunload', _ssUnloadSave);
  window.addEventListener('pagehide', _ssUnloadSave);

  var dangerBtn = document.getElementById('clearChatHistoryBtn');
  if (dangerBtn) {
    dangerBtn.addEventListener('click', function () {
      if (!confirm(_t('settings_clear_confirm'))) return;
      // Clear ALL chat stores: the legacy per-PDF history (ss_chat_*), the
      // standalone chatbot (ss_ncb_*), AND the course document-rail Q&A
      // (ss_course_qa_*). The rail keys were missed before, so "Ask this
      // document" conversations survived a clear — the reported bug.
      Object.keys(localStorage)
        .filter(function (k) {
          return (
            k.indexOf('ss_chat_') === 0 ||
            k.indexOf('ss_ncb_') === 0 ||
            k.indexOf('ss_course_qa_') === 0
          );
        })
        .forEach(function (k) {
          localStorage.removeItem(k);
        });
      if (typeof aiMsgs !== 'undefined') aiMsgs.innerHTML = '';
      // The rail also syncs every turn to the chat_history table and restores
      // from it first (restoreCourseHistory) — without this server-side delete
      // the "cleared" chat comes straight back from Supabase after the reload.
      var serverDelete = Promise.resolve();
      try {
        var supaUrl = window._SUPA || '';
        var tok = window._sbToken || '';
        var uid =
          (window._currentUser && (window._currentUser.id || window._currentUser.sub)) || '';
        if (supaUrl && tok && uid) {
          serverDelete = fetch(
            supaUrl + '/rest/v1/chat_history?user_id=eq.' + encodeURIComponent(uid),
            {
              method: 'DELETE',
              headers: {
                apikey: window._SAKEY || '',
                Authorization: 'Bearer ' + tok,
                Prefer: 'return=minimal',
              },
            }
          ).catch(function () {});
        }
      } catch (e) { /* best-effort — local stores are already cleared */ }
      showToast(_t('toast_chat_cleared'), _t('toast_chat_cleared_sub'));
      // The chatbot caches its conversations in memory after first load, so a
      // storage wipe alone won't update an already-open chatbot. Reload once
      // the server delete finishes (capped at 2.5s) — reloading earlier could
      // race the DELETE and let the rail restore the rows mid-flight.
      var minToastTime = new Promise(function (r) { setTimeout(r, 700); });
      var deleteCap = new Promise(function (r) { setTimeout(r, 2500); });
      Promise.all([minToastTime, Promise.race([serverDelete, deleteCap])]).then(function () {
        location.reload();
      });
    });
  }

  var saveSettingsBtn = document.getElementById('saveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async function () {
      var btn = this;
      var stateEl = document.getElementById('settingsSaveState');
      btn.disabled = true;
      if (stateEl) { stateEl.textContent = _t('set_saving'); stateEl.className = 'settings-save-state dirty'; }
      var lang =
        (document.getElementById('settingsLanguage') || {}).value ||
        window._lang ||
        localStorage.getItem('ss_lang') ||
        'en';
      var autoOpen = !!(document.getElementById('settingsAutoOpen') || {}).checked;
      var saveChat = !!(document.getElementById('settingsSaveChat') || {}).checked;
      var darkMode = !!(document.getElementById('settingsDarkMode') || {}).checked;
      if (!saveChat) {
        Object.keys(localStorage)
          .filter(function (k) {
            return k.startsWith('ss_chat_');
          })
          .forEach(function (k) {
            localStorage.removeItem(k);
          });
      }
      try {
        await saveSettings({
          language: lang,
          auto_open_ai: autoOpen,
          save_chat_history: saveChat,
          dark_mode: darkMode
        });
        showToast(_t('toast_settings_saved'), _t('toast_settings_saved_sub'));
        if (stateEl) { stateEl.textContent = _t('set_saved'); stateEl.className = 'settings-save-state saved'; }
        setTimeout(function () {
          btn.disabled = false;
          var el = document.getElementById('settingsSaveState');
          if (el) { el.textContent = ''; el.className = 'settings-save-state'; }
        }, 1500);
      } catch (err) {
        console.error('saveSettings click error:', err);
        btn.disabled = false;
        if (stateEl) { stateEl.textContent = _t('set_save_failed'); stateEl.className = 'settings-save-state error'; }
      }
    });
  }

  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function () {
      // Defer to supabase.js — it clears sb_sess_*, profile_cache_<uid>,
      // ss_last_uid, the onboarding keys (ss_user_type, ss_major,
      // ss_vertiefung, and the per-uid variants), the trial-device marker,
      // and revokes the token server-side. Don't re-implement any of that
      // here; this used to drift out of sync.
      try {
        if (window._sb && window._sb.auth) await window._sb.auth.signOut();
      } catch (e) { /* network failure is fine — local state is already wiped */ }
      window._userType = 'enrolled';
      window._germanTest = '';
      window._germanLevel = '';
      window.location.reload();
    });
  }

  var deleteAccountBtn = document.getElementById('deleteAccountBtn');
  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', function () {
      var modal = document.createElement('div');
      modal.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:rgba(10,8,18,.88);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center';
      modal.innerHTML =
        '<div style="background:linear-gradient(135deg,#110d20,#0d0f1e);border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:36px 32px;width:380px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:16px;text-align:center">' +
        '<div style="font-size:2rem">!</div>' +
        '<div style="font-family:\'Fredoka One\',cursive;font-size:1.3rem;color:#f87171">' + _t('settings_delete_modal_title') + '</div>' +
        '<div style="font-size:.82rem;color:rgba(255,255,255,.5);font-weight:700;line-height:1.6">' + _t('settings_delete_modal_desc') + '</div>' +
        '<div style="display:flex;gap:10px;margin-top:4px">' +
        '<button id="delAccCancel" style="flex:1;padding:12px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:rgba(255,255,255,.7);cursor:pointer">' + _t('settings_delete_modal_cancel') + '</button>' +
        '<button id="delAccConfirm" style="flex:1;padding:12px;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:#f87171;cursor:pointer">' + _t('settings_delete_modal_confirm') + '</button>' +
        '</div></div>';
      document.body.appendChild(modal);

      document.getElementById('delAccCancel').addEventListener('click', function () {
        document.body.removeChild(modal);
      });

      document.getElementById('delAccConfirm').addEventListener('click', async function () {
        var btn = this;
        btn.textContent = _t('set_deleting');
        btn.disabled = true;
        var token = _sbToken || sessionStorage.getItem('sb_sess_token');
        var uid = _currentUser && _currentUser.id;
        var h = {
          apikey: SUPA_KEY,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        };
        if (uid) {
          var tables = [
            { name: 'lecture_notes', col: 'user_id' },
            { name: 'settings', col: 'id' },
            { name: 'subscriptions', col: 'user_id' },
            { name: 'room_members', col: 'user_id' },
            { name: 'friendships', col: 'user_id' },
            { name: 'friendships', col: 'friend_id' },
            { name: 'profiles', col: 'id' }
          ];
          for (var i = 0; i < tables.length; i++) {
            try {
              await fetch(
                SUPA_URL +
                  '/rest/v1/' +
                  tables[i].name +
                  '?' +
                  tables[i].col +
                  '=eq.' +
                  encodeURIComponent(uid),
                { method: 'DELETE', headers: h }
              );
            } catch (e) {}
          }
        }
        // Auth-user deletion must succeed before we wipe local state and
        // reload — otherwise the user signs back in to a still-alive account
        // (FK constraints to auth.users without ON DELETE CASCADE cause the
        // Supabase Auth Admin API to return a 500 here; surface it instead of
        // silently pretending the account was deleted).
        var deleteOk = false;
        var delStatus = 0;
        try {
          var delRes = await fetch('/api/admin-users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ action: 'deleteself', token: token })
          });
          deleteOk = delRes.ok;
          delStatus = delRes.status;
        } catch (e) { deleteOk = false; }
        // 401 = the session's user no longer exists (e.g. deleted from the
        // dashboard) or the token is dead. Sitting in a ghost session keeps
        // every background sync failing (study_lounge_stats 409s on the FK,
        // deleteself can never succeed) — treat it as "already gone": wipe
        // local state and reload to the login screen.
        if (delStatus === 401) {
          try { if (window._sb && window._sb.auth) await window._sb.auth.signOut(); } catch (e) {}
          localStorage.clear();
          sessionStorage.clear();
          window.location.reload();
          return;
        }
        if (!deleteOk) {
          btn.textContent = _t('set_yes_delete');
          btn.disabled = false;
          showToast(_t('settings_delete_failed'), _t('settings_delete_failed_sub'));
          return;
        }
        try { if (window._sb && window._sb.auth) await window._sb.auth.signOut(); } catch (e) {}
        localStorage.clear();
        sessionStorage.clear();
        document.body.removeChild(modal);
        showToast(_t('settings_account_deleted'), _t('settings_account_deleted_sub'));
        setTimeout(function () {
          window.location.reload();
        }, 1800);
      });
    });
  }
}
bindSettingsControls();
if (window.Minallo && typeof window.Minallo.on === 'function') {
  window.Minallo.on('feature:html-loaded', function (p) {
    if (p && p.id === 'psec-settings') bindSettingsControls();
  });
}
