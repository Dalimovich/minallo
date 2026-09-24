// Profile-driven German exam workspace.
//
// The exam navigation (which modules exist, how many parts each has, which are
// generatable yet) is NOT hard-coded in the practice view: it is built from the
// manifest that python-ai serves for the learner's saved exam profile
// (POST /api/ai/german-exam/manifest — resolved server-side from
// profiles.german_test + german_level; the client sends no profile id).
//
// Profile decides structure; task type decides behaviour. This module knows
// nothing exam-specific: there is no per-exam branching anywhere in it.

import { mountTaskWorkspace } from './task-workspace.js';
import { authenticatedFetch } from '../../services/authenticated-fetch.js';
import { ensureExamStructureStyles } from './exam-structure-preview.js';

export interface ExamManifestPart {
  id: string;
  title: string;
  taskType: string;
  implemented: boolean;
  constraints?: Record<string, unknown>;
}

export interface ExamManifestModule {
  id: string;
  label: string;
  /** The exam's own short code for the module (e.g. DSH "HV"); absent for exams without one. */
  code?: string | null;
  durationSeconds: number | null;
  preparationSeconds: number | null;
  note: string | null;
  parts: ExamManifestPart[];
}

/** Generic, data-driven presentation switches an exam profile may set (never an exam-name check). */
export interface ExamManifestPresentation {
  /** 'manifest': the module cards come ONLY from this manifest; the legacy static exam cards stay hidden. */
  moduleCards?: 'manifest';
  disclaimer?: string;
}

export interface ExamManifest {
  profileId: string;
  profileVersion: number;
  displayName: string;
  cefrLevel: string | null;
  modules: ExamManifestModule[];
  presentation?: ExamManifestPresentation | null;
  resultModel?: Record<string, unknown> | null;
}

export interface ExamNavModule {
  id: string;
  label: string;
  code: string | null;
  note: string | null;
  parts: Array<{ id: string; title: string; implemented: boolean }>;
  partCount: number;
  durationLabel: string | null;
  skill: string | null; // data-skill of the existing practice card that opens this module
  availableParts: number; // parts that can be generated today
  available: boolean; // at least one part is generatable (the module can be opened)
}

/** module id -> data-skill of the existing exam practice card. */
export const MODULE_SKILL: Record<string, string> = {
  listening: 'listening',
  reading: 'reading',
  language_elements: 'sprachbausteine',
  writing: 'writing',
};
const EXAM_SKILLS = Object.values(MODULE_SKILL);

export type ExamStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

export interface ExamWorkspaceState {
  profileId: string | null;
  manifest: ExamManifest | null;
  status: ExamStatus;
}

