// ── Course uploaded files — Supabase Storage ─────────────────────────────
// Bucket: "course-uploads"  (create in Supabase dashboard → Storage)
// Path:   <uid>/<courseKey>/<filename>
// RLS:    authenticated users can read/write/delete their own folder only.
var _UF_BUCKET = 'course-uploads';
var _SS_UPLOAD_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
var _SS_UPLOAD_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
var _SS_UPLOAD_AI_IMAGE_MAX_BYTES = 1024 * 1024;
var _SS_UPLOAD_ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.docx', '.png', '.jpg', '.jpeg'];
var _SS_UPLOAD_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg'
];
var _SS_UPLOAD_BLOCKED_EXTENSIONS = [
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.svg',
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.php',
  '.ps1',
  '.vbs',
  '.msi',
  '.jar',
  '.zip'
];

function _ufKey(course) {
  return (course.id || course.short || course.name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Long-lived tabs burn through the 1-hour Supabase JWT; calls that read
// _sbToken directly (upload/list/fetch-bytes) then 403 with "exp claim
// timestamp check failed". restoreSession refreshes at boot but not later,
// so we re-check here right before any authed storage call.
async function _ufEnsureFreshToken() {
  if (window._sbSessionReady) {
    // 5s timeout: _sbSessionReady wraps _sb.auth.refreshSession() / getUser()
    // which have no built-in timeout. If those Supabase SDK calls hang
    // (slow auth endpoint, degraded network), every storage operation
    // queues behind them indefinitely — and worse, their in-flight HTTP
    // requests occupy connection-pool slots so ai.js never gets to load.
    // Race the await against a timeout so we proceed with whatever token
    // we have rather than block the entire app forever.
    try {
      await Promise.race([
        window._sbSessionReady,
        new Promise(function (_resolve, reject) {
          setTimeout(function () { reject(new Error('sbSessionReady timeout')); }, 5000);
        })
      ]);
    } catch (e) {}
  }
  if (typeof _jwtAliveEnough === 'function' && _sbToken && !_jwtAliveEnough(_sbToken)) {
    // Same problem here — refreshSession is the same SDK call with no
    // built-in timeout. Race it too.
    try {
      await Promise.race([
        _sb.auth.refreshSession(),
        new Promise(function (_resolve, reject) {
          setTimeout(function () { reject(new Error('refreshSession timeout')); }, 5000);
        })
      ]);
    } catch (e) {}
  }
}

function _ssFileExt(name) {
  var lower = String(name || '').toLowerCase();
  var idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx) : '';
}

function _ssValidateUploadFile(file, opts) {
  opts = opts || {};
  if (!file) throw new Error('No file selected');

  var ext = _ssFileExt(file.name);
  var type = String(file.type || '').toLowerCase();
  var maxBytes = opts.maxBytes || _SS_UPLOAD_DEFAULT_MAX_BYTES;
  var allowedExts = opts.allowedExtensions || _SS_UPLOAD_ALLOWED_EXTENSIONS;
  var allowedTypes = opts.allowedMimeTypes || _SS_UPLOAD_ALLOWED_MIME_TYPES;
  var blockedExts = opts.blockedExtensions || _SS_UPLOAD_BLOCKED_EXTENSIONS;

  if (blockedExts.indexOf(ext) !== -1) throw new Error('Blocked file type: ' + ext);
  if (file.size > maxBytes) {
    var mb = (maxBytes / 1048576).toFixed(maxBytes >= 1048576 ? 0 : 1);
    throw new Error('File is too large. Max ' + mb + ' MB.');
  }
  if (allowedExts.indexOf(ext) === -1)
    throw new Error('Unsupported file type: ' + (ext || type || 'unknown'));
  if (type && allowedTypes.indexOf(type) === -1) {
    if (!(ext === '.jpg' && type === 'image/pjpeg'))
      throw new Error('Unsupported file type: ' + type);
  }
  return true;
}

function _ssValidateImageFile(file, maxBytes) {
  return _ssValidateUploadFile(file, {
    maxBytes: maxBytes || _SS_UPLOAD_IMAGE_MAX_BYTES,
    allowedExtensions: ['.png', '.jpg', '.jpeg'],
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/pjpeg'],
    blockedExtensions: _SS_UPLOAD_BLOCKED_EXTENSIONS
  });
}

window._ssValidateUploadFile = _ssValidateUploadFile;
window._ssValidateImageFile = _ssValidateImageFile;
window._SS_UPLOAD_AI_IMAGE_MAX_BYTES = _SS_UPLOAD_AI_IMAGE_MAX_BYTES;

function _ufSanitizeName(name) {
  // Keep only safe characters for Supabase storage keys
  return name
    .replace(/[^\x20-\x7E]/g, '_') // strip non-printable and non-ASCII (Arabic, etc.)
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_') // replace remaining unsafe chars
    .replace(/ +/g, '_') // spaces → underscores
    .replace(/_+/g, '_') // collapse multiple underscores
    .replace(/^_+|_+(?=\.[^.]+$)/g, ''); // trim leading underscores and before extension
}
function _ufStoragePath(uid, course, name, folder) {
  var safe = _ufSanitizeName(name);
  var base = uid + '/' + _ufKey(course) + '/';
  if (folder) {
    base += _ufSanitizeName(folder) + '/';
  }
  return base + safe;
}

function _ufEncodeStoragePath(path) {
  return String(path || '')
    .split('/')
    .map(function (part) {
      return encodeURIComponent(part);
    })
    .join('/');
}

function _ufFetchJsonWithTimeout(url, options, timeoutMs) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl
    ? setTimeout(function () {
        ctrl.abort();
      }, timeoutMs || 10000)
    : null;
  return fetch(url, Object.assign({}, options || {}, { signal: ctrl ? ctrl.signal : undefined }))
    .then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) return null;
      return r.json().catch(function () {
        return null;
      });
    })
    .catch(function (err) {
      if (timer) clearTimeout(timer);
      console.warn('[storage] list request failed/timed out:', err && (err.name || err.message));
      return null;
    });
}

