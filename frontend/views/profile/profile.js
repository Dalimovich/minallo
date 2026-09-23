(function () {
  var feature = {
    sectionId: 'psec-profile',
    html: 'views/profile/profile.html',
    css: 'views/profile/profile.css'
  };
  if (window.Minallo) {
    window.Minallo.registerFeature('profile', feature);
  } else {
    window.MinalloFeatures = window.MinalloFeatures || {};
    window.MinalloFeatures.profile = feature;
  }

  var section = document.getElementById('psec-profile');
  if (section) section.dataset.feature = 'profile';
})();

async function saveProfile() {
  if (!_currentUser) {
    showToast(_t('toast_sign_in'), '');
    return;
  }
  var isLearner = window._userType === 'learner';
  var data = {
    id: _currentUser.id,
    full_name: (document.getElementById('profileName') || {}).value || '',
    email: (document.getElementById('profileEmail') || {}).value || '',
    auth_email: _currentUser.email || '',
    university: (document.getElementById('profileUniversity') || {}).value || '',
    programme: (document.getElementById('profileProgramme') || {}).value || '',
    vertiefung: (document.getElementById('profileVertiefung') || {}).value || '',
    matrikel: (document.getElementById('profileMatrikel') || {}).value || '',
    updated_at: new Date().toISOString()
  };
  if (isLearner) {
    // profiles.german_test + profiles.german_level are the single source of
    // truth for the website AND the AI. Both are always saved together, and
    // only as a valid pair from the shared catalog.
    var gtSel = document.getElementById('profileGermanTest');
    var glSel = document.getElementById('profileGermanLevel');
    var test = gtSel ? gtSel.value : '';
    var level = glSel ? glSel.value : '';
    if (!test || !level || !(window.isValidGermanTestLevel && window.isValidGermanTestLevel(test, level))) {
      showToast(_t('toast_save_failed'), 'Please choose your exam and a target level for it.');
      return;
    }
    data.german_test = test;
    data.german_level = level;
    // TestDaF only: an explicit digital/paper delivery-mode choice always
    // wins over the "unchanged target" preservation below — a learner who
    // switches the dropdown to "paper-based" must see the profile clear even
    // if test/level themselves didn't change. See german-profile.ts.
    var tdSel = document.getElementById('profileTestDafMode');
    var tdVal = test === 'TestDaF' && tdSel ? tdSel.value : '';
    if (tdVal === 'digital') {
      data.german_exam_profile_id = window._resolveGermanExamProfileId
        ? window._resolveGermanExamProfileId(test, level, window.TESTDAF_DIGITAL_PROFILE_ID || 'testdaf_digital')
        : (window.TESTDAF_DIGITAL_PROFILE_ID || 'testdaf_digital');
    } else if (tdVal === 'paper') {
      data.german_exam_profile_id = null;
    } else {
      // Preserve an explicitly saved variant when its target is unchanged.
      // A changed legacy target clears/re-resolves the previous variant.
      data.german_exam_profile_id = test === window._germanTest && level === window._germanLevel && window._germanExamProfileId
        ? window._germanExamProfileId
        : window._resolveGermanExamProfileId ? window._resolveGermanExamProfileId(test, level) : null;
    }
  }
  var _dbSaved = false;
  try {
    var _pr = await _sb.from('profiles').upsert(data);
    if (_pr && _pr.error) {
      // Retry without ONLY the optional compat fields; never the learner
      // identity fields (german_test / german_level).
      var _fb = Object.assign({}, data);
      delete _fb.vertiefung;
      delete _fb.german_exam_profile_id;
      var _pr2 = await _sb.from('profiles').upsert(_fb);
      if (_pr2 && _pr2.error) throw new Error(_pr2.error.message || 'save failed');
    }
    _dbSaved = true;
    // Read the real saved row back: server first, then runtime, then cache.
    var saved = await _sb.from('profiles').select('*').eq('id', _currentUser.id).single();
    if (!saved) throw new Error('Could not confirm the saved profile');
    if (isLearner && (saved.german_test !== data.german_test || saved.german_level !== data.german_level)) {
      throw new Error('Your German level was not saved. Please try again.');
    }
    // Local, non-critical form/state updates. A failure here must never turn a
    // successful save into a "save failed" message.
    try {
      if (data.vertiefung) {
        _userVertiefung = data.vertiefung;
        localStorage.setItem('ss_vertiefung', data.vertiefung);
      }
      if (data.programme) {
        var _spRaw = data.programme.split(',')[0].trim();
        var _spM = MAJOR_LIST.find(function (m) {
          return m.toLowerCase() === _spRaw.toLowerCase();
        });
        if (_spM) {
          _userMajor = _spM;
          localStorage.setItem('ss_major', _spM);
        }
      }
      var init = document.getElementById('profileInitial');
      if (init && data.full_name) init.textContent = data.full_name.charAt(0).toUpperCase();
      updateAuthIndicator(_currentUser);
    } catch (_uiErr) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[Profile] local UI update failed', _uiErr);
    }
    // The saved row is now the authoritative runtime profile. This updates
    // window._germanTest/_germanLevel/_germanExamProfileId, the profile cache,
    // and fires ss-profile-updated, which makes the German exam workspace drop
    // the previous exam and load the new manifest. It runs BEFORE the success
    // notification so nothing can announce a change the UI has not adopted.
    if (typeof window._applySavedProfile === 'function') window._applySavedProfile(saved);
    else if (typeof window.applyProfile === 'function') window.applyProfile(saved);
    // Let the new exam manifest land so the first thing the user sees is the
    // new exam, but never hold the notification hostage to a slow network: the
    // workspace shows its own loading state meanwhile.
    await _settleExamRefresh(1500);
    showToast(_t('toast_profile_saved'), _t('toast_profile_saved_sub'));
  } catch (e) {
    // If the row WAS written but we could not confirm/apply it, the server is
    // now the truth: resync the runtime profile from it rather than leaving the
    // UI on a profile that no longer matches the saved one.
    if (_dbSaved && typeof window._ensureUserProfile === 'function') {
      try {
        window._ensureUserProfile({ force: true });
      } catch (_resyncErr) {
        /* best effort */
      }
    }
    showToast(_t('toast_save_failed'), String((e && e.message) || e));
  }
}

