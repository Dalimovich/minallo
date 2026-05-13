import { initAuthModal } from './auth-modal.js';
import {
  startPresenceHeartbeat,
  loadUserData,
  applyProfile,
  applyUserTypeUI,
} from './user-data.js';

export interface AuthBridgeOptions {
  sb: unknown;
  t: (key: string) => string;
  getCurrentUser: () => { id?: string; email?: string } | null;
  verifyAndEnter: (token: string) => Promise<void> | void;
  enterApp: (user: unknown) => void;
  resetActivityTimer: () => void;
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
    sb: options.sb,
    t: options.t,
    getCurrentUser: options.getCurrentUser,
    verifyAndEnter: options.verifyAndEnter,
    enterApp: options.enterApp,
    resetActivityTimer: options.resetActivityTimer,
  });

  function setAuthMode(mode: 'signin' | 'signup'): void {
    authModal.setAuthMode(mode);
  }
  function updateAuthIndicator(user: unknown): void {
    authModal.updateAuthIndicator(user);
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
