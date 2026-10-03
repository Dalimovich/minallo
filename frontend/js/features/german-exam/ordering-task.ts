/** Reusable paragraph-ordering interaction (TestDaF Lesen 2, paragraph_ordering). N standalone
 * paragraphs, each assigned to exactly one of N positions — distinct from source-selection.ts's
 * matching shape (no separate reading passage, no options per question, no distractors: every
 * paragraph is used exactly once and the "answer" is a shared permutation, not a per-question pick). */
export interface OrderingQuestion { questionId: string; text: string; skillTags: string[] }
export interface OrderingContent { questions: OrderingQuestion[]; correctOrder: string[] }
export interface OrderingPart { constraints: { itemCount: number } }

function nonempty(v: unknown): v is string { return typeof v === 'string' && !!v.trim(); }

export function validateOrdering(part: OrderingPart, content: OrderingContent): void {
  const questions = content?.questions;
  if (!Array.isArray(questions) || questions.length !== part.constraints.itemCount) throw new Error('Wrong item count');
  if (questions.some(q => !q || !nonempty(q.questionId) || !nonempty(q.text))) throw new Error('Malformed paragraph');
  const ids = questions.map(q => q.questionId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate paragraph id');
  const order = content.correctOrder;
  if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length ||
      JSON.stringify([...order].sort()) !== JSON.stringify([...ids].sort())) {
    throw new Error('correctOrder is not a permutation of the paragraph ids');
  }
}

export function gradeOrdering(content: OrderingContent, answers: Record<string, string | null>): Record<string, { correct: boolean; skillTags: string[] }> {
  return Object.fromEntries(content.questions.map(q => {
    const position = String(content.correctOrder.indexOf(q.questionId) + 1);
    return [q.questionId, { correct: answers[q.questionId] === position, skillTags: q.skillTags }];
  }));
}

export function mountOrdering(root: HTMLElement, part: OrderingPart, content: OrderingContent,
  answers: Record<string, string | null>, checked = false): () => void {
  root.replaceChildren();
  try { validateOrdering(part, content); } catch (err) {
    root.textContent = 'This exercise is invalid. Please reload it.';
    throw err;
  }
  const controller = new AbortController();
  const n = content.questions.length;
  for (const q of content.questions) {
    const row = document.createElement('div'); row.dataset.questionId = q.questionId;
    const text = document.createElement('p'); text.textContent = q.text; row.append(text);
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Position in the correct order');
    select.disabled = checked;
    select.add(new Option('?', ''));
    for (let position = 1; position <= n; position++) select.add(new Option(String(position), String(position)));
    select.value = answers[q.questionId] || '';
    select.addEventListener('change', () => { answers[q.questionId] = select.value || null; }, { signal: controller.signal });
    row.append(select);
    if (checked) {
      const correctPosition = String(content.correctOrder.indexOf(q.questionId) + 1);
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      status.textContent = answers[q.questionId] === correctPosition ? 'Correct' : 'Incorrect';
      row.append(status);
    }
    root.append(row);
  }
  return () => { controller.abort(); root.replaceChildren(); };
}
