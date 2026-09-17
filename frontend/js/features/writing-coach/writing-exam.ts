import { authenticatedFetch } from '../../services/authenticated-fetch.js';
import type { TaskType, WritingAnalysis } from './writing-coach-ai.js';

export interface WritingTopic {
  questionId: string;
  title: string;
  communicativeSituation: string;
  taskInstructions: string;
  writingCoachTaskType: TaskType;
}
export interface WritingTask {
  generationId: string;
  exam: { profileId: string; profileVersion: number; family: string; variant: string; cefrLevel: string };
  part: { id: string };
  content: { questions: WritingTopic[] };
}
export interface WritingGrade {
  analysis: WritingAnalysis;
  rubric: Record<string, number | string | null>;
  scoreValue: number | null;
  maxScoreValue: number;
  examResultItems: Record<string, unknown>[];
}

export async function writingExamRequest<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const base = (window as unknown as { BACKEND_URL?: string }).BACKEND_URL || '';
  const response = await authenticatedFetch(`${base}/api/ai/german-exam/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.detail || `HTTP ${response.status}`);
  return data as T;
}

/** Share the in-flight generation across profile notifications and repeated opens. */
export class WritingExamSession {
  task: WritingTask | null = null;
  private pending: Promise<WritingTask> | null = null;
  constructor(private request = writingExamRequest) {}
  generate(): Promise<WritingTask> {
    if (this.task) return Promise.resolve(this.task);
    if (this.pending) return this.pending;
    this.pending = this.request<WritingTask>('generate', {
      profileId: 'telc_c1_hochschule', module: 'writing', partId: 'schreiben_1', mode: 'adaptive_practice'
    }).then(task => {
      if (task.content?.questions?.length !== 2 || !task.generationId || task.part?.id !== 'schreiben_1') {
        throw new Error('Die Schreibaufgabe ist unvollständig. Bitte erneut versuchen.');
      }
      this.task = task;
      return task;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

export function writingProfileReady(): boolean {
  return window._germanExamProfileId === 'telc_c1_hochschule' ||
    (!window._germanExamProfileId && window._germanTest?.trim().toLowerCase() === 'telc' && window._germanLevel === 'C1 Hochschule');
}
