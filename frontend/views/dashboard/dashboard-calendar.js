// ============================================================================
// GOOGLE CALENDAR WIDGET
// ============================================================================
(function () {
  var _gcToken = null;
  var _gcExpiry = 0;
  var _gcEvents = [];
  var _gcViewDate = new Date();
  var _gcEditId = null;
  var CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
  var GCW_LS_KEY = 'ss_gcal_connected';
  var GCW_SS_KEY = 'ss_gcal_token';
  var _gcReminderTimers = [];
  var _gcScheduling = false;

  function _gcSaveToken(t) {
    try {
      sessionStorage.setItem(GCW_SS_KEY, JSON.stringify(t));
    } catch (e) {}
    try {
      localStorage.setItem(GCW_LS_KEY, '1');
    } catch (e) {}
  }
  function _gcLoadToken() {
    try {
      var d = JSON.parse(sessionStorage.getItem(GCW_SS_KEY) || 'null');
      if (d && d.token && d.expiry > Date.now()) {
        _gcToken = d.token;
        _gcExpiry = d.expiry;
      }
    } catch (e) {}
  }
  function _gcHasPreviouslyConnected() {
    try {
      return localStorage.getItem(GCW_LS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function _gcAuth(callback, silent) {
    if (!window.google || !window.google.accounts) {
      if (!silent) showToast('Google not loaded', 'Refresh and try again.');
      return;
    }
    var client = google.accounts.oauth2.initTokenClient({
      client_id: window._GCID || '',
      scope: CAL_SCOPE,
      callback: function (resp) {
        if (resp.error) {
          if (!silent) showToast('Calendar access denied', resp.error);
          return;
        }
        _gcToken = resp.access_token;
        _gcExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        _gcSaveToken({ token: _gcToken, expiry: _gcExpiry });
        if (callback) callback();
      }
    });
    client.requestAccessToken({ prompt: '' });
  }

  function _gcFetch(path, opts) {
    if (!_gcToken) {
      return Promise.reject(new Error('not_authed'));
    }
    var url = 'https://www.googleapis.com/calendar/v3' + path;
    return fetch(
      url,
      Object.assign(
        { headers: { Authorization: 'Bearer ' + _gcToken, 'Content-Type': 'application/json' } },
        opts || {}
      )
    )
      .then(function (r) {
        if (r.status === 401) {
          _gcToken = null;
          sessionStorage.removeItem(GCW_SS_KEY);
          localStorage.removeItem(GCW_LS_KEY);
          return Promise.reject(new Error('token_expired'));
        }
        if (r.status === 204 || r.status === 205) {
          return null;
        }
        return r.json();
      })
      .then(function (d) {
        if (d && d.error) {
          var msg = d.error.message || JSON.stringify(d.error);
          if (d.error.code === 403) return Promise.reject(new Error('api_not_enabled'));
          return Promise.reject(new Error(msg));
        }
        return d;
      });
  }

  function _gcLoadEvents(callback) {
    var y = _gcViewDate.getFullYear(),
      m = _gcViewDate.getMonth();
    var start = new Date(y, m, 1, 0, 0, 0).toISOString();
    var end = new Date(y, m + 1, 1, 0, 0, 0).toISOString();
    _gcFetch(
      '/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=' +
        encodeURIComponent(start) +
        '&timeMax=' +
        encodeURIComponent(end) +
        '&maxResults=250'
    )
      .then(function (d) {
        _gcEvents = d.items || [];
        try {
          window.dispatchEvent(new CustomEvent('ss:gcal-events-updated'));
        } catch (e) {}
        if (callback) callback();
      })
      .catch(function (e) {
        if (e.message === 'token_expired' || e.message === 'not_authed') {
          _gcRenderConnect();
        } else if (e.message === 'api_not_enabled') {
          showToast(
            'Calendar API not enabled',
            'Enable the Google Calendar API in Google Cloud Console → APIs & Services.'
          );
        } else showToast('Calendar error', e.message || 'Could not load events.');
      });
  }

  function _gcCreateEvent(ev, callback) {
    return _gcFetch('/calendars/primary/events', { method: 'POST', body: JSON.stringify(ev) })
      .then(function (d) {
        if (callback) callback(d);
      })
      .catch(function (e) {
        showToast('Could not save event', e.message);
      });
  }

  function _gcUpdateEvent(id, ev, callback) {
    return _gcFetch('/calendars/primary/events/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(ev)
    })
      .then(function (d) {
        if (callback) callback(d);
      })
      .catch(function (e) {
        showToast('Could not update event', e.message);
      });
  }

  function _gcDeleteEvent(id, callback) {
    return _gcFetch('/calendars/primary/events/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        if (callback) callback();
      })
      .catch(function (e) {
        showToast('Could not delete event', e.message);
      });
  }

  var MONTH_NAMES = [
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
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function _gcRoot() {
    return document.getElementById('gcwRoot');
  }

  function _gcRenderConnect() {
    var root = _gcRoot();
    if (!root) return;
    root.innerHTML =
      '<div class="gcw-connect"><button class="gcw-connect-btn" id="gcwConnectBtn">Connect Google Calendar</button><div class="gcw-connect-sub">Grant calendar access to view and edit your events</div></div>';
    var btn = root.querySelector('#gcwConnectBtn');
    if (btn)
      btn.addEventListener('click', function () {
        _gcAuth(function () {
          _gcLoadEvents(function () {
            _gcRenderCalendar();
          });
        });
      });
  }

  var _gcSelectedDate = null;

  function _gcScheduleReminders() {
    if (_gcScheduling) return;
    _gcScheduling = true;
    _gcReminderTimers.forEach(function (t) {
      clearTimeout(t);
    });
    _gcReminderTimers = [];

    var now = new Date();
    var todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0
    ).toISOString();
    var todayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59
    ).toISOString();

    _gcFetch(
      '/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=' +
        encodeURIComponent(todayStart) +
        '&timeMax=' +
        encodeURIComponent(todayEnd) +
        '&maxResults=50'
    )
      .then(function (d) {
        var events = d.items || [];
        events.forEach(function (ev) {
          if (!ev.start || !ev.start.dateTime) return;
          var start = new Date(ev.start.dateTime);
          var reminderAt = start.getTime() - 30 * 60 * 1000;
          var delay = reminderAt - Date.now();
          if (delay > -30 * 60 * 1000 && delay <= 0) {
            _gcShowReminder(ev, start);
          } else if (delay > 0) {
            var t = setTimeout(function () {
              _gcShowReminder(ev, start);
            }, delay);
            _gcReminderTimers.push(t);
          }
        });
      })
      .catch(function () {})
      .then(function () {
        _gcScheduling = false;
      });
  }

  function _gcShowReminder(ev, start) {
    var existing = document.getElementById('gcwReminderBar');
    if (existing) existing.remove();

    var timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var title = ev.summary || 'Upcoming event';

    var bar = document.createElement('div');
    bar.id = 'gcwReminderBar';
    bar.className = 'gcw-reminder-bar';
    bar.innerHTML =
      '<span class="gcw-reminder-icon">ðŸ“…</span>' +
      '<div class="gcw-reminder-text">' +
      '<span class="gcw-reminder-title">' +
      _gcEsc(title) +
      '</span>' +
      '<span class="gcw-reminder-sub">Starting at ' +
      timeStr +
      ' — in 30 minutes</span>' +
      '</div>' +
      '<button class="gcw-reminder-close" id="gcwReminderClose">✕</button>';
    document.body.appendChild(bar);

    document.getElementById('gcwReminderClose').addEventListener('click', function () {
      bar.classList.add('gcw-reminder-out');
      setTimeout(function () {
        bar.remove();
      }, 350);
    });

    setTimeout(function () {
      if (document.getElementById('gcwReminderBar') === bar) {
        bar.classList.add('gcw-reminder-out');
        setTimeout(function () {
          bar.remove();
        }, 350);
      }
    }, 60000);
  }

  function _gcEventsForDay(y, m, d) {
    return _gcEvents.filter(function (e) {
      var s = e.start && (e.start.dateTime || e.start.date);
      if (!s) return false;
      var sd = new Date(s);
      return sd.getFullYear() === y && sd.getMonth() === m && sd.getDate() === d;
    });
  }

  function _gcOpenPicker(root, curY, curM) {
    var showingYears = false;
    var pickerY = curY;

    function buildMonths() {
      var html =
        '<button class="gcw-picker-year-btn" id="gcwPickerYrBtn">' +
        pickerY +
        '<span class="gcw-picker-year-arrow">▼</span></button>' +
        '<div class="gcw-picker-months">';
      MONTH_NAMES.forEach(function (name, i) {
        var active = i === curM && pickerY === curY;
        html +=
          '<button class="gcw-picker-month' +
          (active ? ' gcw-picker-active' : '') +
          '" data-mi="' +
          i +
          '">' +
          name.slice(0, 3) +
          '</button>';
      });
      html += '</div>';
      return html;
    }

    function buildYears() {
      var html =
        '<button class="gcw-picker-year-btn" id="gcwPickerYrBtn" style="border-bottom:none">' +
        '← Months</button>' +
        '<div class="gcw-picker-years" id="gcwPickerYrList">';
      var startY = curY - 50,
        endY = curY + 20;
      for (var yr = endY; yr >= startY; yr--) {
        html +=
          '<button class="gcw-picker-yr' +
          (yr === pickerY ? ' gcw-picker-active' : '') +
          '" data-yr="' +
          yr +
          '">' +
          yr +
          '</button>';
      }
      html += '</div>';
      return html;
    }

    function render(mode) {
      picker.innerHTML = mode === 'years' ? buildYears() : buildMonths();
      picker.querySelector('#gcwPickerYrBtn').addEventListener('click', function (e) {
        e.stopPropagation();
        showingYears = !showingYears;
        render(showingYears ? 'years' : 'months');
        if (showingYears) {
          var list = picker.querySelector('#gcwPickerYrList');
          var active = list && list.querySelector('.gcw-picker-active');
          if (active) active.scrollIntoView({ block: 'center' });
        }
      });
      if (mode === 'years') {
        picker.querySelectorAll('.gcw-picker-yr').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            pickerY = parseInt(btn.dataset.yr);
            showingYears = false;
            render('months');
          });
        });
      } else {
        picker.querySelectorAll('.gcw-picker-month').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            picker.remove();
            document.removeEventListener('click', outsideClick);
            _gcViewDate = new Date(pickerY, parseInt(btn.dataset.mi), 1);
            _gcLoadEvents(function () {
              _gcRenderCalendar();
            });
          });
        });
      }
    }

    var picker = document.createElement('div');
    picker.className = 'gcw-picker';
    root.querySelector('.gcw-nav').appendChild(picker);
    render('months');

    function outsideClick(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', outsideClick);
      }
    }
    setTimeout(function () {
      document.addEventListener('click', outsideClick);
    }, 0);
  }

  function _gcRenderCalendar(dir) {
    var root = _gcRoot();
    if (!root) return;
    var y = _gcViewDate.getFullYear(),
      m = _gcViewDate.getMonth();
    var firstDay = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var today = new Date();
    var selD =
      _gcSelectedDate && _gcSelectedDate.getFullYear() === y && _gcSelectedDate.getMonth() === m
        ? _gcSelectedDate.getDate()
        : null;

    var cells = '';
    for (var b = 0; b < firstDay; b++) cells += '<div class="gcw-cell gcw-blank"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
      var isSel = selD === d;
      var hasEvs = _gcEventsForDay(y, m, d).length > 0;
      var cls =
        'gcw-cell' +
        (isToday ? ' gcw-today' : '') +
        (isSel ? ' gcw-selected' : '') +
        (hasEvs ? ' gcw-has-events' : '');
      cells +=
        '<div class="' +
        cls +
        '" data-day="' +
        d +
        '">' +
        '<span class="gcw-day-num">' +
        d +
        '</span>' +
        (hasEvs ? '<span class="gcw-dot"></span>' : '') +
        '</div>';
    }

    root.innerHTML =
      '<div class="gcw-nav">' +
      '<button class="gcw-nav-btn" id="gcwPrev">&#8249;</button>' +
      '<span class="gcw-month-label">' +
      MONTH_NAMES[m] +
      ' ' +
      y +
      '</span>' +
      '<button class="gcw-nav-btn" id="gcwNext">&#8250;</button>' +
      '<button class="gcw-add-btn" id="gcwAddBtn">&#x2B; Event</button>' +
      '</div>' +
      '<div class="gcw-grid">' +
      DAY_NAMES.map(function (n) {
        return '<div class="gcw-hdr">' + n + '</div>';
      }).join('') +
      cells +
      '</div>' +
      '<div class="gcw-event-list" id="gcwEventList"></div>';

    root.querySelector('#gcwPrev').addEventListener('click', function () {
      _gcViewDate = new Date(y, m - 1, 1);
      _gcLoadEvents(function () {
        _gcRenderCalendar('left');
      });
    });
    root.querySelector('#gcwNext').addEventListener('click', function () {
      _gcViewDate = new Date(y, m + 1, 1);
      _gcLoadEvents(function () {
        _gcRenderCalendar('right');
      });
    });

    root.querySelector('.gcw-month-label').addEventListener('click', function (e) {
      e.stopPropagation();
      var existing = root.querySelector('.gcw-picker');
      if (existing) {
        existing.remove();
        return;
      }
      _gcOpenPicker(root, y, m);
    });
    root.querySelector('#gcwAddBtn').addEventListener('click', function () {
      var dateStr = _gcSelectedDate
        ? _gcSelectedDate.toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      _gcOpenModal(null, dateStr);
    });

    root.querySelectorAll('.gcw-cell[data-day]').forEach(function (cell) {
      cell.addEventListener('click', function () {
        var day = parseInt(cell.dataset.day);
        _gcSelectedDate = new Date(y, m, day);
        root.querySelectorAll('.gcw-cell').forEach(function (c) {
          c.classList.remove('gcw-selected');
        });
        cell.classList.add('gcw-selected');
        _gcShowDayEvents(_gcSelectedDate);
      });
    });

    if (dir) {
      var animCls = 'gcw-anim-' + dir;
      var gridEl = root.querySelector('.gcw-grid');
      var lblEl = root.querySelector('.gcw-month-label');
      if (gridEl) {
        gridEl.classList.add(animCls);
        gridEl.addEventListener(
          'animationend',
          function () {
            gridEl.classList.remove(animCls);
          },
          { once: true }
        );
      }
      if (lblEl) {
        lblEl.classList.add(animCls);
        lblEl.addEventListener(
          'animationend',
          function () {
            lblEl.classList.remove(animCls);
          },
          { once: true }
        );
      }
    }

    var defaultDate =
      today.getFullYear() === y && today.getMonth() === m ? today : new Date(y, m, 1);
    if (!_gcSelectedDate || _gcSelectedDate.getFullYear() !== y || _gcSelectedDate.getMonth() !== m)
      _gcSelectedDate = defaultDate;
    _gcShowDayEvents(_gcSelectedDate);
    var selCell = root.querySelector('[data-day="' + _gcSelectedDate.getDate() + '"]');
    if (selCell) selCell.classList.add('gcw-selected');
  }

  function _gcShowDayEvents(date) {
    var listEl = document.getElementById('gcwEventList');
    if (!listEl) return;
    var y = date.getFullYear(),
      m = date.getMonth(),
      d = date.getDate();
    var evs = _gcEventsForDay(y, m, d);
    var dateStr = date.toISOString().slice(0, 10);
    var isToday = new Date().toDateString() === date.toDateString();
    var label = (isToday ? 'Today, ' : '') + MONTH_NAMES[m] + ' ' + d;

    listEl.innerHTML =
      '<div class="gcw-list-hdr" style="animation-delay:0ms">' +
      label +
      '<button class="gcw-list-add" data-date="' +
      dateStr +
      '">+ Add</button>' +
      '</div>' +
      (evs.length
        ? evs
            .map(function (e, i) {
              var s = e.start && (e.start.dateTime || e.start.date);
              var en = e.end && (e.end.dateTime || e.end.date);
              var timeStr = e.start.dateTime
                ? new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                  ' — ' +
                  new Date(en).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'All day';
              return (
                '<div class="gcw-list-row" data-idx="' +
                i +
                '" style="animation-delay:' +
                i * 55 +
                'ms">' +
                '<div class="gcw-list-bar"></div>' +
                '<div class="gcw-list-info">' +
                '<div class="gcw-list-title">' +
                _gcEsc(e.summary || '(No title)') +
                '</div>' +
                '<div class="gcw-list-time">' +
                timeStr +
                '</div>' +
                '</div>' +
                '<button class="gcw-list-edit" data-idx="' +
                i +
                '" title="Edit">&#x270E;</button>' +
                '</div>'
              );
            })
            .join('')
        : '<div class="gcw-list-empty">No events</div>');

    listEl.querySelector('.gcw-list-add').addEventListener('click', function (e) {
      _gcOpenModal(null, e.target.dataset.date);
    });

    listEl.querySelectorAll('.gcw-list-edit').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var ev = evs[parseInt(btn.dataset.idx)];
        _gcOpenModal(ev, null);
      });
    });
  }

  function _gcEsc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _gcOpenModal(event, defaultDate) {
    var existing = document.getElementById('gcwModal');
    if (existing) existing.remove();

    var isEdit = !!event;
    var defDate = defaultDate || new Date().toISOString().slice(0, 10);
    var defStart = '',
      defEnd = '',
      defTitle = '',
      defDesc = '';
    var evId = null;

    if (isEdit) {
      evId = event.id;
      defTitle = event.summary || '';
      defDesc = event.description || '';
      if (event.start.dateTime) {
        defStart = event.start.dateTime.slice(0, 16);
        defEnd = event.end.dateTime.slice(0, 16);
      } else {
        defStart = event.start.date + 'T00:00';
        defEnd = event.end.date + 'T00:00';
      }
    } else {
      defStart = defDate + 'T09:00';
      defEnd = defDate + 'T10:00';
    }

    var modal = document.createElement('div');
    modal.id = 'gcwModal';
    modal.className = 'gcw-modal-overlay';
    modal.innerHTML =
      '<div class="gcw-modal">' +
      '<div class="gcw-modal-hdr">' +
      '<span>' +
      (isEdit ? 'Edit Event' : 'New Event') +
      '</span>' +
      '<button class="gcw-modal-close" id="gcwModalClose">&#x2715;</button>' +
      '</div>' +
      '<div class="gcw-modal-body">' +
      '<label class="gcw-label">Title</label>' +
      '<input class="gcw-input" id="gcwTitle" type="text" value="' +
      _gcEsc(defTitle) +
      '" placeholder="Event title"/>' +
      '<label class="gcw-label">Start</label>' +
      '<input class="gcw-input" id="gcwStart" type="datetime-local" value="' +
      defStart +
      '"/>' +
      '<label class="gcw-label">End</label>' +
      '<input class="gcw-input" id="gcwEnd" type="datetime-local" value="' +
      defEnd +
      '"/>' +
      '<label class="gcw-label">Description</label>' +
      '<textarea class="gcw-input gcw-textarea" id="gcwDesc" placeholder="Optional description">' +
      _gcEsc(defDesc) +
      '</textarea>' +
      '</div>' +
      '<div class="gcw-modal-ftr">' +
      (isEdit ? '<button class="gcw-del-btn" id="gcwDelBtn">Delete</button>' : '') +
      '<button class="gcw-cancel-btn" id="gcwCancelBtn">Cancel</button>' +
      '<button class="gcw-save-btn" id="gcwSaveBtn">' +
      (isEdit ? 'Save changes' : 'Add event') +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(modal);

    modal.querySelector('#gcwModalClose').addEventListener('click', function () {
      modal.remove();
    });
    modal.querySelector('#gcwCancelBtn').addEventListener('click', function () {
      modal.remove();
    });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.remove();
    });

    if (isEdit) {
      modal.querySelector('#gcwDelBtn').addEventListener('click', function () {
        if (!confirm('Delete "' + defTitle + '"?')) return;
        _gcDeleteEvent(evId, function () {
          modal.remove();
          _gcLoadEvents(function () {
            _gcRenderCalendar();
          });
        });
      });
    }

    modal.querySelector('#gcwSaveBtn').addEventListener('click', function () {
      var title = modal.querySelector('#gcwTitle').value.trim();
      var start = modal.querySelector('#gcwStart').value;
      var end = modal.querySelector('#gcwEnd').value;
      var desc = modal.querySelector('#gcwDesc').value.trim();
      if (!title) {
        showToast('Title required', 'Please enter an event title.');
        return;
      }
      if (!start || !end) {
        showToast('Time required', 'Please set start and end times.');
        return;
      }
      if (new Date(end) <= new Date(start)) {
        showToast('Invalid time', 'End must be after start.');
        return;
      }
      var body = {
        summary: title,
        description: desc || undefined,
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() }
      };
      var saveBtn = modal.querySelector('#gcwSaveBtn');
      saveBtn.textContent = 'Saving…';
      saveBtn.disabled = true;
      if (isEdit) {
        _gcUpdateEvent(evId, body, function () {
          modal.remove();
          _gcLoadEvents(function () {
            _gcRenderCalendar();
          });
        });
      } else {
        _gcCreateEvent(body, function () {
          modal.remove();
          _gcLoadEvents(function () {
            _gcRenderCalendar();
          });
        });
      }
    });
  }

  function _gcInit() {
    _gcLoadToken();
    var root = _gcRoot();
    if (!root) return;

    var btn = root.querySelector('#gcwConnectBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        _gcAuth(function () {
          _gcLoadEvents(function () {
            _gcRenderCalendar();
            _gcScheduleReminders();
          });
        }, false);
      });
    }

    if (_gcToken) {
      _gcLoadEvents(function () {
        _gcRenderCalendar();
        _gcScheduleReminders();
      });
    } else if (_gcHasPreviouslyConnected()) {
      _gcAuth(function () {
        _gcLoadEvents(function () {
          _gcRenderCalendar();
          _gcScheduleReminders();
        });
      }, true);
    }
  }

  var _origSPS = window.showPortalSection;
  window.showPortalSection = function (sec) {
    if (typeof _origSPS === 'function') _origSPS(sec);
    if (sec === 'dashboard') {
      setTimeout(function () {
        if (_gcRoot()) _gcInit();
      }, 120);
    }
  };

  setTimeout(function () {
    if (_gcRoot()) _gcInit();
  }, 400);
  window._gcInitIfPresent = function () {
    if (_gcRoot()) _gcInit();
  };

  var _gcObserver = new MutationObserver(function () {
    var root = _gcRoot();
    if (root && root.querySelector('#gcwConnectBtn')) {
      if (_gcToken || _gcHasPreviouslyConnected()) {
        _gcInit();
      }
    }
  });
  var _gcCanvas = document.getElementById('dashCanvas');
  if (_gcCanvas) _gcObserver.observe(_gcCanvas, { childList: true, subtree: true });

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'gcwConnectBtn') {
      _gcAuth(function () {
        _gcLoadEvents(function () {
          _gcRenderCalendar();
        });
      }, false);
    }
  });

  function _gcBootReminders(attempt) {
    attempt = attempt || 0;
    _gcLoadToken();
    if (_gcToken) {
      _gcScheduleReminders();
    } else if (_gcHasPreviouslyConnected()) {
      if (!window.google || !window.google.accounts) {
        if (attempt < 15)
          setTimeout(function () {
            _gcBootReminders(attempt + 1);
          }, 1000);
        return;
      }
      _gcAuth(function () {
        _gcScheduleReminders();
      }, true);
    }
  }
  setTimeout(function () {
    _gcBootReminders(0);
  }, 500);
  setInterval(
    function () {
      _gcBootReminders(0);
    },
    5 * 60 * 1000
  );
})();
