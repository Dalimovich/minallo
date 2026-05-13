import { showCourseSection } from './course-view.js';
import { indexExistingDocument } from '../../services/ai-service.js';
import type { LegacyCourse } from '../../../globals.js';

interface FolderUploadInput extends HTMLInputElement {
  _targetFolder?: string;
}

interface DocMeta {
  lectureNumber?: number;
  exerciseNumber?: number;
}

function _guessFolderDocMeta(fileName: string): DocMeta {
  const n = fileName.replace(/\.[^.]+$/, '');
  const meta: DocMeta = {};
  let m = n.match(/(?:lecture|vorlesung|vl|lec)[_\s-]*(\d+)/i);
  if (m && m[1]) {
    meta.lectureNumber = parseInt(m[1], 10);
    return meta;
  }
  m = n.match(/(?:exercise|aufgabe|seminar|ag|uebung|übung|ue)[_\s-]*(\d+)/i);
  if (m && m[1]) {
    meta.exerciseNumber = parseInt(m[1], 10);
    return meta;
  }
  return meta;
}

function _guessFolderSourceType(fileName: string): string {
  const n = fileName.toLowerCase();
  if (n.includes('lösung') || n.includes('loesung') || n.includes('solution')) return 'solution';
  if (n.includes('aufgabe') || n.includes('exercise') || n.includes('übung') || n.includes('ag_')) {
    return 'exercise';
  }
  if (n.includes('exam') || n.includes('klausur') || n.includes('prüfung')) return 'exam';
  if (n.includes('notes') || n.includes('notiz') || n.includes('mitschrift')) return 'notes';
  return 'lecture';
}

interface CourseFileLite {
  name?: string;
  _storageName?: string;
  _uploaded?: boolean;
  _folder?: string | null;
}

