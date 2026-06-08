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
}

export interface DailyMissionResponse {
  hasPlan: boolean;
  plan: { id: string; course_id: string; plan_date: string; generated_reason?: string | null } | null;
  tasks: DailyMissionTask[];
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

export async function generateDailyMission(courseId: string, availableMinutes?: number): Promise<DailyMissionResponse> {
  const res = await fetch('/api/study/daily-plan/generate', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      courseId,
      date: todayLocalDate(),
      timezone: timezone(),
      availableMinutes
    })
  });
  if (!res.ok) throw new Error('Daily Mission could not be generated');
  return res.json() as Promise<DailyMissionResponse>;
}

export async function getDailyMissionSummary(courseId: string): Promise<DailyMissionSummary> {
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
  if (!res.ok) throw new Error('Task update failed');
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
