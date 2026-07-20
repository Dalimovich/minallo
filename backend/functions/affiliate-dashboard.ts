import { requireEnv } from '../lib/env';
import { extractBearerToken, verifySupabaseToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { fail, jsonResponse } from '../lib/responses';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface PartnerRow { user_id: string; referral_code: string; created_at: string }
interface ProfileStatusRow { status?: string | null }
interface ReferralRow {
  id: string;
  signed_up_at: string;
  trial_started_at: string | null;
  subscribed_at: string | null;
}
interface CommissionRow {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  earned_at: string;
}

function codeFor(userId: string): string {
  return userId.replace(/-/g, '').slice(0, 12).toLowerCase();
}

async function authenticate(event: NetlifyEvent) {
  const token = extractBearerToken(event.headers);
  return token ? verifySupabaseToken(token) : null;
}

async function hasAffiliateStatus(serviceKey: string, userId: string): Promise<boolean> {
  const result = await supaRequest<ProfileStatusRow[]>(
    'GET',
    'profiles?id=eq.' + encodeURIComponent(userId) + '&select=status&limit=1',
    null,
    serviceKey
  );
  const profile = Array.isArray(result.body) ? result.body[0] : undefined;
  return String(profile?.status || '').toLowerCase() === 'affiliate';
}

async function ensureOwnerAffiliateStatus(
  serviceKey: string,
  user: { id: string; email?: string }
): Promise<boolean> {
  if (await hasAffiliateStatus(serviceKey, user.id)) return true;
  if (String(user.email || '').toLowerCase() !== 'medalimarima@gmail.com') return false;

  const update = await supaRequest(
    'PATCH',
    'profiles?id=eq.' + encodeURIComponent(user.id),
    { status: 'affiliate' },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
  if (update.status < 200 || update.status >= 300) return false;
  return hasAffiliateStatus(serviceKey, user.id);
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return fail(405, 'Method not allowed');
  }
  const user = await authenticate(event);
  if (!user) return fail(401, 'Sign in required');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (event.httpMethod === 'POST') {
    let body: { referralCode?: unknown } = {};
    try { body = JSON.parse(event.body || '{}') as { referralCode?: unknown }; }
    catch { return fail(400, 'Invalid JSON'); }
    const code = typeof body.referralCode === 'string' ? body.referralCode.trim().toLowerCase() : '';
    if (!/^[a-z0-9]{8,32}$/.test(code)) return fail(400, 'Invalid referral code');

    const partnerRes = await supaRequest<PartnerRow[]>(
      'GET',
      'affiliate_partners?referral_code=eq.' + encodeURIComponent(code) + '&select=user_id&limit=1',
      null,
      serviceKey
    );
    const partner = Array.isArray(partnerRes.body) ? partnerRes.body[0] : undefined;
    if (
      !partner ||
      partner.user_id === user.id ||
      !(await hasAffiliateStatus(serviceKey, partner.user_id))
    ) return fail(404, 'Referral link not found');

    const insert = await supaRequest(
      'POST',
      'affiliate_referrals?on_conflict=referred_user_id',
      { affiliate_user_id: partner.user_id, referred_user_id: user.id },
      serviceKey,
      { Prefer: 'resolution=ignore-duplicates,return=minimal' }
    );
    if (insert.status < 200 || insert.status >= 300) return fail(500, 'Could not save referral');
    return jsonResponse(200, { saved: true });
  }


  if (!(await ensureOwnerAffiliateStatus(serviceKey, user))) {
    return fail(403, 'Affiliate access required');
  }

  let partnerRes = await supaRequest<PartnerRow[]>(
    'GET',
    'affiliate_partners?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id,referral_code,created_at&limit=1',
    null,
    serviceKey
  );
  let partner = Array.isArray(partnerRes.body) ? partnerRes.body[0] : undefined;
  if (!partner) {
    const create = await supaRequest<PartnerRow[]>(
      'POST',
      'affiliate_partners?on_conflict=user_id',
      { user_id: user.id, referral_code: codeFor(user.id) },
      serviceKey,
      { Prefer: 'resolution=ignore-duplicates,return=representation' }
    );
    partner = Array.isArray(create.body) ? create.body[0] : undefined;
    if (!partner) {
      partnerRes = await supaRequest<PartnerRow[]>(
        'GET',
        'affiliate_partners?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id,referral_code,created_at&limit=1',
        null,
        serviceKey
      );
      partner = Array.isArray(partnerRes.body) ? partnerRes.body[0] : undefined;
    }
  }
  if (!partner) return fail(500, 'Could not load promoter account');

  const [referralsRes, commissionsRes] = await Promise.all([
    supaRequest<ReferralRow[]>(
      'GET',
      'affiliate_referrals?affiliate_user_id=eq.' + encodeURIComponent(user.id) +
        '&select=id,signed_up_at,trial_started_at,subscribed_at&order=signed_up_at.desc',
      null,
      serviceKey
    ),
    supaRequest<CommissionRow[]>(
      'GET',
      'affiliate_commissions?affiliate_user_id=eq.' + encodeURIComponent(user.id) +
        '&select=id,amount_cents,currency,status,earned_at&order=earned_at.desc',
      null,
      serviceKey
    )
  ]);
  const referrals = Array.isArray(referralsRes.body) ? referralsRes.body : [];
  const commissions = Array.isArray(commissionsRes.body) ? commissionsRes.body : [];
  const earnedCents = commissions
    .filter((row) => row.status !== 'void')
    .reduce((sum, row) => sum + row.amount_cents, 0);

  return jsonResponse(200, {
    referralCode: partner.referral_code,
    referralLink: 'https://minallo.de/?ref=' + partner.referral_code,
    stats: {
      signups: referrals.length,
      trials: referrals.filter((row) => Boolean(row.trial_started_at)).length,
      subscriptions: referrals.filter((row) => Boolean(row.subscribed_at)).length,
      revenueCents: earnedCents,
      currency: 'EUR'
    },
    recentReferrals: referrals.slice(0, 8),
    commissions: commissions.slice(0, 12)
  });
};
