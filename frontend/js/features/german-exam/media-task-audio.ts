import { authenticatedFetch } from '../../services/authenticated-fetch.js';
import type { SegmentClips } from './media-task.js';

/** Real network implementation of MediaDependencies.fetchClips (media-task.ts stays
 * dependency-free so its existing script-tag test harness needs no module shim — see that
 * file's own comment). Calls the SAME /api/ai/tts-batch endpoint practice.js's legacy lsPlayer
 * already uses for telc's Hören, via the SAME cache-then-Qwen3-TTS-then-signed-URL pipeline
 * (routers/tts.py) — no second TTS integration, no new storage. */
interface TTSBatchSegmentResult { id: string; audioUrl?: string | null; durationMs?: number; failed?: boolean }
interface TTSBatchResponse { segments: TTSBatchSegmentResult[]; degraded: boolean }

export async function fetchSegmentClips(
  segments: Array<{ id: string; text: string }>, signal: AbortSignal,
): Promise<SegmentClips | null> {
  const base = (window as unknown as { BACKEND_URL?: string }).BACKEND_URL || '';
  let response: Response;
  try {
    response = await authenticatedFetch(`${base}/api/ai/tts-batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments, language: 'German' }), signal,
    });
  } catch {
    return null; // network/abort failure — caller shows "media unavailable", never partial/fake audio
  }
  if (!response.ok) return null;
  const data = await response.json() as TTSBatchResponse;
  // degraded (ANY segment failed) means the whole batch falls back — never mix real clips with
  // a missing one, same rule practice.js's lsPlayer already enforces for telc's Hören.
  if (data.degraded) return null;
  const clips: SegmentClips = {};
  for (const seg of data.segments) {
    if (seg.failed || !seg.audioUrl) return null;
    clips[seg.id] = { url: seg.audioUrl, durationMs: seg.durationMs || 0 };
  }
  return clips;
}
