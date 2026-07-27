export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export interface CachedCourseFile {
  name: string;
  storageName?: string;
  folder?: string | null;
  uploaded?: boolean;
  uid?: string;
  size?: string;
}

export interface CachedCourseFolder {
  name: string;
  files: CachedCourseFile[];
  expanded?: boolean;
}

export interface CourseEntryCache {
  files: CachedCourseFile[];
  folders: CachedCourseFolder[];
  hydrated: boolean;
  status: ResourceStatus;
  fetchedAt: number | null;
  error: string | null;
  scrollTop: number;
}

export interface CachedSavedItem {
  id: string;
  kind: string;
  title: string;
  courseId: string;
  courseName: string;
  meta: string;
  noteId?: string;
}

interface StudyLibraryCache {
  version: 2;
  userId: string;
  activeTab: 'courses' | 'saved';
  activeCourseId: string | null;
  activeSavedKind: string | null;
  courseScrollTop: number;
  savedScrollTop: number;
  courseEntries: Record<string, CourseEntryCache>;
  savedItems: CachedSavedItem[];
  savedStatus: ResourceStatus;
  savedFetchedAt: number | null;
  savedError: string | null;
}

// v2 deliberately invalidates the first Study cache release, which could
// persist a false empty course when auth/storage hydration had not completed.
const CACHE_PREFIX = 'minallo:study-library:v2:';
const COURSE_TTL = 3 * 60 * 1000;
const SAVED_TTL = 3 * 60 * 1000;
const inFlight = new Map<string, Promise<unknown>>();
let active: StudyLibraryCache | null = null;

function empty(userId: string): StudyLibraryCache {
  return {
    version: 2, userId, activeTab: 'courses', activeCourseId: null,
    activeSavedKind: null, courseScrollTop: 0, savedScrollTop: 0,
    courseEntries: {}, savedItems: [], savedStatus: 'idle', savedFetchedAt: null, savedError: null,
  };
}

export function studyLibraryUserId(): string {
  try {
    return String(window._currentUser?.id || window._currentUser?.sub
      || localStorage.getItem('ss_last_uid') || 'anonymous');
  } catch { return String(window._currentUser?.id || window._currentUser?.sub || 'anonymous'); }
}

export function studyLibraryState(): StudyLibraryCache {
  const userId = studyLibraryUserId();
  if (active?.userId === userId) return active;
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_PREFIX + userId) || 'null') as StudyLibraryCache | null;
    active = parsed?.version === 2 && parsed.userId === userId ? parsed : empty(userId);
  } catch { active = empty(userId); }
  return active;
}

export function persistStudyLibrary(): void {
  const state = studyLibraryState();
  try { localStorage.setItem(CACHE_PREFIX + state.userId, JSON.stringify(state)); } catch { /* cache is best effort */ }
}

export function courseEntry(courseId: string): CourseEntryCache | null {
  return studyLibraryState().courseEntries[courseId] || null;
}

export function setCourseEntry(courseId: string, entry: CourseEntryCache): void {
  studyLibraryState().courseEntries[courseId] = entry;
  persistStudyLibrary();
}

export function isCourseFresh(entry: CourseEntryCache | null): boolean {
  return !!entry?.hydrated && !!entry.fetchedAt && Date.now() - entry.fetchedAt < COURSE_TTL;
}

export function isSavedFresh(): boolean {
  const fetchedAt = studyLibraryState().savedFetchedAt;
  return !!fetchedAt && Date.now() - fetchedAt < SAVED_TTL;
}

export function dedupeStudyRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const scoped = `${studyLibraryUserId()}:${key}`;
  const existing = inFlight.get(scoped);
  if (existing) return existing as Promise<T>;
  const request = load().finally(() => inFlight.delete(scoped));
  inFlight.set(scoped, request);
  return request;
}

export function invalidateCourseEntry(courseId: string): void {
  const entry = courseEntry(courseId);
  if (entry) entry.fetchedAt = null;
  persistStudyLibrary();
}

export function removeCourseEntry(courseId: string): void {
  delete studyLibraryState().courseEntries[courseId];
  if (studyLibraryState().activeCourseId === courseId) studyLibraryState().activeCourseId = null;
  persistStudyLibrary();
}

export function invalidateSaved(): void {
  studyLibraryState().savedFetchedAt = null;
  persistStudyLibrary();
}

export function resetStudyLibraryMemory(): void {
  active = null;
  inFlight.clear();
}
