import { showCourseSection } from './course-view.js?v=7';
import {
  listCourseDocuments,
  indexExistingDocument,
  generateStudyTool
} from '../../services/ai-service.js';

// Session-level cache: prevents re-triggering files already confirmed or in-flight.
// Key: courseId + ':' + fname.toLowerCase() → 'ready' | 'triggered'
var _ragConfirmed = {};

export function bindFileEvents(co, course) {
  var selectMode = false;
  var selectedFiles = [];

  function updateMultiBar() {
    var bar = co.querySelector('#coMultiBar');
    var cnt = co.querySelector('#coSelCount');
    var btn = co.querySelector('#coMultiSumBtn');
    if (!bar) return;
    cnt.textContent = selectedFiles.length;
    bar.classList.toggle('show', selectedFiles.length > 0);
    btn.disabled = selectedFiles.length === 0;
    btn.title = selectedFiles.length === 0 ? 'Select at least 1 file' : '';
    if (selectedFiles.length === 1) btn.textContent = '✨ AI Chat (1 file)';
    else if (selectedFiles.length > 1)
      btn.textContent = '✨ AI Chat (' + selectedFiles.length + ' files)';
    else btn.textContent = '✨ AI Chat';
  }

  initCourseStudyTools(co, course);

  // ── Select toggle ──────────────────────────────────────────────────────────
  var selectToggle = co.querySelector('#coSelectToggle');
  if (selectToggle) {
    selectToggle.addEventListener('click', function () {
      selectMode = !selectMode;
      selectToggle.classList.toggle('active', selectMode);
      selectToggle.textContent = selectMode ? '✕ Cancel selection' : '☑ Select multiple';
      var filesList = co.querySelector('#coFilesList');
      if (filesList) filesList.classList.toggle('co-select-mode', selectMode);
      co.querySelectorAll('.co-folder-files').forEach(function (fl) {
        fl.classList.toggle('co-select-mode', selectMode);
      });
      co.querySelectorAll('.co-folder-select-all-btn').forEach(function (btn) {
        btn.style.display = selectMode ? '' : 'none';
      });
      if (!selectMode) {
        selectedFiles = [];
        co.querySelectorAll('.co-file').forEach(function (el) {
          el.classList.remove('selected');
        });
        co.querySelectorAll('.co-file-cb').forEach(function (cb) {
          cb.classList.remove('checked');
        });
        updateMultiBar();
      }
    });
  }

  // ── Multi-select clear ─────────────────────────────────────────────────────
  var multiClear = co.querySelector('#coMultiClear');
  if (multiClear) {
    multiClear.addEventListener('click', function () {
      selectedFiles = [];
      co.querySelectorAll('.co-file').forEach(function (el) {
        el.classList.remove('selected');
      });
      co.querySelectorAll('.co-file-cb').forEach(function (cb) {
        cb.classList.remove('checked');
      });
      updateMultiBar();
    });
  }

  // ── Multi AI summary ───────────────────────────────────────────────────────
  var multiSumBtn = co.querySelector('#coMultiSumBtn');
  if (multiSumBtn) {
    multiSumBtn.addEventListener('click', function () {
      if (selectedFiles.length === 0) return;
      var files = selectedFiles.slice();
      var btn = multiSumBtn;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      btn.disabled = true;
      btn.textContent = 'Loading…';

      var promises = files.map(function (f) {
        return new Promise(function (resolve) {
          function fromBytes(bytes) {
            window
              ._ssEnsurePdfJs()
              .then(function () {
                return window.pdfjsLib
                  .getDocument({ data: bytes })
                  .promise.then(function (pdf) {
                    var pp = [];
                    for (var p = 1; p <= Math.min(pdf.numPages, 15); p++) {
                      pp.push(
                        pdf.getPage(p).then(function (pg) {
                          return pg.getTextContent().then(function (tc) {
                            return tc.items
                              .map(function (i) {
                                return i.str;
                              })
                              .join(' ');
                          });
                        })
                      );
                    }
                    Promise.all(pp)
                      .then(function (pages) {
                        resolve('=== ' + f.name + ' ===\n' + pages.join('\n'));
                      })
                      .catch(function () {
                        resolve('=== ' + f.name + ' === [extraction failed]');
                      });
                  })
                  .catch(function () {
                    resolve('=== ' + f.name + ' === [could not open]');
                  });
              })
              .catch(function () {
                resolve('=== ' + f.name + ' === [could not load PDF.js]');
              });
          }

          if (f.sname && uid) {
            window
              ._ufFetchBytes(uid, course, f.sname, f.folder || null)
              .then(fromBytes)
              .catch(function () {
                resolve('=== ' + f.name + ' === [fetch failed]');
              });
          } else {
            var path = window.PDF_DATA && window.PDF_DATA[f.name];
            if (path) {
              window._fetchPdfBytes(path, fromBytes, function () {
                resolve('=== ' + f.name + ' === [not available]');
              });
            } else {
              resolve('=== ' + f.name + ' === [not available in demo]');
            }
          }
        });
      });

      Promise.all(promises).then(function (parts) {
        window.pdfFullText = parts.join('\n\n');
        var names = files.map(function (f) {
          return f.name.replace(/\.pdf$/i, '');
        });
        window.activeFileName = names.join(', ');
        if (typeof window.openAI === 'function') window.openAI();
        var chatEl = document.getElementById('aiChat');
        if (chatEl) chatEl.innerHTML = '';
        var intro =
          '📂 **' +
          files.length +
          ' file' +
          (files.length !== 1 ? 's' : '') +
          ' loaded:**\n' +
          files
            .map(function (f) {
              return '- ' + f.name;
            })
            .join('\n') +
          '\n\nAsk me anything — I can summarise, compare, explain concepts, generate quizzes, and more.';
        if (typeof window.addBotMsg === 'function') window.addBotMsg(intro);
        btn.disabled = false;
        updateMultiBar();
      });
    });
  }

  // ── Multi delete ───────────────────────────────────────────────────────────
  var multiDeleteBtn = co.querySelector('#coMultiDeleteBtn');
  if (multiDeleteBtn) {
    multiDeleteBtn.addEventListener('click', function () {
      var toDelete = selectedFiles.slice();
      if (!toDelete.length) return;
      if (
        !confirm('Delete ' + toDelete.length + ' file' + (toDelete.length !== 1 ? 's' : '') + '?')
      )
        return;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      toDelete.forEach(function (s) {
        window._ufDelete(course, s.name, s.folder || null, s.sname || null);
      });
      selectedFiles = [];
      showCourseSection(course, 'files');
      if (typeof window.showToast === 'function')
        window.showToast(
          'Deleted',
          toDelete.length + ' file' + (toDelete.length !== 1 ? 's' : '') + ' removed'
        );
    });
  }

  // ── Multi move ────────────────────────────────────────────────────────────
  var multiMoveBtn = co.querySelector('#coMultiMoveBtn');
  if (multiMoveBtn) {
    multiMoveBtn.addEventListener('click', function () {
      if (!selectedFiles.length) return;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      window._glMoveDestPicker(uid, course, async function (toCourse, toFolder) {
        multiMoveBtn.textContent = 'Moving…';
        multiMoveBtn.disabled = true;
        var toMove = selectedFiles.slice();
        try {
          await Promise.all(
            toMove.map(function (s) {
              return window._ufMoveFileTo(
                uid,
                course,
                toCourse,
                s.name,
                s.folder || null,
                toFolder,
                s.sname || null
              );
            })
          );
          course.userFolders = null;
          course.files = (course.files || []).filter(function (f) {
            return !(
              f._uploaded &&
              toMove.some(function (s) {
                return s.name === f.name;
              })
            );
          });
          selectedFiles = [];
          await window._ufMerge(course);
          showCourseSection(course, 'files');
          var destCard = toCourse.id !== course.id ? toCourse.name || toCourse.id : null;
          var destFolder = toFolder ? '"' + toFolder + '"' : 'root';
          var destLabel = destCard ? destCard + (toFolder ? ' / ' + toFolder : '') : destFolder;
          if (typeof window.showToast === 'function')
            window.showToast(
              'Moved ✓',
              toMove.length + ' file' + (toMove.length !== 1 ? 's' : '') + ' → ' + destLabel
            );
        } catch (e) {
          if (typeof window.showToast === 'function') window.showToast('Move failed', e.message);
        }
      });
    });
  }

  // ── File row click (open / select) ─────────────────────────────────────────
  co.querySelectorAll('.co-file[data-fname]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (
        e.target.closest('.co-dl-btn') ||
        e.target.closest('.co-del-btn') ||
        e.target.closest('.co-reindex-btn') ||
        e.target.closest('.co-rag-status')
      )
        return;
      var fname = el.getAttribute('data-fname');
      var folderAttr = el.getAttribute('data-folder') || null;
      var snameAttr = el.querySelector('.co-del-btn')
        ? el.querySelector('.co-del-btn').getAttribute('data-sname')
        : null;
      if (selectMode) {
        var idx = selectedFiles.findIndex(function (s) {
          return s.name === fname && s.folder === folderAttr;
        });
        if (idx === -1) {
          selectedFiles.push({ name: fname, folder: folderAttr, sname: snameAttr });
          el.classList.add('selected');
          el.querySelector('.co-file-cb').classList.add('checked');
        } else {
          selectedFiles.splice(idx, 1);
          el.classList.remove('selected');
          el.querySelector('.co-file-cb').classList.remove('checked');
        }
        updateMultiBar();
        return;
      }
      var f = null;
      if (folderAttr) {
        var fd = (course.userFolders || []).find(function (x) {
          return x.name === folderAttr;
        });
        if (fd)
          f = (fd.files || []).find(function (x) {
            return x.name === fname;
          });
      } else {
        f = (course.files || []).find(function (x) {
          return x.name === fname;
        });
      }
      if (f) {
        if (typeof window.openFile === 'function') window.openFile(f, course);
      } else {
        if (typeof window.showToast === 'function')
          window.showToast('File not found', 'Try refreshing the course');
      }
    });
  });

  // ── Download button ────────────────────────────────────────────────────────
  co.querySelectorAll('.co-dl-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof window.downloadFile === 'function')
        window.downloadFile(btn.getAttribute('data-fname'));
    });
  });

  // ── Delete uploaded file ───────────────────────────────────────────────────
  co.querySelectorAll('.co-del-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var fname = btn.getAttribute('data-fname');
      var sname = btn.getAttribute('data-sname') || null;
      var folder = btn.getAttribute('data-folder') || null;
      var where = folder ? 'from folder "' + folder + '"' : 'from this course';
      if (!confirm('Delete "' + fname + '" ' + where + '?')) return;
      window._ufDelete(course, fname, folder, sname);
      showCourseSection(course, 'files');
    });
  });

  // ── Re-index button ────────────────────────────────────────────────────────
  co.querySelectorAll('.co-reindex-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var fname = btn.getAttribute('data-fname');
      var sname = btn.getAttribute('data-sname') || null;
      var folder = btn.getAttribute('data-folder') || null;
      if (!sname) return;
      btn.textContent = '⏳';
      btn.style.pointerEvents = 'none';
      indexExistingDocument(course.id, sname, fname, _guessSourceType(fname), folder, Object.assign({}, _guessDocMeta(fname), { forceReindex: true }))
        .then(function () {
          btn.textContent = '✓ AI';
          btn.style.background = 'rgba(6,214,160,.15)';
          btn.style.color = 'rgba(6,214,160,.9)';
          btn.style.borderColor = 'rgba(6,214,160,.3)';
          if (typeof window.showToast === 'function')
            window.showToast('Re-indexed', '"' + fname + '" is now updated for AI.');
          // Restart status polling so the hourglass becomes 🟢 once processing finishes.
          try { _bindRagStatus(co, course); } catch (e) {}
        })
        .catch(function () {
          btn.textContent = '↺ AI';
          btn.style.pointerEvents = '';
          if (typeof window.showToast === 'function')
            window.showToast('Error', 'Re-index failed. Try again.');
        });
    });
  });

  // ── Reindex-all button ─────────────────────────────────────────────────────
  var reindexAllBtn = co.querySelector('#coReindexAllBtn');
  if (reindexAllBtn) {
    reindexAllBtn.addEventListener('click', function () {
      var targets = [];
      (course.files || []).forEach(function (f) {
        if (f._uploaded && f._storageName && /\.pdf$/i.test(f.name)) {
          targets.push({ fname: f.name, sname: f._storageName, folder: null });
        }
      });
      (course.userFolders || []).forEach(function (fd) {
        (fd.files || []).forEach(function (f) {
          if (f._uploaded && f._storageName && /\.pdf$/i.test(f.name)) {
            targets.push({ fname: f.name, sname: f._storageName, folder: fd.name });
          }
        });
      });
      if (!targets.length) {
        if (typeof window.showToast === 'function')
          window.showToast('Nothing to reindex', 'No uploaded PDFs in this course.');
        return;
      }
      if (!confirm('Re-index ' + targets.length + ' PDF' + (targets.length === 1 ? '' : 's') + ' in this course? This may take a few minutes.')) return;

      reindexAllBtn.disabled = true;
      var origLabel = reindexAllBtn.textContent;
      var done = 0, failed = 0;
      function updateLabel() {
        reindexAllBtn.textContent = '⏳ ' + done + ' / ' + targets.length;
      }
      updateLabel();

      // Wait until the doc is 'ready' or 'failed' in the DB, polling every 3s.
      // Up to ~3 minutes per doc. Returns the final status.
      function _waitForDoc(docId) {
        return new Promise(function (resolve) {
          var attempts = 0;
          var MAX = 60;
          (function poll() {
            if (attempts++ >= MAX) return resolve('timeout');
            listCourseDocuments(course.id).then(function (docs) {
              var d = (docs || []).find(function (x) { return x.id === docId; });
              if (!d) return setTimeout(poll, 3000);
              if (d.processing_status === 'ready' || d.processing_status === 'failed') {
                return resolve(d.processing_status);
              }
              setTimeout(poll, 3000);
            }).catch(function () { setTimeout(poll, 3000); });
          })();
        });
      }

      function _runOne(t, retry) {
        return indexExistingDocument(
          course.id,
          t.sname,
          t.fname,
          _guessSourceType(t.fname),
          t.folder,
          Object.assign({}, _guessDocMeta(t.fname), { forceReindex: true })
        ).then(function (res) {
          if (!res || !res.documentId) return 'failed';
          return _waitForDoc(res.documentId);
        }).then(function (status) {
          if (status === 'ready') return 'ready';
          // Auto-retry once on failure/timeout, with a small pause
          if (!retry) {
            return new Promise(function (r) { setTimeout(r, 1500); })
              .then(function () { return _runOne(t, true); });
          }
          return status;
        }).catch(function () { return 'failed'; });
      }

      var i = 0;
      function next() {
        if (i >= targets.length) {
          reindexAllBtn.disabled = false;
          reindexAllBtn.textContent = origLabel;
          if (typeof window.showToast === 'function') {
            window.showToast(
              'Reindex complete',
              done + ' succeeded' + (failed ? ', ' + failed + ' failed' : '') + '.'
            );
          }
          try { _bindRagStatus(co, course); } catch (e) {}
          return;
        }
        var t = targets[i++];
        _runOne(t, false).then(function (status) {
          if (status === 'ready') done++;
          else failed++;
          updateLabel();
          // Re-bind after each so the user sees green dots appear progressively
          try { _bindRagStatus(co, course); } catch (e) {}
          next();
        });
      }
      next();
    });
  }

  // ── RAG status indicators ──────────────────────────────────────────────────
  _bindRagStatus(co, course);

  // ── Upload button ──────────────────────────────────────────────────────────
  var uploadBtn = co.querySelector('#coUploadBtn');
  var uploadInput = co.querySelector('#coUploadInput');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', function () {
      var folders = (course.userFolders || []).map(function (fd) {
        return fd.name;
      });
      if (folders.length === 0) {
        uploadInput._targetFolder = null;
        uploadInput.click();
      } else {
        window._showFolderPickerPopup(uploadBtn, folders, function (chosen) {
          uploadInput._targetFolder = chosen;
          uploadInput.click();
        });
      }
    });
  }

  if (uploadInput) {
    uploadInput.addEventListener('change', function () {
      var files = Array.from(this.files || []);
      if (!files.length) return;
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) {
        if (typeof window.showToast === 'function')
          window.showToast('Not signed in', 'Sign in to upload files.');
        return;
      }
      var toolbar = co.querySelector('.co-files-toolbar');
      var progWrap = document.createElement('div');
      progWrap.className = 'co-upload-progress';
      progWrap.innerHTML =
        '<div class="co-upload-progress-label"><span id="coProgLabel">Uploading 0 / ' +
        files.length +
        '…</span><span id="coProgPct">0%</span></div>' +
        '<div class="co-upload-progress-track"><div class="co-upload-progress-bar" id="coProgBar" style="width:0%"></div></div>';
      if (toolbar) toolbar.appendChild(progWrap);
      var completed = 0;
      var totalPct = new Array(files.length).fill(0);
      function updateProgress(i, pct) {
        totalPct[i] = pct;
        var avg = Math.round(
          totalPct.reduce(function (a, b) {
            return a + b;
          }, 0) / files.length
        );
        var bar = co.querySelector('#coProgBar');
        var label = co.querySelector('#coProgLabel');
        var pctEl = co.querySelector('#coProgPct');
        if (bar) bar.style.width = avg + '%';
        if (pctEl) pctEl.textContent = avg + '%';
        if (label) label.textContent = 'Uploading ' + completed + ' / ' + files.length + '…';
      }
      var targetFolder = uploadInput._targetFolder || null;
      Promise.all(
        files.map(function (file, i) {
          return window
            ._ufUpload(
              uid,
              course,
              file,
              function (pct) {
                updateProgress(i, pct);
              },
              targetFolder
            )
            .then(function () {
              completed++;
              updateProgress(i, 100);
            });
        })
      )
        .then(function () {
          if (progWrap.parentNode) progWrap.parentNode.removeChild(progWrap);
          course.files = course.files.filter(function (f) {
            return !f._uploaded;
          });
          return window._ufMerge(course);
        })
        .then(function () {
          try {
            var toCache = {
              files: course.files
                .filter(function (f) {
                  return f._uploaded && !f._folder;
                })
                .map(function (f) {
                  return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
                }),
              folders: (course.userFolders || []).map(function (fd) {
                return {
                  name: fd.name,
                  files: fd.files.map(function (f) {
                    return {
                      name: f.name,
                      storageName: f._storageName,
                      size: f.size,
                      date: f.date
                    };
                  })
                };
              })
            };
            localStorage.setItem('ss_uf_cache_' + course.id, JSON.stringify(toCache));
          } catch (e) {}
          showCourseSection(course, 'files');
          if (typeof window.showToast === 'function')
            window.showToast(
              'Files uploaded',
              '' +
                files.length +
                ' file' +
                (files.length > 1 ? 's' : '') +
                ' added to ' +
                course.short
            );
          // Auto-index any newly uploaded PDFs for RAG
          var pdfFiles = files.filter(function (f) {
            return f.name.toLowerCase().endsWith('.pdf');
          });
          if (pdfFiles.length && course.id) {
            // Find the freshly merged file objects to get storageName
            var allFiles = course.files || [];
            pdfFiles.forEach(function (pf) {
              var merged = allFiles.find(function (x) {
                return x.name === pf.name && x._uploaded && x._storageName;
              });
              if (merged) {
                indexExistingDocument(
                  course.id,
                  merged._storageName,
                  merged.name,
                  _guessSourceType(merged.name),
                  merged._folder || null,
                  _guessDocMeta(merged.name)
                ).catch(function () {});
              }
            });
          }
        })
        .catch(function (e) {
          if (progWrap.parentNode) progWrap.parentNode.removeChild(progWrap);
          if (typeof window.showToast === 'function')
            window.showToast('Upload failed', e.message || 'Please try again.');
        });
      this.value = '';
    });
  }
}

