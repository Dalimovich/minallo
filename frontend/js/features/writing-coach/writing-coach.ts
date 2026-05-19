// Writing Coach — view logic (mount, show/hide, submit, localStorage).
//
// HTML/CSS live under frontend/views/writing-coach/. This module fetches the
// HTML at runtime, injects it into #psec-german (next to #glHome), and wires
// the entry card + detail view. AI calls are delegated to writing-coach-ai.

import { analyzeParagraph, WritingAnalysis, WritingIssue } from './writing-coach-ai.js';

const DRAFT_KEY = 'ss_writing_coach_draft';
const MIN_CHARS = 10;

/** Read the user's German level from the profile (loaded into window by
 * user-data.ts). The trainer is read-only on this value — editing happens
 * on the Profile page. */
function _profileLevel(): string {
  const w = window as unknown as { _germanLevel?: string };
  return (w._germanLevel || '').trim();
}

let _injected = false;
let _activeAbort: AbortController | null = null;

export function initWritingCoach(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => _tryInject());
  } else {
    _tryInject();
  }
}

function _tryInject(attempt = 0): void {
  if (_injected) return;
  const psecGerman = document.getElementById('psec-german');
  const glHome = psecGerman?.querySelector('#glHome');
  // psec-german + glHome are injected asynchronously by practice.js. Retry
  // until both are present, but cap retries so we don't spin forever.
  if (!psecGerman || !glHome) {
    if (attempt > 40) return;
    window.setTimeout(() => _tryInject(attempt + 1), 250);
    return;
  }
  _injected = true;
  void _inject(psecGerman as HTMLElement);
}

async function _inject(psecGerman: HTMLElement): Promise<void> {
  try {
    const res = await fetch('views/writing-coach/writing-coach.html');
    if (!res.ok) {
      console.error('[writing-coach] fetch failed:', res.status);
      return;
    }
    const html = await res.text();
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Card → append at the end of the practice home shell (below the skill
    // grid as a full-width feature card). Prefer .sd-shell so margins line
    // up with the grid; fall back to #glHome for older markup.
    const card = tmp.querySelector('#wcCard');
    const view = tmp.querySelector('#wcView');
    const target =
      psecGerman.querySelector('#glHome .sd-shell') ||
      psecGerman.querySelector('#glHome');
    if (card && target) target.appendChild(card);
    if (view) psecGerman.appendChild(view);

    _wire();
  } catch (e) {
    console.error('[writing-coach] inject error:', e);
  }
}

function _wire(): void {
  const card = document.getElementById('wcCard');
  card?.addEventListener('click', _openView);

  const back = document.getElementById('wcBack');
  back?.addEventListener('click', _closeView);

  // Level is no longer user-selected here; it comes from the profile.
  // Wire the "Go to Profile" button in the empty state.
  const goProfile = document.getElementById('wcGoProfile');
  goProfile?.addEventListener('click', () => {
    const w = window as unknown as { showPortalSection?: (s: string) => void };
    if (typeof w.showPortalSection === 'function') w.showPortalSection('profile');
  });

  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = localStorage.getItem(DRAFT_KEY) || '';
    let saveTimer: number | null = null;
    ta.addEventListener('input', () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        localStorage.setItem(DRAFT_KEY, ta.value);
      }, 500);
      _updateAnalyzeEnabled();
    });
  }

  const btn = document.getElementById('wcAnalyze');
  btn?.addEventListener('click', () => {
    void _analyze();
  });

  _updateAnalyzeEnabled();

  // Belt-and-braces: psec-german is already learner-gated, but hide the card
  // anyway if userType is known and not 'learner'.
  if (typeof window._userType === 'string' && window._userType !== 'learner') {
    if (card) card.style.display = 'none';
  }
}

function _openView(): void {
  const home = document.getElementById('glHome');
  const view = document.getElementById('wcView');
  if (home) home.style.display = 'none';
  if (view) view.style.display = '';
  _renderProfileLevel();
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  ta?.focus();
  _updateAnalyzeEnabled();
}

/** Toggle between the writer card and the empty state based on whether
 * the user has a German level on their profile, and stamp the imported
 * level into the read-only badge. */
function _renderProfileLevel(): void {
  const level = _profileLevel();
  const writer = document.getElementById('wcWriter');
  const noLevel = document.getElementById('wcNoLevel');
  const valueEl = document.getElementById('wcLevelValue');
  if (level) {
    if (valueEl) valueEl.textContent = level;
    if (writer) writer.style.display = '';
    if (noLevel) noLevel.style.display = 'none';
  } else {
    if (writer) writer.style.display = 'none';
    if (noLevel) noLevel.style.display = '';
  }
}

