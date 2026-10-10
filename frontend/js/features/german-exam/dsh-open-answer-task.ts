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
 * two-play delivery model, dsh-hv-playback.ts, which this module deliberately does not connect —
 * doing so would create the APPEARANCE of a real listening exam without real audio behind it).
 * This renders the lectureText as a transcript with an explicit, honest notice instead.
 *
 * Grading: if a `grade` callback is supplied, submit calls it (see dsh-lv-hv-grader.ts for the
 * real one, backed by POST /german-exam/dsh/lv-hv/grade and german_exam_dsh_grading.py's raw
 * content-point grader — score_content_item stays the one authoritative scorer; nothing here
 * recomputes a score). Without one, this falls back to the original collect-only behaviour
 * (honest "not yet scored" message) — kept for any caller that still only wants to collect
 * answers. The content passed to this function must already have had its answer-key fields
 * (requiredPoints, referenceAnswer, ...) stripped by the caller (german_exam_dsh_grading.
 * strip_answer_key_for_learner on the backend) — this renderer never receives or needs them.
 *
 * CRITICAL — the result this renders is a RAW CONTENT score, never an official DSH score: it is
 * `earned generated content points / generated content-point maximum` for THIS ONE generated
 * task, not a measurement of how the real DSH exam would score the learner (see
 * german_exam_dsh_grading.py's own module docstring for exactly why that conversion does not
 * exist). The rendered result must never claim otherwise — no point totals that look official, no
 * DSH-1/2/3-shaped wording, nothing implying a pass/fail against the real exam.
 */

export interface DshContentPoint { pointId: string; description: string; points: number; alternatives?: string[] }
// requiredPoints/optionalPoints are optional here on purpose: the learner-facing content this
// renderer receives has had them stripped server-side (german_exam_dsh_grading.py's
// strip_answer_key_for_learner) — they are answer-key material, never needed to render a
// question or collect an answer. Only server code holding the full, unstripped content may use
// them (see dsh-lv-hv-grader.ts, which never imports this file's types for that reason).
export interface DshOpenAnswerItem { itemId: string; question: string; requiredPoints?: DshContentPoint[]; optionalPoints?: DshContentPoint[] }
export interface DshOpenAnswerTaskGroup { form: string; items: DshOpenAnswerItem[] }
export interface DshOpenAnswerContent {
  lectureText?: string; // HV
  source?: { text: string; graphic?: unknown }; // LV
  tasks: DshOpenAnswerTaskGroup[];
}

export interface DshGradeItemResult { itemId: string; points: number; maxPoints: number }
export interface DshGradeResult {
  part: 'lv' | 'hv';
  generationId: string;
  rawPoints: number;
  rawMaxPoints: number;
  percent: number | null;
  items: DshGradeItemResult[];
  officialDshScore: null;
  officialScoreAvailable: false;
}
/** Resolves with the raw result, or throws — never resolves with a guessed/fabricated score. */
export type DshGradeFn = (answers: Record<string, string>, signal: AbortSignal) => Promise<DshGradeResult>;

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
    }
  }
}

const NOT_SCORED_MESSAGE = 'Inhaltliche Bewertung derzeit nicht verfügbar. Ihre Antwort wurde nicht bewertet.';
const RAW_RESULT_DISCLAIMER = 'Dies ist eine inhaltliche Übungsbewertung und kein offizielles Prüfungsergebnis.';

function setFormDisabled(form: HTMLElement, submit: HTMLButtonElement, disabled: boolean): void {
  form.querySelectorAll('textarea').forEach(t => { (t as HTMLTextAreaElement).disabled = disabled; });
  submit.disabled = disabled;
}

function renderRawResult(container: HTMLElement, result: DshGradeResult): void {
  container.replaceChildren();
  const heading = document.createElement('p');
  heading.setAttribute('role', 'status');
  const percentText = result.percent == null ? '' : ` (${result.percent}% der erzeugten Inhaltspunkte)`;
  heading.textContent = `Inhaltliche Bewertung: ${result.rawPoints} / ${result.rawMaxPoints} inhaltliche Punkte${percentText}.`;
  const disclaimer = document.createElement('p');
  disclaimer.textContent = RAW_RESULT_DISCLAIMER;
  container.append(heading, disclaimer);
}

/** kind distinguishes only which field carries the text and which notice is shown — the rest of
 * the rendering (questions, free-text answers, submit) is identical for HV and LV.
 *
 * `grade`, if supplied, drives the real submit -> loading -> raw-result/error flow (see module
 * docstring). Omitting it preserves the original collect-only behaviour. */
export function mountDshOpenAnswer(root: HTMLElement, content: DshOpenAnswerContent, kind: 'hv' | 'lv', grade?: DshGradeFn): () => void {
  root.replaceChildren();
  validateDshOpenAnswerContent(content);
  const text = (content.lectureText ?? content.source?.text) as string;
  const controller = new AbortController();
  let disposed = false;
  let phase: 'idle' | 'submitting' | 'done' = 'idle';
  const answers: Record<string, string> = {};

  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  notice.textContent = kind === 'hv'
    ? 'Transkript-basierter Übungsmodus — Audio ist derzeit nicht verfügbar. Sie lesen den Vortrag als Transkript.'
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
  const resultBlock = document.createElement('div');

  submit.addEventListener('click', () => {
    if (disposed || phase === 'submitting' || phase === 'done') return;

    if (!grade) {
      phase = 'done';
      setFormDisabled(form, submit, true);
      const answeredCount = items.filter(i => (answers[i.itemId] || '').trim()).length;
      status.textContent = `${answeredCount} / ${items.length} Antworten erfasst. Eine automatische inhaltliche Bewertung ist für diesen Aufgabentyp noch nicht verfügbar.`;
      return;
    }

    phase = 'submitting';
    setFormDisabled(form, submit, true);
    resultBlock.replaceChildren();
    status.textContent = 'Bewertung wird erstellt…';

    grade({ ...answers }, controller.signal).then(
      result => {
        if (disposed) return;
        phase = 'done';
        status.textContent = '';
        renderRawResult(resultBlock, result);
      },
      (error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        phase = 'idle';
        setFormDisabled(form, submit, false);
        status.textContent = NOT_SCORED_MESSAGE;
      },
    );
  }, { signal: controller.signal });

  root.append(notice, textBlock, form, submit, status, resultBlock);
  return () => { disposed = true; controller.abort(); root.replaceChildren(); };
}
