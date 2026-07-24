export interface AiVisualImage {
  mediaType: string;
  data: string;
  page?: number;
}

export interface LastAiImageContext {
  images: AiVisualImage[];
  courseId?: string;
  documentId?: string;
  fileName?: string;
  page?: number;
  conversationId?: string;
  questionThreadId?: string;
  timestamp: number;
  remainingTurns: number;
}

export interface CurrentVisualContext {
  courseId?: string;
  documentId?: string;
  fileName?: string;
  page?: number;
  conversationId?: string;
}

const VISUAL_CONTEXT_TTL_MS = 15 * 60 * 1000;

export function isLikelyVisualAssignmentQuestion(question: string): boolean {
  return (
    /\b(checkbox|check box|checked|tick|ticked|marked|matching|answer grid|diagram|table)\b/i.test(question) ||
    /\b(k[aä]stchen|angekreuzt|markiert|zuordnung|diagramm|tabelle)\b/i.test(question) ||
    /\b(?:numbers?|ziffern?|nummern?)\s*\d+\s*(?:bis|to|-|–)\s*\d+\b/i.test(question) ||
    /\b(?:task|exercise|problem|question|aufgabe|[uü]bung)\s*\d+(?:[.,]\d+)?\b/i.test(question)
  );
}

export function shouldReuseRecentVisualContext(
  question: string,
  context: LastAiImageContext | undefined,
  current: CurrentVisualContext,
  now: number = Date.now(),
): boolean {
  if (!context?.images?.length || context.remainingTurns <= 0) return false;
  if (now - context.timestamp > VISUAL_CONTEXT_TTL_MS) return false;
  if (context.courseId && context.courseId !== current.courseId) return false;
  if (context.documentId && context.documentId !== current.documentId) return false;
  if (context.fileName && context.fileName !== current.fileName) return false;
  if (context.conversationId && context.conversationId !== current.conversationId) return false;
  if (context.page && current.page && context.page !== current.page) return false;

  const visualReference =
    /\b(this|that|it|image|picture|screenshot|photo|shown|above|diagram|table|checkbox|mark)\b/i;
  const correctionOrContinuation =
    /\b(missing|missed|wrong|incorrect|again|complete|all|only|you said|you mentioned|check|recheck|correct|fix|number|remaining)\b/i;
  const formattingFollowUp =
    /\b(german|english|translate|explain|shorter|detail|table|list|format)\b/i;
  const shortFollowUp = question.trim().split(/\s+/).filter(Boolean).length <= 18;

  return visualReference.test(question) ||
    correctionOrContinuation.test(question) ||
    formattingFollowUp.test(question) ||
    shortFollowUp;
}
