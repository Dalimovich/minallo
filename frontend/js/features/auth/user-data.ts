import { checkAdminStatus } from '../../services/admin-service.js';

interface ProfileRow {
  full_name?: string;
  email?: string;
  university?: string;
  programme?: string;
  vertiefung?: string;
  matrikel?: string;
  chat_username?: string;
  courses?: unknown;
  user_type?: string;
  german_test?: string;
  german_level?: string;
  [k: string]: unknown;
}

interface SettingsRow {
  [k: string]: unknown;
}

interface SubscriptionRow {
  status?: string;
  expires_at?: string;
  [k: string]: unknown;
}

let _presenceTimer: ReturnType<typeof setInterval> | null = null;

export function startPresenceHeartbeat(uid: string): void {
  if (_presenceTimer) clearInterval(_presenceTimer);
  function _beat(): void {
    const token = window._sbToken;
    if (!uid || !token) return;
    const SUPA_URL = window.SUPA_URL || '';
    fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { ...(window._sbHeaders ? window._sbHeaders() : {}), Prefer: 'return=minimal' },
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    }).catch(() => {});
  }
  _beat();
  _presenceTimer = setInterval(_beat, 60000);
}

export async function loadUserData(uid: string): Promise<void> {
  try {
    try {
      const cached = localStorage.getItem('profile_cache_' + uid);
      if (cached) {
        const cp = JSON.parse(cached) as ProfileRow;
        if (cp && cp.full_name && window.applyProfile) window.applyProfile(cp);
        if (cp && cp.courses && window._loadUserCourses) window._loadUserCourses(cp.courses);
      }
    } catch {
      /* malformed cache — ignore */
    }

    const sb = window._sb;
    if (!sb) return;
    const profile = (await sb.from('profiles').select('*').eq('id', uid).single()) as
      | ProfileRow
      | null;
    if (profile && profile.full_name) {
      try {
        localStorage.setItem('profile_cache_' + uid, JSON.stringify(profile));
      } catch {
        /* quota */
      }
      if (window.applyProfile) window.applyProfile(profile);
    }
    if (profile && profile.courses) {
      if (window._loadUserCourses) window._loadUserCourses(profile.courses);
    } else if (window.restoreState) {
      window.restoreState();
    }

    const currentUser = window._currentUser;
    if (currentUser && currentUser.email) {
      fetch((window.SUPA_URL || '') + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
        method: 'PATCH',
        headers: { ...(window._sbHeaders ? window._sbHeaders() : {}), Prefer: 'return=minimal' },
        body: JSON.stringify({ auth_email: currentUser.email }),
      }).catch(() => {});
    }

    startPresenceHeartbeat(uid);

    const settings = (await sb.from('settings').select('*').eq('id', uid).single()) as
      | SettingsRow
      | null;
    if (settings && window.applySettings) window.applySettings(settings);

    let sub = (await sb.from('subscriptions').select('*').eq('user_id', uid).single()) as
      | SubscriptionRow
      | null;
    if (sub && sub.expires_at && Date.parse(sub.expires_at) <= Date.now()) {
      sub = { ...sub, status: 'expired' };
    }
    if (window.applySubscription) window.applySubscription(sub || {});

    // Admin accounts bypass the subscription gate.
    checkAdminStatus()
      .then((data: unknown) => {
        const isAdmin = !!(
          data &&
          typeof data === 'object' &&
          'isAdmin' in data &&
          (data as { isAdmin?: boolean }).isAdmin
        );
        window._userIsAdmin = isAdmin;
        if (isAdmin) {
          const btn = document.getElementById('psbAdmin');
          if (btn) btn.style.display = '';
        }
        if (!window._userIsPro && !isAdmin && window._showPaywall) {
          setTimeout(window._showPaywall, 800);
        }
      })
      .catch(() => {
        if (!window._userIsPro && window._showPaywall) setTimeout(window._showPaywall, 800);
      });

    const loadLectureNotes = window._lnLoadFromSupabase || window.lnLoadFromSupabase;
    if (loadLectureNotes) {
      await loadLectureNotes(uid);
    } else {
      console.warn('Lecture notes loader is not ready yet');
    }
    if (typeof window._dwLoadAndRender === 'function') window._dwLoadAndRender();
  } catch (e: unknown) {
    console.warn('loadUserData error:', e);
  }
}

