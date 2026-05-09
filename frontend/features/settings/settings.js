(function () {
  var feature = {
    sectionId: 'psec-settings',
    html: 'features/settings/settings.html',
    css: 'features/settings/settings.css'
  };
  if (window.StudySphere) {
    window.StudySphere.registerFeature('settings', feature);
  } else {
    window.StudySphereFeatures = window.StudySphereFeatures || {};
    window.StudySphereFeatures.settings = feature;
  }

  var section = document.getElementById('psec-settings');
  if (section) section.dataset.feature = 'settings';
})();

var _autoOpenEnabled = true;
var _saveChatEnabled = true;

async function saveSettings(patch) {
  if (!_currentUser) return;
  var data = Object.assign({ id: _currentUser.id, updated_at: new Date().toISOString() }, patch);
  var result = await _sb.from('settings').upsert(data);
  if (result && result.error) console.error('saveSettings error:', result.error);
}

(function bindSettingsControls() {
  var settingsLanguage = document.getElementById('settingsLanguage');
  if (settingsLanguage) {
    settingsLanguage.value = window._lang || localStorage.getItem('ss_lang') || 'en';
    settingsLanguage.addEventListener('change', function () {
      if (typeof window.applyLanguage === 'function') window.applyLanguage(this.value);
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
      _applyTheme(this.checked, this);
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
    settingsAutoOpen.addEventListener('change', function () {
      _autoOpenEnabled = this.checked;
    });
  }

  var pdfBody = document.getElementById('pdfBody');
  if (pdfBody) {
    pdfBody.addEventListener('mouseup', function () {
      if (!_autoOpenEnabled) {
        setTimeout(function () {
          var banner =
            document.getElementById('aiMsgs') &&
            document.getElementById('aiMsgs').querySelector('.ai-sel-banner');
          if (banner) banner.remove();
          if (!aiPinned) forceCloseAI();
        }, 50);
      }
    });
  }

  var settingsSaveChat = document.getElementById('settingsSaveChat');
  if (settingsSaveChat) {
    settingsSaveChat.addEventListener('change', function () {
      _saveChatEnabled = this.checked;
    });
  }

  var _origDeferredSave = window.deferredSave;
  window.deferredSave = function () {
    if (_saveChatEnabled && typeof _origDeferredSave === 'function') _origDeferredSave();
  };

  function _ssUnloadSave() {
    if (typeof window._ssPreUnloadHook === 'function') window._ssPreUnloadHook();
    saveState();
  }
  window.addEventListener('beforeunload', _ssUnloadSave);
  window.addEventListener('pagehide', _ssUnloadSave);

  var dangerBtn = document.querySelector('.settings-danger-btn');
  if (dangerBtn) {
    dangerBtn.addEventListener('click', function () {
      Object.keys(localStorage)
        .filter(function (k) {
          return k.startsWith('ss_chat_');
        })
        .forEach(function (k) {
          localStorage.removeItem(k);
        });
      if (typeof aiMsgs !== 'undefined') aiMsgs.innerHTML = '';
      showToast(_t('toast_chat_cleared'), _t('toast_chat_cleared_sub'));
    });
  }

  var saveSettingsBtn = document.getElementById('saveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async function () {
      var lang =
        (document.getElementById('settingsLanguage') || {}).value ||
        window._lang ||
        localStorage.getItem('ss_lang') ||
        'en';
      var autoOpen = !!(document.getElementById('settingsAutoOpen') || {}).checked;
      var saveChat = !!(document.getElementById('settingsSaveChat') || {}).checked;
      if (!saveChat) {
        Object.keys(localStorage)
          .filter(function (k) {
            return k.startsWith('ss_chat_');
          })
          .forEach(function (k) {
            localStorage.removeItem(k);
          });
      }
      await saveSettings({ language: lang, auto_open_ai: autoOpen, save_chat_history: saveChat });
      showToast(_t('toast_settings_saved'), _t('toast_settings_saved_sub'));
    });
  }

  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      localStorage.removeItem('sb_token');
      localStorage.removeItem('sb_refresh');
      localStorage.removeItem('ss_user_type');
      sessionStorage.removeItem('sb_sess_token');
      sessionStorage.removeItem('ss_last_active');
      sessionStorage.removeItem('ss_logged_in');
      window._userType = 'enrolled';
      window._germanTest = '';
      window._germanLevel = '';
      _applyUserTypeUI();
      _sbToken = null;
      _currentUser = null;
      var portal = document.getElementById('portal');
      if (portal) {
        portal.classList.remove('show');
        portal.style.display = 'none';
      }
      var ai = document.getElementById('authIndicator');
      if (ai) ai.style.display = 'none';
      if (typeof _setAuthMode === 'function') _setAuthMode('signin');
      var emailEl = document.getElementById('authEmail');
      var pwEl = document.getElementById('authPassword');
      if (emailEl) emailEl.value = '';
      if (pwEl) pwEl.value = '';
      var authModal = document.getElementById('authModal');
      if (authModal) authModal.style.display = 'flex';
      showToast(_t('toast_signed_out'), _t('toast_signed_out_sub'));
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
        '<div style="font-family:\'Fredoka One\',cursive;font-size:1.3rem;color:#f87171">Delete your account?</div>' +
        '<div style="font-size:.82rem;color:rgba(255,255,255,.5);font-weight:700;line-height:1.6">This will permanently delete your account and all associated data including notes, settings, and chat history. <strong style="color:rgba(239,68,68,.8)">This cannot be undone.</strong></div>' +
        '<div style="display:flex;gap:10px;margin-top:4px">' +
        '<button id="delAccCancel" style="flex:1;padding:12px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:rgba(255,255,255,.7);cursor:pointer">Cancel</button>' +
        '<button id="delAccConfirm" style="flex:1;padding:12px;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:#f87171;cursor:pointer">Yes, delete</button>' +
        '</div></div>';
      document.body.appendChild(modal);

      document.getElementById('delAccCancel').addEventListener('click', function () {
        document.body.removeChild(modal);
      });

      document.getElementById('delAccConfirm').addEventListener('click', async function () {
        var btn = this;
        btn.textContent = 'Deleting...';
        btn.disabled = true;
        var token = _sbToken || localStorage.getItem('sb_token');
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
        try {
          await fetch('/api/admin-users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ action: 'deleteself', token: token })
          });
        } catch (e) {}
        localStorage.clear();
        sessionStorage.clear();
        document.body.removeChild(modal);
        showToast('Account deleted', 'Your account has been permanently removed.');
        setTimeout(function () {
          window.location.reload();
        }, 1800);
      });
    });
  }
})();
