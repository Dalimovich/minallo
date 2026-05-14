import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method Not Allowed');
  const paypalPlanId = requireEnv('PAYPAL_PLAN_ID');
  return jsonResponse(200, { paypalPlanId });
};
