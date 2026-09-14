export type WorkspaceModalType = 'profile' | 'settings' | 'subscription' | 'study-lounge' | null;

type WorkspaceSessionState = {
  active: WorkspaceModalType;
  settingsCategory: string;
};

export const workspaceModalState: WorkspaceSessionState = {
  active: null,
  settingsCategory: 'general'
};

