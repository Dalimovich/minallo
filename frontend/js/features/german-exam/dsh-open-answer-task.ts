/** DSH HV (Hörverstehen) / LV (Leseverstehen) — open-answer, content-graded tasks.
 *
 * Deliberately NOT routed through media-task.ts or productive-task.ts: DSH's content shape
 * (content.tasks[].items[] with per-item requiredPoints/optionalPoints content points) is
 * structurally different from both — media-task.ts's MEDIA_TASKS are short-answer/choice/
 * selection against a FIXED key, and productive-task.ts expects {prompt, sources}. Forcing
 * either to render this would misrepresent fields neither shape actually has.
 *
 * HV has no audio yet (german_exam_dsh_generators.py's HV generator is content-only, same as
 * every other exam's Hören — audio synthesis is a separate, not-yet-built concern for DSH's own
 * two-play delivery model, dsh-hv-playback.ts). This renders the lectureText as a transcript with
 * an explicit notice, never silently pretending audio exists.
 *
 * No backend grading exists for this content (open-answer content-point scoring needs an LLM
 * content-matcher judgement that is not wired to any route) — submitting here only COLLECTS the
 * learner's own answers and shows them back with an honest "not yet scored" message. It never
 * invents a score, and never calls /german-exam/results (that endpoint is for an ALREADY-scored
 * attempt; nothing here has one).
 */

export interface DshContentPoint { pointId: string; description: string; points: number; alternatives?: string[] }
export interface DshOpenAnswerItem { itemId: string; question: string; requiredPoints: DshContentPoint[]; optionalPoints?: DshContentPoint[] }
export interface DshOpenAnswerTaskGroup { form: string; items: DshOpenAnswerItem[] }
export interface DshOpenAnswerContent {
  lectureText?: string; // HV
  source?: { text: string; graphic?: unknown }; // LV
  tasks: DshOpenAnswerTaskGroup[];
}

export function validateDshOpenAnswerContent(c: DshOpenAnswerContent): void {
  const text = c.lectureText ?? c.source?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid DSH open-answer content: missing text');
  if (!Array.isArray(c.tasks) || !c.tasks.length) throw new Error('Invalid DSH open-answer content: missing tasks');
  const ids = new Set<string>();
  for (const task of c.tasks) {
    if (!Array.isArray(task.items) || !task.items.length) throw new Error('Invalid DSH open-answer content: a task needs items');
    for (const item of task.items) {
      if (!item.itemId || typeof item.itemId !== 'string' || ids.has(item.itemId)) throw new Error('Invalid DSH open-answer content: missing or duplicate item id');
      ids.add(item.itemId);
      if (typeof item.question !== 'string' || !item.question.trim()) throw new Error('Invalid DSH open-answer content: item missing question');
      if (!Array.isArray(item.requiredPoints) || !item.requiredPoints.length) throw new Error('Invalid DSH open-answer content: item missing required content points');
    }
  }
}

/** kind distinguishes only which field carries the text and which notice is shown — the rest of
 * the rendering (questions, free-text answers, submit) is identical for HV and LV. */
export function mountDshOpenAnswer(root: HTMLElement, content: DshOpenAnswerContent, kind: 'hv' | 'lv'): () => void {
  root.replaceChildren();
  validateDshOpenAnswerContent(content);
  const text = (content.lectureText ?? content.source?.text) as string;
  const controller = new AbortController();
  let disposed = false;
  let submitted = false;
  const answers: Record<string, string> = {};

  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  notice.textContent = kind === 'hv'
    ? 'Audio-Synthese für diesen Prüfungsteil ist noch nicht verfügbar. Sie lesen den Vortrag als Transkript.'
    : 'Lesen Sie den folgenden Text.';

  const textBlock = document.createElement('div');
  for (const paragraph of text.split(/\n+/).filter(p => p.trim())) {
    const p = document.createElement('p');
    p.textContent = paragraph;
    textBlock.append(p);
  }

  const items = content.tasks.flatMap(t => t.items);
  const form = document.createElement('fieldset');
  for (const item of items) {
    const label = document.createElement('label');
    label.style.display = 'block';
    const question = document.createElement('span');
    question.textContent = item.question;
    const input = document.createElement('textarea');
    input.rows = 2;
    input.setAttribute('aria-label', item.question);
    input.addEventListener('input', () => { answers[item.itemId] = input.value; }, { signal: controller.signal });
    label.append(question, input);
    form.append(label);
  }

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = 'Antworten einreichen';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');

  submit.addEventListener('click', () => {
    if (disposed || submitted) return;
    submitted = true;
    submit.disabled = true;
    form.querySelectorAll('textarea').forEach(t => { (t as HTMLTextAreaElement).disabled = true; });
    const answeredCount = items.filter(i => (answers[i.itemId] || '').trim()).length;
    status.textContent = `${answeredCount} / ${items.length} Antworten erfasst. Eine automatische inhaltliche Bewertung ist für diesen Aufgabentyp noch nicht verfügbar.`;
  }, { signal: controller.signal });

  root.append(notice, textBlock, form, submit, status);
  return () => { disposed = true; controller.abort(); root.replaceChildren(); };
}
