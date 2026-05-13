import { adminShowIfEligible } from '../admin/admin-panel.js';
import { showOnboarding } from './onboarding.js';
import type { AuthBridge } from './auth-bridge.js';

export interface LandingAuthBridgeOptions {
  authBridge: AuthBridge;
}

export function initLandingAuthBridge(options: LandingAuthBridgeOptions): {
  showAuth: (mode?: 'signin' | 'signup') => void;
  showOnboarding: typeof showOnboarding;
  adminShowIfEligible: typeof adminShowIfEligible;
} {
  const authBridge = options.authBridge;

  function showAuth(mode?: 'signin' | 'signup'): void {
    if (authBridge && typeof authBridge.showAuthModal === 'function') {
      authBridge.showAuthModal(mode);
    }
  }

  window._adminShowIfEligible = adminShowIfEligible;
  window._showOnboarding = showOnboarding;
  window.landShowAuth = showAuth;

  return {
    showAuth,
    showOnboarding,
    adminShowIfEligible,
  };
}
