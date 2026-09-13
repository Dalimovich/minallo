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

/** Re-derives the chatbot shell's role mode from window._userType. Safe to
 * call repeatedly/idempotently — it only forces a library-tab switch when
 * the currently active tab is wrong for the role, so it never resets a tab
 * the user is legitimately looking at. */
export function applyChatbotExperienceMode(): void {
  const root = document.getElementById('ncbRoot');
  if (!root) return;

  const isLearner = currentUserType() === 'learner';
  root.classList.toggle('ncb-learner-mode', isLearner);
  root.querySelectorAll<HTMLElement>('.ncb-student-only').forEach((el) => {
    el.hidden = isLearner;
  });
  root.querySelectorAll<HTMLElement>('.ncb-learner-only').forEach((el) => {
    el.hidden = !isLearner;
  });

  const level = currentGermanLevel() || '–';
  const levelBadge = document.getElementById('ncbGermanLevelBadge');
  const levelValue = document.getElementById('ncbGermanLevelValue');
  if (levelBadge) levelBadge.textContent = level;
  if (levelValue) levelValue.textContent = level;

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
 * of duplicating their logic — see router.js's psbGerman/psbWritingCoach/
 * psbLearnerHome handlers) and the ss-profile-updated listener that re-applies
 * the mode once the real profile arrives. */
export function initChatbotExperienceMode(root: HTMLElement): void {
  if (root.dataset.ncbExperienceBound === '1') return;
  root.dataset.ncbExperienceBound = '1';

  root.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-nav-target]');
    if (!target) return;
    const dest = target.dataset.navTarget || '';
    const navId = NAV_TARGET_IDS[dest];
    if (!navId) return;
    ev.preventDefault();
    // The German panel links (Vocabulary/Grammar/Reading) all navigate to the
    // 'german' section, but each one must deep-link into its own skill inside
    // the existing Practice view rather than dumping the user on its home
    // screen — see router.js's psbGerman handler, which consumes this via
    // window._glSetPendingSkill before opening the section.
    const skill = target.dataset.glSkill || '';
    const setPendingSkill = (window as unknown as { _glSetPendingSkill?: (s: string) => void })
      ._glSetPendingSkill;
    if (skill && typeof setPendingSkill === 'function') setPendingSkill(skill);
    document.getElementById(navId)?.click();
  });

  window.addEventListener('ss-profile-updated', applyChatbotExperienceMode);

  applyChatbotExperienceMode();
}