// ── User folders (persisted in localStorage) ─────────────────────────────
function _ufFolderKey(uid, course) {
  return 'ss_ufolders_' + uid + '_' + _ufKey(course);
}
function _ufGetFolders(uid, course) {
  try {
    return JSON.parse(localStorage.getItem(_ufFolderKey(uid, course)) || '[]');
  } catch (e) {
    return [];
  }
}
function _ufSaveFolders(uid, course, list) {
  localStorage.setItem(_ufFolderKey(uid, course), JSON.stringify(list));
}
function _ufCreateFolder(uid, course, name) {
  var f = _ufGetFolders(uid, course);
  name = name.trim();
  if (!name || f.includes(name)) return false;
  f.push(name);
  _ufSaveFolders(uid, course, f);
  return true;
}
function _ufDeleteFolder(uid, course, name) {
  _ufSaveFolders(
    uid,
    course,
    _ufGetFolders(uid, course).filter(function (n) {
      return n !== name;
    })
  );
}

async function _ufListFolder(uid, course, folder) {
  var fe = encodeURIComponent(folder);
  if (/[^\x00-\x7F]/.test(folder)) fe = fe.replace(/%/g, '%25');
  var prefix = uid + '/' + _ufKey(course) + '/' + fe + '/';
  var items = await _ufFetchJsonWithTimeout(SUPA_URL + '/storage/v1/object/list/' + _UF_BUCKET, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + (_sbToken || SUPA_KEY),
      'Content-Type': 'application/json'
    },
    // sortBy is required by current Supabase Storage validation — older
    // versions accepted just { prefix, limit, offset }, newer ones 400.
    body: JSON.stringify({
      prefix: prefix,
      limit: 200,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' }
    })
  }, 10000);
  return Array.isArray(items) ? items : [];
}

