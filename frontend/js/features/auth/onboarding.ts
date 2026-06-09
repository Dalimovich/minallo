import { HOCHSCHULEN, type Hochschule } from '../../data/hochschulen.js';

declare global {
  interface Window {
    VERTIEFUNG_MAP?: Record<string, string[]>;
    VERTIEFUNG_LIST?: string[];
    _obLogout?: () => void;
    _obNext?: () => void;
    _obSelectPath?: (path: string) => void;
    _obBack?: (fromStep?: number) => void;
    _obSelectTest?: (card: HTMLElement) => void;
    _obSelectLevel?: (btn: HTMLElement, level: string) => void;
    _obFinish?: () => Promise<void>;
    _obFinishLearner?: () => Promise<void>;
  }
}

interface ObSupabaseResult {
  error?: { message?: string } | null;
}

interface ObSupabaseClient {
  from: (table: string) => {
    upsert: (row: Record<string, unknown>) => Promise<ObSupabaseResult>;
  };
}

interface ProfilePayload {
  id?: string;
  full_name: string;
  email: string;
  auth_email?: string;
  university?: string;
  university_name?: string;
  university_state?: string;
  university_type?: string;
  programme?: string;
  vertiefung?: string;
  matrikel?: string;
  user_type?: string;
  german_test?: string;
  german_level?: string;
  age?: number | null;
  updated_at?: string;
}

interface CachePayload {
  full_name: string;
  email: string;
  university?: string;
  university_name?: string;
  university_state?: string;
  university_type?: string;
  programme?: string;
  vertiefung?: string;
  matrikel?: string;
  user_type: string;
  german_test?: string;
  german_level?: string;
}

import { listSuggestions, submitSuggestion } from '../../services/suggestions-service.js';

let _obTest = '';
let _obLevel = '';
let _obSelectedHochschule: Hochschule | null = null;

// Per-major cache of crowd-approved Vertiefung suggestions. Filled lazily
// when the user picks a major in step 3a. Avoids re-fetching on every
// keystroke in the Vertiefung input.
const _obVertSuggestions: Record<string, string[]> = {};
let _obVertSuggestionsLoading: Record<string, boolean> = {};

async function _loadVertSuggestions(major: string): Promise<void> {
  if (!major || _obVertSuggestions[major] !== undefined) return;
  if (_obVertSuggestionsLoading[major]) return;
  _obVertSuggestionsLoading[major] = true;
  try {
    const items = await listSuggestions('vertiefung', major);
    _obVertSuggestions[major] = items.map((i) => i.value);
  } catch {
    _obVertSuggestions[major] = [];
  } finally {
    _obVertSuggestionsLoading[major] = false;
  }
}

function _obIsTuBraunschweig(hs: Hochschule | null = _obSelectedHochschule): boolean {
  if (!hs) return false;
  return hs.short === 'TU Braunschweig';
}

function _obCurrentProgramme(): string {
  const inp = document.getElementById('obProg') as HTMLInputElement | null;
  return inp ? inp.value.trim() : '';
}

function _obApplyVertiefungVisibility(major: string): void {
  const row = document.getElementById('obVertiefungRow');
  const vInp = document.getElementById('obVertiefung') as HTMLInputElement | null;
  const drop = document.getElementById('obVertDrop');
  if (!row) return;

  row.style.display = 'flex';
  if (drop) drop.style.display = 'none';
  const VERTIEFUNG_MAP = window.VERTIEFUNG_MAP || {};
  const list = VERTIEFUNG_MAP[major];
  const hasVertiefung = _obIsTuBraunschweig() && !!(list && list.length);
  if (vInp) {
    _obSetPlaceholder(
      vInp,
      hasVertiefung ? 'ob_vertiefung_ph' : 'ob_vertiefung_optional_ph'
    );
  }
  if (major) void _loadVertSuggestions(major);
}

