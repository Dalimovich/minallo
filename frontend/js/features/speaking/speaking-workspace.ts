import { transitionLearnerWorkspace } from '../chatbot-new/experience-mode.js';
import { writingExamRequest } from '../writing-coach/writing-exam.js';
import { SpeakingSession, speakingProfileStatus, type SpeakingStage } from './speaking-session.js';
import { SpeakingAudio, recordingBase64 } from './speaking-audio.js';

let session: SpeakingSession;
const audio = new SpeakingAudio();
let opened = false;
let busy = false;
let recording = false;
let error = '';
let unsent: Blob | null = null;
let initialized = false;
let playing = false;
let recordStarted = 0;
let clock: ReturnType<typeof setInterval> | null = null;
let weakHtml = '';
const labels: Record<SpeakingStage, string> = {
  choose: 'Thema wählen', prepare: 'Vorbereitung und Notizen', presentation: 'Teil 1A · Präsentation (ca. 3 Minuten)',
  own_followup: 'Teil 1B · Anschlussfragen beantworten', listen: 'Teil 1B · Partnerpräsentation anhören und Notizen machen',
  summary: 'Teil 1B · Hauptpunkte zusammenfassen', questions: 'Teil 1B · Anschlussfragen stellen',
  part1_done: 'Teil 1 abgeschlossen', discussion: 'Teil 2 · Diskussion (ca. 6 Minuten)', graded: 'Auswertung der Simulation'
};
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const profile = () => speakingProfileStatus({ loaded: window._germanProfileLoaded, id: window._germanExamProfileId, family: window._germanTest, level: window._germanLevel });
const button = (id: string, text: string, disabled = false) => `<button type="button" id="${id}" class="ncb-wc-btn-secondary" ${disabled ? 'disabled' : ''}>${text}</button>`;
const on = (id: string, action: () => void) => document.getElementById(id)?.addEventListener('click', action);

export async function openSpeakingWorkspace(): Promise<void> {
  if (!initialized) {
    initialized = true;
    session = new SpeakingSession(crypto.randomUUID());
    window.addEventListener('ss-profile-updated', () => { if (opened) void prepare(); });
    (window as unknown as { _spClose: () => void })._spClose = closeSpeakingWorkspace;
    window.addEventListener('pagehide', closeSpeakingWorkspace);
  }
  opened = true;
  await transitionLearnerWorkspace('speaking');
  await prepare();
}

export function closeSpeakingWorkspace(): void {
  opened = false;
  audio.close(); recording = false; playing = false;
  if (clock) clearInterval(clock);
  clock = null;
}

async function prepare(): Promise<void> {
  if (profile() !== 'ready') { audio.close(); recording = false; render(); return; }
  if (busy || session.tasks.sprechen_1) { render(); return; }
  await run(() => session.load().then(() => {}));
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true; error = ''; render();
  try { await action(); } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : 'Bitte erneut versuchen.';
  } finally { busy = false; render(); }
}

