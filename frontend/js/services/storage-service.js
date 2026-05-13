// Centralized localStorage/sessionStorage helpers. Features should read /
// write through these instead of touching localStorage directly so quota
// errors and JSON parse errors are handled in one place.
export function getItem(key, defaultValue = null) {
    try {
        const val = localStorage.getItem(key);
        return val !== null ? val : defaultValue;
    }
    catch {
        return defaultValue;
    }
}
export function setItem(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
        /* quota exceeded — ignore */
    }
}
export function removeItem(key) {
    try {
        localStorage.removeItem(key);
    }
    catch {
        /* ignore */
    }
}
export function getJson(key, defaultValue = null) {
    try {
        const raw = localStorage.getItem(key);
        return raw !== null ? JSON.parse(raw) : defaultValue;
    }
    catch {
        return defaultValue;
    }
}
export function setJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* ignore */
    }
}
export function loadAppState() {
    return getJson('ss_state', {}) || {};
}
export function saveAppState(state) {
    setJson('ss_state', state);
}
export function loadSettings() {
    return {
        dark: getItem('ss_dark') === 'true',
        lang: getItem('ss_lang', 'en') || 'en',
        autoOpenAI: getItem('ss_auto_open_ai') === 'true',
        saveChatHistory: getItem('ss_save_chat') !== 'false',
    };
}
export function saveSetting(key, value) {
    setItem(key, String(value));
}
export function loadChat(filename) {
    return getJson('ss_chat_' + filename, []) || [];
}
export function saveChat(filename, messages) {
    setJson('ss_chat_' + filename, messages);
}
export function clearChat(filename) {
    removeItem('ss_chat_' + filename);
}
//# sourceMappingURL=storage-service.js.map