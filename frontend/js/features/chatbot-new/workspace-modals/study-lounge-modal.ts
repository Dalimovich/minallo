import type { WorkspaceFeature } from './workspace-modal-shell.js';

export const studyLoungeWorkspace: WorkspaceFeature = {
  title: 'Study Lounge',
  subtitle: 'Your real study activity, courses and recent resources',
  sectionId: 'psec-lounge',
  afterMount() {
    window._loungeRender?.();
  }
};

