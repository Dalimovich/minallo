import { trapWorkspaceFocus } from './workspace-modal-focus.js';
import { workspaceModalState, type WorkspaceModalType } from './workspace-modal-store.js';
import { profileWorkspace } from './profile-modal.js';
import { settingsWorkspace } from './settings-modal.js';
import { subscriptionWorkspace } from './subscription-modal.js';
import { studyLoungeWorkspace } from './study-lounge-modal.js';

export type WorkspaceFeature = {
  title: string;
  subtitle: string;
  sectionId: string;
  layout: WorkspaceModalLayout;
  nav?: Array<[string, string]>;
  afterMount?: (section: HTMLElement) => void;
};

export type WorkspaceModalLayout = 'full' | 'sidebar-content' | 'content-detail' | 'three-column';

const features: Record<Exclude<WorkspaceModalType, null>, WorkspaceFeature> = {
  profile: profileWorkspace,
  settings: settingsWorkspace,
  subscription: subscriptionWorkspace,
  'study-lounge': studyLoungeWorkspace
};

let cleanupWorkspaceModal: (() => void) | null = null;

function ensureStyles(): void {
  if (document.querySelector('[data-mn-workspace-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/js/features/chatbot-new/workspace-modals/workspace-modal.css';
  link.dataset.mnWorkspaceStyles = '1';
  document.head.appendChild(link);
}

export function closeWorkspaceModal(): void {
  cleanupWorkspaceModal?.();
}

export function openWorkspaceModal(type: Exclude<WorkspaceModalType, null>): void {
  cleanupWorkspaceModal?.();
  ensureStyles();
  const feature = features[type];
  const section = document.getElementById(feature.sectionId);
  if (!section) return;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousOverflow = document.body.style.overflow;
  const previousDisplay = section.style.display;
  const previousHidden = section.hidden;
  const previousAriaHidden = section.getAttribute('aria-hidden');
  const origin = document.createComment('mn-workspace-origin');
  section.parentNode?.insertBefore(origin, section);

  const mount = document.createElement('div');
  mount.className = 'mn-workspace-modal-root';
  mount.innerHTML = `
    <div class="mn-workspace-backdrop">
      <section class="mn-workspace-modal" role="dialog" aria-modal="true" aria-labelledby="mn-workspace-title" tabindex="-1" data-workspace-type="${type}" data-layout="${feature.layout}">
        <header class="mn-workspace-header">
          <div><p class="mn-workspace-eyebrow">Minallo workspace</p><h1 id="mn-workspace-title"></h1><p class="mn-workspace-subtitle"></p></div>
          <button class="mn-workspace-close" type="button" aria-label="Close workspace">&times;</button>
        </header>
        <div class="mn-workspace-body">
          ${feature.nav?.length ? '<nav class="mn-workspace-nav" aria-label="Settings categories"></nav>' : ''}
          <main class="mn-workspace-content"></main>
        </div>
        <div class="mn-workspace-status" role="status" aria-live="polite"></div>
      </section>
    </div>`;
  document.body.appendChild(mount);
  const backdrop = mount.querySelector<HTMLElement>('.mn-workspace-backdrop')!;
  const dialog = mount.querySelector<HTMLElement>('.mn-workspace-modal')!;
  const content = mount.querySelector<HTMLElement>('.mn-workspace-content')!;
  const nav = mount.querySelector<HTMLElement>('.mn-workspace-nav');
  mount.querySelector<HTMLElement>('#mn-workspace-title')!.textContent = feature.title;
  mount.querySelector<HTMLElement>('.mn-workspace-subtitle')!.textContent = feature.subtitle;

  if (feature.nav?.length && nav) {
    feature.nav.forEach(([id, label], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.settingsCategory = id;
      button.classList.toggle('is-active', index === 0);
      button.addEventListener('click', () => {
        workspaceModalState.settingsCategory = id;
        nav.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item === button));
        const blocks = Array.from(section.querySelectorAll<HTMLElement>('.settings-block'));
        const target = blocks[Math.min(index, Math.max(0, blocks.length - 1))];
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      nav.appendChild(button);
    });
  }

  section.hidden = false;
  section.style.setProperty('display', 'block', 'important');
  section.removeAttribute('inert');
  section.setAttribute('aria-hidden', 'false');
  content.appendChild(section);
  document.body.style.overflow = 'hidden';
  document.body.classList.add('mn-workspace-open');
  workspaceModalState.active = type;
  feature.afterMount?.(section);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    section.style.removeProperty('display');
    section.style.display = previousDisplay;
    section.hidden = previousHidden;
    if (previousAriaHidden === null) section.removeAttribute('aria-hidden');
    else section.setAttribute('aria-hidden', previousAriaHidden);
    if (origin.parentNode) origin.parentNode.insertBefore(section, origin);
    origin.remove();
    mount.remove();
    document.body.style.overflow = previousOverflow;
    document.body.classList.remove('mn-workspace-open');
    workspaceModalState.active = null;
    cleanupWorkspaceModal = null;
    previousFocus?.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else trapWorkspaceFocus(dialog, event);
  };
  mount.querySelector('.mn-workspace-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeyDown, true);
  cleanupWorkspaceModal = close;
  requestAnimationFrame(() => (dialog.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]') || dialog).focus());
}
