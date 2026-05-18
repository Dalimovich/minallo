var COLORS = ['#2563EB', '#FF6FB7', '#4CC9F0', '#06D6A0', '#FF6B35', '#FFD93D'];

// ── DATA ──────────────────────────────────────────────────────────────────
var SEMS = {
  ss2526: { color: '#06D6A0', courses: [] },
  ws2526: { color: '#FFD93D', courses: [] },
  ss25: { color: '#2563EB', courses: [] },
  ws2425: { color: '#FF6FB7', courses: [] },
  ss24: { color: '#4CC9F0', courses: [] },
  ws2324: { color: '#FF6B35', courses: [] }
};
// Load user courses from localStorage
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('ss_user_courses') || '{}');
    // One-time migration: SS 2026 is the current semester. Courses previously
    // saved under `ws2526` were actually summer-semester courses (the slot
    // misnamed before ss2526 existed). Move them across if ss2526 is empty
    // and ws2526 has data, then persist so the migration is sticky.
    if (
      saved &&
      Array.isArray(saved.ws2526) && saved.ws2526.length > 0 &&
      (!Array.isArray(saved.ss2526) || saved.ss2526.length === 0)
    ) {
      saved.ss2526 = saved.ws2526;
      saved.ws2526 = [];
      try { localStorage.setItem('ss_user_courses', JSON.stringify(saved)); } catch (e) {}
    }
    Object.keys(saved).forEach(function (sid) {
      if (SEMS[sid]) SEMS[sid].courses = saved[sid];
    });
  } catch (e) {}
})();
function _stripCourseForSave(c) {
  var out = {};
  Object.keys(c).forEach(function (k) {
    if (k === 'files' || k === 'userFolders' || k === '_filesLoading') return;
    out[k] = c[k];
  });
  return out;
}

function _saveUserCourses() {
  var data = {};
  Object.keys(SEMS).forEach(function (sid) {
    data[sid] = SEMS[sid].courses.map(_stripCourseForSave);
  });
  localStorage.setItem('ss_user_courses', JSON.stringify(data));
  // Also persist to Supabase so courses sync across devices
  var uid = _currentUser && (_currentUser.id || _currentUser.sub);
  if (uid) {
    fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: Object.assign(_sbHeaders(), { Prefer: 'return=minimal' }),
      body: JSON.stringify({ courses: data })
    }).catch(function (e) {
      console.warn('[courses] save failed', e);
    });
  }
}

// ── Background warm-up ──────────────────────────────────────────────────────
// Once the user is authed and SEMS is populated, hit Supabase storage for
// every course in parallel (with a small concurrency cap) so every course
// card has its real file count AND opening any course is instant. Without
// this each course had to lazy-load on first click, which is what made
// users see "0 files" on cards and empty toolbars on the first open.

var _coursePrewarmRan = false;

