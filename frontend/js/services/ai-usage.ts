// AI fair-use surface — fetches the current month's call counters and
// renders:
//   • a banner per bucket once it crosses 80% (interactive / generation)
//   • a cap-reached modal triggered when any AI call returns 429 with
//     code 'ai_monthly_cap' (the modal text adapts to the bucket field)
//
// Two independent buckets ship from /api/ai/usage:
//   interactive — chat / RAG / writing coach / stream asks (large cap, ~2000)
//   generation  — quiz / flashcards / notes generation     (tight cap, ~200)
//
// Both pieces are styled with the site's existing glass tokens so they sit
// naturally in the portal. No new design language introduced.

declare global {
  interface Window {
    _sbToken?: string;
    BACKEND_URL?: string;
    _aiUsage?: AiUsage;
    showAiCapModal?: (detail: AiCapErrorDetail) => void;
    refreshAiUsage?: () => Promise<AiUsage | null>;
  }
}

export interface AiUsageBucket {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetsAt: string;
}

export interface AiUsage {
  interactive: AiUsageBucket;
  generation: AiUsageBucket;
  resetsAt: string;
  // Legacy single-counter fields (max of the two buckets) — kept so existing
  // subscription.js and similar callers keep working without an update.
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
}

export interface AiCapErrorDetail {
  code: 'ai_monthly_cap';
  bucket?: 'interactive' | 'generation';
  message: string;
  used: number;
  limit: number;
  resetsAt: string;
}

const WARN_THRESHOLD = 0.8;
const MODAL_ID = 'aiCapModal';
const STORAGE_KEY_PREFIX = 'ss_ai_usage_banner_dismissed_';
const CONTACT_EMAIL = 'support@minallo.de';

const BANNER_LABEL: Record<'interactive' | 'generation', { title: string; subjectAtCap: string; subjectWarn: string }> = {
  interactive: {
    title: 'AI chat & tutor allowance',
    subjectAtCap: "You've reached this month's chat + tutor allowance",
    subjectWarn: "You're approaching this month's chat + tutor allowance"
  },
  generation: {
    title: 'AI generation allowance (quiz / flashcards / notes)',
    subjectAtCap: "You've reached this month's generation allowance",
    subjectWarn: "You're approaching this month's generation allowance"
  }
};

function _backendUrl(): string { return window.BACKEND_URL || ''; }
function _token(): string { return window._sbToken || ''; }

function _monthKey(d: Date = new Date()): string {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export async function fetchAiUsage(): Promise<AiUsage | null> {
  if (!_token()) return null;
  try {
    const res = await fetch(_backendUrl() + '/api/ai/usage', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + _token() }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as AiUsage;
    window._aiUsage = data;
    return data;
  } catch {
    return null;
  }
}

function _formatResetDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return iso; }
}

function _bannerId(bucket: 'interactive' | 'generation'): string {
  return 'aiUsageBanner_' + bucket;
}

function _renderBucketBanner(bucket: 'interactive' | 'generation', b: AiUsageBucket): void {
  const id = _bannerId(bucket);
  const shouldShow = b.percentUsed >= WARN_THRESHOLD * 100;
  let banner = document.getElementById(id);

  if (!shouldShow) {
    if (banner) banner.remove();
    return;
  }

  const storageKey = STORAGE_KEY_PREFIX + bucket + '_month';
  if (localStorage.getItem(storageKey) === _monthKey()) return;

  if (!banner) {
    banner = document.createElement('div');
    banner.id = id;
    banner.className = 'ai-usage-banner';
    const portal = document.getElementById('portal') || document.body;
    portal.insertBefore(banner, portal.firstChild);
  }

  const isAtCap = b.percentUsed >= 100;
  const labels = BANNER_LABEL[bucket];
  const reset = _formatResetDate(b.resetsAt);
  const tone = isAtCap ? 'ai-usage-banner--cap' : 'ai-usage-banner--warn';
  banner.className = 'ai-usage-banner ' + tone;
  banner.innerHTML =
    '<div class="ai-usage-banner-icon" aria-hidden="true">' +
    (isAtCap ? '&#x26A0;&#xFE0F;' : '&#x1F4CA;') +
    '</div>' +
    '<div class="ai-usage-banner-body">' +
    '<div class="ai-usage-banner-title">' +
    (isAtCap ? labels.subjectAtCap : labels.subjectWarn) +
    '</div>' +
    '<div class="ai-usage-banner-sub">' +
    b.used + ' of ' + b.limit + ' used &middot; ' + labels.title + '. Resets on ' + reset + '.' +
    '</div>' +
    '<div class="ai-usage-banner-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
    b.percentUsed + '">' +
    '<div class="ai-usage-banner-meter-fill" style="width:' + Math.min(100, b.percentUsed) + '%"></div>' +
    '</div>' +
    '</div>' +
    '<button class="ai-usage-banner-close" type="button" aria-label="Dismiss">&times;</button>';

  banner.querySelector('.ai-usage-banner-close')?.addEventListener('click', () => {
    localStorage.setItem(storageKey, _monthKey());
    banner?.remove();
  });
}

