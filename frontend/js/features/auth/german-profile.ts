// Single frontend definition of the German learner profile.
//
// Source of truth is the DB: profiles.german_test + profiles.german_level
// (+ authoritative german_exam_profile_id). The runtime globals (window._germanTest
// etc.) are only ever written by applyProfile() from an authoritative row;
// every German feature reads them through getGermanLearnerProfile() below and
// never invents a default level.

// Controlled test families and the exact target levels each one allows.
// Shared by onboarding, the Profile page, and every practice level selector
// so the lists cannot drift apart.
export const GERMAN_TEST_LEVELS: Record<string, string[]> = {
  TestDaF: ['TDN 3', 'TDN 4', 'TDN 5'],
  DSH: ['DSH-1', 'DSH-2', 'DSH-3'],
  Goethe: ['B1', 'B2', 'C1', 'C2'],
  telc: ['B2', 'C1', 'C1 Hochschule', 'C2'],
  OESD: ['B2', 'C1', 'C2'],
  DSD: ['DSD I (B1/B2)', 'DSD II (C1)'],
};

export const GERMAN_TEST_LABELS: Record<string, string> = {
  TestDaF: 'TestDaF',
  DSH: 'DSH',
  Goethe: 'Goethe',
  telc: 'telc',
  OESD: 'ÖSD',
  DSD: 'DSD',
};

// Plain CEFR steps offered as an explicit, session-only practice override.
const CEFR_OVERRIDE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// German Exam Engine profile registry, client-side mirror of the backend's
// resolve_profile_id() in backend/python-ai/app/services/german_exam_profiles.py.
// Table-driven so adding a profile is one entry here + one in the backend
// registry, not another branch.
const GERMAN_EXAM_PROFILES_CLIENT: Array<{ profileId: string; family: string; legacyLevelValues: string[] }> = [
  { profileId: 'telc_c1_hochschule', family: 'telc', legacyLevelValues: ['C1 Hochschule'] },
  { profileId: 'goethe_c1', family: 'Goethe', legacyLevelValues: ['C1'] },
  { profileId: 'testdaf_digital', family: 'TestDaF', legacyLevelValues: [] },
];

export function resolveGermanExamProfileIdClient(
  test: string | undefined,
  level: string | undefined,
  savedProfileId?: string | null
): string | null {
  if (savedProfileId?.trim()) return savedProfileId.trim();
  const familyNorm = (test || '').trim().toLowerCase();
  const levelNorm = (level || '').trim();
  if (!familyNorm || !levelNorm) return null;
  const matches = GERMAN_EXAM_PROFILES_CLIENT.filter(
    (p) => p.family.toLowerCase() === familyNorm && p.legacyLevelValues.indexOf(levelNorm) !== -1
  );
  return matches.length === 1 ? matches[0]?.profileId ?? null : null;
}

export function isValidGermanTestLevel(test: string, level: string): boolean {
  const levels = GERMAN_TEST_LEVELS[test];
  return !!levels && levels.indexOf(level) !== -1;
}

export interface GermanLearnerProfile {
  // 'ready' only once the authoritative profiles row is applied AND the
  // account is a learner with a chosen test + level. A failed/in-flight
  // profile read is 'loading'/'error' — never a guessed level.
  state: 'loading' | 'ready' | 'error';
  userType: string;
  testFamily: string;
  targetLevel: string;
  // null is NOT an error: it means no exam-specific blueprint is registered
  // for this (test, level) pair. General practice still works.
  examProfileId: string | null;
}

export function getGermanLearnerProfile(): GermanLearnerProfile {
  const res = window._profileResolutionState;
  const userType = window._userType || '';
  const testFamily = window._germanTest || '';
  const targetLevel = window._germanLevel || '';
  if (res === 'error') {
    return { state: 'error', userType, testFamily: '', targetLevel: '', examProfileId: null };
  }
  if (res !== 'ready' || userType !== 'learner') {
    // 'loading', or a non-learner account (which has no German target).
    return {
      state: res === 'ready' ? 'ready' : 'loading',
      userType,
      testFamily: res === 'ready' ? testFamily : '',
      targetLevel: res === 'ready' ? targetLevel : '',
      examProfileId: null,
    };
  }
  // Two layers: prefer the persisted/applied id, otherwise derive it from the
  // authoritative (test, level) pair so a missing id never shows a false
  // "unsupported profile".
  const examProfileId =
    window._germanExamProfileId || resolveGermanExamProfileIdClient(testFamily, targetLevel);
  return { state: 'ready', userType, testFamily, targetLevel, examProfileId };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// <option> list for a practice-level <select>. The learner's own target level
// is always first and pre-selected; the remaining entries are an explicit,
// session-only override (changing the select never writes the profile).
export function germanLevelOptionsHtml(): string {
  const p = getGermanLearnerProfile();
  if (p.state !== 'ready' || !p.targetLevel) {
    return '<option value="" selected>…</option>';
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (l: string): void => {
    if (l && !seen.has(l)) {
      seen.add(l);
      ordered.push(l);
    }
  };
  add(p.targetLevel);
  (GERMAN_TEST_LEVELS[p.testFamily] || []).forEach(add);
  CEFR_OVERRIDE_LEVELS.forEach(add);
  return ordered
    .map((l) => '<option value="' + esc(l) + '"' + (l === p.targetLevel ? ' selected' : '') + '>' + esc(l) + '</option>')
    .join('');
}

// Fill a Target Level <select> for the chosen test family. A stored level
// that is not in the family's list (legacy row, or a family not chosen yet)
// is kept as an extra option so the field never silently shows something else.
export function populateGermanLevelSelect(
  levelSel: HTMLSelectElement | null,
  test: string,
  selectedLevel: string
): void {
  if (!levelSel) return;
  const levels = (GERMAN_TEST_LEVELS[test] || []).slice();
  if (selectedLevel && levels.indexOf(selectedLevel) === -1) levels.push(selectedLevel);
  const placeholder = levelSel.getAttribute('data-placeholder') || 'Select your level…';
  levelSel.innerHTML =
    '<option value="">' + esc(placeholder) + '</option>' +
    levels.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
  levelSel.value = selectedLevel && levels.indexOf(selectedLevel) !== -1 ? selectedLevel : '';
}
