export interface PersistablePdfFile {
  name: string;
  _uploaded?: boolean;
  _storageName?: string;
  _folder?: string | null;
  _uid?: string;
}

/**
 * Return the small, JSON-safe identity needed to reopen a PDF tab.
 *
 * Live file objects often contain `_course`, which points back to the course
 * and can make JSON.stringify throw on a circular reference. Never persist the
 * live object wholesale.
 */
export function persistablePdfFile(file: PersistablePdfFile): PersistablePdfFile {
  const safe: PersistablePdfFile = { name: String(file.name || '') };
  if (file._uploaded === true) safe._uploaded = true;
  if (typeof file._storageName === 'string' && file._storageName) {
    safe._storageName = file._storageName;
  }
  if (typeof file._folder === 'string' && file._folder) safe._folder = file._folder;
  else if (file._folder === null) safe._folder = null;
  if (typeof file._uid === 'string' && file._uid) safe._uid = file._uid;
  return safe;
}

