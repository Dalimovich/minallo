export interface ClassifiedAiError {
  code: string;
  title: string;
  message: string;
  retryable: boolean;
  preservePartialAnswer: boolean;
  action: 'retry' | 'continue' | 'sign_in' | 'read_current_page' | 'none';
  stage?: string;
}

type ErrorDetails = Omit<ClassifiedAiError, 'code'>;
const typedErrors: Record<string, ErrorDetails> = {
  request_superseded: { title: 'Response replaced', message: 'This answer was replaced by your newer question.', retryable: false, preservePartialAnswer: false, action: 'none' },
  stream_ended_without_terminal_event: { title: 'Answer interrupted', message: 'The connection ended before the answer was confirmed complete.', retryable: true, preservePartialAnswer: true, action: 'continue' },
  stream_inactivity_timeout: { title: 'Connection stalled', message: 'The tutor stopped sending updates. Please retry.', retryable: true, preservePartialAnswer: true, action: 'continue' },
  empty_completed_response: { title: 'Empty answer', message: 'The tutor finished without returning an answer.', retryable: true, preservePartialAnswer: false, action: 'retry' },
  internal_error: { title: 'Minallo could not finish this response', message: 'Your question and document context are preserved.', retryable: true, preservePartialAnswer: true, action: 'retry' },
  internal_stream_error: { title: 'Minallo could not finish this response', message: 'Your question and document context are preserved.', retryable: true, preservePartialAnswer: true, action: 'retry' },
  retrieval_timeout: { title: 'Document search took too long', message: 'Your file and question are still here.', retryable: true, preservePartialAnswer: true, action: 'retry' },
  visual_page_render_failed: { title: 'Visual page reading paused', message: 'Minallo could not inspect the visual markings on this page.', retryable: true, preservePartialAnswer: true, action: 'read_current_page' },
  generation_timeout: { title: 'The response took too long', message: 'Your grounded context is preserved and the answer can be retried.', retryable: true, preservePartialAnswer: true, action: 'retry' },
  shared_generation_check_failed: { title: 'Chat state unavailable', message: 'Minallo could not verify the active response state.', retryable: true, preservePartialAnswer: false, action: 'retry' },
  generation_state_unavailable: { title: 'Chat state unavailable', message: 'Minallo could not verify the active response state.', retryable: true, preservePartialAnswer: false, action: 'retry' },
  document_access_revoked: { title: 'Document access changed', message: 'Reopen the document before trying again.', retryable: false, preservePartialAnswer: false, action: 'read_current_page' },
  visible_page_snapshot_unstable: { title: 'Page changed', message: 'Keep the PDF page open and retry.', retryable: true, preservePartialAnswer: false, action: 'read_current_page' },
  visible_page_capture_failed: { title: 'Page could not be read', message: 'Reopen the visible PDF page and retry.', retryable: true, preservePartialAnswer: false, action: 'read_current_page' },
  original_pdf_context_unavailable: { title: 'Original PDF needed', message: 'Reopen the PDF used for this response, then continue.', retryable: true, preservePartialAnswer: true, action: 'read_current_page' },
  stream_transport_interrupted: { title: 'Connection interrupted', message: 'The saved response can be continued.', retryable: true, preservePartialAnswer: true, action: 'continue' },
  request_state_unavailable: { title: 'Response state unavailable', message: 'Minallo could not confirm the saved request state yet.', retryable: true, preservePartialAnswer: true, action: 'retry' },
  conversation_creation_failed: { title: 'Chat could not be saved', message: 'Minallo could not create this conversation.', retryable: true, preservePartialAnswer: false, action: 'retry' },
  session_expired: { title: 'Session expired', message: 'Please sign in again, then retry.', retryable: false, preservePartialAnswer: false, action: 'sign_in' },
  session_refresh_failed: { title: 'Session refresh failed', message: 'Please check your connection and sign in again if needed.', retryable: true, preservePartialAnswer: false, action: 'sign_in' },
  rag_service_unavailable: { title: 'Course search unavailable', message: 'Course-file search is temporarily unavailable.', retryable: true, preservePartialAnswer: false, action: 'retry' },
};

/** Classify typed failures first; message matching is only a legacy fallback. */
export function classifyAiError(error: unknown): ClassifiedAiError {
  const typed = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown; metadata?: { stage?: unknown }; stage?: unknown } : null;
  const code = typeof typed?.code === 'string' ? typed.code : '';
  if (typedErrors[code]) {
    const known = typedErrors[code];
    const retryable = typeof typed?.retryable === 'boolean' ? typed.retryable : known.retryable;
    const result: ClassifiedAiError = {
      code, ...known, retryable,
      action: retryable ? known.action : 'none',
    };
    const stage = typed?.stage || typed?.metadata?.stage;
    if (typeof stage === 'string' && stage) result.stage = stage;
    return result;
  }

  const raw = error instanceof Error ? error.message : String(error || '');
  const msg = raw.toLowerCase();
  let message = 'Something interrupted the response. Please try again—your chat is still here.';
  if (/question is too long|message.{0,20}too long|payload too large|\b413\b/.test(msg))
    message = 'That message is a little too long for one request. Please shorten it or send it in smaller parts.';
  else if (/openfilecontext is too long|context.{0,20}too long|maximum context|token limit/.test(msg))
    message = 'There is a bit too much material to process at once. Try selecting fewer pages or asking about a smaller section.';
  else if (/\b401\b|invalid or expired token|session_expired|empty token|authorization/.test(msg))
    message = 'Your session needs a quick refresh. Please sign in again, then retry your question.';
  else if (/\b403\b|forbidden|permission|not allowed/.test(msg))
    message = "I can't access that course material right now. Please check that the file belongs to this course and try again.";
  else if (/\b404\b|document not found|course not found|no content found/.test(msg))
    message = "I couldn't find the selected material. Reopen the file or choose another course file, then try again.";
  else if (/\b429\b|rate.?limit|too many requests|quota/.test(msg))
    message = "I'm receiving lots of questions right now. Please wait a moment and try again.";
  else if (/timeout|timed out|aborterror|gateway timeout|\b504\b/.test(msg))
    message = 'That took longer than expected. Your question is safe—please try again.';
  else if (/network|failed to fetch|load failed|could not reach|offline|connection/.test(msg))
    message = "I couldn't connect just now. Check your internet connection and try again in a moment.";
  else if (/\b5\d\d\b|internal error|service unavailable|temporarily unavailable|generation failed|upstream/.test(msg))
    message = "I couldn't finish that response just now. Please try again in a moment.";

  return { code: code || 'unknown_error', title: 'Could not finish', message, retryable: typed?.retryable !== false, preservePartialAnswer: false, action: 'retry' };
}

export function friendlyAiErrorMessage(error: unknown): string {
  return classifyAiError(error).message;
}