function render(): void {
  const root = document.getElementById('spWorkspace');
  if (!root || !opened) return;
  const status = profile();
  if (status !== 'ready') {
    root.innerHTML = `<h2>Sprechen</h2><p role="status">${status === 'loading' ? 'Prüfungsprofil wird geladen …' : 'Generiertes Sprechen ist für telc C1 Hochschule verfügbar. Stellen Sie dieses Prüfungsziel im Profil ein.'}</p>`;
    return;
  }
  const part2 = session.stage === 'discussion' || session.stage === 'graded';
  let taskHtml = '';
  const content = session.tasks.sprechen_1?.content;
  if (!part2 && content?.questions) {
    taskHtml = content.questions.map((topic, i) => `<section class="sp-topic"><label><input type="radio" name="spTopic" value="${escape(topic.questionId)}" ${session.selectedTopicId === topic.questionId ? 'checked' : ''} ${busy || !['choose', 'prepare'].includes(session.stage) ? 'disabled' : ''}> <strong>Thema ${i === 0 ? 'A' : 'B'}: ${escape(topic.title)}</strong></label><p>${escape(topic.taskInstructions)}</p></section>`).join('');
  } else if (part2) {
    const discussion = session.tasks.sprechen_2?.content;
    taskHtml = `<blockquote>${escape(discussion?.quote)}</blockquote><p>${escape(discussion?.sourceLabel)}</p><ul>${discussion?.guidingPoints?.map(p => `<li>${escape(p)}</li>`).join('') || ''}</ul>`;
  }
  const visibleTurns = session.turns.filter(turn => turn.stage !== 'partner_presentation' || ['questions', 'part1_done', 'discussion', 'graded'].includes(session.stage));
  const history = visibleTurns.map(t => `<article class="sp-turn"><strong>${t.role === 'learner' ? 'Sie · Transkript' : 'KI-Partner'}</strong><p>${escape(t.text)}</p></article>`).join('');
  const partner = [...session.turns].reverse().find(t => t.role === 'partner');
  const canRecord = ['presentation', 'own_followup', 'summary', 'questions', 'discussion'].includes(session.stage) && !session.needsPartnerRetry;
  root.innerHTML = `<h2>telc C1 Hochschule · C1 · Sprechen · Teil ${part2 ? '2' : '1'}</h2>
    <p>Prüfungsnahe Solo-Simulation mit einem KI-Partner und Prüfer. Sie üben beide Prüfungsteile; dies ersetzt keine echte Partnerprüfung.</p>
    ${taskHtml}<h3>${labels[session.stage]}</h3>
    ${session.stage === 'own_followup' || session.stage === 'summary' || session.stage === 'questions' ? '<p>Teil 1B: Zusammenfassung und Anschlussfragen, insgesamt ca. 2 Minuten pro Person.</p>' : ''}
    ${session.stage !== 'graded' ? `<label for="spNotes">Eigene Notizen (werden nicht bewertet)</label><textarea id="spNotes" class="ncb-wc-textarea" rows="3" maxlength="6000">${escape(session.notes)}</textarea>` : ''}
    <div role="log" aria-label="Gespräch" class="sp-conversation">${history}</div>
    ${session.stage === 'listen' ? '<p>Hören Sie den Partnerbeitrag und notieren Sie die Hauptpunkte. Der Text wird erst nach Ihrer Zusammenfassung angezeigt.</p>' : ''}
    <div class="sp-controls">
    ${session.stage === 'prepare' ? button('spStart', 'Präsentation beginnen', busy) : ''}
    ${partner && session.stage !== 'graded' ? button('spPlay', playing ? 'Audio läuft …' : 'KI-Partner anhören', busy || recording || playing) : ''}
    ${playing ? button('spStopAudio', 'Audio stoppen') : ''}
    ${session.stage === 'listen' ? button('spSummary', 'Jetzt zusammenfassen', busy || !session.listened || playing) : ''}
    ${canRecord ? button('spMic', recording ? 'Aufnahme beenden und senden' : 'Mikrofon starten', busy || playing) : ''}
    ${recording ? '<span id="spRecordClock" role="status">Aufnahme läuft …</span>' : ''}
    ${unsent && !session.needsPartnerRetry ? button('spRetryRecording', 'Aufnahme erneut senden', busy) : ''}
    ${session.needsPartnerRetry ? button('spRetryPartner', 'KI-Antwort erneut laden', busy) : ''}
    ${session.stage === 'part1_done' ? button('spPart2', 'Weiter zu Teil 2', busy || playing) : ''}
    ${session.stage === 'discussion' ? button('spEvaluate', 'Diskussion beenden und bewerten', busy || recording || playing || !session.canGrade) : ''}
    ${!session.tasks.sprechen_1 && !busy ? button('spRetryGenerate', 'Aufgabe erneut laden') : ''}
    </div>
    ${busy ? '<p role="status">Wird verarbeitet …</p>' : ''}${error ? `<p class="wc-error" role="alert">${escape(error)}</p>` : ''}
    ${session.grade ? renderGrade() : ''}`;
  root.querySelectorAll<HTMLInputElement>('input[name="spTopic"]').forEach(input => input.addEventListener('change', () => { session.choose(input.value); render(); }));
  document.getElementById('spNotes')?.addEventListener('input', event => { session.notes = (event.target as HTMLTextAreaElement).value; });
  on('spStart', () => { session.startPresentation(); render(); });
  on('spSummary', () => { audio.stopPlayback(); session.startSummary(); render(); });
  on('spRetryGenerate', () => { void prepare(); });
  on('spPart2', () => { void run(() => session.startDiscussion()); });
  on('spRetryPartner', () => { void run(async () => { await session.retryPartner(); unsent = null; }); });
  on('spMic', () => { if (recording) audio.stopRecording(); else void startRecording(); });
  on('spRetryRecording', () => { if (unsent) void sendRecording(unsent); });
  on('spPlay', () => { if (partner) void playPartner(partner.text); });
  on('spStopAudio', () => { audio.stopPlayback(); });
  on('spEvaluate', () => { void run(async () => { await session.evaluate(); await save(); }); });
  on('spSave', () => { void run(save); });
  on('spNew', () => {
    audio.close(); session = new SpeakingSession(crypto.randomUUID()); unsent = null; weakHtml = ''; void prepare();
  });
}

