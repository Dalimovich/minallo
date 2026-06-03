// ── LECTURE NOTES — fetches own HTML then wires all LN logic ──────────────────
(function () {
  var container = document.getElementById('psec-notes');
  if (!container) return;

  fetch('views/lecturenotes/lecturenotes.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var sec = tmp.querySelector('#psec-notes');
      if (sec) {
        // Preserve the live display. lecturenotes.html's #psec-notes ships with
        // style="display:none", and this fetch resolves AFTER the first click
        // already revealed the section — clobbering cssText would re-hide it,
        // forcing a pointless second click.
        var prevDisplay = container.style.display || 'none';
        container.style.cssText = sec.getAttribute('style') || '';
        container.style.display = prevDisplay;
        while (sec.firstChild) container.appendChild(sec.firstChild);
      }
      _init();
    });

  function _init() {
    var LN_CACHE_KEY = 'ss_ln_cache';
    var lnSummaries = [];
    var lnOpenIdx = -1;
    var lnSyncing = false;
    var lnPrevCount = 0;

    function lnSaveToLocalCache(notes) {
      try {
        localStorage.setItem(LN_CACHE_KEY, JSON.stringify(notes));
      } catch (e) {}
    }

    function lnLoadFromLocalCache() {
      try {
        return JSON.parse(localStorage.getItem(LN_CACHE_KEY) || '[]');
      } catch (e) {
        return [];
      }
    }

    function lnEscapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function lnRenderMarkdown(text) {
      text = lnEscapeHtml(text);
      text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      text = text.replace(/^### (.+)$/gm, '<h4>$1</h4>');
      text = text.replace(/^## (.+)$/gm, '<h3>$1</h3>');
      text = text.replace(/((?:^[•\-\*] .+$\n?)+)/gm, function (block) {
        return (
          '<ul>' + block.replace(/^[•\-\*] (.+)$/gm, '<li>$1</li>').replace(/\n/g, '') + '</ul>'
        );
      });
      text = text.replace(/\n\n/g, '<br>');
      text = text.replace(/\n/g, '<br>');
      return text;
    }

    function lnFormatDate(iso) {
      try {
        var d = new Date(iso);
        return d.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (e) {
        return iso;
      }
    }

    function lnGetPreview(text) {
      var m = text.match(/##\s*📌.*?\n([\s\S]*?)(?=##|$)/);
      var raw = m ? m[1] : text;
      return raw
        .replace(/[#*`]/g, '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .slice(0, 160);
    }

    function lnRender(summaries) {
      var content = document.getElementById('lnContent');
      if (!content) return;
      lnSummaries = summaries || [];
      if (lnSummaries.length === 0) {
        content.innerHTML =
          '<div class="ln-empty"><span class="ln-empty-icon">🎓</span>No lecture summaries yet.<br>Install the <strong style="color:rgba(59,130,246,.7)">Minallo Extension</strong>, watch a lecture on YouTube or Opencast,<br>then press <strong style="color:rgba(59,130,246,.7)">✨ Summarize</strong> — your notes will appear here automatically.</div>';
        return;
      }
      var html = '<div class="ln-grid">';
      lnSummaries.forEach(function (s, i) {
        var preview = lnGetPreview(s.text);
        var source = s.url
          ? s.url.includes('youtube')
            ? '▶ YouTube'
            : s.url.includes('opencast')
              ? '🎓 Opencast'
              : s.url.includes('zoom')
                ? '📹 Zoom'
                : '🎬 Lecture'
          : '🎬 Lecture';
        html +=
          '<div class="ln-card" data-idx="' +
          i +
          '">' +
          '<div class="ln-card-hdr">' +
          '<div class="ln-card-title">' +
          lnEscapeHtml(s.title) +
          '</div>' +
          '<div class="ln-card-meta"><span class="ln-card-date">' +
          lnEscapeHtml(lnFormatDate(s.date)) +
          '</span><span class="ln-card-badge">' +
          lnEscapeHtml(source) +
          '</span></div>' +
          '</div>' +
          '<div class="ln-card-preview">' +
          lnEscapeHtml(preview) +
          '…</div>' +
          '</div>';
      });
      html += '</div>';
      content.innerHTML = html;
      content.querySelectorAll('.ln-card').forEach(function (card) {
        card.addEventListener('click', function () {
          lnOpenModal(parseInt(card.getAttribute('data-idx')));
        });
      });
    }

    function lnOpenModal(idx) {
      lnOpenIdx = idx;
      var s = lnSummaries[idx];
      if (!s) return;
      document.getElementById('lnModalTitle').textContent = s.title;
      document.getElementById('lnModalBody').innerHTML = lnRenderMarkdown(s.text);
      document.getElementById('lnModalDate').textContent = lnFormatDate(s.date);
      document.getElementById('lnModal').classList.add('show');
    }

    async function lnLoadFromSupabase(uid) {
      if (!uid) return;
      var cached = lnLoadFromLocalCache();
      if (cached.length) lnRender(cached);
      try {
        var r = await fetch(
          SUPA_URL +
            '/rest/v1/lecture_notes?select=*&user_id=eq.' +
            encodeURIComponent(uid) +
            '&order=date.desc',
          { headers: _sbHeaders() }
        );
        if (!r.ok) return;
        var rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) {
          var localOnly = lnSummaries.filter(function (n) {
            return !n.id;
          });
          if (localOnly.length) {
            localOnly.forEach(function (n) {
              lnSaveNoteToSupabase(n);
            });
          } else {
            lnSaveToLocalCache([]);
            lnRender([]);
          }
          return;
        }
        var dbNotes = rows.map(function (row) {
          return {
            id: row.id,
            title: row.title,
            text: row.content,
            date: row.date,
            url: row.url || ''
          };
        });
        var inMemoryOnly = lnSummaries.filter(function (n) {
          return !n.id;
        });
        var merged = dbNotes.concat(inMemoryOnly);
        merged.sort(function (a, b) {
          return new Date(b.date) - new Date(a.date);
        });
        lnRender(merged);
        lnSaveToLocalCache(merged);
        inMemoryOnly.forEach(function (n) {
          lnSaveNoteToSupabase(n);
        });
      } catch (e) {
        console.warn('lnLoadFromSupabase error:', e);
      }
    }

    function lnGenId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'ln-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    }

    async function lnSaveNoteToSupabase(note) {
      if (!_currentUser || !note || !note.id) return;
      try {
        await fetch(SUPA_URL + '/rest/v1/lecture_notes', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), {
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify({
            id: note.id,
            user_id: _currentUser.id,
            title: note.title,
            content: note.text,
            url: note.url || '',
            date: note.date
          })
        });
      } catch (e) {
        console.warn('lnSaveNoteToSupabase error:', e);
      }
    }

    async function lnDeleteNoteFromSupabase(id) {
      if (!_currentUser || !id) return;
      try {
        await fetch(
          SUPA_URL +
            '/rest/v1/lecture_notes?id=eq.' +
            encodeURIComponent(id) +
            '&user_id=eq.' +
            encodeURIComponent(_currentUser.id),
          { method: 'DELETE', headers: _sbHeaders() }
        );
      } catch (e) {
        console.warn('lnDeleteNoteFromSupabase error:', e);
      }
    }

    // Expose for app.js auth flow
    window._lnLoadFromSupabase = lnLoadFromSupabase;
    window.lnLoadFromSupabase = lnLoadFromSupabase;

    // Modal close
    (
      document.getElementById('lnModalClose') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      document.getElementById('lnModal').classList.remove('show');
    });
    (document.getElementById('lnModal') || { addEventListener: function () {} }).addEventListener(
      'click',
      function (e) {
        if (e.target === this) this.classList.remove('show');
      }
    );
    (
      document.getElementById('lnModalDel') || { addEventListener: function () {} }
    ).addEventListener('click', async function () {
      if (lnOpenIdx < 0) return;
      var deleted = lnSummaries[lnOpenIdx];
      lnSummaries.splice(lnOpenIdx, 1);
      document.getElementById('lnModal').classList.remove('show');
      lnRender(lnSummaries);
      lnSaveToLocalCache(lnSummaries);
      window.postMessage({ type: 'SS_DELETE_SUMMARY', summaries: lnSummaries }, location.origin);
      if (deleted && deleted.id) await lnDeleteNoteFromSupabase(deleted.id);
    });

    // How-to toggle
    (
      document.getElementById('extHowToBtn') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      var howto = document.getElementById('extHowTo');
      var btn = document.getElementById('extHowToBtn');
      if (!howto) return;
      var open = howto.style.display !== 'none';
      howto.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'How to install' : 'Hide steps';
    });

    // Sync button
    (document.getElementById('lnSyncBtn') || { addEventListener: function () {} }).addEventListener(
      'click',
      function () {
        if (lnSyncing) return;
        lnSyncing = true;
        document.getElementById('lnSyncLabel').textContent = _t('sync_syncing');
        document.getElementById('lnSyncDot').style.background = '#0ea5e9';
        window.postMessage({ type: 'SS_REQUEST_SUMMARIES' }, location.origin);
        setTimeout(function () {
          if (lnSyncing) {
            lnSyncing = false;
            document.getElementById('lnSyncLabel').textContent = _t('sync_no_ext');
            document.getElementById('lnSyncDot').style.background = '#ff6b35';
            setTimeout(function () {
              document.getElementById('lnSyncLabel').textContent = _t('ln_sync_btn');
              document.getElementById('lnSyncDot').style.background = '#3b82f6';
            }, 2500);
          }
        }, 3000);
      }
    );

    // Toast action — navigate to lecture notes
    (
      document.getElementById('ss-toast-action') || { addEventListener: function () {} }
    ).addEventListener('click', function () {
      document.getElementById('ss-toast').classList.remove('show');
      setNavActive('psbNotes');
      showPortalSection('notes');
    });

    // Extension message listener
    var _ALLOWED_ORIGINS = [location.origin, 'chrome-extension://'];
    window.addEventListener('message', function (e) {
      var originOk =
        e.origin === location.origin ||
        (typeof e.origin === 'string' && e.origin.startsWith('chrome-extension://'));
      if (!originOk) return;
      if (!e.data || e.data.type !== 'SS_SUMMARIES_DATA') return;
      var isManualSync = lnSyncing;
      lnSyncing = false;
      var summaries = e.data.summaries || [];

      document.getElementById('lnSyncLabel').textContent = _t('sync_synced');
      document.getElementById('lnSyncDot').style.background = '#06D6A0';
      setTimeout(function () {
        document.getElementById('lnSyncLabel').textContent = _t('ln_sync_btn');
        document.getElementById('lnSyncDot').style.background = '#3b82f6';
      }, 2000);

      if (lnPrevCount > 0 && summaries.length > lnPrevCount) {
        var newest = summaries[0];
        showToast(
          _t('toast_new_summary_pre') +
            newest.title.slice(0, 40) +
            (newest.title.length > 40 ? '…' : ''),
          _t('toast_tap_view')
        );
      } else if (isManualSync && summaries.length > 0) {
        showToast(
          '✅ ' +
            summaries.length +
            ' ' +
            (summaries.length !== 1 ? _t('toast_synced_p') : _t('toast_synced_s')),
          summaries[0].title.slice(0, 50)
        );
      } else if (isManualSync && summaries.length === 0) {
        showToast(_t('toast_no_notes'), _t('toast_summarize_first'));
      }

      var existingKeys = lnSummaries.map(function (n) {
        return (n.title || '') + '|' + (n.date || '').slice(0, 10);
      });
      var toSave = [];
      summaries.forEach(function (s) {
        if (!s.id) {
          var key = (s.title || '') + '|' + (s.date || '').slice(0, 10);
          var match = lnSummaries.find(function (n) {
            return (n.title || '') + '|' + (n.date || '').slice(0, 10) === key;
          });
          s.id = match ? match.id : lnGenId();
        }
        var key = (s.title || '') + '|' + (s.date || '').slice(0, 10);
        if (!existingKeys.includes(key)) {
          toSave.push(s);
        }
      });
      toSave.reduce(function (p, s) {
        return p.then(function () {
          return lnSaveNoteToSupabase(s);
        });
      }, Promise.resolve());

      var mergedSummaries = summaries.slice();
      lnSummaries.forEach(function (existing) {
        if (!existing.id) return;
        var key = (existing.title || '') + '|' + (existing.date || '').slice(0, 10);
        var found = mergedSummaries.find(function (s) {
          return (s.title || '') + '|' + (s.date || '').slice(0, 10) === key;
        });
        if (!found) mergedSummaries.push(existing);
      });
      mergedSummaries.sort(function (a, b) {
        return new Date(b.date) - new Date(a.date);
      });
      lnPrevCount = mergedSummaries.length;
      lnRender(mergedSummaries);
      lnSaveToLocalCache(mergedSummaries);
    });

    // Auto-request on load
    setTimeout(function () {
      window.postMessage({ type: 'SS_REQUEST_SUMMARIES' }, location.origin);
    }, 800);

    // Show cached notes immediately
    var cached = lnLoadFromLocalCache();
    if (cached.length) lnRender(cached);
  } // end _init
})();
