type AiChipsModule = typeof import('./ai-chips.js');
let _chipsPromise: Promise<AiChipsModule> | null = null;
function _loadChips(): Promise<AiChipsModule> {
  if (!_chipsPromise) _chipsPromise = import(/* @vite-ignore */ atob('Li9haS1jaGlwcy5qcw=='));
  return _chipsPromise;
}

export function initAiChipsBridge(): {
  chipPrompt: (type: string, level?: string) => unknown;
  closeAllOpts: () => void;
} {
  window.chipPrompt = (type: string, level?: string) =>
    _loadChips().then((mod) => mod.chipPrompt(type, level));
  window.closeAllOpts = () => {
    void _loadChips().then((mod) => mod.closeAllOpts());
  };
  const root = document.getElementById('aiPanel') || document.body;
  root.addEventListener('pointerdown', () => {
    void _loadChips().then((mod) => mod.initChipListeners());
  }, { once: true, capture: true });
  return {
    chipPrompt: window.chipPrompt,
    closeAllOpts: window.closeAllOpts,
  };
}
