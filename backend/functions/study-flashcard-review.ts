// GET/POST /api/study/flashcard-review
//
// Spaced-repetition (SM-2) review state for flashcards (Stage 3).
//
//   GET  ?deckId=<uuid>
//       → { reviews: [{ card_index, due_at, interval_days, ease_factor,
//                        review_count, lapse_count, rating, last_reviewed_at }] }
//     Returns only the cards the learner has actually rated. Cards with no row
//     are treated by the client as "new, due now" (see migration + flashcards.js).
//
//   POST { deckId, cardIndex, rating }   rating ∈ again|hard|good|easy
//       → { review: <the upserted row> }
//     Computes the next SM-2 state server-side and upserts one row.
//
// Auth: Supabase JWT (verifySupabaseToken). No subscription gate — recording a
// review is cheap and must keep working for any studyable deck, mirroring the
// direct-to-Supabase deck progress writes the flashcards UI already does.
// Deck ownership is verified before any write so a user can only schedule reviews
// on their own decks.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { isValidRating, scheduleNext } from '../lib/flashcard-sr';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CARD_INDEX = 100000; // generous upper bound; decks are capped at 24 cards

interface ReviewRow {
  card_index: number;
  due_at: string;
  interval_days: number;
  ease_factor: number;
  review_count: number;
  lapse_count: number;
  rating: string | null;
  last_reviewed_at: string | null;
}

function deckIdFromQuery(event: NetlifyEvent): string | null {
  const q = event.queryStringParameters;
  if (q && typeof q.deckId === 'string') return q.deckId;
  const match = String(event.path || '').match(/[?&]deckId=([^&]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

/** Confirm the deck exists and belongs to the user. */
async function userOwnsDeck(
  serviceKey: string,
  userId: string,
  deckId: string
): Promise<boolean> {
  const res = await supaRequest<Array<{ id: string }>>(
    'GET',
    'flashcard_decks?id=eq.' + encodeURIComponent(deckId) +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&select=id&limit=1',
    null,
    serviceKey
  );
  return Array.isArray(res.body) && res.body.length > 0;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // ── GET: list this deck's review state ─────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const deckId = deckIdFromQuery(event);
    if (!deckId || !UUID_RE.test(deckId)) return fail(400, 'Valid deckId is required');

    const res = await supaRequest<ReviewRow[]>(
      'GET',
      'flashcard_review_state?user_id=eq.' + encodeURIComponent(user.id) +
        '&deck_id=eq.' + encodeURIComponent(deckId) +
        '&select=card_index,due_at,interval_days,ease_factor,review_count,lapse_count,rating,last_reviewed_at' +
        '&order=due_at.asc',
      null,
      serviceKey
    );
    return jsonResponse(200, { reviews: Array.isArray(res.body) ? res.body : [] });
  }

  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  // ── POST: record a rating, compute + persist next SM-2 state ───────────────
  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const deckId = typeof body.deckId === 'string' ? body.deckId : '';
  if (!deckId || !UUID_RE.test(deckId)) return fail(400, 'Valid deckId is required');

  const cardIndexRaw = body.cardIndex;
  const cardIndex = typeof cardIndexRaw === 'number' ? cardIndexRaw : Number(cardIndexRaw);
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > MAX_CARD_INDEX) {
    return fail(400, 'cardIndex must be a non-negative integer');
  }

  const rating = body.rating;
  if (!isValidRating(rating)) return fail(400, 'rating must be one of again|hard|good|easy');

  if (!(await userOwnsDeck(serviceKey, user.id, deckId))) {
    return fail(404, 'Deck not found');
  }

  // Read current state (if any) so growth/ease compound correctly.
  const currentRes = await supaRequest<ReviewRow[]>(
    'GET',
    'flashcard_review_state?user_id=eq.' + encodeURIComponent(user.id) +
      '&deck_id=eq.' + encodeURIComponent(deckId) +
      '&card_index=eq.' + cardIndex +
      '&select=interval_days,ease_factor,review_count,lapse_count&limit=1',
    null,
    serviceKey
  );
  const prev = Array.isArray(currentRes.body) ? currentRes.body[0] : undefined;

  const next = scheduleNext(
    prev
      ? {
          intervalDays: prev.interval_days,
          easeFactor: prev.ease_factor,
          reviewCount: prev.review_count,
          lapseCount: prev.lapse_count,
        }
      : null,
    rating
  );

  const now = new Date().toISOString();
  const upsertRow = {
    user_id: user.id,
    deck_id: deckId,
    card_index: cardIndex,
    due_at: next.dueAt,
    interval_days: next.intervalDays,
    ease_factor: next.easeFactor,
    review_count: next.reviewCount,
    lapse_count: next.lapseCount,
    rating: next.rating,
    last_reviewed_at: now,
    updated_at: now,
  };

  const res = await supaRequest<ReviewRow[]>(
    'POST',
    'flashcard_review_state?on_conflict=user_id,deck_id,card_index',
    upsertRow,
    serviceKey,
    { Prefer: 'resolution=merge-duplicates,return=representation' }
  );

  if (res.status >= 300) {
    console.error('[study-flashcard-review] upsert failed', res.status, res.body);
    return fail(500, 'Failed to record review');
  }

  const row = Array.isArray(res.body) ? res.body[0] ?? null : null;
  return jsonResponse(200, { review: row });
};
