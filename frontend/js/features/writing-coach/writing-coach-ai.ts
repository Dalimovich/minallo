// Writing Coach — AI integration module.
//
// Calls /api/ai/writing-coach (Cloudflare → Python service) with the user's
// paragraph + profile level + task type. Returns the full analysis shape
// defined in docs/schreibtrainer-ai-spec.md.
//
// userId is taken server-side from the verified Supabase JWT — never
// passed from the client.

export type FeedbackType = 'grammar' | 'vocabulary' | 'style' | 'pattern';
export type Severity = 'high' | 'medium' | 'low' | 'optional';
export type Confidence = 'high' | 'medium' | 'low';
export type TaskType =
  | 'email'
  | 'stellungnahme'
  | 'argumentation'
  | 'zusammenfassung'
  | 'bericht'
  | 'motivationsschreiben'
  | 'freier_text';
export type ExplanationLanguage = 'English' | 'German' | 'Simple';

export interface RuleCard {
  title: string;
  rule: string;
  example: string;
  miniExerciseHint: string;
}

export interface FeedbackItem {
  type: FeedbackType;
  label: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  original: string;
  suggestion: string;
  spanStart: number;
  spanEnd: number;
  count?: number;
  examples?: unknown[];
  isActualError: boolean;
  isLevelUpgrade: boolean;
  explanation: string;
  ruleCard?: RuleCard | null;
}

export interface ScoreBlock {
  overall: number | null;
  grammar: number | null;
  vocabulary: number | null;
  structure: number | null;
  style: number | null;
  taskFulfillment: number | null;
}

export interface StructureFeedback {
  verdict: 'weak' | 'adequate' | 'strong';
  missing: string[];
  note: string;
}

export interface ExamReadiness {
  wouldPass: boolean;
  verdict: 'likely' | 'borderline' | 'unlikely';
  missing: string[];
  note: string;
}

export interface InsufficientContext {
  reason: 'tooShort' | 'tooVague' | 'offTopic';
  message: string;
  minWords: number;
}

export interface WritingAnalysis {
  profileLevel: string;
  taskType: TaskType;
  estimatedLevel: string;
  score: ScoreBlock;
  scoreExplanation: string;
  correctedText: string;
  improvedText: string;
  strengths: string[];
  feedbackItems: FeedbackItem[];
  structureFeedback: StructureFeedback | null;
  examReadiness: ExamReadiness | null;
  practiceRecommendations: string[];
  longitudinalNote: string | null;
  insufficientContext: InsufficientContext | null;
}

export interface AnalyzeOptions {
  text: string;
  profileLevel: string;
  taskType?: TaskType;
  explanationLanguage?: ExplanationLanguage;
  signal?: AbortSignal;
}

function _backendUrl(): string {
  const w = window as unknown as { BACKEND_URL?: string };
  return w.BACKEND_URL || '';
}

function _token(): string {
  const w = window as unknown as { _sbToken?: string };
  return w._sbToken || '';
}

export async function analyzeParagraph(opts: AnalyzeOptions): Promise<WritingAnalysis> {
  const res = await fetch(_backendUrl() + '/api/ai/writing-coach', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + _token(),
    },
    body: JSON.stringify({
      text: opts.text,
      profileLevel: opts.profileLevel,
      taskType: opts.taskType || 'freier_text',
      explanationLanguage: opts.explanationLanguage || 'English',
    }),
    signal: opts.signal,
  });
  // Surface the cap modal if the user has exhausted this month's allowance.
  // Import inline to avoid a circular dep with services/ai-usage during boot.
  try {
    const { detectAiCapError } = await import('../../services/ai-usage.js');
    await detectAiCapError(res);
  } catch { /* no-op */ }
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try {
      // Backend uses two shapes: fail() returns { error: { message } },
      // while some handlers return { error: "string" }. Accept both.
      const j = (await res.json()) as { error?: string | { message?: string } };
      if (typeof j.error === 'string') detail = j.error;
      else if (j.error && typeof j.error.message === 'string') detail = j.error.message;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return (await res.json()) as WritingAnalysis;
}
