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
    } & Record<string, unknown>;
    pdfDoc?: { numPages: number } | null;
    pdfPage?: number;
    _pdfVisiblePage?: () => number | null;
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
