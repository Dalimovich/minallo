/** DSH LV/HV practice generation + raw content grading — the real backend calls behind
 * dsh-open-answer-task.ts's `grade` callback. See that module's own header and
 * german_exam_dsh_grading.py's module docstring for the architecture and the explicit,
 * deliberate boundary: this never returns, and dsh-open-answer-task.ts never renders, an
 * official DSH score, a percentage of any official DSH scale, or a DSH-1/2/3 level.
 *
 * Deliberately NOT /german-exam/generate + /german-exam/results (writingExamRequest's own
 * `generate` path): every DSH PartBlueprint stays available=False, so that path raises/501s for
 * DSH forever by design. These two calls hit the separate, explicitly non-production
 * /german-exam/dsh/lv-hv/{generate,grade} endpoints instead — a sandbox for exercising the
 * generation+grading pipeline, not the officially-supported exam flow.
 *
 * SECURE as of the generationId/gradingContent audit being resolved: there is no `gradingContent`
 * anywhere in this module or in either backend response/request. Generation now writes the full
 * grading-essential content server-side (public.dsh_lv_hv_practice_generations via
 * german_exam_dsh_practice_state.py) and returns only an opaque `generationId`; grading sends
 * that id plus the learner's answers and nothing else — the backend claims its own stored state
 * by id, atomically, enforcing ownership/expiry/one-time-use (see german_exam.py's
 * dsh_lv_hv_grade_endpoint). This module cannot send the answer key even if it wanted to: nothing
 * here ever holds it. userId is intentionally ABSENT from every request body below — exactly
 * like writing-exam.ts's writingExamRequest/createWritingGrader, the authenticated user identity
 * comes from the Cloudflare Function's own verified Supabase session (ai-german-exam-dsh-lv-hv-
 * generate.ts / -grade.ts, following ai-german-exam-grade-writing.ts's pattern) and is injected
 * there before forwarding to Python — a browser-supplied userId would not be trusted anyway. */

import { authenticatedFetch } from '../../services/authenticated-fetch.js';
import type { DshGradeResult, DshOpenAnswerContent } from './dsh-open-answer-task.js';

export async function dshLvHvRequest<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const base = (window as unknown as { BACKEND_URL?: string }).BACKEND_URL || '';
  const response = await authenticatedFetch(`${base}/api/ai/german-exam/dsh/lv-hv/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.detail || `HTTP ${response.status}`);
  return data as T;
}

export interface DshLvHvGenerateResponse {
  part: 'lv' | 'hv';
  // Opaque reference to server-held grading state (public.dsh_lv_hv_practice_generations), owned
  // by the authenticated learner, expiring in 30 minutes, usable for exactly one grade() call.
  // Carries no information on its own — nothing can be decoded or read out of it.
  generationId: string;
  content: DshOpenAnswerContent;
}

/** Generates one DSH LV or HV practice task. `topic` is an optional free-text label; omit it to
 * let the backend pick one of DSH's own topic-bank entries. */
export async function generateDshLvHvPracticeTask(
  part: 'lv' | 'hv', topic?: string, request: typeof dshLvHvRequest = dshLvHvRequest, signal?: AbortSignal,
): Promise<DshLvHvGenerateResponse> {
  return request<DshLvHvGenerateResponse>('generate', { part, topic: topic ?? null }, signal);
}

/** Builds the real `grade` callback dsh-open-answer-task.ts's mountDshOpenAnswer expects. Sends
 * only `generationId` + the learner's answers — the backend looks up its OWN stored content by
 * that id; this function has no grading content to send even if it wanted to. */
export function createDshLvHvGrader(
  part: 'lv' | 'hv', generationId: string, request: typeof dshLvHvRequest = dshLvHvRequest,
): (answers: Record<string, string>, signal: AbortSignal) => Promise<DshGradeResult> {
  return (answers, signal) => {
    const payload = Object.entries(answers).map(([itemId, answer]) => ({ itemId, answer }));
    return request<DshGradeResult>('grade', { part, generationId, answers: payload }, signal);
  };
}
