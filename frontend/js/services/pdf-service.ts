import type { LegacyCourse } from '../../globals.js';

export function fetchPdfBytes(
  path: string,
  cb: (bytes: Uint8Array) => void,
  onError?: (err: Error) => void
): void {
  fetch(path)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => cb(new Uint8Array(buf)))
    .catch((e: unknown) => {
      if (onError) onError(e instanceof Error ? e : new Error(String(e)));
    });
}

interface CourseFileLite {
  name?: string;
  _storageName?: string;
  _uploaded?: boolean;
  _folder?: string | null;
}

export interface DownloadOpts {
  storageName?: string | null;
  folder?: string | null;
  course?: LegacyCourse | null;
}

function _resolveUploadedFile(fname: string): DownloadOpts | null {
  const course = window.activeCourseRef;
  if (!course) return null;
  const flat = (course.files || []) as unknown as CourseFileLite[];
  let hit = flat.find((x) => x.name === fname && x._uploaded && x._storageName);
  let folder: string | null = null;
  if (!hit && course.userFolders) {
    for (const fd of course.userFolders) {
      const f = (fd.files || []).find(
        (x) => (x as unknown as CourseFileLite).name === fname &&
               (x as unknown as CourseFileLite)._uploaded &&
               (x as unknown as CourseFileLite)._storageName
      ) as unknown as CourseFileLite | undefined;
      if (f) { hit = f; folder = fd.name; break; }
    }
  }
  if (!hit || !hit._storageName) return null;
  return { storageName: hit._storageName, folder, course };
}

export async function downloadFile(fname: string, opts?: DownloadOpts): Promise<void> {
  let buf: ArrayBuffer | null = null;

  let resolved: DownloadOpts | null = null;
  if (opts && opts.storageName) resolved = opts;
  else resolved = _resolveUploadedFile(fname);

  if (resolved && resolved.storageName && resolved.course && window._ufFetchBytes) {
    const uid = window._currentUser && (window._currentUser.id || window._currentUser.sub);
    try {
      const bytes = await window._ufFetchBytes(
        uid,
        resolved.course,
        resolved.storageName,
        resolved.folder ?? null
      );
      if (bytes && bytes.byteLength) {
        buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
    } catch { /* fall through to demo path */ }
  }

  if (!buf) {
    const PDF_DATA = window.PDF_DATA || {};
    const pdfPath = PDF_DATA[fname];
    if (pdfPath) {
      const r = await fetch(pdfPath);
      if (r.ok) buf = await r.arrayBuffer();
    }
  }

  if (!buf) {
    alert(window._t ? window._t('not_in_demo') : 'Not available in demo');
    return;
  }

  const ext = ((fname.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    html: 'text/html', htm: 'text/html', txt: 'text/plain',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
