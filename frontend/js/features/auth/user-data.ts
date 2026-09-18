import { checkAdminStatus } from '../../services/admin-service.js';
import { authenticatedSupabaseFetch } from '../../services/authenticated-fetch.js';

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
  german_exam_profile_id?: string | null;
  [k: string]: unknown;
}

// German Exam Engine profile registry, client-side mirror of the backend's
// resolve_profile_id() in backend/python-ai/app/services/german_exam_profiles.py.
// Table-driven (not a hardcoded if-chain) so adding a profile is one entry
// here + one entry in the backend registry, not another branch — this
// matters once TestDaF digital/paper or more telc variants exist and a
// single (family, level) pair no longer maps unambiguously.
const GERMAN_EXAM_PROFILES_CLIENT: Array<{ profileId: string; family: string; legacyLevelValues: string[] }> = [
  { profileId: 'telc_c1_hochschule', family: 'telc', legacyLevelValues: ['C1 Hochschule'] },
];

function resolveGermanExamProfileIdClient(test: string | undefined, level: string | undefined): string | null {
  const familyNorm = (test || '').trim().toLowerCase();
  const levelNorm = (level || '').trim();
  if (!familyNorm || !levelNorm) return null;
  const matches = GERMAN_EXAM_PROFILES_CLIENT.filter(
    (p) => p.family.toLowerCase() === familyNorm && p.legacyLevelValues.indexOf(levelNorm) !== -1
  );
  return matches.length === 1 ? matches[0]?.profileId ?? null : null;
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

// Used to default to 1500ms (cached profile) / 300ms (fresh profile) —
// showing a stale-empty course list for up to 1.5s even though the data was
// already sitting in localStorage. _loadUserCourses is cheap (in-memory SEMS
// replacement + a render; the storage-prewarm fan-out this delay originally
// guarded against was already removed — see app-data.js's own "Background
// prewarm intentionally disabled" note), so applying it on the next
// microtask instead is safe. Calling it twice in quick succession (once for
// cache, once for the fresh profile fetch moments later) is harmless: the
// fresh call just reconciles over whatever the cached call already showed.
function scheduleUserCoursesLoad(courses: unknown): void {
  if (!courses || !window._loadUserCourses) return;
  queueMicrotask(() => {
    if (window._loadUserCourses) window._loadUserCourses(courses);
  });
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
    authenticatedSupabaseFetch(SUPA_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    }, { safeToRetry: true }).then(stopHeartbeatOnUnauthorized).catch(() => {});
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
  try {
    try {
      const cached = localStorage.getItem('profile_cache_' + uid);
      if (cached) {
        const cp = JSON.parse(cached) as ProfileRow;
        if (cp && window.applyProfile) window.applyProfile(cp, { authoritative: false });
        if (cp && cp.courses) scheduleUserCoursesLoad(cp.courses);
      }
    } catch {
      /* malformed cache — ignore */
    }

    const sb = window._sb;
    // Commit the dedup window only once the authoritative fetch is actually
    // about to fire, not at function entry — a call that returns here
    // because window._sb isn't ready yet never really "loaded" anything, so
    // it must not block the next call for the full 30s window. That gap
    // used to leave the browser with only the (possibly stale/partial)
    // cached profile applied, for up to 30s, with no authoritative fetch
    // in flight to correct it.
    if (!sb) return;
    _lastLoadUid = uid;
    _lastLoadAt = Date.now();
    // 2s timeout per query (was 5s): on a healthy network these typically
    // return in <300ms, so 2s is plenty of slack but cuts the worst-case
    // fallback wait by 60%. Resolving null on timeout lets downstream code
    // use cached/default state instead of blocking the UI.
    // Distinguish "query answered: no row" from "query never answered". The
    // paywall decision must only ever act on a POSITIVE answer — a timed-out
    // subscriptions query is not proof the user has no subscription.
    const timedOut: Record<string, boolean> = {};
    // A rejection (network error, non-2xx from PostgREST, etc.) used to
    // propagate straight through Promise.race and then Promise.all below,
    // aborting the ENTIRE loadUserData call — including the other two
    // queries that may have succeeded — and, critically, skipping the
    // profile apply below entirely. That left _germanProfileLoaded unset
    // for the rest of the session with no retry, which is exactly what
    // stranded Sprachbausteine (and Lesen/Hören/Writing Coach, which read
    // the same flag) on "Loading your exam profile…" forever after a
    // transient 503/403 during boot. Resolve null on error too, same as a
    // timeout — the caller already treats null as "couldn't get this".
    const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T | null> =>
      Promise.race<T | null>([
        p.catch((err: unknown) => {
          console.warn('[loadUserData] ' + label + ' failed', err);
          timedOut[label] = true;
          return null;
        }),
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
    // Apply whenever a row came back — not just when full_name is set. This
    // used to gate on full_name, which silently dropped the ENTIRE fresh
    // profile (user_type, german_test, german_level, etc.) for any account
    // that hadn't filled in a display name, e.g. a learner mid-onboarding.
    // applyProfile() already falls back to email/'You' when full_name is
    // missing, so there's nothing unsafe about applying a nameless row.
    if (profile) {
      try {
        localStorage.setItem('profile_cache_' + uid, JSON.stringify(profile));
      } catch {
        /* quota */
      }
      if (window.applyProfile) window.applyProfile(profile);
    } else if (window.applyProfile) {
      // The authoritative profiles fetch didn't return a row (timed out,
      // errored, or a genuine DB miss) — every module gating on
      // _germanProfileLoaded (Sprachbausteine/Lesen/Hören/Writing Coach)
      // has no other signal to stop waiting on, so leaving it unset here
      // means an indefinite loading spinner instead of either the
      // resolved cached profile or an honest "unsupported" state. Promote
      // whatever's already known (from the cache-path apply earlier in
      // this function, or localStorage) as final: applyProfile({}, ...)
      // carries no keys of its own, so the hasOwnProperty guards in
      // applyProfile() make this a no-op for every field except flipping
      // _germanProfileLoaded to true.
      window.applyProfile({}, { authoritative: true });
    }
    if (profile && profile.courses) {
      scheduleUserCoursesLoad(profile.courses);
    } else if (window.restoreState) {
      window.restoreState();
    }

    const currentUser = window._currentUser;
    if (currentUser && currentUser.email) {
      authenticatedSupabaseFetch((window.SUPA_URL || '') + '/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ auth_email: currentUser.email }),
      }, { safeToRetry: true }).then(stopHeartbeatOnUnauthorized).catch(() => {});
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
      })
      .catch(() => undefined);

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
    // Same reasoning as the null-profile branch above: an unexpected throw
    // anywhere in this function must not leave _germanProfileLoaded unset
    // forever. This is now a secondary safety net (withTimeout no longer
    // lets a query rejection propagate this far), covering anything else
    // that could throw before the profile apply runs.
    if (window.applyProfile) window.applyProfile({}, { authoritative: true });
  }
}

