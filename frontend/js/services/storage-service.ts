// Centralized localStorage/sessionStorage helpers. Features should read /
// write through these instead of touching localStorage directly so quota
// errors and JSON parse errors are handled in one place.

export function getItem(key: string, defaultValue: string | null = null): string | null {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded — ignore */
  }
}

export function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getJson<T = unknown>(key: string, defaultValue: T | null = null): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export interface AppState {
  semId?: string;
  courseId?: string;
  fileName?: string;
  section?: string;
  inApp?: boolean;
}

export function loadAppState(): AppState {
  return getJson<AppState>('ss_state', {}) || {};
}

export function saveAppState(state: AppState): void {
  setJson('ss_state', state);
}

export interface UserSettings {
  dark: boolean;
  lang: string;
  autoOpenAI: boolean;
  saveChatHistory: boolean;
}

export function loadSettings(): UserSettings {
  return {
    dark: getItem('ss_dark') === 'true',
    lang: getItem('ss_lang', 'en') || 'en',
    autoOpenAI: getItem('ss_auto_open_ai') === 'true',
    saveChatHistory: getItem('ss_save_chat') !== 'false',
  };
}

export function saveSetting(key: string, value: unknown): void {
  setItem(key, String(value));
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  [k: string]: unknown;
}

export function loadChat(filename: string): ChatMessage[] {
  return getJson<ChatMessage[]>('ss_chat_' + filename, []) || [];
}

export function saveChat(filename: string, messages: ChatMessage[]): void {
  setJson('ss_chat_' + filename, messages);
}

export function clearChat(filename: string): void {
  removeItem('ss_chat_' + filename);
}
