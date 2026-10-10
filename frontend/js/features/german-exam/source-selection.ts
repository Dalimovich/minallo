/** Reusable source/selection interaction. Exam policy arrives through the manifest. */
export interface SelectionOption { id: string; text: string; role?: string }
export interface SelectionQuestion {
  id: string; prompt: string; group?: string; answerId: string; evidenceIds: string[];
  skillTags: string[]; options?: SelectionOption[];
}
export interface SelectionContent {
  schemaVersion: 'source-selection-v1';
  source: { paragraphs: Array<{ id: string; text: string }> };
  options?: SelectionOption[]; questions: SelectionQuestion[];
}
export interface SelectionPart {
  taskType: string;
  constraints: { itemCount: number; optionCount?: number; uniqueMappings?: boolean;
    categoryRoles?: string[]; groupCount?: number; presentation?: { instructions?: string } };
}
export const SELECTION_TYPES = new Set(['speech_act_matching', 'statement_category_matching',
  'statement_concept_pair_matching', 'lexical_cloze']);
function nonempty(v: unknown): v is string { return typeof v === 'string' && !!v.trim(); }
function rows(v: unknown): asserts v is Array<Record<string, unknown>> {
  if (!Array.isArray(v) || !v.length || v.some(r => !r || !nonempty(r.id)) || new Set(v.map(r => r.id)).size !== v.length)
    throw new Error('Missing or duplicate IDs');
}
export function validateSelection(part: SelectionPart, content: SelectionContent): void {
  if (!SELECTION_TYPES.has(part.taskType) || content?.schemaVersion !== 'source-selection-v1') throw new Error('Invalid task schema');
  rows(content.source?.paragraphs); rows(content.questions);
  if (content.source.paragraphs.some(p => !nonempty(p.text))) throw new Error('Malformed source');
  if (content.questions.length !== part.constraints.itemCount) throw new Error('Wrong item count');
  const sources = new Set(content.source.paragraphs.map(p => p.id));
  for (const q of content.questions) {
    const opts = q.options || content.options; rows(opts);
    if (opts.some(o => !nonempty(o.text)) || new Set(opts.map(o => o.text.trim().toLocaleLowerCase())).size !== opts.length) throw new Error('Invalid options');
    if (part.constraints.optionCount != null && opts.length !== part.constraints.optionCount) throw new Error('Wrong option count');
    if (!nonempty(q.prompt) || !opts.some(o => o.id === q.answerId)) throw new Error('Invalid answer reference');
    if (!Array.isArray(q.evidenceIds) || !q.evidenceIds.length || q.evidenceIds.some(id => !sources.has(id))) throw new Error('Invalid evidence');
    if (!Array.isArray(q.skillTags) || !q.skillTags.length || q.skillTags.some(t => !nonempty(t))) throw new Error('Invalid skills');
  }
  if (part.constraints.uniqueMappings && new Set(content.questions.map(q => q.answerId)).size !== content.questions.length) throw new Error('Nonunique mapping');
  const roles = part.constraints.categoryRoles;
  if (roles && JSON.stringify(content.options?.map(o => o.role).sort()) !== JSON.stringify([...roles].sort())) throw new Error('Invalid category roles');
  if (part.constraints.groupCount != null && (content.questions.some(q => !nonempty(q.group)) || new Set(content.questions.map(q => q.group)).size !== part.constraints.groupCount)) throw new Error('Invalid groups');
  if (part.taskType === 'lexical_cloze') {
    const markers = [...content.source.paragraphs.map(p => p.text).join(' ').matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1]).sort();
    if (JSON.stringify(markers) !== JSON.stringify(content.questions.map(q => q.id).sort())) throw new Error('Invalid cloze gaps');
  }
}
export function gradeSelection(content: SelectionContent, answers: Record<string, string | null>): Record<string, { correct: boolean; skillTags: string[] }> {
  return Object.fromEntries(content.questions.map(q => [q.id, { correct: answers[q.id] === q.answerId, skillTags: q.skillTags }]));
}
export function mountSelection(sourceRoot: HTMLElement, questionRoot: HTMLElement, part: SelectionPart,
  content: SelectionContent, answers: Record<string, string | null>, checked = false): () => void {
  sourceRoot.replaceChildren(); questionRoot.replaceChildren();
  try { validateSelection(part, content); } catch (err) {
    questionRoot.textContent = 'This exercise is invalid. Please reload it.';
    throw err;
  }
  const controller = new AbortController();
  const makeSelect = (q: SelectionQuestion): HTMLSelectElement => {
    const select = document.createElement('select'); select.setAttribute('aria-label', q.prompt);
    select.dataset.questionId = q.id; select.disabled = checked;
    select.add(new Option('?', ''));
    for (const o of q.options || content.options || []) select.add(new Option(o.text, o.id));
    select.value = answers[q.id] || '';
    select.addEventListener('change', () => { answers[q.id] = select.value || null; }, { signal: controller.signal });
    return select;
  };
  const instructions = document.createElement('p');
  instructions.textContent = part.constraints.presentation?.instructions || '';
  sourceRoot.append(instructions);
  for (const paragraph of content.source.paragraphs) {
    const p = document.createElement('p'); p.dataset.sourceId = paragraph.id;
    if (part.taskType === 'lexical_cloze') {
      const chunks = paragraph.text.split(/(\{\{[^{}]+\}\})/g);
      for (const chunk of chunks) {
        if (chunk.startsWith('{{') && chunk.endsWith('}}')) {
          const q = content.questions.find(item => item.id === chunk.slice(2, -2));
          if (q) p.append(makeSelect(q));
        } else p.append(document.createTextNode(chunk));
      }
    } else p.textContent = paragraph.text;
    sourceRoot.append(p);
  }
  for (const q of content.questions) {
    const row = document.createElement('div'); row.dataset.questionId = q.id;
    const label = document.createElement('label'); label.textContent = [q.group, q.prompt].filter(Boolean).join(' ? ');
    if (part.taskType !== 'lexical_cloze') label.append(makeSelect(q));
    row.append(label);
    if (checked) {
      const result = document.createElement('p'); result.setAttribute('role', 'status');
      result.textContent = answers[q.id] === q.answerId ? 'Correct' : 'Incorrect'; row.append(result);
    }
    questionRoot.append(row);
  }
  return () => { controller.abort(); sourceRoot.replaceChildren(); questionRoot.replaceChildren(); };
}