export function bindFolderEvents(co: HTMLElement, course: LegacyCourse): void {
  // Restore open folder state
  co.querySelectorAll<HTMLElement>('.co-folder-section').forEach((sec) => {
    const name = sec.getAttribute('data-folder');
    if (name && window._openFolders && window._openFolders.has(name)) {
      sec.classList.remove('collapsed');
    }
  });

  // Folder select-all
  co.querySelectorAll<HTMLElement>('.co-folder-select-all-btn').forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const sec = btn.closest('.co-folder-section');
      if (!sec) return;
      sec.querySelectorAll<HTMLElement>('.co-file[data-fname]').forEach((el) => {
        const fname = el.getAttribute('data-fname');
        const folderAttr = el.getAttribute('data-folder') || null;
        const snameA = el.querySelector('.co-del-btn')?.getAttribute('data-sname') || null;
        if (!window._selectedFiles) window._selectedFiles = [];
        const already = window._selectedFiles.findIndex(
          (s) => s.name === fname && s.folder === folderAttr
        );
        if (already === -1 && fname) {
          window._selectedFiles.push({ name: fname, folder: folderAttr, sname: snameA });
          el.classList.add('selected');
          el.querySelector('.co-file-cb')?.classList.add('checked');
        }
      });
    });
  });

  // Folder header toggle
  co.querySelectorAll<HTMLElement>('.co-folder-header').forEach((hdr) => {
    hdr.addEventListener('click', (e: Event) => {
      const target = e.target as Element | null;
      if (
        target?.closest('.co-folder-up-btn') ||
        target?.closest('.co-folder-del-btn') ||
        target?.closest('.co-folder-select-all-btn')
      ) {
        return;
      }
      const sec = hdr.closest('.co-folder-section');
      if (!sec) return;
      sec.classList.toggle('collapsed');
      const name = sec.getAttribute('data-folder');
      if (name && window._openFolders) {
        if (sec.classList.contains('collapsed')) window._openFolders.delete(name);
        else window._openFolders.add(name);
      }
    });
  });

  // Folder delete
  co.querySelectorAll<HTMLButtonElement>('.co-folder-del-btn').forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const folderName = btn.getAttribute('data-folder');
      if (!folderName) return;
      const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      const fd = (course.userFolders || []).find((f) => f.name === folderName);
      const n = fd ? fd.files.length : 0;
      if (
        !confirm(
          'Delete folder "' + folderName + '"' +
          (n ? ' and its ' + n + ' file' + (n !== 1 ? 's' : '') : '') + '?'
        )
      ) {
        return;
      }
      btn.disabled = true;
      const delPromises = fd
        ? fd.files.map((f) => {
            const fileName = (f as CourseFileLite).name || '';
            return window._ufDeleteRemote?.(uid, course, fileName, folderName);
          })
        : [];
      Promise.allSettled(delPromises).then((results) => {
        window._ufDeleteFolder?.(uid, course, folderName);
        course.userFolders = (course.userFolders || []).filter((f) => f.name !== folderName);
        showCourseSection(course, 'files');
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed && typeof window.showToast === 'function') {
          window.showToast(
            'Warning',
            failed + ' file' + (failed !== 1 ? 's' : '') + ' could not be removed from storage.'
          );
        }
      });
    });
  });

  // Upload to folder
  const folderUploadInput = co.querySelector<FolderUploadInput>('#coFolderUploadInput');
  co.querySelectorAll<HTMLElement>('.co-folder-up-btn').forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      if (folderUploadInput) {
        folderUploadInput._targetFolder = btn.getAttribute('data-folder') || undefined;
        folderUploadInput.click();
      }
    });
  });

  if (folderUploadInput) {
    folderUploadInput.addEventListener('change', function (this: FolderUploadInput) {
      const targetFolder = this._targetFolder;
      const files = Array.from(this.files || []);
      if (!files.length || !targetFolder) return;
      const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) {
        if (typeof window.showToast === 'function') {
          window.showToast('Not signed in', 'Sign in to upload files.');
        }
        return;
      }
      Promise.all(
        files.map((file) => window._ufUpload?.(uid, course, file, null, targetFolder))
      )
        .then(() => {
          course.userFolders = null as unknown as LegacyCourse['userFolders'];
          return window._ufMerge?.(course);
        })
        .then(() => {
          showCourseSection(course, 'files');
          if (typeof window.showToast === 'function') {
            window.showToast(
              'Files uploaded',
              files.length + ' file' + (files.length !== 1 ? 's' : '') +
              ' added to "' + targetFolder + '"'
            );
          }
          if (course.id) {
            let allFolderFiles: CourseFileLite[] = [];
            (course.userFolders || []).forEach((fd) => {
              allFolderFiles = allFolderFiles.concat((fd.files || []) as unknown as CourseFileLite[]);
            });
            files
              .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
              .forEach((pf) => {
                const merged = allFolderFiles.find(
                  (x) => x.name === pf.name && x._uploaded && x._storageName
                );
                if (merged && merged._storageName && merged.name) {
                  const st = _guessFolderSourceType(pf.name);
                  indexExistingDocument(
                    course.id,
                    merged._storageName,
                    merged.name,
                    st,
                    merged._folder || targetFolder || null,
                    _guessFolderDocMeta(pf.name)
                  ).catch(() => {});
                }
              });
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : 'Please try again.';
          if (typeof window.showToast === 'function') window.showToast('Upload failed', msg);
        });
      this.value = '';
    });
  }

  // New folder
  const newFolderBtn = co.querySelector<HTMLButtonElement>('#coNewFolderBtn');
  if (newFolderBtn) {
    newFolderBtn.addEventListener('click', () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
      if (!uid) return;
      if (!window._ufCreateFolder?.(uid, course, name.trim())) {
        if (typeof window.showToast === 'function') {
          window.showToast('Already exists', 'A folder with that name already exists.');
        }
        return;
      }
      if (!course.userFolders) course.userFolders = [];
      course.userFolders.push({ name: name.trim(), files: [] });
      showCourseSection(course, 'files');
    });
  }
}

export function showFolderPickerPopup(
  anchorEl: HTMLElement,
  folders: string[],
  onPick: (folder: string | null) => void
): void {
  const existing = document.getElementById('_folderPickerPopup');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const popup = document.createElement('div');
  popup.id = '_folderPickerPopup';
  popup.style.cssText =
    'position:fixed;z-index:9999;background:var(--dp-solid,#1e1e2e);border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.4);padding:6px;min-width:180px;font-size:.85rem;';

  function item(label: string, value: string | null): HTMLElement {
    const el = document.createElement('div');
    el.textContent = label;
    el.style.cssText =
      'padding:8px 12px;border-radius:7px;cursor:pointer;color:var(--on-glass,#e2e8f0);white-space:nowrap;';
    el.addEventListener('mouseenter', () => {
      el.style.background = 'rgba(255,255,255,.08)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = '';
    });
    el.addEventListener('click', () => {
      cleanup();
      onPick(value);
    });
    return el;
  }

  popup.appendChild(item('📂 Root (no folder)', null));
  folders.forEach((f) => {
    popup.appendChild(item('📁 ' + f, f));
  });
  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = rect.bottom + 4 + 'px';
  popup.style.left = rect.left + 'px';

  function cleanup(): void {
    if (popup.parentNode) popup.parentNode.removeChild(popup);
    document.removeEventListener('click', outsideClick, true);
  }
  function outsideClick(e: Event): void {
    const target = e.target as Node | null;
    if (target && !popup.contains(target) && target !== anchorEl) cleanup();
  }
  setTimeout(() => {
    document.addEventListener('click', outsideClick, true);
  }, 0);
}
