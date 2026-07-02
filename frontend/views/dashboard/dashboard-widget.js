// ── Widget Dashboard ──────────────────────────────────────────────────────────
(function () {
  var container = document.getElementById('psec-dashboard');
  if (!container) return;

  if (!document.getElementById('dashCanvas')) {
    container.innerHTML =
      '<div id="dashEmpty" class="dash-empty">' +
        '<div class="dash-empty-glyph">&#x229E;</div>' +
        '<div class="dash-empty-title" data-i18n="dash_empty_title">Your dashboard is empty</div>' +
        '<div class="dash-empty-sub"><span data-i18n="dash_empty_sub_pre">Click </span><kbd>+</kbd><span data-i18n="dash_empty_sub_post"> to add widgets</span></div>' +
      '</div>' +
      '<div id="dashCanvas" class="dash-canvas"></div>';
  }
  if (!document.getElementById('wpOverlay')) {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="wpOverlay" class="wp-overlay"></div>' +
      '<div id="widgetPanel" class="widget-panel">' +
        '<div class="wp-header">' +
          '<span class="wp-title" data-i18n="wp_title">&#x2736; Add Widgets</span>' +
          '<button class="wp-close" id="wpClose">&#xD7;</button>' +
        '</div>' +
        '<div class="wp-body"><div class="wp-grid" id="wpGrid"></div></div>' +
      '</div>' +
      '<button class="add-widget-fab" id="addWidgetFab">+</button>' +
      '<div id="dragGhost"></div>'
    );
  }
  _init();

  function _init() {
    var COLS = 4,
      ROW_H = 160,
      GAP = 14;

    function layoutCols() {
      if (window.innerWidth <= 640) return 1;
      if (window.innerWidth <= 768) return 2;
      return COLS;
    }

    function gridRowHeight() {
      return window.innerWidth <= 640 ? 140 : ROW_H;
    }

    function clampWidgetToLayout(w) {
      var cols = layoutCols();
      w.cs = Math.max(1, Math.min(w.cs || 1, cols));
      w.col = Math.max(1, Math.min(w.col || 1, cols - w.cs + 1));
      w.row = Math.max(1, w.row || 1);
    }

    function normalizeLayoutForViewport(anchorUid) {
      state.forEach(clampWidgetToLayout);
      resolveVerticalOverlaps(anchorUid);
    }

    function _t(key, fallback) {
      var v = window._t && window._t(key);
      // window._t returns the key itself when no translation exists — treat that as "missing"
      // and use the explicit fallback string the caller provided.
      if (!v || v === key) return fallback;
      return v;
    }
    var DEFS = [
      { type: 'courses', icon: '📚', nameKey: 'wdg_courses_name', name: 'Course shortcuts', descKey: 'wdg_courses_desc', desc: 'Jump into a course', cols: 2, rows: 1 },
      { type: 'notes', icon: '📝', nameKey: 'wdg_notes_name', name: 'Quick notes', descKey: 'wdg_notes_desc', desc: 'Personal notepad', cols: 2, rows: 2 },
      { type: 'stats', icon: '📊', nameKey: 'wdg_stats_name', name: 'Study stats', descKey: 'wdg_stats_desc', desc: 'Files & notes counts', cols: 2, rows: 1 },
      { type: 'deadlines', icon: '⏰', nameKey: 'wdg_deadlines_name', name: 'Deadlines', descKey: 'wdg_deadlines_desc', desc: 'Upcoming calendar events', cols: 2, rows: 2 },
      { type: 'wordOfDay', icon: '🇩🇪', nameKey: 'wdg_word_name', name: 'Word of the day', descKey: 'wdg_word_desc', desc: 'A new German word at your level', cols: 2, rows: 2,
        requires: function () { return !!(window._germanLevel); } },
      { type: 'ai', icon: '🤖', nameKey: 'wdg_ai_name', name: 'AI quick chat', descKey: 'wdg_ai_desc', desc: 'Ask anything', cols: 2, rows: 2 },
      { type: 'gcal', icon: '📆', nameKey: 'wdg_gcal_name', name: 'Google Calendar', descKey: 'wdg_gcal_desc', desc: 'View & edit events', cols: 1, rows: 3 },
      { type: 'mastery', icon: '🎯', nameKey: 'wdg_mastery_name', name: 'Practice focus', descKey: 'wdg_mastery_desc', desc: 'Weak topics from your quizzes', cols: 2, rows: 2 },
      { type: 'dailyMission', icon: 'DM', nameKey: 'wdg_daily_mission_name', name: 'Daily Mission', descKey: 'wdg_daily_mission_desc', desc: 'Today\'s study plan', cols: 2, rows: 2 }
    ];
    function defName(def) { return _t(def.nameKey, def.name || def.nameKey); }
    function defDesc(def) { return _t(def.descKey, def.desc || def.descKey); }

    var now = new Date();
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December'
    ];
    var SCHEDULE = {
      0: [
        { time: '10:00', name: 'Study session', color: '#7C3AED' },
        { time: '14:00', name: 'Lab report prep', color: '#F59E0B' }
      ],
      1: [
        { time: '08:00', name: 'Mathematik III', room: 'PK 2.2', color: '#2563EB' },
        { time: '10:00', name: 'Algorithmen & DS', room: 'IZ 160', color: '#7C3AED' },
        { time: '14:00', name: 'Softwaretechnik', room: 'SN 19.2', color: '#22C55E' }
      ],
      2: [
        { time: '09:00', name: 'Analysis I', room: 'SN 19.1', color: '#F59E0B' },
        { time: '13:00', name: 'Physik Praktikum', room: 'PK 4.4', color: '#2563EB' }
      ],
      3: [
        { time: '08:00', name: 'Mathematik III', room: 'PK 2.2', color: '#2563EB' },
        { time: '11:00', name: 'Informatik II', room: 'IZ 305', color: '#7C3AED' },
        { time: '16:00', name: 'Tutorium Analysis', room: 'PK 3.3', color: '#22C55E' }
      ],
      4: [
        { time: '10:00', name: 'Algorithmen & DS', room: 'IZ 160', color: '#7C3AED' },
        { time: '14:00', name: 'Softwaretechnik', room: 'SN 19.2', color: '#22C55E' }
      ],
      5: [
        { time: '08:00', name: 'Analysis I', room: 'SN 19.1', color: '#F59E0B' },
        { time: '12:00', name: 'Seminar', room: 'IZ 105', color: '#2563EB' }
      ],
      6: []
    };

    function widgetBody(type) {
      var day = now.getDay(),
        evs = SCHEDULE[day] || [];
      if (type === 'today') {
        var evHtml = evs.length
          ? evs
              .map(function (e) {
                return (
                  '<div class="tw-event"><span class="tw-dot" style="background:' +
                  e.color +
                  '"></span>' +
                  '<span class="tw-time">' +
                  e.time +
                  '</span><span class="tw-name">' +
                  e.name +
                  '</span>' +
                  (e.room ? '<span class="tw-room">' + e.room + '</span>' : '') +
                  '</div>'
                );
              })
              .join('')
          : '<div class="tw-none">No classes today 🎉</div>';
        return (
          '<div class="tw-date">' +
          DAYS[day] +
          ', ' +
          MONS[now.getMonth()] +
          ' ' +
          now.getDate() +
          '</div>' +
          evHtml
        );
      }
      if (type === 'courses') {
        var sem = SEMS[window.sdActiveSemId];
        var courses = sem && sem.courses && sem.courses.length ? sem.courses : [];
        if (!courses.length)
          return '<div class="tw-none" style="padding:16px;text-align:center;opacity:.5;font-size:.82rem">' + _t('dash_no_courses', 'No courses yet — add some in Subjects') + '</div>';
        return (
          '<div class="cw-pills">' +
          courses
            .slice(0, 8)
            .map(function (c) {
              return '<span class="cw-pill" style="cursor:pointer">' + c.name + '</span>';
            })
            .join('') +
          '</div>'
        );
      }
      if (type === 'notes')
        return (
          '<div class="nw-list"></div>' +
          '<div class="nw-compose" style="display:none;flex-direction:column;gap:8px">' +
          '<textarea class="nw-ta" placeholder="Write your note…" spellcheck="false" style="flex:1;min-height:80px;resize:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;font-family:\'Nunito\',sans-serif;font-size:.82rem;color:#fff;outline:none"></textarea>' +
          '<div style="display:flex;gap:8px">' +
          '<button class="nw-cancel" style="flex:1;padding:8px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:20px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:rgba(255,255,255,.6);cursor:pointer">Cancel</button>' +
          '<button class="nw-save" style="flex:1;padding:8px;background:linear-gradient(135deg,#3b82f6,#0ea5e9);border:none;border-radius:20px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:#fff;cursor:pointer">Save</button>' +
          '</div>' +
          '</div>' +
          '<button class="nw-add-btn" style="margin-top:8px;width:100%;padding:8px;background:rgba(59,130,246,.1);border:1px dashed rgba(59,130,246,.35);border-radius:10px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:rgba(59,130,246,.8);cursor:pointer">+ Add note</button>'
        );
      if (type === 'stats') {
        var fileCount = 0;
        Object.keys(SEMS || {}).forEach(function (semId) {
          ((SEMS[semId] && SEMS[semId].courses) || []).forEach(function (course) {
            fileCount += (course.files || []).length;
            (course.userFolders || []).forEach(function (folder) {
              fileCount += (folder.files || []).length;
            });
          });
        });
        return (
          '<div class="sw-chips"><div class="sw-chip"><div class="sw-val">' + fileCount + '</div><div class="sw-lbl">Files</div></div>' +
          '<div class="sw-chip"><div class="sw-val">' + ((window._qnNotes || []).length) + '</div><div class="sw-lbl">Notes</div></div></div>'
        );
      }
      if (type === 'wordOfDay') {
        return (
          '<div class="wod-root" style="display:flex;flex-direction:column;height:100%;gap:6px">' +
            '<div class="wod-body" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px">' +
              '<div style="opacity:.55;font-size:.78rem;text-align:center;padding:14px;color:var(--muted)">' +
                _t('wod_loading', 'Loading word of the day…') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }
      if (type === 'deadlines') {
        return (
          '<div class="dlw-root" style="display:flex;flex-direction:column;height:100%;gap:6px">' +
            '<div class="dlw-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px">' +
              '<div class="dlw-empty" style="opacity:.5;font-size:.78rem;text-align:center;padding:14px">' +
                _t('dlw_loading', 'Loading upcoming events…') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }
      if (type === 'ai')
        return (
          '<div class="aw-row"><input class="aw-in" placeholder="Ask AI anything…"/><button class="aw-btn">→</button></div>' +
          '<div class="aw-response" style="flex:1;overflow-y:auto;font-size:.8rem;line-height:1.6;color:rgba(255,255,255,.8);padding:4px 2px;display:none"></div>' +
          '<div class="aw-hint">Powered by Minallo AI</div>'
        );
      if (type === 'gcal')
        return '<div class="gcw-root" id="gcwRoot"><div class="gcw-connect"><button class="gcw-connect-btn" id="gcwConnectBtn">' + _t('gcw_connect_btn', 'Connect Google Calendar') + '</button><div class="gcw-connect-sub">' + _t('gcw_connect_sub', 'Sign in with Google to view and edit your events') + '</div></div></div>';
      if (type === 'mastery') {
        // Course picker + sorted mastery list. Initial state shows a loading
        // placeholder; the post-render hook below fetches /api/ai/mastery
        // for the selected course and re-paints. Re-paints again whenever
        // the chatbot or quiz UI dispatches `ss:mastery-updated`.
        return (
          '<div class="mw-root" style="display:flex;flex-direction:column;height:100%;gap:8px">' +
            '<select class="mw-course" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#fff;padding:6px 8px;font-family:\'Nunito\',sans-serif;font-size:.78rem;outline:none"></select>' +
            '<div class="mw-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px">' +
              '<div class="mw-empty" style="opacity:.5;font-size:.78rem;text-align:center;padding:14px">Loading practice focus…</div>' +
            '</div>' +
          '</div>'
        );
      }
      if (type === 'dailyMission') {
        return '<div id="daily-mission-widget" class="dmw-root"><div class="dmw-status">Loading today&rsquo;s mission...</div></div>';
      }
      return '';
    }

    var state = [],
      uid = 1;
    var canvas = document.getElementById('dashCanvas');
    var empty = document.getElementById('dashEmpty');
    var fab = document.getElementById('addWidgetFab');
    var panel = document.getElementById('widgetPanel');
    var overlay = document.getElementById('wpOverlay');
    var wpGrid = document.getElementById('wpGrid');
    var ghost = document.getElementById('dragGhost');
    if (!canvas || !fab || !panel || !overlay || !wpGrid || !ghost) {
      return;
    }
    var dragging = null,
      resizing = null;

    // ── Persist widget layout per user ────────────────────────────────────────
    var _dwSaveTimer = null;
    function _dwSave() {
      clearTimeout(_dwSaveTimer);
      _dwSaveTimer = setTimeout(function () {
        var userId = _currentUser && (_currentUser.id || _currentUser.sub);
        if (!userId) return;
        var payload = state.map(function (w) {
          return { type: w.type, col: w.col, row: w.row, cs: w.cs, rs: w.rs };
        });
        fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId), {
          method: 'PATCH',
          headers: _sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ dashboard_widgets: JSON.stringify(payload) })
        }).catch(function () {});
      }, 600);
    }

    function _dwLoad(callback) {
      var userId = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!userId) {
        if (callback) callback();
        return;
      }

      function _applyWidgetData(raw, rawNotes) {
        if (raw) {
          try {
            var saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(saved) && saved.length)
              state = saved
                .filter(function (w) {
                  return ['today', 'mail', 'weather'].indexOf(w.type) === -1;
                })
                .map(function (w) {
                  return Object.assign({}, w, { uid: uid++ });
                });
          } catch (e) {}
        }
        if (rawNotes) {
          try {
            _qnNotes = JSON.parse(rawNotes) || [];
          } catch (e) {
            _qnNotes = [];
          }
        }
      }
      var lsCache = localStorage.getItem('ss_dash_cache_' + userId);
      if (lsCache) {
        try {
          var c = JSON.parse(lsCache);
          _applyWidgetData(c.widgets, c.notes);
          if (callback) callback();
          callback = null;
        } catch (e) {}
      }

      fetch(
        SUPA_URL +
          '/rest/v1/profiles?id=eq.' +
          encodeURIComponent(userId) +
          '&select=dashboard_widgets,dashboard_notes',
        {
          headers: _sbHeaders()
        }
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (rows) {
          var raw = rows && rows[0] && rows[0].dashboard_widgets;
          var rawNotes = rows && rows[0] && rows[0].dashboard_notes;
          try {
            localStorage.setItem(
              'ss_dash_cache_' + userId,
              JSON.stringify({ widgets: raw, notes: rawNotes })
            );
          } catch (e) {}
          uid = 1;
          state = [];
          _applyWidgetData(raw, rawNotes);
        })
        .catch(function () {})
        .then(function () {
          if (callback) callback();
          else if (typeof window._dwRenderOnly === 'function') window._dwRenderOnly();
        });
    }

    function overlap(a, b) {
      return !(
        a.col + a.cs <= b.col ||
        b.col + b.cs <= a.col ||
        a.row + a.rs <= b.row ||
        b.row + b.rs <= a.row
      );
    }
    function horizontalOverlap(a, b) {
      return !(a.col + a.cs <= b.col || b.col + b.cs <= a.col);
    }
    function isFree(col, row, cs, rs) {
      var t = { col: col, row: row, cs: cs, rs: rs };
      return !state.some(function (w) {
        return overlap(w, t);
      });
    }
    function findFree(cs, rs) {
      var cols = layoutCols();
      cs = Math.min(cs, cols);
      for (var r = 1; r <= 20; r++)
        for (var c = 1; c <= cols - cs + 1; c++)
          if (isFree(c, r, cs, rs)) return { col: c, row: r };
      return { col: 1, row: 1 };
    }

    function compact() {
      state.sort(function (a, b) {
        return a.row !== b.row ? a.row - b.row : a.col - b.col;
      });
      state.forEach(function (w) {
        for (var r = 1; r < w.row; r++) {
          var cand = { col: w.col, row: r, cs: w.cs, rs: w.rs };
          if (
            !state.some(function (x) {
              return x.uid !== w.uid && overlap(x, cand);
            })
          ) {
            w.row = r;
            break;
          }
        }
      });
    }

    function packDownFrom(anchorUid) {
      var anchor = state.find(function (x) {
        return x.uid === anchorUid;
      });
      var changed = true;
      var guard = 0;
      while (changed && guard++ < 120) {
        changed = false;
        state
          .slice()
          .sort(function (a, b) {
            if (a.uid === anchorUid) return -1;
            if (b.uid === anchorUid) return 1;
            return a.row !== b.row ? a.row - b.row : a.col - b.col;
          })
          .forEach(function (top) {
            state.forEach(function (candidate) {
              if (top.uid === candidate.uid) return;
              if (candidate.uid === anchorUid) return;
              if (!horizontalOverlap(top, candidate)) return;
              if (!overlap(top, candidate)) return;
              var nextRow = top.row + top.rs;
              if (anchor && candidate.row < anchor.row) return;
              if (candidate.row !== nextRow) {
                candidate.row = nextRow;
                changed = true;
              }
            });
          });
      }
    }

    function renderAnimated() {
      var snap = {};
      canvas.querySelectorAll('.dash-widget').forEach(function (el) {
        snap[el.dataset.uid] = el.getBoundingClientRect();
      });
      normalizeLayoutForViewport();
      compact();
      render();
      canvas.querySelectorAll('.dash-widget').forEach(function (el) {
        var prev = snap[el.dataset.uid];
        if (!prev) return;
        var cur = el.getBoundingClientRect();
        var dx = prev.left - cur.left,
          dy = prev.top - cur.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            el.style.transition = '';
            el.style.transform = '';
          });
        });
      });
    }

    function computeDrop(w, col, row) {
      var cols = layoutCols();
      var newPos = { col: col, row: row, cs: w.cs, rs: w.rs };
      var displaced = state.filter(function (x) {
        return x.uid !== w.uid && overlap(x, newPos);
      });
      if (!displaced.length) return [];
      var tempUsed = state
        .filter(function (x) {
          return (
            x.uid !== w.uid &&
            !displaced.some(function (d) {
              return d.uid === x.uid;
            })
          );
        })
        .map(function (x) {
          return { col: x.col, row: x.row, cs: x.cs, rs: x.rs };
        });
      tempUsed.push({ col: col, row: row, cs: w.cs, rs: w.rs });
      var moves = [];
      displaced.forEach(function (d) {
        var preferred = { col: w.col, row: w.row, cs: d.cs, rs: d.rs };
        var fits =
          w.col + d.cs - 1 <= cols &&
          !tempUsed.some(function (t) {
            return overlap(t, preferred);
          });
        var dest;
        if (fits) {
          dest = { col: w.col, row: w.row };
        } else {
          dest = null;
          scan: for (var r = 1; r <= 20; r++) {
            for (var c = 1; c <= cols - d.cs + 1; c++) {
              var cand = { col: c, row: r, cs: d.cs, rs: d.rs };
              if (
                !tempUsed.some(function (t) {
                  return overlap(t, cand);
                })
              ) {
                dest = { col: c, row: r };
                break scan;
              }
            }
          }
          if (!dest) dest = { col: w.col, row: w.row };
        }
        moves.push({ uid: d.uid, col: dest.col, row: dest.row, cs: d.cs, rs: d.rs });
        tempUsed.push({ col: dest.col, row: dest.row, cs: d.cs, rs: d.rs });
      });
      return moves;
    }

    function updateWidgetGridPositions() {
      normalizeLayoutForViewport(resizing && resizing.uid);
      canvas.querySelectorAll('.dash-widget').forEach(function (el) {
        var u = +el.dataset.uid;
        var w = state.find(function (x) {
          return x.uid === u;
        });
        if (!w) return;
        var mCols = layoutCols();
        var mCs = Math.min(w.cs, mCols),
          mCol = Math.min(w.col, mCols - mCs + 1);
        el.style.gridColumn = mCol + ' / span ' + mCs;
        el.style.gridRow = w.row + ' / span ' + w.rs;
      });
    }

    function resolveVerticalOverlaps(anchorUid) {
      if (anchorUid) packDownFrom(anchorUid);
      else {
        var changed = true;
        var guard = 0;
        while (changed && guard++ < 120) {
          changed = false;
          state
            .slice()
            .sort(function (a, b) {
              return a.row !== b.row ? a.row - b.row : a.col - b.col;
            })
            .forEach(function (top) {
              state.forEach(function (below) {
                if (top.uid === below.uid) return;
                if (!horizontalOverlap(top, below)) return;
                if (!overlap(top, below)) return;
                if (below.row < top.row) return;
                below.row = top.row + top.rs;
                changed = true;
              });
            });
        }
      }
      if (anchorUid) {
        var anchor = state.find(function (x) {
          return x.uid === anchorUid;
        });
        if (anchor) {
          var cols = layoutCols();
          anchor.cs = Math.min(anchor.cs, cols);
          anchor.col = Math.max(1, Math.min(anchor.col, cols - anchor.cs + 1));
        }
      }
    }

    function render() {
      normalizeLayoutForViewport();
      canvas.innerHTML = '';
      state.forEach(function (w) {
        var def = DEFS.find(function (d) {
          return d.type === w.type;
        });
        var el = document.createElement('div');
        el.className = 'dash-widget';
        if (w.type === 'dailyMission') el.classList.add('dash-widget--daily-mission');
        el.dataset.uid = w.uid;
        var mCols = layoutCols();
        var mCs = Math.min(w.cs, mCols),
          mCol = Math.min(w.col, mCols - mCs + 1);
        el.style.gridColumn = mCol + ' / span ' + mCs;
        el.style.gridRow = w.row + ' / span ' + w.rs;
        el.innerHTML =
          '<div class="dw-header"><span class="dw-icon">' +
          (def ? def.icon : '') +
          '</span><span class="dw-title">' +
          (def ? defName(def) : '') +
          '</span><button class="dw-remove">\xD7</button></div>' +
          '<div class="dw-body">' +
          widgetBody(w.type) +
          '</div>' +
          '<div class="dw-resize"></div>';
        canvas.appendChild(el);
      });
      if (empty) empty.style.display = state.length ? 'none' : 'flex';
      canvas.querySelectorAll('.dw-header').forEach(bindDrag);
      canvas.querySelectorAll('.dw-resize').forEach(bindResize);
      canvas.querySelectorAll('.dw-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var u = +btn.closest('.dash-widget').dataset.uid;
          state = state.filter(function (w) {
            return w.uid !== u;
          });
          renderAnimated();
          _dwSave();
        });
      });
      canvas.querySelectorAll('.cw-pill').forEach(function (pill) {
        pill.addEventListener('click', function () {
          var name = pill.textContent.trim();
          var sem = SEMS[window.sdActiveSemId];
          var course =
            sem &&
            sem.courses &&
            sem.courses.find(function (c) {
              return c.name === name;
            });
          if (!course) return;
          setNavActive('pcStudip');
          // Update ss_portal_tab via the portal-section call so a later refresh
          // doesn't think we're still on the dashboard and wipe ss_state.
          if (typeof window.showPortalSection === 'function') {
            window.showPortalSection('studip');
          }
          _showFilesView();
          openCourse(course);
        });
      });
      // Same Minallo app map the in-PDF and chatbot prompts use, so the
      // dashboard widget can answer "how do I upload a doc / where is X /
      // what is this site" with concrete steps instead of vague generics.
      var WIDGET_APP_CONTEXT =
        'You are Minallo AI, the assistant for Minallo at minallo.de — a study platform + AI tutor for university students. ' +
        'You ARE on Minallo right now. Never say "I don\'t know which site I\'m on".\n\n' +
        'For product/navigation questions, give numbered steps naming the exact sidebar item, tab and button. ' +
        'Do NOT say "look for the Upload button" — use this map:\n' +
        'SIDEBAR (top→bottom):\n' +
        '1. Home — dashboard / widgets / greeting.\n' +
        '2. Courses — semesters and courses. Inside a course: Files | Notes | Summaries | Quiz | Flashcards | Forum | Calendar tabs.\n' +
        '3. Lecture Notes — every generated note/summary across courses.\n' +
        '4. Editor — Writer (rich-text + AI), PDF Editor (annotate/sign), PDF Merger (combine PDFs).\n' +
        '5. Chatbot — general Minallo AI chat with files/images.\n' +
        '6. Chat — student/friend chat rooms (Öffentlich / Freunde / Nur mit Einladung) + NSFW + slow-mode toggles.\n' +
        '7. Games — "🎮 Game Room" hub. Tetris, Chess, Flappy Bird, and Solitaire with 7 variants (Klondike, Spider, Freecell, Pyramid, Scorpion, TriPeaks, Vegas).\n' +
        '8. Study Lounge — total minutes, current/longest streak, opened files, per-course breakdown, weekly chart, Reset stats.\n' +
        '9. Profile — account profile.\n' +
        '10. Settings — language DE/EN, German level + test type, sign-out, delete account.\n' +
        '11. Subscription — plan, Stripe billing portal, PayPal pause/resume/cancel/reactivate, retention discount.\n' +
        '12. Admin — admin-only tools (admins only).\n' +
        'Top bar "Study" = focus timer. Sidebar bottom "Night" = dark/light toggle. Footer: Impressum + Privacy Policy.\n\n' +
        'UPLOAD A DOCUMENT: 1) Click Courses in the sidebar. 2) Open the semester, open the course. ' +
        '3) On the Files tab, click "+ Upload" or drag-and-drop. PDF/TXT/DOCX/PNG/JPG, max 25 MB (6 MB images). ' +
        '4) Indexing runs automatically; then open the PDF and click the AI button on the right.\n\n' +
        'PDF VIEWER toolbar: Page/zoom/Fit/Single-page/Annotate/Download. Right rail: AI chat, Problem solver, Notes, Summary. ' +
        'Open a second PDF tab for split view. Annotate popover: Pen / Highlight / Text / Eraser, colours, thickness, Undo, Clear, Save, Upload.\n\n' +
        'PROBLEM SOLVER MODES (AI panel → Problem): Hint, Setup (Given/Required/Formula), Check (verify your work), Solve, Practice (similar problem).\n\n' +
        'GENERATING MATERIAL: inside a course, Notes/Summaries/Quiz/Flashcards tabs each have a "Generate" button.\n\n' +
        'STYLE: numbered steps, name the exact UI element, suggest the next action. If a feature is not in this map, say so plainly; do not invent one.';

      function _sendWidgetAI(widget) {
        var inp = widget.querySelector('.aw-in');
        var btn = widget.querySelector('.aw-btn');
        var resp = widget.querySelector('.aw-response');
        var hint = widget.querySelector('.aw-hint');
        var q = inp && inp.value.trim();
        if (!q || btn.disabled) return;
        inp.value = '';
        btn.disabled = true;
        btn.textContent = '…';
        resp.style.display = 'block';
        resp.textContent = 'Thinking…';
        if (hint) hint.style.display = 'none';
        fetch(BACKEND_URL + '/api/ai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (window._sbToken || '')
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            system: WIDGET_APP_CONTEXT,
            messages: [{ role: 'user', content: q }]
          })
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var text = data.error
              ? 'Error: ' + (data.error.message || 'unknown')
              : data.content
                ? data.content
                    .map(function (b) {
                      return b.text || '';
                    })
                    .join('')
                : 'No response';
            resp.innerHTML = renderMarkdown(text);
          })
          .catch(function () {
            resp.textContent = 'Could not reach AI. Try again.';
          })
          .then(function () {
            btn.disabled = false;
            btn.textContent = '→';
          });
      }
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var btn = body.querySelector('.aw-btn');
        var inp = body.querySelector('.aw-in');
        if (!btn || !inp) return;
        btn.addEventListener('click', function () {
          _sendWidgetAI(body);
        });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') _sendWidgetAI(body);
        });
      });

      // ── Word of the Day widget binding (German learners) ──────────────────
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var root = body.querySelector('.wod-root');
        if (!root || body._wodBound) return;
        body._wodBound = true;
        var bodyEl = root.querySelector('.wod-body');

        function _wodEsc(s) {
          return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
          });
        }

        function _wodRender(d) {
          if (!d || !d.word) {
            bodyEl.innerHTML =
              '<div style="opacity:.55;font-size:.78rem;text-align:center;padding:14px;color:var(--text)">' +
              _t('wod_error', 'Could not load the word of the day. Try again later.') +
              '</div>';
            return;
          }
          var formsHtml = '';
          if (d.forms && Array.isArray(d.forms.rows) && d.forms.rows.length) {
            formsHtml =
              '<div style="margin-top:4px">' +
                '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);opacity:.75;margin-bottom:4px">' +
                  _wodEsc(d.forms.label || _t('wod_forms', 'Forms')) +
                '</div>' +
                '<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:.74rem">' +
                  d.forms.rows.map(function (r) {
                    return (
                      '<span style="color:var(--muted)">' + _wodEsc(r[0]) + '</span>' +
                      '<span style="color:var(--text)">' + _wodEsc(r[1]) + '</span>'
                    );
                  }).join('') +
                '</div>' +
              '</div>';
          }
          bodyEl.innerHTML =
            '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">' +
              '<span style="font-size:1.15rem;font-weight:800;color:var(--text)">' + _wodEsc(d.word) + '</span>' +
              (d.pos ? '<span style="font-size:.7rem;color:var(--muted);font-style:italic">' + _wodEsc(d.pos) + '</span>' : '') +
              '<span style="margin-left:auto;font-size:.66rem;padding:2px 7px;border-radius:10px;background:rgba(59,130,246,.18);color:#3b82f6;font-weight:700">' + _wodEsc(window._germanLevel || '') + '</span>' +
            '</div>' +
            (d.translation ? '<div style="font-size:.82rem;color:var(--text);opacity:.92">' + _wodEsc(d.translation) + '</div>' : '') +
            (d.example && d.example.de ? (
              '<div style="padding:8px 10px;background:rgba(127,127,127,.08);border-radius:8px">' +
                '<div style="font-size:.78rem;color:var(--text);line-height:1.4">' + _wodEsc(d.example.de) + '</div>' +
                (d.example.en ? '<div style="font-size:.72rem;color:var(--muted);margin-top:2px">' + _wodEsc(d.example.en) + '</div>' : '') +
              '</div>'
            ) : '') +
            formsHtml;
        }

        function _wodLoad() {
          var level = window._germanLevel;
          if (!level) {
            bodyEl.innerHTML =
              '<div style="opacity:.75;font-size:.78rem;text-align:center;padding:14px;line-height:1.5;color:var(--muted)">' +
              _t('wod_set_level', 'Set your German level on your profile to see a daily word.') +
              '</div>';
            return;
          }
          var uid = (_currentUser && (_currentUser.id || _currentUser.sub)) || 'anon';
          var today = new Date().toISOString().slice(0, 10);
          var cacheKey = 'ss_wod_' + uid + '_' + level + '_' + today;
          var historyKey = 'ss_wod_history_' + uid + '_' + level;
          try {
            var cached = localStorage.getItem(cacheKey);
            if (cached) {
              _wodRender(JSON.parse(cached));
              return;
            }
          } catch (e) {}

          var history = [];
          try {
            var hraw = localStorage.getItem(historyKey);
            if (hraw) history = JSON.parse(hraw) || [];
            if (!Array.isArray(history)) history = [];
          } catch (e) { history = []; }
          var recentWords = history.slice(0, 30).map(function (h) { return h && h.word; }).filter(Boolean);

          bodyEl.innerHTML =
            '<div style="opacity:.55;font-size:.78rem;text-align:center;padding:14px;color:var(--muted)">' +
            _t('wod_loading', 'Loading word of the day…') +
            '</div>';

          var exclusionLine = recentWords.length
            ? '\nDo NOT pick any of these words (the learner has already seen them recently): ' +
              recentWords.join(', ') + '.'
            : '';

          var prompt =
            'Pick ONE German word appropriate for a learner at CEFR level ' + level +
            ' to learn on ' + today + '. Vary the part of speech day-to-day.' +
            exclusionLine + '\n' +
            'Return ONLY this JSON, no markdown, no commentary:\n' +
            '{"word":"...","pos":"noun|verb|adjective|adverb|preposition|conjunction",' +
            '"translation":"<short English>","example":{"de":"<one natural German sentence using the word>","en":"<English translation>"},' +
            '"forms":{"label":"<Conjugation|Declension|Comparison|Usage>","rows":[["form","value"], ...]}}\n' +
            'For verbs: forms.rows = 6 present-tense persons (ich/du/er-sie-es/wir/ihr/sie-Sie) + Infinitiv + Präteritum (ich-form). ' +
            'For nouns: forms.rows = Artikel, Plural, Genitiv (singular), Genus (m/f/n). ' +
            'For adjectives: Komparativ, Superlativ. ' +
            'For other parts of speech: 2-3 short usage notes as rows.';

          fetch((window.BACKEND_URL || '') + '/api/ai', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + (window._sbToken || '')
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 600,
              messages: [{ role: 'user', content: prompt }]
            })
          })
            .then(function (r) {
              if (r.status === 402) {
                bodyEl.innerHTML =
                  '<div style="opacity:.85;font-size:.78rem;text-align:center;padding:14px;line-height:1.5;color:var(--muted)">' +
                  _t('wod_paywall', 'An active Minallo subscription is required to see your daily German word.') +
                  '</div>';
                return null;
              }
              return r.json();
            })
            .then(function (data) {
              if (!data) return;
              var text = data && data.content
                ? data.content.map(function (b) { return b.text || ''; }).join('')
                : '';
              var json = null;
              try {
                var m = text.match(/\{[\s\S]*\}/);
                if (m) json = JSON.parse(m[0]);
              } catch (e) {}
              if (json && json.word) {
                try { localStorage.setItem(cacheKey, JSON.stringify(json)); } catch (e) {}
                try {
                  var newHist = [{ word: json.word, date: today }]
                    .concat(history.filter(function (h) { return h && h.word !== json.word; }))
                    .slice(0, 60);
                  localStorage.setItem(historyKey, JSON.stringify(newHist));
                } catch (e) {}
                _wodRender(json);
              } else {
                _wodRender(null);
              }
            })
            .catch(function () { _wodRender(null); });
        }

        _wodLoad();
      });

      // ── Deadlines widget binding (Google Calendar) ────────────────────────
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var root = body.querySelector('.dlw-root');
        if (!root || body._dlwBound) return;
        body._dlwBound = true;
        var list = root.querySelector('.dlw-list');

        function _dlwEsc(s) {
          return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
          });
        }

        function _dlwFmt(ev) {
          var s = ev.start && (ev.start.dateTime || ev.start.date);
          if (!s) return '';
          var d = new Date(s);
          var allDay = !ev.start.dateTime;
          var now = new Date();
          var msDay = 86400000;
          var dayDiff = Math.floor(
            (new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
              new Date(now.getFullYear(), now.getMonth(), now.getDate())) /
              msDay
          );
          var label;
          if (dayDiff === 0) label = _t('dlw_today', 'Today');
          else if (dayDiff === 1) label = _t('dlw_tomorrow', 'Tomorrow');
          else if (dayDiff > 1 && dayDiff < 7)
            label = d.toLocaleDateString([], { weekday: 'long' });
          else label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          if (!allDay) {
            label +=
              ' · ' +
              d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
          return label;
        }

        function _dlwRender(events) {
          if (!events || !events.length) {
            list.innerHTML =
              '<div class="dlw-empty" style="opacity:.55;font-size:.78rem;text-align:center;padding:14px">' +
              _t('dlw_no_events', 'No upcoming events in the next 30 days.') +
              '</div>';
            return;
          }
          list.innerHTML = events
            .slice(0, 8)
            .map(function (ev) {
              var title = _dlwEsc(ev.summary || '(No title)');
              var when = _dlwEsc(_dlwFmt(ev));
              return (
                '<div style="display:flex;flex-direction:column;gap:2px;padding:8px 10px;background:rgba(255,255,255,.05);border-radius:8px">' +
                  '<div style="font-size:.8rem;color:rgba(255,255,255,.9);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
                  title + '">' + title + '</div>' +
                  '<div style="font-size:.7rem;color:rgba(255,255,255,.55)">' + when + '</div>' +
                '</div>'
              );
            })
            .join('');
        }

        function _dlwRenderConnect() {
          list.innerHTML =
            '<div class="dlw-empty" style="opacity:.7;font-size:.78rem;text-align:center;padding:14px;line-height:1.5">' +
            _t('dlw_connect', 'Connect Google Calendar to see upcoming deadlines.') +
            '</div>';
        }

        function _dlwLoad() {
          var tok = null;
          try {
            var raw = sessionStorage.getItem('ss_gcal_token');
            if (raw) {
              var d = JSON.parse(raw);
              if (d && d.token && d.expiry > Date.now()) tok = d.token;
            }
          } catch (e) {}
          if (!tok) {
            _dlwRenderConnect();
            return;
          }
          var now = new Date();
          var end = new Date(now.getTime() + 30 * 86400000);
          var url =
            'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
            '?singleEvents=true&orderBy=startTime&maxResults=20' +
            '&timeMin=' + encodeURIComponent(now.toISOString()) +
            '&timeMax=' + encodeURIComponent(end.toISOString());
          fetch(url, { headers: { Authorization: 'Bearer ' + tok } })
            .then(function (r) { return r.ok ? r.json() : { items: [] }; })
            .then(function (data) { _dlwRender((data && data.items) || []); })
            .catch(function () { _dlwRender([]); });
        }

        _dlwLoad();

        window.addEventListener('ss:gcal-events-updated', function () {
          _dlwLoad();
        });
      });

      // ── Mastery widget binding ────────────────────────────────────────────
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var root = body.querySelector('.mw-root');
        if (!root || body._mwBound) return;
        body._mwBound = true;

        var sel = root.querySelector('.mw-course');
        var list = root.querySelector('.mw-list');

        function _allCourses() {
          var out = [];
          Object.keys(SEMS || {}).forEach(function (semId) {
            ((SEMS[semId] && SEMS[semId].courses) || []).forEach(function (c) {
              if (c && c.id) out.push({ id: c.id, name: c.name || c.id });
            });
          });
          // Phase 3: Schreibtrainer feeds writing weaknesses into the same
          // table under a sentinel course_id; expose it as its own picker
          // option so the user can see german:* topics alongside quizzes.
          out.push({ id: '_writing_coach', name: 'Schreibtrainer (German)' });
          return out;
        }

        function _renderList(rows) {
          if (!rows || !rows.length) {
            list.innerHTML =
              '<div class="mw-empty" style="opacity:.6;font-size:.78rem;text-align:center;padding:14px;line-height:1.4">' +
              _t('mastery_take_quiz', 'Take a quiz to see your practice focus for this course.') + '</div>';
            return;
          }
          // Sorted weakest-first server-side. Show top 6.
          var top = rows.slice(0, 6);
          list.innerHTML = top.map(function (r, i) {
            var pct = Math.max(0, Math.min(100, Math.round((r.mastery_score || 0) * 100)));
            var bad = pct < 50;
            var color = bad ? '#ef4444' : pct < 75 ? '#f59e0b' : '#22c55e';
            var rawTopic = String(r.topic || '');
            var name = rawTopic.replace(/[<>&]/g, function (c) {
              return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
            });
            return (
              '<div class="mw-row" data-mw-topic-idx="' + i + '" style="display:flex;flex-direction:column;gap:3px">' +
                '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
                  '<span style="font-size:.78rem;color:rgba(255,255,255,.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + name + '">' + name + '</span>' +
                  '<span style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
                    '<span style="font-size:.72rem;color:rgba(255,255,255,.55)">' + pct + '%</span>' +
                    '<button class="mw-practice" data-mw-practice="' + i + '" title="Practice this topic" ' +
                      'style="background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.4);color:#93c5fd;font-family:\'Nunito\',sans-serif;font-size:.66rem;font-weight:700;padding:2px 7px;border-radius:10px;cursor:pointer">' +
                      'Practice' +
                    '</button>' +
                  '</span>' +
                '</div>' +
                '<div style="height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden">' +
                  '<div style="width:' + pct + '%;height:100%;background:' + color + ';transition:width .25s ease"></div>' +
                '</div>' +
              '</div>'
            );
          }).join('');

          // Wire Practice buttons. Drops a seed into sessionStorage and
          // navigates to the chatbot, which consumes the seed on mount
          // (see shell.ts: consumePracticeSeed).
          list.querySelectorAll('[data-mw-practice]').forEach(function (btn) {
            btn.addEventListener('click', function (ev) {
              ev.stopPropagation();
              var idx = parseInt(btn.getAttribute('data-mw-practice'), 10);
              var row = top[idx];
              if (!row || !row.topic) return;
              // Schreibtrainer topics are namespaced "german:<category>".
              // Strip the prefix for the practice prompt so it reads naturally.
              var displayTopic = String(row.topic).replace(/^german:/, '');
              var courseId = sel.value;
              var isWriting = courseId === '_writing_coach' || /^german:/.test(row.topic);
              var prompt = isWriting
                ? 'Quiz me on the German grammar topic "' + displayTopic + '". Give me 3-5 multiple-choice questions.'
                : 'Quiz me on "' + displayTopic + '". Give me 3-5 multiple-choice questions grounded in my course material.';
              try {
                sessionStorage.setItem('ss_practice_seed', JSON.stringify({
                  topic: row.topic,
                  courseId: courseId,
                  prompt: prompt
                }));
              } catch (e) { /* ignore */ }
              if (typeof window.setNavActive === 'function') window.setNavActive('psbAIPage');
              if (typeof window.showPortalSection === 'function') {
                window.showPortalSection('aipage');
              }
            });
          });
        }

        function _fetch(courseId) {
          if (!courseId) { _renderList([]); return; }
          list.innerHTML = '<div class="mw-empty" style="opacity:.5;font-size:.78rem;text-align:center;padding:14px">Loading…</div>';
          var token = window._sbToken || '';
          fetch((window.BACKEND_URL || '') + '/api/ai/mastery?courseId=' + encodeURIComponent(courseId), {
            headers: { Authorization: 'Bearer ' + token }
          })
            .then(function (r) { return r.ok ? r.json() : { mastery: [] }; })
            .then(function (data) { _renderList(data && data.mastery); })
            .catch(function () { _renderList([]); });
        }

        var courses = _allCourses();
        if (!courses.length) {
          sel.innerHTML = '<option>' + _t('dash_no_courses_short', 'No courses yet') + '</option>';
          list.innerHTML = '<div class="mw-empty" style="opacity:.6;font-size:.78rem;text-align:center;padding:14px">Add a course in Subjects to start tracking your practice focus.</div>';
          return;
        }
        sel.innerHTML = courses.map(function (c) {
          return '<option value="' + c.id + '">' + (c.name || c.id) + '</option>';
        }).join('');
        // Restore last selection per user-local preference.
        var lastKey = 'ss_mastery_widget_course';
        var last = null;
        try { last = localStorage.getItem(lastKey); } catch (e) {}
        if (last && courses.some(function (c) { return c.id === last; })) sel.value = last;
        var initial = sel.value || courses[0].id;
        sel.value = initial;
        _fetch(initial);
        sel.addEventListener('change', function () {
          try { localStorage.setItem(lastKey, sel.value); } catch (e) {}
          _fetch(sel.value);
        });

        // Re-render after a quiz submit updates mastery for the current course.
        window.addEventListener('ss:mastery-updated', function (e) {
          var d = (e && e.detail) || {};
          if (!d.courseId || d.courseId !== sel.value) return;
          if (Array.isArray(d.mastery)) _renderList(d.mastery);
          else _fetch(sel.value);
        });
      });
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var list = body.querySelector('.nw-list');
        var compose = body.querySelector('.nw-compose');
        var ta = body.querySelector('.nw-ta');
        var addBtn = body.querySelector('.nw-add-btn');
        var saveBtn = body.querySelector('.nw-save');
        var cancelBtn = body.querySelector('.nw-cancel');
        if (!list || !addBtn) return;
        if (body._nwBound) {
          body._nwRender && body._nwRender();
          return;
        }
        body._nwBound = true;

        var _editingIdx = -1;

        function _nwOpenCompose(idx) {
          _editingIdx = idx;
          ta.value = idx >= 0 ? _qnNotes[idx].text : '';
          compose.style.display = 'flex';
          addBtn.style.display = 'none';
          ta.focus();
        }

        function _nwCloseCompose() {
          _editingIdx = -1;
          ta.value = '';
          compose.style.display = 'none';
          addBtn.style.display = '';
        }

        function _nwRender() {
          list.innerHTML = '';
          (_qnNotes || []).forEach(function (n, i) {
            var d = document.createElement('div');
            d.style.cssText =
              'padding:8px 10px;background:rgba(255,255,255,.05);border-radius:8px;font-size:.78rem;color:rgba(255,255,255,.75);line-height:1.5;position:relative;margin-bottom:6px;white-space:pre-wrap;word-break:break-word;padding-right:22px;cursor:pointer';
            d.title = 'Click to edit';
            d.textContent = n.text;
            d.addEventListener('click', function (e) {
              if (!e.target.closest('button')) _nwOpenCompose(i);
            });
            var del = document.createElement('button');
            del.textContent = '\xD7';
            del.title = 'Delete';
            del.style.cssText =
              'position:absolute;top:4px;right:4px;background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:.9rem;line-height:1';
            del.addEventListener('click', function () {
              _qnNotes.splice(i, 1);
              _nwSave();
              _nwRender();
            });
            d.appendChild(del);
            list.appendChild(d);
          });
          if (!(_qnNotes && _qnNotes.length))
            list.innerHTML =
              '<div style="font-size:.78rem;color:rgba(255,255,255,.25);text-align:center;padding:8px 0">No notes yet</div>';
        }

        function _nwSave() {
          var uid = _currentUser && (_currentUser.id || _currentUser.sub);
          if (!uid) return;
          fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
            method: 'PATCH',
            headers: _sbHeaders({ Prefer: 'return=minimal' }),
            body: JSON.stringify({ dashboard_notes: JSON.stringify(_qnNotes) })
          }).catch(function () {});
        }

        body._nwRender = _nwRender;
        _nwRender();

        addBtn.addEventListener('click', function () {
          _nwOpenCompose(-1);
        });
        cancelBtn.addEventListener('click', function () {
          _nwCloseCompose();
        });
        saveBtn.addEventListener('click', function () {
          var txt = ta.value.trim();
          if (!txt) return;
          if (!_qnNotes) _qnNotes = [];
          if (_editingIdx >= 0) {
            _qnNotes[_editingIdx].text = txt;
            _qnNotes[_editingIdx].ts = Date.now();
          } else {
            _qnNotes.unshift({ text: txt, ts: Date.now() });
          }
          _nwSave();
          _nwRender();
          _nwCloseCompose();
        });
      });
      canvas.querySelectorAll('.dw-body').forEach(function (body) {
        var root = body.querySelector('#daily-mission-widget');
        if (!root || root._dmwBound) return;
        root._dmwBound = true;
        // Hand off rendering to the multi-subject Daily Mission system
        // (daily-mission-ui.ts). It owns #daily-mission-widget and paints the
        // full task list. On resize/move the dashboard recreates this element,
        // so we re-trigger its render() — which repaints instantly from memory
        // (no API call) and keeps the list from disappearing.
        // Cache-bust with assetVersion: dynamic module imports have no ?v= by
        // default, so the browser/CDN can serve a stale copy without render().
        // NOTE: dashboard-widget.js is a CLASSIC script, so import() resolves
        // against the document base URL (site root). A bare specifier like
        // 'js/…' is treated as a module name and throws "Failed to resolve
        // module specifier". Use an absolute '/js/…' path so it resolves.
        var _dmV = (window.MinalloConfig && window.MinalloConfig.assetVersion) || '';
        import('/js/features/daily-mission/daily-mission-ui.js?v=' + _dmV)
          .then(function (mod) {
            // Call the export off the module namespace directly — robust against
            // window._dailyMission being clobbered by another module instance.
            if (mod && typeof mod.renderDashboardWidget === 'function') {
              mod.renderDashboardWidget();
            } else if (window._dailyMission && typeof window._dailyMission.render === 'function') {
              window._dailyMission.render();
            }
          })
          .catch(function (e) { console.error('[DailyMission] dashboard import failed:', e); });
      });
      updateCards();
    }

    function getCellAt(ax, ay) {
      var r = canvas.getBoundingClientRect();
      var cols = layoutCols();
      var cw = (r.width + GAP) / cols,
        ch = gridRowHeight() + GAP;
      return {
        col: Math.max(1, Math.min(Math.floor((ax - r.left) / cw) + 1, cols)),
        row: Math.max(1, Math.floor((ay - r.top) / ch) + 1)
      };
    }

    function bindDrag(hdr) {
      hdr.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        if (e.target.closest('.dw-remove')) return;
        var el = hdr.closest('.dash-widget'),
          u = +el.dataset.uid;
        var w = state.find(function (x) {
          return x.uid === u;
        });
        if (!w) return;
        e.preventDefault();
        var rect = el.getBoundingClientRect();
        dragging = {
          uid: u,
          offX: e.clientX - rect.left,
          offY: e.clientY - rect.top,
          cs: w.cs,
          rs: w.rs,
          lastCell: null
        };
        el.classList.add('is-dragging');
        ghost.style.cssText =
          'display:block;width:' +
          rect.width +
          'px;height:' +
          rect.height +
          'px;left:' +
          (e.clientX - dragging.offX) +
          'px;top:' +
          (e.clientY - dragging.offY) +
          'px';
        try {
          hdr.setPointerCapture(e.pointerId);
        } catch (err) {}
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd);
        document.addEventListener('pointercancel', onDragCancel);
      });

      function clearDragListeners() {
        document.removeEventListener('pointermove', onDragMove);
        document.removeEventListener('pointerup', onDragEnd);
        document.removeEventListener('pointercancel', onDragCancel);
      }

      function onDragMove(e) {
        if (!dragging) return;
        e.preventDefault();
        ghost.style.left = e.clientX - dragging.offX + 'px';
        ghost.style.top = e.clientY - dragging.offY + 'px';
        var cell = getCellAt(e.clientX - dragging.offX, e.clientY - dragging.offY);
        var cols = layoutCols();
        var col = Math.min(cell.col, cols - Math.min(dragging.cs, cols) + 1),
          row = Math.max(1, cell.row);
        var lc = dragging.lastCell;
        if (lc && lc.col === col && lc.row === row) return;
        dragging.lastCell = { col: col, row: row };
        var w = state.find(function (x) {
          return x.uid === dragging.uid;
        });
        if (!w) return;
        canvas.querySelectorAll('.dash-widget:not(.is-dragging)').forEach(function (el) {
          el.style.transform = '';
        });
        var canvasRect = canvas.getBoundingClientRect();
        var cw = (canvasRect.width + GAP) / cols,
          ch = gridRowHeight() + GAP;
        computeDrop(w, col, row).forEach(function (move) {
          var el = canvas.querySelector('[data-uid="' + move.uid + '"]');
          if (!el) return;
          var cur = el.getBoundingClientRect();
          el.style.transform =
            'translate(' +
            (canvasRect.left + (move.col - 1) * cw - cur.left) +
            'px,' +
            (canvasRect.top + (move.row - 1) * ch - cur.top) +
            'px)';
        });
      }

      function onDragCancel() {
        if (!dragging) return;
        clearDragListeners();
        ghost.style.display = 'none';
        var el2 = canvas.querySelector('[data-uid="' + dragging.uid + '"]');
        if (el2) el2.classList.remove('is-dragging');
        dragging = null;
        renderAnimated();
      }

      function onDragEnd(e) {
        if (!dragging) return;
        clearDragListeners();
        var cell = getCellAt(e.clientX - dragging.offX, e.clientY - dragging.offY);
        var w = state.find(function (x) {
          return x.uid === dragging.uid;
        });
        if (w) {
          var cols = layoutCols();
          w.cs = Math.min(w.cs, cols);
          var newCol = Math.min(cell.col, cols - w.cs + 1),
            newRow = Math.max(1, cell.row);
          computeDrop(w, newCol, newRow).forEach(function (move) {
            var d = state.find(function (x) {
              return x.uid === move.uid;
            });
            if (d) {
              d.col = move.col;
              d.row = move.row;
            }
          });
          w.col = newCol;
          w.row = newRow;
        }
        ghost.style.display = 'none';
        dragging = null;
        renderAnimated();
        _dwSave();
      }
    }

    function bindResize(handle) {
      handle.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        var el = handle.closest('.dash-widget'),
          u = +el.dataset.uid;
        var w = state.find(function (x) {
          return x.uid === u;
        });
        if (!w) return;
        e.preventDefault();
        resizing = { uid: u, sx: e.clientX, sy: e.clientY, sc: w.cs, sr: w.rs };
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', function (e) {
        if (!resizing) return;
        var ch = gridRowHeight() + GAP;
        var w = state.find(function (x) {
          return x.uid === resizing.uid;
        });
        if (!w) return;
        var wantCs = resizing.sc;
        var wantRs = Math.max(
          1,
          resizing.sr + Math.round((e.clientY - resizing.sy) / ch)
        );
        if (wantRs === w.rs) return;
        w.cs = wantCs;
        w.rs = wantRs;
        resolveVerticalOverlaps(w.uid);
        updateWidgetGridPositions();
      });
      handle.addEventListener('pointerup', function () {
        if (resizing) {
          renderAnimated();
          _dwSave();
        }
        resizing = null;
      });
    }

    function openPanel() {
      buildPicker();
      updateCards();
      panel.classList.add('open');
      overlay.classList.add('show');
      fab.classList.add('open');
    }
    function closePanel() {
      panel.classList.remove('open');
      overlay.classList.remove('show');
      fab.classList.remove('open');
    }

    function buildPicker() {
      wpGrid.innerHTML = '';
      DEFS.filter(function (def) {
        return !def.requires || def.requires();
      }).forEach(function (def) {
        var card = document.createElement('div');
        card.className = 'wp-card';
        card.dataset.type = def.type;
        card.innerHTML =
          '<div class="wp-icon">' +
          def.icon +
          '</div><div class="wp-name">' +
          defName(def) +
          '</div><div class="wp-size">' +
          def.cols +
          '\xD7' +
          def.rows +
          ' \xB7 ' +
          defDesc(def) +
          '</div>';
        card.addEventListener('click', function () {
          if (card.classList.contains('added')) return;
          var pos = findFree(def.cols, def.rows);
          state.push({
            uid: uid++,
            type: def.type,
            col: pos.col,
            row: pos.row,
            cs: def.cols,
            rs: def.rows
          });
          renderAnimated();
          _dwSave();
        });
        wpGrid.appendChild(card);
      });
    }

    function updateCards() {
      var active = state.map(function (w) {
        return w.type;
      });
      wpGrid.querySelectorAll('.wp-card').forEach(function (c) {
        c.classList.toggle('added', active.indexOf(c.dataset.type) !== -1);
      });
    }

    fab.addEventListener('click', function () {
      panel.classList.contains('open') ? closePanel() : openPanel();
    });
    overlay.addEventListener('click', closePanel);
    document.getElementById('wpClose').addEventListener('click', closePanel);

    var _dashResizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(_dashResizeTimer);
      _dashResizeTimer = setTimeout(function () {
        if (!document.getElementById('dashCanvas')) return;
        renderAnimated();
      }, 120);
    });

    // ── Daily Mission: size its tile to content ───────────────────────────────
    // The Daily Mission widget's logic is "show the whole list; scroll only if
    // it's taller than fits". A fixed grid-row span fights that — it leaves dead
    // space under a short list and clips/forces an internal scroll on a long one.
    // So after the Daily Mission UI paints (it calls this via window), we measure
    // the tile's NATURAL content height and set its row span to match: grow to
    // show every task, capped at the viewport so a very long list still scrolls
    // internally instead of running off-screen.
    var _dmFitting = false;
    window._dwFitDailyMission = function () {
      if (_dmFitting) return;
      var host = document.getElementById('daily-mission-widget');
      if (!host) return;
      var el = host.closest('.dash-widget');
      if (!el) return;
      if (!host.querySelector('.dm-widget')) return; // not painted yet
      var u = +el.dataset.uid;
      var w = state.find(function (x) {
        return x.uid === u;
      });
      if (!w) return;

      // Measure the full content height directly. If the list was capped by a
      // previous fit, briefly uncap it so scrollHeight reflects every task.
      var taskList = host.querySelector('.dm-widget-tasks--scrollable');
      var prevListMax = taskList ? taskList.style.maxHeight : '';
      var prevListOverflow = taskList ? taskList.style.overflowY : '';
      if (taskList) {
        taskList.style.maxHeight = 'none';
        taskList.style.overflowY = 'visible';
      }
      el.style.removeProperty('--dm-widget-list-max-height');
      var naturalTotal = el.scrollHeight;
      var fullListHeight = taskList ? taskList.scrollHeight : 0;
      if (taskList) {
        taskList.style.maxHeight = prevListMax;
        taskList.style.overflowY = prevListOverflow;
      }
      if (!naturalTotal) return;

      var rowHeight = gridRowHeight();
      var cell = rowHeight + GAP;
      // Cap at the viewport so the tile never runs off-screen; past this the
      // task list scrolls internally (its container is overflow-y:auto).
      var canvasTop = canvas.getBoundingClientRect().top;
      var avail = window.innerHeight - canvasTop - 24;
      var maxRows = Math.max(2, Math.floor((avail + GAP) / cell));
      // tileHeight(rs) = rs*rowHeight + (rs-1)*GAP = rs*cell - GAP; solve for rs.
      var wantRs = Math.max(2, Math.ceil((naturalTotal + GAP) / cell));
      var capped = wantRs > maxRows;
      if (capped) wantRs = maxRows;

      if (capped && taskList && fullListHeight) {
        var maxTileHeight = wantRs * rowHeight + (wantRs - 1) * GAP;
        var chromeHeight = Math.max(0, naturalTotal - fullListHeight);
        var listMax = Math.max(120, maxTileHeight - chromeHeight);
        el.style.setProperty('--dm-widget-list-max-height', listMax + 'px');
      } else {
        el.style.removeProperty('--dm-widget-list-max-height');
      }

      if (wantRs === w.rs) {
        resolveVerticalOverlaps(w.uid);
        updateWidgetGridPositions();
        return; // already fits — no relayout
      }
      w.rs = wantRs;
      resolveVerticalOverlaps(w.uid);
      _dmFitting = true;
      renderAnimated();
      _dwSave();
      setTimeout(function () {
        _dmFitting = false;
      }, 0);
    };

    window._dwRenderOnly = function () {
      render();
      setTimeout(function () {
        if (typeof window._gcInitIfPresent === 'function') window._gcInitIfPresent();
      }, 150);
    };
    window._dwLoadAndRender = function () {
      _dwLoad(function () {
        window._dwRenderOnly();
      });
    };

    buildPicker();
    (function () {
      try {
        var lastUid = localStorage.getItem('ss_last_uid');
        if (!lastUid) return;
        var c = JSON.parse(localStorage.getItem('ss_dash_cache_' + lastUid) || 'null');
        if (!c) return;
        if (c.widgets) {
          var saved = typeof c.widgets === 'string' ? JSON.parse(c.widgets) : c.widgets;
          if (Array.isArray(saved) && saved.length)
            state = saved
              .filter(function (w) {
                return w.type !== 'today';
              })
              .map(function (w) {
                return Object.assign({}, w, { uid: uid++ });
              });
        }
        if (c.notes) {
          try {
            _qnNotes = JSON.parse(c.notes) || [];
          } catch (e) {}
        }
      } catch (e) {}
    })();
    render();

    // Re-render tiles + picker when the user switches language so widget names,
    // descriptions, and JS-generated bodies (mastery prompt, Google Calendar
    // connect, "No courses yet"…) all flip immediately.
    window.addEventListener('minallo:lang-changed', function () {
      try {
        if (typeof buildPicker === 'function') buildPicker();
        if (typeof render === 'function') render();
      } catch (e) { /* ignore */ }
    });
  } // end _init
})();

