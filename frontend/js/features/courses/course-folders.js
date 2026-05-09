import { showCourseSection } from './course-view.js?v=3';
import { indexExistingDocument } from '../../services/ai-service.js';

function _guessFolderDocMeta(fileName) {
  var n = fileName.replace(/\.[^.]+$/, '');
  var meta = {};
  var m;
  m = n.match(/(?:lecture|vorlesung|vl|lec)[_\s-]*(\d+)/i);
  if (m) {
    meta.lectureNumber = parseInt(m[1], 10);
    return meta;
  }
  m = n.match(/(?:exercise|aufgabe|seminar|ag|uebung|übung|ue)[_\s-]*(\d+)/i);
  if (m) {
    meta.exerciseNumber = parseInt(m[1], 10);
    return meta;
  }
  return meta;
}

export function bindFolderEvents(co, course) {
  // ── Restore open folder state ──────────────────────────────────────────────
  co.querySelectorAll('.co-folder-section').forEach(function (sec) {
    var name = sec.getAttribute('data-folder');
    if (name && window._openFolders && window._openFolders.has(name))
      sec.classList.remove('collapsed');
  });

  // ── Folder select-all ──────────────────────────────────────────────────────
  co.querySelectorAll('.co-folder-select-all-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var sec = btn.closest('.co-folder-section');
      sec.querySelectorAll('.co-file[data-fname]').forEach(function (el) {
        var fname = el.getAttribute('data-fname');
        var folderAttr = el.getAttribute('data-folder') || null;
        var snameA = el.querySelector('.co-del-btn')
          ? el.querySelector('.co-del-btn').getAttribute('data-sname')
          : null;
        if (!window._selectedFiles) window._selectedFiles = [];
        var already = window._selectedFiles.findIndex(function (s) {
          return s.name === fname && s.folder === folderAttr;
        });
        if (already === -1) {
          window._selectedFiles.push({ name: fname, folder: folderAttr, sname: snameA });
          el.classList.add('selected');
          el.querySelector('.co-file-cb').classList.add('checked');
        }
      });
    });
  });

  // ── Folder header toggle ───────────────────────────────────────────────────
  co.querySelectorAll('.co-folder-header').forEach(function (hdr) {
    hdr.addEventListener('click', function (e) {
      if (
        e.target.closest('.co-folder-up-btn') ||
        e.target.closest('.co-folder-del-btn') ||
        e.target.closest('.co-folder-select-all-btn')
      )
        return;
      var sec = hdr.closest('.co-folder-section');
      sec.classList.toggle('collapsed');
      var name = sec.getAttribute('data-folder');
      if (name && window._openFolders) {
        if (sec.classList.contains('collapsed')) window._openFolders.delete(name);
        else window._openFolders.add(name);
      }
    });
  });

  // ── Folder delete ──────────────────────────────────────────────────────────
  co.querySelectorAll('.co-folder-del-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var folderName = btn.getAttribute('data-folder');
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      var fd = (course.userFolders || []).find(function (f) {
        return f.name === folderName;
      });
      var n = fd ? fd.files.length : 0;
      if (
        !confirm(
          'Delete folder "' +
            folderName +
            '"' +
            (n ? ' and its ' + n + ' file' + (n !== 1 ? 's' : '') : '') +
            '?'
        )
      )
        return;
      btn.disabled = true;
      var delPromises = fd
        ? fd.files.map(function (f) {
            return window._ufDeleteRemote(uid, course, f.name, folderName);
          })
        : [];
      Promise.allSettled(delPromises).then(function (results) {
        window._ufDeleteFolder(uid, course, folderName);
        course.userFolders = (course.userFolders || []).filter(function (f) {
          return f.name !== folderName;
        });
        showCourseSection(course, 'files');
        var failed = results.filter(function (r) {
          return r.status === 'rejected';
        }).length;
        if (failed && typeof window.showToast === 'function') {
          window.showToast(
            'Warning',
            failed + ' file' + (failed !== 1 ? 's' : '') + ' could not be removed from storage.'
          );
        }
      });
    });
  });

  // ── Upload to folder ───────────────────────────────────────────────────────
  var folderUploadInput = co.querySelector('#coFolderUploadInput');
  co.querySelectorAll('.co-folder-up-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (folderUploadInput) {
        folderUploadInput._targetFolder = btn.getAttribute('data-folder');
        folderUploadInput.click();
      }
    });
  });

  if (folderUploadInput) {
    folderUploadInput.addEventListener('change', function () {
      var targetFolder = this._targetFolder;
      var files = Array.from(this.files || []);
      if (!files.length || !targetFolder) return;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) {
        if (typeof window.showToast === 'function')
          window.showToast('Not signed in', 'Sign in to upload files.');
        return;
      }
      Promise.all(
        files.map(function (file) {
          return window._ufUpload(uid, course, file, null, targetFolder);
        })
      )
        .then(function () {
          course.userFolders = null;
          return window._ufMerge(course);
        })
        .then(function () {
          showCourseSection(course, 'files');
          if (typeof window.showToast === 'function')
            window.showToast(
              'Files uploaded',
              files.length +
                ' file' +
                (files.length !== 1 ? 's' : '') +
                ' added to "' +
                targetFolder +
                '"'
            );
          // Auto-index any PDFs uploaded to this folder
          if (course.id) {
            var allFolderFiles = [];
            (course.userFolders || []).forEach(function (fd) {
              allFolderFiles = allFolderFiles.concat(fd.files || []);
            });
            files
              .filter(function (f) {
                return f.name.toLowerCase().endsWith('.pdf');
              })
              .forEach(function (pf) {
                var merged = allFolderFiles.find(function (x) {
                  return x.name === pf.name && x._uploaded && x._storageName;
                });
                if (merged) {
                  var st = _guessFolderSourceType(pf.name);
                  indexExistingDocument(
                    course.id,
                    merged._storageName,
                    merged.name,
                    st,
                    merged._folder || targetFolder || null,
                    _guessFolderDocMeta(pf.name)
                  ).catch(function () {});
                }
              });
          }
        })
        .catch(function (e) {
          if (typeof window.showToast === 'function')
            window.showToast('Upload failed', e.message || 'Please try again.');
        });
      this.value = '';
    });
  }

  // ── New folder ─────────────────────────────────────────────────────────────
  var newFolderBtn = co.querySelector('#coNewFolderBtn');
  if (newFolderBtn) {
    newFolderBtn.addEventListener('click', function () {
      var name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      if (!window._ufCreateFolder(uid, course, name.trim())) {
        if (typeof window.showToast === 'function')
          window.showToast('Already exists', 'A folder with that name already exists.');
        return;
      }
      if (!course.userFolders) course.userFolders = [];
      course.userFolders.push({ name: name.trim(), files: [] });
      showCourseSection(course, 'files');
    });
  }
}