const _obTestLevels: Record<string, string[]> = {
  TestDaF: ['TDN 3', 'TDN 4', 'TDN 5'],
  DSH: ['DSH-1', 'DSH-2', 'DSH-3'],
  Goethe: ['B1', 'B2', 'C1', 'C2'],
  telc: ['B2', 'C1', 'C1 Hochschule', 'C2'],
  OESD: ['B2', 'C1', 'C2'],
  DSD: ['DSD I (B1/B2)', 'DSD II (C1)'],
};

function _obT(key: string): string {
  try {
    return typeof window._t === 'function' ? window._t(key) : key;
  } catch {
    return key;
  }
}

function _obSetText(id: string, key: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('data-i18n', key);
  el.textContent = _obT(key);
}

function _obSetPlaceholder(el: HTMLInputElement | null, key: string): void {
  if (!el) return;
  el.setAttribute('data-i18n-ph', key);
  // _obT (→ window._t) falls back to returning the key itself when the
  // translation is empty/missing. An intentionally-blank placeholder must
  // stay blank rather than leaking the raw key name into the field.
  const v = _obT(key);
  el.placeholder = v === key ? '' : v;
}

function _obSetHeader(titleKey: string, subKey: string, emojiText: string): void {
  _obSetText('obTitle', titleKey);
  _obSetText('obSub', subKey);
  const emoji = document.getElementById('obEmoji');
  if (emoji) emoji.textContent = emojiText;
}

function _obShowStep(step: string): void {
  ['obStep1', 'obStep2', 'obStep3a', 'obStep3b'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById('obStep' + step);
  if (target) target.style.display = 'flex';
  const grad = 'linear-gradient(90deg,#3b82f6,#0ea5e9)';
  const dim = 'rgba(255,255,255,.12)';
  const p1 = document.getElementById('obProg1');
  const p2 = document.getElementById('obProg2');
  const p3 = document.getElementById('obProg3');
  if (step === '1') {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = dim;
    if (p3) p3.style.background = dim;
  } else if (step === '2') {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = grad;
    if (p3) p3.style.background = dim;
  } else {
    if (p1) p1.style.background = grad;
    if (p2) p2.style.background = grad;
    if (p3) p3.style.background = grad;
  }
}

function inputValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? el.value.trim() : '';
}

function _obBaseInfo(): { first: string; last: string; age: string; email: string } {
  return {
    first: inputValue('obFirst'),
    last: inputValue('obLast'),
    age: inputValue('obAge'),
    email: inputValue('obEmail'),
  };
}

