export interface AiStreamErrorLike {
  code?: string;
  message?: string;
}

export function userFacingStreamError(evt: AiStreamErrorLike): string {
  switch (evt.code) {
    case 'visual_evidence_unreadable':
      return evt.message ||
        'I received the drawing, but one or more marked areas are not clear enough to verify. Please crop or select the relevant area.';
    case 'image_payload_too_large':
      return 'The drawing image was too large to process. Please attach a focused crop of the relevant area.';
    case 'visual_verification_timeout':
    case 'visual_verification_failed':
      return evt.message ||
        'The answer could not be visually verified, but this was a verification-service issue—not a conflict in your PDF.';
    case 'vision_model_unavailable':
      return 'The visual model is temporarily unavailable. Please try again shortly.';
    case 'stream_interrupted':
      return 'The response connection was interrupted before completion.';
    default:
      return evt.message ||
        `Minallo could not complete this request${evt.code ? ` (${evt.code})` : ''}.`;
  }
}
