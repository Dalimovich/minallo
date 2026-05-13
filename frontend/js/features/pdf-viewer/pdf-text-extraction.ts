// Extract plain text from a loaded pdf.js document.

interface PdfTextItem {
  str: string;
}

interface PdfTextContent {
  items: PdfTextItem[];
}

interface PdfPage {
  getTextContent: () => Promise<PdfTextContent>;
}

interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}

export async function extractPdfText(pdfDoc: PdfDocLike | null, maxPages?: number): Promise<string> {
  if (!pdfDoc) return '';
  const limit = Math.min(pdfDoc.numPages, maxPages || pdfDoc.numPages);
  const pageTexts: string[] = [];
  for (let i = 1; i <= limit; i++) {
    try {
      const page = await pdfDoc.getPage(i);
      const tc = await page.getTextContent();
      pageTexts.push(tc.items.map((it) => it.str).join(' '));
    } catch {
      /* skip unreadable page */
    }
  }
  return pageTexts.join('\n');
}

export async function extractMultiplePdfs(fnames: string[], maxPages?: number): Promise<string[]> {
  const pages = maxPages || 20;
  const PDF_DATA = window.PDF_DATA || {};

  return Promise.all(
    fnames.map((fname) => {
      return new Promise<string>((resolve) => {
        const pdfPath = PDF_DATA[fname];
        if (!pdfPath) {
          resolve('[' + fname + ': not available in demo]');
          return;
        }
        if (!window._fetchPdfBytes) {
          resolve('[' + fname + ': pdf loader unavailable]');
          return;
        }
        window._fetchPdfBytes(
          pdfPath,
          (bytes: Uint8Array) => {
            window
              ._ssEnsurePdfJs?.()
              .then(() => {
                return window.pdfjsLib!
                  .getDocument({ data: bytes })
                  .promise.then((pdf) => extractPdfText(pdf as PdfDocLike, pages))
                  .then((text) => {
                    resolve('=== ' + fname + ' ===\n' + text);
                  });
              })
              .catch(() => {
                resolve('[' + fname + ': could not load PDF.js]');
              });
          },
          () => {
            resolve('[' + fname + ': error loading]');
          }
        );
      });
    })
  );
}
