// Suppress noisy warnings from third-party libs (pdf.js mainly) AND silence
// dev-debug console.log spam in production. Users hit F12 and saw a wall of
// [Auth] / Supabase / loader status lines that don't help them but reveal
// implementation details. Set localStorage.MINALLO_DEBUG = '1' to re-enable
// all dev logs when actually debugging.

export function initConsoleFilter(): void {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const supThirdParty = ['fake worker', 'TT:', 'undefined function', 'scale-factor'];

  // Dev-only console.log prefixes — silenced unless MINALLO_DEBUG is on.
  // Keep this list tight: only the predictable boot/auth status spam.
  // Anything urgent should be console.warn / console.error, which still ship.
  const supDevLogPrefixes = [
    'Supabase REST client',
    'Supabase reachable',
    'app.js + modules loaded',
    'js/ai.js loaded',
    '✓ js/ai.js loaded',
    '✓ New landing page',
    '[Auth]',
    '[router]',
    '[loadUserData]',
    '[loader]',
    '[storage]',
    '[restore]',
    '[watchdog]',
  ];

  let debugMode = false;
  try {
    debugMode = localStorage.getItem('MINALLO_DEBUG') === '1';
  } catch { /* localStorage disabled */ }

  function shouldSuppressThirdParty(args: IArguments | unknown[]): boolean {
    const m = Array.prototype.join.call(args, ' ');
    return supThirdParty.some((s) => m.indexOf(s) !== -1);
  }
  function shouldSuppressDevLog(args: IArguments | unknown[]): boolean {
    if (debugMode) return false;
    const first = args && (args as unknown[])[0];
    if (typeof first !== 'string') return false;
    return supDevLogPrefixes.some((p) => first.indexOf(p) === 0 || first.indexOf(' ' + p) > -1);
  }

  console.log = function (...args: unknown[]): void {
    if (shouldSuppressDevLog(args)) return;
    origLog(...args);
  };
  console.warn = function (...args: unknown[]): void {
    if (shouldSuppressThirdParty(args)) return;
    // Warns also include [loadUserData] timeouts and [router] queue warnings —
    // suppress those in production too so the console is clean.
    if (shouldSuppressDevLog(args)) return;
    origWarn(...args);
  };
  console.error = function (...args: unknown[]): void {
    if (shouldSuppressThirdParty(args)) return;
    origError(...args);
  };
}