export function durationLabel(seconds: number | null): string | null {
  if (!seconds) return null;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function buildNavModel(manifest: ExamManifest): ExamNavModule[] {
  return manifest.modules.map((m) => ({
    id: m.id,
    label: m.label,
    code: m.code || null,
    note: m.note || null,
    parts: m.parts.map((p) => ({ id: p.id, title: p.title, implemented: p.implemented })),
    partCount: m.parts.length,
    durationLabel: durationLabel(m.durationSeconds),
    skill: MODULE_SKILL[m.id] ?? null,
    availableParts: m.parts.filter((p) => p.implemented).length,
    available: m.parts.some((p) => p.implemented),
  }));
}

/** True when transient exam state built for `prev` must be discarded for `next`. */
export function profileChanged(prev: string | null, next: string | null): boolean {
  return (prev || null) !== (next || null);
}

/** True when this exam's profile asks for manifest-only module cards. */
export function usesManifestCards(manifest: ExamManifest | null | undefined): boolean {
  return manifest?.presentation?.moduleCards === 'manifest';
}

/**
 * Whether a legacy static exam card (data-skill) exists for the current exam state. The manifest decides:
 * a module the exam lacks is ABSENT, a profile that opts into manifest cards has no static cards at all,
 * and while a manifest is loading/failed no card is shown (never a previous or guessed exam's structure).
 */
export function staticExamCardState(state: ExamWorkspaceState, skill: string): { hidden: boolean; soon: boolean } {
  if (!EXAM_SKILLS.includes(skill)) return { hidden: false, soon: false };
  if (state.status === 'ready' && state.manifest) {
    if (usesManifestCards(state.manifest)) return { hidden: true, soon: false };
    const nav = buildNavModel(state.manifest).find((m) => m.skill === skill);
    return { hidden: !nav, soon: !!nav && !nav.available };
  }
  if (state.status === 'loading' || state.status === 'error') return { hidden: true, soon: false };
  return { hidden: false, soon: false }; // no exam-specific profile: unchanged legacy behaviour
}

/** The chatbot German panel links to the same exam skills; same manifest rule as the practice cards. */
export function chatPanelLinkHidden(state: ExamWorkspaceState, skill: string): boolean {
  return staticExamCardState(state, skill).hidden;
}

/** The chatbot panel's static Sprechen link follows the manifest as well: only an exam with a speaking section has it. */
export function chatSpeakingLinkHidden(state: ExamWorkspaceState): boolean {
  if (state.status === 'ready' && state.manifest) return !state.manifest.modules.some((m) => m.id === 'speaking');
  if (state.status === 'loading' || state.status === 'error') return true;
  return false; // no exam-specific profile: unchanged legacy behaviour
}

/**
 * Body of a generation request. Built ONLY from the current, ready manifest so a stale mounted workspace
 * can never send the previous exam's profile id or a part the current exam does not have.
 */
export function buildGenerateRequestBody(
  state: ExamWorkspaceState,
  module: string,
  partId: string
): { profileId: string; module: string; partId: string; mode: 'adaptive_practice' } {
  if (state.status !== 'ready' || !state.manifest || !state.profileId || state.manifest.profileId !== state.profileId) {
    throw new Error('exam_not_ready');
  }
  const part = state.manifest.modules.find((m) => m.id === module)?.parts.find((p) => p.id === partId);
  if (!part) throw new Error('part_not_in_current_exam');
  return { profileId: state.profileId, module, partId, mode: 'adaptive_practice' };
}

/** Why an exam skill cannot be opened right now, or '' when it can (or is unknown). */
export function skillBlockReason(state: ExamWorkspaceState, skill: string): string {
  if (!EXAM_SKILLS.includes(skill) || state.status !== 'ready' || !state.manifest) return '';
  const nav = buildNavModel(state.manifest).find((m) => m.skill === skill);
  if (!nav) return `${state.manifest.displayName} has no such section.`;
  if (!nav.available) return `${nav.label} practice for ${state.manifest.displayName} is coming soon.`;
  return '';
}

/** 'yes' | 'no' | 'pending' — used to skip speculative work for parts the exam lacks. */
export function partAvailability(
  state: ExamWorkspaceState,
  moduleId: string,
  partId: string
): 'yes' | 'no' | 'pending' {
  if (state.status === 'loading' || state.status === 'idle') return 'pending';
  if (state.status !== 'ready' || !state.manifest) return 'no';
  const part = state.manifest.modules.find((m) => m.id === moduleId)?.parts.find((p) => p.id === partId);
  return part && part.implemented ? 'yes' : 'no';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderOverviewHtml(manifest: ExamManifest): string {
  const manifestCards = usesManifestCards(manifest);
  const rows = buildNavModel(manifest)
    .map((m) => {
      const parts = `${m.partCount} ${m.partCount === 1 ? 'part' : 'parts'}`;
      const time = m.durationLabel ? ` · ${esc(m.durationLabel)}` : '';
      const soon = !m.available
        ? ' <span class="gl-exam-soon">coming soon</span>'
        : m.availableParts < m.partCount
          ? ` <span class="gl-exam-soon">${m.availableParts} of ${m.partCount} ready</span>`
          : '';
      const code = m.code ? `<span class="gl-exam-code">${esc(m.code)}</span>` : '';
      const note = manifestCards && m.note ? `<span class="gl-exam-module-note">${esc(m.note)}</span>` : '';
      return (
        `<li class="gl-exam-module" data-exam-module="${esc(m.id)}"${m.code ? ` data-exam-module-code="${esc(m.code)}"` : ''}>` +
        `${code}<span class="gl-exam-module-name">${esc(m.label)}</span>` +
        `<span class="gl-exam-module-meta">${parts}${time}${soon}</span>${note}</li>`
      );
    })
    .join('');
  const disclaimer = manifest.presentation?.disclaimer
    ? `<p class="gl-exam-disclaimer">${esc(manifest.presentation.disclaimer)}</p>`
    : '';
  return (
    `<h3 class="gl-exam-title" data-exam-profile="${esc(manifest.profileId)}">${esc(manifest.displayName)}</h3>` +
    `<p class="gl-exam-sub">Prepare for your actual exam format</p>` +
    `<ul class="gl-exam-modules${manifestCards ? ' gl-exam-modules--manifest' : ''}">${rows}</ul>${disclaimer}`
  );
}

export async function fetchManifest(
  fetcher: typeof authenticatedFetch = authenticatedFetch,
  base = '',
  signal?: AbortSignal
): Promise<{ profileId: string; manifest: ExamManifest }> {
  const res = await fetcher(base + '/api/ai/german-exam/manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    ...(signal ? { signal } : {}),
  });
  if (res.status === 422) throw Object.assign(new Error('unsupported'), { unsupported: true });
  if (!res.ok) throw new Error('manifest_http_' + res.status);
  const data = (await res.json()) as { profileId: string; manifest: ExamManifest };
  if (!data?.manifest || data.manifest.profileId !== data.profileId) throw new Error('manifest_mismatch');
  return data;
}

export interface ExamWorkspaceHooks {
  /** Learner's resolved exam profile id (null = no exam-specific profile). Only a fallback for `savedProfileKey`. */
  resolveProfileId: () => string | null;
  /**
   * Identity of the SAVED exam selection (e.g. "Goethe|C1"). The workspace re-reads the manifest whenever this
   * changes; the SERVER resolves which exam profile it maps to, so adding an exam needs no client registry entry.
   */
  savedProfileKey?: () => string;
  /** False while the saved profile is still loading (never guess an exam meanwhile). */
  profileReady: () => boolean;
  /** Discard every piece of profile-specific transient state (generated part, prefetch, TTS, part nav). */
  onProfileChange: (prev: string | null, next: string | null) => void;
  /** The exam view/skill currently open, or ''. */
  activeSkill: () => string;
  /** Called when the open skill is not available in the (new) profile. */
  onActiveSkillBlocked: (skill: string, reason: string) => void;
  base?: string;
}

export interface ExamWorkspaceDeps {
  fetchManifest: (signal: AbortSignal) => Promise<{ profileId: string; manifest: ExamManifest }>;
  render: (state: ExamWorkspaceState) => void;
}

export interface ExamWorkspaceController {
  state: ExamWorkspaceState;
  /** Re-read the saved selection and (re)load the manifest. Resolves when THIS state has settled (or was superseded). */
  refresh: () => Promise<void>;
  /** Resolves once the most recent refresh has settled — safe to await after a profile save. */
  whenSettled: () => Promise<void>;
  onReady: (cb: () => void) => void;
  clearCache: () => void;
}

type CacheEntry = { profileId: string; manifest: ExamManifest } | { unsupported: true };

/**
 * The single owner of "which exam is the UI showing".
 *
 *  - Keyed by the SAVED exam selection, not by a client-side profile registry.
 *  - A selection change clears the previous exam's manifest and transient state IMMEDIATELY
 *    (loading state, never the old exam's modules), then loads the new manifest.
 *  - Every refresh gets a sequence number; a response is applied only if it is still the newest request
 *    for the currently saved selection. A late response for an old selection is discarded and never cached.
 *  - A throwing hook can never abort the refresh.
 */
export function createExamWorkspace(hooks: ExamWorkspaceHooks, deps: ExamWorkspaceDeps): ExamWorkspaceController {
  const state: ExamWorkspaceState = { profileId: null, manifest: null, status: 'idle' };
  let key: string | null = null;
  let seq = 0;
  let pendingAbort: AbortController | null = null;
  let settled: Promise<void> = Promise.resolve();
  const cache = new Map<string, CacheEntry>();
  const waiters: Array<() => void> = [];

  const flush = (): void => {
    waiters.splice(0).forEach((cb) => {
      try {
        cb();
      } catch {
        /* a waiter must never break the workspace */
      }
    });
  };
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* keep the refresh going: a failing reset hook must not leave the UI on the previous exam */
    }
  };
  const render = (): void => safe(() => deps.render(state));
  const savedKey = (): string => (hooks.savedProfileKey ? hooks.savedProfileKey() : hooks.resolveProfileId() || '');
  const activeSkill = (): string => {
    try {
      return hooks.activeSkill() || '';
    } catch {
      return '';
    }
  };

  async function run(mine: number): Promise<void> {
    if (!hooks.profileReady()) {
      pendingAbort?.abort();
      state.status = 'loading';
      render();
      return;
    }
    const wanted = savedKey();
    if (wanted !== (key ?? '')) {
      // The saved exam changed: drop everything that belongs to the previous one BEFORE anything can render.
      const prev = state.profileId;
      key = wanted;
      state.profileId = null;
      state.manifest = null;
      state.status = wanted ? 'loading' : 'unsupported';
      pendingAbort?.abort();
      safe(() => hooks.onProfileChange(prev, null));
      render();
    }
    if (!wanted) {
      state.status = 'unsupported';
      render();
      flush();
      return;
    }
    const hit = cache.get(wanted);
    if (hit) {
      if ('unsupported' in hit) {
        state.profileId = null;
        state.manifest = null;
        state.status = 'unsupported';
      } else {
        state.profileId = hit.profileId;
        state.manifest = hit.manifest;
        state.status = 'ready';
      }
    } else {
      state.profileId = null;
      state.manifest = null;
      state.status = 'loading';
      render();
      pendingAbort?.abort();
      const ac = new AbortController();
      pendingAbort = ac;
      let entry: CacheEntry | null = null;
      let failed = false;
      try {
        entry = await deps.fetchManifest(ac.signal);
      } catch (err) {
        if ((err as { unsupported?: boolean })?.unsupported) entry = { unsupported: true };
        else failed = true;
      }
      // Superseded by a newer refresh, or the saved selection moved on while we waited: apply nothing, cache nothing.
      if (mine !== seq || wanted !== key) return;
      if (failed || !entry) {
        state.status = 'error';
      } else if ('unsupported' in entry) {
        cache.set(wanted, entry);
        state.status = 'unsupported';
      } else {
        cache.set(wanted, entry);
        state.profileId = entry.profileId; // the SERVER's resolution of the saved selection is authoritative
        state.manifest = entry.manifest;
        state.status = 'ready';
      }
    }
    render();
    const active = activeSkill();
    const reason = active ? skillBlockReason(state, active) : '';
    if (reason) safe(() => hooks.onActiveSkillBlocked(active, reason));
    flush();
  }

  const refresh = (): Promise<void> => {
    const mine = ++seq;
    const p = run(mine).catch(() => {
      if (mine === seq && state.status === 'loading') {
        state.status = 'error';
        render();
      }
    });
    settled = p;
    return p;
  };

  return {
    state,
    refresh,
    whenSettled: () => settled,
    onReady: (cb) => {
      if (state.status === 'ready' || state.status === 'unsupported' || state.status === 'error') cb();
      else waiters.push(cb);
    },
    clearCache: () => cache.clear(),
  };
}

