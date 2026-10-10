import { supaRequest } from './supabase-admin';

async function callAffiliateRpc(
  serviceKey: string,
  functionName: 'record_affiliate_trial' | 'record_affiliate_payment',
  userId: string | null | undefined
): Promise<void> {
  if (!userId) return;
  const result = await supaRequest(
    'POST',
    'rpc/' + functionName,
    { p_user_id: userId },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(functionName + ' failed -> ' + result.status);
  }
}

export function recordAffiliateTrial(serviceKey: string, userId: string | null | undefined): Promise<void> {
  return callAffiliateRpc(serviceKey, 'record_affiliate_trial', userId);
}

export function recordAffiliatePayment(serviceKey: string, userId: string | null | undefined): Promise<void> {
  return callAffiliateRpc(serviceKey, 'record_affiliate_payment', userId);
}
