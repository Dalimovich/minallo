import type { WorkspaceFeature } from './workspace-modal-shell.js';

export const profileWorkspace: WorkspaceFeature = {
  title: 'Profile',
  subtitle: 'Your identity and study information',
  sectionId: 'psec-profile',
  afterMount(section) {
    section.classList.add('mn-profile-workspace');
    const hero = section.querySelector<HTMLElement>('.profile-hero');
    if (!hero || hero.querySelector('.mn-profile-completion')) return;
    const completion = document.createElement('div');
    completion.className = 'mn-profile-completion';
    completion.innerHTML = '<div><span>Profile completeness</span><strong>0%</strong></div><progress max="100" value="0" aria-label="Profile completeness"></progress>';
    hero.appendChild(completion);
    const update = (): void => {
      const fields = Array.from(section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.profile-fields input:not([readonly]), .profile-fields select'));
      const relevant = fields.filter((field) => field.closest<HTMLElement>('.pf-group')?.style.display !== 'none');
      const filled = relevant.filter((field) => String(field.value || '').trim()).length;
      const value = relevant.length ? Math.round((filled / relevant.length) * 100) : 0;
      const progress = completion.querySelector<HTMLProgressElement>('progress')!;
      progress.value = value;
      completion.querySelector('strong')!.textContent = `${value}%`;
    };
    if (section.dataset.mnProfileCompletionBound !== '1') {
      section.dataset.mnProfileCompletionBound = '1';
      section.addEventListener('input', update);
      section.addEventListener('change', update);
      window.addEventListener('ss-profile-updated', update);
    }
    update();
    window.setTimeout(update, 250);
  }
};
