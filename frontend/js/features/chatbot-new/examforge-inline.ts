import { escapeHtml } from '../../utils/escape-html.js';
import { gradeExamForgeAnswer } from '../../services/ai-service.js';
import { reportStudyToolError } from './study-tool-boundary.js';

interface Question { id?: string; type?: string; question?: string; prompt?: string; options?: unknown; points?: number; topic?: string; difficulty?: string }
interface Grade { ok?: boolean; isCorrect?: boolean; score?: number; correctAnswer?: string; feedback?: string; error?: string }
interface Attempt { current: number; display: 'one' | 'all'; answers: Record<string, string>; flags: Record<string, boolean>; status: 'in_progress' | 'submitting' | 'graded' | 'failed'; grades: Record<string, Grade>; confirmSubmit?: boolean }

const optionList = (q: Question): Array<{ id: string; text: string }> => {
  if (q.type === 'true_false') return [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];
  if (Array.isArray(q.options)) return q.options.map((value, i) => typeof value === 'object' && value ? { id: String((value as { id?: string }).id || String.fromCharCode(65 + i)), text: String((value as { text?: string }).text || '') } : { id: String.fromCharCode(65 + i), text: String(value) });
  if (q.options && typeof q.options === 'object') return Object.entries(q.options).map(([id, text]) => ({ id, text: String(text) }));
  return [];
};

