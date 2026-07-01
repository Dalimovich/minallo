// Shared helper: forward a request to the Python AI service.
//
// Python is now the only AI implementation — the legacy JS pipelines have
// been removed. Every AI/document handler is a thin auth+forward shell
// over this helper. Auth happens in the host function (Supabase JWT);
// this helper just signs the upstream request with INTERNAL_SECRET so the
// Python service knows the call came through our edge.
//
// Uses Web `fetch` so it runs on Workers (Cloudflare Pages Functions) —
// Node's https.request isn't implemented in unenv's nodejs_compat shim.

import { optionalEnv } from './env';
import type { PythonProxyResult } from './types';

// Grounded generation (cheatsheet, structured Deep Learn) runs ~40 tok/s and a
// dense sheet can take 45–55s. 120s default gives comfortable margin for heavy
// grounded generation that can approach ~50s; still overridable per-env via
// AI_UPSTREAM_TIMEOUT_MS (e.g. set lower in staging to fail fast).
const _UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_UPSTREAM_TIMEOUT_MS', '120000'), 10);

function _config(): { serviceUrl: string; internalToken: string } {
  return {
    serviceUrl: optionalEnv('AI_SERVICE_URL', ''),
    internalToken: optionalEnv('INTERNAL_SECRET', '')
  };
}

/** True if the Python service is wired up. If false, the handler should
 *  surface a 503 — there is no JS fallback anymore. */
export function pythonAiConfigured(): boolean {
  const { serviceUrl, internalToken } = _config();
  return Boolean(serviceUrl && internalToken);
}

/** Forwards `payload` to `<AI_SERVICE_URL>/<endpoint>`. `body` is the
 *  parsed JSON response when available, else `{ raw }`. `ok` is true only on 2xx. */
export async function forwardToPython<T = unknown>(
  endpoint: string,
  payload: unknown
): Promise<PythonProxyResult<T>> {
  const { serviceUrl, internalToken } = _config();
  if (!serviceUrl || !internalToken) {
    return { ok: false, status: 503, body: { error: 'AI service not configured' } };
  }
  let targetUrl: string;
  try {
    targetUrl = new URL(serviceUrl.replace(/\/$/, '') + '/' + endpoint).toString();
  } catch {
    return { ok: false, status: 500, body: { error: 'Invalid AI_SERVICE_URL' } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), _UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'X-Internal-Token': internalToken,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    const text = await res.text();
    let parsed: T | { raw: string };
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = { raw: text };
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: parsed
    };
  } catch {
    return { ok: false, status: 502, body: { error: 'Upstream AI service error' } };
  } finally {
    clearTimeout(timer);
  }
}