function _renderBanners(usage: AiUsage): void {
  _renderBucketBanner('interactive', usage.interactive);
  _renderBucketBanner('generation', usage.generation);
}

function showAiCapModal(detail: AiCapErrorDetail): void {
  let modal = document.getElementById(MODAL_ID);
  if (modal) { modal.style.display = 'flex'; return; }

  const bucket = detail.bucket === 'generation' ? 'generation' : 'interactive';
  const labelTitle = bucket === 'generation'
    ? 'Monthly generation limit reached'
    : 'Monthly AI chat limit reached';
  const explainer = bucket === 'generation'
    ? "You've used all " + detail.limit + " quiz / flashcard / notes generations included in your Pro " +
      "subscription this month (Fair-Use). Chat and tutor still work."
    : "You've used all " + detail.limit + " AI chat / tutor calls included in your Pro " +
      "subscription this month (Fair-Use).";
  const reset = _formatResetDate(detail.resetsAt);

  modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'ai-cap-modal';
  modal.innerHTML =
    '<div class="ai-cap-modal-backdrop"></div>' +
    '<div class="ai-cap-modal-card" role="dialog" aria-modal="true" aria-labelledby="aiCapModalTitle">' +
    '<div class="ai-cap-modal-icon" aria-hidden="true">&#x26A0;&#xFE0F;</div>' +
    '<h2 id="aiCapModalTitle" class="ai-cap-modal-title">' + labelTitle + '</h2>' +
    '<p class="ai-cap-modal-text">' +
    explainer + ' Your allowance refreshes on <strong>' + reset + '</strong>.' +
    '</p>' +
    '<div class="ai-cap-modal-meta">' +
    detail.used + ' / ' + detail.limit + ' used &middot; ' +
    '<a href="/terms.html#leistung" target="_blank" rel="noopener">Fair-Use details</a>' +
    '</div>' +
    '<div class="ai-cap-modal-actions">' +
    '<a class="ai-cap-modal-btn ai-cap-modal-btn-secondary" href="mailto:' + CONTACT_EMAIL +
    '?subject=Request%20higher%20AI%20fair-use%20limit">Need more? Contact us</a>' +
    '<button class="ai-cap-modal-btn ai-cap-modal-btn-primary" type="button" id="aiCapModalDismiss">Got it</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(modal);
  const dismiss = (): void => { modal!.style.display = 'none'; };
  modal.querySelector('#aiCapModalDismiss')?.addEventListener('click', dismiss);
  modal.querySelector('.ai-cap-modal-backdrop')?.addEventListener('click', dismiss);
}

export async function detectAiCapError(res: Response): Promise<boolean> {
  if (res.status !== 429) return false;
  try {
    const clone = res.clone();
    const body = (await clone.json()) as { error?: AiCapErrorDetail };
    if (body && body.error && body.error.code === 'ai_monthly_cap') {
      showAiCapModal(body.error);
      void fetchAiUsage().then((u) => { if (u) _renderBanners(u); });
      return true;
    }
  } catch { /* not JSON / no body — ignore */ }
  return false;
}

export function initAiUsage(): void {
  window.showAiCapModal = showAiCapModal;
  window.refreshAiUsage = async (): Promise<AiUsage | null> => {
    const u = await fetchAiUsage();
    if (u) _renderBanners(u);
    return u;
  };
  void window.refreshAiUsage();
}
