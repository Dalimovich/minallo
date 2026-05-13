export function initPdfWorker() {
    if (!window.pdfjsLib)
        return;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
//# sourceMappingURL=pdf-worker.js.map