function applyAffiliateAccess(p: ProfileRow | null | undefined): void {
  if (!p) return;
  const affiliateLink = document.getElementById('psbAffiliate');
  if (affiliateLink) {
    affiliateLink.style.display = String(p.status || '').toLowerCase() === 'affiliate' ? '' : 'none';
  }
}

export function applyProfile(
  p: ProfileRow | null | undefined,
  opts: { authoritative?: boolean } = {}
): void {
  if (!p) return;
  const authoritative = opts.authoritative !== false;
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
  // A full profiles row (select('*')) always carries these keys, even as
  // null when unset, so hasOwnProperty is true and behavior below is
  // unchanged for a real fetch. A partial object — e.g. profile.js's
  // saveProfile(), which only sends the fields the edit form actually
  // touched — omits keys it never read, and MUST NOT be treated as "this
  // field is now empty": that previously downgraded an already-resolved
  // German exam profile back to unsupported on every profile save. Only a
  // key that's genuinely present (present-but-falsy is a real "cleared"
  // value) may override the current in-memory state; an absent key falls
  // back to whatever's already there.
  const hasUserType = Object.prototype.hasOwnProperty.call(p, 'user_type');
  const hasGermanTest = Object.prototype.hasOwnProperty.call(p, 'german_test');
  const hasGermanLevel = Object.prototype.hasOwnProperty.call(p, 'german_level');
  const hasGermanExamProfileId = Object.prototype.hasOwnProperty.call(p, 'german_exam_profile_id');
  window._userType = hasUserType
    ? p.user_type || localStorage.getItem('ss_user_type_' + uid) || 'enrolled'
    : window._userType || localStorage.getItem('ss_user_type_' + uid) || 'enrolled';
  window._germanTest = hasGermanTest
    ? p.german_test || localStorage.getItem('ss_german_test_' + uid) || ''
    : window._germanTest || localStorage.getItem('ss_german_test_' + uid) || '';
  window._germanLevel = hasGermanLevel
    ? p.german_level || localStorage.getItem('ss_german_level_' + uid) || ''
    : window._germanLevel || localStorage.getItem('ss_german_level_' + uid) || '';
  if (uid) {
    localStorage.setItem('ss_user_type_' + uid, window._userType);
    localStorage.setItem('ss_german_test_' + uid, window._germanTest);
    localStorage.setItem('ss_german_level_' + uid, window._germanLevel);
  }

  // Canonical German Exam Engine profile id: prefer the persisted column
  // (authoritative once written), else derive it client-side and persist it
  // lazily so future reads (and the backend, which also derives it) agree.
  // A stale localStorage cache alone is intentionally never trusted here —
  // only the freshly-fetched profiles row or a fresh derivation are. A
  // partial object that never carried this column falls back to the
  // already-resolved in-memory id instead of being treated as "cleared",
  // for the same reason as german_test/german_level above.
  const persistedProfileId = hasGermanExamProfileId
    ? p.german_exam_profile_id || null
    : window._germanExamProfileId || null;
  const derivedProfileId = persistedProfileId || resolveGermanExamProfileIdClient(window._germanTest, window._germanLevel);
  window._germanExamProfileId = derivedProfileId;
  if (uid) localStorage.setItem('ss_german_exam_profile_id_' + uid, derivedProfileId || '');
  if (!persistedProfileId && derivedProfileId && window._currentUser) {
    const sb = window._sb as { from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (k: string, v: unknown) => Promise<{ error?: unknown }> } } } | undefined;
    if (sb) {
      sb.from('profiles')
        .update({ german_exam_profile_id: derivedProfileId })
        .eq('id', window._currentUser.id)
        .catch(() => {
          /* best-effort cache write; resolution still works next load either way */
        });
    }
  }
  applyUserTypeUI();
  // Only an authoritative apply (a fresh profiles-row fetch, or a just-saved
  // write) may promote this to true. A cache-sourced apply (boot-time
  // profile_cache_<uid>, see app.ts/loadUserData) can be stale or predate
  // german_test/german_level being set — treating THAT as "the profile has
  // definitively loaded" was the real bug behind Sprachbausteine/Lesen/
  // Hören/Writing Coach showing an "unsupported profile" state for a
  // learner whose real profile does resolve, just not yet fetched. Never
  // regress an already-true flag back to false on a later non-authoritative
  // call (there shouldn't be one, but this keeps the invariant monotonic).
  if (authoritative) window._germanProfileLoaded = true;
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
  // Sidebar items/dividers/section-labels opt into role-gating via
  // data-roles="student" / "learner" (comma-separated for both); everything
  // else is unaffected, so student nav stays pixel-identical.
  document.querySelectorAll<HTMLElement>('[data-roles]').forEach((el) => {
    const roles = (el.getAttribute('data-roles') || '').split(',').map((r) => r.trim());
    el.style.display = roles.includes(isLearner ? 'learner' : 'student') ? '' : 'none';
  });
  const problemRailBtn = document.querySelector<HTMLElement>('.dr-rail-btn[data-dr-mode="problem"]');
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
