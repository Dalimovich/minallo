// Resolves an AI-named course to a real, locally-known course object.
//
// The model only ever names a course in prose (or names none at all) — it
// never supplies a course id, and it must never be trusted to. Resolution
// here matches purely against window.SEMS/_SEMS, the same authoritative
// account/course registry already used elsewhere (mirrors the backend's
// workspace_context.match_course_in_text and the course traversal in
// pdf-viewer/source-link.ts's _allCourses). The LLM is never the source of
// truth for which course id an action button targets.

import type { LegacyCourse } from '../../../globals.js';

export type ResolvableCourse = LegacyCourse;

export function allKnownCourses(): ResolvableCourse[] {
  const out: ResolvableCourse[] = [];
  const seen = new Set<string>();
  const sems = window.SEMS || window._SEMS;
  if (sems) {
    Object.values(sems).forEach((sem) =>
      (sem.courses || []).forEach((c) => {
        const id = String(c?.id || '');
        if (c && id && !seen.has(id)) {
          seen.add(id);
          out.push(c);
        }
      })
    );
  }
  return out;
}

export function resolveCourseById(courseId: string): ResolvableCourse | null {
  const want = (courseId || '').trim();
  if (!want) return null;
  return allKnownCourses().find((c) => String(c.id || '') === want) || null;
}

// Longest match wins ("Technische Mechanik 2" beats a sibling "Technische
// Mechanik"); word-boundary safe so "TM2" never matches inside "atm2x".
// Mirrors backend workspace_context.match_course_in_text's semantics.
export function resolveCourseByNameInText(text: string): ResolvableCourse | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().split(/\s+/).join(' ')} `;
  let best: ResolvableCourse | null = null;
  let bestLen = 0;
  for (const c of allKnownCourses()) {
    for (const key of ['name', 'short'] as const) {
      const v = String(c[key] || '').toLowerCase().split(/\s+/).join(' ').trim();
      if (v.length < 3 || v.length <= bestLen) continue;
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(t)) {
        best = c;
        bestLen = v.length;
      }
    }
  }
  return best;
}
