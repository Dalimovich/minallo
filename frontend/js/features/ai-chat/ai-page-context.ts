// Builds the `pageContext` object sent with every /ask-stream request: where
// the student currently is in the Minallo UI (page, course, active course tab,
// open document). Only UI facts the server cannot know are sent — workspace
// DATA (file/quiz/deck counts) is fetched server-side from Supabase, scoped to
// the JWT user, so nothing here is trusted as data. The backend sanitises and
// length-caps every field again (workspace_context.sanitize_page_context).

export interface AiPageContext {
  page?: string;          // 'pdf-viewer' | 'course' | 'chatbot' | hash route
  courseName?: string;
  activeTab?: string;     // files|quiz|flashcards|examforge|cheatsheet|deeplearn
  documentTitle?: string;
}

const COURSE_TABS = new Set(['files', 'quiz', 'flashcards', 'examforge', 'cheatsheet', 'deeplearn']);

export function buildPageContext(): AiPageContext | null {
  const w = window as unknown as {
    activeCourseRef?: { name?: string } | null;
    activeCourseSection?: string | null;
    activeFileName?: string | null;
  };
  const ctx: AiPageContext = {};

  const courseName = (w.activeCourseRef?.name || '').trim();
  if (courseName) ctx.courseName = courseName.slice(0, 120);

  const tab = (w.activeCourseSection || '').trim().toLowerCase();
  if (tab && COURSE_TABS.has(tab)) ctx.activeTab = tab;

  const fileName = (w.activeFileName || '').trim();
  if (fileName) ctx.documentTitle = fileName.slice(0, 160);

  if (fileName) {
    ctx.page = 'pdf-viewer';
  } else if (courseName) {
    ctx.page = 'course';
  } else {
    // Fall back to the hash route (#portal=chatbot, #portal=admin, …).
    const m = /#portal=([a-z0-9_-]+)/i.exec(window.location.hash || '');
    if (m && m[1]) ctx.page = m[1].toLowerCase().slice(0, 40);
  }

  return Object.keys(ctx).length ? ctx : null;
}
