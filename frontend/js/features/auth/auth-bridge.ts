import { initAuthModal } from './auth-modal.js';
import {
  startPresenceHeartbeat,
  loadUserData,
  applyProfile,
  applyUserTypeUI,
  beginProfileResolution,
  resetProfileResolution,
  ensureUserProfile,
  applySavedProfile,
} from './user-data.js';
import {
  GERMAN_TEST_LEVELS,
  getGermanLearnerProfile,
  germanLevelOptionsHtml,
  isValidGermanTestLevel,
  populateGermanLevelSelect,
  resolveGermanExamProfileIdClient,
} from './german-profile.js';

export interface AuthBridgeOptions {
  sb: SbClientCompat | null;
  t: (key: string) => string;
  getCurrentUser: () => { id?: string; email?: string } | null;
  verifyAndEnter: (token: string) => Promise<void> | void;
  enterApp: (user: unknown) => void;
  resetActivityTimer: () => void;
}

// Re-declared structural type so auth-bridge doesn't have to import auth-modal's
// internal shape. Kept narrow on purpose — anything matching this works.
interface SbClientCompat {
  auth: {
    signUp: (email: string, password: string, redirect?: string) => Promise<unknown>;
    signIn: (email: string, password: string) => Promise<unknown>;
    signOut: () => Promise<unknown>;
    onAuthStateChange?: (cb: (event: string, data: unknown) => void) => unknown;
  };
}

export interface AuthBridge {
  showAuthModal: (mode?: 'signin' | 'signup') => void;
  getAuthMode: () => string;
  setAuthMode: (mode: 'signin' | 'signup') => void;
  updateAuthIndicator: (user: unknown) => void;
  handleAuthClick: () => void;
  startPresenceHeartbeat: typeof startPresenceHeartbeat;
  loadUserData: typeof loadUserData;
  applyProfile: typeof applyProfile;
  applyUserTypeUI: () => void;
}

export function initAuthBridge(options: AuthBridgeOptions): AuthBridge {
  const authModal = initAuthModal({
    sb: options.sb as Parameters<typeof initAuthModal>[0]['sb'],
    t: options.t,
    getCurrentUser: options.getCurrentUser,
    verifyAndEnter: options.verifyAndEnter,
    enterApp: options.enterApp,
    resetActivityTimer: options.resetActivityTimer,
  });

  function setAuthMode(mode: 'signin' | 'signup'): void {
    authModal.setAuthMode(mode);
  }
  // The sidebar (#authName/#authAvatar) lives in portal.html, which the loader
  // injects asynchronously. On a slow reload _enterApp can run BEFORE that
  // markup exists; the update then silently no-oped and nothing retried, so
  // the panel showed "Loading…" until the next login. Remember the latest
  // user and re-apply once the elements appear (bounded retry, latest wins).
  let _lastIndicatorUser: unknown = null;
  let _indicatorAttempt = 0;
  function _applyIndicator(): void {
    if (_lastIndicatorUser === null) return;
    if (!document.getElementById('authName')) {
      if (_indicatorAttempt < 60) {
        _indicatorAttempt += 1;
        window.setTimeout(_applyIndicator, 350);
      }
      return;
    }
    _indicatorAttempt = 0;
    authModal.updateAuthIndicator(_lastIndicatorUser);
  }
  function updateAuthIndicator(user: unknown): void {
    _lastIndicatorUser = user;
    _indicatorAttempt = 0;
    _applyIndicator();
  }
  function handleAuthClick(): void {
    authModal.handleAuthClick();
  }
  function applyUserTypeUiBridge(): void {
    applyUserTypeUI();
  }

  window._setAuthMode = setAuthMode;
  Object.defineProperty(window, '_authMode', {
    configurable: true,
    get(): string {
      return authModal.getAuthMode();
    },
  });
  window.updateAuthIndicator = updateAuthIndicator;
  window.loadUserData = loadUserData;
  window.applyProfile = applyProfile;
  window._applyUserTypeUI = applyUserTypeUiBridge;
  window._beginProfileResolution = beginProfileResolution;
  window._resetProfileResolution = resetProfileResolution;
  window._ensureUserProfile = ensureUserProfile;
  window._resolveGermanExamProfileId = resolveGermanExamProfileIdClient;
  window._applySavedProfile = applySavedProfile;
  // Single German-profile contract for classic-script views (profile, practice).
  window.getGermanLearnerProfile = getGermanLearnerProfile;
  window.germanLevelOptionsHtml = germanLevelOptionsHtml;
  window.isValidGermanTestLevel = isValidGermanTestLevel;
  window.populateGermanLevelSelect = populateGermanLevelSelect;
  window.GERMAN_TEST_LEVELS = GERMAN_TEST_LEVELS;

  window.MinalloBoot?.mark('authBridgeReady');
  // Self-heal: if a session was restored before this bridge existed (any
  // future loader-order regression), start profile resolution now. Shares the
  // single in-flight promise, so it can never double-fetch.
  const restoredUser = window._currentUser;
  if (restoredUser?.id && window._profileResolutionState !== 'ready') {
    beginProfileResolution(restoredUser.id);
    void ensureUserProfile();
  }

  return {
    showAuthModal: (mode) => authModal.showAuthModal(mode),
    getAuthMode: () => authModal.getAuthMode(),
    setAuthMode,
    updateAuthIndicator,
    handleAuthClick,
    startPresenceHeartbeat,
    loadUserData,
    applyProfile,
    applyUserTypeUI: applyUserTypeUiBridge,
  };
}
