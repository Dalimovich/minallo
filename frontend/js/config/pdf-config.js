export const PDF_DATA = {
    'Aufgabe_1_3.pdf': 'assets/Aufgabe_1_3.pdf',
};
export function configurePdfJs() {
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
}
//# sourceMappingURL=pdf-config.js.map