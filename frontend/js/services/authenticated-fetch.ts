export interface AuthRefreshResult {
  accessToken: string | null;
  recoverable: boolean;
}

export interface AuthRequestDependencies {
  getAccessToken: () => string | null;
  refreshSession: () => Promise<AuthRefreshResult>;
  now?: () => number;
}

export interface AuthenticatedFetchOptions {
  safeToRetry?: boolean;
  retryAuthFailure?: boolean;
}

const EXPIRY_SKEW_MS = 90_000;
let refreshInFlight: Promise<AuthRefreshResult> | null = null;

function tokenExpiryMs(token: string | null): number {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function tokenNeedsRefresh(token: string | null, now = Date.now()): boolean {
  const expiry = tokenExpiryMs(token);
  return !token || !expiry || expiry <= now + EXPIRY_SKEW_MS;
}

export function coordinatedRefresh(
  refresh: () => Promise<AuthRefreshResult>,
): Promise<AuthRefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function authenticatedFetchWith(
  deps: AuthRequestDependencies,
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: AuthenticatedFetchOptions = {},
): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  let token = deps.getAccessToken();
  if (tokenNeedsRefresh(token, now)) {
    const refreshed = await coordinatedRefresh(deps.refreshSession);
    token = refreshed.accessToken || deps.getAccessToken();
    if (!token && !refreshed.recoverable) {
      throw new Error('SESSION_INVALID');
    }
    if (!token) throw new Error('SESSION_REFRESH_NETWORK_ERROR');
  }

  const send = (bearer: string): Promise<Response> => {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${bearer}`);
    return fetch(input, { ...init, headers });
  };

  let response = await send(token as string);
  const canRetry = options.safeToRetry === true || !init.method || /^(GET|HEAD)$/i.test(init.method);
  if (response.status !== 401 || options.retryAuthFailure === false || !canRetry) {
    return response;
  }

  const refreshed = await coordinatedRefresh(deps.refreshSession);
  const newToken = refreshed.accessToken || deps.getAccessToken();
  if (!newToken) return response;
  response = await send(newToken);
  return response;
}

async function browserRefresh(): Promise<AuthRefreshResult> {
  const auth = (window as unknown as {
    _sb?: { auth?: { refreshSession?: () => Promise<unknown> } };
  })._sb?.auth;
  if (!auth?.refreshSession) {
    return { accessToken: null, recoverable: false };
  }
  try {
    const tokenBefore = window._sbToken || null;
    const refresh = async (): Promise<void> => {
      // Another tab may have refreshed while this tab was waiting for the
      // origin-wide lock. Re-read the shared token before rotating again.
      if (!tokenNeedsRefresh(window._sbToken || null)) return;
      await auth.refreshSession!();
    };
    const locks = (navigator as Navigator & {
      locks?: { request: (name: string, callback: () => Promise<void>) => Promise<void> };
    }).locks;
    if (locks) await locks.request('minallo-session-refresh', refresh);
    else await refresh();
    const accessToken = window._sbToken || null;
    if (accessToken === tokenBefore && tokenNeedsRefresh(accessToken)) {
      return { accessToken: null, recoverable: true };
    }
    return { accessToken, recoverable: !!accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    const unrecoverable = /invalid.?refresh|refresh.?token.*(?:revoked|expired)|signed.?out/i.test(message);
    return { accessToken: null, recoverable: !unrecoverable };
  }
}

export function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: AuthenticatedFetchOptions = {},
): Promise<Response> {
  return authenticatedFetchWith(
    {
      getAccessToken: () => window._sbToken || null,
      refreshSession: browserRefresh,
    },
    input,
    init,
    options,
  );
}

export function resetAuthRefreshForTests(): void {
  refreshInFlight = null;
}
