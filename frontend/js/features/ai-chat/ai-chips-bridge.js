import { chipPrompt as _chipPrompt, closeAllOpts as _closeAllOpts, initChipListeners, } from './ai-chips.js';
export function initAiChipsBridge() {
    window.chipPrompt = (type, level) => _chipPrompt(type, level);
    window.closeAllOpts = () => _closeAllOpts();
    initChipListeners();
    return {
        chipPrompt: window.chipPrompt,
        closeAllOpts: window.closeAllOpts,
    };
}
//# sourceMappingURL=ai-chips-bridge.js.map