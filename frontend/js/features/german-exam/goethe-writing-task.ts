/** Goethe C1 Schreiben (forum_discussion_post / formal_context_message) — a single, no-choice
 * writing scenario with a fixed number of content points the response must address.
 *
 * Deliberately NOT routed through productive-task.ts: Goethe's content shape ({questions: [{title,
 * communicativeSituation, contentPoints, taskInstructions, writingCoachTaskType}]}, from
 * german_exam_writing.py's _prompt_goethe_single_scenario) has no `id`/`prompt`/`sources` fields —
 * genuinely different from productive-task-v1, not a renaming of the same thing (see
 * dsh-stimulus-task.ts's own header comment for the identical reasoning applied to DSH TP/Oral).
 * task-workspace.ts previously dispatched this task type through mountWriting/ProductiveContent,
 * which threw on this shape immediately (validateProductive rejects a missing schemaVersion) —
 * confirmed broken by a real production generate+grade attempt, 2026-10-07/08.
 *
 * Grading IS real here (unlike DSH's TP): the SAME POST /german-exam/grade-writing endpoint and
 * the SAME shared Writing Coach evaluator (analyse_writing(), via german_exam_writing_grading.py)
 * TELC's own Writing already uses — only the request's `topicId` (there is no top-level `id` to
 * read it from, unlike ProductiveContent) and `task` shape differ, both handled below with no new
 * grading mechanism invented.
 */
import { writingExamRequest, type WritingGrade } from '../writing-coach/writing-exam.js';
import { renderFeedback, wordCount, type Feedback, type ProductivePart } from './productive-task.js';
import { mapWritingGradeToFeedback } from './writing-grader.js';

export interface GoetheWritingTopic {
  questionId: string;
  title: string;
  communicativeSituation: string;
  contentPoints: string[];
  taskInstructions: string;
  writingCoachTaskType: string;
  addressForm?: string;
}
export interface GoetheWritingContent { questions: GoetheWritingTopic[] }

export interface GoetheWritingTaskEnvelope {
  generationId?: string;
  exam: { profileId: string };
  part: { id: string };
}

export function validateGoetheWritingContent(c: GoetheWritingContent): GoetheWritingTopic {
  const topic = Array.isArray(c?.questions) ? c.questions[0] : undefined;
  if (!topic || typeof topic.questionId !== 'string' || !topic.questionId.trim()
    || typeof topic.title !== 'string' || !topic.title.trim()
    || typeof topic.communicativeSituation !== 'string' || !topic.communicativeSituation.trim()
    || !Array.isArray(topic.contentPoints) || !topic.contentPoints.length
    || topic.contentPoints.some((p) => typeof p !== 'string' || !p.trim())
    || typeof topic.taskInstructions !== 'string' || !topic.taskInstructions.trim()) {
    throw new Error('Invalid Goethe writing task');
  }
  return topic;
}

function renderGoetheWritingPrompt(root: HTMLElement, topic: GoetheWritingTopic): void {
  const title = document.createElement('h4');
  title.textContent = topic.title;
  const situation = document.createElement('p');
  situation.textContent = topic.communicativeSituation;
  const pointsHeading = document.createElement('p');
  pointsHeading.textContent = 'Gehen Sie in Ihrer Antwort auf folgende Punkte ein:';
  const points = document.createElement('ul');
  for (const point of topic.contentPoints) {
    const li = document.createElement('li');
    li.textContent = point;
    points.append(li);
  }
  const instructions = document.createElement('p');
  instructions.textContent = topic.taskInstructions;
  root.append(title, situation, pointsHeading, points, instructions);
}

/** Builds the real grader: reuses writingExamRequest (the same low-level POST helper every
 * other German-exam writing path calls) and mapWritingGradeToFeedback (unchanged) — only the
 * request fields differ from createWritingGrader's (topicId comes from the single topic's own
 * questionId, there being no top-level content.id in this shape). */
function createGoetheWritingGrader(
  envelope: GoetheWritingTaskEnvelope, content: GoetheWritingContent, topic: GoetheWritingTopic,
  gradingDimensions: readonly string[], request: typeof writingExamRequest = writingExamRequest,
) {
  return async (text: string, signal: AbortSignal): Promise<Feedback> => {
    const grade = await request<WritingGrade>('grade-writing', {
      profileId: envelope.exam.profileId,
      partId: envelope.part.id,
      topicId: topic.questionId,
      generationId: envelope.generationId ?? null,
      writingCoachTaskType: topic.writingCoachTaskType,
      task: content,
      text,
    }, signal);
    return mapWritingGradeToFeedback(grade, gradingDimensions, text);
  };
}

/** Same UX shell as productive-task.ts's mountWriting (textarea, word count, draft recovery,
 * submit, feedback) — deliberately NOT shared code, since that function's shell is entangled
 * with renderProductiveSources/ProductiveContent's validation; duplicating the small shell here
 * is cheaper and clearer than threading a content-shape-agnostic abstraction through it for a
 * single caller. */
export function mountGoetheWriting(
  root: HTMLElement, part: ProductivePart, content: GoetheWritingContent, identity: string,
  envelope: GoetheWritingTaskEnvelope, request: typeof writingExamRequest = writingExamRequest,
  storage: Storage = localStorage,
): () => void {
  root.replaceChildren();
  const topic = validateGoetheWritingContent(content);
  const grader = createGoetheWritingGrader(envelope, content, topic, part.gradingDimensions || [], request);
  const controller = new AbortController();
  let disposed = false;
  let submitting = false;
  const key = `german-writing:${identity}:${topic.questionId}`;

  renderGoetheWritingPrompt(root, topic);
  const editor = document.createElement('textarea');
  editor.setAttribute('aria-label', 'Your response');
  editor.rows = 12;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const count = document.createElement('output');
  const feedback = document.createElement('section');
  const guidance = document.createElement('p');
  const min = part.constraints.wordCountMin;
  guidance.textContent = min != null
    ? `Minimum: ${min} words`
    : `Approximate length: ${part.constraints.wordCountMinApprox ?? '?'}–${part.constraints.wordCountMaxApprox ?? '?'} words`;

  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved && typeof saved.text === 'string') editor.value = saved.text;
  } catch { status.textContent = 'Draft recovery unavailable.'; }

  const save = (): void => {
    count.textContent = `${wordCount(editor.value)} words`;
    try { storage.setItem(key, JSON.stringify({ text: editor.value })); } catch { status.textContent = 'Draft could not be saved on this device.'; }
  };
  editor.addEventListener('input', save, { signal: controller.signal });
  save();

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = 'Submit';
  submit.onclick = async () => {
    if (submitting || disposed || !editor.value.trim()) return;
    submitting = true;
    submit.disabled = true;
    editor.readOnly = true;
    status.textContent = 'Submitting…';
    save();
    try {
      const result = await grader(editor.value, controller.signal);
      if (disposed) return;
      renderFeedback(feedback, part, result, editor.value);
      status.textContent = 'Submitted';
    } catch {
      if (!disposed) {
        status.textContent = 'Grading failed. Your draft is saved; retry submission.';
        submitting = false;
        submit.disabled = false;
        editor.readOnly = false;
      }
    }
  };

  root.append(guidance, editor, count, submit, status, feedback);
  return () => { disposed = true; save(); controller.abort(); root.replaceChildren(); };
}
