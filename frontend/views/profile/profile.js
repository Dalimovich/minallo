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
    // Re-resolved on every save: null (no exam-specific blueprint for this
    // pair) is a normal value, not an error, and clears a stale id.
    data.german_exam_profile_id = window._resolveGermanExamProfileId
      ? window._resolveGermanExamProfileId(test, level)
      : null;
  }
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
    // Read the real saved row back: server first, then runtime, then cache.
    var saved = await _sb.from('profiles').select('*').eq('id', _currentUser.id).single();
    if (!saved) throw new Error('Could not confirm the saved profile');
    if (isLearner && (saved.german_test !== data.german_test || saved.german_level !== data.german_level)) {
      throw new Error('Your German level was not saved. Please try again.');
    }
    showToast(_t('toast_profile_saved'), _t('toast_profile_saved_sub'));
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
    // Make the saved row the authoritative runtime profile: updates
    // window._germanTest/_germanLevel/_germanExamProfileId, the profile cache,
    // and fires ss-profile-updated so every open surface (practice level
    // selectors, sidebar chip, Writing Coach badge, Sprachbausteine) reacts
    // with no reload.
    if (typeof window._applySavedProfile === 'function') window._applySavedProfile(saved);
    else if (typeof window.applyProfile === 'function') window.applyProfile(saved);
  } catch (e) {
    showToast(_t('toast_save_failed'), String((e && e.message) || e));
  }
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
});