// Resolves when the German exam workspace has adopted the just-saved profile
// (manifest loaded or failed), or after maxMs, whichever comes first. A no-op
// when German Practice has not been opened yet.
function _settleExamRefresh(maxMs) {
  var refresh = window._glExamRefreshNow;
  if (typeof refresh !== 'function') return Promise.resolve();
  var settled = Promise.resolve()
    .then(function () {
      return refresh();
    })
    .catch(function () {});
  var timeout = new Promise(function (resolve) {
    setTimeout(resolve, maxMs);
  });
  return Promise.race([settled, timeout]);
}

// The profile form HTML is lazy-loaded, so the Save button doesn't exist when
// this script first runs and a direct addEventListener would no-op. Delegate
// from document so the click always works regardless of when the HTML mounts.
(function bindProfileControls() {
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.profile-save-btn') : null;
    if (btn) {
      e.preventDefault();
      saveProfile();
    }
  });
})();

// Changing the exam family repopulates Target Level with that exam's exact
// levels (same catalog as onboarding). Delegated because the form HTML is
// lazy-loaded.
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || t.id !== 'profileGermanTest') return;
  var gl = document.getElementById('profileGermanLevel');
  if (gl && typeof window.populateGermanLevelSelect === 'function') {
    window.populateGermanLevelSelect(gl, t.value, '');
  }
  // TestDaF-only delivery-mode field: show it only while TestDaF is the
  // chosen family, and never carry a stale choice into another family.
  var tdGroup = document.getElementById('profileTestDafModeGroup');
  var tdSel = document.getElementById('profileTestDafMode');
  if (tdGroup) tdGroup.style.display = t.value === 'TestDaF' ? '' : 'none';
  if (tdSel && t.value !== 'TestDaF') tdSel.value = '';
});
