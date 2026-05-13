// Centralised state store for Minallo. Pub-sub: setState merges, listeners
// fire with the new state. Kept deliberately small — features keep their
// own state and use this only for cross-cutting things like the auth user
// and the active selection.
const state = {
    user: null,
    activeSemesterId: 'ws2526',
    activeCourse: null,
    activeFile: null,
    activeCourseSection: 'files',
    isAiGenerating: false,
    settings: {
        darkMode: localStorage.getItem('ss_dark') !== '0', // default to night
        language: localStorage.getItem('ss_lang') || 'en',
    },
};
const listeners = new Set();
export const Store = {
    getState: () => ({ ...state }),
    setState: (update) => {
        if (!update || typeof update !== 'object' || Array.isArray(update)) {
            console.warn('Store.setState ignored invalid update:', update);
            return;
        }
        let next = update;
        if (update.settings && typeof update.settings === 'object' && !Array.isArray(update.settings)) {
            next = {
                ...update,
                settings: { ...state.settings, ...update.settings },
            };
        }
        Object.assign(state, next);
        listeners.forEach((fn) => fn(state));
    },
    subscribe: (fn) => {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    },
    get isAuthenticated() {
        return !!state.user;
    },
    get activeCourseId() {
        return state.activeCourse?.id || null;
    },
};
export default Store;
//# sourceMappingURL=state.js.map