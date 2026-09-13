// Role-aware chatbot shell (Phase 2 of the German Learner UI migration).
//
// The modern chatbot shell (#ncbRoot) is student-specific static markup —
// "AI Chats", Course-safe mode, the Courses/Saved study panel — and never
// checked window._userType. Meanwhile _enterApp() (supabase.js) mounts this
// shell immediately and only calls loadUserData() afterwards, so the real
// user_type is not known yet at mount time. That's the actual production bug:
// a learner account briefly (or, without this fix, permanently) sees the full
// student shell with their old university courses.
//
// Fix: mark every student-only / learner-only element in chatbot.html with
// .ncb-student-only / .ncb-learner-only, and toggle them here based on
// window._userType — once at mount, and again every time 'ss-profile-updated'
// fires (applyProfile() in user-data.ts dispatches this once the real
// profile row, and therefore the real user_type, is known). No page reload
// required, no forked shell markup.
//
// Phase 3 adds a second, independent axis for learners: which workspace view
// is showing inside the SAME #ncbRoot — 'chat' (the normal AI Chats view) or
// 'writing-coach' (see writing-coach.ts). Elements are marked
// .ncb-chat-view-only / .ncb-writing-coach-view-only and folded into the same
// single visibility pass as the role markers so the two axes can never fight
// over one element's `hidden` property (see applyChatbotExperienceMode()).

export type LearnerWorkspaceView = 'chat' | 'writing-coach';

let _workspaceView: LearnerWorkspaceView = 'chat';

const NAV_TARGET_IDS: Record<string, string> = {
  'learner-home': 'psbLearnerHome',
  german: 'psbGerman',
  'writing-coach': 'psbWritingCoach',
};

function currentUserType(): string {
  return (window as unknown as { _userType?: string })._userType || 'enrolled';
}

function currentGermanLevel(): string {
  return (window as unknown as { _germanLevel?: string })._germanLevel || '';
}

function translate(key: string, fallback: string): string {
  const t = (window as unknown as { _t?: (k: string) => string })._t;
  const result = typeof t === 'function' ? t(key) : '';
  return result || fallback;
}

export function getLearnerWorkspaceView(): LearnerWorkspaceView {
  return _workspaceView;
}

/** Switches the in-shell workspace view for learners. Pure DOM-state toggle —
 * callers that need Writing Coach's module loaded/initialized first should
 * await ensureWritingCoach() (main.ts) before calling this with
 * 'writing-coach'; see the [data-workspace-view] handler below. */
export function setLearnerWorkspaceView(view: LearnerWorkspaceView): void {
  _workspaceView = view;
  applyChatbotExperienceMode();
}

/** Re-derives the chatbot shell's role mode AND workspace view from
 * window._userType / the stored view state. Safe to call repeatedly/
 * idempotently — it only forces a library-tab switch when the currently
 * active tab is wrong for the role, so it never resets a tab the user is
 * legitimately looking at. Both axes are resolved in one pass so an element
 * marked with both a role class and a view class (the Writing Coach panel is
 * both .ncb-learner-only and .ncb-writing-coach-view-only) gets a single,
 * consistent `hidden` value instead of two independent toggles racing. */
