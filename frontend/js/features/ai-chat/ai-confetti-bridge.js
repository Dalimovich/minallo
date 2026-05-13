export function spawnConfetti() {
    const cols = ['#FFD93D', '#FF6B35', '#FF6FB7', '#2563EB', '#4CC9F0', '#06D6A0'];
    for (let i = 0; i < 16; i++) {
        const el = document.createElement('div');
        el.className = 'confetti-piece';
        const color = cols[Math.floor(Math.random() * cols.length)];
        el.style.cssText =
            'left:' + Math.random() * 100 +
                'vw;background:' + color +
                ';animation-delay:' + Math.random() * 0.5 +
                's;animation-duration:' + (1 + Math.random()) + 's;';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2200);
    }
}
export function initAiConfettiBridge() {
    window.spawnConfetti = spawnConfetti;
    return { spawnConfetti };
}
//# sourceMappingURL=ai-confetti-bridge.js.map