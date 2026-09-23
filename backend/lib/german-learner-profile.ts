// Server-side German learner profile for Cloudflare/TS endpoints.
//
// profiles.german_test + profiles.german_level are the source of truth; this
// helper reads them with the service role, keyed by the JWT-verified user id.
// Endpoints must use THIS instead of trusting a client-supplied level or
// exam-profile id (a stale tab or cached value would otherwise win).
//
// Mirrors backend/python-ai/app/services/german_learner_profile.py and
// german_exam_profiles.py; tests/backend/german-learner-profile.test.mjs keeps
// the registries in sync.

import { supaRequest } from './supabase-admin';

export interface GermanLearnerProfile {
  userType: string;
  testFamily: string;
  targetLevel: string;
  // null is NOT an error: no exam-specific blueprint exists for this pair.
  examProfileId: string | null;
}

interface ProfileRow {
  user_type?: string | null;
  german_test?: string | null;
  german_level?: string | null;
}

// Exam profiles with a generated blueprint. Same shape as the Python registry
// (family + exact legacy level values).
const EXAM_PROFILE_REGISTRY: ReadonlyArray<{ profileId: string; family: string; levels: readonly string[] }> = [
  { profileId: 'telc_c1_hochschule', family: 'telc', levels: ['C1 Hochschule'] },
  { profileId: 'goethe_c1', family: 'Goethe', levels: ['C1'] },
  { profileId: 'testdaf_digital', family: 'TestDaF', levels: [] }
];

export function isRegisteredExamProfileId(profileId: unknown): profileId is string {
  return typeof profileId === 'string' && EXAM_PROFILE_REGISTRY.some((p) => p.profileId === profileId);
}

export function resolveGermanExamProfileId(
  family: string | null | undefined,
  level: string | null | undefined
): string | null {
  const fam = (family || '').trim().toLowerCase();
  const lvl = (level || '').trim();
  if (!fam || !lvl) return null;
  const matches = EXAM_PROFILE_REGISTRY.filter((p) => p.family.toLowerCase() === fam && p.levels.includes(lvl));
  return matches.length === 1 ? matches[0]?.profileId ?? null : null;
}

export function unsupportedExamProfileMessage(profile: GermanLearnerProfile): string {
  const label = [profile.testFamily, profile.targetLevel].filter(Boolean).join(' ');
  return label
    ? `Exam-format practice for ${label} is not available yet.`
    : 'Choose your exam and target level in Profile to unlock exam-format practice.';
}

/** The authenticated user's saved German profile, or null when it could not be
 *  read (callers must treat null as "unknown" — never invent a level). */
export async function getGermanLearnerProfile(
  serviceKey: string,
  userId: string
): Promise<GermanLearnerProfile | null> {
  if (!userId) return null;
  const res = await supaRequest<ProfileRow[]>(
    'GET',
    'profiles?id=eq.' + encodeURIComponent(userId) + '&select=user_type,german_test,german_level&limit=1',
    null,
    serviceKey
  );
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body)) return null;
  const row = res.body[0];
  if (!row) return null;
  const testFamily = (row.german_test || '').trim();
  const targetLevel = (row.german_level || '').trim();
  return {
    userType: (row.user_type || '').trim() || 'enrolled',
    testFamily,
    targetLevel,
    examProfileId: resolveGermanExamProfileId(testFamily, targetLevel)
  };
}
