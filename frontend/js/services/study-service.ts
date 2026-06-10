export interface DailyMissionTask {
  id: string;
  title: string;
  description?: string | null;
  task_type: string;
  priority_group: 'must_do' | 'should_do' | 'optional';
  status: 'todo' | 'in_progress' | 'completed' | 'skipped' | 'moved' | 'unavailable' | 'replaced';
  estimated_minutes: number;
  page_start?: number | null;
  page_end?: number | null;
  reason?: string | null;
  reason_code?: string | null;
  source_file_id?: string | null;
  source_file_name?: string | null;
  exercise_file_id?: string | null;
  exercise_file_name?: string | null;
  page_range?: string | null;
}

export interface PossibleMatch {
  courseId: string;
  exerciseFileId: string;
  exerciseFileName: string;
  possibleLectureFileId: string;
  possibleLectureFileName: string;
  confidence: 'medium' | 'low';
  reason: string;
}

export interface DailyMissionResponse {
  hasPlan: boolean;
  planId?: string | null;
  plan: { id: string; course_id: string; plan_date: string; generated_reason?: string | null } | null;
  tasks: DailyMissionTask[];
  possibleMatches?: PossibleMatch[];
  summary: {
    completedTasks: number;
    totalTasks: number;
    minutesRemaining: number;
    status: string;
    noValidCandidates?: boolean;
  };
}

export interface DailyMissionSummary {
  hasPlan: boolean;
  courseId: string;
  planDate: string;
  completedTasks: number;
  totalTasks: number;
  minutesRemaining: number;
  mainFocus: string | null;
  status: string;
  noValidCandidates?: boolean;
  hasUnavailableSources?: boolean;
}

function authHeaders(): HeadersInit {
  const token = (window as unknown as { _sbToken?: string })._sbToken || '';
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token
  };
}

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

export async function getDailyMission(courseId: string): Promise<DailyMissionResponse> {
  const qs = new URLSearchParams({ courseId, date: todayLocalDate(), timezone: timezone() });
  const res = await fetch('/api/study/daily-plan?' + qs.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error('Daily Mission could not be loaded');
  return res.json() as Promise<DailyMissionResponse>;
}

export async function generateDailyMission(courseId: string, availableMinutes?: number, regenerate?: boolean): Promise<DailyMissionResponse> {
  const res = await fetch('/api/study/daily-plan/generate', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      courseId,
      date: todayLocalDate(),
      timezone: timezone(),
      availableMinutes,
      regenerate: !!regenerate
    })
  });
  if (!res.ok) {
    try {
      const errBody = await res.json() as { message?: string };
      throw new Error(errBody.message || 'Daily Mission could not be generated');
    } catch {
      throw new Error('Daily Mission could not be generated (HTTP ' + res.status + ')');
    }
  }
  return res.json() as Promise<DailyMissionResponse>;
}

export async function regenerateDailyMission(courseId: string, availableMinutes?: number): Promise<DailyMissionResponse> {
  return generateDailyMission(courseId, availableMinutes, true);
}

export async function getDailyMissionSummary(courseId: string): Promise<DailyMissionSummary> {
  // Wait for auth token to be available
  const token = (window as unknown as { _sbToken?: string })._sbToken;
  if (!token) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const checkToken = () => {
        const t = (window as unknown as { _sbToken?: string })._sbToken;
        if (t) {
          getDailyMissionSummary(courseId).then(resolve).catch(reject);
        } else if (attempts++ < 10) {
          setTimeout(checkToken, 100);
        } else {
          reject(new Error('Auth token not available'));
        }
      };
      checkToken();
    });
  }

  const qs = new URLSearchParams({ courseId, date: todayLocalDate(), timezone: timezone() });
  const res = await fetch('/api/study/daily-plan/summary?' + qs.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error('Daily Mission summary could not be loaded');
  return res.json() as Promise<DailyMissionSummary>;
}

export async function updateDailyMissionTask(taskId: string, status: DailyMissionTask['status']): Promise<void> {
  const res = await fetch('/api/study/tasks/' + encodeURIComponent(taskId), {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ status })
  });
  if (!res.ok) {
    try {
      const errBody = await res.json() as { message?: string };
      throw new Error(errBody.message || 'Task update failed (HTTP ' + res.status + ')');
    } catch {
      throw new Error('Task update failed (HTTP ' + res.status + ')');
    }
  }
}

/** Document ids the user has marked as already studied for a course. */
export async function getDoneFiles(courseId: string): Promise<string[]> {
  const qs = new URLSearchParams({ courseId });
  const res = await fetch('/api/study/done-files?' + qs.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not load completed files');
  const data = await res.json() as { documentIds?: string[] };
  return Array.isArray(data.documentIds) ? data.documentIds : [];
}

/** Replace the set of "already studied" files for a course. Newly-marked files
 *  have their covered topics flipped to 'studied' so the planner treats them as
 *  known material (spaced repetition) rather than new lectures. */
export async function saveDoneFiles(courseId: string, documentIds: string[]): Promise<string[]> {
  const res = await fetch('/api/study/done-files', {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ courseId, documentIds })
  });
  if (!res.ok) throw new Error('Could not save completed files (HTTP ' + res.status + ')');
  const data = await res.json() as { documentIds?: string[] };
  return Array.isArray(data.documentIds) ? data.documentIds : documentIds;
}

export function findPrimaryCourseId(): string | null {
  const w = window as unknown as {
    activeCourseId?: string | null;
    activeCourseRef?: { id?: string } | null;
    sdActiveSemId?: string;
    SEMS?: Record<string, { courses?: Array<{ id?: string }> }>;
  };
  if (w.activeCourseRef?.id) return w.activeCourseRef.id;
  if (w.activeCourseId) return w.activeCourseId;
  const sem = w.SEMS?.[w.sdActiveSemId || ''];
  const first = sem?.courses?.find((c) => c.id);
  return first?.id || null;
}

export async function confirmPossibleMatch(
  planId: string,
  exerciseFileId: string,
  possibleLectureFileId: string,
  action: 'confirm' | 'dismiss',
  planDate?: string
): Promise<{ ok: boolean; remaining: number }> {
  const res = await fetch('/api/study/possible-match', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ planId, exerciseFileId, possibleLectureFileId, action, planDate }),
  });
  if (!res.ok) {
    try {
      const errBody = await res.json() as { message?: string };
      throw new Error(errBody.message || 'Possible match action failed (HTTP ' + res.status + ')');
    } catch {
      throw new Error('Possible match action failed (HTTP ' + res.status + ')');
    }
  }
  return res.json() as Promise<{ ok: boolean; remaining: number }>;
}
