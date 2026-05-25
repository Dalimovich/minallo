interface BillingErrorBody {
  error?: { message?: string } | string;
}

function _authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (window._sbToken || ''),
  };
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
  if (!res.ok) {
    const message =
      typeof payload.error === 'object' && payload.error?.message
        ? payload.error.message
        : typeof payload.error === 'string'
          ? payload.error
          : 'Could not pause subscription';
    throw new Error(message);
  }
  return payload;
}

export async function resumeSubscription(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/resume-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof payload.error === 'object' && payload.error?.message
        ? payload.error.message
        : typeof payload.error === 'string'
          ? payload.error
          : 'Could not resume subscription';
    throw new Error(message);
  }
  return payload;
}

export async function cancelSubscription(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/cancel-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof payload.error === 'object' && payload.error?.message
        ? payload.error.message
        : typeof payload.error === 'string'
          ? payload.error
          : 'Could not cancel subscription';
    throw new Error(message);
  }
  return payload;
}

export async function applyRetentionDiscount(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/apply-retention-discount', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({}),
  });
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody & Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof payload.error === 'object' && payload.error?.message
        ? payload.error.message
        : typeof payload.error === 'string'
          ? payload.error
          : 'Could not apply discount';
    throw new Error(message);
  }
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
    const message = typeof payload.error === 'string' ? payload.error : 'Activation failed';
    throw new Error(message);
  }
  return payload;
}

export async function loadBillingConfig(): Promise<unknown> {
  const res = await fetch('/api/public-billing-config');
  const payload = (await res.json().catch(() => ({}))) as BillingErrorBody;
  if (!res.ok) {
    const message =
      typeof payload.error === 'object' && payload.error?.message
        ? payload.error.message
        : 'Could not load billing config';
    throw new Error(message);
  }
  return payload;
}
