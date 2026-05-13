interface BillingErrorBody {
  error?: { message?: string } | string;
}

function _authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (window._sbToken || ''),
  };
}

export async function createCheckoutSession(noTrial?: boolean): Promise<{ url?: string }> {
  const res = await fetch('/api/create-checkout', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ noTrial: !!noTrial }),
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

export async function verifyPayment(sessionId: string): Promise<unknown> {
  const res = await fetch('/api/verify-payment', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  return res.json().catch(() => ({}));
}

export async function activatePayPalSubscription(subscriptionID: string): Promise<unknown> {
  const res = await fetch('/api/activate-paypal-subscription', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ subscriptionID }),
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
