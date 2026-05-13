export function initPullToRefresh() {
    const THRESHOLD = 80;
    let startY = 0;
    let curY = 0;
    let active = false;
    const ind = document.createElement('div');
    ind.id = 'ptr-indicator';
    ind.innerHTML =
        '<svg id="ptr-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="20"/><polyline points="18 14 12 20 6 14"/></svg>';
    ind.style.cssText =
        'position:fixed;top:-50px;left:50%;transform:translateX(-50%);width:32px;height:32px;border-radius:50%;background:rgba(20,15,40,.88);box-shadow:0 2px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999;transition:top .15s ease,opacity .15s ease;opacity:0;color:#fff;pointer-events:none';
    document.body.appendChild(ind);
    const arrow = ind.querySelector('#ptr-arrow');
    if (!arrow)
        return;
    function setProgress(dy) {
        const p = Math.min(dy / THRESHOLD, 1);
        const top = Math.min(-60 + dy * 0.9, 16);
        ind.style.top = top + 'px';
        ind.style.opacity = String(p);
        arrow.style.transform = 'rotate(' + (-180 + 180 * p) + 'deg)';
        arrow.style.transition = 'transform .1s';
    }
    function reset() {
        ind.style.top = '-60px';
        ind.style.opacity = '0';
        arrow.style.transform = 'rotate(0deg)';
    }
    document.addEventListener('touchstart', (e) => {
        const appEl = document.getElementById('app');
        const inPdf = !!(appEl && appEl.style.display === 'flex');
        const touch = e.touches[0];
        if (!touch)
            return;
        startY = touch.clientY;
        active = !inPdf && (window.scrollY === 0 || document.documentElement.scrollTop === 0);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!active)
            return;
        const touch = e.touches[0];
        if (!touch)
            return;
        curY = touch.clientY;
        const dy = curY - startY;
        if (dy > 0)
            setProgress(dy);
    }, { passive: true });
    document.addEventListener('touchend', () => {
        if (!active)
            return;
        active = false;
        const dy = curY - startY;
        if (dy >= THRESHOLD) {
            arrow.style.transition = 'transform .4s';
            arrow.style.transform = 'rotate(360deg)';
            ind.style.top = '16px';
            setTimeout(() => location.reload(), 400);
        }
        else {
            reset();
        }
    }, { passive: true });
}
//# sourceMappingURL=pull-to-refresh.js.map