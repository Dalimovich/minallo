import {
  aiMakePdfBlob,
  aiDownloadPdf,
  ufDestPicker,
  glMoveDestPicker,
  aiExportToCourse,
  aiShowExportModal,
  aiResponseActions,
} from './ai-export.js';

export function initAiExportBridge(): Record<string, unknown> {
  window._aiMakePdfBlob = aiMakePdfBlob;
  window._aiDownloadPdf = aiDownloadPdf;
  window._ufDestPicker = ufDestPicker;
  window._glMoveDestPicker = glMoveDestPicker;
  window._aiExportToCourse = aiExportToCourse;
  window._aiShowExportModal = aiShowExportModal;
  window._aiResponseActions = aiResponseActions;

  document.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement | null;
    const modal = document.getElementById('aiExportModal');
    if (!target || !modal) return;
    if (target.id === 'aiExportClose' || target === modal) {
      modal.style.display = 'none';
    }
  });

  return {
    aiMakePdfBlob,
    aiDownloadPdf,
    ufDestPicker,
    glMoveDestPicker,
    aiExportToCourse,
    aiShowExportModal,
    aiResponseActions,
  };
}
