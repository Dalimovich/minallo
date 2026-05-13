// Ambient declarations for the `window`-scoped globals the legacy bootstrap
// (auth-bootstrap.js, supabase.js, loader.js, app.js) still installs. Each
// migration commit will replace these as the corresponding module is
// rewritten and stops touching window. The file SHRINKS as the migration
// progresses — once everything is module-scoped these declarations go away.

declare global {
  interface Window {
    // ── Config (set by frontend/js/config.js) ───────────────────────────
    _GCID?: string;
    _SUPA?: string;
    _SAKEY?: string;
    AI_SERVICE_URL?: string;
    BACKEND_URL?: string;
    MinalloConfig?: Record<string, unknown>;
    PDF_DATA?: Record<string, string>;

    // ── Session ─────────────────────────────────────────────────────────
    _currentUser?: { id?: string; sub?: string; email?: string };
    _sbToken?: string;
    _lang?: string;
    _uid?: string;

    // ── Course / file state (legacy window globals) ─────────────────────
    SEMS?: Record<string, { color: string; courses: LegacyCourse[] }>;
    _SEMS?: Record<string, { color: string; courses: LegacyCourse[] }>;
    activeSemesterId?: string;
    _activeSemesterId?: string;
    activeCourseId?: string | null;
    activeFileName?: string | null;
    activeCourseRef?: LegacyCourse | null;
    activeCourseSection?: string;

    // ── App-shell helpers ──────────────────────────────────────────────
    openFile?: (file: unknown, course: LegacyCourse) => void;
    openCourse?: (course: LegacyCourse) => void;
    showCourseSection?: (course: LegacyCourse, section: string) => void;
    renderCourses?: () => void;
    sdRenderCourses?: () => void;
    showPortalSection?: (section: string) => void;
    forceCloseAI?: () => void;
    _aiBubbleClose?: () => void;
    _aiBubbleSendMessage?: (text: string) => void;
    _statsStopFile?: () => void;
    _stRunning?: boolean;
    _glOpenSkill?: (skill: string) => void;
    _glOpenFile?: (uid: string, fileName: string) => void;
    _saveUserCourses?: () => void;
    _setAiChipsVisible?: (visible: boolean) => void;
    _generateStudyTool?: (...args: unknown[]) => unknown;
    mountQuiz?: (el: HTMLElement, course: LegacyCourse, opts: { generate: unknown }) => void;
    mountFlashcards?: (el: HTMLElement, course: LegacyCourse, opts: { generate: unknown }) => void;

    // ── i18n + toasts ──────────────────────────────────────────────────
    _t?: (key: string) => string;
    showToast?: (title: string, sub?: string) => void;

    // ── Auth bridge ────────────────────────────────────────────────────
    _onLoginSuccess?: () => void;

    // ── Restore plumbing (used by state-persistence) ───────────────────
    _ssRestoring?: boolean;
    _pendingPortalRestore?: { section: string } | null;
    _pendingRestoreCourse?: { course: LegacyCourse; sec: string; file?: string } | null;
    _courseOpenSeq?: number;
    _ufMerge?: (course: LegacyCourse) => Promise<void>;
    _prewarmCourses?: (opts?: { force?: boolean }) => void;
    _notesPanel?: { close?: () => void };

    // ── Misc DB shim exposed by db-helpers ─────────────────────────────
    _ssDb?: {
      supaHeaders: () => Record<string, string>;
      supaUrl: () => string;
      userId: () => string | null;
    };

    // ── pdf.js + page state ────────────────────────────────────────────
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (src: unknown) => { promise: Promise<unknown> };
    } & Record<string, unknown>;
    pdfDoc?: { numPages: number } | null;
    pdfPage?: number;
    _pdfVisiblePage?: () => number | null;
    _fetchPdfBytes?: (path: string, onOk: (bytes: Uint8Array) => void, onErr?: () => void) => void;
    _ssEnsurePdfJs?: () => Promise<unknown>;

    // ── AI typing config (set by ai-typing-config) ─────────────────────
    AI_TYPING?: {
      streamTokenInterval: number;
      fallbackWordsPerFrame: number;
      fallbackFrameInterval: number;
      chatbotCharInterval: number;
      chatbotWordsPerFrame: number;
      chatbotFrameInterval: number;
      mathRenderTriggers: string[];
    };

    // ── AI chips ───────────────────────────────────────────────────────
    chipPrompt?: (type: string, level?: string) => unknown;
    closeAllOpts?: () => void;

    // ── AI confetti ────────────────────────────────────────────────────
    spawnConfetti?: () => void;

    // ── AI export ──────────────────────────────────────────────────────
    _aiMakePdfBlob?: (...args: unknown[]) => unknown;
    _aiDownloadPdf?: (...args: unknown[]) => unknown;
    _ufDestPicker?: (...args: unknown[]) => unknown;
    _glMoveDestPicker?: (...args: unknown[]) => unknown;
    _aiExportToCourse?: (...args: unknown[]) => unknown;
    _aiShowExportModal?: (...args: unknown[]) => unknown;
    _aiResponseActions?: (...args: unknown[]) => unknown;

    // ── Auth bridge ────────────────────────────────────────────────────
    _setAuthMode?: (mode: 'signin' | 'signup') => void;
    _authMode?: string;
    updateAuthIndicator?: (user: unknown) => void;
    loadUserData?: (uid: string) => unknown;
    applyProfile?: (profile: unknown) => unknown;
    _applyUserTypeUI?: () => void;
    _adminShowIfEligible?: (user: { id?: string } | null) => void;
    _showOnboarding?: (...args: unknown[]) => void;
    landShowAuth?: (mode?: 'signin' | 'signup') => void;

    // ── Theme / settings ───────────────────────────────────────────────
    nightOn?: boolean;
    _applyTheme?: (toNight: boolean) => void;
    applyLanguage?: (lang: string) => void;
    applySettings?: (settings?: Record<string, unknown> | null) => void;
    _autoOpenEnabled?: boolean;
    _saveChatEnabled?: boolean;
    _ytApplyFromDB?: (playlists: unknown) => void;

    // ── Subscription gate ──────────────────────────────────────────────
    _requirePro?: (message?: string) => boolean;

    // ── Multi-summary modal state ──────────────────────────────────────
    msmCurrentText?: string;
    msmCurrentTitle?: string;
    lnRenderMarkdown?: (markdown: string) => string;

    // ── Portal / navigation extras ─────────────────────────────────────
    showPortal?: () => void;
    setNavActive?: (id: string) => void;

    // ── ai-ask bridge ──────────────────────────────────────────────────
    askAI?: (q: string, skipUserBubble?: boolean) => unknown;
    _legacyAskAI?: (q: string) => unknown;
    addTyping?: () => unknown;
    _pdfToImages?: (...args: unknown[]) => unknown;
    stopGeneration?: () => void;
    restoreCourseHistory?: (...args: unknown[]) => unknown;
    clearCourseHistory?: (...args: unknown[]) => unknown;
    _abortCurrentStream?: () => void;
    _activeStreamRender?: (() => void) | null;
    _attachedImages?: unknown[];
  }
}

/** Minimal shape of the legacy `course` object passed around the app. */
export interface LegacyCourse {
  id: string;
  name: string;
  short?: string;
  meta?: string;
  files?: Array<Record<string, unknown>>;
  userFolders?: Array<{ name: string; files: Array<Record<string, unknown>> }>;
  _filesLoading?: boolean;
  [k: string]: unknown;
}

export {};
