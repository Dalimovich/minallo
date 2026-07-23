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
  plan?: string;
  status?: string;
  expires_at?: string;
  stripe_subscription_id?: string | null;
  stripe_customer_id?: string | null;
  paypal_subscription_id?: string | null;
  [k: string]: unknown;
}

let _presenceTimer: ReturnType<typeof setInterval> | null = null;
let _presenceUid: string | null = null;
let _courseLoadTimer: ReturnType<typeof setTimeout> | null = null;

// loadUserData de-dup: _enterApp can fire many times in a short window (initial
// sign-in + session restore + token refresh + repeated SIGNED_IN events), and
// each full run sends two profiles PATCHes plus admin/notes/subscription
// fetches. Without a guard this snowballs into a request storm that exhausts
// the browser connection pool and starves real data fetches (e.g. flashcard
// decks). Skip a redundant run for the same uid within this window.
let _lastLoadUid: string | null = null;
let _lastLoadAt = 0;
const _LOAD_DEDUP_MS = 30000;

function stopPresenceHeartbeat(): void {
  if (_presenceTimer) clearInterval(_presenceTimer);
  _presenceTimer = null;
  _presenceUid = null;
}

function stopHeartbeatOnUnauthorized(response: Response): void {
  if (response.status === 401) stopPresenceHeartbeat();
}

function scheduleUserCoursesLoad(courses: unknown, delay = 1200): void {
  if (!courses || !window._loadUserCourses) return;
  if (_courseLoadTimer) clearTimeout(_courseLoadTimer);
  _courseLoadTimer = setTimeout(() => {
    _courseLoadTimer = null;
    if (window._loadUserCourses) window._loadUserCourses(courses);
  }, delay);
}

export function startPresenceHeartbeat(uid: string): void {
  // Already beating for this user — don't fire another immediate beat or stack
  // a second interval. This is the single biggest source of the profiles PATCH
  // storm when _enterApp re-runs.
  if (_presenceTimer && _presenceUid === uid) return;
  stopPresenceHeartbeat();
  _presenceUid = uid;
  function _beat(): void {
    const token = window._sbToken;
    if (!uid || !token) return;
    const SUPA_URL = window.SUPA_URL || '';
    fetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { ...(window._sbHeaders ? window._sbHeaders() : {}), Prefer: 'return=minimal' },
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    }).then(stopHeartbeatOnUnauthorized).catch(() => {});
  }
  _beat();
  _presenceTimer = setInterval(_beat, 60000);
}

