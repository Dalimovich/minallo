import { authenticatedFetch } from '../../services/authenticated-fetch.js';

/** This workspace owns only its own recorder and Audio element. Never touches
 * Hören's audio queue or global speechSynthesis cancellation. */
export class SpeakingAudio {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private playbackAbort: AbortController | null = null;
  get recording(): boolean { return this.recorder?.state === 'recording'; }
  async record(onComplete: (blob: Blob) => void, onError: (error: Error) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Mikrofonaufnahme benötigt einen unterstützten Browser und HTTPS.');
    this.stopPlayback();
    const epoch = ++this.epoch;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { this.close(); throw new Error('Dieser Browser unterstützt kein kompatibles Aufnahmeformat.'); }
    try {
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      this.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { this.close(); onError(new Error('Die Mikrofonaufnahme ist fehlgeschlagen.')); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (this.limitTimer) clearTimeout(this.limitTimer);
        this.limitTimer = null;
        if (epoch !== this.epoch) return;
        this.recorder = null; this.stream = null;
        onComplete(new Blob(chunks, { type: mimeType }));
      };
      recorder.start(1000);
      this.limitTimer = setTimeout(() => this.stopRecording(), 4 * 60 * 1000);
    } catch (error) { this.close(); throw error; }
  }
  stopRecording(): void { if (this.recorder?.state === 'recording') this.recorder.stop(); }
  stopPlayback(): void {
    this.playbackAbort?.abort(); this.playbackAbort = null;
    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }
  }
  close(): void {
    this.epoch++;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.stopRecording();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.recorder = null;
    this.stopPlayback();
  }
  async play(text: string): Promise<void> {
    this.stopPlayback();
    const controller = new AbortController();
    this.playbackAbort = controller;
    // Split long partner presentations into bounded requests to existing TTS.
    const chunks: string[] = [];
    for (const word of text.split(/\s+/)) {
      const last = chunks.length - 1;
      if (last < 0 || (chunks[last]!.length + word.length + 1) > 1600) chunks.push(word);
      else chunks[last] += ` ${word}`;
    }
    const base = (window as unknown as { BACKEND_URL?: string }).BACKEND_URL || '';
    for (const chunk of chunks) {
      if (controller.signal.aborted) throw new DOMException('Playback stopped', 'AbortError');
      const res = await authenticatedFetch(`${base}/api/ai/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk, language: 'German' }), signal: controller.signal
      });
      if (!res.ok) throw new Error('Partneraudio ist momentan nicht verfügbar. Bitte erneut versuchen.');
      const data = await res.json() as { audioUrl: string };
      if (!data.audioUrl) throw new Error('Keine Audiodatei empfangen.');
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(data.audioUrl);
        this.audio = audio;
        const abort = () => { audio.pause(); cleanup(); reject(new DOMException('Playback stopped', 'AbortError')); };
        const cleanup = () => { controller.signal.removeEventListener('abort', abort); audio.onended = null; audio.onerror = null; };
        audio.onended = () => { cleanup(); resolve(); };
        audio.onerror = () => { cleanup(); reject(new Error('Audio konnte nicht abgespielt werden. Bitte erneut versuchen.')); };
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) { abort(); return; }
        void audio.play().catch(error => { cleanup(); reject(error); });
      });
    }
  }
}

export function recordingBase64(blob: Blob): Promise<string> {
  if (blob.size > 6 * 1024 * 1024) return Promise.reject(new Error('Aufnahme zu groß. Bitte kürzer aufnehmen.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Aufnahme konnte nicht gelesen werden.'));
    reader.readAsDataURL(blob);
  });
}
