import crypto from 'crypto';
import { requireEnv } from './env';
import { supaRequest } from './supabase-admin';

interface TrialDeviceRow {
  device_hash: string;
}

export function normalizeTrialDeviceId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^[a-f0-9-]{20,80}$/i.test(trimmed) ? trimmed : '';
}

export function hashTrialDeviceId(deviceId: string): string {
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return crypto.createHmac('sha256', serviceKey).update(deviceId).digest('hex');
}

export async function hasUsedDeviceTrial(serviceKey: string, deviceHash: string): Promise<boolean> {
  if (!deviceHash) return false;
  const res = await supaRequest<TrialDeviceRow[]>(
    'GET',
    'subscription_trial_devices?device_hash=eq.' + encodeURIComponent(deviceHash) +
      '&select=device_hash&limit=1',
    null,
    serviceKey
  );
  return Boolean(Array.isArray(res.body) && res.body[0]);
}

export async function recordDeviceTrial(
  serviceKey: string,
  deviceHash: string,
  userId: string,
  subscriptionId: string | null | undefined,
  provider: string
): Promise<void> {
  if (!deviceHash) return;
  await supaRequest(
    'POST',
    'subscription_trial_devices?on_conflict=device_hash',
    {
      device_hash: deviceHash,
      first_user_id: userId,
      first_subscription_id: subscriptionId || null,
      provider,
      used_at: new Date().toISOString()
    },
    serviceKey,
    { Prefer: 'resolution=ignore-duplicates,return=minimal' }
  );
}

