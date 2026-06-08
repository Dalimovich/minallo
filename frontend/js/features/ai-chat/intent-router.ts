export type StudyIntent = 'daily_mission' | 'summary' | 'notes' | 'cheatsheet';

export interface IntentRoute {
  intent: StudyIntent;
  action: 'create_or_show';
  confidence: number;
  needsClarification: boolean;
  target: {
    courseId: string | null;
  };
}

const EXPLANATION_START = /^(what\s+(is|are)|how\s+(do|does|can)|why|explain|define|difference\s+between)\b/i;

export function routeStudyIntent(message: string, courseId: string | null): IntentRoute | null {
  const text = normalize(message);
  if (!text) return null;
  if (EXPLANATION_START.test(text)) return null;

  const intent =
    isDailyMission(text) ? 'daily_mission' :
    isSummary(text) ? 'summary' :
    isNotes(text) ? 'notes' :
    isCheatsheet(text) ? 'cheatsheet' :
    null;
  if (!intent) return null;
  return {
    intent,
    action: 'create_or_show',
    confidence: 0.9,
    needsClarification: !courseId,
    target: { courseId }
  };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDailyMission(s: string): boolean {
  return /^(to-?do|daily mission|study mission)$/.test(s) ||
    /\b(what should i study today|plan my study day|make me a to-?do|create my tasks|study plan for today)\b/.test(s);
}

function isSummary(s: string): boolean {
  return /^(summary|summarize)$/.test(s) || /\b(summarize this|make a summary|generate summary|short summary)\b/.test(s);
}

function isNotes(s: string): boolean {
  return /^(notes|study notes)$/.test(s) || /\b(make notes|generate notes|write notes|turn this into notes)\b/.test(s);
}

function isCheatsheet(s: string): boolean {
  return /^(cheatsheet|cheat sheet|formula sheet)$/.test(s) ||
    /\b(make a cheat ?sheet|generate cheat ?sheet|make a formula sheet|one-page sheet|compact sheet)\b/.test(s);
}