export function applyProfile(p: ProfileRow | null | undefined): void {
  if (!p) return;
  const n = document.getElementById('profileName') as HTMLInputElement | null;
  const e = document.getElementById('profileEmail') as HTMLInputElement | null;
  const u = document.getElementById('profileUniversity') as HTMLInputElement | null;
  const pr = document.getElementById('profileProgramme') as HTMLInputElement | null;
  const pv = document.getElementById('profileVertiefung') as HTMLInputElement | null;
  const m = document.getElementById('profileMatrikel') as HTMLInputElement | null;
  const i = document.getElementById('profileInitial');
  if (n && p.full_name) n.value = p.full_name;
  if (e && p.email) e.value = p.email;
  if (u && p.university) u.value = p.university;
  if (pr && p.programme) pr.value = p.programme;
  if (pv && p.vertiefung) pv.value = p.vertiefung;
  if (m && p.matrikel) m.value = p.matrikel;
  if (i && p.full_name) i.textContent = p.full_name.charAt(0).toUpperCase();
  if (p.vertiefung) {
    window._userVertiefung = p.vertiefung;
    localStorage.setItem('ss_vertiefung', p.vertiefung);
  }
  if (p.programme) {
    const MAJOR_LIST = window.MAJOR_LIST || [];
    const rawMajor = p.programme.split(',')[0]?.trim() || '';
    const matchedMajor = MAJOR_LIST.find((m) => m.toLowerCase() === rawMajor.toLowerCase());
    if (matchedMajor) {
      window._userMajor = matchedMajor;
      localStorage.setItem('ss_major', matchedMajor);
    }
  }
  if (p.chat_username) window._chatUsername = p.chat_username;
  if (p.full_name && typeof window.updateAuthIndicator === 'function' && window._currentUser) {
    window.updateAuthIndicator(window._currentUser);
  }
  const dcAv = document.getElementById('dcUserAv');
  const dcNm = document.getElementById('dcUserName2');
  const displayName =
    p.full_name ||
    (window._currentUser && window._currentUser.email
      ? window._currentUser.email.split('@')[0]
      : 'You') || 'You';
  const initial = displayName.charAt(0).toUpperCase();
  if (dcAv) dcAv.textContent = initial;
  if (dcNm) dcNm.textContent = displayName;
  const uid = (window._currentUser && window._currentUser.id) || '';
  window._userType = p.user_type || localStorage.getItem('ss_user_type_' + uid) || 'enrolled';
  window._germanTest = p.german_test || localStorage.getItem('ss_german_test_' + uid) || '';
  window._germanLevel = p.german_level || localStorage.getItem('ss_german_level_' + uid) || '';
  if (uid) {
    localStorage.setItem('ss_user_type_' + uid, window._userType);
    localStorage.setItem('ss_german_test_' + uid, window._germanTest);
    localStorage.setItem('ss_german_level_' + uid, window._germanLevel);
  }
  applyUserTypeUI();
  window.dispatchEvent(new Event('ss-profile-updated'));
}

export function applyUserTypeUI(): void {
  const userType = window._userType || 'enrolled';
  const germanTest = window._germanTest || '';
  const germanLevel = window._germanLevel || '';
  const isLearner = userType === 'learner';

  const sub = document.getElementById('sbUserSub');
  if (sub) {
    sub.textContent = isLearner
      ? (germanTest || 'German Test') + (germanLevel ? ' · ' + germanLevel : '')
      : 'TU Braunschweig';
  }
  const coursesNav = document.getElementById('pcStudip');
  const germanNav = document.getElementById('psbGerman');
  if (coursesNav) coursesNav.style.display = isLearner ? 'none' : '';
  if (germanNav) germanNav.style.display = isLearner ? '' : 'none';

  const glSub = document.getElementById('glTestBadge');
  const glChip = document.getElementById('glLevelChip');
  if (glSub) glSub.textContent = (germanTest || 'German Test') + ' preparation';
  if (glChip) glChip.textContent = germanLevel || '–';

  document.querySelectorAll<HTMLElement>('.pf-enrolled-field').forEach((el) => {
    el.style.display = isLearner ? 'none' : '';
  });
  document.querySelectorAll<HTMLElement>('.pf-learner-field').forEach((el) => {
    el.style.display = isLearner ? '' : 'none';
  });
  const gt = document.getElementById('profileGermanTest') as HTMLInputElement | null;
  const gl = document.getElementById('profileGermanLevel') as HTMLInputElement | null;
  if (gt && germanTest) gt.value = germanTest;
  if (gl && germanLevel) gl.value = germanLevel;
}
