// Profile-aware German exam structure checks for the edge functions.
//
// The exam structure (modules / parts / task types) is authoritative in Python
// (backend/python-ai/app/services/german_exams/, one file per exam). Edge
// functions must NOT keep flat module/part allowlists — those were TELC-era and
// let a Goethe learner request a TELC-only part. Instead they ask Python for the
// profile manifest once and cache it, then check (profile -> module -> part).
//
// A manifest that cannot be fetched yields 'unverified': callers proceed and
// python-ai's own get_part() validation (which runs before any LLM cost) rejects
// bad requests, so an outage never opens a hole — it only loses the cheap early
// rejection.

import { forwardToPython } from './python-ai-proxy';

export interface ExamManifestPart {
  id: string;
  title: string;
  taskType: string;
  implemented: boolean;
  [key: string]: unknown;
}

export interface ExamManifestModule {
  id: string;
  label: string;
  durationSeconds: number | null;
  preparationSeconds: number | null;
  parts: ExamManifestPart[];
  [key: string]: unknown;
}

export interface ExamManifest {
  schemaVersion: string;
  profileId: string;
  profileVersion: number;
  displayName: string;
  cefrLevel: string | null;
  modules: ExamManifestModule[];
  [key: string]: unknown;
}

export type ExamPartCheck = 'ok' | 'unknown' | 'unverified';
/** 'unavailable' = the part is in the exam's structure but cannot be generated yet (manifest `implemented: false`). */
export type ExamPartAvailability = 'available' | 'unavailable' | 'unverified';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; manifest: ExamManifest }>();

export function clearExamManifestCache(): void {
  cache.clear();
}

export async function fetchExamManifest(profileId: string): Promise<ExamManifest | null> {
  const hit = cache.get(profileId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.manifest;
  const res = await forwardToPython<ExamManifest>('german-exam/manifest', { profileId }, 10000);
  if (!res.ok || !res.body || !Array.isArray((res.body as ExamManifest).modules)) return null;
  const manifest = res.body as ExamManifest;
  if (manifest.profileId !== profileId) return null;
  cache.set(profileId, { at: Date.now(), manifest });
  return manifest;
}

export function manifestFindPart(
  manifest: ExamManifest,
  module: string,
  partId: string
): ExamManifestPart | null {
  const mod = manifest.modules.find((m) => m.id === module);
  return mod?.parts.find((p) => p.id === partId) ?? null;
}

/** 'ok' = the part exists in this profile's module; 'unknown' = it does not (e.g.
 *  sprachbausteine_1 for goethe_c1); 'unverified' = manifest unavailable. */
export async function checkExamPart(
  profileId: string,
  module: string,
  partId: string
): Promise<ExamPartCheck> {
  const manifest = await fetchExamManifest(profileId);
  if (!manifest) return 'unverified';
  return manifestFindPart(manifest, module, partId) ? 'ok' : 'unknown';
}

/**
 * Whether a part that EXISTS in the profile can be generated today. Used only by the generate endpoint to
 * reject an unavailable part before any paid-usage accounting. 'unverified' (manifest unreachable, or the
 * part is unknown) never blocks: python-ai's own validation still runs before any model cost.
 */
export async function checkExamPartAvailability(
  profileId: string,
  module: string,
  partId: string
): Promise<ExamPartAvailability> {
  const manifest = await fetchExamManifest(profileId);
  if (!manifest) return 'unverified';
  const part = manifestFindPart(manifest, module, partId);
  if (!part) return 'unverified';
  return part.implemented === true ? 'available' : 'unavailable';
}

/** 'ok' when the module exists in the profile; same semantics as checkExamPart. */
export async function checkExamModule(profileId: string, module: string): Promise<ExamPartCheck> {
  const manifest = await fetchExamManifest(profileId);
  if (!manifest) return 'unverified';
  return manifest.modules.some((m) => m.id === module) ? 'ok' : 'unknown';
}

/** Slug-shaped identifier check (cheap shape validation before any lookup). */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value);
}
