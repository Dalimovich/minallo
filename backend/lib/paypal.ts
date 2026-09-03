// PayPal API helpers. Uses Web `fetch` so they run on Workers (Cloudflare
// Pages Functions) — unenv's https.request shim throws "not implemented".

import { requireEnv, optionalEnv } from './env';

const PAYPAL_API_BASE = optionalEnv('PAYPAL_API_BASE', 'https://api-m.paypal.com');

interface OauthTokenResponse {
  access_token?: string;
}

async function _parseJsonOrText<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function paypalRequest<T>(
  method: string,
  path: string,
  accessToken: string,
  body?: string | object
): Promise<{ status: number; body: T | null }> {
  const url = PAYPAL_API_BASE + path;
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: bodyStr
  });
  return { status: res.status, body: await _parseJsonOrText<T>(res) };
}

export async function paypalOauthToken(): Promise<string> {
  const clientId = requireEnv('PAYPAL_CLIENT_ID');
  const secret = requireEnv('PAYPAL_CLIENT_SECRET');
  const res = await fetch(PAYPAL_API_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(clientId + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (res.status < 200 || res.status >= 300) throw new Error('paypal oauth failed');
  const parsed = (await res.json().catch(() => ({}))) as OauthTokenResponse;
  if (!parsed.access_token) throw new Error('paypal oauth failed');
  return parsed.access_token;
}