// Upload one file with XHR so we get progress events
// onProgress(pct 0-100) is called as data uploads
async function _ufUpload(uid, course, file, onProgress, folder) {
  _ssValidateUploadFile(file);
  await _ufEnsureFreshToken();
  return new Promise(function (resolve, reject) {
    var path = _ufStoragePath(uid, course, file.name, folder || null);
    var url = SUPA_URL + '/storage/v1/object/' + _UF_BUCKET + '/' + path;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('apikey', SUPA_KEY);
    xhr.setRequestHeader('Authorization', 'Bearer ' + (_sbToken || SUPA_KEY));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    if (onProgress) {
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        console.error('Upload failed', xhr.status, xhr.responseText);
        reject(new Error('Upload failed: ' + xhr.status + ' ' + xhr.responseText));
      }
    };
    xhr.onerror = function () {
      reject(new Error('Network error'));
    };
    xhr.send(file);
  });
}

// List files for user+course from Supabase Storage
async function _ufList(uid, course) {
  // Wait for session restore so the request uses the real token, not anon.
  // Without this, prewarm-on-boot lists with SUPA_KEY → empty results → cards
  // show 0 files until the user reopens the course.
  await _ufEnsureFreshToken();

  var prefix = uid + '/' + _ufKey(course) + '/';
  var items = await _ufFetchJsonWithTimeout(SUPA_URL + '/storage/v1/object/list/' + _UF_BUCKET, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + (_sbToken || SUPA_KEY),
      'Content-Type': 'application/json'
    },
    // sortBy is required by current Supabase Storage validation — older
    // versions accepted just { prefix, limit, offset }, newer ones 400.
    body: JSON.stringify({
      prefix: prefix,
      limit: 200,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' }
    })
  }, 10000);
  return Array.isArray(items) ? items : [];
}

// Fetch an uploaded file's bytes directly using the authenticated endpoint.
// Public entry — wraps the multi-fallback impl in a hard 45s overall cap so
// the cascade of (3 endpoints + signed URL) × (4 name fallbacks) can never
// keep the PDF viewer's "Loading…" overlay open forever. Each per-request
// timeout inside is shorter; this is the last-line safety against the worst
// total elapsed time.
async function _ufFetchBytes(uid, course, name, folder) {
  var overallTimeout = new Promise(function (_resolve, reject) {
    setTimeout(function () { reject(new Error('_ufFetchBytes overall timeout')); }, 45000);
  });
  try {
    return await Promise.race([_ufFetchBytesImpl(uid, course, name, folder), overallTimeout]);
  } catch (e) {
    if (e && e.message === '_ufFetchBytes overall timeout') {
      console.warn('[storage] _ufFetchBytes timed out after 45s for', name);
    }
    return null;
  }
}