function initCourseStudyTools(co, course) {
  window._generateStudyTool = generateStudyTool;

  co.querySelectorAll('[data-course-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabName = tab.getAttribute('data-course-tab');
      setCourseStudyMode(co, course, tabName);
      if (typeof window.showCourseSection === 'function') {
        window.showCourseSection(course, tabName);
      }
    });
  });
}

function setCourseStudyMode(co, course, mode) {
  var nextMode = ['files', 'quiz', 'flashcards'].includes(mode) ? mode : 'files';
  co.querySelectorAll('[data-course-tab]').forEach(function (tab) {
    var isActive = tab.getAttribute('data-course-tab') === nextMode;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  co.querySelectorAll('[data-course-panel]').forEach(function (panel) {
    panel.classList.toggle('active', panel.getAttribute('data-course-panel') === nextMode);
  });

  // Widen the .co-inner container for panels that need more space (JS fallback for :has())
  var inner = co.closest('.co-inner');
  if (inner) inner.classList.toggle('co-inner-wide', nextMode === 'quiz' || nextMode === 'flashcards');

  // New feature modules take over the quiz / flashcards panels.
  // If the module script hasn't finished loading yet, retry until it's ready.
  if (nextMode === 'quiz') {
    var quizPanel = co.querySelector('#coQuizPanel');
    if (quizPanel) {
      (function tryMountQuiz() {
        if (typeof window.mountQuiz === 'function') {
          if (!quizPanel.dataset.qzMounted) {
            quizPanel.dataset.qzMounted = '1';
            window.mountQuiz(quizPanel, course, { generate: generateStudyTool });
          } else if (typeof window.resetQuizToGrid === 'function') {
            window.resetQuizToGrid(quizPanel);
          }
        } else {
          setTimeout(tryMountQuiz, 80);
        }
      })();
    }
    return;
  }
  if (nextMode === 'flashcards') {
    var flashPanel = co.querySelector('#coFlashPanel');
    if (flashPanel) {
      (function tryMountFlashcards() {
        if (typeof window.mountFlashcards === 'function') {
          if (!flashPanel.dataset.fcMounted) {
            flashPanel.dataset.fcMounted = '1';
            window.mountFlashcards(flashPanel, course, { generate: generateStudyTool });
          } else if (typeof window.resetFlashcardsToGrid === 'function') {
            window.resetFlashcardsToGrid(flashPanel);
          }
        } else {
          setTimeout(tryMountFlashcards, 80);
        }
      })();
    }
    return;
  }
}

function _guessSourceType(fileName) {
  var n = fileName.toLowerCase();
  if (n.includes('lösung') || n.includes('loesung') || n.includes('solution')) return 'solution';
  if (n.includes('aufgabe') || n.includes('exercise') || n.includes('übung') || n.includes('ag_'))
    return 'exercise';
  if (n.includes('exam') || n.includes('klausur') || n.includes('prüfung')) return 'exam';
  if (n.includes('formelzettel') || n.includes('formelsammlung') || n.includes('formel') ||
      n.includes('zusammenfassung') || n.includes('summary') || n.includes('cheatsheet') ||
      n.includes('cheat sheet') || n.includes('merkblatt') || n.includes('überblick'))
    return 'summary';
  if (n.includes('notes') || n.includes('notiz') || n.includes('mitschrift')) return 'notes';
  return 'lecture';
}

// Extract lecture_number / exercise_number from filename patterns like:
//   Lecture_04, VL04, L04, Aufgabe_3, Exercise_03, Seminar_01, AG_02
function _guessDocMeta(fileName) {
  var n = fileName.replace(/\.[^.]+$/, ''); // strip extension
  var meta = {};
  var m;
  // Lecture number: Lecture_04, VL04, VL_04, L04, Vorlesung_4
  m = n.match(/(?:lecture|vorlesung|vl|lec)[_\s-]*(\d+)/i);
  if (m) {
    meta.lectureNumber = parseInt(m[1], 10);
    return meta;
  }
  // Exercise / Seminar number: Exercise_03, Aufgabe_3, AG_02, Seminar_01, UE_03, Uebung_2
  m = n.match(/(?:exercise|aufgabe|seminar|ag|uebung|übung|ue)[_\s-]*(\d+)/i);
  if (m) {
    meta.exerciseNumber = parseInt(m[1], 10);
    return meta;
  }
  return meta;
}

// Simple FIFO throttle. Concurrency 1 — pgvector HNSW serializes inserts
// anyway, and parallel triggers cause Supabase statement_timeout cascades.
var _ragQueue = [];
var _ragRunning = 0;
var _RAG_CONCURRENCY = 1;
function _ragEnqueue(fn) {
  return new Promise(function (resolve) {
    _ragQueue.push(function () {
      _ragRunning++;
      Promise.resolve()
        .then(fn)
        .catch(function () {})
        .then(function () {
          _ragRunning--;
          resolve();
          _ragDrain();
        });
    });
    _ragDrain();
  });
}
function _ragDrain() {
  while (_ragRunning < _RAG_CONCURRENCY && _ragQueue.length) {
    var next = _ragQueue.shift();
    next();
  }
}

async function _bindRagStatus(co, course) {
  var courseId = course.id;
  if (!courseId) return;

  // Wait for auth session to be ready before making authenticated API calls
  if (window._sbSessionReady) {
    try {
      await window._sbSessionReady;
    } catch (e) {}
  }
  if (!window._sbToken) return; // not authenticated yet — skip silently

  var ragDocs = [];
  try {
    ragDocs = await listCourseDocuments(courseId);
  } catch (e) {}

  // Multiple rows per filename can exist after retried/failed indexing runs.
  // Prefer 'ready', then 'failed', else the most-recent — so a successful
  // reindex isn't masked by a stale failed/in-progress row.
  function _statusRank(s) {
    if (s === 'ready') return 0;
    if (s === 'failed') return 1;
    return 2; // uploaded / extracting_text / chunking / embedding / null
  }
  var ragMap = {};
  ragDocs.forEach(function (d) {
    var key = d.file_name.toLowerCase();
    var prev = ragMap[key];
    if (!prev) { ragMap[key] = d; return; }
    var prevRank = _statusRank(prev.processing_status);
    var curRank = _statusRank(d.processing_status);
    if (curRank < prevRank) { ragMap[key] = d; return; }
    if (curRank === prevRank) {
      var prevTime = prev.updated_at || prev.created_at || '';
      var curTime = d.updated_at || d.created_at || '';
      if (curTime > prevTime) ragMap[key] = d;
    }
  });

  co.querySelectorAll('.co-rag-status').forEach(function (el) {
    var fname = el.dataset.fname || '';
    var cacheKey = courseId + ':' + fname.toLowerCase();
    var doc = ragMap[fname.toLowerCase()];
    var f = _findUploadedFile(course, fname);

    // Already confirmed ready this session — show green, skip all API work.
    if (_ragConfirmed[cacheKey] === 'ready') {
      _setRagStatus(el, 'ready');
      return;
    }

    if (doc) {
      _setRagStatus(el, doc.processing_status);
      if (doc.processing_status === 'ready') {
        _ragConfirmed[cacheKey] = 'ready';
        return;
      }
      if (doc.processing_status === 'failed') {
        // Auto-retry failed docs — up to 3 attempts per session.
        var key = '_ragRetries_' + doc.id;
        var attempts = window[key] || 0;
        if (f && attempts < 3) {
          window[key] = attempts + 1;
          _ragConfirmed[cacheKey] = 'triggered';
          _ragEnqueue(function () {
            return _triggerRagIndex(el, fname, f, course, courseId, cacheKey);
          });
        }
        return;
      }

      // In-progress — poll only; don't re-trigger unless genuinely stuck.
      var stuckSince = doc.updated_at || doc.created_at;
      var stuckMs = stuckSince ? Date.now() - new Date(stuckSince).getTime() : 0;
      var stuckKey = '_ragStuckRetries_' + doc.id;
      var stuckAttempts = window[stuckKey] || 0;
      if (stuckMs > 7 * 60 * 1000 && f && stuckAttempts < 2) {
        window[stuckKey] = stuckAttempts + 1;
        _ragConfirmed[cacheKey] = 'triggered';
        _ragEnqueue(function () {
          return _triggerRagIndex(el, fname, f, course, courseId, cacheKey);
        });
        return;
      }
      _pollRagStatus(el, courseId, doc.id, cacheKey);
    } else if (f) {
      // Not indexed yet — trigger once per session only.
      if (_ragConfirmed[cacheKey] === 'triggered') return;
      _ragConfirmed[cacheKey] = 'triggered';
      _ragEnqueue(function () {
        return _triggerRagIndex(el, fname, f, course, courseId, cacheKey);
      });
    }

    // Allow click only to retry a failed index.
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.dataset.ragStatus !== 'failed') return;
      var fr = _findUploadedFile(course, fname);
      if (fr) {
        _ragConfirmed[cacheKey] = 'triggered';
        _ragEnqueue(function () {
          return _triggerRagIndex(el, fname, fr, course, courseId, cacheKey);
        });
      }
    });
  });
}

