/**
 * Centralized State Management for StudySphere
 */
const state = {
    user: null,
    activeSemesterId: 'ws2526',
    activeCourse: null,
    activeFile: null,
    activeCourseSection: 'files',
    isAiGenerating: false,
    settings: {
        darkMode: false,
        language: localStorage.getItem('ss_lang') || 'en'
    }
};

const listeners = new Set();

export const Store = {
    getState: () => ({ ...state }),
    
    setState: (update) => {
        Object.assign(state, update);
        listeners.forEach(fn => fn(state));
    },
    
    subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    // Helper getters
    get isAuthenticated() {
        return !!state.user;
    },

    get activeCourseId() {
        return state.activeCourse?.id || null;
    }
};

// Exporting a frozen proxy to prevent direct mutations from outside
export default Store;