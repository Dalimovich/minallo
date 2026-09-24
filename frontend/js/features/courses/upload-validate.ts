// Backend documents-upload.ts rejects > 20 MB with HTTP 413. Cap at the same
// size on the client so users get a clear warning instead of a failed upload.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export interface RejectedFile {
  file: File;
  reason: string;
}

export interface FilterResult {
  valid: File[];
  rejected: RejectedFile[];
}

export function filterOversizedFiles(files: File[]): FilterResult {
  const valid: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) {
      rejected.push({
        file: f,
        reason: formatBytes(f.size) + ' — max ' + formatBytes(MAX_UPLOAD_BYTES),
      });
    } else {
      valid.push(f);
    }
  }
  return { valid, rejected };
}

// Show a toast for skipped files and, when all files were rejected, also a
// blocking alert so the user can't miss it.
export function warnRejected(rejected: RejectedFile[], allRejected: boolean): void {
  if (!rejected.length) return;
  const names = rejected.map((r) => r.file.name + ' (' + r.reason + ')');
  const title = rejected.length === 1 ? 'File too large' : 'Files too large';
  const sub = names.join(', ');
  if (typeof window.showToast === 'function') window.showToast(title, sub);
  if (allRejected) {
    const max = formatBytes(MAX_UPLOAD_BYTES);
    alert(
      'Upload blocked.\n\n' +
      'Max file size is ' + max + '. The following file' +
      (rejected.length !== 1 ? 's were' : ' was') + ' skipped:\n\n' +
      names.join('\n')
    );
  }
}