function _guessFolderSourceType(fileName) {
  var n = fileName.toLowerCase();
  if (n.includes('lösung') || n.includes('loesung') || n.includes('solution')) return 'solution';
  if (n.includes('aufgabe') || n.includes('exercise') || n.includes('übung') || n.includes('ag_'))
    return 'exercise';
  if (n.includes('exam') || n.includes('klausur') || n.includes('prüfung')) return 'exam';
  if (n.includes('notes') || n.includes('notiz') || n.includes('mitschrift')) return 'notes';
  return 'lecture';
}

export function showFolderPickerPopup(anchorEl, folders, onPick) {
  var existing = document.getElementById('_folderPickerPopup');
  if (existing) existing.parentNode.removeChild(existing);

  var popup = document.createElement('div');
  popup.id = '_folderPickerPopup';
  popup.style.cssText =
    'position:fixed;z-index:9999;background:var(--dp-solid,#1e1e2e);border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.4);padding:6px;min-width:180px;font-size:.85rem;';

  function item(label, value) {
    var el = document.createElement('div');
    el.textContent = label;
    el.style.cssText =
      'padding:8px 12px;border-radius:7px;cursor:pointer;color:var(--on-glass,#e2e8f0);white-space:nowrap;';
    el.addEventListener('mouseenter', function () {
      el.style.background = 'rgba(255,255,255,.08)';
    });
    el.addEventListener('mouseleave', function () {
      el.style.background = '';
    });
    el.addEventListener('click', function () {
      cleanup();
      onPick(value);
    });
    return el;
  }

  popup.appendChild(item('📂 Root (no folder)', null));
  folders.forEach(function (f) {
    popup.appendChild(item('📁 ' + f, f));
  });
  document.body.appendChild(popup);

  var rect = anchorEl.getBoundingClientRect();
  popup.style.top = rect.bottom + 4 + 'px';
  popup.style.left = rect.left + 'px';

  function cleanup() {
    if (popup.parentNode) popup.parentNode.removeChild(popup);
    document.removeEventListener('click', outsideClick, true);
  }
  function outsideClick(e) {
    if (!popup.contains(e.target) && e.target !== anchorEl) cleanup();
  }
  setTimeout(function () {
    document.addEventListener('click', outsideClick, true);
  }, 0);
}
