// Shared helper to invoke the background processing function.
//
// Resolution order for the target URL:
//   1. PROCESS_FUNCTION_URL env (explicit override; e.g. for staging)
//   2. URL or DEPLOY_URL (Netlify auto-injects the live site URL) +
//      "/.netlify/functions/documents-process-background"
//
// Background functions on Netlify need the "-background" suffix and run up to
// 15 minutes — the regular sync functions cap at 10 seconds, which is not
// enough for PDF extract + OpenAI embedding for a real course document.
//
// Fire-and-forget: we resolve as soon as the request is *sent*, not when the
// response arrives, otherwise Netlify kills the caller's socket on exit.

const https = require('https');
const { optionalEnv } = require('./env');

function resolveProcessUrl() {
  const explicit = optionalEnv('PROCESS_FUNCTION_URL', '');
  if (explicit) return explicit;
  const siteUrl = optionalEnv('URL', '') || optionalEnv('DEPLOY_URL', '');
  if (!siteUrl) return '';
  return siteUrl.replace(/\/$/, '') + '/.netlify/functions/documents-process-background';
}

function triggerProcessing(documentId, userId) {
  const processUrl = resolveProcessUrl();
  console.log('[trigger-processing] resolved URL:', processUrl || '(none)', 'doc=', documentId);
  if (!processUrl) {
    console.warn('[trigger-processing] no URL — set PROCESS_FUNCTION_URL or rely on Netlify URL env');
    return Promise.resolve({ triggered: false, reason: 'no_url' });
  }
  const body = JSON.stringify({ documentId, userId });
  return new Promise(function (resolve) {
    try {
      const url = new URL(processUrl);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-internal-secret': optionalEnv('INTERNAL_SECRET', '')
          }
        },
        function (res) {
          console.log('[trigger-processing] response status:', res.statusCode, 'doc=', documentId);
          resolve({ triggered: true, status: res.statusCode });
        }
      );
      req.on('error', function (err) {
        console.error('[trigger-processing] network error:', err && err.message, 'doc=', documentId);
        resolve({ triggered: false, reason: 'network', error: err && err.message });
      });
      req.write(body);
      req.end();
      setTimeout(function () {
        resolve({ triggered: true, status: 'timeout-resolved' });
      }, 5000);
    } catch (e) {
      console.error('[trigger-processing] exception:', e && e.message, 'doc=', documentId);
      resolve({ triggered: false, reason: 'exception', error: e && e.message });
    }
  });
}

module.exports = { triggerProcessing, resolveProcessUrl };
