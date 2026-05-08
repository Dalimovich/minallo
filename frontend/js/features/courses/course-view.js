import { panelShow, panelHide } from '../../core/panels.js';
import { bindFileEvents } from './course-files.js';
import { bindFolderEvents } from './course-folders.js';
import { buildFilesContent } from './course-render.js';

export function openCourse(course) {
  if (!course.files) course.files = [];
  window.activeCourseId = course.id;
  window.activeFileName = null;

  panelHide(document.getElementById('welcomeState'));
  panelHide(document.getElementById('pdfView'));
  var co = document.getElementById('courseOverview');
  if (co) co.style.display = 'block';

  var crumb = document.getElementById('breadcrumb');
  if (crumb) {
    crumb.textContent = '';
    var b = document.createElement('b');
    b.textContent = course.name;
    crumb.appendChild(b);
  }

  // Apply cached uploaded files immediately so the list shows without waiting for network
  var ufCacheKey = 'ss_uf_cache_' + course.id;
  try {
    var cached = JSON.parse(localStorage.getItem(ufCacheKey) || 'null');
    if (cached && Array.isArray(cached.files)) {
      var uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      cached.files.forEach(function (f) {
        if (
          !course.files.find(function (x) {
            return x.name === f.name && x._uploaded;
          })
        )
          course.files.unshift({
            name: f.name,
            _storageName: f.storageName,
            size: f.size,
            date: f.date,
            _uploaded: true,
            _uid: uid,
            _course: course
          });
      });
      course.userFolders = (cached.folders || []).map(function (fd) {
        return {
          name: fd.name,
          files: fd.files.map(function (f) {
            return {
              name: f.name,
              _storageName: f.storageName,
              size: f.size,
              date: f.date,
              _uploaded: true,
              _uid: uid,
              _course: course,
              _folder: fd.name
            };
          })
        };
      });
    }
  } catch (e) {}

  // Mark loading only if there's nothing in cache to show yet
  var hasCache =
    course.files.length > 0 ||
    (course.userFolders || []).some(function (fd) {
      return fd.files && fd.files.length > 0;
    });
  if (!hasCache) course._filesLoading = true;

  showCourseSection(course, 'files');
  if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(false);
  if (typeof window.renderCourses === 'function') window.renderCourses();

  // Refresh from network in background and update cache
  var _myCourseSeq = ++window._courseOpenSeq;
  window
    ._ufMerge(course)
    .then(function () {
      course._filesLoading = false;
      if (_myCourseSeq !== window._courseOpenSeq) return;
      window._ssRestoring = true;
      showCourseSection(course, 'files');
      window._ssRestoring = false;
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
                return { name: f.name, storageName: f._storageName, size: f.size, date: f.date };
              })
            };
          })
        };
        localStorage.setItem(ufCacheKey, JSON.stringify(toCache));
        var _totalCount =
          course.files.length +
          (course.userFolders || []).reduce(function (s, fd) {
            return s + (fd.files ? fd.files.length : 0);
          }, 0);
        localStorage.setItem('ss_fc_' + course.id, _totalCount + '');
      } catch (e) {}
    })
    .catch(function () {
      course._filesLoading = false;
    });
}

export function showCourseSection(course, section) {
  section = ['files', 'quiz', 'flashcards'].includes(section) ? section : 'files';
  window.activeCourseRef = course;
  window.activeCourseSection = section;
  window.activeFileName = null;

  document.getElementById('pdfView').style.display = 'none';
  document.getElementById('welcomeState').style.display = 'none';
  var co = document.getElementById('courseOverview');

  // Preserve active tab before re-rendering so background refreshes don't kick user back to Files
  var prevTab = null;
  var prevActivePanel = co.querySelector('[data-course-panel].active');
  if (prevActivePanel) prevTab = prevActivePanel.getAttribute('data-course-panel');

  co.style.display = 'block';
  co.innerHTML =
    '<div class="co-inner">' +
    '<div class="co-logo">📚 StudySphere</div>' +
    (course.meta ? '<p class="co-tag">' + course.name + ' · ' + course.meta + '</p>' : '') +
    '<div class="co-card" style="margin-top:0">' +
    buildFilesContent(course) +
    '</div>' +
    '</div>';

  var coInner = co.querySelector('.co-inner');
  if (coInner) {
    coInner.classList.remove('panel-enter');
    void coInner.offsetWidth;
    coInner.classList.add('panel-enter');
  }

  bindFileEvents(co, course);
  bindFolderEvents(co, course);

  // Activate the requested tab (or restore previous tab if re-rendering)
  var targetTab = (section !== 'files') ? section : (prevTab && prevTab !== 'files' ? prevTab : null);
  if (targetTab) {
    var tabBtn = co.querySelector('[data-course-tab="' + targetTab + '"]');
    if (tabBtn) tabBtn.click();
  }
}
