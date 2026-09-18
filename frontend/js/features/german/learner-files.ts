import { clearCourseDocumentCache, listCourseDocuments, type CourseDocument } from '../../services/ai-service.js';
import { authenticatedFetch, authenticatedSupabaseFetch } from '../../services/authenticated-fetch.js';
import { MAX_UPLOAD_BYTES } from '../courses/upload-validate.js';
import type { LegacyCourse } from '../../../globals.js';

const CANONICAL_SCOPE = 'german-files';
const LEGACY_SCOPES = [
  'german-general', 'german-reading', 'german-listening', 'german-sprachbausteine',
  'german-writing', 'german-speaking', 'german-vocab', 'german-grammar',
  'german-sentences', 'german-games',
];
const SCOPES = [CANONICAL_SCOPE, ...LEGACY_SCOPES];

export type LearnerFile = {
  id: string;
  documentId: string | null;
  documentName: string;
  learnerFileScope: string;
  name: string;
  _storageName: string;
  _folder: string | null;
  _uid: string;
  _uploaded: true;
  _document?: CourseDocument;
  size?: string;
};

type StorageFile = { name: string; _storageName?: string; _folder?: string | null; size?: string };
type StorageScope = LegacyCourse & { files?: StorageFile[]; userFolders?: Array<{ name: string; files?: StorageFile[] }> };
type StorageWindow = Window & {
  _ssValidateUploadFile?: (file: File, options?: { maxBytes: number }) => void;
  _ufSanitizeName?: (name: string) => string;
};

export function getLearnerFileStorageScope(): StorageScope {
  return { id: CANONICAL_SCOPE, short: CANONICAL_SCOPE, name: 'German Files' } as StorageScope;
}

function userId(): string {
  const uid = window._currentUser?.id || window._currentUser?.sub;
  if (!uid) throw new Error('Sign in to use your German files.');
  return uid;
}

function assertOwner(file: LearnerFile): void {
  if (file._uid !== userId() || !SCOPES.includes(file.learnerFileScope)) {
    throw new Error('This file is not in your learner library.');
  }
}

function storageScope(file: LearnerFile): StorageScope {
  assertOwner(file);
  return { id: file.learnerFileScope, short: file.learnerFileScope, name: 'German Files' } as StorageScope;
}

function entry(uid: string, scope: string, file: StorageFile, docs: CourseDocument[]): LearnerFile {
  const storageName = file._storageName || file.name;
  const folder = file._folder || null;
  const path = `${uid}/${scope}/${folder ? folder + '/' : ''}${storageName}`;
  const doc = docs.find((item) => item.storage_path === path || item.storage_path === `course-uploads:${path}`);
  return {
    id: doc?.id || `storage:${path}`, documentId: doc?.id || null,
    documentName: doc?.file_name || file.name, learnerFileScope: scope,
    name: doc?.file_name || file.name, _storageName: storageName, _folder: folder,
    _uid: uid, _uploaded: true, _document: doc, size: file.size,
  };
}

