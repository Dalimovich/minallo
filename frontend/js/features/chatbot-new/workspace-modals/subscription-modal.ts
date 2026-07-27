import type { WorkspaceFeature } from './workspace-modal-shell.js';

export const subscriptionWorkspace: WorkspaceFeature = {
  title: 'Subscription',
  subtitle: 'Your plan, billing status and subscription controls',
  sectionId: 'psec-subscription',
  afterMount() {
    void window.refreshSubscriptionView?.();
  }
};

