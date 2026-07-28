// SM-2 style spaced-repetition scheduler for flashcards.
//
// Pure, side-effect-free functions so they can be unit-tested in isolation and
// run unchanged on the Workers runtime. The Cloudflare Pages Function
// (backend/functions/study-flashcard-review.ts) calls `scheduleNext` to compute
// the next review state from the current state + the learner's rating.
//
// The algorithm is the classic SM-2 with the four-button Anki-style mapping:
//   • again — lapse: reset interval, drop ease, schedule for ~1 day (re-learn soon).
//   • hard  — small interval growth (×1.2), ease drops a little.
//   • good  — standard SM-2 growth (×ease).
//   • easy  — bigger growth (×ease×easyBonus), ease rises.
//
// Ease factor is floored at MIN_EASE (1.3, the SM-2 minimum) so a card can never
// spiral into sub-day intervals forever.

export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy';

export interface ReviewState {
  /** Current inter-review interval in days. 0 for a brand-new / never-graduated card. */
  intervalDays: number;
  /** SM-2 ease factor, >= 1.3. Defaults to 2.5 for new cards. */
  easeFactor: number;
  /** Count of consecutive successful (>= good) reviews. */
  reviewCount: number;
  /** Number of times the card has lapsed (rated `again`). */
  lapseCount: number;
}

export interface ScheduledReview extends ReviewState {
  /** ISO timestamp for the next due date. */
  dueAt: string;
  /** The rating that produced this state. */
  rating: FlashcardRating;
}

export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;

// First two successful intervals are fixed (the SM-2 "graduating" steps), after
// which growth becomes multiplicative by the ease factor.
const FIRST_INTERVAL_DAYS = 1;
const SECOND_INTERVAL_DAYS = 6;

// Multipliers / ease deltas per rating.
const HARD_INTERVAL_MULT = 1.2;
const EASY_BONUS = 1.3;
const AGAIN_INTERVAL_DAYS = 1; // re-learn within a day after a lapse

const EASE_DELTA: Record<FlashcardRating, number> = {
  again: -0.20,
  hard: -0.15,
  good: 0,
  easy: +0.15,
};

const VALID_RATINGS: ReadonlySet<string> = new Set(['again', 'hard', 'good', 'easy']);

export function isValidRating(value: unknown): value is FlashcardRating {
  return typeof value === 'string' && VALID_RATINGS.has(value);
}

function clampEase(ease: number): number {
  if (!Number.isFinite(ease)) return DEFAULT_EASE;
  return Math.max(MIN_EASE, ease);
}

/** Normalize a possibly-missing/garbage stored state into safe defaults. */
export function normalizeState(partial: Partial<ReviewState> | null | undefined): ReviewState {
  const p = partial || {};
  const intervalDays = Number.isFinite(p.intervalDays) && (p.intervalDays as number) >= 0
    ? (p.intervalDays as number)
    : 0;
  const easeFactor = clampEase(Number.isFinite(p.easeFactor) ? (p.easeFactor as number) : DEFAULT_EASE);
  const reviewCount = Number.isFinite(p.reviewCount) && (p.reviewCount as number) >= 0
    ? Math.floor(p.reviewCount as number)
    : 0;
  const lapseCount = Number.isFinite(p.lapseCount) && (p.lapseCount as number) >= 0
    ? Math.floor(p.lapseCount as number)
    : 0;
  return { intervalDays, easeFactor, reviewCount, lapseCount };
}

function addDays(fromMs: number, days: number): string {
  const ms = fromMs + Math.max(0, days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Compute the next review state from the current state and a rating.
 *
 * @param current  Current (possibly partial / missing) review state.
 * @param rating   One of again|hard|good|easy.
 * @param nowMs    Current time in ms (injectable for tests). Defaults to Date.now().
 */
export function scheduleNext(
  current: Partial<ReviewState> | null | undefined,
  rating: FlashcardRating,
  nowMs: number = Date.now()
): ScheduledReview {
  const state = normalizeState(current);
  const ease = clampEase(state.easeFactor + (EASE_DELTA[rating] ?? 0));

  // Lapse: reset growth, schedule a quick re-learn, bump lapse count.
  if (rating === 'again') {
    return {
      intervalDays: 0,
      easeFactor: ease,
      reviewCount: 0,
      lapseCount: state.lapseCount + 1,
      dueAt: addDays(nowMs, AGAIN_INTERVAL_DAYS),
      rating,
    };
  }

  const nextReviewCount = state.reviewCount + 1;
  let intervalDays: number;

  if (nextReviewCount === 1) {
    // First successful review.
    intervalDays = rating === 'easy' ? SECOND_INTERVAL_DAYS : FIRST_INTERVAL_DAYS;
  } else if (nextReviewCount === 2 && state.intervalDays < SECOND_INTERVAL_DAYS) {
    intervalDays = SECOND_INTERVAL_DAYS;
  } else {
    const base = state.intervalDays > 0 ? state.intervalDays : FIRST_INTERVAL_DAYS;
    if (rating === 'hard') {
      intervalDays = base * HARD_INTERVAL_MULT;
    } else if (rating === 'easy') {
      intervalDays = base * ease * EASY_BONUS;
    } else {
      intervalDays = base * ease;
    }
  }

  // Always grow by at least a day so successive reviews can't collapse to "now".
  intervalDays = Math.max(1, Math.round(intervalDays * 100) / 100);

  return {
    intervalDays,
    easeFactor: ease,
    reviewCount: nextReviewCount,
    lapseCount: state.lapseCount,
    dueAt: addDays(nowMs, intervalDays),
    rating,
  };
}
