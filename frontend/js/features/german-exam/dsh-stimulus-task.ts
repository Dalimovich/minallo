/** DSH TP (Textproduktion) / Oral (Kurzvortrag stimulus) — input-bound productive tasks.
 *
 * Deliberately NOT routed through productive-task.ts: DSH's content shape ({inputs, languageActs,
 * instructions, inputRefs}, from german_exam_dsh_generators.py) has no `prompt` field and no
 * `sources` array — it is genuinely different from productive-task-v1, not a renaming of the
 * same thing. Forcing mountWriting/mountSpeaking onto it would misrepresent fields neither shape
 * actually has (and, for Oral, there is no grader/recording destination to wire a ProductiveGrader
 * or RecordingSubmitter into at all).
 *
 * No backend grading exists for TP (DSH is not in GRADABLE_WRITING_PROFILE_IDS) and none exists
 * for Oral (no interaction architecture, no weights — see the Goethe-speaking-shaped blocker this
 * generator's own docstring points at). Both renderers below only COLLECT what the learner did
 * and show it back honestly as "not yet scored" / "not yet gradeable" — never a fabricated score,
 * never a submission to /german-exam/results (which is for an already-scored attempt).
 */

export interface DshStimulusInput { id: string; kind: string; text: string }
export interface DshStimulusContent {
  inputs: DshStimulusInput[];
  languageActs: string[];
  instructions: string;
  wordCountApprox?: number; // TP only
  inputRefs: string[];
}

export function validateDshStimulusContent(c: DshStimulusContent): void {
  if (!Array.isArray(c.inputs) || !c.inputs.length) throw new Error('Invalid DSH stimulus content: missing inputs');
  for (const input of c.inputs) {
    if (!input || typeof input.id !== 'string' || !input.id.trim() || typeof input.kind !== 'string'
      || typeof input.text !== 'string' || !input.text.trim()) throw new Error('Invalid DSH stimulus content: bad input');
  }
  if (new Set(c.inputs.map(i => i.id)).size !== c.inputs.length) throw new Error('Invalid DSH stimulus content: duplicate input ids');
  if (!Array.isArray(c.languageActs) || !c.languageActs.length) throw new Error('Invalid DSH stimulus content: missing language acts');
  if (typeof c.instructions !== 'string' || !c.instructions.trim()) throw new Error('Invalid DSH stimulus content: missing instructions');
  if (!Array.isArray(c.inputRefs) || !c.inputRefs.length) throw new Error('Invalid DSH stimulus content: missing inputRefs');
}

function renderInputs(root: HTMLElement, content: DshStimulusContent): void {
  const instructions = document.createElement('p');
  instructions.textContent = content.instructions;
  const inputs = document.createElement('section');
  for (const input of content.inputs) {
    const block = document.createElement('blockquote');
    block.textContent = input.text;
    block.setAttribute('data-input-kind', input.kind);
    inputs.append(block);
  }
  root.append(instructions, inputs);
}

/** TP: a free-text response, approximate word-count guidance, draft auto-saved like
 * productive-task.ts's mountWriting (same UX pattern, reused, not the same content shape). */
export function mountDshWritingStimulus(
  root: HTMLElement, content: DshStimulusContent, identity: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): () => void {
  root.replaceChildren();
  validateDshStimulusContent(content);
  const controller = new AbortController();
  let disposed = false;
  let submitted = false;
  const key = `dsh-tp-draft:${identity}`;

  renderInputs(root, content);
  const guidance = document.createElement('p');
  guidance.textContent = content.wordCountApprox != null ? `Ungefähre Länge: ${content.wordCountApprox} Wörter` : '';

  const editor = document.createElement('textarea');
  editor.rows = 12;
  editor.setAttribute('aria-label', 'Ihre Antwort');
  const count = document.createElement('output');
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved && typeof saved.text === 'string') editor.value = saved.text;
  } catch { /* corrupt/unavailable draft storage — start empty, never throw */ }

  const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);
  const save = (): void => {
    count.textContent = `${wordCount(editor.value)} Wörter`;
    try { storage.setItem(key, JSON.stringify({ text: editor.value })); } catch { /* best-effort draft save only */ }
  };
  editor.addEventListener('input', save, { signal: controller.signal });
  save();

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = 'Antwort einreichen';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  submit.addEventListener('click', () => {
    if (disposed || submitted) return;
    submitted = true;
    submit.disabled = true;
    editor.readOnly = true;
    status.textContent = `Antwort erfasst (${wordCount(editor.value)} Wörter). Eine automatische Bewertung ist für diesen Aufgabentyp noch nicht verfügbar.`;
  }, { signal: controller.signal });

  root.append(guidance, editor, count, submit, status);
  return () => { disposed = true; controller.abort(); root.replaceChildren(); };
}

/** Oral: shows the Kurzvortrag stimulus with the official preparation countdown, then a
 * self-reported "I presented" confirmation — NO audio recording. There is no grader or
 * interaction architecture to submit a recording to (this generator only produces the
 * stimulus, never an examiner-dialogue script — see this module's own header comment), so
 * capturing audio here would have nowhere honest to go. */
export function mountDshOralStimulus(
  root: HTMLElement, content: DshStimulusContent, preparationSeconds: number | undefined,
  now: () => number = Date.now,
): () => void {
  root.replaceChildren();
  validateDshStimulusContent(content);
  let disposed = false;
  renderInputs(root, content);

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.textContent = 'Ich habe meinen Kurzvortrag gehalten';

  let interval: ReturnType<typeof setInterval> | null = null;
  if (preparationSeconds && preparationSeconds > 0) {
    confirm.disabled = true;
    const deadline = now() + preparationSeconds * 1000;
    const tick = (): void => {
      const remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
      status.textContent = remaining > 0 ? `Vorbereitung: ${remaining}s verbleibend` : 'Vorbereitung beendet — Sie können jetzt vortragen.';
      if (remaining === 0) { confirm.disabled = false; if (interval) clearInterval(interval); }
    };
    tick();
    interval = setInterval(tick, 1000);
  } else {
    status.textContent = 'Sie können jetzt vortragen.';
  }

  confirm.addEventListener('click', () => {
    if (disposed || confirm.disabled) return;
    confirm.disabled = true;
    status.textContent = 'Als gehalten markiert. Eine automatische Bewertung ist für diesen Aufgabentyp noch nicht verfügbar.';
  });

  root.append(status, confirm);
  return () => { disposed = true; if (interval) clearInterval(interval); root.replaceChildren(); };
}
