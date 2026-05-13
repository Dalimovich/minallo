var _obPath = '';
var _obTest = '';
var _obLevel = '';

var _obTestLevels = {
  TestDaF: ['TDN 3', 'TDN 4', 'TDN 5'],
  DSH: ['DSH-1', 'DSH-2', 'DSH-3'],
  Goethe: ['B1', 'B2', 'C1', 'C2'],
  telc: ['B2', 'C1', 'C1 Hochschule', 'C2'],
  OESD: ['B2', 'C1', 'C2'],
  DSD: ['DSD I (B1/B2)', 'DSD II (C1)']
};

function _obShowStep(step) {
  ['obStep1', 'obStep2', 'obStep3a', 'obStep3b'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var target = document.getElementById('obStep' + step);
  if (target) target.style.display = 'flex';
  var grad = 'linear-gradient(90deg,#3b82f6,#0ea5e9)',
    dim = 'rgba(255,255,255,.12)';
  var p1 = document.getElementById('obProg1'),
    p2 = document.getElementById('obProg2'),
    p3 = document.getElementById('obProg3');
  if (step === '1') {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = dim;
    if (p3) p3.style.background = dim;
  } else if (step === '2') {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = grad;
    if (p3) p3.style.background = dim;
  } else {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = grad;
    if (p3) p3.style.background = grad;
  }
}

function _obBaseInfo() {
  return {
    first: document.getElementById('obFirst').value.trim(),
    last: document.getElementById('obLast').value.trim(),
    age: document.getElementById('obAge').value.trim(),
    email: document.getElementById('obEmail').value.trim()
  };
}

async function _obSaveAndClose(profilePayload, cachePayload, onError) {
  var _currentUser = window._currentUser;
  if (_currentUser) {
    try {
      var res = await window._sb.from('profiles').upsert(profilePayload);
      if (res && res.error) {
        var fallback = Object.assign({}, profilePayload);
        delete fallback.vertiefung;
        delete fallback.german_test;
        delete fallback.german_level;
        delete fallback.user_type;
        var fallbackRes = await window._sb.from('profiles').upsert(fallback);
        if (fallbackRes && fallbackRes.error) {
          console.warn('Profile save error (both attempts failed):', fallbackRes.error);
          if (typeof onError === 'function') onError();
          return;
        }
        console.warn('Profile partial save:', res.error);
      }
    } catch (e) {
      console.warn('Profile save error:', e);
      if (typeof onError === 'function') onError();
      return;
    }
    try {
      localStorage.setItem('profile_cache_' + _currentUser.id, JSON.stringify(cachePayload));
    } catch (e) {}
  }
  var pName = document.getElementById('profileName');
  var pEmail = document.getElementById('profileEmail');
  var pUni = document.getElementById('profileUniversity');
  var pProg = document.getElementById('profileProgramme');
  var pInit = document.getElementById('profileInitial');
  var fullName = profilePayload.full_name;
  if (pName) pName.value = fullName;
  if (pEmail) pEmail.value = profilePayload.email;
  if (pUni && profilePayload.university) pUni.value = profilePayload.university;
  if (pProg && profilePayload.programme) pProg.value = profilePayload.programme;
  if (pInit) pInit.textContent = fullName.charAt(0).toUpperCase();
  if (typeof window.updateAuthIndicator === 'function' && _currentUser)
    window.updateAuthIndicator(_currentUser);
  localStorage.setItem('ob_done_' + (_currentUser ? _currentUser.id : 'u'), '1');
  document.getElementById('onboardModal').style.display = 'none';
}

export function showOnboarding(email) {
  _obPath = '';
  _obTest = '';
  _obLevel = '';
  _obShowStep('1');
  document.getElementById('obTitle').textContent = 'Welcome to Minallo!';
  document.getElementById('obSub').textContent = "Let's set up your profile — step 1 of 3";
  document.getElementById('obEmoji').textContent = '👋';
  var emailField = document.getElementById('obEmail');
  if (emailField && email) emailField.value = email;
  document.getElementById('onboardModal').style.display = 'flex';
}

export function initOnboarding() {
  // Programme autocomplete
  (function () {
    var inp = document.getElementById('obProg');
    var drop = document.getElementById('obProgDrop');
    if (!inp || !drop) return;
    function _showProgDrop(q) {
      var MAJOR_LIST = window.MAJOR_LIST || [];
      var items = q
        ? MAJOR_LIST.filter(function (v) {
            return v.toLowerCase().includes(q.toLowerCase());
          })
        : MAJOR_LIST;
      if (!items.length) {
        drop.style.display = 'none';
        return;
      }
      drop.innerHTML = '';
      items.forEach(function (v) {
        var opt = document.createElement('div');
        opt.textContent = v;
        opt.style.cssText =
          "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family:'Nunito',sans-serif;font-weight:700";
        opt.addEventListener('mouseenter', function () {
          opt.style.background = 'rgba(59,130,246,.15)';
        });
        opt.addEventListener('mouseleave', function () {
          opt.style.background = '';
        });
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          inp.value = v;
          drop.style.display = 'none';
          _obToggleVertiefung(v);
        });
        drop.appendChild(opt);
      });
      drop.style.display = 'block';
    }
    function _obToggleVertiefung(major) {
      var row = document.getElementById('obVertiefungRow');
      var vInp = document.getElementById('obVertiefung');
      if (!row) return;
      var VERTIEFUNG_MAP = window.VERTIEFUNG_MAP || {};
      var hasVertiefung = !!(VERTIEFUNG_MAP[major] && VERTIEFUNG_MAP[major].length);
      row.style.display = hasVertiefung ? 'flex' : 'none';
      if (!hasVertiefung && vInp) vInp.value = '';
    }
    inp.addEventListener('focus', function () {
      _showProgDrop(inp.value.trim());
    });
    inp.addEventListener('input', function () {
      _showProgDrop(inp.value.trim());
      _obToggleVertiefung(inp.value.trim());
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        drop.style.display = 'none';
      }, 150);
    });
    _obToggleVertiefung(inp.value.trim());
  })();

  // Vertiefung autocomplete (onboarding)
  (function () {
    var inp = document.getElementById('obVertiefung');
    var drop = document.getElementById('obVertDrop');
    if (!inp || !drop) return;
    function _showVertDrop(q) {
      var majorInp = document.getElementById('obProg');
      var major = majorInp ? majorInp.value.trim() : '';
      var VERTIEFUNG_MAP = window.VERTIEFUNG_MAP || {};
      var VERTIEFUNG_LIST = window.VERTIEFUNG_LIST || [];
      var base =
        VERTIEFUNG_MAP[major] && VERTIEFUNG_MAP[major].length
          ? VERTIEFUNG_MAP[major]
          : VERTIEFUNG_LIST;
      var items = q
        ? base.filter(function (v) {
            return v.toLowerCase().includes(q.toLowerCase());
          })
        : base;
      if (!items.length) {
        drop.style.display = 'none';
        return;
      }
      drop.innerHTML = '';
      items.forEach(function (v) {
        var opt = document.createElement('div');
        opt.textContent = v;
        opt.style.cssText =
          "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family:'Nunito',sans-serif;font-weight:700";
        opt.addEventListener('mouseenter', function () {
          opt.style.background = 'rgba(59,130,246,.15)';
        });
        opt.addEventListener('mouseleave', function () {
          opt.style.background = '';
        });
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          inp.value = v;
          drop.style.display = 'none';
        });
        drop.appendChild(opt);
      });
      drop.style.display = 'block';
    }
    inp.addEventListener('focus', function () {
      _showVertDrop(inp.value.trim());
    });
    inp.addEventListener('input', function () {
      _showVertDrop(inp.value.trim());
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        drop.style.display = 'none';
      }, 150);
    });
  })();

  // Vertiefung autocomplete (profile page)
  (function () {
    var inp = document.getElementById('profileVertiefung');
    var drop = document.getElementById('pfVertDrop');
    if (!inp || !drop) return;
    function _showPfVertDrop(q) {
      var VERTIEFUNG_LIST = window.VERTIEFUNG_LIST || [];
      var items = q
        ? VERTIEFUNG_LIST.filter(function (v) {
            return v.toLowerCase().includes(q.toLowerCase());
          })
        : VERTIEFUNG_LIST;
      if (!items.length) {
        drop.style.display = 'none';
        return;
      }
      drop.innerHTML = '';
      items.forEach(function (v) {
        var opt = document.createElement('div');
        opt.textContent = v;
        opt.style.cssText =
          "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family:'Nunito',sans-serif;font-weight:700";
        opt.addEventListener('mouseenter', function () {
          opt.style.background = 'rgba(59,130,246,.15)';
        });
        opt.addEventListener('mouseleave', function () {
          opt.style.background = '';
        });
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          inp.value = v;
          drop.style.display = 'none';
        });
        drop.appendChild(opt);
      });
      drop.style.display = 'block';
    }
    inp.addEventListener('focus', function () {
      _showPfVertDrop(inp.value.trim());
    });
    inp.addEventListener('input', function () {
      _showPfVertDrop(inp.value.trim());
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        drop.style.display = 'none';
      }, 150);
    });
  })();

  // Global ob handlers
  window._obLogout = function () {
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_refresh');
    sessionStorage.removeItem('sb_sess_token');
    sessionStorage.removeItem('ss_last_active');
    sessionStorage.removeItem('ss_logged_in');
    window.location.reload();
  };

  window._obNext = function () {
    var first = document.getElementById('obFirst').value.trim();
    var last = document.getElementById('obLast').value.trim();
    var age = document.getElementById('obAge').value.trim();
    var email = document.getElementById('obEmail').value.trim();
    var err = document.getElementById('obErr1');
    if (!first || !last || !age || !email) {
      err.textContent = 'Please fill in all fields';
      err.style.display = 'block';
      return;
    }
    if (!email.includes('@')) {
      err.textContent = 'Please enter a valid email';
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    _obShowStep('2');
    document.getElementById('obTitle').textContent = 'Your path';
    document.getElementById('obSub').textContent = 'Tell us about yourself — step 2 of 3';
    document.getElementById('obEmoji').textContent = '🧭';
  };

  window._obSelectPath = function (path) {
    _obPath = path;
    document.querySelectorAll('.ob-path-card').forEach(function (c) {
      c.classList.remove('selected');
    });
    var card = document.getElementById(path === 'enrolled' ? 'obPathEnrolled' : 'obPathLearner');
    if (card) card.classList.add('selected');
    setTimeout(function () {
      _obShowStep(path === 'enrolled' ? '3a' : '3b');
      document.getElementById('obTitle').textContent =
        path === 'enrolled' ? 'Almost there!' : 'Your German journey';
      document.getElementById('obSub').textContent = 'Details — step 3 of 3';
      document.getElementById('obEmoji').textContent = path === 'enrolled' ? '🎓' : '🇩🇪';
    }, 200);
  };

  window._obBack = function (fromStep) {
    if (fromStep === 1 || fromStep === undefined) {
      _obShowStep('1');
      document.getElementById('obTitle').textContent = 'Welcome to Minallo!';
      document.getElementById('obSub').textContent = "Let's set up your profile — step 1 of 3";
      document.getElementById('obEmoji').textContent = '👋';
    } else {
      _obShowStep('2');
      document.getElementById('obTitle').textContent = 'Your path';
      document.getElementById('obSub').textContent = 'Tell us about yourself — step 2 of 3';
      document.getElementById('obEmoji').textContent = '🧭';
    }
  };

  window._obSelectTest = function (card) {
    document.querySelectorAll('.ob-test-card').forEach(function (c) {
      c.classList.remove('selected');
    });
    card.classList.add('selected');
    _obTest = card.dataset.test;
    _obLevel = '';
    var wrap = document.getElementById('obLevelWrap');
    var grid = document.getElementById('obLevelGrid');
    if (!wrap || !grid) return;
    var levels = _obTestLevels[_obTest] || [];
    grid.innerHTML = levels
      .map(function (l) {
        return '<button class="ob-level-btn" data-level="' + l + '">' + l + '</button>';
      })
      .join('');
    wrap.style.display = 'flex';
  };

  window._obSelectLevel = function (btn, level) {
    document.querySelectorAll('.ob-level-btn').forEach(function (b) {
      b.classList.remove('selected');
    });
    btn.classList.add('selected');
    _obLevel = level;
  };

  window._obFinish = async function () {
    var prog = document.getElementById('obProg').value.trim();
    var vertiefung = (document.getElementById('obVertiefung') || {}).value.trim() || '';
    var sem = document.getElementById('obSem').value.trim();
    var matrikel = document.getElementById('obMatrikel').value.trim();
    var err = document.getElementById('obErr3a');
    if (!prog || !sem || !matrikel) {
      err.textContent = 'Please fill in all fields';
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    var btn = document.getElementById('obFinish');
    btn.textContent = '⏳ Saving…';
    btn.disabled = true;
    function _reEnableFinish() {
      btn.textContent = 'Finish';
      btn.disabled = false;
    }

    var info = _obBaseInfo();
    var fullName = info.first + ' ' + info.last;
    var programmeStr = prog + ', ' + sem + '. Semester';
    var MAJOR_LIST = window.MAJOR_LIST || [];
    if (vertiefung) {
      window._userVertiefung = vertiefung;
      localStorage.setItem('ss_vertiefung', vertiefung);
    }
    var _obMatchedMajor = MAJOR_LIST.find(function (m) {
      return m.toLowerCase() === prog.toLowerCase();
    });
    if (_obMatchedMajor) {
      window._userMajor = _obMatchedMajor;
      localStorage.setItem('ss_major', _obMatchedMajor);
    }
    var pVert = document.getElementById('profileVertiefung');
    var pMat = document.getElementById('profileMatrikel');
    if (pVert) pVert.value = vertiefung;
    if (pMat) pMat.value = matrikel;

    var _currentUser = window._currentUser;
    var payload = {
      id: _currentUser && _currentUser.id,
      full_name: fullName,
      email: info.email,
      auth_email: (_currentUser && _currentUser.email) || '',
      university: 'TU Braunschweig',
      programme: programmeStr,
      vertiefung: vertiefung,
      matrikel: matrikel,
      user_type: 'enrolled',
      age: parseInt(info.age) || null,
      updated_at: new Date().toISOString()
    };
    await _obSaveAndClose(payload, {
      full_name: fullName,
      email: info.email,
      university: 'TU Braunschweig',
      programme: programmeStr,
      vertiefung: vertiefung,
      matrikel: matrikel,
      user_type: 'enrolled'
    }, _reEnableFinish);
  };

  window._obFinishLearner = async function () {
    var err = document.getElementById('obErr3b');
    if (!_obTest) {
      err.textContent = 'Please select a test';
      err.style.display = 'block';
      return;
    }
    if (!_obLevel) {
      err.textContent = 'Please select your level';
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    var btn = document.getElementById('obFinishLearner');
    btn.textContent = '⏳ Saving…';
    btn.disabled = true;
    function _reEnableFinishLearner() {
      btn.textContent = 'Finish';
      btn.disabled = false;
    }

    var info = _obBaseInfo();
    var fullName = info.first + ' ' + info.last;
    var _currentUser = window._currentUser;
    var _uid = (_currentUser && _currentUser.id) || '';
    localStorage.setItem('ss_user_type_' + _uid, 'learner');
    localStorage.setItem('ss_german_test_' + _uid, _obTest);
    localStorage.setItem('ss_german_level_' + _uid, _obLevel);
    localStorage.setItem('ss_user_type', 'learner');

    var payload = {
      id: _currentUser && _currentUser.id,
      full_name: fullName,
      email: info.email,
      auth_email: (_currentUser && _currentUser.email) || '',
      user_type: 'learner',
      german_test: _obTest,
      german_level: _obLevel,
      age: parseInt(info.age) || null,
      updated_at: new Date().toISOString()
    };
    await _obSaveAndClose(payload, {
      full_name: fullName,
      email: info.email,
      user_type: 'learner',
      german_test: _obTest,
      german_level: _obLevel
    }, _reEnableFinishLearner);
  };

  // Event listeners
  window.addEventListener('ss-ready', function () {
    var logoutBtn = document.getElementById('obLogoutBtn');
    var continueBtn = document.getElementById('obContinueBtn');
    var back1Btn = document.getElementById('obBack1Btn');
    var back2aBtn = document.getElementById('obBack2aBtn');
    var back2bBtn = document.getElementById('obBack2bBtn');
    var finishBtn = document.getElementById('obFinish');
    var finishLrnBtn = document.getElementById('obFinishLearner');
    var testGrid = document.getElementById('obTestGrid');
    var levelGrid = document.getElementById('obLevelGrid');

    if (logoutBtn)
      logoutBtn.addEventListener('click', function () {
        window._obLogout && window._obLogout();
      });
    if (continueBtn)
      continueBtn.addEventListener('click', function () {
        window._obNext && window._obNext();
      });
    if (back1Btn)
      back1Btn.addEventListener('click', function () {
        window._obBack && window._obBack(1);
      });
    if (back2aBtn)
      back2aBtn.addEventListener('click', function () {
        window._obBack && window._obBack(2);
      });
    if (back2bBtn)
      back2bBtn.addEventListener('click', function () {
        window._obBack && window._obBack(2);
      });
    if (finishBtn)
      finishBtn.addEventListener('click', function () {
        window._obFinish && window._obFinish();
      });
    if (finishLrnBtn)
      finishLrnBtn.addEventListener('click', function () {
        window._obFinishLearner && window._obFinishLearner();
      });

    document.querySelectorAll('.ob-path-card[data-path]').forEach(function (card) {
      card.addEventListener('click', function () {
        window._obSelectPath && window._obSelectPath(card.dataset.path);
      });
    });
    if (testGrid) {
      testGrid.addEventListener('click', function (e) {
        var card = e.target.closest('.ob-test-card');
        if (card && window._obSelectTest) window._obSelectTest(card);
      });
    }
    if (levelGrid) {
      levelGrid.addEventListener('click', function (e) {
        var btn = e.target.closest('.ob-level-btn');
        if (btn && btn.dataset.level && window._obSelectLevel)
          window._obSelectLevel(btn, btn.dataset.level);
      });
    }
  });
}