async function _obSaveAndClose(
  profilePayload: ProfilePayload,
  cachePayload: CachePayload,
  onError?: (msg: string) => void
): Promise<void> {
  const _currentUser = window._currentUser;
  if (_currentUser) {
    const sb = window._sb as ObSupabaseClient | undefined;
    if (sb) {
      try {
        const res = await sb.from('profiles').upsert(profilePayload as unknown as Record<string, unknown>);
        if (res && res.error) {
          const fallback: Partial<ProfilePayload> = Object.assign({}, profilePayload);
          delete fallback.vertiefung;
          delete fallback.german_test;
          delete fallback.german_level;
          delete fallback.user_type;
          const fallbackRes = await sb
            .from('profiles')
            .upsert(fallback as unknown as Record<string, unknown>);
          if (fallbackRes && fallbackRes.error) {
            console.error('Profile save error (both attempts failed):', fallbackRes.error);
            const msg = fallbackRes.error.message || 'Could not save your profile.';
            if (typeof onError === 'function') onError(msg);
            return;
          }
          console.warn('Profile partial save:', res.error);
        }
      } catch (e: unknown) {
        console.error('Profile save error:', e);
        const msg = e instanceof Error ? e.message : 'Could not save your profile.';
        if (typeof onError === 'function') onError(msg);
        return;
      }
    }
    try {
      const uid = _currentUser.id;
      if (uid) {
        localStorage.setItem('profile_cache_' + uid, JSON.stringify(cachePayload));
      }
    } catch {
      /* ignore */
    }
  }
  const pName = document.getElementById('profileName') as HTMLInputElement | null;
  const pEmail = document.getElementById('profileEmail') as HTMLInputElement | null;
  const pUni = document.getElementById('profileUniversity') as HTMLInputElement | null;
  const pProg = document.getElementById('profileProgramme') as HTMLInputElement | null;
  const pInit = document.getElementById('profileInitial');
  const fullName = profilePayload.full_name;
  if (pName) pName.value = fullName;
  if (pEmail) pEmail.value = profilePayload.email;
  if (pUni && profilePayload.university) pUni.value = profilePayload.university;
  if (pProg && profilePayload.programme) pProg.value = profilePayload.programme;
  if (pInit) pInit.textContent = fullName.charAt(0).toUpperCase();
  if (typeof window.updateAuthIndicator === 'function' && _currentUser)
    window.updateAuthIndicator(_currentUser);
  localStorage.setItem('ob_done_' + (_currentUser ? _currentUser.id : 'u'), '1');
  // Welcome notification for brand-new users. dedupeKey keeps it to once even
  // if onboarding is re-run, and addNotification is a no-op if the module/uid
  // isn't ready yet.
  try {
    const _w = window as unknown as {
      addNotification?: (n: {
        title: string;
        body?: string;
        icon?: string;
        dedupeKey?: string;
      }) => void;
      _lang?: string;
    };
    const _de = _w._lang === 'de';
    _w.addNotification?.({
      icon: '🎉',
      title: _de ? 'Willkommen bei Minallo! 👋' : 'Welcome to Minallo! 👋',
      body: _de
        ? 'Schön, dass du da bist! Lade ein PDF hoch, stelle Fragen an die KI und erstelle Quizze, um loszulegen.'
        : "Glad you're here! Upload a PDF, ask the AI questions, and generate quizzes to get started.",
      dedupeKey: 'welcome',
    });
  } catch {
    /* notifications optional — never block onboarding */
  }
  const modal = document.getElementById('onboardModal');
  if (modal) modal.style.display = 'none';
}

export function showOnboarding(email?: string): void {
  _obTest = '';
  _obLevel = '';
  _obShowStep('1');
  _obSetHeader('ob_welcome_title', 'ob_step1', '👋');
  const emailField = document.getElementById('obEmail') as HTMLInputElement | null;
  if (emailField && email) emailField.value = email;
  const modal = document.getElementById('onboardModal');
  if (modal) modal.style.display = 'flex';
}

function _selectedState(): string {
  const sel = document.getElementById('obState') as HTMLSelectElement | null;
  return sel ? sel.value : '';
}

function setupStateSelect(): void {
  const sel = document.getElementById('obState') as HTMLSelectElement | null;
  const uniInp = document.getElementById('obUni') as HTMLInputElement | null;
  if (!sel) return;
  // Populate options from HOCHSCHULEN so the list stays in sync with the
  // generated data file. Sorted alphabetically (de-DE locale).
  const states = Array.from(new Set(HOCHSCHULEN.map((h) => h.state))).sort((a, b) =>
    a.localeCompare(b, 'de')
  );
  states.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    if (!uniInp) return;
    // State changed → previously chosen uni is no longer valid.
    uniInp.value = '';
    _obSelectedHochschule = null;
    _obApplyVertiefungVisibility(_obCurrentProgramme());
    if (sel.value) {
      uniInp.disabled = false;
      _obSetPlaceholder(uniInp, 'ob_uni_ph_after');
      uniInp.focus();
    } else {
      uniInp.disabled = true;
      _obSetPlaceholder(uniInp, 'ob_uni_ph_before');
    }
  });
}

