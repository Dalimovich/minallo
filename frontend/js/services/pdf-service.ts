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

export async function downloadFile(fname: string): Promise<void> {
  const PDF_DATA = window.PDF_DATA || {};
  const pdfPath = PDF_DATA[fname];
  if (!pdfPath) {
    alert(window._t ? window._t('not_in_demo') : 'Not available in demo');
    return;
  }
  const r = await fetch(pdfPath);
  if (!r.ok) {
    alert(window._t ? window._t('download_failed') : 'Download failed');
    return;
  }
  const buf = await r.arrayBuffer();
  const blob = new Blob([buf], { type: 'application/pdf' });
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