let disposeTaskWorkspace: (() => void) | undefined;
let workspaceBase = '';
// The workspace state object is mutated in place; requests read it at CLICK time, never a captured snapshot.
let latestState: ExamWorkspaceState = { profileId: null, manifest: null, status: 'idle' };

function applyChatPanelLinks(state: ExamWorkspaceState): void {
  document.querySelectorAll<HTMLElement>('.ncb-german-panel-link[data-workspace-skill]').forEach((link) => {
    const hide = chatPanelLinkHidden(state, link.getAttribute('data-workspace-skill') || '');
    link.hidden = hide;
    // chatbot.css gives .ncb-german-panel-link an explicit display, which overrides [hidden]: hide it explicitly.
    link.style.display = hide ? 'none' : '';
  });
  document.querySelectorAll<HTMLElement>('[data-testid="german-panel-speaking"]').forEach((link) => {
    const hide = chatSpeakingLinkHidden(state);
    link.hidden = hide;
    link.style.display = hide ? 'none' : '';
  });
}

function applyDom(state: ExamWorkspaceState): void {
  latestState = state;
  disposeTaskWorkspace?.();
  disposeTaskWorkspace = undefined;
  const root = document.getElementById('glExamGroup');
  const overview = document.getElementById('glExamOverview');
  if (!root) return;
  root.setAttribute('data-exam-state', state.status);
  root.querySelectorAll<HTMLElement>('.gl-skill-card[data-skill]').forEach((card) => {
    const skill = card.getAttribute('data-skill') || '';
    if (!EXAM_SKILLS.includes(skill)) return;
    const visibility = staticExamCardState(state, skill);
    card.hidden = visibility.hidden;
    card.classList.toggle('gl-skill-card-soon', visibility.soon);
  });
  applyChatPanelLinks(state);
  ensureExamStructureStyles();
  if (overview) {
    if (state.status === 'ready' && state.manifest) {
      overview.innerHTML = renderOverviewHtml(state.manifest);
      const taskRoot = document.createElement('div');
      overview.append(taskRoot);
      disposeTaskWorkspace = mountTaskWorkspace(taskRoot, state.manifest, async (module, part, signal) => {
        const response = await authenticatedFetch(workspaceBase + '/api/ai/german-exam/generate', {
          method: 'POST', signal, headers: {'Content-Type':'application/json'},
          body: JSON.stringify(buildGenerateRequestBody(latestState, module, part.id))
        });
        if (!response.ok) throw new Error('generation failed');
        return response.json();
      });
      overview.hidden = false;
    } else if (state.status === 'loading') {
      overview.innerHTML = '<p class="gl-exam-sub gl-exam-loading" role="status">Loading your exam…</p>';
      overview.hidden = false;
    } else if (state.status === 'error') {
      overview.innerHTML =
        '<p class="gl-exam-sub">Your exam structure could not be loaded. ' +
        '<button type="button" class="gl-exam-retry">Try again</button></p>';
      overview.hidden = false;
    } else {
      overview.innerHTML = '';
      overview.hidden = true;
    }
  }
}

