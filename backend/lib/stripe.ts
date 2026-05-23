// Stripe API helpers. Uses STRIPE_SECRET_KEY from env.
//
// Uses Web `fetch` so this runs on Workers (Cloudflare Pages Functions) —
// unenv's https.request shim throws "not implemented".

import { requireEnv } from './env';
import type { SupaResult } from './types';

async function _parseJsonOrText<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return null as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function stripePost<T = unknown>(
  path: string,
  params: URLSearchParams
): Promise<SupaResult<T>> {
  const secretKey = requireEnv('STRIPE_SECRET_KEY');
  const res = await fetch('https://api.stripe.com' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(secretKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  return { status: res.status, body: await _parseJsonOrText<T>(res) };
}

export async function stripeGet<T = unknown>(path: string): Promise<SupaResult<T>> {
  const secretKey = requireEnv('STRIPE_SECRET_KEY');
  const res = await fetch('https://api.stripe.com' + path, {
    method: 'GET',
    headers: {
      Authorization: 'Basic ' + btoa(secretKey + ':')
    }
  });
  return { status: res.status, body: await _parseJsonOrText<T>(res) };
}
