// â”€â”€ Widget Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var container = document.getElementById('psec-dashboard');
  if (!container) return;

  fetch('features/dashboard/dashboard.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      // Inject inner content â€” split out the widget panel/FAB/ghost into body
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Move #psec-dashboard children into the real container
      var sec = tmp.querySelector('#psec-dashboard');
      if (sec) {
        while (sec.firstChild) container.appendChild(sec.firstChild);
      }
      // Append widget panel, FAB, and drag ghost to body
      var body = tmp; // remaining siblings
      while (body.firstChild) {
        var node = body.firstChild;
        body.removeChild(node);
        if (node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim())) {
          document.body.appendChild(node);
        }
      }
      _init();
    })
    .catch(function (err) {
      console.error('dashboard.html load error:', err);
    });

  function _init() {
    var COLS = 4,
      ROW_H = 160,
      GAP = 14;

    var DEFS = [
      {
        type: 'courses',
        icon: 'ðŸ“š',
        name: 'Course Shortcuts',
        cols: 2,
        rows: 1,
        desc: 'Jump into any course'
      },
      {
        type: 'mail',
        icon: 'âœ‰ï¸',
        name: 'New Mails',
        cols: 2,
        rows: 2,
        desc: 'Unread messages only'
      },
      {
        type: 'notes',
        icon: 'ðŸ“',
        name: 'Quick Notes',
        cols: 2,
        rows: 2,
        desc: 'Personal scratch pad'
      },
      { type: 'stats', icon: 'ðŸ“Š', name: 'Study Stats', cols: 2, rows: 1, desc: 'Weekly progress' },
      {
        type: 'deadlines',
        icon: 'â°',
        name: 'Deadlines',
        cols: 2,
        rows: 2,
        desc: 'Upcoming due dates'
      },
      {
        type: 'weather',
        icon: 'ðŸŒ¤ï¸',
        name: 'Campus Weather',
        cols: 1,
        rows: 1,
        desc: 'Braunschweig forecast'
      },
      {
        type: 'ai',
        icon: 'ðŸ¤–',
        name: 'AI Quick Chat',
        cols: 2,
        rows: 2,
        desc: 'Ask anything instantly'
      },
      {
        type: 'gcal',
        icon: 'ðŸ“†',
        name: 'Google Calendar',
        cols: 1,
        rows: 3,
        desc: 'View & edit your events'
      }
    ];

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
          : '<div class="tw-none">No classes today ðŸŽ‰</div>';
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
          return '<div class="tw-none" style="padding:16px;text-align:center;opacity:.5;font-size:.82rem">No courses yet â€” add some in Subjects</div>';
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
      if (type === 'mail')
        return (
          '<div class="mw-badge">3 unread</div>' +
          [
            {
              av: 'P',
              from: 'Prof. M\xFCller',
              subj: '\xDCbungsblatt 5 â€” Abgabe Freitag',
              t: '10:34',
              g: 'linear-gradient(135deg,#2563EB,#7C3AED)'
            },
            {
              av: 'S',
              from: 'Stud.IP System',
              subj: 'New material in Mathematik III',
              t: '09:12',
              g: 'linear-gradient(135deg,#7C3AED,#22C55E)'
            },
            {
              av: 'T',
              from: 'TU Braunschweig',
              subj: 'Semesterticket Verl\xE4ngerung',
              t: 'Ges.',
              g: 'linear-gradient(135deg,#F59E0B,#2563EB)'
            }
          ]
            .map(function (m) {
              return (
                '<div class="mw-row"><div class="mw-av" style="background:' +
                m.g +
                '">' +
                m.av +
                '</div>' +
                '<div class="mw-info"><div class="mw-from">' +
                m.from +
                '</div><div class="mw-subj">' +
                m.subj +
                '</div></div>' +
                '<div class="mw-t">' +
                m.t +
                '</div></div>'
              );
            })
            .join('')
        );
      if (type === 'notes')
        return (
          '<div class="nw-list"></div>' +
          '<div class="nw-compose" style="display:none;flex-direction:column;gap:8px">' +
          '<textarea class="nw-ta" placeholder="Write your noteâ€¦" spellcheck="false" style="flex:1;min-height:80px;resize:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;font-family:\'Nunito\',sans-serif;font-size:.82rem;color:#fff;outline:none"></textarea>' +
          '<div style="display:flex;gap:8px">' +
          '<button class="nw-cancel" style="flex:1;padding:8px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:20px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:rgba(255,255,255,.6);cursor:pointer">Cancel</button>' +
          '<button class="nw-save" style="flex:1;padding:8px;background:linear-gradient(135deg,#c084fc,#f472b6);border:none;border-radius:20px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:#fff;cursor:pointer">Save</button>' +
          '</div>' +
          '</div>' +
          '<button class="nw-add-btn" style="margin-top:8px;width:100%;padding:8px;background:rgba(192,132,252,.1);border:1px dashed rgba(192,132,252,.35);border-radius:10px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.78rem;color:rgba(192,132,252,.8);cursor:pointer">+ Add note</button>'
        );
      if (type === 'stats')
        return (
          '<div class="sw-chips"><div class="sw-chip"><div class="sw-val">12</div><div class="sw-lbl">PDFs</div></div>' +
          '<div class="sw-chip"><div class="sw-val">28</div><div class="sw-lbl">AI chats</div></div>' +
          '<div class="sw-chip"><div class="sw-val">14h</div><div class="sw-lbl">This week</div></div></div>' +
          '<div class="sw-bar-row"><span>Weekly goal</span><span>70%</span></div>' +
          '<div class="sw-bar"><div class="sw-bar-fill" style="width:70%"></div></div>'
        );
      if (type === 'deadlines')
        return [
          { c: '#ef4444', n: '\xDCbungsblatt 5 Abgabe', d: 'Fri 28 Mar' },
          { c: '#F59E0B', n: 'Praktikumsbericht', d: '2 Apr' },
          { c: '#22C55E', n: 'Klausur Anmeldung', d: '15 Apr' },
          { c: '#7C3AED', n: 'Seminararbeit', d: '30 Apr' }
        ]
          .map(function (x) {
            return (
              '<div class="dlw-row"><span class="dlw-dot" style="background:' +
              x.c +
              '"></span>' +
              '<span class="dlw-name">' +
              x.n +
              '</span><span class="dlw-date">' +
              x.d +
              '</span></div>'
            );
          })
          .join('');
      if (type === 'weather')
        return '<div class="ww-temp">12\xB0</div><div class="ww-desc">â›… Partly cloudy</div><div class="ww-loc">Braunschweig</div>';
      if (type === 'ai')
        return (
          '<div class="aw-row"><input class="aw-in" placeholder="Ask AI anythingâ€¦"/><button class="aw-btn">â†’</button></div>' +
          '<div class="aw-response" style="flex:1;overflow-y:auto;font-size:.8rem;line-height:1.6;color:rgba(255,255,255,.8);padding:4px 2px;display:none"></div>' +
          '<div class="aw-hint">Powered by StudySphere AI</div>'
        );
      if (type === 'gcal')
        return '<div class="gcw-root" id="gcwRoot"><div class="gcw-connect"><button class="gcw-connect-btn" id="gcwConnectBtn">Connect Google Calendar</button><div class="gcw-connect-sub">Sign in with Google to view and edit your events</div></div></div>';
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

    // â”€â”€ Persist widget layout per user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                  return w.type !== 'today';
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
    function isFree(col, row, cs, rs) {
      var t = { col: col, row: row, cs: cs, rs: rs };
      return !state.some(function (w) {
        return overlap(w, t);
      });
    }
    function findFree(cs, rs) {
      for (var r = 1; r <= 20; r++)
        for (var c = 1; c <= COLS - cs + 1; c++)
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

    function renderAnimated() {
      var snap = {};
      canvas.querySelectorAll('.dash-widget').forEach(function (el) {
        snap[el.dataset.uid] = el.getBoundingClientRect();
      });
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
          w.col + d.cs - 1 <= COLS &&
          !tempUsed.some(function (t) {
            return overlap(t, preferred);
          });
        var dest;
        if (fits) {
          dest = { col: w.col, row: w.row };
        } else {
          dest = null;
          scan: for (var r = 1; r <= 20; r++) {
            for (var c = 1; c <= COLS - d.cs + 1; c++) {
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

    function render() {
      canvas.innerHTML = '';
      state.forEach(function (w) {
        var def = DEFS.find(function (d) {
          return d.type === w.type;
        });
        var el = document.createElement('div');
        el.className = 'dash-widget';
        el.dataset.uid = w.uid;
        var mCols = window.innerWidth <= 768 ? 2 : COLS;
        var mCs = Math.min(w.cs, mCols),
          mCol = Math.min(w.col, mCols - mCs + 1);
        el.style.gridColumn = mCol + ' / span ' + mCs;
        el.style.gridRow = w.row + ' / span ' + w.rs;
        el.innerHTML =
          '<div class="dw-header"><span class="dw-icon">' +
          (def ? def.icon : '') +
          '</span><span class="dw-title">' +
          (def ? def.name : '') +
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
          _showFilesView();
          openCourse(course);
        });
      });
      function _sendWidgetAI(widget) {
        var inp = widget.querySelector('.aw-in');
        var btn = widget.querySelector('.aw-btn');
        var resp = widget.querySelector('.aw-response');
        var hint = widget.querySelector('.aw-hint');
        var q = inp && inp.value.trim();
        if (!q || btn.disabled) return;
        inp.value = '';
        btn.disabled = true;
        btn.textContent = 'â€¦';
        resp.style.display = 'block';
        resp.textContent = 'Thinkingâ€¦';
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
            btn.textContent = 'â†’';
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
      updateCards();
    }

    function getCellAt(ax, ay) {
      var r = canvas.getBoundingClientRect();
      var cw = (r.width + GAP) / COLS,
        ch = ROW_H + GAP;
      return {
        col: Math.max(1, Math.min(Math.floor((ax - r.left) / cw) + 1, COLS)),
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
        hdr.setPointerCapture(e.pointerId);
      });
      hdr.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        ghost.style.left = e.clientX - dragging.offX + 'px';
        ghost.style.top = e.clientY - dragging.offY + 'px';
        var cell = getCellAt(e.clientX - dragging.offX, e.clientY - dragging.offY);
        var col = Math.min(cell.col, COLS - dragging.cs + 1),
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
        var cw = (canvasRect.width + GAP) / COLS,
          ch = ROW_H + GAP;
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
      });
      hdr.addEventListener('pointercancel', function () {
        if (!dragging) return;
        ghost.style.display = 'none';
        var el2 = canvas.querySelector('[data-uid="' + dragging.uid + '"]');
        if (el2) el2.classList.remove('is-dragging');
        dragging = null;
        renderAnimated();
      });
      hdr.addEventListener('pointerup', function (e) {
        if (!dragging) return;
        var cell = getCellAt(e.clientX - dragging.offX, e.clientY - dragging.offY);
        var w = state.find(function (x) {
          return x.uid === dragging.uid;
        });
        if (w) {
          var newCol = Math.min(cell.col, COLS - w.cs + 1),
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
      });
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
        var r = canvas.getBoundingClientRect(),
          cw = (r.width + GAP) / COLS,
          ch = ROW_H + GAP;
        var w = state.find(function (x) {
          return x.uid === resizing.uid;
        });
        if (!w) return;
        var wantCs = Math.max(
          1,
          Math.min(resizing.sc + Math.round((e.clientX - resizing.sx) / cw), COLS - w.col + 1)
        );
        var wantRs = Math.max(1, resizing.sr + Math.round((e.clientY - resizing.sy) / ch));
        var others = state.filter(function (x) {
          return x.uid !== w.uid;
        });
        while (wantCs > 1 || wantRs > 1) {
          var cand = { col: w.col, row: w.row, cs: wantCs, rs: wantRs };
          if (
            !others.some(function (x) {
              return overlap(x, cand);
            })
          )
            break;
          if (wantCs - resizing.sc >= wantRs - resizing.sr && wantCs > 1) wantCs--;
          else if (wantRs > 1) wantRs--;
          else if (wantCs > 1) wantCs--;
          else break;
        }
        w.cs = wantCs;
        w.rs = wantRs;
        var elW = canvas.querySelector('[data-uid="' + w.uid + '"]');
        if (elW) {
          elW.style.gridColumn = w.col + ' / span ' + w.cs;
          elW.style.gridRow = w.row + ' / span ' + w.rs;
        }
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
      DEFS.forEach(function (def) {
        var card = document.createElement('div');
        card.className = 'wp-card';
        card.dataset.type = def.type;
        card.innerHTML =
          '<div class="wp-icon">' +
          def.icon +
          '</div><div class="wp-name">' +
          def.name +
          '</div><div class="wp-size">' +
          def.cols +
          '\xD7' +
          def.rows +
          ' \xB7 ' +
          def.desc +
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
  } // end _init
})();

