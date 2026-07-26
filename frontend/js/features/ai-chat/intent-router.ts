// Canonical, side-effect-free study-tool intent detector. Detection only proposes
// an action; the chatbot owns confirmation, source resolution and execution.

export type StudyToolIntent =
  | 'examforge_create'
  | 'flashcards_create'
  | 'deep_learn_create'
  | 'cheatsheet_create'
  | 'notes_generate'
  | 'summary_generate'
  | 'note_save'
  | 'unknown';

export type IntentResolutionMethod =
  | 'exact'
  | 'normalised'
  | 'token_order'
  | 'fuzzy'
  | 'semantic'
  | 'none';

export interface DetectedStudyIntent {
  intent: StudyToolIntent;
  confidence: number;
  explicitSourceReference: boolean;
  sourcePhrase?: string;
  extractedParameters: Record<string, unknown>;
  missingRequiredParameters: string[];
  shouldOpenConfiguration: boolean;
  resolutionMethod: IntentResolutionMethod;
  matchedPhrase?: string;
}

export const AUTO_OPEN_CONFIGURATION_THRESHOLD = 0.82;
export const SUGGEST_INTENT_THRESHOLD = 0.58;

export const STUDY_TOOL_INTENT_ALIASES: Record<Exclude<StudyToolIntent, 'unknown'>, string[]> = {
  cheatsheet_create: ['cheatsheet', 'cheat sheet', 'sheet cheat', 'cheetsheet', 'cheet sheet', 'cheatshet', 'cheatsheat', 'formula cheat', 'formula sheet', 'reference sheet', 'exam sheet', 'study sheet', 'summary sheet', 'quick reference', 'spickzettel', 'formelsammlung'],
  flashcards_create: ['flashcards', 'flash cards', 'flashcard', 'flash card', 'flaschcards', 'flashcrads', 'flashcars', 'fcs', 'fc', 'revision cards', 'study cards', 'question answer cards', 'karteikarten', 'lernkarten'],
  examforge_create: ['examforge', 'exam forge', 'examforg', 'exam fourge', 'practice exam', 'mock exam', 'practice test', 'trial exam', 'test me', 'ubungsklausur', 'übungsklausur', 'prufungsfragen', 'prüfungsfragen'],
  deep_learn_create: ['deeplearn', 'deep learn', 'deep lern', 'deap learn', 'deep lesson', 'full lesson', 'teach deeply', 'professor explanation', 'lern tief', 'ausfuhrlich erklaren', 'ausführlich erklären'],
  notes_generate: ['notes', 'note', 'nots', 'notse', 'study notes', 'lecture notes', 'revision notes', 'class notes', 'notizen', 'lernnotizen', 'vorlesungsnotizen'],
  summary_generate: ['summary', 'summarise', 'summarize', 'overview', 'short overview', 'zusammenfassung', 'uberblick', 'überblick'],
  note_save: ['save to notes', 'save this note', 'save this answer', 'add to notes', 'keep this in notes', 'als notiz speichern', 'in notizen speichern']
};

const COMMAND_RE = /\b(create|make|generate|build|prepare|give me|put|turn\b.{0,80}\binto|convert\b.{0,80}\binto|i want|i need|open|start|write me|save|add|keep|test me|teach me|explain this|erstelle|mach|generiere|baue|gib mir|speicher|schreib)\b/iu;
const INFORMATION_RE = /^(?:what|why|how|when|where|who|was|warum|wie)\b|\b(?:mentions?|means?|definition|algorithm|metal)\b/iu;

export function normaliseIntentText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[-_/]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function compactIntentText(value: string): string {
  return normaliseIntentText(value).replace(/\s+/g, '');
}

function sortedTokenKey(value: string): string {
  return normaliseIntentText(value).split(' ').filter(Boolean).sort().join(' ');
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j] as number;
      row[j] = Math.min(previous + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length] as number;
}