export function mountInlineExamForge(target: HTMLElement | null, payload: Record<string, unknown>, mode: 'exam' | 'practice' = 'exam'): void {
  if (!target) return;
  const sessionId = String(payload.sessionId || payload.id || '');
  const questions = (Array.isArray(payload.questions) ? payload.questions : []) as Question[];
  const key = `minallo_examforge_attempt_${sessionId}_${mode}`;
  let state: Attempt = { current: 0, display: 'one', answers: {}, flags: {}, status: 'in_progress', grades: {} };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(key) || '{}') as Attempt }; } catch { /* new attempt */ }
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* optional */ } };
  const qKey = (q: Question, i: number) => String(q.id || i);
  const answered = () => questions.filter((q, i) => String(state.answers[qKey(q, i)] || '').trim()).length;

  const renderQuestion = (q: Question, i: number): string => {
    const id = qKey(q, i); const answer = state.answers[id] || ''; const grade = state.grades[id];
    const options = optionList(q);
    const control = q.type === 'short_answer'
      ? `<label class="ncb-ef-written"><span>Your answer</span><textarea data-ef-answer="${escapeHtml(id)}" maxlength="2000"${state.status !== 'in_progress' ? ' disabled' : ''}>${escapeHtml(answer)}</textarea></label>`
      : `<fieldset class="ncb-ef-options"><legend class="sr-only">Answer options</legend>${options.map(o => `<label><input type="radio" name="ef-${escapeHtml(id)}" value="${escapeHtml(o.id)}" data-ef-answer="${escapeHtml(id)}"${answer.toLowerCase() === o.id.toLowerCase() ? ' checked' : ''}${state.status !== 'in_progress' ? ' disabled' : ''}><span><b>${escapeHtml(o.id.toUpperCase())}</b>${escapeHtml(o.text)}</span></label>`).join('')}</fieldset>`;
    const review = grade ? `<div class="ncb-ef-review ${grade.isCorrect ? 'is-correct' : 'is-wrong'}"><strong>${grade.isCorrect ? 'Correct' : 'Needs review'} · ${Number(grade.score || 0)}/${Number(q.points || 1)} pt</strong>${grade.correctAnswer ? `<p><b>Correct answer:</b> ${escapeHtml(grade.correctAnswer)}</p>` : ''}<p>${escapeHtml(grade.feedback || grade.error || '')}</p></div>` : '';
    return `<article class="ncb-ef-question" data-question="${i}"><div class="ncb-ef-qmeta"><span>Question ${i + 1}</span><button type="button" data-ef-flag="${i}" aria-pressed="${state.flags[id] ? 'true' : 'false'}">${state.flags[id] ? '⚑ Flagged' : '⚐ Flag'}</button></div><h4>${escapeHtml(q.question || q.prompt || '')}</h4>${control}${review}</article>`;
  };

  const render = () => {
    const done = answered(); const total = questions.length;
    if (!total) { target.replaceChildren(document.createTextNode('This ExamForge session contains no questions.')); return; }
    state.current = Math.max(0, Math.min(state.current, total - 1));
    const shown = state.display === 'all' ? questions.map(renderQuestion).join('') : renderQuestion(questions[state.current]!, state.current);
    const score = Object.values(state.grades).reduce((n, g) => n + Number(g.score || 0), 0);
    const max = questions.reduce((n, q) => n + Number(q.points || 1), 0);
    const previousHtml = target.innerHTML;
    try {
    target.innerHTML = `<section class="ncb-ef-inline" aria-live="polite"><header><div><span class="ncb-tool-config-badge">ExamForge</span><h3>${escapeHtml(String(payload.title || 'ExamForge'))}</h3></div><span>${done} answered · ${total - done} unanswered</span></header><div class="ncb-ef-progress"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>${state.status === 'graded' ? `<div class="ncb-ef-score"><strong>Exam completed · ${score}/${max}</strong><span>${max ? Math.round(score / max * 100) : 0}%</span></div>` : ''}<div class="ncb-ef-display"><button data-ef-display="one" class="${state.display === 'one' ? 'active' : ''}">One at a time</button><button data-ef-display="all" class="${state.display === 'all' ? 'active' : ''}">All questions</button></div><nav class="ncb-ef-nav" aria-label="Question navigator">${questions.map((q, i) => `<button data-ef-go="${i}" class="${i === state.current ? 'current' : ''} ${state.answers[qKey(q, i)] ? 'answered' : ''}" aria-label="Question ${i + 1}">${i + 1}${state.flags[qKey(q, i)] ? '⚑' : ''}</button>`).join('')}</nav>${shown}<div class="ncb-ef-actions">${state.display === 'one' ? `<button data-ef-prev${state.current === 0 ? ' disabled' : ''}>Previous</button><button data-ef-next${state.current === total - 1 ? ' disabled' : ''}>Next</button>` : ''}${state.status === 'in_progress' ? `<button class="primary" data-ef-submit>Submit exam</button>` : state.status === 'failed' ? `<button class="primary" data-ef-submit>Retry review</button>` : ''}</div>${state.confirmSubmit ? `<div class="ncb-ef-confirm" role="alert">You still have ${total - done} unanswered questions.<button data-ef-unanswered>Review unanswered</button><button data-ef-submit-anyway>Submit anyway</button></div>` : ''}${state.status === 'submitting' ? '<p class="ncb-ef-grading">Reviewing your answers…</p>' : state.status === 'failed' ? '<p class="ncb-ef-error">Minallo could not finish reviewing your answers. Your responses are saved.</p>' : ''}</section>`;
      bind();
    } catch (error) {
      target.innerHTML = previousHtml;
      reportStudyToolError({ tool: 'examforge', stage: 'attempt_render', artifactId: sessionId }, error);
    }
  };

  const submit = async () => {
    state.status = 'submitting'; state.confirmSubmit = false; persist(); render();
    try {
      const grades = await Promise.all(questions.map(async (q, i) => {
        const id = qKey(q, i); if (!q.id) return [id, { ok: false, error: 'Question was not persisted.' } as Grade] as const;
        const grade = await gradeExamForgeAnswer(sessionId, q.id, state.answers[id] || '') as Grade;
        return [id, grade] as const;
      }));
      state.grades = Object.fromEntries(grades); state.status = 'graded'; persist(); render();
    } catch { state.status = 'failed'; persist(); render(); }
  };

  const updateExamChrome = (): void => {
    const done = answered();
    const count = target.querySelector<HTMLElement>('.ncb-ef-inline header > span');
    if (count) count.textContent = `${done} answered · ${questions.length - done} unanswered`;
    const progress = target.querySelector<HTMLElement>('.ncb-ef-progress i');
    if (progress) progress.style.width = `${questions.length ? Math.round(done / questions.length * 100) : 0}%`;
    target.querySelectorAll<HTMLButtonElement>('[data-ef-go]').forEach(button => {
      const index = Number(button.dataset.efGo); const question = questions[index];
      button.classList.toggle('answered', !!question && !!state.answers[qKey(question, index)]);
    });
  };

  const bind = () => {
    target.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-ef-answer]').forEach(el => el.addEventListener(el instanceof HTMLTextAreaElement ? 'input' : 'change', () => {
      try {
        state.answers[el.dataset.efAnswer!] = el.value; persist(); updateExamChrome();
      } catch (error) { reportStudyToolError({ tool: 'examforge', stage: 'answer_update', artifactId: sessionId }, error); }
    }));
    target.querySelectorAll<HTMLButtonElement>('[data-ef-go]').forEach(b => b.addEventListener('click', () => { state.current = Number(b.dataset.efGo); state.display = 'one'; persist(); render(); }));
    target.querySelectorAll<HTMLButtonElement>('[data-ef-display]').forEach(b => b.addEventListener('click', () => { state.display = b.dataset.efDisplay as 'one' | 'all'; persist(); render(); }));
    target.querySelectorAll<HTMLButtonElement>('[data-ef-flag]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.efFlag); const id = qKey(questions[i]!, i); state.flags[id] = !state.flags[id]; persist(); render(); }));
    target.querySelector<HTMLButtonElement>('[data-ef-prev]')?.addEventListener('click', () => { state.current--; persist(); render(); });
    target.querySelector<HTMLButtonElement>('[data-ef-next]')?.addEventListener('click', () => { state.current++; persist(); render(); });
    target.querySelector<HTMLButtonElement>('[data-ef-submit]')?.addEventListener('click', () => { if (answered() < questions.length) { state.confirmSubmit = true; render(); } else void submit(); });
    target.querySelector<HTMLButtonElement>('[data-ef-submit-anyway]')?.addEventListener('click', () => void submit());
    target.querySelector<HTMLButtonElement>('[data-ef-unanswered]')?.addEventListener('click', () => { const i = questions.findIndex((q, n) => !state.answers[qKey(q, n)]); if (i >= 0) state.current = i; state.display = 'one'; state.confirmSubmit = false; render(); });
  };
  render();
}