async function _ufFetchBytesImpl(uid, course, name, folder) {
  // Wait for session restore to finish (fixes race on page refresh where restoreState
  // calls openFile before restoreSession has set _sbToken) and refresh the JWT
  // if it has expired during a long-lived tab.
  await _ufEnsureFreshToken();

  var courseKey = _ufKey(course);
  var token = _sbToken || SUPA_KEY;

  async function _fetchWithTimeout(url, opts, connectTimeoutMs, bodyTimeoutMs) {
    var ctrl = new AbortController();
    // Abort if server never responds (connection/headers timeout)
    var connectTimer = setTimeout(function () {
      ctrl.abort();
    }, connectTimeoutMs || 20000);
    try {
      var r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(connectTimer);
      if (!r.ok) return r;
      // Server responded — now download the body with a longer timeout
      var bodyTimer = setTimeout(function () {
        ctrl.abort();
      }, bodyTimeoutMs || 120000);
      try {
        var buf = await r.arrayBuffer();
        clearTimeout(bodyTimer);
        return {
          ok: true,
          arrayBuffer: function () {
            return Promise.resolve(buf);
          },
          json: function () {
            return Promise.resolve(JSON.parse(new TextDecoder().decode(buf)));
          }
        };
      } catch (e) {
        clearTimeout(bodyTimer);
        throw e;
      }
    } catch (e) {
      clearTimeout(connectTimer);
      throw e;
    }
  }

  async function _fetchPath(path) {
    var encodedPath = _ufEncodeStoragePath(path);
    // Try all three Supabase Storage access patterns
    var endpoints = [
      SUPA_URL + '/storage/v1/object/' + _UF_BUCKET + '/' + encodedPath, // direct (works for public buckets + auth)
      SUPA_URL + '/storage/v1/object/authenticated/' + _UF_BUCKET + '/' + encodedPath, // authenticated RLS
      SUPA_URL + '/storage/v1/object/public/' + _UF_BUCKET + '/' + encodedPath // public bucket
    ];
    for (var i = 0; i < endpoints.length; i++) {
      try {
        var r = await _fetchWithTimeout(
          endpoints[i],
          { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token } },
          15000,
          180000
        );
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
      } catch (e) {}
    }
    // Last resort: signed URL
    try {
      var signRes = await _fetchWithTimeout(
        SUPA_URL + '/storage/v1/object/sign/' + _UF_BUCKET + '/' + encodedPath,
        {
          method: 'POST',
          headers: {
            apikey: SUPA_KEY,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ expiresIn: 300 })
        },
        15000
      );
      if (signRes.ok) {
        var sd = await signRes.json();
        var su = sd.signedURL || sd.signedUrl || sd.signed_url || '';
        if (su) {
          if (!su.startsWith('http'))
            su = SUPA_URL + (su.startsWith('/storage') ? '' : '/storage/v1') + su;
          var sr = await _fetchWithTimeout(su, {}, 15000, 180000);
          if (sr.ok) return new Uint8Array(await sr.arrayBuffer());
        }
      }
    } catch (e) {}
    return null;
  }

  var folderPart = folder ? _ufSanitizeName(folder) + '/' : '';
  var base = uid + '/' + courseKey + '/' + folderPart;

  // Try 1: exact storageName
  var bytes = await _fetchPath(base + name);
  if (bytes) return bytes;

  // Try 2: sanitized name fallback
  var safeName = _ufSanitizeName(name);
  if (safeName !== name) {
    bytes = await _fetchPath(base + safeName);
    if (bytes) return bytes;
  }

  // Try 3: unsanitized folder name
  if (folder && folder !== _ufSanitizeName(folder)) {
    bytes = await _fetchPath(uid + '/' + courseKey + '/' + folder + '/' + name);
    if (bytes) return bytes;
  }

  // Try 4: refresh the storage listing and use the exact object key returned by Supabase.
  // This helps when a restored/cached file entry has an old display name or storage key.
  try {
    var listed = folder ? await _ufListFolder(uid, course, folder) : await _ufList(uid, course);
    for (var li = 0; li < listed.length; li++) {
      var item = listed[li] || {};
      if (!item.id || !item.name) continue;
      var objectName = decodeURIComponent(item.name || '');
      var meta = item.metadata || {};
      var original = (meta.userMetadata && meta.userMetadata.originalName) || '';
      var objectFile = objectName.split('/').pop();
      if (
        objectName === name ||
        objectFile === name ||
        original === name ||
        objectName === safeName ||
        objectFile === safeName
      ) {
        var exactPath =
          objectName.indexOf('/') !== -1
            ? uid + '/' + courseKey + '/' + objectName
            : base + objectName;
        bytes = await _fetchPath(exactPath);
        if (bytes) return bytes;
      }
    }
  } catch (e) {}

  var storageErr = new Error(
    'File not found. Path: ' +
      base +
      name +
      ' — check Supabase bucket policies allow SELECT for authenticated users.'
  );
  storageErr._storageError = true;
  throw storageErr;
}

// Delete one file from Supabase Storage
async function _ufDeleteRemote(uid, course, name, folder, storageName) {
  var path;
  if (storageName) {
    // Use exact storage key to avoid re-sanitizing display names of old files
    var base = uid + '/' + _ufKey(course) + '/' + (folder ? _ufSanitizeName(folder) + '/' : '');
    path = base + storageName;
  } else {
    path = _ufStoragePath(uid, course, name, folder || null);
  }
  await fetch(SUPA_URL + '/storage/v1/object/' + _UF_BUCKET + '/' + path, {
    method: 'DELETE',
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + (_sbToken || SUPA_KEY) }
  });
}

// Dedup map: when prewarm and a course-open click both fire _ufMerge for the
// same course, the second caller reuses the first call's Promise instead of
// firing a duplicate Supabase storage list.
var _ufMergeInFlight = {};

