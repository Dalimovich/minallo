/** Convert technical AI/API failures into calm, actionable student-facing copy. */
export function friendlyAiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const msg = raw.toLowerCase();

  if (/question is too long|message.{0,20}too long|payload too large|\b413\b/.test(msg))
    return 'That message is a little too long for one request. Please shorten it or send it in smaller parts.';
  if (/openfilecontext is too long|context.{0,20}too long|maximum context|token limit/.test(msg))
    return 'There is a bit too much material to process at once. Try selecting fewer pages or asking about a smaller section.';
  if (/\b401\b|invalid or expired token|session_expired|empty token|authorization/.test(msg))
    return 'Your session needs a quick refresh. Please sign in again, then retry your question.';
  if (/\b403\b|forbidden|permission|not allowed/.test(msg))
    return "I can't access that course material right now. Please check that the file belongs to this course and try again.";
  if (/\b404\b|document not found|course not found|no content found/.test(msg))
    return "I couldn't find the selected material. Reopen the file or choose another course file, then try again.";
  if (/\b429\b|rate.?limit|too many requests|quota/.test(msg))
    return "I'm receiving lots of questions right now. Please wait a moment and try again.";
  if (/timeout|timed out|aborterror|gateway timeout|\b504\b/.test(msg))
    return 'That took longer than expected. Your question is safe—please try again.';
  if (/network|failed to fetch|load failed|could not reach|offline|connection/.test(msg))
    return "I couldn't connect just now. Check your internet connection and try again in a moment.";
  if (/\b5\d\d\b|internal error|service unavailable|temporarily unavailable|generation failed|upstream/.test(msg))
    return "I couldn't finish that response just now. Please try again in a moment.";

  return "Something interrupted the response. Please try again—your chat is still here.";
}