function setupUniAutocomplete(): void {
  const inp = document.getElementById('obUni') as HTMLInputElement | null;
  const drop = document.getElementById('obUniDrop');
  if (!inp || !drop) return;

  function _showUniDrop(q: string): void {
    if (!drop || !inp) return;
    const state = _selectedState();
    if (!state) {
      drop.style.display = 'none';
      return;
    }
    const inState = HOCHSCHULEN.filter((h) => h.state === state);
    const needle = q.toLowerCase();
    // Match against short OR full name so users can search either way.
    const items = needle
      ? inState.filter(
          (h) =>
            h.short.toLowerCase().includes(needle) ||
            h.name.toLowerCase().includes(needle)
        )
      : inState;
    // Cap to 50 results — autocomplete lists longer than that overwhelm the
    // dropdown and the user is expected to type more to narrow down.
    const shown = items.slice(0, 50);
    if (!shown.length) {
      drop.style.display = 'none';
      return;
    }
    drop.innerHTML = '';
    shown.forEach((h) => {
      const opt = document.createElement('div');
      const short = document.createElement('div');
      short.textContent = h.short;
      short.style.cssText = 'font-weight:600;color:rgba(255,255,255,.9)';
      const sub = document.createElement('div');
      sub.textContent = h.name + ' · ' + h.state;
      sub.style.cssText =
        'font-size:.72rem;font-weight:500;color:rgba(255,255,255,.4);margin-top:2px';
      opt.appendChild(short);
      opt.appendChild(sub);
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = h.short;
        _obSelectedHochschule = h;
        drop.style.display = 'none';
        _obApplyVertiefungVisibility(_obCurrentProgramme());
      });
      drop.appendChild(opt);
    });
    drop.style.display = 'block';
  }

  inp.addEventListener('focus', () => {
    _showUniDrop(inp.value.trim());
  });
  inp.addEventListener('input', () => {
    // Free-text edits invalidate the previously-selected university.
    _obSelectedHochschule = null;
    _obApplyVertiefungVisibility(_obCurrentProgramme());
    _showUniDrop(inp.value.trim());
  });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });
}

function setupProgAutocomplete(): void {
  const inp = document.getElementById('obProg') as HTMLInputElement | null;
  const drop = document.getElementById('obProgDrop');
  if (!inp || !drop) return;

  function _showProgDrop(q: string): void {
    if (!drop || !inp) return;
    const MAJOR_LIST = window.MAJOR_LIST || [];
    const items = q
      ? MAJOR_LIST.filter((v) => v.toLowerCase().includes(q.toLowerCase()))
      : MAJOR_LIST;
    if (!items.length) {
      drop.style.display = 'none';
      return;
    }
    drop.innerHTML = '';
    items.forEach((v) => {
      const opt = document.createElement('div');
      opt.textContent = v;
      opt.style.cssText =
        "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family: var(--font-main);font-weight:700";
      opt.addEventListener('mouseenter', () => {
        opt.style.background = 'rgba(59,130,246,.15)';
      });
      opt.addEventListener('mouseleave', () => {
        opt.style.background = '';
      });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = v;
        drop.style.display = 'none';
        _obToggleVertiefung(v);
      });
      drop.appendChild(opt);
    });
    drop.style.display = 'block';
  }

  function _obToggleVertiefung(major: string): void {
    _obApplyVertiefungVisibility(major);
  }

  inp.addEventListener('focus', () => {
    _showProgDrop(inp.value.trim());
  });
  inp.addEventListener('input', () => {
    _showProgDrop(inp.value.trim());
    _obToggleVertiefung(inp.value.trim());
  });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });
  _obToggleVertiefung(inp.value.trim());
}

