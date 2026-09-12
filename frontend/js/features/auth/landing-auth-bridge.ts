import type { AuthBridge } from './auth-bridge.js';

export interface LandingAuthBridgeOptions {
  authBridge: AuthBridge;
}

export function initLandingAuthBridge(options: LandingAuthBridgeOptions): {
  showAuth: (mode?: 'signin' | 'signup') => void;
  showOnboarding: () => void;
  adminShowIfEligible: () => Promise<void>;
} {
  const authBridge = options.authBridge;

  function showOnboarding(): void {
    void import(/* @vite-ignore */ atob('Li9vbmJvYXJkaW5nLmpz')).then((mod) => mod.showOnboarding());
  }

  function adminShowIfEligible(): Promise<void> {
    return import(/* @vite-ignore */ atob('Li4vYWRtaW4vYWRtaW4tcGFuZWwuanM=')).then((mod) =>
      mod.adminShowIfEligible()
    );
  }

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
