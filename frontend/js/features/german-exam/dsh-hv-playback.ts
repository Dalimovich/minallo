// DSH Hörverstehen two-play delivery — browser mirror of
// backend/python-ai/app/services/german_exams/dsh_hv_playback.py (the authoritative rule set).
// Both are checked against the SAME scripted vectors (tests/fixtures/dsh-hv-playback-vectors.json).
//
// MPO §10(1)1 / §10(4)1b: the lecture is presented exactly twice; 10 minutes of processing time follow the
// first and 40 minutes the second presentation. There is no third play and no play during a window.
//
// LIMITATION: this state lives in the browser (storage). A learner can clear it, so it protects against
// reloads, stale tabs and double clicks, not against deliberate tampering. A tamper-proof play count needs a
// server-side attempt record (table + endpoint + migration): FUTURE WORK.

export type HvPhase =
  | 'ready'
  | 'playing_1'
  | 'processing_1'
  | 'awaiting_play_2'
  | 'playing_2'
  | 'processing_2'
  | 'submitted'
  | 'expired';
export type HvEvent = 'start_play' | 'playback_ended' | 'tick' | 'submit';

export interface HvPlaybackState {
  schemaVersion: 1;
  attemptId: string;
  phase: HvPhase;
  playsStarted: number;
  playsCompleted: number;
  windowDeadlineMs: number | null;
}

export const HV_MAX_PLAYS = 2;
const PHASES: HvPhase[] = ['ready', 'playing_1', 'processing_1', 'awaiting_play_2', 'playing_2', 'processing_2', 'submitted', 'expired'];
/** Processing windows after presentation 1 and 2 (MPO §10(1)1); the manifest carries the same numbers. */
export const HV_WINDOWS_MS: Record<1 | 2, number> = { 1: 600_000, 2: 2_400_000 };

export class HvPlaybackError extends Error {}

export function newHvState(attemptId: string): HvPlaybackState {
  if (!attemptId) throw new HvPlaybackError('attemptId is required');
  return { schemaVersion: 1, attemptId, phase: 'ready', playsStarted: 0, playsCompleted: 0, windowDeadlineMs: null };
}

function validate(state: HvPlaybackState): void {
  if (!state || state.schemaVersion !== 1 || !PHASES.includes(state.phase)) throw new HvPlaybackError('invalid playback state');
  if (!Number.isInteger(state.playsStarted) || state.playsStarted < 0 || state.playsStarted > HV_MAX_PLAYS) {
    throw new HvPlaybackError('invalid play count');
  }
}

function tickState(state: HvPlaybackState, nowMs: number): HvPlaybackState {
  const deadline = state.windowDeadlineMs;
  if (deadline === null || nowMs < deadline) return state;
  if (state.phase === 'processing_1') return { ...state, phase: 'awaiting_play_2', windowDeadlineMs: null };
  if (state.phase === 'processing_2') return { ...state, phase: 'expired', windowDeadlineMs: null };
  return state;
}

export function advanceHv(state: HvPlaybackState, event: HvEvent | string, nowMs: number): HvPlaybackState {
  validate(state);
  if (!Number.isInteger(nowMs) || nowMs < 0) throw new HvPlaybackError('nowMs must be a non-negative integer');
  const current = tickState(state, nowMs); // a lapsed window always resolves first, whatever the event is
  const phase = current.phase;
  if (event === 'tick') return current;
  if (event === 'start_play') {
    if (phase === 'ready') return { ...current, phase: 'playing_1', playsStarted: 1 };
    if (phase === 'awaiting_play_2') return { ...current, phase: 'playing_2', playsStarted: 2 };
    throw new HvPlaybackError(`cannot start a play in phase ${phase}`);
  }
  if (event === 'playback_ended') {
    if (phase === 'playing_1' || phase === 'playing_2') {
      const n: 1 | 2 = phase === 'playing_1' ? 1 : 2;
      return { ...current, phase: n === 1 ? 'processing_1' : 'processing_2', playsCompleted: n, windowDeadlineMs: nowMs + HV_WINDOWS_MS[n] };
    }
    throw new HvPlaybackError(`no play is running in phase ${phase}`);
  }
  if (event === 'submit') {
    if (phase === 'processing_2') return { ...current, phase: 'submitted', windowDeadlineMs: null };
    throw new HvPlaybackError(`submission opens after the second presentation (phase ${phase})`);
  }
  throw new HvPlaybackError(`unknown event ${String(event)}`);
}

/** After a reload: an interrupted play counts as consumed and its window starts now; it is never re-granted. */
export function recoverHv(state: HvPlaybackState, nowMs: number): HvPlaybackState {
  validate(state);
  let next = state;
  if (next.phase === 'playing_1' || next.phase === 'playing_2') next = advanceHv(next, 'playback_ended', nowMs);
  return advanceHv(next, 'tick', nowMs);
}

export function canStartPlay(state: HvPlaybackState, nowMs: number): boolean {
  try {
    advanceHv(state, 'start_play', nowMs);
    return true;
  } catch {
    return false;
  }
}

export function remainingMs(state: HvPlaybackState, nowMs: number): number | null {
  const deadline = tickState(state, nowMs).windowDeadlineMs;
  return deadline === null ? null : Math.max(0, deadline - nowMs);
}

/**
 * Persisted controller. `beginPlay()` writes the new state to storage BEFORE it returns true, so the audio is
 * only started after the play is on record; a reload (or a second tab) after that can never see play 1 again.
 * With no usable storage it fails closed: no play can be started that could not be recorded.
 */
export class HvPlaybackController {
  private state: HvPlaybackState;
  private readonly key: string;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
    attemptId: string,
    private readonly now: () => number = Date.now
  ) {
    this.key = `dsh-hv-playback:${attemptId}`;
    let loaded: HvPlaybackState | null = null;
    try {
      const raw = storage?.getItem(this.key);
      if (raw) loaded = JSON.parse(raw) as HvPlaybackState;
    } catch {
      loaded = null;
    }
    try {
      this.state = loaded && loaded.attemptId === attemptId ? recoverHv(loaded, this.now()) : newHvState(attemptId);
    } catch {
      // A corrupt record must not restore a play: refuse to start anything rather than start over.
      this.state = { ...newHvState(attemptId), phase: 'expired' };
    }
    this.persist();
  }

  private persist(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.state));
      return true;
    } catch {
      return false;
    }
  }

  get snapshot(): HvPlaybackState {
    this.state = tickState(this.state, this.now());
    return this.state;
  }

  beginPlay(): boolean {
    const before = this.state;
    try {
      this.state = advanceHv(this.state, 'start_play', this.now());
    } catch {
      return false;
    }
    if (!this.persist()) {
      this.state = before; // could not be recorded: do not play
      return false;
    }
    return true;
  }

  endPlay(): void {
    this.state = advanceHv(this.state, 'playback_ended', this.now());
    this.persist();
  }

  submit(): void {
    this.state = advanceHv(this.state, 'submit', this.now());
    this.persist();
  }
}
