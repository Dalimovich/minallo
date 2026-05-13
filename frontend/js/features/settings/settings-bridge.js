import { t, applyLanguage } from './language.js';
import { applySettings } from './settings.js';
export { t };
export function initSettingsBridge() {
    window._t = t;
    window.applyLanguage = applyLanguage;
    window.applySettings = applySettings;
}
//# sourceMappingURL=settings-bridge.js.map