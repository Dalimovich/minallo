// Verifies a Supabase user JWT against the Supabase Auth API.
// Returns the user object on success, or null on failure.
//
// Uses Web `fetch` instead of Node's `https.request` so this module runs
// unchanged on both Netlify (Node) and Cloudflare Pages (Workers, where
// unenv's https shim throws "https.request is not implemented yet").

import { requireEnv } from './env';
import type { HttpHeaders, SupabaseUser } from './types';

export async function verifySupabaseToken(token: string): Promise<SupabaseUser | null> {
  try {
    const supaUrl = requireEnv('SUPABASE_URL');
    const anonKey = requireEnv('SUPABASE_ANON_KEY');
    const res = await fetch(supaUrl.replace(/\/$/, '') + '/auth/v1/user', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: anonKey
      }
    });
    if (res.status !== 200) return null;
    const user = (await res.json()) as SupabaseUser;
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Extract Bearer token from Authorization header. Returns null if missing.
export function extractBearerToken(headers: HttpHeaders | undefined): string | null {
  const authHeader = (headers && (headers['authorization'] || headers['Authorization'])) || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}
