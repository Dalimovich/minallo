/** Reusable "click the wrong sentences" interaction (TestDaF Lesen 7,
 * reading_summary_error_detection): a text/graphic source grounds a summary of several
 * sentences; exactly itemCount of them are toggled on as content-wise wrong. Distinct from
 * media-task.ts's error_selection (that one is built around an <audio>/<video> element and a
 * speaker-segment transcript — this task has no media at all, just a reading source) and from
 * productive-task.ts (this is objectively keyed, graded client-side, never AI-graded). Reuses
 * renderGraphic from productive-task.ts for the data-graphic source rather than a second table
 * renderer. */
import { renderGraphic, type Graphic } from './productive-task.js';

export interface SummaryErrorSource { id: string; kind: 'text' | 'graphic'; text?: string; graphic?: Graphic }
export interface SummaryErrorQuestion { questionId: string; text: string; skillTags: string[] }
export interface SummaryErrorContent { sources: SummaryErrorSource[]; questions: SummaryErrorQuestion[]; correctIds: string[] }
export interface SummaryErrorPart { constraints: { itemCount: number; requiredSourceKinds?: string[] } }

function nonempty(v: unknown): v is string { return typeof v === 'string' && !!v.trim(); }

export function validateSummaryError(part: SummaryErrorPart, content: SummaryErrorContent): void {
  const sources = content?.sources;
  if (!Array.isArray(sources) || !sources.length) throw new Error('Missing sources');
  for (const s of sources) {
    if (!s || !nonempty(s.id) || (s.kind !== 'text' && s.kind !== 'graphic')) throw new Error('Invalid source');
    if (s.kind === 'text' && !nonempty(s.text)) throw new Error('Invalid text source');
  }
  const required = part.constraints.requiredSourceKinds || [];
  const kinds = new Set<string>(sources.map(s => s.kind));
  if (required.some(k => !kinds.has(k))) throw new Error('Missing required source');

  const questions = content.questions;
  if (!Array.isArray(questions) || questions.length <= part.constraints.itemCount) throw new Error('Not enough summary sentences');
  if (questions.some(q => !q || !nonempty(q.questionId) || !nonempty(q.text))) throw new Error('Malformed sentence');
  const ids = questions.map(q => q.questionId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate sentence id');

  const correct = content.correctIds;
  if (!Array.isArray(correct) || correct.length !== part.constraints.itemCount ||
      new Set(correct).size !== correct.length || correct.some(id => !ids.includes(id))) {
    throw new Error('Invalid correctIds');
  }
}

export function gradeSummaryError(content: SummaryErrorContent, selected: ReadonlySet<string>): { correct: number; total: number } {
  const correct = [...selected].filter(id => content.correctIds.includes(id)).length;
  return { correct, total: content.correctIds.length };
}

export function mountSummaryError(root: HTMLElement, part: SummaryErrorPart, content: SummaryErrorContent): () => void {
  root.replaceChildren();
  validateSummaryError(part, content);
  const controller = new AbortController();
  const selected = new Set<string>();
  let submitted = false;

  const sourceSection = document.createElement('section');
  for (const s of content.sources) {
    if (s.kind === 'text') { const p = document.createElement('p'); p.textContent = s.text || ''; sourceSection.append(p); }
    else if (s.graphic) renderGraphic(sourceSection, s.graphic);
  }

  const status = document.createElement('p'); status.setAttribute('role', 'status');
  status.textContent = `Select exactly ${part.constraints.itemCount} sentences that are factually wrong.`;
  const summary = document.createElement('div');
  const buttons = new Map<string, HTMLButtonElement>();
  for (const q of content.questions) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = q.text;
    btn.dataset.questionId = q.questionId; btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      if (submitted) return;
      if (selected.has(q.questionId)) {
        selected.delete(q.questionId); btn.setAttribute('aria-pressed', 'false');
      } else if (selected.size >= part.constraints.itemCount) {
        status.textContent = `You can only mark ${part.constraints.itemCount} sentences — unmark one first.`;
      } else {
        selected.add(q.questionId); btn.setAttribute('aria-pressed', 'true');
      }
    }, { signal: controller.signal });
    buttons.set(q.questionId, btn);
    summary.append(btn);
  }

  const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = 'Submit';
  submit.addEventListener('click', () => {
    if (submitted) return;
    const result = gradeSummaryError(content, selected);
    submitted = true; submit.disabled = true;
    for (const [id, btn] of buttons) { btn.disabled = true; if (content.correctIds.includes(id)) btn.dataset.correct = 'true'; }
    status.textContent = `${result.correct} / ${result.total} correct (practice)`;
  }, { signal: controller.signal });

  root.append(sourceSection, summary, submit, status);
  return () => { controller.abort(); root.replaceChildren(); };
}