function _prewarmCourses(opts) {
  if (typeof window._ufMerge !== 'function') return; // app-storage not loaded yet
  var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
  if (!uid) return; // need an authed user
  if (_coursePrewarmRan && !(opts && opts.force)) return;
  _coursePrewarmRan = true;

  var allCourses = [];
  Object.keys(SEMS).forEach(function (sid) {
    (SEMS[sid].courses || []).forEach(function (c) { allCourses.push(c); });
  });
  if (!allCourses.length) return;

  // Skip courses that already have a cache entry — they're already warm.
  var todo = allCourses.filter(function (c) {
    try { return !localStorage.getItem('ss_uf_cache_' + c.id); }
    catch (e) { return true; }
  });
  if (!todo.length) return;

  // Prioritize the course the user is currently looking at (URL hash
  // #course=<id>) so its files are ready before the spinner times out.
  try {
    var m = /[#&]course=([^&]+)/.exec(window.location.hash || '');
    var openId = m && m[1];
    if (openId) {
      var idx = -1;
      for (var i = 0; i < todo.length; i++) {
        if (todo[i].id === openId) { idx = i; break; }
      }
      if (idx > 0) {
        var first = todo.splice(idx, 1)[0];
        todo.unshift(first);
      }
    }
  } catch (e) { /* hash parse failed — fall back to natural order */ }

  // 6 is a measured-ish bump from 4 — Supabase storage list calls are cheap and
  // the dominant per-course cost is _ufMergeImpl's folder listing (now parallel
  // within a course). Higher than 6 risks contending with the user's in-focus
  // open call; 4 left too many courses cold on first paint.
  var CONCURRENCY = 6;
  var cursor = 0;

  function _persistCourseCache(c) {
    try {
      var payload = {
        files: (c.files || []).filter(function (f) { return f._uploaded && !f._folder; })
          .map(function (f) { return { name: f.name, storageName: f._storageName, size: f.size, date: f.date }; }),
        folders: (c.userFolders || []).map(function (fd) {
          return {
            name: fd.name,
            files: (fd.files || []).map(function (f) {
              return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
            })
          };
        })
      };
      localStorage.setItem('ss_uf_cache_' + c.id, JSON.stringify(payload));
      var total = (c.files || []).length + (c.userFolders || []).reduce(function (s, fd) {
        return s + ((fd.files || []).length);
      }, 0);
      localStorage.setItem('ss_fc_' + c.id, String(total));
    } catch (e) {}
  }

  function _next() {
    if (cursor >= todo.length) return Promise.resolve();
    var c = todo[cursor++];
    return window._ufMerge(c)
      .then(function () { _persistCourseCache(c); })
      .catch(function () { /* leave for the on-open path to retry */ })
      .then(_next);
  }

  var lanes = [];
  for (var i = 0; i < Math.min(CONCURRENCY, todo.length); i++) lanes.push(_next());
  Promise.all(lanes).then(function () {
    // Repaint cards so badges update without a manual refresh.
    if (typeof window.sdRenderCourses === 'function') window.sdRenderCourses();
  });
}
window._prewarmCourses = _prewarmCourses;

// Fallback trigger: the primary call site is at the end of _loadUserCourses
// (after the profile API call returns). If that call is slow or fails, this
// poll still fires the warm-up as soon as _currentUser + _ufMerge are both
// available — typically within ~1s of page load.
(function _prewarmWhenReady() {
  var attempts = 0;
  var iv = setInterval(function () {
    if (_coursePrewarmRan) { clearInterval(iv); return; }
    if (window._currentUser && typeof window._ufMerge === 'function') {
      clearInterval(iv);
      try { _prewarmCourses(); } catch (e) {}
    } else if (++attempts > 30) {
      clearInterval(iv);
    }
  }, 500);
})();

function _loadUserCourses(data) {
  if (!data || typeof data !== 'object') return;
  Object.keys(data).forEach(function (sid) {
    if (SEMS[sid] && Array.isArray(data[sid])) {
      var oldCourses = SEMS[sid].courses || [];
      data[sid].forEach(function (c) {
        if (!c.files) c.files = [];
        // Preserve already-loaded files/userFolders from the old course object
        // so that opened courses don't lose their displayed files when SEMS is replaced.
        var old = oldCourses.find(function (oc) {
          return oc.id === c.id;
        });
        if (old) {
          if (old.files && old.files.length) c.files = old.files;
          if (old.userFolders) c.userFolders = old.userFolders;
        }
      });
      SEMS[sid].courses = data[sid];
    }
  });
  // Persist to localStorage as cache
  try {
    localStorage.setItem('ss_user_courses', JSON.stringify(data));
  } catch (e) {}
  sdRenderCourses();
  // Fire-and-forget: pre-fetch every course's files now so cards show real
  // counts and opening a course is instant. Fire on next microtask so the
  // initial render commits first, but with no extra setTimeout delay.
  Promise.resolve().then(function () { try { _prewarmCourses(); } catch (e) {} });
  restoreState();
  // If a course was restored before auth completed, refresh its files from network now.
  // Skip if _currentUser isn't set yet — the post-auth _loadUserCourses call will handle it.
  var _prcUid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
  if (window._pendingRestoreCourse && !_prcUid) {
    // Auth not ready — leave _pendingRestoreCourse for the next call after auth completes.
  } else if (window._pendingRestoreCourse) {
    var _prc = window._pendingRestoreCourse;
    window._pendingRestoreCourse = null;
    var _prcCourse = _prc.course;
    // Find the updated course object (courses array was just replaced by _loadUserCourses)
    var _prcSem = Object.values(SEMS).find(function (s) {
      return s.courses.find(function (c) {
        return c.id === _prcCourse.id;
      });
    });
    if (_prcSem) {
      var _prcFresh = _prcSem.courses.find(function (c) {
        return c.id === _prcCourse.id;
      });
      if (_prcFresh) _prcCourse = _prcFresh;
    }
    _ufMerge(_prcCourse)
      .then(function () {
        _ssRestoring = true;
        showCourseSection(_prcCourse, _prc.sec);
        _ssRestoring = false;
        try {
          var _tc = {
            files: _prcCourse.files
              .filter(function (f) {
                return f._uploaded && !f._folder;
              })
              .map(function (f) {
                return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
              }),
            folders: (_prcCourse.userFolders || []).map(function (fd) {
              return {
                name: fd.name,
                files: fd.files.map(function (f) {
                  return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
                })
              };
            })
          };
          localStorage.setItem('ss_uf_cache_' + _prcCourse.id, JSON.stringify(_tc));
          var _prcTotal =
            _prcCourse.files.length +
            (_prcCourse.userFolders || []).reduce(function (s, fd) {
              return s + (fd.files ? fd.files.length : 0);
            }, 0);
          localStorage.setItem('ss_fc_' + _prcCourse.id, _prcTotal + '');
        } catch (e) {}
        if (_prc.file) {
          var _f = _prcCourse.files.find(function (x) {
            return x.name === _prc.file;
          });
          if (!_f)
            (_prcCourse.userFolders || []).forEach(function (fd) {
              if (!_f)
                _f = (fd.files || []).find(function (x) {
                  return x.name === _prc.file;
                });
            });
          if (_f) {
            openFile(_f, _prcCourse);
          } else {
            // _ufMerge may have been slow or partially failed — try the localStorage
            // cache as a fallback before giving up and clearing state.
            try {
              var _cachedUf = JSON.parse(
                localStorage.getItem('ss_uf_cache_' + _prcCourse.id) || 'null'
              );
              var _cachedFile = null;
              var _cachedFolder = null;
              if (_cachedUf) {
                _cachedFile = (_cachedUf.files || []).find(function (x) {
                  return x.name === _prc.file;
                });
                if (!_cachedFile) {
                  (_cachedUf.folders || []).forEach(function (fd) {
                    if (!_cachedFile) {
                      var hit = (fd.files || []).find(function (x) {
                        return x.name === _prc.file;
                      });
                      if (hit) {
                        _cachedFile = hit;
                        _cachedFolder = fd.name;
                      }
                    }
                  });
                }
              }
              if (_cachedFile && _cachedFile.storageName) {
                var _cachedUid =
                  (window._currentUser && (window._currentUser.id || window._currentUser.sub)) ||
                  localStorage.getItem('ss_last_uid');
                openFile(
                  {
                    name: _cachedFile.name,
                    _storageName: _cachedFile.storageName,
                    _folder: _cachedFolder,
                    _uploaded: true,
                    _uid: _cachedUid,
                    _course: _prcCourse
                  },
                  _prcCourse
                );
              } else {
                _ssClearRestoredFileState(
                  _prcCourse,
                  'This file is no longer in Supabase Storage. Re-upload it if needed.'
                );
              }
            } catch (e) {
              _ssClearRestoredFileState(
                _prcCourse,
                'This file is no longer in Supabase Storage. Re-upload it if needed.'
              );
            }
          }
        }
      })
      .catch(function () {});
  }
}

// Predefined subject list — TU Braunschweig BSc programmes
// All bachelor majors offered at TU Braunschweig
var MAJOR_LIST = [
  'Informatik',
  'Wirtschaftsinformatik',
  'Maschinenbau',
  'Elektrotechnik und Informationstechnik',
  'Bauingenieurwesen',
  'Wirtschaftsingenieurwesen Bauingenieurwesen',
  'Umweltingenieurwesen',
  'Wirtschaftsingenieurwesen Maschinenbau',
  'Architektur',
  'Chemie',
  'Biologie',
  'Biotechnologie',
  'Physik',
  'Psychologie'
];

// Vertiefung (Fachprofil) track names — keyed per major
var VERTIEFUNG_MAP = {
  Maschinenbau: [
    'Allgemeiner Maschinenbau',
    'Energie- und Verfahrenstechnik',
    'Fahrzeugtechnik und mobile Systeme',
    'Luft- und Raumfahrttechnik',
    'Materialwissenschaften',
    'Mechatronik',
    'Produktion, Automation und Systeme'
  ],
  'Elektrotechnik und Informationstechnik': [
    'Autonome intelligente Systeme',
    'Informationstechnische Systeme',
    'Energiesysteme und Antriebstechnik',
    'Metrologie und Messtechnik',
    'Photonik und Quantentechnologien'
  ],
  Bauingenieurwesen: [
    'Konstruktiver Ingenieurbau',
    'Wasser und Umwelt',
    'Verkehr und Infrastruktur',
    'Computational Engineering'
  ],
  'Wirtschaftsingenieurwesen Bauingenieurwesen': [
    'Konstruktiver Ingenieurbau',
    'Wasser und Umwelt',
    'Verkehr und Infrastruktur',
    'Decision Support',
    'Service-Informationssysteme'
  ],
  Umweltingenieurwesen: [
    'Wasserwesen',
    'Energietechnik',
    'Verfahrenstechnik',
    'Ver- und Entsorgungswirtschaft',
    'Verkehr und Infrastruktur',
    'Umwelt- und Ressourcengerechtes Bauen',
    'Geotechnik und Geomonitoring',
    'Konstruktion'
  ],
  'Wirtschaftsingenieurwesen Maschinenbau': [
    'Decision Support',
    'Dienstleistungsmanagement',
    'Finanzwirtschaft',
    'Informationsmanagement',
    'Marketing',
    'Produktion und Logistik',
    'Recht',
    'Unternehmensführung & Organisation',
    'Unternehmensrechnung',
    'Volkswirtschaftslehre',
    'Allgemeiner Maschinenbau',
    'Energie- und Verfahrenstechnik',
    'Fahrzeugtechnik und mobile Systeme',
    'Luft- und Raumfahrttechnik',
    'Materialwissenschaften',
    'Mechatronik',
    'Produktion, Automation und Systeme'
  ],
  Wirtschaftsinformatik: [
    'wirtschaftswissenschaftliche Methodik',
    'Data-Driven Enterprise',
    'Decision Support',
    'Service-Informationssysteme',
    'Dienstleistungsmanagement',
    'Finanzwirtschaft',
    'Produktion und Logistik',
    'Marketing',
    'Recht',
    'Unternehmensrechnung',
    'Unternehmensführung & Organisation',
    'Volkswirtschaftslehre',
    'Unternehmensgründung und -nachfolge',
    'Geschäftsprozess- und Projektmanagement'
  ]
};
// Flat list for autocomplete (all Vertiefungen across all majors)
var VERTIEFUNG_LIST = (function () {
  var all = [];
  Object.keys(VERTIEFUNG_MAP).forEach(function (k) {
    VERTIEFUNG_MAP[k].forEach(function (v) {
      if (all.indexOf(v) < 0) all.push(v);
    });
  });
  return all;
})();

// User's chosen Vertiefung — loaded from localStorage on startup
var _userVertiefung = localStorage.getItem('ss_vertiefung') || '';
var _qnNotes = []; // Quick Notes widget data — loaded from profiles.dashboard_notes
// User's study programme (major) — extracted from stored profile on startup
var _userMajor = localStorage.getItem('ss_major') || '';

var SUBJECT_LIST = [
  // Grundlagen (always shown regardless of Vertiefung)
  { name: 'Faszination Maschinenbau', short: 'FaszMB', cat: 'grundlagen' },
  { name: 'Ingenieurmathematik A', short: 'IMA', cat: 'grundlagen' },
  { name: 'Ingenieurmathematik B', short: 'IMB', cat: 'grundlagen' },
  { name: 'Digitale Werkzeuge', short: 'DigWZ', cat: 'grundlagen' },
  { name: 'Einführung in die Messtechnik', short: 'EiMessT', cat: 'grundlagen' },
  { name: 'Regelungstechnik 1', short: 'RT1', cat: 'grundlagen' },
  { name: 'Grundlagen der Strömungsmechanik', short: 'GStröM', cat: 'grundlagen' },
  { name: 'Technische Mechanik 1', short: 'TM1', cat: 'grundlagen' },
  { name: 'Technische Mechanik 2', short: 'TM2', cat: 'grundlagen' },
  { name: 'Technische Mechanik 3', short: 'TM3', cat: 'grundlagen' },
  { name: 'Thermodynamik 1', short: 'Thermo1', cat: 'grundlagen' },
  { name: 'Fertigungstechnik', short: 'FT', cat: 'grundlagen' },
  { name: 'Ganzheitliches Life Cycle Management', short: 'LCM', cat: 'grundlagen' },
  { name: 'Grundlagen des Konstruierens', short: 'GdK', cat: 'grundlagen' },
  { name: 'Grundlagen komplexer Maschinenelemente und Antriebe', short: 'GkMA', cat: 'grundlagen' },
  { name: 'Werkstoffwissenschaften', short: 'WerkW', cat: 'grundlagen' },
  { name: 'Digitalisierung im Maschinenbau', short: 'DigMB', cat: 'allg-mb' },
  { name: 'Projektarbeit', short: 'PA', cat: 'grundlagen' },
  { name: 'Charakterisierung von Oberflächen und Schichten', short: 'CharOS', cat: 'grundlagen' },
  { name: 'Fügetechnik', short: 'FügT', cat: 'grundlagen' },
  { name: 'Grundlagen der Energietechnik', short: 'GEnT', cat: 'grundlagen' },
  { name: 'Grundlagen der Fahrzeugtechnik', short: 'GFT', cat: 'grundlagen' },
  { name: 'Grundlagen der Mechatronik und Elektronik', short: 'GME', cat: 'grundlagen' },
  { name: 'Grundlagen der Mikrosystemtechnik', short: 'GMikro', cat: 'grundlagen' },
  { name: 'Raumfahrttechnische Grundlagen', short: 'RaumF', cat: 'grundlagen' },
  // Modellierung und Simulation
  { name: 'Finite-Elemente-Methoden', short: 'FEM', cat: 'Allgemeiner Maschinenbau' },
  {
    name: 'Modellierung mechatronischer Systeme',
    short: 'ModMech',
    cat: 'Allgemeiner Maschinenbau'
  },
  {
    name: 'Numerische Methoden in der Materialwissenschaft',
    short: 'NumMat',
    cat: 'Allgemeiner Maschinenbau'
  },
  { name: 'Simulation of Mechatronic Systems', short: 'SimMech', cat: 'Allgemeiner Maschinenbau' },
  // Mechanik und Festigkeit
  {
    name: 'Dynamik in Fallbeispielen aus der Industrie',
    short: 'DynFB',
    cat: 'Allgemeiner Maschinenbau'
  },
  { name: 'Höhere Festigkeitslehre', short: 'HFL', cat: 'Allgemeiner Maschinenbau' },
  { name: 'Maschinendynamik', short: 'MaDyn', cat: 'Allgemeiner Maschinenbau' },
  // Werkstoffe
  {
    name: 'Chemie für die Verfahrenstechnik und Materialwissenschaften',
    short: 'ChemVT',
    cat: 'Materialwissenschaften'
  },
  { name: 'Funktionswerkstoffe', short: 'FunkW', cat: 'Materialwissenschaften' },
  { name: 'Mechanisches Verhalten der Werkstoffe', short: 'MechVW', cat: 'Materialwissenschaften' },
  { name: 'Technische Schadensfälle', short: 'TechSF', cat: 'Materialwissenschaften' },
  // Konstruktion
  { name: 'Akustikgerechtes Konstruieren', short: 'AkustK', cat: 'Allgemeiner Maschinenbau' },
  {
    name: 'Grundlagen der Produktentwicklung und Konstruktion',
    short: 'GPK',
    cat: 'Allgemeiner Maschinenbau'
  },
  { name: 'Vertiefte Methoden des Konstruierens', short: 'VMK', cat: 'Allgemeiner Maschinenbau' },
  // Energie- und Verfahrenstechnik
  { name: 'Anlagenbau', short: 'AnlB', cat: 'Energie- und Verfahrenstechnik' },
  {
    name: 'Digitalisierung in der Energie- und Verfahrenstechnik',
    short: 'DigEVT',
    cat: 'Energie- und Verfahrenstechnik'
  },
  {
    name: 'Einführung in numerische Methoden für Ingenieure',
    short: 'EinNumM',
    cat: 'Energie- und Verfahrenstechnik'
  },
  {
    name: 'Grundlagen der Mechanischen Verfahrenstechnik',
    short: 'GMechVT',
    cat: 'Energie- und Verfahrenstechnik'
  },
  { name: 'Thermodynamik 2', short: 'Thermo2', cat: 'Energie- und Verfahrenstechnik' },
  {
    name: 'Grundlagen der Strömungsmaschinen',
    short: 'GStrömM',
    cat: 'Energie- und Verfahrenstechnik'
  },
  {
    name: 'Grundoperationen der Fluidverfahrenstechnik',
    short: 'GrundFVT',
    cat: 'Energie- und Verfahrenstechnik'
  },
  {
    name: 'Batterien und Brennstoffzellen',
    short: 'BattBZ',
    cat: 'Energie- und Verfahrenstechnik'
  },
  { name: 'Bioreaktoren und Bioprozesse', short: 'BioBP', cat: 'Energie- und Verfahrenstechnik' },
  { name: 'Chemische Reaktionskinetik', short: 'ChemRK', cat: 'Energie- und Verfahrenstechnik' },
  { name: 'Chemische Verfahrenstechnik', short: 'ChemVT2', cat: 'Energie- und Verfahrenstechnik' },
  {
    name: 'Electrochemical Energy Engineering',
    short: 'EcEE',
    cat: 'Energie- und Verfahrenstechnik'
  },
  { name: 'Elektrische Energietechnik', short: 'EET', cat: 'Energie- und Verfahrenstechnik' },
  {
    name: 'Grundlagen der Umweltschutztechnik',
    short: 'GUT',
    cat: 'Energie- und Verfahrenstechnik'
  },
  // Fahrzeugtechnik
  {
    name: 'Digitalisierung in der Fahrzeugtechnik',
    short: 'DigFT',
    cat: 'Fahrzeugtechnik und mobile Systeme'
  },
  {
    name: 'Grundlagen der Fahrzeugkonstruktion',
    short: 'GFK',
    cat: 'Fahrzeugtechnik und mobile Systeme'
  },
  {
    name: 'Numerische Methoden in der Kraftfahrzeugtechnik',
    short: 'NumKFZ',
    cat: 'Fahrzeugtechnik und mobile Systeme'
  },
  {
    name: 'Mobile Arbeitsmaschinen und Nutzfahrzeuge',
    short: 'MAN',
    cat: 'Fahrzeugtechnik und mobile Systeme'
  },
  {
    name: 'Verbrennungskraftmaschinen und Brennstoffzellen',
    short: 'VKM',
    cat: 'Fahrzeugtechnik und mobile Systeme'
  },
  { name: 'Verkehrsleittechnik', short: 'VLT', cat: 'Fahrzeugtechnik und mobile Systeme' },
  // Luft- und Raumfahrttechnik
  {
    name: 'Berechnungsmethoden in der Aerodynamik',
    short: 'BAero',
    cat: 'Luft- und Raumfahrttechnik'
  },
  {
    name: 'Digitalisierung in der Luft- und Raumfahrttechnik',
    short: 'DigLRT',
    cat: 'Luft- und Raumfahrttechnik'
  },
  { name: 'Flugleistungen', short: 'FL', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Grundlagen der Flugführung', short: 'GFF', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Ingenieurtheorien des Leichtbaus', short: 'ITL', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Kreisprozesse der Flugtriebwerke', short: 'KPF', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Airfoil Aerodynamics', short: 'AirAero', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Bauelemente von Strahltriebwerken', short: 'BauST', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Drehflügeltechnik', short: 'DrehF', cat: 'Luft- und Raumfahrttechnik' },
  { name: 'Elemente des Leichtbaus', short: 'ELB', cat: 'Luft- und Raumfahrttechnik' },
  {
    name: 'Future Propulsion Technologies for Sustainable Aviation',
    short: 'FPTSA',
    cat: 'Luft- und Raumfahrttechnik'
  },
  { name: 'Luftverkehrsimulation', short: 'LVSim', cat: 'Luft- und Raumfahrttechnik' },
  // Materialwissenschaften
  {
    name: 'Herstellung und Anwendung dünner Schichten',
    short: 'HAdS',
    cat: 'Materialwissenschaften'
  },
  {
    name: 'Numerische Methoden in der Materialwissenschaft',
    short: 'NumMatW',
    cat: 'Materialwissenschaften'
  },
  // Mechatronik
  { name: 'Aktoren', short: 'Akt', cat: 'Mechatronik' },
  { name: 'Digitalisierung in der Mechatronik', short: 'DigMech', cat: 'Mechatronik' },
  { name: 'Aufbau- und Verbindungstechnik', short: 'AVT', cat: 'Mechatronik' },
  { name: 'Automatisierte Montage', short: 'AutoM', cat: 'Mechatronik' },
  {
    name: 'Automatisierung von industriellen Fertigungsprozessen',
    short: 'AutoFP',
    cat: 'Mechatronik'
  },
  { name: 'Computational Biomechanics', short: 'CompBio', cat: 'Mechatronik' },
  { name: 'Elektrische Signalverarbeitung', short: 'ESigV', cat: 'Mechatronik' },
  { name: 'Fertigungsmesstechnik', short: 'FMessT', cat: 'Mechatronik' },
  { name: 'Mechatronische Systeme', short: 'MechSys', cat: 'Mechatronik' },
  // Produktion, Automation und Systeme
  { name: 'Betriebsorganisation', short: 'BetOrg', cat: 'Produktion, Automation und Systeme' },
  {
    name: 'Industrielles Qualitätsmanagement',
    short: 'IQM',
    cat: 'Produktion, Automation und Systeme'
  },
  {
    name: 'Praxisorientiertes Konstruktionsprojekt',
    short: 'PKP',
    cat: 'Produktion, Automation und Systeme'
  },
  // Informatik
  { name: 'Programmieren 1', short: 'Prog1', cat: 'Informatik' },
  { name: 'Programmieren 2', short: 'Prog2', cat: 'Informatik' },
  { name: 'Algorithmen und Datenstrukturen', short: 'AlgDS', cat: 'Informatik' },
  { name: 'Theoretische Informatik 1', short: 'TheoInf1', cat: 'Informatik' },
  { name: 'Theoretische Informatik 2', short: 'TheoInf2', cat: 'Informatik' },
  { name: 'Technische Informatik', short: 'TechInf', cat: 'Informatik' },
  { name: 'Betriebssysteme', short: 'BS', cat: 'Informatik' },
  { name: 'Datenbanksysteme', short: 'DBS', cat: 'Informatik' },
  { name: 'Computernetze', short: 'CN', cat: 'Informatik' },
  { name: 'IT-Sicherheit', short: 'ITSec', cat: 'Informatik' },
  { name: 'Algorithm Engineering', short: 'AlgEng', cat: 'Informatik' },
  { name: 'Netzwerkalgorithmen', short: 'NetzAlg', cat: 'Informatik' },
  { name: 'Verteilte Systeme', short: 'VS', cat: 'Informatik' },
  { name: 'Programmanalyse', short: 'ProgAna', cat: 'Informatik' },
  { name: 'Maschinelles Lernen', short: 'ML', cat: 'Informatik' },
  { name: 'Computer Vision', short: 'CV', cat: 'Informatik' },
  // Wirtschaftsinformatik
  { name: 'Betriebswirtschaftslehre', short: 'BWL', cat: 'Wirtschaftsinformatik' },
  { name: 'Volkswirtschaftslehre', short: 'VWL', cat: 'Wirtschaftsinformatik' },
  { name: 'Rechnungswesen', short: 'ReWe', cat: 'Wirtschaftsinformatik' },
  { name: 'Statistik', short: 'Stat', cat: 'Wirtschaftsinformatik' },
  { name: 'Data-Driven Enterprise', short: 'DDE', cat: 'Wirtschaftsinformatik' },
  { name: 'Decision Support', short: 'DecSup', cat: 'Wirtschaftsinformatik' },
  { name: 'Informationssysteme', short: 'InfoSys', cat: 'Wirtschaftsinformatik' },
  // Bauingenieurwesen
  { name: 'Ingenieurmathematik', short: 'IngMath', cat: 'Bauingenieurwesen' },
  { name: 'Geotechnik', short: 'GeoT', cat: 'Bauingenieurwesen' },
  { name: 'Baustoffkunde', short: 'BaustK', cat: 'Bauingenieurwesen' },
  { name: 'Baustatik', short: 'BauStat', cat: 'Bauingenieurwesen' },
  { name: 'Stahlbau', short: 'Stahl', cat: 'Bauingenieurwesen' },
  { name: 'Massivbau', short: 'Massiv', cat: 'Bauingenieurwesen' },
  { name: 'Wasserbau', short: 'Wasser', cat: 'Bauingenieurwesen' },
  { name: 'Umweltschutz', short: 'UmwSch', cat: 'Bauingenieurwesen' },
  { name: 'Verkehrsplanung', short: 'VerkPl', cat: 'Bauingenieurwesen' },
  { name: 'Straßenwesen', short: 'Straße', cat: 'Bauingenieurwesen' },
  // Architektur
  { name: 'Entwerfen', short: 'Entw', cat: 'Architektur' },
  { name: 'Baukonstruktion', short: 'BauKon', cat: 'Architektur' },
  { name: 'Tragwerkslehre', short: 'TragW', cat: 'Architektur' },
  { name: 'Bauphysik', short: 'BauPhys', cat: 'Architektur' },
  { name: 'Städtebau', short: 'StädtB', cat: 'Architektur' },
  { name: 'Architekturgeschichte', short: 'ArchG', cat: 'Architektur' },
  { name: 'CAD', short: 'CAD', cat: 'Architektur' },
  { name: 'Gestaltung', short: 'Gest', cat: 'Architektur' },
  { name: 'Gebäudeplanung', short: 'GebPl', cat: 'Architektur' },
  { name: 'Städtebauprojekte', short: 'StädtPr', cat: 'Architektur' },
  { name: 'Konstruktive Projekte', short: 'KonPr', cat: 'Architektur' },
  // Chemie
  { name: 'Anorganische Chemie', short: 'AnorgChem', cat: 'Chemie' },
  { name: 'Organische Chemie', short: 'OrgChem', cat: 'Chemie' },
  { name: 'Physikalische Chemie', short: 'PhysChem', cat: 'Chemie' },
  { name: 'Analytische Chemie', short: 'AnalChem', cat: 'Chemie' },
  { name: 'Technische Chemie', short: 'TechChem', cat: 'Chemie' },
  { name: 'Makromolekulare Chemie', short: 'MakroChem', cat: 'Chemie' },
  // Biologie
  { name: 'Zellbiologie', short: 'ZellBio', cat: 'Biologie' },
  { name: 'Genetik', short: 'Genet', cat: 'Biologie' },
  { name: 'Ökologie', short: 'Öko', cat: 'Biologie' },
  { name: 'Mikrobiologie', short: 'MikroBio', cat: 'Biologie' },
  { name: 'Botanik', short: 'Bot', cat: 'Biologie' },
  { name: 'Zoologie', short: 'Zoo', cat: 'Biologie' },
  { name: 'Molekularbiologie', short: 'MolBio', cat: 'Biologie' },
  { name: 'Evolution', short: 'Evol', cat: 'Biologie' },
  { name: 'Biochemie', short: 'BioChem', cat: 'Biologie' },
  // Biotechnologie
  { name: 'Bioverfahrenstechnik', short: 'BioVT', cat: 'Biotechnologie' },
  // Physik
  { name: 'Experimentalphysik', short: 'ExPhys', cat: 'Physik' },
  { name: 'Theoretische Physik', short: 'TheoPhys', cat: 'Physik' },
  { name: 'Mathematik', short: 'Math', cat: 'Physik' },
  { name: 'Numerische Methoden', short: 'NumMeth', cat: 'Physik' },
  { name: 'Simulation', short: 'Sim', cat: 'Physik' },
  // Psychologie
  { name: 'Allgemeine Psychologie', short: 'AllgPsy', cat: 'Psychologie' },
  { name: 'Entwicklungspsychologie', short: 'EntwPsy', cat: 'Psychologie' },
  { name: 'Sozialpsychologie', short: 'SozPsy', cat: 'Psychologie' },
  { name: 'Klinische Psychologie', short: 'KlinPsy', cat: 'Psychologie' },
  { name: 'Diagnostik', short: 'Diagn', cat: 'Psychologie' },
  { name: 'Neurowissenschaften', short: 'NeuroW', cat: 'Psychologie' },
  { name: 'Forschungsmethoden', short: 'ForschM', cat: 'Psychologie' },
  // ET Grundlagen (always shown for ET major)
  { name: 'Lineare Algebra für Elektrotechnik', short: 'LinAlgET', cat: 'et-grundlagen' },
  { name: 'Analysis für Elektrotechnik', short: 'AnalET', cat: 'et-grundlagen' },
  { name: 'Höhere Analysis für Elektrotechnik', short: 'HöhAnalET', cat: 'et-grundlagen' },
  { name: 'Physik für Elektrotechnik mit Praktikum', short: 'PhysET', cat: 'et-grundlagen' },
  { name: 'Optik - Quanten - Materialien', short: 'OQM', cat: 'et-grundlagen' },
  { name: 'Wahrscheinlichkeitstheorie und Statistik', short: 'WuS', cat: 'et-grundlagen' },
  { name: 'Rechenmethoden der Elektrotechnik', short: 'RechmET', cat: 'et-grundlagen' },
  {
    name: 'Grundlagen der elektrischen Messtechnik mit Labor',
    short: 'GMessT',
    cat: 'et-grundlagen'
  },
  { name: 'Grundlagen der Elektrotechnik', short: 'GdET', cat: 'et-grundlagen' },
  { name: 'Leitungstheorie', short: 'LeithT', cat: 'et-grundlagen' },
  {
    name: 'Grundlagen der elektromagnetischen Feldtheorie',
    short: 'GEMFeld',
    cat: 'et-grundlagen'
  },
  { name: 'Netzwerke', short: 'NWK', cat: 'et-grundlagen' },
  { name: 'Signale und Systeme', short: 'SuS', cat: 'et-grundlagen' },
  { name: 'Grundlagen der Regelungstechnik', short: 'GRT', cat: 'et-grundlagen' },
  { name: 'Grundlagen der Elektronik', short: 'GElektr', cat: 'et-grundlagen' },
  { name: 'Grundlagen der elektrischen Energietechnik', short: 'GEnerT', cat: 'et-grundlagen' },
  { name: 'Informatik für Ingenieure', short: 'InfIng', cat: 'et-grundlagen' },
  { name: 'Schaltungstechnik', short: 'SchalT', cat: 'et-grundlagen' },
  { name: 'Grundlagen der Informationstechnik', short: 'GInfT', cat: 'et-grundlagen' },
  { name: 'Programmieren 1', short: 'Prog1ET', cat: 'et-grundlagen' },
  { name: 'Professionalisierung', short: 'Prof', cat: 'et-grundlagen' },
  { name: 'Industriefachpraktikum', short: 'InduPrak', cat: 'et-grundlagen' },
  { name: 'Teamprojekt', short: 'TeamPrj', cat: 'et-grundlagen' },
  { name: 'Bachelorarbeit', short: 'BachArbET', cat: 'et-grundlagen' },
  // ET Wahlbereich: Autonome intelligente Systeme
  { name: 'Messelektronik', short: 'MessEl', cat: 'Autonome intelligente Systeme' },
  { name: 'Messelektronik mit Praxis', short: 'MessElP', cat: 'Autonome intelligente Systeme' },
  {
    name: 'Identifikation dynamischer Systeme',
    short: 'IdDynSys',
    cat: 'Autonome intelligente Systeme'
  },
  {
    name: 'Erweiterte Methoden der Regelungstechnik',
    short: 'ErwRT',
    cat: 'Autonome intelligente Systeme'
  },
  { name: 'Datenbussysteme', short: 'DatBus', cat: 'Autonome intelligente Systeme' },
  {
    name: 'Hochvoltsicherheit im Kraftfahrzeug',
    short: 'HochvKFZ',
    cat: 'Autonome intelligente Systeme'
  },
  { name: 'Fahrzeugsystemtechnik', short: 'FahrzSys', cat: 'Autonome intelligente Systeme' },
  { name: 'Rechnerstrukturen 1', short: 'RechStr1', cat: 'Autonome intelligente Systeme' },
  {
    name: 'Grundlagen Computer Design mit Praktikum',
    short: 'GCDPrak',
    cat: 'Autonome intelligente Systeme'
  },
  {
    name: 'Grundlagen eingebetteter Rechnersysteme mit Praktikum (2013)',
    short: 'GEmbRS',
    cat: 'Autonome intelligente Systeme'
  },
  {
    name: 'Elektromagnetische Verträglichkeit',
    short: 'EMV',
    cat: 'Autonome intelligente Systeme'
  },
  { name: 'Digitale Signalverarbeitung', short: 'DSV', cat: 'Autonome intelligente Systeme' },
  {
    name: 'Grundlagen der Digitalen Signalverarbeitung',
    short: 'GDSV',
    cat: 'Autonome intelligente Systeme'
  },
  {
    name: 'Electrochemical storages embedded in on-board power systems',
    short: 'EchemOBD',
    cat: 'Autonome intelligente Systeme'
  },
  { name: 'Modellfahrzeugbau', short: 'ModFzg', cat: 'Autonome intelligente Systeme' },
  {
    name: 'Anwendung regelungstechnischer Methoden',
    short: 'AnwRT',
    cat: 'Autonome intelligente Systeme'
  },
  // ET Wahlbereich: Informationstechnische Systeme
  { name: 'Integrierte Schaltungen', short: 'IntSchal', cat: 'Informationstechnische Systeme' },
  {
    name: 'Optische Nachrichtentechnik mit Praktikum',
    short: 'OptNT',
    cat: 'Informationstechnische Systeme'
  },
  {
    name: 'Systeme und Schaltungen der Hochfrequenztechnik',
    short: 'SuSHF',
    cat: 'Informationstechnische Systeme'
  },
  {
    name: 'Lineare Photonik mit Praktikum',
    short: 'LinPhP',
    cat: 'Informationstechnische Systeme'
  },
  { name: 'Lineare Photonik', short: 'LinPh', cat: 'Informationstechnische Systeme' },
  {
    name: 'Kommunikationsnetze für Ingenieure',
    short: 'KommN',
    cat: 'Informationstechnische Systeme'
  },
  {
    name: 'Grundlagen der Kommunikationsnetze für Ingenieure',
    short: 'GKommN',
    cat: 'Informationstechnische Systeme'
  },
  {
    name: 'Vertiefungspraktikum zur Schaltungstechnik',
    short: 'VPSchal',
    cat: 'Informationstechnische Systeme'
  },
  {
    name: 'Planung terrestrischer Funknetze',
    short: 'PlanFN',
    cat: 'Informationstechnische Systeme'
  },
  { name: 'Grundlagen des Mobilfunks', short: 'GMobil', cat: 'Informationstechnische Systeme' },
  { name: 'Digitale Signalübertragung', short: 'DSÜ', cat: 'Informationstechnische Systeme' },
  { name: 'Mobilkommunikation', short: 'MobKomm', cat: 'Informationstechnische Systeme' },
  { name: 'Hardware-Software-Systeme', short: 'HSwSys', cat: 'Informationstechnische Systeme' },
  {
    name: 'Digitale Signalübertragung und Rechnerübung',
    short: 'DSÜRÜ',
    cat: 'Informationstechnische Systeme'
  },
  // ET Wahlbereich: Energiesysteme und Antriebstechnik
  { name: 'Elektrische Antriebe', short: 'ElAntr', cat: 'Energiesysteme und Antriebstechnik' },
  {
    name: 'Grundschaltungen der Leistungselektronik',
    short: 'GLElektr',
    cat: 'Energiesysteme und Antriebstechnik'
  },
  {
    name: 'Technologien der Verteilungsnetze',
    short: 'TechVN',
    cat: 'Energiesysteme und Antriebstechnik'
  },
  {
    name: 'Technologien der Übertragungsnetze',
    short: 'TechÜN',
    cat: 'Energiesysteme und Antriebstechnik'
  },
  {
    name: 'Energiewirtschaft und Marktintegration erneuerbarer Energien',
    short: 'EnWirt',
    cat: 'Energiesysteme und Antriebstechnik'
  },
  {
    name: 'Aufbau und Berechnung von Gleichstromsystemen',
    short: 'AuBGlStr',
    cat: 'Energiesysteme und Antriebstechnik'
  },
  // ET Wahlbereich: Metrologie und Messtechnik
  { name: 'Lichttechnik', short: 'LichtT', cat: 'Metrologie und Messtechnik' },
  { name: 'Halbleitermesstechnik', short: 'HalbMessT', cat: 'Metrologie und Messtechnik' },
  {
    name: 'Nano- und Bioelektronische Systeme',
    short: 'NanoBio',
    cat: 'Metrologie und Messtechnik'
  },
  { name: 'Lichttechnik mit Praxis', short: 'LichtTP', cat: 'Metrologie und Messtechnik' },
  // ET Wahlbereich: Photonik und Quantentechnologien
  { name: 'Molekulare Elektronik', short: 'MolElektr', cat: 'Photonik und Quantentechnologien' },
  {
    name: 'Dielektrische Materialien der Elektronik und Photonik',
    short: 'DiElMat',
    cat: 'Photonik und Quantentechnologien'
  }
];
