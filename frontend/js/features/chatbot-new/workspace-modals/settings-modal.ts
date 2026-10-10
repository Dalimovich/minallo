import type { WorkspaceFeature } from './workspace-modal-shell.js';

export const settingsWorkspace: WorkspaceFeature = {
  title: 'Settings',
  subtitle: 'Preferences, data and account controls',
  sectionId: 'psec-settings',
  layout: 'sidebar-content',
  nav: [
    ['general', 'General'],
    ['learning', 'AI & learning'],
    ['services', 'Music services'],
    ['data', 'Privacy & data'],
    ['account', 'Account']
  ]
};
