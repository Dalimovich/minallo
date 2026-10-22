import { recordingBase64 } from '../speaking/speaking-audio.js';
import { writingExamRequest } from '../writing-coach/writing-exam.js';
import type { Feedback, ProductiveContent } from './productive-task.js';
import type { RecordingSubmitter } from './speaking-task.js';

/** Kept local (not imported from task-workspace.ts) to avoid a circular import,
 * mirroring WritingTaskEnvelope's own reason in writing-grader.ts. */
export interface SpeakingTaskEnvelope {
  exam: { profileId: string };
  part: { id: string };
}

/** Builds the real grader for TestDaF's independent single-recording Sprechen
 * tasks — replaces mountSpeaking's default "not connected" stub. No recording
 * is ever uploaded to storage first: recordingBase64() (the SAME helper the
 * other speaking feature already uses) turns the blob into base64 once, then
 * one request does transcription + grading server-side (POST /grade-speaking-
 * recording) and nothing is persisted. Reuses writingExamRequest (the same
 * low-level POST helper telc's Writing Coach exam mode already calls) rather
 * than a second fetch path. */
export function createSpeakingRecordingGrader(
  envelope: SpeakingTaskEnvelope,
  content: ProductiveContent,
  request: typeof writingExamRequest = writingExamRequest,
  toBase64: typeof recordingBase64 = recordingBase64,
): RecordingSubmitter {
  return async (blob, durationSeconds, signal) => {
    const audioBase64 = await toBase64(blob);
    return request<Feedback>('grade-speaking-recording', {
      profileId: envelope.exam.profileId,
      partId: envelope.part.id,
      task: content,
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      durationSeconds,
    }, signal);
  };
}
