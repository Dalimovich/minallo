// Reuse the deferred auth entry; retry a failed load on deliberate sign-in.
const deferredScriptsReady = new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else document.addEventListener('DOMContentLoaded', resolve, { once: true });
});
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
export async function openAuth() {
  if (!pending) {
    pending = (async () => {
      // A script element can exist while its request is pending or failed.
      // Wait for deferred scripts, then check their actual initialization.
      await deferredScriptsReady;
      if (typeof window._googleAuth === 'function') return;
      for (const src of [
        '/js/minallo.js?v=2',
        '/js/runtime-config.js',
        '/js/config.js?v=20261015-qa2-cachebust',
        '/js/auth-bootstrap.js?v=15'
      ]) {
        await loadScript(src);
      }
      window.dispatchEvent(new Event('ss-ready'));
    })().catch((error) => {
      pending = null;
      throw error;
    });
  }
  await pending;
  window._googleAuth();
}
