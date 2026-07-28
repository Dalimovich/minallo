interface BillingErrorBody {
  error?: { message?: string } | string;
}

function _authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (window._sbToken || ''),
  };
}

function _billingError(payload: BillingErrorBody, fallback: string): string {
  if (typeof payload.error === 'object' && payload.error?.message) return payload.error.message;
  if (typeof payload.error === 'string') return payload.error;
  return fallback;
}

export interface CheckoutConsent {
  consentWiderrufVerzicht: boolean;
  consentTimestamp: string;
}

export async function createCheckoutSession(
  noTrial?: boolean,
  consent?: CheckoutConsent,
  trialDeviceId?: string
): Promise<{ url?: string }> {
  const res = await fetch('/api/create-checkout', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({
      noTrial: !!noTrial,
      consentWiderrufVerzicht: !!(consent && consent.consentWiderrufVerzicht),
      consentTimestamp: (consent && consent.consentTimestamp) || '',
      trialDeviceId: trialDeviceId || ''
    }),
  });
  return res.json().catch(() => ({}));
}

export async function createPortalSession(): Promise<{ url?: string }> {
  const res = await fetch('/api/create-portal', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  return res.json().catch(() => ({}));
}

export async function pauseSubscription(
  resumeAt: string,
  reason?: string
): Promise<Record<string, unknown>> {
  const res = await fetch('/api/pause-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ resumeAt, reason: reason || 'Vacation pause' }),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not pause subscription'));
  return payload;
}

export async function resumeSubscription(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/resume-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not resume subscription'));
  return payload;
}

export async function cancelSubscription(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/cancel-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not cancel subscription'));
  return payload;
}

export async function reactivateSubscription(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/reactivate-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not reactivate subscription'));
  return payload;
}

export async function applyRetentionDiscount(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/apply-retention-discount', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not apply discount'));
  return payload;
}

export async function verifyPayment(sessionId: string): Promise<unknown> {
  const res = await fetch('/api/verify-payment', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  return res.json().catch(() => ({}));
}

export async function activatePayPalSubscription(
  subscriptionID: string,
  trialDeviceId?: string,
  consent?: { consentWiderrufVerzicht: boolean; consentTimestamp: string }
): Promise<unknown> {
  const res = await fetch('/api/activate-paypal-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({
      subscriptionID,
      trialDeviceId: trialDeviceId || '',
      consentWiderrufVerzicht: !!(consent && consent.consentWiderrufVerzicht),
      consentTimestamp: (consent && consent.consentTimestamp) || ''
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) {
    // Backend uses fail() → { error: { message } }. The old string fallback
    // never matched, so every failure surfaced as the generic "Activation
    // failed" instead of the actual reason (e.g. consent missing, custom_id
    // mismatch).
    const errObj = payload.error as { message?: string } | string | undefined;
    const message =
      (typeof errObj === 'object' && errObj && typeof errObj.message === 'string' && errObj.message) ||
      (typeof errObj === 'string' ? errObj : 'Activation failed');
    throw new Error(message);
  }
  return payload;
}

export async function loadBillingConfig(): Promise<unknown> {
  const res = await fetch('/api/public-billing-config');
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody;
  if (!res.ok) throw new Error(_billingError(payload, 'Could not load billing config'));
  return payload;
}