function _findUploadedFile(course, fname) {
  var lower = fname.toLowerCase();
  var found = (course.files || []).find(function (x) {
    return x.name === fname && x._uploaded;
  });
  if (found) return found;
  for (var i = 0; i < (course.userFolders || []).length; i++) {
    found = course.userFolders[i].files.find(function (x) {
      return x.name === fname && x._uploaded;
    });
    if (found) return found;
  }
  return null;
}

async function _triggerRagIndex(el, fname, f, course, courseId, cacheKey) {
  if (!f._storageName) return;

  _setRagStatus(el, 'uploading');

  try {
    var result = await indexExistingDocument(
      courseId,
      f._storageName,
      fname,
      _guessSourceType(fname),
      f._folder || null,
      _guessDocMeta(fname)
    );
    if (result.alreadyIndexed) {
      var st = result.processingStatus || 'ready';
      _setRagStatus(el, st);
      if (st === 'ready' && cacheKey) _ragConfirmed[cacheKey] = 'ready';
      if (st !== 'ready' && st !== 'failed' && result.documentId) {
        _pollRagStatus(el, courseId, result.documentId, cacheKey);
      }
      return;
    }
    _setRagStatus(el, 'uploaded');

    var updatedDocs = await listCourseDocuments(courseId);
    var updated = updatedDocs.find(function (d) {
      return d.file_name.toLowerCase() === fname.toLowerCase();
    });
    if (updated) {
      _setRagStatus(el, updated.processing_status);
      if (updated.processing_status === 'ready' && cacheKey) _ragConfirmed[cacheKey] = 'ready';
      if (updated.processing_status !== 'ready' && updated.processing_status !== 'failed') {
        _pollRagStatus(el, courseId, updated.id, cacheKey);
      }
    }
  } catch (err) {
    _setRagStatus(el, 'failed');
  }
}