export function applyChatbotExperienceMode(): void {
  const root = document.getElementById('ncbRoot');
  if (!root) return;

  const isLearner = currentUserType() === 'learner';
  // Workspace-view mode only ever applies to learners; a student (or a
  // learner who hasn't opened Writing Coach) is always effectively 'chat'.
  const inWritingCoachView = isLearner && _workspaceView === 'writing-coach';
  root.classList.toggle('ncb-learner-mode', isLearner);
  root.classList.toggle('ncb-view-writing-coach', inWritingCoachView);

  // #ncbImportModal is a sibling of #ncbRoot (both injected by chatbot.js
  // into #psec-aipage), not nested inside it, so this must be document-scoped
  // — a root-scoped query silently misses it and anything else outside root.
  document.querySelectorAll<HTMLElement>('.ncb-student-only').forEach((el) => {
    el.hidden = isLearner;
  });
  document.querySelectorAll<HTMLElement>('.ncb-learner-only').forEach((el) => {
    el.hidden = !isLearner;
  });
  document.querySelectorAll<HTMLElement>('.ncb-chat-view-only').forEach((el) => {
    el.hidden = inWritingCoachView;
  });
  document.querySelectorAll<HTMLElement>('.ncb-writing-coach-view-only').forEach((el) => {
    el.hidden = !inWritingCoachView;
  });

  const level = currentGermanLevel() || '–';
  const levelBadge = document.getElementById('ncbGermanLevelBadge');
  const levelValue = document.getElementById('ncbGermanLevelValue');
  if (levelBadge) levelBadge.textContent = level;
  if (levelValue) levelValue.textContent = level;

  // The composer textarea is a single shared element (not a duplicated
  // student/learner pair like the other copy), so its placeholder/aria-label
  // are swapped directly rather than via .ncb-student-only/.ncb-learner-only.
  // It lives inside .ncb-center, which is itself hidden in writing-coach view,
  // so this is a no-op (harmless) while Writing Coach is showing.
  const textarea = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
  if (textarea) {
    const phKey = isLearner ? textarea.dataset.i18nPhLearner : textarea.dataset.i18nPh;
    const ariaKey = isLearner ? textarea.dataset.i18nAriaLearner : textarea.dataset.i18nAria;
    if (phKey) textarea.placeholder = translate(phKey, textarea.placeholder);
    if (ariaKey) textarea.setAttribute('aria-label', translate(ariaKey, textarea.getAttribute('aria-label') || ''));
  }

  const coursesTab = root.querySelector<HTMLButtonElement>('[data-library-tab="courses"]');
  const germanTab = root.querySelector<HTMLButtonElement>('[data-library-tab="german"]');
  const activeTab = root.querySelector<HTMLButtonElement>('.ncb-library-tab--active');
  if (isLearner && germanTab && activeTab === coursesTab) {
    germanTab.click();
  } else if (!isLearner && coursesTab && activeTab === germanTab) {
    coursesTab.click();
  }
}

/** Binds the shell's role-mode behavior once per mount: the [data-nav-target]
 * click delegation (routes into the existing portal sidebar handlers instead
 * of duplicating their logic — see router.js's psbGerman/psbLearnerHome
 * handlers), the [data-workspace-view] delegation (switches the in-shell
 * 'chat'/'writing-coach' view without leaving #ncbRoot), and the
 * ss-profile-updated listener that re-applies role mode once the real
 * profile arrives. */
export function initChatbotExperienceMode(root: HTMLElement): void {
  if (root.dataset.ncbExperienceBound === '1') return;
  root.dataset.ncbExperienceBound = '1';

  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;

    const viewTarget = target.closest<HTMLElement>('[data-workspace-view]');
    if (viewTarget) {
      ev.preventDefault();
      const view = viewTarget.dataset.workspaceView === 'writing-coach' ? 'writing-coach' : 'chat';
      if (view === 'writing-coach') {
        // Writing Coach is still a lazily-loaded module (main.ts's
        // ensureWritingCoach()) — await the same load promise the router
        // path uses so an early click loads-then-opens instead of the view
        // switching to an empty panel. window._wcOpen() (writing-coach.ts)
        // both switches the view and does its own render/focus setup.
        const ensure = (window as unknown as { _ensureWritingCoach?: () => Promise<void> })._ensureWritingCoach;
        const open = () => (window as unknown as { _wcOpen?: () => void })._wcOpen?.();
        if (typeof ensure === 'function') ensure().then(open).catch(() => {});
        else open();
      } else {
        setLearnerWorkspaceView('chat');
      }
      return;
    }

    const navTarget = target.closest<HTMLElement>('[data-nav-target]');
    if (!navTarget) return;
    const dest = navTarget.dataset.navTarget || '';
    const navId = NAV_TARGET_IDS[dest];
    if (!navId) return;
    ev.preventDefault();
    // The German panel links (Vocabulary/Grammar/Reading) all navigate to the
    // 'german' section, but each one must deep-link into its own skill inside
    // the existing Practice view rather than dumping the user on its home
    // screen — see router.js's psbGerman handler, which consumes this via
    // window._glSetPendingSkill before opening the section.
    const skill = navTarget.dataset.glSkill || '';
    const setPendingSkill = (window as unknown as { _glSetPendingSkill?: (s: string) => void })
      ._glSetPendingSkill;
    if (skill && typeof setPendingSkill === 'function') setPendingSkill(skill);
    document.getElementById(navId)?.click();
  });

  window.addEventListener('ss-profile-updated', applyChatbotExperienceMode);

  applyChatbotExperienceMode();
}
