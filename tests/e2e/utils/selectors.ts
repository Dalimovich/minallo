export const appSelectors = {
  shell: '#portal',
  hamburger: '[data-testid="portal-hamburger"], #portalHamburger',
  activeSidebarItem: '.sb-item.on, .sb-item.active, [aria-current="page"]',
  toast:
    '.toast, .toastify, .Toastify__toast, #toast, .ss-toast, .swal2-container, [role="status"], [aria-live="polite"]',
  modal:
    '[role="dialog"], .modal, .modal-backdrop, .ncb-modal-overlay:not([hidden]), #stOverlay[style*="display: block"]',
  panel:
    '.pdf-notes-panel[style*="display: flex"], .ncb-context, .st-popup, [data-testid$="-panel"]',
} as const;

export const sidebarSelectors = {
  home: '[data-testid="sidebar-home"], #psbDashboard',
  dashboard: '[data-testid="sidebar-home"], #psbDashboard',
  courses: '[data-testid="sidebar-courses"], #pcStudip',
  notes: '[data-testid="sidebar-notes"], #psbNotes',
  summaries: '[data-testid="sidebar-notes"], #psbNotes',
  editor: '[data-testid="sidebar-editor"], #psbEditor',
  pdfEditor: '[data-testid="sidebar-editor"], #psbEditor',
  chatbot: '[data-testid="sidebar-chatbot"], #psbAIPage',
  ai: '[data-testid="sidebar-chatbot"], #psbAIPage',
  chat: '[data-testid="sidebar-chat"], #psbChat',
  notifications: '[data-testid="sidebar-notifications"], #psbNotifications',
  games: '[data-testid="sidebar-games"], #psbGames',
  settings: '[data-testid="sidebar-settings"], #psbSettings',
  profile: '[data-testid="sidebar-profile"], #psbProfile',
  subscription: '[data-testid="sidebar-subscription"], #psbSubscription',
} as const;

export type MainSection = keyof typeof sidebarSelectors;

export const sectionSelectors: Record<MainSection, string> = {
  home: '#psec-dashboard',
  dashboard: '#psec-dashboard',
  courses: '#psec-studip',
  notes: '#psec-notes',
  summaries: '#psec-notes',
  editor: '#psec-editor',
  pdfEditor: '#psec-editor',
  chatbot: '#psec-aipage, [data-testid="chatbot-root"], #ncbRoot',
  ai: '#psec-aipage, [data-testid="chatbot-root"], #ncbRoot',
  chat: '#psec-chat',
  notifications: '#psec-notifications',
  games: '#psec-games',
  settings: '#psec-settings',
  profile: '#psec-profile',
  subscription: '#psec-subscription',
};

export const chatbotSelectors = {
  root: '[data-testid="chatbot-root"], #ncbRoot',
  input: '[data-testid="chatbot-input"], .ncb-input-textarea',
  send: '[data-testid="chatbot-send"], .ncb-send-btn',
  upload: '[data-testid="chatbot-upload"], .ncb-upload-btn',
  fileInput: '[data-testid="chatbot-file-input"], .ncb-file-input',
  importCourse: '[data-testid="import-course"], .ncb-import-btn',
  importModal: '[data-testid="chatbot-import-modal"], #ncbImportModal',
  messages: '.ncb-msgs',
  userMessage: '.ncb-msg-row--user, .ncb-msg-user, [data-role="user-message"]',
  assistantMessage: '.ncb-msg-row--assistant, .ncb-msg-assistant, [data-role="assistant-message"]',
  loading: '.ncb-typing, .ncb-loading, [aria-busy="true"]',
  quickSummarize: '[data-testid="quick-summarize"], .ncb-action-card:has-text("Summarize lecture")',
  quickSolve: '[data-testid="quick-solve"], .ncb-action-card:has-text("Solve exercise")',
  quickExamAnswer:
    '[data-testid="quick-exam-answer"], .ncb-action-card:has-text("Exam answer")',
  quickFlashcards:
    '[data-testid="quick-flashcards"], .ncb-action-card:has-text("Create flashcards")',
} as const;

export const notesSelectors = {
  notesPage: '[data-testid="notes-page"], #psec-notes',
  notesPanel: '[data-testid="notes-panel"], #pdfNotesPanel',
  summaryPanel: '[data-testid="summary-panel"], .np-tab[data-tab="summary"]',
  savedTab: '[data-testid="notes-saved-tab"], .np-tab[data-tab="saved"]',
  deleteButton: '.np-saved-delete, [data-testid*="delete"]',
  generate: '#npGenerate',
} as const;

export const pdfEditorSelectors = {
  hubCard: '[data-testid="pdf-editor-open"], #edHubPdfEditor',
  view: '#editorPdfEditorView',
  choose: '[data-testid="pdf-editor-upload"], #edPdfChooseBtn',
  input: '[data-testid="pdf-editor-file-input"], #edPdfEditorInput',
  toolbar: '[data-testid="pdf-editor-toolbar"], #edPdfEditorMain .epdf-tool',
  main: '#edPdfEditorMain',
  textTool: '[data-testid="pdf-tool-text"], #edPdfTool_text',
  highlightTool: '[data-testid="pdf-tool-highlight"], #edPdfTool_highlight',
  penTool: '[data-testid="pdf-tool-pen"], #edPdfTool_pen',
  colorPicker: '[data-testid="pdf-editor-color"], #edAnnColor, #edTextColor',
  fontSize: '[data-testid="pdf-editor-font-size"], #edTextSize, select[id*="Size"]',
  saveExport:
    '#edSavePdf, #edExportPdf, button:has-text("Save"), button:has-text("Export"), button:has-text("Download")',
} as const;

export const clickableAuditSelector = [
  'button',
  'a[href]',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])',
  '.sb-item',
  '.ncb-action-card',
  '.ncb-tool-btn',
  '.epdf-tool',
  '.co-tool-btn',
  '.co-next-step',
  '.st-tech-card',
].join(', ');

export const destructivePattern =
  /delete|remove|trash|logout|log out|sign out|checkout|payment|stripe|paypal|cancel subscription|delete account|destroy|danger/i;
