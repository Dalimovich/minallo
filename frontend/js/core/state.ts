// Centralised state store for Minallo. Pub-sub: setState merges, listeners
// fire with the new state. Kept deliberately small — features keep their
// own state and use this only for cross-cutting things like the auth user
// and the active selection.

export interface UserShape {
  id?: string;
  sub?: string;
  email?: string;
  [k: string]: unknown;
}

export interface AppSettings {
  darkMode: boolean;
  language: string;
}

export interface AppStoreState {
  user: UserShape | null;
  activeSemesterId: string;
  activeCourse: { id?: string; [k: string]: unknown } | null;
  activeFile: { name?: string; [k: string]: unknown } | null;
  activeCourseSection: string;
  isAiGenerating: boolean;
  settings: AppSettings;
}

type Listener = (state: AppStoreState) => void;

const state: AppStoreState = {
  user: null,
  activeSemesterId: 'ss2526',
  activeCourse: null,
  activeFile: null,
  activeCourseSection: 'files',
  isAiGenerating: false,
  settings: {
    darkMode: localStorage.getItem('ss_dark') !== '0', // default to night
    language: localStorage.getItem('ss_lang') || 'en',
  },
};

const listeners = new Set<Listener>();

export const Store = {
  getState: (): AppStoreState => ({ ...state }),

  setState: (update: Partial<AppStoreState>): void => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      console.warn('Store.setState ignored invalid update:', update);
      return;
    }
    let next: Partial<AppStoreState> = update;
    if (update.settings && typeof update.settings === 'object' && !Array.isArray(update.settings)) {
      next = {
        ...update,
        settings: { ...state.settings, ...update.settings },
      };
    }
    Object.assign(state, next);
    listeners.forEach((fn) => fn(state));
  },

  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  get isAuthenticated(): boolean {
    return !!state.user;
  },

  get activeCourseId(): string | null {
    return state.activeCourse?.id || null;
  },
};

export default Store;