function _setRagStatus(el, status) {
  el.dataset.ragStatus = status;
  el.title =
    {
      ready: 'Ready for AI ✓',
      failed: 'Indexing failed — click to retry',
      uploading: 'Sending to AI…',
      uploaded: 'Processing…',
      extracting_text: 'Extracting text…',
      chunking: 'Chunking…',
      embedding: 'Indexing…'
    }[status] || 'Preparing for AI…';
  el.textContent =
    {
      ready: '🟢',
      failed: '🔴',
      uploading: '⏳',
      uploaded: '🔵',
      extracting_text: '🔵',
      chunking: '🔵',
      embedding: '🔵'
    }[status] || '⏳';
  el.style.cursor = status === 'failed' ? 'pointer' : 'default';
}

async function _pollRagStatus(el, courseId, docId, cacheKey, _attempts) {
  _attempts = (_attempts || 0) + 1;
  if (_attempts > 60) return;
  await new Promise(function (r) { setTimeout(r, 4000); });
  try {
    var docs = await listCourseDocuments(courseId);
    var doc = docs.find(function (d) { return d.id === docId; });
    if (!doc) return;
    _setRagStatus(el, doc.processing_status);
    if (doc.processing_status === 'ready') {
      if (cacheKey) _ragConfirmed[cacheKey] = 'ready';
      return;
    }
    if (doc.processing_status === 'failed') return;
    _pollRagStatus(el, courseId, docId, cacheKey, _attempts);
  } catch (e) {}
}
