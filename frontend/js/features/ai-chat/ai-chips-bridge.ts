import {
  chipPrompt as _chipPrompt,
  closeAllOpts as _closeAllOpts,
  initChipListeners,
} from './ai-chips.js';

export function initAiChipsBridge(): {
  chipPrompt: (type: string, level?: string) => unknown;
  closeAllOpts: () => void;
} {
  window.chipPrompt = (type: string, level?: string) => _chipPrompt(type, level);
  window.closeAllOpts = () => _closeAllOpts();
  initChipListeners();
  return {
    chipPrompt: window.chipPrompt,
    closeAllOpts: window.closeAllOpts,
  };
}
