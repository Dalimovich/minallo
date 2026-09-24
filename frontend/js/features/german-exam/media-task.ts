/** Script content and media delivery are separate contracts. No provider access. */
export const MEDIA_TASKS: Record<string, string> = {
  listening_overview_completion: 'short_answer', listening_concept_pair_notes: 'short_answer',
  video_outline_completion: 'short_answer', video_speaker_statement_matching: 'choice',
  listening_multiple_choice: 'choice', listening_summary_error_detection: 'error_selection',
  sound_script_comparison: 'word_selection'
};
export interface MediaPart {
  taskType: string; constraints: {itemCount: number; mediaType: 'audio' | 'video'; optionCount?: number;
    answerWordMax?: number; answerNormalization?: {ignoreCase?: boolean; ignorePunctuation?: boolean};
    categoryRoles?: string[]; revealQuestionsAfterMedia?: boolean};
}
export interface MediaContent {
  schemaVersion: 'media-task-v1'; source: {segments: Array<{id: string; speakerId: string; text: string}>};
  questions: Array<{id: string; prompt: string; evidenceIds: string[]; skillTags: string[];
    acceptedAnswers?: string[]; options?: Array<{id: string; text: string; role?: string}>; answerId?: string; spokenText?: string}>;
  correctIds?: string[];
  media?: {mediaType: 'audio' | 'video'; mediaId: string; audioUrl?: string; videoUrl?: string; duration: number;
    transcriptAvailability: 'hidden' | 'after_submission' | 'available'; segments?: Array<{sourceId: string; start: number; end: number}>};
}
export function normalizeAnswer(s: string, policy: {ignoreCase?: boolean; ignorePunctuation?: boolean} = {}): string {
  s = s.normalize('NFKC'); if (policy.ignoreCase) s = s.toLocaleLowerCase('de');
  if (policy.ignorePunctuation) s = s.replace(/\p{P}/gu, '');
  return s.trim().replace(/\s+/g, ' ');
}
function validRows(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length > 0 && rows.every(r => r && typeof r.id === 'string' && r.id.trim()) && new Set(rows.map(r => r.id)).size === rows.length;
}
export function validateMediaTask(part: MediaPart, c: MediaContent): void {
  const kind = MEDIA_TASKS[part.taskType];
  if (!kind || c?.schemaVersion !== 'media-task-v1' || !validRows(c.source?.segments) || !validRows(c.questions)) throw new Error('Invalid task schema');
  const ids = new Set(c.source.segments.map(s => s.id));
  if (c.source.segments.some(s => typeof s.text !== 'string' || !s.text.trim() || typeof s.speakerId !== 'string' || !s.speakerId.trim())) throw new Error('Invalid source');
  if (['choice','short_answer'].includes(kind) && c.questions.length !== part.constraints.itemCount) throw new Error('Wrong item count');
  for (const q of c.questions) {
    if (typeof q.prompt !== 'string' || !q.prompt.trim() || !Array.isArray(q.evidenceIds) || !q.evidenceIds.length || q.evidenceIds.some(i => !ids.has(i))) throw new Error('Invalid question');
    if (!Array.isArray(q.skillTags) || !q.skillTags.length) throw new Error('Missing skills');
    if (kind === 'short_answer' && (!Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length || q.acceptedAnswers.some(a => typeof a !== 'string' || !a.trim() || (part.constraints.answerWordMax != null && a.trim().split(/\s+/).length > part.constraints.answerWordMax)))) throw new Error('Invalid accepted variants');
    if (kind === 'choice') {
      if (!q.options || !validRows(q.options) || q.options.length !== part.constraints.optionCount || !q.options.some(o => o.id === q.answerId) || q.options.some(o => typeof o.text !== 'string' || !o.text.trim()) || new Set(q.options.map(o => o.text.trim().toLowerCase())).size !== q.options.length) throw new Error('Invalid options');
      if (part.constraints.categoryRoles && JSON.stringify(q.options!.map(o => o.role).sort()) !== JSON.stringify([...part.constraints.categoryRoles].sort())) throw new Error('Invalid category roles');
    }
  }
  if (kind?.endsWith('selection')) {
    if (!Array.isArray(c.correctIds) || c.correctIds.length !== part.constraints.itemCount || new Set(c.correctIds).size !== c.correctIds.length || c.correctIds.length >= c.questions.length || c.correctIds.some(id => !c.questions.some(q => q.id === id))) throw new Error('Invalid error keys');
    if (kind === 'word_selection') {
      if (c.questions.some(q => !q.spokenText || q.prompt.trim().split(/\s+/).length !== 1 || q.spokenText.trim().split(/\s+/).length !== 1 || ((normalizeAnswer(q.prompt) !== normalizeAnswer(q.spokenText)) !== c.correctIds?.includes(q.id)))) throw new Error('Invalid word alignment');
      if (normalizeAnswer(c.questions.map(q => q.spokenText).join(' ')) !== normalizeAnswer(c.source.segments.map(s => s.text).join(' '))) throw new Error('Invalid spoken source');
    }
  }
  const m = c.media;
  if (m) {
    const url = m.mediaType === 'video' ? m.videoUrl : m.audioUrl;
    if (m.mediaType !== part.constraints.mediaType || typeof m.mediaId !== 'string' || !m.mediaId.trim() || !Number.isFinite(m.duration) || m.duration <= 0 || !['hidden','after_submission','available'].includes(m.transcriptAvailability) || (url != null && !/^(https:\/\/|\/(?!\/)|blob:)/.test(url))) throw new Error('Invalid media');
    if (m.segments?.some(s => !ids.has(s.sourceId) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > m.duration)) throw new Error('Invalid media timing');
  }
}
export function gradeMediaTask(part: MediaPart, c: MediaContent, answers: Record<string, string | boolean>): {kind: 'practice'; correct: number; total: number} {
  validateMediaTask(part, c);
  if (Object.keys(answers).some(id => !c.questions.some(q => q.id === id))) throw new Error('Unknown answers');
  const kind = MEDIA_TASKS[part.taskType]; let correct = 0;
  if (kind?.endsWith('selection')) {
    const selected = Object.keys(answers).filter(id => answers[id] === true);
    if (selected.length > part.constraints.itemCount) throw new Error('Too many selections');
    correct = selected.filter(id => c.correctIds?.includes(id)).length;
  } else for (const q of c.questions) {
    const given = answers[q.id] ?? ''; if (typeof given !== 'string') throw new Error('Invalid response');
    const policy = part.constraints.answerNormalization;
    if (kind === 'choice' ? given === q.answerId :
      (!part.constraints.answerWordMax || given.trim().split(/\s+/).length <= part.constraints.answerWordMax) && q.acceptedAnswers?.some(a => normalizeAnswer(a,policy) === normalizeAnswer(given,policy))) correct++;
  }
  return {kind: 'practice', correct, total: part.constraints.itemCount};
}
export function mountMediaTask(root: HTMLElement, part: MediaPart, c: MediaContent): () => void {
  root.replaceChildren(); validateMediaTask(part, c);
  const controller = new AbortController(); const answers: Record<string, string | boolean> = {};
  let disposed = false; let submitted = false;
  const media = document.createElement(part.constraints.mediaType); media.controls = true; media.preload = 'metadata';
  const status = document.createElement('p'); status.setAttribute('role','status'); status.textContent = 'Loading media?';
  const questions = document.createElement('fieldset'); questions.hidden = !!part.constraints.revealQuestionsAfterMedia;
  const transcript = document.createElement('details'); const title = document.createElement('summary'); title.textContent = 'Transcript'; transcript.append(title);
  for (const s of c.source.segments) { const p = document.createElement('p'); p.textContent = s.text; transcript.append(p); }
  transcript.hidden = c.media?.transcriptAvailability !== 'available';
  const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = 'Submit'; submit.disabled = questions.hidden;
  const listen = (event: string, cb: () => void): void => media.addEventListener(event,cb,{signal:controller.signal});
  listen('canplay', () => {status.textContent='Ready';}); listen('play', () => {status.textContent='Playing';});
  listen('pause', () => {status.textContent='Paused';}); listen('error', () => {status.textContent='Media unavailable. Please reload the exercise.'; submit.disabled=true;});
  listen('ended', () => {status.textContent='Playback complete'; questions.hidden=false; submit.disabled=submitted;});
  const url = c.media?.[part.constraints.mediaType === 'video' ? 'videoUrl' : 'audioUrl'];
  if (url) media.src=url; else {status.textContent='Media unavailable. Please reload the exercise.'; submit.disabled=true;}
  for (const q of c.questions) {
    const label = document.createElement('label'); label.style.display='block'; label.textContent=q.prompt;
    const kind=MEDIA_TASKS[part.taskType];
    if (kind === 'choice') {
      const input=document.createElement('select'); input.setAttribute('aria-label',q.prompt); input.add(new Option('?',''));
      q.options?.forEach(o=>input.add(new Option(o.text,o.id)));
      input.addEventListener('change',()=>{answers[q.id]=input.value;},{signal:controller.signal}); label.append(input);
    } else {
      const input=document.createElement('input'); input.type=kind==='short_answer'?'text':'checkbox'; input.setAttribute('aria-label',q.prompt);
      input.addEventListener('input',()=>{answers[q.id]=kind==='short_answer'?input.value:input.checked;},{signal:controller.signal}); label.append(input);
    }
    questions.append(label);
  }
  submit.addEventListener('click',()=>{
    if (disposed || submitted || !url) return;
    try {const result=gradeMediaTask(part,c,answers); submitted=true; questions.disabled=true; submit.disabled=true;
      status.textContent=`${result.correct} / ${result.total} correct (practice)`;
      transcript.hidden=c.media?.transcriptAvailability==='hidden';
    } catch {status.textContent=`Select at most ${part.constraints.itemCount} items.`;}
  },{signal:controller.signal});
  root.append(media,status,questions,submit,transcript);
  return ()=>{disposed=true;controller.abort();media.pause();media.removeAttribute('src');media.load();root.replaceChildren();};
}