function setupVertOnboardingAutocomplete(): void {
  const inp = document.getElementById('obVertiefung') as HTMLInputElement | null;
  const drop = document.getElementById('obVertDrop');
  if (!inp || !drop) return;

  function _showVertDrop(q: string): void {
    if (!drop || !inp) return;
    const majorInp = document.getElementById('obProg') as HTMLInputElement | null;
    const major = majorInp ? majorInp.value.trim() : '';
    const VERTIEFUNG_MAP = window.VERTIEFUNG_MAP || {};
    const VERTIEFUNG_LIST = window.VERTIEFUNG_LIST || [];
    const isTuBraunschweig = _obIsTuBraunschweig();
    const mapped = isTuBraunschweig ? VERTIEFUNG_MAP[major] : undefined;
    // TU Braunschweig keeps the built-in Vertiefung catalog. Other universities
    // only show approved crowd suggestions, while still allowing free typing.
    const crowd = major ? (_obVertSuggestions[major] || []) : [];
    const baseList = isTuBraunschweig ? (mapped && mapped.length ? mapped : VERTIEFUNG_LIST) : [];
    const seen = new Set<string>();
    const base: string[] = [];
    [...baseList, ...crowd].forEach((v) => {
      const key = v.toLowerCase();
      if (!seen.has(key)) { seen.add(key); base.push(v); }
    });
    const items = q ? base.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : base;
    if (!items.length) {
      drop.style.display = 'none';
      return;
    }
    drop.innerHTML = '';
    items.forEach((v) => {
      const opt = document.createElement('div');
      opt.textContent = v;
      opt.style.cssText =
        "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family: var(--font-main);font-weight:700";
      opt.addEventListener('mouseenter', () => {
        opt.style.background = 'rgba(59,130,246,.15)';
      });
      opt.addEventListener('mouseleave', () => {
        opt.style.background = '';
      });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = v;
        drop.style.display = 'none';
      });
      drop.appendChild(opt);
    });
    drop.style.display = 'block';
  }

  inp.addEventListener('focus', () => {
    _showVertDrop(inp.value.trim());
  });
  inp.addEventListener('input', () => {
    _showVertDrop(inp.value.trim());
  });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });
}

function setupVertProfileAutocomplete(): void {
  const inp = document.getElementById('profileVertiefung') as HTMLInputElement | null;
  const drop = document.getElementById('pfVertDrop');
  if (!inp || !drop) return;

  function _showPfVertDrop(q: string): void {
    if (!drop || !inp) return;
    const VERTIEFUNG_LIST = window.VERTIEFUNG_LIST || [];
    const items = q
      ? VERTIEFUNG_LIST.filter((v) => v.toLowerCase().includes(q.toLowerCase()))
      : VERTIEFUNG_LIST;
    if (!items.length) {
      drop.style.display = 'none';
      return;
    }
    drop.innerHTML = '';
    items.forEach((v) => {
      const opt = document.createElement('div');
      opt.textContent = v;
      opt.style.cssText =
        "padding:9px 14px;cursor:pointer;font-size:.85rem;color:rgba(255,255,255,.85);border-bottom:1px solid rgba(59,130,246,.1);font-family: var(--font-main);font-weight:700";
      opt.addEventListener('mouseenter', () => {
        opt.style.background = 'rgba(59,130,246,.15)';
      });
      opt.addEventListener('mouseleave', () => {
        opt.style.background = '';
      });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = v;
        drop.style.display = 'none';
      });
      drop.appendChild(opt);
    });
    drop.style.display = 'block';
  }

  inp.addEventListener('focus', () => {
    _showPfVertDrop(inp.value.trim());
  });
  inp.addEventListener('input', () => {
    _showPfVertDrop(inp.value.trim());
  });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });
}