function similarity(a: string, b: string): number {
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

function params(text: string, intent: StudyToolIntent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const count = text.match(/\b(\d{1,3})(?:\s+\p{L}+){0,2}\s+(?:flash\s*cards?|fcs?|cards?|questions?|fragen)\b/iu);
  const pageRange = text.match(/\bpages?\s*(\d+)\s*(?:-|to|through|bis)\s*(\d+)\b/iu);
  const page = !pageRange && text.match(/\bpages?\s*(\d+)\b/iu);
  if (count) result.count = Number(count[1]);
  if (pageRange) result.pages = [Number(pageRange[1]), Number(pageRange[2])];
  else if (page) result.page = Number(page[1]);
  const difficulty = text.match(/\b(easy|simple|leicht|medium|normal|mittel|hard|difficult|schwer|mixed|gemischt)\b/iu)?.[1]?.toLowerCase();
  if (difficulty) result.difficulty = ({ simple: 'easy', leicht: 'easy', normal: 'medium', mittel: 'medium', difficult: 'hard', schwer: 'hard', gemischt: 'mixed' } as Record<string, string>)[difficulty] || difficulty;
  if (/\b(german|deutsch)\b/iu.test(text)) result.language = 'de';
  if (/\b(english|englisch)\b/iu.test(text)) result.language = 'en';
  if (intent === 'cheatsheet_create' && /\b(?:one|1|eine[rnms]?)\s+pages?\b|\beinseitig\b/iu.test(text)) result.pages = 1;
  return result;
}

const semantic: Array<[StudyToolIntent, RegExp]> = [
  ['cheatsheet_create', /\b(?:all|important|wichtige[nrms]?)\s+(?:formulas?|formeln|rules?|regeln).*(?:compact|one page|seite)|\bcompact.*(?:formulas?|rules?)\b/iu],
  ['flashcards_create', /\b(?:question|frage).*(?:one side|vorderseite).*(?:answer|antwort).*(?:other|ruckseite|rückseite)|\b(?:pdf|lecture|vorlesung).*(?:into|zu)\s+(?:study\s+)?cards?\b/iu],
  ['examforge_create', /\b(?:create|make|erstelle).*(?:exam|test|questions|prufung|prüfung|fragen)\b|\btest me\b/iu],
  ['deep_learn_create', /\b(?:really understand|teach me deeply|full lesson|like a professor|wie ein professor)\b/iu]
];

export function detectStudyIntent(message: string): DetectedStudyIntent {
  const text = normaliseIntentText(message);
  const command = COMMAND_RE.test(text);
  const shortCommand = text.split(' ').length <= 3;
  const candidates: Array<{ intent: Exclude<StudyToolIntent, 'unknown'>; score: number; method: IntentResolutionMethod; phrase: string }> = [];
  for (const [intent, aliases] of Object.entries(STUDY_TOOL_INTENT_ALIASES) as Array<[Exclude<StudyToolIntent, 'unknown'>, string[]]>) {
    for (const alias of aliases) {
      const normalAlias = normaliseIntentText(alias);
      const exact = text === normalAlias;
      const contained = text.includes(normalAlias) && (command || intent === 'note_save' || shortCommand || /\b(?:from|aus)\s+(?:this|the|dies)/iu.test(text));
      if (exact || contained) candidates.push({ intent, score: exact ? 0.99 : 0.96, method: exact ? 'exact' : 'normalised', phrase: normalAlias });
      if ((shortCommand || command) && normalAlias.split(' ').length <= 3 && sortedTokenKey(text.replace(COMMAND_RE, '').replace(/\b(?:me|a|an|the|this|from|please|pls|pdf)\b/gu, '').trim()) === sortedTokenKey(normalAlias)) {
        candidates.push({ intent, score: 0.94, method: 'token_order', phrase: normalAlias });
      }
      if (command || shortCommand) {
        const compactAlias = compactIntentText(alias);
        const words = text.split(' ');
        for (const word of [compactIntentText(text), ...words]) {
          if (compactAlias.length < 4 || word.length < 4) continue;
          const score = similarity(word, compactAlias);
          const threshold = compactAlias.length <= 6 ? 0.84 : 0.75;
          if (score >= threshold) candidates.push({ intent, score: Math.min(0.91, score), method: 'fuzzy', phrase: word });
        }
      }
    }
  }
  if (command) for (const [intent, pattern] of semantic) if (pattern.test(text)) candidates.push({ intent: intent as Exclude<StudyToolIntent, 'unknown'>, score: 0.88, method: 'semantic', phrase: text.slice(0, 80) });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const ambiguous = best && candidates.some((candidate) => candidate.intent !== best.intent && Math.abs(candidate.score - best.score) < 0.04);
  const blocked = INFORMATION_RE.test(text) && !command;
  const intent = !best || ambiguous || blocked ? 'unknown' : best.intent;
  const confidence = intent === 'unknown' ? (ambiguous ? 0.6 : 0) : (best?.score ?? 0);
  const extractedParameters = params(text, intent);
  const sourceMatch = text.match(/\b(?:from|use|aus|nutze)\s+(this pdf|this document|current page|whole course|[\p{L}\p{N}][\p{L}\p{N} ._-]*\.(?:pdf|docx?))\b/iu);
  return {
    intent,
    confidence,
    explicitSourceReference: !!sourceMatch,
    sourcePhrase: sourceMatch?.[1],
    extractedParameters,
    missingRequiredParameters: intent === 'deep_learn_create' && !/\b(?:about|on|topic|thema)\s+.+/iu.test(text) ? ['topic'] : [],
    shouldOpenConfiguration: intent !== 'unknown' && confidence >= AUTO_OPEN_CONFIGURATION_THRESHOLD,
    resolutionMethod: best?.method || 'none',
    matchedPhrase: best?.phrase
  };
}

// Existing shell compatibility. Interactive tools are deliberately proposed but
// not executed by this shim until their configuration card confirms the action.
export type StudyIntent = 'daily_mission' | 'summary' | 'notes' | 'cheatsheet';
export interface IntentRoute { intent: StudyIntent; action: 'create_or_show'; confidence: number; needsClarification: boolean; target: { courseId: string | null }; }

export function routeStudyIntent(message: string, courseId: string | null): IntentRoute | null {
  const daily = /\b(?:daily mission|study today|to-?do list|plan my study day)\b/iu.test(message);
  if (daily) return { intent: 'daily_mission', action: 'create_or_show', confidence: 0.95, needsClarification: false, target: { courseId } };
  const detected = detectStudyIntent(message);
  const map: Partial<Record<StudyToolIntent, StudyIntent>> = { summary_generate: 'summary', notes_generate: 'notes', cheatsheet_create: 'cheatsheet' };
  const intent = map[detected.intent];
  if (!intent || detected.confidence < SUGGEST_INTENT_THRESHOLD) return null;
  return { intent, action: 'create_or_show', confidence: detected.confidence, needsClarification: !courseId, target: { courseId } };
}

// Legacy AI-panel contract retained while both chat surfaces converge on the
// canonical detector.
export type ChatIntent = 'daily_mission' | 'weekly_mission' | 'summary' | 'notes' | 'cheatsheet' | 'clarification_needed' | 'normal_question';
export interface IntentResult { intent: ChatIntent; confidence: 'high' | 'medium' | 'low'; scope?: 'global' | 'course'; target?: string; needsClarification: boolean; clarificationQuestion?: string; }
export function detectIntent(message: string, context: { activeCourseId?: string; activeCourseTitle?: string }): IntentResult {
  if (/\bweekly mission|study this week|plan my (?:study )?week\b/iu.test(message)) return { intent: 'weekly_mission', confidence: 'high', scope: 'global', needsClarification: false };
  if (/\bdaily mission|study today|to-?do list|plan my study day\b/iu.test(message)) return { intent: 'daily_mission', confidence: 'high', scope: 'global', needsClarification: false };
  const detected = detectStudyIntent(message);
  const map: Partial<Record<StudyToolIntent, ChatIntent>> = { summary_generate: 'summary', notes_generate: 'notes', cheatsheet_create: 'cheatsheet' };
  const intent = map[detected.intent] || 'normal_question';
  const actionable = intent !== 'normal_question';
  return { intent, confidence: detected.confidence >= AUTO_OPEN_CONFIGURATION_THRESHOLD ? 'high' : detected.confidence >= SUGGEST_INTENT_THRESHOLD ? 'medium' : 'low', target: context.activeCourseTitle, needsClarification: actionable && !context.activeCourseId, clarificationQuestion: actionable && !context.activeCourseId ? 'Which course or file should I use?' : undefined };
}
