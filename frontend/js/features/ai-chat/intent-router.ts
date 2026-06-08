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
