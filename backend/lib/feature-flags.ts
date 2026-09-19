import { optionalEnv } from './env';

// Sprechen (German Exam Engine speaking module) is fully implemented but
// deliberately cost-disabled — transcription, the AI conversation partner,
// grading, and TTS playback all carry real per-turn cost, and pronunciation/
// conversation quality hasn't been budgeted for yet. Default OFF (missing
// env var means disabled, not enabled) so a forgotten deploy config can
// never silently turn paid speaking traffic back on. Flip
// GERMAN_SPEAKING_ENABLED=true once ready to pay for it again — no code
// change needed, and none of the speaking implementation is deleted.
export function isGermanSpeakingEnabled(): boolean {
  return optionalEnv('GERMAN_SPEAKING_ENABLED', 'false') === 'true';
}
