// Intent router — intercepts study-planning commands before they reach the AI.
//
// detectIntent() is a pure function: given a user message and optional active
// course context, it returns a structured IntentResult that the chat send
// handler can branch on without ever calling the AI for these local actions.

export type ChatIntent =
  | 'daily_mission'
  | 'weekly_mission'
  | 'summary'
  | 'notes'
  | 'cheatsheet'
  | 'clarification_needed'
  | 'normal_question';

export interface IntentResult {
  intent: ChatIntent;
  confidence: 'high' | 'medium' | 'low';
  scope?: 'global' | 'course'; // for mission intents
  target?: string; // course name or file name if detected
  needsClarification: boolean;
  clarificationQuestion?: string;
}

// ── Blocking patterns (return normal_question immediately) ──────────────────
// These match "what is a to-do", "how do I...", etc. and must beat all other
// patterns so purely informational questions never trigger an action.
const BLOCKING_PATTERNS: RegExp[] = [
  /\bwhat\s+(is|are)\s+(a|an|the)\s+(to-?do|summary|cheatsheet|cheat\s*sheet|note|plan|mission)\b/i,
  /\bhow\s+(do|does|can|should)\s+(i|you|one|we)\b/i,
  /\bwhy\s+(is|are|do|does|did|would|should)\b/i,
  /\bexplain\s+(what|how|why|the|a|an)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bwhat\s+(are|is)\s+the\s+(benefits|advantages|purpose|point|difference|meaning)\b/i
];

// ── Trigger patterns ────────────────────────────────────────────────────────

const DAILY_MISSION_PATTERNS: RegExp[] = [
  /\bto-?do\s+list\b/i,
  /\bto\s+do\s+list\b/i,
  /\bwhat\s+should\s+i\s+study\s+today\b/i,
  /\bstudy\s+today\b/i,
  /\btoday'?s?\s+mission\b/i,
  /\bdaily\s+mission\b/i,
  /\bplan\s+(my\s+)?study\s+day\b/i,
  /\bplan\s+(my\s+)?study\s+plan\s+(for\s+today)?\b/i,
  /\bmake\s+(me\s+)?a\s+(study\s+)?plan(\s+for\s+today)?\b/i,
  /\bmake\s+(me\s+)?a\s+to-?do\b/i,
  /^to-?do$/i,
  /^daily\s+mission$/i,
  /^study\s+mission$/i
];

const WEEKLY_MISSION_PATTERNS: RegExp[] = [
  /\bwhat\s+should\s+i\s+study\s+this\s+week\b/i,
  /\bstudy\s+this\s+week\b/i,
  /\bweekly\s+mission\b/i,
  /\bplan\s+(my\s+)?study\s+week\b/i,
  /\bplan\s+(my\s+)?week\b/i,
  /\bweekly\s+plan\b/i,
  /\bweek\s+plan\b/i,
  /\bwhat\s+to\s+study\s+this\s+week\b/i,
  /^weekly\s+mission$/i
];

const SUMMARY_PATTERNS: RegExp[] = [
  /\bsummarize(\s+(this|the))?\b/i,
  /\bmake\s+(a\s+)?summary\b/i,
  /\bcreate\s+(a\s+)?summary\b/i,
  /\bsummary\s+of(\s+(this|the))?\b/i,
  /^summary$/i,
  /^summarize$/i
];

const NOTES_PATTERNS: RegExp[] = [
  /\bmake\s+(me\s+)?(study\s+)?notes\b/i,
  /\bcreate\s+notes\b/i,
  /\bgenerate\s+notes\b/i,
  /\btake\s+notes\b/i,
  /\bnotes\s+from\s+(this|the)\b/i,
  /^notes$/i,
  /^study\s+notes$/i
];

const CHEATSHEET_PATTERNS: RegExp[] = [
  /\b(make|create|generate)\s+(a\s+)?cheat\s*sheet\b/i,
  /\b(make|create|generate)\s+(a\s+)?formula\s+sheet\b/i,
  /\b(make|create|generate)\s+(a\s+)?reference\s+sheet\b/i,
  /^cheat\s*sheet$/i,
  /^cheatsheet$/i,
  /^formula\s+sheet$/i
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── Typo-tolerant fallback ──────────────────────────────────────────────────
// A user who types just the skill word but misspells it ("cheactsheet",
// "summry", "noets") clearly still wants that skill. We only fuzzy-match SHORT,
// command-like inputs (≤ 3 words, ≤ 24 chars) so a real question is never
// reinterpreted as a command.
const FUZZY_INTENT_WORDS: { intent: ChatIntent; word: string }[] = [
  { intent: 'cheatsheet', word: 'cheatsheet' },
  { intent: 'cheatsheet', word: 'cheat sheet' },
  { intent: 'cheatsheet', word: 'formula sheet' },
  { intent: 'summary', word: 'summary' },
  { intent: 'summary', word: 'summarize' },
  // 'notes' is intentionally excluded from fuzzy matching: at 5 chars it
  // collides with real words ("nodes", "noted", "votes"). Exact "notes" still
  // routes via NOTES_PATTERNS.
  { intent: 'daily_mission', word: 'daily mission' },
  { intent: 'weekly_mission', word: 'weekly mission' }
];

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[] = [];
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j] as number;
      const sub = prev + (a[i - 1] === b[j - 1] ? 0 : 1);
      dp[j] = Math.min(tmp + 1, (dp[j - 1] as number) + 1, sub);
      prev = tmp;
    }
  }
  return dp[n] as number;
}