async function startRecording(): Promise<void> {
  if (busy || recording) return;
  error = ''; busy = true; render();
  try {
    await audio.record(blob => { recording = false; if (clock) clearInterval(clock); clock = null; void sendRecording(blob); }, cause => { error = cause.message; recording = false; render(); });
    recording = audio.recording;
    if (recording) {
      recordStarted = Date.now();
      clock = setInterval(() => { const el = document.getElementById('spRecordClock'); if (el) el.textContent = `Aufnahme: ${Math.floor((Date.now() - recordStarted) / 1000)} s (max. 4 Minuten)`; }, 1000);
    }
  } catch (cause) { error = cause instanceof Error ? cause.message : 'Mikrofonzugriff fehlgeschlagen.'; }
  finally { busy = false; render(); }
}

async function sendRecording(blob: Blob): Promise<void> {
  unsent = blob;
  await run(async () => {
    const previousTurns = session.turns.length;
    try { await session.submitRecording(await recordingBase64(blob), blob.type); }
    finally { if (session.turns.length > previousTurns) unsent = null; }
  });
}

async function playPartner(text: string): Promise<void> {
  playing = true; error = ''; render();
  const current = session;
  try {
    await audio.play(text);
    if (session === current && session.stage === 'listen') session.listened = true;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : 'Audiofehler';
  } finally { playing = false; render(); }
}

function renderGrade(): string {
  const grade = session.grade!;
  const names: Record<string, string> = { presentation: 'Teil 1A · Präsentation', summary_followup: 'Teil 1B · Zusammenfassung und Anschlussfragen', discussion: 'Teil 2 · Diskussion', fluency: 'Flüssigkeit', repertoire: 'Repertoire', grammatical_correctness: 'Grammatische Korrektheit', pronunciation_intonation: 'Aussprache und Intonation' };
  return `<section class="sp-feedback"><h3>KI-Übungseinschätzung: ${grade.scoreValue} / ${grade.maxScoreValue} bewertbare Punkte</h3><p>${escape(grade.unavailableReason)}</p>
    <dl>${Object.entries(grade.rubric).map(([key, value]) => `<dt>${escape(names[key] || key)}${value.scope === 'global' ? ' · gesamte Simulation' : ''}</dt><dd>${value.score === null ? 'Nicht verfügbar' : value.score} / ${value.maxScore}</dd>`).join('')}</dl>
    ${(['strengths', 'weaknesses', 'improvements'] as const).map(key => `<h4>${({ strengths: 'Stärken', weaknesses: 'Schwächen', improvements: 'Konkrete Verbesserungen' })[key]}</h4><ul>${(grade.feedback[key] || []).map(s => `<li>${escape(s)}</li>`).join('')}</ul>`).join('')}
    ${(grade.feedback.examples || []).map(e => `<blockquote>${escape(e.quote)}</blockquote><p>${escape(e.suggestion)}</p>`).join('')}
    <p role="status">${session.saved ? 'Bewertung gespeichert.' : 'Bewertung noch nicht gespeichert.'}</p>
    ${!session.saved ? button('spSave', 'Bewertung speichern / erneut versuchen', busy) : button('spNew', 'Neue Simulation', busy)}${weakHtml}</section>`;
}

async function save(): Promise<void> {
  await session.save();
  try {
    const report = await writingExamRequest<{ tags: Record<string, { score: number; confidence: string }> }>('weaknesses', { profileId: 'telc_c1_hochschule', module: 'speaking' });
    const tags = Object.entries(report.tags).filter(([, value]) => value.confidence !== 'cold_start').sort((a, b) => a[1].score - b[1].score);
    weakHtml = '<h4>Weak Areas · Sprechen</h4>' + (tags.length ? `<ul>${tags.map(([tag, value]) => `<li>${escape(tag.replace(/_/g, ' '))}: ${Math.round(value.score * 100)}%</li>`).join('')}</ul>` : '<p>Noch nicht genügend Bewertungen für verlässliche Übungsschwerpunkte.</p>');
  } catch { weakHtml = '<p>Übungsschwerpunkte konnten nicht geladen werden.</p>'; }
}