export async function loadUserData(uid: string): Promise<void> {
  // De-dup redundant runs from rapid repeated _enterApp / SIGNED_IN events.
  // The first run applies profile/settings/subscription and starts the
  // heartbeat; re-running within the window only re-spams the network.
  const _now = Date.now();
  if (uid && uid === _lastLoadUid && _now - _lastLoadAt < _LOAD_DEDUP_MS) return;
  _lastLoadUid = uid;
  _lastLoadAt = _now;
  try {
    try {
      const cached = localStorage.getItem('profile_cache_' + uid);
      if (cached) {
        const cp = JSON.parse(cached) as ProfileRow;
        if (cp && cp.full_name && window.applyProfile) window.applyProfile(cp);
        if (cp && cp.courses) scheduleUserCoursesLoad(cp.courses, 1500);
      }
    } catch {
      /* malformed cache — ignore */
    }

    const sb = window._sb;
    if (!sb) return;
    // 2s timeout per query (was 5s): on a healthy network these typically
    // return in <300ms, so 2s is plenty of slack but cuts the worst-case
    // fallback wait by 60%. Resolving null on timeout lets downstream code
    // use cached/default state instead of blocking the UI.
    // Distinguish "query answered: no row" from "query never answered". The
    // paywall decision must only ever act on a POSITIVE answer — a timed-out
    // subscriptions query is not proof the user has no subscription.
    const timedOut: Record<string, boolean> = {};
    const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T | null> =>
      Promise.race<T | null>([
        p,
        new Promise<null>((resolve) =>
          setTimeout(() => {
            console.warn('[loadUserData] ' + label + ' timed out');
            timedOut[label] = true;
            resolve(null);
          }, 2000)
        ),
      ]);
    // Fire all three queries in parallel. Was sequential awaits — that
    // meant a slow profiles query blocked settings AND subscriptions from
    // even starting. Parallel cuts boot data-fetch time to whichever single
    // query is slowest, instead of the sum.
    const [profile, settings, sub0] = await Promise.all([
      withTimeout(
        sb.from('profiles').select('*').eq('id', uid).single() as Promise<ProfileRow | null>,
        'profiles'
      ) as Promise<ProfileRow | null>,
      withTimeout(
        sb.from('settings').select('*').eq('id', uid).single() as Promise<SettingsRow | null>,
        'settings'
      ) as Promise<SettingsRow | null>,
      withTimeout(
        sb.from('subscriptions').select('*').eq('user_id', uid).single() as Promise<SubscriptionRow | null>,
        'subscriptions'
      ) as Promise<SubscriptionRow | null>,
    ]);

    applyAffiliateAccess(profile);
    if (profile && profile.full_name) {
      try {
        localStorage.setItem('profile_cache_' + uid, JSON.stringify(profile));
      } catch {
        /* quota */
      }
      if (window.applyProfile) window.applyProfile(profile);
    }
    if (profile && profile.courses) {
      scheduleUserCoursesLoad(profile.courses, 300);
    } else if (window.restoreState) {
      window.restoreState();
    }

    const currentUser = window._currentUser;
    if (currentUser && currentUser.email) {
      fetch((window.SUPA_URL || '') + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
        method: 'PATCH',
        headers: { ...(window._sbHeaders ? window._sbHeaders() : {}), Prefer: 'return=minimal' },
        body: JSON.stringify({ auth_email: currentUser.email }),
      }).then(stopHeartbeatOnUnauthorized).catch(() => {});
    }

    startPresenceHeartbeat(uid);

    if (settings && window.applySettings) window.applySettings(settings);

    let sub = sub0;
    if (sub && sub.status !== 'paused' && sub.expires_at && Date.parse(sub.expires_at) <= Date.now()) {
      sub = { ...sub, status: 'expired' };
    }
    if (
      sub &&
      sub.plan === 'pro' &&
      !sub.stripe_subscription_id &&
      !sub.stripe_customer_id &&
      !sub.paypal_subscription_id &&
      !['cancelled', 'expired', 'past_due', 'paused'].includes(String(sub.status || ''))
    ) {
      sub = { ...sub, status: sub.status || 'active' };
    }
    if (window.applySubscription) window.applySubscription(sub || {});
    const isAffiliate = String(profile?.status || '').toLowerCase() === 'affiliate';
    if (isAffiliate && window.applySubscription) {
      window.applySubscription({
        ...(sub || {}),
        plan: 'pro',
        status: 'active',
        affiliate_managed: true,
      });
    }

    // The trial paywall is a conversion surface, not the enforcement layer
    // (the backend 402s AI usage regardless). Showing it requires a POSITIVE
    // "this user has no subscription": a timed-out subscriptions query or a
    // failed admin check is an unknown, and flashing the trial screen at a
    // paying user on every flaky reload is worse than skipping it once for a
    // free user. ss_pro_seen_<uid> remembers the last confirmed pro state so
    // even a known-stale boot doesn't flash the gate; it's cleared the next
    // time the subscription is positively absent/expired.
    const subStatusKnown = !timedOut['subscriptions'];
    const proSeenKey = 'ss_pro_seen_' + uid;
    const decidePaywall = (isAdmin: boolean, adminKnown: boolean): void => {
      let cachedPro = false;
      try { cachedPro = localStorage.getItem(proSeenKey) === '1'; } catch { /* ignore */ }
      try {
        if (window._userIsPro || isAdmin || isAffiliate) localStorage.setItem(proSeenKey, '1');
        else if (subStatusKnown && adminKnown) localStorage.removeItem(proSeenKey);
      } catch { /* ignore */ }
      if (!window._userIsPro && !isAdmin && !isAffiliate && subStatusKnown && adminKnown && !cachedPro && window._showPaywall) {
        setTimeout(window._showPaywall, 800);
      }
    };

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
          if (!window._userIsPro && window.applySubscription) {
            window.applySubscription({
              ...(sub || {}),
              plan: 'pro',
              status: sub && sub.status === 'paused' ? 'paused' : 'active',
              admin_managed: true,
            });
          }
        }
        // checkAdminStatus resolves null for non-admins (403) — that IS a
        // known answer. Only a thrown fetch (network) lands in catch below.
        decidePaywall(isAdmin, true);
      })
      .catch(() => {
        decidePaywall(false, false);
      });

    if (typeof window._dwLoadAndRender === 'function') window._dwLoadAndRender();
    const loadLectureNotes = window._lnLoadFromSupabase || window.lnLoadFromSupabase;
    if (loadLectureNotes) {
      loadLectureNotes(uid).catch(() => {
        console.warn('Lecture notes load failed');
      });
    } else {
      console.warn('Lecture notes loader is not ready yet');
    }
  } catch (e: unknown) {
    console.warn('loadUserData error:', e);
  }
}

function applyAffiliateAccess(p: ProfileRow | null | undefined): void {
  if (!p) return;
  const affiliateLink = document.getElementById('psbAffiliate');
  if (affiliateLink) {
    affiliateLink.style.display = String(p.status || '').toLowerCase() === 'affiliate' ? '' : 'none';
  }
}

export function applyProfile(p: ProfileRow | null | undefined): void {
  if (!p) return;
  applyAffiliateAccess(p);
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
  if (p.university) {
    window._userUniversity = p.university;
    localStorage.setItem('ss_university', p.university);
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
    const tFn = window._t;
    const germanTestLabel = tFn ? tFn('profile_german_test') : 'German Test';
    const uni = window._userUniversity || localStorage.getItem('ss_university') || '';
    sub.textContent = isLearner
      ? (germanTest || germanTestLabel) + (germanLevel ? ' · ' + germanLevel : '')
      : uni;
  }
  const coursesNav = document.getElementById('pcStudip');
  const germanNav = document.getElementById('psbGerman');
  const problemRailBtn = document.querySelector<HTMLElement>('.dr-rail-btn[data-dr-mode="problem"]');
  if (coursesNav) coursesNav.style.display = isLearner ? 'none' : '';
  if (germanNav) germanNav.style.display = isLearner ? '' : 'none';
  if (problemRailBtn) problemRailBtn.style.display = isLearner ? 'none' : '';

  const glSub = document.getElementById('glTestBadge');
  const glChip = document.getElementById('glLevelChip');
  if (glSub) {
    const tFn = window._t;
    const germanTestLabel = tFn ? tFn('profile_german_test') : 'German Test';
    const prepWord = tFn ? tFn('user_preparation') : 'preparation';
    glSub.textContent = (germanTest || germanTestLabel) + ' ' + prepWord;
  }
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