function _closeView(): void {
  if (_activeAbort) {
    _activeAbort.abort();
    _activeAbort = null;
  }
  const home = document.getElementById('glHome');
  const view = document.getElementById('wcView');
  if (view) view.style.display = 'none';
  if (home) home.style.display = '';
}

function _updateAnalyzeEnabled(): void {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const btn = document.getElementById('wcAnalyze') as HTMLButtonElement | null;
  if (!ta || !btn) return;
  // Also requires a profile level to grade against.
  btn.disabled = ta.value.trim().length < MIN_CHARS || !_profileLevel();
}

async function _analyze(): Promise<void> {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const btn = document.getElementById('wcAnalyze') as HTMLButtonElement | null;
  const loading = document.getElementById('wcLoading');
  const results = document.getElementById('wcResults');
  if (!ta || !btn) return;

  const text = ta.value.trim();
  const level = _profileLevel();
  if (text.length < MIN_CHARS || !level) return;

  if (_activeAbort) _activeAbort.abort();
  _activeAbort = new AbortController();

  btn.disabled = true;
  if (loading) loading.style.display = 'flex';
  if (results) {
    results.style.display = 'none';
    results.innerHTML = '';
  }

  try {
    const analysis = await analyzeParagraph({ text, level, signal: _activeAbort.signal });
    _renderResults(analysis);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    console.error('[writing-coach] analyze error:', e);
    if (results) {
      results.style.display = '';
      results.innerHTML = '<div class="wc-error">Analysis failed. Please try again.</div>';
    }
  } finally {
    if (loading) loading.style.display = 'none';
    btn.disabled = ta.value.trim().length < MIN_CHARS;
    _activeAbort = null;
  }
}

function _renderResults(a: WritingAnalysis): void {
  const root = document.getElementById('wcResults');
  if (!root) return;
  root.style.display = '';

  const issuesHtml =
    (a.issues || []).map(_issueCard).join('') ||
    '<p class="wc-empty">No grammar issues found.</p>';
  const vocabHtml =
    (a.vocabularySuggestions || []).map(_issueCard).join('') ||
    '<p class="wc-empty">No vocabulary suggestions.</p>';
  const tipsHtml = (a.practiceTips || []).map((t) => `<li>${_escape(t)}</li>`).join('');

  root.innerHTML = `
    <section class="wc-result-section">
      <h3 class="wc-result-title">Corrected Text</h3>
      <p class="wc-corrected">${_escape(a.correctedText)}</p>
    </section>
    <section class="wc-result-section">
      <h3 class="wc-result-title">Mistakes Explained</h3>
      <div class="wc-issue-grid">${issuesHtml}</div>
    </section>
    <section class="wc-result-section">
      <h3 class="wc-result-title">Vocabulary Improvements</h3>
      <div class="wc-issue-grid">${vocabHtml}</div>
    </section>
    <section class="wc-result-section">
      <h3 class="wc-result-title">Improved Version</h3>
      <p class="wc-improved">${_escape(a.improvedText)}</p>
    </section>
    <section class="wc-result-section wc-level-section">
      <h3 class="wc-result-title">Estimated Level</h3>
      <span class="wc-level-badge">${_escape(a.estimatedLevel)}</span>
    </section>
    <section class="wc-result-section">
      <h3 class="wc-result-title">Practice Recommendations</h3>
      <ul class="wc-tips">${tipsHtml}</ul>
    </section>
    <div class="wc-result-actions">
      <button id="wcAgain" class="wc-btn-secondary" type="button">Write another</button>
    </div>
  `;

  const again = document.getElementById('wcAgain');
  again?.addEventListener('click', _resetForm);
}

function _issueCard(issue: WritingIssue): string {
  const colorClass = `wc-color-${issue.color}`;
  return `
    <div class="wc-issue ${colorClass}">
      <div class="wc-issue-header">
        <span class="wc-issue-dot"></span>
        <span class="wc-issue-type">${_escape(issue.type)}</span>
      </div>
      <div class="wc-issue-change">
        <span class="wc-issue-original">${_escape(issue.original)}</span>
        <span class="wc-issue-arrow">→</span>
        <span class="wc-issue-correction">${_escape(issue.correction)}</span>
      </div>
      <p class="wc-issue-explanation">${_escape(issue.explanation)}</p>
    </div>
  `;
}

function _resetForm(): void {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const results = document.getElementById('wcResults');
  if (ta) {
    ta.value = '';
    ta.focus();
  }
  localStorage.removeItem(DRAFT_KEY);
  if (results) {
    results.style.display = 'none';
    results.innerHTML = '';
  }
  _updateAnalyzeEnabled();
}

function _escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}
