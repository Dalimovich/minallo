// Load Minallo's existing auth entry only on deliberate sign-in. Its startup
// route cleanup must not erase public marketing fragment links on page load.
let pending;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error('Auth script failed'));
    };
    document.head.append(script);
  });
}
function alreadyLoaded(src) {
  return !!document.querySelector(`script[src="${src}"]`);
}

export async function openAuth() {
  if (!pending) {
    pending = (async () => {
      // The page already loads this same chain deferred in <head>/<body> so
      // the automatic Google One Tap prompt (auth-bootstrap.js's
      // _initOneTap) fires on page load. Only fall back to loading it here
      // if that failed or hasn't finished yet — never reload it, which
      // would re-run _initOneTap and double-register One Tap.
      for (const src of [
        '/js/minallo.js?v=2',
        '/js/runtime-config.js',
        '/js/config.js?v=20261015-qa2-cachebust',
        '/js/auth-bootstrap.js?v=14'
      ]) {
        if (alreadyLoaded(src)) continue;
        await loadScript(src);
      }
      if (typeof window._googleAuth !== 'function') {
        window.dispatchEvent(new Event('ss-ready'));
      }
    })().catch((error) => {
      pending = null;
      throw error;
    });
  }
  await pending;
  window._googleAuth();
}
