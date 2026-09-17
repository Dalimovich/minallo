import { writingExamRequest } from '../writing-coach/writing-exam.js';

export type SpeakingStage = 'choose' | 'prepare' | 'presentation' | 'own_followup' | 'listen' | 'summary' | 'questions' | 'part1_done' | 'discussion' | 'graded';
export interface SpeakingTurn { role: 'learner' | 'partner'; stage: string; text: string; evidence: string }
export interface SpeakingContent {
  questions?: { questionId: string; title: string; taskInstructions: string }[];
  quote?: string; sourceLabel?: string; guidingPoints?: string[];
}
export interface SpeakingTask { generationId: string; content: SpeakingContent; part: { id: string } }
export interface SpeakingGrade {
  scoreValue: number; maxScoreValue: number; officialMaxScoreValue: number;
  rubric: Record<string, { score: number | null; maxScore: number; scope: string }>;
  unavailableReason: string;
  feedback: { strengths?: string[]; weaknesses?: string[]; improvements?: string[]; examples?: { quote: string; suggestion: string }[] };
  examResultItems: Record<string, unknown>[];
}
export function speakingProfileStatus(profile: { loaded?: boolean; id?: string | null; family?: string; level?: string }): 'ready' | 'loading' | 'unsupported' {
  if (profile.id === 'telc_c1_hochschule' || (!profile.id && profile.family?.trim().toLowerCase() === 'telc' && profile.level === 'C1 Hochschule')) return 'ready';
  return profile.loaded ? 'unsupported' : 'loading';
}

/** Pure session state; only this owner advances stages or adds recorded turns. */
export class SpeakingSession {
  stage: SpeakingStage = 'choose';
  selectedTopicId = '';
  notes = '';
  turns: SpeakingTurn[] = [];
  tasks: Record<string, SpeakingTask> = {};
  grade: SpeakingGrade | null = null;
  saved = false;
  listened = false;
  private pending = new Map<string, Promise<SpeakingTask>>();
  private pendingPartner: string | null = null;
  private saving: Promise<void> | null = null;
  constructor(readonly sessionId: string, private request = writingExamRequest) {}

  async load(partId = 'sprechen_1'): Promise<SpeakingTask> {
    const task = this.tasks[partId];
    if (task) return task;
    const pending = this.pending.get(partId);
    if (pending) return pending;
    const call = this.request<SpeakingTask>('generate', { profileId: 'telc_c1_hochschule', module: 'speaking', partId, mode: 'adaptive_practice' })
      .then(value => {
        if (value.part?.id !== partId || !value.generationId ||
            (partId === 'sprechen_1' ? value.content?.questions?.length !== 2 : !value.content?.quote || value.content?.guidingPoints?.length !== 4)) {
          throw new Error('Die Sprechaufgabe ist unvollständig. Bitte erneut versuchen.');
        }
        this.tasks[partId] = value;
        return value;
      }).finally(() => { this.pending.delete(partId); });
    this.pending.set(partId, call);
    return call;
  }
  choose(id: string): void {
    if (!['choose', 'prepare'].includes(this.stage) || !this.tasks.sprechen_1?.content.questions?.some(q => q.questionId === id)) throw new Error('Wählen Sie ein Thema.');
    this.selectedTopicId = id; this.stage = 'prepare';
  }
  startPresentation(): void {
    if (this.stage !== 'prepare' || !this.selectedTopicId) throw new Error('Wählen Sie zuerst ein Thema.');
    this.stage = 'presentation';
  }
  startSummary(): void {
    if (this.stage !== 'listen' || !this.listened) throw new Error('Hören Sie zuerst den Partnerbeitrag.');
    this.stage = 'summary';
  }
  private context() {
    return { profileId: 'telc_c1_hochschule', sessionId: this.sessionId, selectedTopicId: this.selectedTopicId,
      tasks: Object.fromEntries(Object.entries(this.tasks).map(([id, task]) => [id, task.content])), turns: this.turns };
  }
  async partner(stage: string): Promise<void> {
    this.pendingPartner = stage;
    const turn = await this.request<SpeakingTurn>('speaking', { ...this.context(), action: 'partner', stage });
    this.turns.push(turn);
    this.pendingPartner = null;
    if (stage === 'own_followup') this.stage = 'own_followup';
    if (stage === 'partner_presentation') this.stage = 'listen';
    if (stage === 'partner_answer') this.stage = 'part1_done';
    if (stage === 'discussion') this.stage = 'discussion';
  }
  get needsPartnerRetry(): boolean { return !!this.pendingPartner; }
  async retryPartner(): Promise<void> { if (this.pendingPartner) await this.partner(this.pendingPartner); }
  async submitRecording(audioBase64: string, mimeType: string): Promise<void> {
    if (!['presentation', 'own_followup', 'summary', 'questions', 'discussion'].includes(this.stage) || this.pendingPartner) throw new Error('Dieser Schritt ist noch nicht bereit.');
    if (this.turns.length >= 36) throw new Error('Bitte beenden Sie die Diskussion und lassen Sie sie bewerten.');
    const stage = this.stage;
    const turn = await this.request<SpeakingTurn>('speaking', {
      profileId: 'telc_c1_hochschule', sessionId: this.sessionId, action: 'transcribe', stage, audioBase64, mimeType
    });
    this.turns.push(turn);
    if (stage === 'presentation') await this.partner('own_followup');
    else if (stage === 'own_followup') await this.partner('partner_presentation');
    else if (stage === 'summary') this.stage = 'questions';
    else if (stage === 'questions') await this.partner('partner_answer');
    else await this.partner('discussion');
  }
  async startDiscussion(): Promise<void> {
    if (this.stage !== 'part1_done') throw new Error('Schließen Sie zuerst Teil 1 ab.');
    await this.load('sprechen_2');
    await this.partner('discussion');
  }
  get canGrade(): boolean {
    return this.stage === 'discussion' && !this.pendingPartner && this.turns.filter(t => t.role === 'learner' && t.stage === 'discussion').length >= 2;
  }
  async evaluate(): Promise<void> {
    if (this.grade) return;
    if (!this.canGrade) throw new Error('Mindestens zwei eigene Diskussionsbeiträge sind erforderlich.');
    this.grade = await this.request<SpeakingGrade>('speaking', { ...this.context(), action: 'grade' });
    this.stage = 'graded';
  }
  save(): Promise<void> {
    if (this.saved || !this.grade) return Promise.resolve();
    if (this.saving) return this.saving;
    const items = this.grade.examResultItems.map(item => ({ ...item, metadata: {
      ...(item.metadata as Record<string, unknown>), sourceGenerationIds: Object.fromEntries(Object.entries(this.tasks).map(([id, task]) => [id, task.generationId]))
    } }));
    this.saving = this.request<{ accepted: number; dropped: number }>('results', {
      examFamily: 'telc', examVariant: 'C1 Hochschule', targetLevel: 'C1', module: 'speaking', items
    }).then(result => {
      if (result.accepted !== items.length || result.dropped) throw new Error('Die Bewertung wurde nicht vollständig gespeichert. Bitte Speichern erneut versuchen.');
      this.saved = true;
    }).finally(() => { this.saving = null; });
    return this.saving;
  }
}