function _ufCloneMergedFile(f, course, folder) {
  var copy = Object.assign({}, f);
  copy._course = course;
  if (folder) copy._folder = folder;
  else delete copy._folder;
  return copy;
}

function _ufCopyMergedState(fromCourse, toCourse) {
  if (!fromCourse || !toCourse || fromCourse === toCourse) return;
  var localFiles = (toCourse.files || []).filter(function (f) {
    return !f._uploaded;
  });
  var uploadedRoot = (fromCourse.files || []).filter(function (f) {
    return f._uploaded && !f._folder;
  }).map(function (f) {
    return _ufCloneMergedFile(f, toCourse, null);
  });
  toCourse.files = localFiles.concat(uploadedRoot);
  if (Array.isArray(fromCourse.userFolders)) {
    toCourse.userFolders = fromCourse.userFolders.map(function (fd) {
      return {
        name: fd.name,
        files: (fd.files || []).map(function (f) {
          return _ufCloneMergedFile(f, toCourse, fd.name);
        })
      };
    });
  }
  toCourse._filesLoading = false;
}

// Merge remote file list into course.files + course.userFolders (called on openCourse)
function _ufMerge(course) {
  if (!course || !course.id) return Promise.resolve();
  var inFlight = _ufMergeInFlight[course.id];
  if (inFlight) {
    if (inFlight.course === course) return inFlight.promise;
    var copyRootBeforeViewRenders = function (ev) {
      var detail = ev && ev.detail;
      if (!detail || detail.courseId !== course.id) return;
      _ufCopyMergedState(inFlight.course, course);
      window.removeEventListener('uf-merge-root-done', copyRootBeforeViewRenders, true);
    };
    window.addEventListener('uf-merge-root-done', copyRootBeforeViewRenders, true);
    if (
      (inFlight.course.files || []).some(function (f) { return f._uploaded; }) ||
      (inFlight.course.userFolders || []).some(function (fd) { return fd.files && fd.files.length; })
    ) {
      _ufCopyMergedState(inFlight.course, course);
      setTimeout(function () {
        try {
          window.dispatchEvent(new CustomEvent('uf-merge-root-done', {
            detail: { courseId: course.id, course: course }
          }));
        } catch (e) {}
      }, 0);
    }
    return inFlight.promise.then(function () {
      window.removeEventListener('uf-merge-root-done', copyRootBeforeViewRenders, true);
      _ufCopyMergedState(inFlight.course, course);
    });
  }
  var p = _ufMergeImpl(course).finally(function () {
    delete _ufMergeInFlight[course.id];
  });
  _ufMergeInFlight[course.id] = { promise: p, course: course };
  return p;
}

