// Supabase request helpers. Exposed on window._ssDb so the not-yet-migrated
// IIFE feature scripts can still reach them; once those are TS-native too,
// drop the window assignment.
//
// This file is loaded as a plain classic <script> (loader.ts's loadScript()
// calls omit `type: 'module'`), NOT an ES module — it must never contain an
// import/export statement, or the browser throws "Cannot use import
// statement outside a module" and the whole script fails to execute. Any
// auth-refresh-aware helper (authenticatedSupabaseFetch etc.) has to be
// wired from an actual ES module consumer instead (see workspace-library.ts,
// study-tool-workflow.ts), not from here.

function _supaHeaders(): Record<string, string> {
  const token = window._sbToken || '';
  const key = window._SAKEY || '';
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: 'Bearer ' + token,
  };
}

function _supaUrl(): string {
  return (window._SUPA || '').replace(/\/$/, '');
}

function _userId(): string | null {
  try {
    const part = (window._sbToken || '').split('.')[1];
    if (!part) return null;
    const decoded = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(decoded).sub as string | undefined) || null;
  } catch {
    return null;
  }
}

window._ssDb = { supaHeaders: _supaHeaders, supaUrl: _supaUrl, userId: _userId };