declare global {
  interface Window {
    _glExamState?: () => ExamWorkspaceState;
    _glExamSkillBlocked?: (skill: string) => string;
    _glExamPartAvailability?: (moduleId: string, partId: string) => 'yes' | 'no' | 'pending';
    _glExamOnReady?: (cb: () => void) => void;
    /** Resolves when the workspace has adopted the most recently saved exam (manifest applied or failed). Used right after a Profile save. */
    _glExamRefreshNow?: () => Promise<void>;
  }
}

export function initExamWorkspace(hooks: ExamWorkspaceHooks): ExamWorkspaceController {
  workspaceBase = hooks.base || '';
  const ctl = createExamWorkspace(hooks, {
    fetchManifest: (signal) => fetchManifest(undefined, hooks.base || '', signal),
    render: applyDom,
  });
  window._glExamState = () => ctl.state;
  window._glExamSkillBlocked = (skill) => skillBlockReason(ctl.state, skill);
  window._glExamPartAvailability = (moduleId, partId) => partAvailability(ctl.state, moduleId, partId);
  window._glExamOnReady = (cb) => ctl.onReady(cb);
  // The 'ss-profile-updated' listener below has already started the refresh synchronously by the time a Profile
  // save calls this, so just wait for it instead of starting (and aborting) a second request.
  window._glExamRefreshNow = () => ctl.whenSettled();
  window.addEventListener('ss-profile-updated', () => {
    void ctl.refresh();
  });
  // The chatbot German panel can mount after the manifest settled: apply the same manifest rule to it then.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver((records) => {
      const added = records.some((r) =>
        Array.from(r.addedNodes).some(
          (n) => n instanceof HTMLElement && (n.matches('.ncb-german-panel-link') || !!n.querySelector('.ncb-german-panel-link'))
        )
      );
      if (added) applyChatPanelLinks(ctl.state);
    }).observe(document.body, { childList: true, subtree: true });
  }
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('.gl-exam-retry')) {
      ctl.clearCache();
      void ctl.refresh();
    }
  });
  void ctl.refresh();
  return ctl;
}

// Exposed so a browser harness can drive the real DOM-apply path with a ready manifest state.
export { applyDom as applyExamStateToDom };
