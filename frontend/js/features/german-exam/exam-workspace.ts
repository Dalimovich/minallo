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

import { authenticatedFetch } from '../../services/authenticated-fetch.js';

export interface ExamManifestPart {
  id: string;
  title: string;
  taskType: string;
  implemented: boolean;
}

export interface ExamManifestModule {
  id: string;
  label: string;
  durationSeconds: number | null;
  preparationSeconds: number | null;
  note: string | null;
  parts: ExamManifestPart[];
}

export interface ExamManifest {
  profileId: string;
  profileVersion: number;
  displayName: string;
  cefrLevel: string | null;
  modules: ExamManifestModule[];
}

export interface ExamNavModule {
  id: string;
  label: string;
  partCount: number;
  durationLabel: string | null;
  skill: string | null; // data-skill of the existing practice card that opens this module
  available: boolean; // every part is generatable
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
    partCount: m.parts.length,
    durationLabel: durationLabel(m.durationSeconds),
    skill: MODULE_SKILL[m.id] ?? null,
    available: m.parts.length > 0 && m.parts.every((p) => p.implemented),
  }));
}

/** True when transient exam state built for `prev` must be discarded for `next`. */
export function profileChanged(prev: string | null, next: string | null): boolean {
  return (prev || null) !== (next || null);
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
  const rows = buildNavModel(manifest)
    .map((m) => {
      const parts = `${m.partCount} ${m.partCount === 1 ? 'part' : 'parts'}`;
      const time = m.durationLabel ? ` · ${esc(m.durationLabel)}` : '';
      const soon = m.available ? '' : ' <span class="gl-exam-soon">coming soon</span>';
      return (
        `<li class="gl-exam-module" data-exam-module="${esc(m.id)}">` +
        `<span class="gl-exam-module-name">${esc(m.label)}</span>` +
        `<span class="gl-exam-module-meta">${parts}${time}${soon}</span></li>`
      );
    })
    .join('');
  return (
    `<h3 class="gl-exam-title" data-exam-profile="${esc(manifest.profileId)}">${esc(manifest.displayName)}</h3>` +
    `<p class="gl-exam-sub">Prepare for your actual exam format</p>` +
    `<ul class="gl-exam-modules">${rows}</ul>`
  );
}

const manifestCache = new Map<string, ExamManifest>();

export async function fetchManifest(
  fetcher: typeof authenticatedFetch = authenticatedFetch,
  base = ''
): Promise<{ profileId: string; manifest: ExamManifest }> {
  const res = await fetcher(base + '/api/ai/german-exam/manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 422) throw Object.assign(new Error('unsupported'), { unsupported: true });
  if (!res.ok) throw new Error('manifest_http_' + res.status);
  const data = (await res.json()) as { profileId: string; manifest: ExamManifest };
  if (!data?.manifest || data.manifest.profileId !== data.profileId) throw new Error('manifest_mismatch');
  return data;
}

export interface ExamWorkspaceHooks {
  /** Learner's resolved exam profile id (null = no exam-specific profile). */
  resolveProfileId: () => string | null;
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

const state: ExamWorkspaceState = { profileId: null, manifest: null, status: 'idle' };
const readyWaiters: Array<() => void> = [];
let epoch = 0;

function flushWaiters(): void {
  readyWaiters.splice(0).forEach((cb) => {
    try {
      cb();
    } catch {
      /* a waiter must never break the workspace */
    }
  });
}

function applyDom(): void {
  const root = document.getElementById('glExamGroup');
  const overview = document.getElementById('glExamOverview');
  if (!root) return;
  root.setAttribute('data-exam-state', state.status);
  root.querySelectorAll<HTMLElement>('.gl-skill-card[data-skill]').forEach((card) => {
    const skill = card.getAttribute('data-skill') || '';
    if (!EXAM_SKILLS.includes(skill)) return;
    if (state.status === 'ready' && state.manifest) {
      const nav = buildNavModel(state.manifest).find((m) => m.skill === skill);
      card.hidden = !nav; // a module the exam does not have simply does not exist here
      card.classList.toggle('gl-skill-card-soon', !!nav && !nav.available);
    } else if (state.status === 'loading' || state.status === 'error') {
      card.hidden = true; // never show a previous exam's (or a guessed) structure
    } else {
      card.hidden = false; // no exam-specific profile: unchanged legacy behaviour
    }
  });
  if (overview) {
    if (state.status === 'ready' && state.manifest) {
      overview.innerHTML = renderOverviewHtml(state.manifest);
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

async function refresh(hooks: ExamWorkspaceHooks): Promise<void> {
  const mine = ++epoch;
  if (!hooks.profileReady()) {
    state.status = 'loading';
    applyDom();
    return;
  }
  const wanted = hooks.resolveProfileId();
  if (profileChanged(state.profileId, wanted)) {
    const prev = state.profileId;
    state.profileId = wanted;
    state.manifest = null;
    hooks.onProfileChange(prev, wanted);
  }
  if (!wanted) {
    state.status = 'unsupported';
    applyDom();
    flushWaiters();
    return;
  }
  const cached = manifestCache.get(wanted);
  if (cached) {
    state.manifest = cached;
    state.status = 'ready';
  } else {
    state.status = 'loading';
    applyDom();
    try {
      const data = await fetchManifest(undefined, hooks.base || '');
      if (mine !== epoch) return; // a newer refresh superseded this one
      // The SERVER's resolution of the saved profile is authoritative.
      manifestCache.set(data.profileId, data.manifest);
      if (data.profileId !== wanted) {
        // Local view was stale; adopt the server's exam.
        const prev = state.profileId;
        state.profileId = data.profileId;
        hooks.onProfileChange(prev, data.profileId);
      }
      state.manifest = data.manifest;
      state.status = 'ready';
    } catch (err) {
      if (mine !== epoch) return;
      state.manifest = null;
      state.status = (err as { unsupported?: boolean })?.unsupported ? 'unsupported' : 'error';
    }
  }
  applyDom();
  const active = hooks.activeSkill();
  const reason = active ? skillBlockReason(state, active) : '';
  if (reason) hooks.onActiveSkillBlocked(active, reason);
  flushWaiters();
}

declare global {
  interface Window {
    _glExamState?: () => ExamWorkspaceState;
    _glExamSkillBlocked?: (skill: string) => string;
    _glExamPartAvailability?: (moduleId: string, partId: string) => 'yes' | 'no' | 'pending';
    _glExamOnReady?: (cb: () => void) => void;
  }
}

export function initExamWorkspace(hooks: ExamWorkspaceHooks): void {
  window._glExamState = () => state;
  window._glExamSkillBlocked = (skill) => skillBlockReason(state, skill);
  window._glExamPartAvailability = (moduleId, partId) => partAvailability(state, moduleId, partId);
  window._glExamOnReady = (cb) => {
    if (state.status === 'ready' || state.status === 'unsupported' || state.status === 'error') cb();
    else readyWaiters.push(cb);
  };
  const run = (): void => {
    void refresh(hooks);
  };
  window.addEventListener('ss-profile-updated', run);
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('.gl-exam-retry')) {
      manifestCache.clear();
      run();
    }
  });
  run();
}