export function initOnboarding(): void {
  setupStateSelect();
  setupUniAutocomplete();
  setupProgAutocomplete();
  setupVertOnboardingAutocomplete();
  setupVertProfileAutocomplete();

  window._obLogout = function () {
    // Delegate to the central signOut so we get a single source of truth for
    // session cleanup (tokens, profile_cache_<uid>, ss_last_uid, course
    // caches) plus the Supabase /auth/v1/logout revocation. Doing it inline
    // here used to scrub the wrong storages — sb_sess_refresh lives in
    // localStorage, not sessionStorage — leaving the refresh token behind so
    // the next boot silently re-authed the user.
    const finishReload = () => window.location.reload();
    const sb = (window as unknown as {
      _sb?: { auth?: { signOut?: () => unknown } };
    })._sb;
    if (sb?.auth?.signOut) {
      try {
        const p = sb.auth.signOut();
        if (p && typeof (p as Promise<unknown>).then === 'function') {
          (p as Promise<unknown>).then(finishReload, finishReload);
          return;
        }
      } catch (_e) { /* central signOut threw — fall through to manual */ }
      finishReload();
      return;
    }

    // Fallback: no central signOut available (shouldn't happen in production).
    // Mirror the cleanup in supabase.js. The refresh token lives ONLY in
    // localStorage; do NOT touch sessionStorage for sb_sess_refresh — that
    // was the original bug (false sense of cleanup, real token survived).
    try {
      sessionStorage.removeItem('sb_sess_token');
      localStorage.removeItem('sb_sess_token');
      localStorage.removeItem('sb_sess_refresh');
      localStorage.removeItem('sb_token');
      localStorage.removeItem('sb_refresh');
      localStorage.removeItem('ss_last_uid');
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('profile_cache_') === 0) localStorage.removeItem(k);
      }
      sessionStorage.removeItem('ss_last_active');
      sessionStorage.removeItem('ss_logged_in');
    } catch (_e) { /* ignore */ }
    finishReload();
  };

  window._obNext = function () {
    const first = inputValue('obFirst');
    const last = inputValue('obLast');
    const age = inputValue('obAge');
    const email = inputValue('obEmail');
    const err = document.getElementById('obErr1');
    if (!err) return;
    if (!first || !last || !age || !email) {
      err.textContent = _obT('ob_err_fill_all');
      err.style.display = 'block';
      return;
    }
    if (!email.includes('@')) {
      err.textContent = _obT('ob_err_valid_email');
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    _obShowStep('2');
    _obSetHeader('ob_path_title', 'ob_step2', '🧭');
  };

  window._obSelectPath = function (path: string) {
    document.querySelectorAll('.ob-path-card').forEach((c) => {
      c.classList.remove('selected');
    });
    const card = document.getElementById(path === 'enrolled' ? 'obPathEnrolled' : 'obPathLearner');
    if (card) card.classList.add('selected');
    setTimeout(() => {
      _obShowStep(path === 'enrolled' ? '3a' : '3b');
      _obSetHeader(
        path === 'enrolled' ? 'ob_almost_there' : 'ob_de_journey',
        'ob_step3',
        path === 'enrolled' ? '🎓' : '🇩🇪'
      );
    }, 200);
  };

  window._obBack = function (fromStep?: number) {
    if (fromStep === 1 || fromStep === undefined) {
      _obShowStep('1');
      _obSetHeader('ob_welcome_title', 'ob_step1', '👋');
    } else {
      _obShowStep('2');
      _obSetHeader('ob_path_title', 'ob_step2', '🧭');
    }
  };

  window._obSelectTest = function (card: HTMLElement) {
    document.querySelectorAll('.ob-test-card').forEach((c) => {
      c.classList.remove('selected');
    });
    card.classList.add('selected');
    _obTest = card.dataset['test'] || '';
    _obLevel = '';
    const wrap = document.getElementById('obLevelWrap');
    const grid = document.getElementById('obLevelGrid');
    if (!wrap || !grid) return;
    const levels = _obTestLevels[_obTest] || [];
    grid.innerHTML = levels
      .map((l) => '<button class="ob-level-btn" data-level="' + l + '">' + l + '</button>')
      .join('');
    wrap.style.display = 'flex';
  };

  window._obSelectLevel = function (btn: HTMLElement, level: string) {
    document.querySelectorAll('.ob-level-btn').forEach((b) => {
      b.classList.remove('selected');
    });
    btn.classList.add('selected');
    _obLevel = level;
  };

  window._obFinish = async function () {
    const state = _selectedState();
    const uni = inputValue('obUni');
    const prog = inputValue('obProg');
    const vertiefung = inputValue('obVertiefung');
    const sem = inputValue('obSem');
    const matrikel = inputValue('obMatrikel');
    const err = document.getElementById('obErr3a');
    if (!err) return;
    if (!state) {
      err.textContent = _obT('ob_err_bundesland');
      err.style.display = 'block';
      return;
    }
    if (!uni || !prog || !sem || !matrikel) {
      err.textContent = _obT('ob_err_fill_all');
      err.style.display = 'block';
      return;
    }
    // Require the user to pick a real entry from the dropdown so we always
    // persist the registry metadata (state, type) alongside the short name.
    // The match must also be in the selected Bundesland — guards against a
    // user changing the state after picking a uni.
    if (
      !_obSelectedHochschule ||
      _obSelectedHochschule.short !== uni ||
      _obSelectedHochschule.state !== state
    ) {
      const match = HOCHSCHULEN.find(
        (h) => h.short.toLowerCase() === uni.toLowerCase() && h.state === state
      );
      if (!match) {
        err.textContent = _obT('ob_err_pick_uni');
        err.style.display = 'block';
        return;
      }
      _obSelectedHochschule = match;
    }
    err.style.display = 'none';
    const btn = document.getElementById('obFinish') as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = _obT('ob_saving');
      btn.disabled = true;
    }
    function _reEnableFinish(msg?: string): void {
      if (btn) {
        btn.textContent = _obT('ob_finish_btn');
        btn.disabled = false;
      }
      if (msg) {
        err!.textContent = _obT('ob_save_failed_prefix') + msg;
        err!.style.display = 'block';
      }
    }

    const info = _obBaseInfo();
    const fullName = info.first + ' ' + info.last;
    const programmeStr = prog + ', ' + sem + '. Semester';
    const MAJOR_LIST = window.MAJOR_LIST || [];
    if (vertiefung) {
      window._userVertiefung = vertiefung;
      localStorage.setItem('ss_vertiefung', vertiefung);
    }
    const _obMatchedMajor = MAJOR_LIST.find((m) => m.toLowerCase() === prog.toLowerCase());
    if (_obMatchedMajor) {
      window._userMajor = _obMatchedMajor;
      localStorage.setItem('ss_major', _obMatchedMajor);
    }
    const pVert = document.getElementById('profileVertiefung') as HTMLInputElement | null;
    const pMat = document.getElementById('profileMatrikel') as HTMLInputElement | null;
    if (pVert) pVert.value = vertiefung;
    if (pMat) pMat.value = matrikel;

    // Crowd-source the Vertiefung dropdown: each submission increments the
    // counter; entries with ≥ 5 submissions auto-approve. Skip values that
    // are already part of TU Braunschweig's static VERTIEFUNG_MAP for this
    // major (they're already in that dropdown).
    if (vertiefung) {
      const staticList = _obIsTuBraunschweig() ? ((window.VERTIEFUNG_MAP || {})[prog] || []) : [];
      const inStatic = staticList.some((v) => v.toLowerCase() === vertiefung.toLowerCase());
      if (!inStatic) void submitSuggestion('vertiefung', prog, vertiefung);
    }

    const _currentUser = window._currentUser;
    const hs = _obSelectedHochschule!;
    const payload: ProfilePayload = {
      id: _currentUser?.id,
      full_name: fullName,
      email: info.email,
      auth_email: _currentUser?.email || '',
      university: hs.short,
      university_name: hs.name,
      university_state: hs.state,
      university_type: hs.type,
      programme: programmeStr,
      vertiefung: vertiefung,
      matrikel: matrikel,
      user_type: 'enrolled',
      age: parseInt(info.age) || null,
      updated_at: new Date().toISOString(),
    };
    await _obSaveAndClose(
      payload,
      {
        full_name: fullName,
        email: info.email,
        university: hs.short,
        university_name: hs.name,
        university_state: hs.state,
        university_type: hs.type,
        programme: programmeStr,
        vertiefung: vertiefung,
        matrikel: matrikel,
        user_type: 'enrolled',
      },
      _reEnableFinish
    );
  };

  window._obFinishLearner = async function () {
    const err = document.getElementById('obErr3b');
    if (!err) return;
    if (!_obTest) {
      err.textContent = _obT('ob_err_select_test');
      err.style.display = 'block';
      return;
    }
    if (!_obLevel) {
      err.textContent = _obT('ob_err_select_level');
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    const btn = document.getElementById('obFinishLearner') as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = _obT('ob_saving');
      btn.disabled = true;
    }
    function _reEnableFinishLearner(msg?: string): void {
      if (btn) {
        btn.textContent = _obT('ob_finish_btn');
        btn.disabled = false;
      }
      if (msg) {
        err!.textContent = _obT('ob_save_failed_prefix') + msg;
        err!.style.display = 'block';
      }
    }

    const info = _obBaseInfo();
    const fullName = info.first + ' ' + info.last;
    const _currentUser = window._currentUser;
    const _uid = _currentUser?.id || '';
    if (_uid) {
      localStorage.setItem('ss_user_type_' + _uid, 'learner');
      localStorage.setItem('ss_german_test_' + _uid, _obTest);
      localStorage.setItem('ss_german_level_' + _uid, _obLevel);
    }
    localStorage.setItem('ss_user_type', 'learner');

    const payload: ProfilePayload = {
      id: _currentUser?.id,
      full_name: fullName,
      email: info.email,
      auth_email: _currentUser?.email || '',
      user_type: 'learner',
      german_test: _obTest,
      german_level: _obLevel,
      age: parseInt(info.age) || null,
      updated_at: new Date().toISOString(),
    };
    await _obSaveAndClose(
      payload,
      {
        full_name: fullName,
        email: info.email,
        user_type: 'learner',
        german_test: _obTest,
        german_level: _obLevel,
      },
      _reEnableFinishLearner
    );
  };

  // initOnboarding is called from main.ts via runIdle(), which usually fires
  // AFTER loader.ts dispatches 'ss-ready' — so registering only on ss-ready
  // means the listener is added too late and the buttons never get wired.
  // Wire immediately if the modal is in the DOM; otherwise wait for ss-ready
  // as a fallback. Guard with a flag so we never wire twice.
  let _wired = false;
  const wireButtons = (): void => {
    if (_wired) return;
    const logoutBtn = document.getElementById('obLogoutBtn');
    const continueBtn = document.getElementById('obContinueBtn');
    const back1Btn = document.getElementById('obBack1Btn');
    const back2aBtn = document.getElementById('obBack2aBtn');
    const back2bBtn = document.getElementById('obBack2bBtn');
    const finishBtn = document.getElementById('obFinish');
    const finishLrnBtn = document.getElementById('obFinishLearner');
    const testGrid = document.getElementById('obTestGrid');
    const levelGrid = document.getElementById('obLevelGrid');

    // If the modal hasn't been injected yet, bail and let the ss-ready
    // fallback below try again. Use obLogoutBtn as the sentinel.
    if (!logoutBtn) return;
    _wired = true;

    logoutBtn.addEventListener('click', () => {
      window._obLogout?.();
    });
    if (continueBtn)
      continueBtn.addEventListener('click', () => {
        window._obNext?.();
      });
    if (back1Btn)
      back1Btn.addEventListener('click', () => {
        window._obBack?.(1);
      });
    if (back2aBtn)
      back2aBtn.addEventListener('click', () => {
        window._obBack?.(2);
      });
    if (back2bBtn)
      back2bBtn.addEventListener('click', () => {
        window._obBack?.(2);
      });
    if (finishBtn)
      finishBtn.addEventListener('click', () => {
        void window._obFinish?.();
      });
    if (finishLrnBtn)
      finishLrnBtn.addEventListener('click', () => {
        void window._obFinishLearner?.();
      });

    document.querySelectorAll<HTMLElement>('.ob-path-card[data-path]').forEach((card) => {
      card.addEventListener('click', () => {
        const path = card.dataset['path'];
        if (path) window._obSelectPath?.(path);
      });
    });
    if (testGrid) {
      testGrid.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        const card = target ? target.closest<HTMLElement>('.ob-test-card') : null;
        if (card && window._obSelectTest) window._obSelectTest(card);
      });
    }
    if (levelGrid) {
      levelGrid.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        const btn = target ? target.closest<HTMLElement>('.ob-level-btn') : null;
        if (btn && btn.dataset['level'] && window._obSelectLevel)
          window._obSelectLevel(btn, btn.dataset['level']);
      });
    }
  };

  wireButtons();
  if (!_wired) window.addEventListener('ss-ready', wireButtons);
}
