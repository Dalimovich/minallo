function _authHeaders() {
    return {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (window._sbToken || ''),
    };
}
export async function createCheckoutSession(noTrial) {
    const res = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({ noTrial: !!noTrial }),
    });
    return res.json().catch(() => ({}));
}
export async function createPortalSession() {
    const res = await fetch('/api/create-portal', {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({}),
    });
    return res.json().catch(() => ({}));
}
export async function verifyPayment(sessionId) {
    const res = await fetch('/api/verify-payment', {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({ sessionId }),
    });
    return res.json().catch(() => ({}));
}
export async function activatePayPalSubscription(subscriptionID) {
    const res = await fetch('/api/activate-paypal-subscription', {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({ subscriptionID }),
    });
    const payload = (await res.json().catch(() => ({})));
    if (!res.ok) {
        const message = typeof payload.error === 'string' ? payload.error : 'Activation failed';
        throw new Error(message);
    }
    return payload;
}
export async function loadBillingConfig() {
    const res = await fetch('/api/public-billing-config');
    const payload = (await res.json().catch(() => ({})));
    if (!res.ok) {
        const message = typeof payload.error === 'object' && payload.error?.message
            ? payload.error.message
            : 'Could not load billing config';
        throw new Error(message);
    }
    return payload;
}
//# sourceMappingURL=subscription-service.js.map