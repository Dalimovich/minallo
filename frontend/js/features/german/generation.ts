// One lifecycle for every German AI generation (Wortschatz, Grammatik, Lesen,
// Hören, Sprachbausteine, Schreiben task). A request may never sit on a static
// "Generating…" card: it either completes, is cancelled by the learner (or a
// newer request), or hits a client deadline and becomes an explicit error the
// caller renders with Retry. Progress text is honest staged wording — never a
// fake percentage.

export type GenKind = 'practice' | 'exam';
export type GenFailureCode = 'timeout' | 'cancelled' | 'failed';

// Safety ceilings, chosen below the edge's own hard limit (Cloudflare drops
// long-held requests) — tune from measured production timings
// (response.diagnostics.totalMs), not by guessing.
export const GENERATION_DEADLINE_MS: Record<GenKind, number> = { practice: 60_000, exam: 100_000 };

export class GenerationError extends Error {
  code: GenFailureCode;
  status: number;
  reference: string;
  constructor(code: GenFailureCode, message: string, status = 0, reference = '') {
    super(message);
    this.code = code;
    this.status = status;
    this.reference = reference;
  }
}

export interface GenStages {
  start: string;
  working: string;
  slow: string;
}

const DEFAULT_STAGES: Record<GenKind, GenStages> = {
  practice: {
    start: 'Creating your practice…',
    working: 'Still working — checking the generated questions…',
    slow: 'This is taking longer than usual.',
  },
  exam: {
    start: 'Creating your exercise…',
    working: 'Still working — checking the generated questions…',
    slow: 'This is taking longer than usual.',
  },
};

export function stageMessage(elapsedMs: number, stages: GenStages): string {
  if (elapsedMs < 8_000) return stages.start;
  if (elapsedMs < 30_000) return stages.working;
  return stages.slow;
}

/** Pulls a non-sensitive support reference ("ref abc123") out of an error body. */
export function extractReference(body: unknown): string {
  const b = body as { diagnostics?: { requestId?: string }; requestId?: string; detail?: unknown; error?: unknown } | null;
  const direct = b?.diagnostics?.requestId || b?.requestId;
  if (direct) return String(direct);
  const text = String(b?.detail ?? b?.error ?? '');
  const m = /\(ref ([a-f0-9]{6,32})\)/i.exec(text);
  return m ? (m[1] as string) : '';
}

export interface RunOptions<T> {
  kind: GenKind;
  /** Where the progress card is drawn; the caller overwrites it on completion. */
  el?: HTMLElement | null;
  stages?: Partial<GenStages>;
  deadlineMs?: number;
  request: (signal: AbortSignal) => Promise<T>;
}

export interface GenerationHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Starts one generation. Rejects with GenerationError. Always clears its timers,
 * so callers can reset their own busy flags in a `finally`.
 */
export function runGeneration<T>(opts: RunOptions<T>): GenerationHandle<T> {
  const controller = new AbortController();
  const stages: GenStages = { ...DEFAULT_STAGES[opts.kind], ...(opts.stages || {}) };
  const deadlineMs = opts.deadlineMs ?? GENERATION_DEADLINE_MS[opts.kind];
  const started = Date.now();
  let reason: GenFailureCode | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let rejectOuter: (e: GenerationError) => void = () => undefined;

  const draw = (): void => {
    const el = opts.el;
    if (!el) return;
    const elapsed = Date.now() - started;
    const msg = esc(stageMessage(elapsed, stages));
    const cancelBtn =
      elapsed >= 8_000 ? '<button type="button" class="gl-gen-cancel" data-gen-cancel="1">Cancel</button>' : '';
    // Exam surfaces (and their blank-state watchdogs) recognise this class as a
    // legitimate loading state.
    const cls = opts.kind === 'exam' ? 'gl-gen-progress gl-listen-generating' : 'gl-gen-progress';
    el.innerHTML =
      '<div class="' + cls + '" role="status" aria-live="polite">' +
      '<div class="gl-gen-progress-text">' + msg + '</div>' + cancelBtn + '</div>';
    const btn = el.querySelector('[data-gen-cancel]');
    if (btn) btn.addEventListener('click', () => cancel());
  };

  const cleanup = (): void => {
    if (tick) clearInterval(tick);
    if (deadline) clearTimeout(deadline);
    tick = null;
    deadline = null;
  };

  const cancel = (): void => {
    if (reason) return;
    reason = 'cancelled';
    controller.abort();
    rejectOuter(new GenerationError('cancelled', 'Cancelled'));
  };

  const promise = new Promise<T>((resolve, reject) => {
    rejectOuter = reject;
    draw();
    tick = setInterval(draw, 1_000);
    deadline = setTimeout(() => {
      if (reason) return;
      reason = 'timeout';
      controller.abort();
      reject(new GenerationError('timeout', 'Generation took too long.'));
    }, deadlineMs);
    opts
      .request(controller.signal)
      .then(resolve, (err: unknown) => {
        if (reason) return; // already rejected as timeout/cancelled
        if (err instanceof GenerationError) return reject(err);
        const e = err as { status?: number; reference?: string; message?: string } | null;
        reject(new GenerationError('failed', e?.message || 'Generation failed', e?.status || 0, e?.reference || ''));
      });
  }).finally(cleanup);

  return { promise, cancel };
}

/** Learner-facing text for a terminal failure, with the support reference. */
export function failureText(err: unknown, what = 'practice'): { title: string; detail: string; reference: string } {
  const e = err instanceof GenerationError ? err : null;
  if (e?.code === 'cancelled') return { title: 'Cancelled.', detail: '', reference: '' };
  if (e?.code === 'timeout' || e?.status === 504) {
    return { title: 'Generation took too long.', detail: 'Try again.', reference: e.reference };
  }
  return { title: `Couldn't create ${what}.`, detail: '', reference: e?.reference || '' };
}