function fuzzyIntent(message: string): ChatIntent | null {
  const norm = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;
  // Command-like inputs only — never reinterpret a full sentence as a command.
  if (norm.split(' ').length > 3 || norm.length > 24) return null;
  let best: { intent: ChatIntent; dist: number } | null = null;
  for (const { intent, word } of FUZZY_INTENT_WORDS) {
    const dist = levenshtein(norm, word);
    // ~1 edit per 5 chars (clamped 1–2): catches "cheactsheet"/"summry"
    // without matching unrelated short words.
    const threshold = Math.min(2, Math.max(1, Math.floor(word.length / 5)));
    if (dist <= threshold && (!best || dist < best.dist)) best = { intent, dist };
  }
  return best ? best.intent : null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function detectIntent(
  message: string,
  context: { activeCourseId?: string; activeCourseTitle?: string }
): IntentResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: 'normal_question', confidence: 'high', needsClarification: false };
  }

  // Blocking check first — informational questions always pass through to AI.
  if (matchesAny(trimmed, BLOCKING_PATTERNS)) {
    return { intent: 'normal_question', confidence: 'high', needsClarification: false };
  }

  const hasCourse = !!context.activeCourseId;
  const courseTitle = context.activeCourseTitle || undefined;

  // ── daily_mission ────────────────────────────────────────────────────────
  if (matchesAny(trimmed, DAILY_MISSION_PATTERNS)) {
    return {
      intent: 'daily_mission',
      confidence: 'high',
      scope: 'global', // no clarification needed — default to global
      needsClarification: false
    };
  }

  // ── weekly_mission ───────────────────────────────────────────────────────
  if (matchesAny(trimmed, WEEKLY_MISSION_PATTERNS)) {
    return {
      intent: 'weekly_mission',
      confidence: 'high',
      scope: 'global',
      needsClarification: false
    };
  }

  // ── summary ──────────────────────────────────────────────────────────────
  if (matchesAny(trimmed, SUMMARY_PATTERNS)) {
    if (!hasCourse) {
      return {
        intent: 'summary',
        confidence: 'high',
        needsClarification: true,
        clarificationQuestion: 'Which course or file should I use?'
      };
    }
    return {
      intent: 'summary',
      confidence: 'high',
      target: courseTitle,
      needsClarification: false
    };
  }

  // ── notes ────────────────────────────────────────────────────────────────
  if (matchesAny(trimmed, NOTES_PATTERNS)) {
    if (!hasCourse) {
      return {
        intent: 'notes',
        confidence: 'high',
        needsClarification: true,
        clarificationQuestion: 'Which course or file should I use?'
      };
    }
    return {
      intent: 'notes',
      confidence: 'high',
      target: courseTitle,
      needsClarification: false
    };
  }

  // ── cheatsheet ───────────────────────────────────────────────────────────
  if (matchesAny(trimmed, CHEATSHEET_PATTERNS)) {
    if (!hasCourse) {
      return {
        intent: 'cheatsheet',
        confidence: 'high',
        needsClarification: true,
        clarificationQuestion: 'Which course or file should I use?'
      };
    }
    return {
      intent: 'cheatsheet',
      confidence: 'high',
      target: courseTitle,
      needsClarification: false
    };
  }

  // ── typo-tolerant fallback ─────────────────────────────────────────────────
  // No exact pattern matched — but a short, misspelled command word should
  // still route to its skill (e.g. "cheactsheet" → cheatsheet).
  const fuzzy = fuzzyIntent(trimmed);
  if (fuzzy === 'daily_mission' || fuzzy === 'weekly_mission') {
    return { intent: fuzzy, confidence: 'medium', scope: 'global', needsClarification: false };
  }
  if (fuzzy === 'summary' || fuzzy === 'notes' || fuzzy === 'cheatsheet') {
    if (!hasCourse) {
      return {
        intent: fuzzy,
        confidence: 'medium',
        needsClarification: true,
        clarificationQuestion: 'Which course or file should I use?'
      };
    }
    return { intent: fuzzy, confidence: 'medium', target: courseTitle, needsClarification: false };
  }

  // ── fallthrough ──────────────────────────────────────────────────────────
  return { intent: 'normal_question', confidence: 'high', needsClarification: false };
}

// ── Backward-compatibility shim for chatbot-new/shell.ts ────────────────────
// shell.ts calls routeStudyIntent(text, courseId) and reads:
//   .intent, .needsClarification, .target.courseId

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

export function routeStudyIntent(message: string, courseId: string | null): IntentRoute | null {
  const result = detectIntent(message, {
    activeCourseId: courseId || undefined,
    activeCourseTitle: undefined
  });
  if (result.intent === 'normal_question' || result.intent === 'weekly_mission') return null;
  // clarification_needed is never returned by detectIntent directly —
  // needsClarification is the flag instead.
  const intent = result.intent as StudyIntent;
  return {
    intent,
    action: 'create_or_show',
    confidence: 0.9,
    needsClarification: result.needsClarification,
    target: { courseId }
  };
}