/** Storage keys stay internal: no SEMS registry or active university course is consulted. */
export async function listLearnerFiles(options: { force?: boolean } = {}): Promise<LearnerFile[]> {
  const uid = userId();
  if (!window._ufMerge) throw new Error('File storage is still loading. Please retry.');
  const groups = await Promise.all(SCOPES.map(async (id) => {
    const scope = { id, short: id, name: 'German Files' } as StorageScope;
    await window._ufMerge!(scope);
    if (!scope.files) throw new Error('Could not load your files. Please retry.');
    const docs = await listCourseDocuments(id, { force: options.force ?? true });
    const files = [...scope.files, ...((scope.userFolders || []) as Array<{ name: string; files?: StorageFile[] }>).flatMap((folder) =>
      (folder.files || []).map((file) => ({ ...file, _folder: folder.name })))];
    return files.map((file) => entry(uid, id, file, docs));
  }));
  if (uid !== userId()) throw new Error('Your account changed. Please reload your files.');
  const seen = new Set<string>();
  return groups.flat().filter((file) => {
    if (seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
}

export async function getLearnerFile(id: string): Promise<LearnerFile> {
  const file = (await listLearnerFiles()).find((item) => item.id === id);
  if (!file) throw new Error('This file is no longer in your learner library.');
  return file;
}

export async function readLearnerFile(file: LearnerFile): Promise<Uint8Array> {
  const scope = storageScope(file);
  if (!window._ufFetchBytes) throw new Error('File storage is still loading.');
  const bytes = await window._ufFetchBytes(userId(), scope, file._storageName, file._folder);
  assertOwner(file);
  return bytes;
}

export async function refreshLearnerFile(file: LearnerFile): Promise<LearnerFile> {
  storageScope(file);
  const docs = await listCourseDocuments(file.learnerFileScope, { force: true });
  assertOwner(file);
  return entry(file._uid, file.learnerFileScope, file, docs);
}

export async function indexLearnerFile(file: LearnerFile, forceReindex = false): Promise<LearnerFile> {
  storageScope(file);
  if (!file.name.toLowerCase().endsWith('.pdf')) throw new Error('AI indexing is available for PDF files only.');
  const response = await authenticatedFetch('/api/documents/index-existing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId: file.learnerFileScope, storageName: file._storageName,
      fileName: file.documentName, folder: file._folder, sourceType: 'unknown', forceReindex }),
  }, { safeToRetry: true });
  const data = await response.json() as { documentId?: string; processingStatus?: string; indexingStarted?: boolean; error?: string };
  assertOwner(file);
  clearCourseDocumentCache(file.learnerFileScope);
  if (!response.ok || data.indexingStarted === false) throw new Error(data.error || 'Indexing failed');
  return { ...file, id: data.documentId || file.id, documentId: data.documentId || file.documentId,
    _document: { id: data.documentId || file.documentId || '', file_name: file.name,
      processing_status: data.processingStatus || 'uploaded' } };
}

/** Uses the existing validated upload pipeline. Indexing is a separate, retryable step. */
export async function uploadLearnerFile(file: File, onProgress?: (percent: number) => void): Promise<LearnerFile> {
  const uid = userId();
  const storage = window as StorageWindow;
  if (!window._ufUpload || !storage._ssValidateUploadFile || !storage._ufSanitizeName) {
    throw new Error('File storage is still loading. Please retry.');
  }
  storage._ssValidateUploadFile(file, { maxBytes: MAX_UPLOAD_BYTES });
  await window._ufUpload(uid, getLearnerFileStorageScope(), file, onProgress, null);
  if (uid !== userId()) throw new Error('Your account changed. Please reload your files.');
  clearCourseDocumentCache(CANONICAL_SCOPE);
  return entry(uid, CANONICAL_SCOPE, { name: file.name, _storageName: storage._ufSanitizeName(file.name) }, []);
}

export async function deleteLearnerFile(file: LearnerFile): Promise<void> {
  storageScope(file);
  if (!window.SUPA_URL) throw new Error('File storage is still loading.');
  if (file.documentId) {
    const response = await authenticatedFetch('/api/documents/delete', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: file.documentId }),
    }, { safeToRetry: true });
    if (!response.ok && response.status !== 404) throw new Error('Could not delete the indexed document.');
  }
  assertOwner(file);
  const path = `${userId()}/${file.learnerFileScope}/${file._folder ? file._folder + '/' : ''}${file._storageName}`;
  const response = await authenticatedSupabaseFetch(window.SUPA_URL + '/storage/v1/object/course-uploads', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  }, { safeToRetry: true });
  if (!response.ok) throw new Error('Could not delete the stored file. Please retry.');
  clearCourseDocumentCache(file.learnerFileScope);
}

export async function openLearnerFile(file: LearnerFile): Promise<void> {
  assertOwner(file);
  const tab = window.open('about:blank', '_blank');
  if (!tab) throw new Error('Allow a new tab to open this file.');
  tab.opener = null;
  try {
    const bytes = await readLearnerFile(file);
    assertOwner(file);
    const ext = file.name.split('.').pop()?.toLowerCase();
    const type = ext === 'pdf' ? 'application/pdf' : ext === 'txt' ? 'text/plain' :
      ext === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(ext || '') ? 'image/jpeg' : 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
    tab.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    tab.close();
    throw error;
  }
}