async function _ufMergeImpl(course) {
  var uid = _currentUser && (_currentUser.id || _currentUser.sub);
  if (!uid) return;
  function _parseMeta(item) {
    var fname = decodeURIComponent(item.name || '');
    if (!fname || fname.endsWith('/') || !item.id) return null; // skip folder entries (id is null for folders)
    var meta = item.metadata || {};
    // Use original filename from metadata if the storage key was sanitized
    var displayName = (meta.userMetadata && meta.userMetadata.originalName) || fname;
    var size = meta.size
      ? meta.size > 1048576
        ? (meta.size / 1048576).toFixed(1) + ' MB'
        : meta.size > 1024
          ? (meta.size / 1024).toFixed(0) + ' KB'
          : meta.size + ' B'
      : '';
    var date = item.updated_at
      ? new Date(item.updated_at).toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        })
      : '';
    return { name: displayName, storageName: fname, size: size, date: date };
  }
  // Clear previously uploaded files so stale entries don't persist after moves/deletes
  course.files = (course.files || []).filter(function (f) {
    return !f._uploaded;
  });
  // Root listing — files have an id, folder entries have id: null
  var items = await _ufList(uid, course);
  var discoveredFolders = [];
  items.forEach(function (item) {
    if (!item.id && item.name && !item.name.endsWith('/')) {
      // This is a subfolder prefix entry — collect folder name
      var fn = decodeURIComponent(item.name);
      if (fn && !discoveredFolders.includes(fn)) discoveredFolders.push(fn);
      return;
    }
    var m = _parseMeta(item);
    if (!m) return;
    // Skip files that are inside a subfolder (their storage name contains '/')
    if (m.storageName && m.storageName.indexOf('/') !== -1) return;
    if (
      !course.files.find(function (f) {
        return f.name === m.name && f._uploaded;
      })
    )
      course.files.unshift({
        name: m.name,
        _storageName: m.storageName,
        size: m.size,
        date: m.date,
        _uploaded: true,
        _uid: uid,
        _course: course
      });
  });

  // Root listing is done. Fire an event so the course view can render the
  // root files immediately — folder listings continue below in parallel.
  // Without this, the UI waits for the *last* folder list to clear the spinner.
  try {
    window.dispatchEvent(new CustomEvent('uf-merge-root-done', {
      detail: { courseId: course.id, course: course }
    }));
  } catch (e) {}

  // Merge discovered folders with localStorage list so neither source loses data
  var savedFolders = _ufGetFolders(uid, course);
  var allFolders = savedFolders.slice();
  discoveredFolders.forEach(function (fn) {
    if (!allFolders.includes(fn)) allFolders.push(fn);
  });
  if (allFolders.length !== savedFolders.length) _ufSaveFolders(uid, course, allFolders);

  // Limit folder-list fanout. Fully parallel folder listing made refreshes feel
  // frozen on accounts with many folders because each course merge could start
  // a burst of Supabase requests while the UI was still settling.
  var folderResults = [];
  var folderCursor = 0;
  function _nextFolder() {
    if (folderCursor >= allFolders.length) return Promise.resolve();
    var folderName = allFolders[folderCursor++];
    return _ufListFolder(uid, course, folderName)
      .then(
        function (folderItems) { folderResults.push({ name: folderName, items: folderItems }); },
        function () { folderResults.push({ name: folderName, items: [] }); }
      )
      .then(_nextFolder);
  }
  var folderLanes = [];
  for (var fi = 0; fi < Math.min(2, allFolders.length); fi++) folderLanes.push(_nextFolder());
  await Promise.all(folderLanes);
  course.userFolders = folderResults.map(function (fr) {
    var folderFiles = [];
    fr.items.forEach(function (item) {
      var m = _parseMeta(item);
      if (!m) return;
      folderFiles.push({
        name: m.name,
        _storageName: m.storageName,
        size: m.size,
        date: m.date,
        _uploaded: true,
        _uid: uid,
        _course: course,
        _folder: fr.name
      });
    });
    return { name: fr.name, files: folderFiles };
  });
}

// Delete — removes from Supabase and from course.files / course.userFolders in memory
function _ufDelete(course, name, folder, storageName) {
  var uid = _currentUser && (_currentUser.id || _currentUser.sub);
  if (uid) _ufDeleteRemote(uid, course, name, folder || null, storageName || null);
  if (folder) {
    (course.userFolders || []).forEach(function (fd) {
      if (fd.name === folder)
        fd.files = fd.files.filter(function (f) {
          return f.name !== name;
        });
    });
  } else {
    course.files = course.files.filter(function (f) {
      return !(f.name === name && f._uploaded);
    });
  }
  try {
    localStorage.removeItem('ss_uf_cache_' + course.id);
  } catch (e) {}
}

function _ufDropCachedUploadedFile(course, file) {
  if (!course || !file) return;
  var name = file.name;
  var folder = file._folder || null;
  if (folder) {
    (course.userFolders || []).forEach(function (fd) {
      if (fd.name === folder)
        fd.files = (fd.files || []).filter(function (f) {
          return !(f.name === name && f._uploaded);
        });
    });
  } else {
    course.files = (course.files || []).filter(function (f) {
      return !(f.name === name && f._uploaded);
    });
  }
  try {
    var cacheKey = 'ss_uf_cache_' + course.id;
    var cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached) {
      cached.files = (cached.files || []).filter(function (f) {
        return f.name !== name;
      });
      cached.folders = (cached.folders || []).map(function (fd) {
        return {
          name: fd.name,
          files: (fd.files || []).filter(function (f) {
            return !(fd.name === folder && f.name === name);
          })
        };
      });
      localStorage.setItem(cacheKey, JSON.stringify(cached));
    }
    var total =
      (course.files || []).length +
      (course.userFolders || []).reduce(function (s, fd) {
        return s + (fd.files || []).length;
      }, 0);
    localStorage.setItem('ss_fc_' + course.id, total + '');
  } catch (e) {}
  if (activeFileName === name) activeFileName = null;
}

