/** Convert technical AI/API failures into calm, actionable student-facing copy. */
export function friendlyAiErrorMessage(error: unknown): string {
  const typed = error && typeof error === 'object' ? error as {
    code?: unknown; message?: unknown; retryable?: unknown;
  } : null;
  const code = typeof typed?.code === 'string' ? typed.code : '';
  const typedMessages: Record<string, string> = {
    request_superseded: 'This answer was replaced by your newer question.',
    document_access_revoked: 'Access to this document changed while I was answering. Reopen the file and try again.',
    generation_state_unavailable: 'I could not confirm this chat’s current state. Please retry your question.',
    visible_page_snapshot_unstable: 'The PDF page changed while I was reading it. Keep the page open and retry.',
    visible_page_capture_failed: 'I could not capture the visible PDF page. Reopen that page and retry.',
    empty_completed_response: 'The tutor finished without returning an answer. Please retry.',
    stream_ended_without_terminal_event: 'The connection ended before the answer was confirmed complete. Please retry.',
    internal_stream_error: 'The tutor hit an internal error while answering. Please retry in a moment.',
  };
  if (typedMessages[code]) return typedMessages[code];
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
