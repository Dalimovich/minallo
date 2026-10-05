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
 * generation+grading pipeline, not the officially-supported exam flow. */

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
  // A fresh id minted per generate call with no server-held state behind it — a client-visible
  // correlation label only, never a pointer to anything the server remembers. Do not treat it as
  // a security boundary or as proof the server can look grading state up by it; it cannot.
  generationId: string;
  content: DshOpenAnswerContent;
  // AUDITED FACT: this field carries the FULL answer key (requiredPoints[].description,
  // referenceAnswer, errorfulVariant, gradingNotes) that `content` above has had stripped, and it
  // arrived in the browser in this very same response — reading raw network traffic for this
  // call already exposes it, independent of anything below. The only guarantee callers get is
  // that nothing in this codebase ever passes `gradingContent` to mountDshOpenAnswer or otherwise
  // renders it — hold it in a closure (see createDshLvHvGrader) and nowhere else. Do not describe
  // this as "the answer key never reaches the browser"; it does. Fully preventing that needs
  // server-side generation storage, not built in this phase.
  gradingContent: unknown;
}

/** Generates one DSH LV or HV practice task. `topic` is an optional free-text label; omit it to
 * let the backend pick one of DSH's own topic-bank entries. */
export async function generateDshLvHvPracticeTask(
  part: 'lv' | 'hv', topic?: string, request: typeof dshLvHvRequest = dshLvHvRequest, signal?: AbortSignal,
): Promise<DshLvHvGenerateResponse> {
  return request<DshLvHvGenerateResponse>('generate', { part, topic: topic ?? null }, signal);
}

/** Builds the real `grade` callback dsh-open-answer-task.ts's mountDshOpenAnswer expects: holds
 * `gradingContent` in closure (never passed to the renderer, never put in the DOM) and resends it
 * unmodified alongside the learner's answers. */
export function createDshLvHvGrader(
  part: 'lv' | 'hv', generationId: string, gradingContent: unknown, request: typeof dshLvHvRequest = dshLvHvRequest,
): (answers: Record<string, string>, signal: AbortSignal) => Promise<DshGradeResult> {
  return (answers, signal) => request<DshGradeResult>('grade', { part, generationId, gradingContent, answers }, signal);
}