function _ssClearRestoredFileState(course, message) {
  if (!course) return;
  activeFileName = null;
  activeCourseSection = 'files';
  showCourseSection(course, 'files');
  try {
    localStorage.setItem(
      'ss_state',
      JSON.stringify({
        semId: activeSemId,
        courseId: course.id,
        fileName: null,
        section: 'files',
        inApp: true
      })
    );
    _ssReplaceHistory(
      { view: 'course', courseId: course.id, section: 'files' },
      '#course=' + encodeURIComponent(course.id || '') + '&section=files'
    );
  } catch (e) {}
  if (message && typeof showToast === 'function') showToast('File not reopened', message);
}

// Move a file via server-side copy then delete (no download needed)
async function _ufMoveFileTo(uid, fromCourse, toCourse, fname, fromFolder, toFolder, storageName) {
  var srcKey;
  if (storageName) {
    var srcBase =
      uid + '/' + _ufKey(fromCourse) + '/' + (fromFolder ? _ufSanitizeName(fromFolder) + '/' : '');
    srcKey = srcBase + storageName;
  } else {
    srcKey = _ufStoragePath(uid, fromCourse, fname, fromFolder || null);
  }
  var dstKey = _ufStoragePath(uid, toCourse, fname, toFolder || null);
  if (srcKey === dstKey) return;
  var r = await fetch(SUPA_URL + '/storage/v1/object/copy', {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + (_sbToken || SUPA_KEY),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bucketId: _UF_BUCKET, sourceKey: srcKey, destinationKey: dstKey })
  });
  if (!r.ok) throw new Error('Copy failed: ' + r.status);
  await fetch(SUPA_URL + '/storage/v1/object/' + _UF_BUCKET + '/' + srcKey, {
    method: 'DELETE',
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + (_sbToken || SUPA_KEY) }
  });
}

async function _ufMoveFile(uid, course, fname, fromFolder, toFolder) {
  if ((fromFolder || null) === (toFolder || null)) return;
  var srcKey = _ufStoragePath(uid, course, fname, fromFolder || null);
  var dstKey = _ufStoragePath(uid, course, fname, toFolder || null);
  var r = await fetch(SUPA_URL + '/storage/v1/object/copy', {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + (_sbToken || SUPA_KEY),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bucketId: _UF_BUCKET, sourceKey: srcKey, destinationKey: dstKey })
  });
  if (!r.ok) throw new Error('Copy failed: ' + r.status);
  await _ufDeleteRemote(uid, course, fname, fromFolder || null);
}

// Rename a folder. The cross-device source of truth for folder names is the
// Supabase storage path prefix (_ufMerge derives the folder list from it), so
// we move every file in the folder from the old prefix to the new one. The
// localStorage folder list is updated too so empty folders (no storage objects
// yet) also rename. File open/download builds paths from the live folder name,
// so it keeps working after the rename.
async function _ufRenameFolder(uid, course, oldName, newName) {
  oldName = (oldName || '').trim();
  newName = (newName || '').trim();
  if (!uid || !oldName || !newName || oldName === newName) return;
  var fd = (course.userFolders || []).find(function (x) {
    return x.name === oldName;
  });
  var files = fd ? fd.files || [] : [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    await _ufMoveFileTo(uid, course, course, f.name, oldName, newName, f._storageName || null);
  }
  var list = _ufGetFolders(uid, course).map(function (n) {
    return n === oldName ? newName : n;
  });
  if (list.indexOf(newName) === -1) list.push(newName);
  _ufSaveFolders(uid, course, list);
}
