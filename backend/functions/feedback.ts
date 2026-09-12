import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const ALLOWED_TYPES = ['feedback', 'problem', 'idea'] as const;

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user?.id) return fail(401, 'Invalid or expired session');

  let type = '';
  let message = '';
  let pageUrl = '';
  try {
    const body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    type = typeof body.type === 'string' ? body.type.trim() : '';
    message = typeof body.message === 'string' ? body.message.trim() : '';
    pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : '';
  } catch {
    return fail(400, 'Invalid body');
  }

  if (!ALLOWED_TYPES.includes(type as (typeof ALLOWED_TYPES)[number])) return fail(400, 'Invalid feedback type');
  if (message.length < 10) return fail(400, 'Please provide at least 10 characters');
  if (message.length > 5000) return fail(400, 'Feedback is too long');

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return fail(503, 'Email delivery is not configured yet. Please contact support@minallo.de.');
  const toEmail = process.env.FEEDBACK_TO_EMAIL || 'support@minallo.de';
  const fromEmail = process.env.FEEDBACK_FROM_EMAIL || 'Minallo Feedback <noreply@minallo.de>';
  const senderEmail = typeof user.email === 'string' ? user.email : 'unknown';
  const safe = (value: string): string => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      reply_to: senderEmail !== 'unknown' ? senderEmail : undefined,
      subject: '[Minallo ' + type + '] New message from ' + senderEmail,
      html: '<h2>New Minallo ' + safe(type) + '</h2>' +
        '<p><strong>From:</strong> ' + safe(senderEmail) + '<br><strong>User ID:</strong> ' + safe(user.id) + '</p>' +
        '<div style="white-space:pre-wrap;font-family:system-ui;line-height:1.6">' + safe(message) + '</div>' +
        (pageUrl ? '<p style="margin-top:24px;color:#64748b"><strong>Page:</strong> ' + safe(pageUrl) + '</p>' : '')
    })
  });
  if (!emailRes.ok) {
    console.error('[feedback] Resend error', emailRes.status, await emailRes.text());
    return fail(502, 'Could not send feedback');
  }
  return jsonResponse(201, { ok: true });
};
