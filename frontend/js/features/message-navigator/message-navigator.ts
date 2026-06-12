// ── Message Navigator ──────────────────────────────────────────────────────
// Reusable vertical message minimap for chat surfaces. Renders a slim track
// of dash markers (one per message) overlaid on the right edge of a chat
// scroller; hovering/focusing it expands a floating panel with message
// previews. Clicking a marker or preview smooth-scrolls to that message.
//
// Used by:
//   - the standalone Chatbot (features/chatbot-new/shell.ts), compact=false
//   - the AI side panel (#aiPanel via app.ts), compact=true
//
// The component is fully DOM-driven: it watches the messages container with
// a MutationObserver, so streaming, regeneration, history replay, and chat
// switches all stay in sync without the caller wiring any events. Styles are
// injected from JS so both surfaces share one stylesheet without touching
// the loader's CSS lists (and their cache-bust choreography).
//
// Positioning: the navigator is absolutely positioned but its coordinates
// are delta-corrected against getBoundingClientRect() instead of trusting a
// particular positioned ancestor. The AI panel gets re-parented into the
// document-rail drawer with `position: static` forced inline, so "nearest
// positioned ancestor" is not stable across hosts — rect-delta math is.

export interface MessageNavigatorOptions {
  /** Non-scrolling element that receives the overlay (kept across re-renders). */
  host: HTMLElement;
  /** The scroll container of the message list. */
  scroller: HTMLElement;
  /** Element whose DIRECT children are the message rows (observed for adds/removes). */
  container: HTMLElement;
  /** Selector matching message rows inside `container`. */
  messageSelector: string;
  /** Distinguishes user rows from assistant rows. */
  isUser: (row: HTMLElement) => boolean;
  /** Element to extract the preview snippet from. Defaults to the row itself. */
  snippetSource?: (row: HTMLElement) => HTMLElement | null;
  /** Element overlapping the bottom of the scroller (e.g. a sticky composer). */
  bottomGuard?: () => HTMLElement | null;
  /** Extra px to keep clear of the scroller's right edge, measured per layout
   *  pass — for fixed overlays that cover it (e.g. the document-rail buttons). */
  rightInset?: () => number;
  /** Smaller track + preview panel for narrow surfaces. */
  compact?: boolean;
  /** Navigator stays hidden below this many messages. Default 4. */
  minMessages?: number;
}

export interface MessageNavigatorHandle {
  refresh(): void;
  destroy(): void;
}

const STYLE_ID = 'msgnav-styles';

const CSS = `
.message-navigator {
  position: absolute;
  left: 0;
  top: 0;
  width: 22px;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.message-navigator[data-hidden] { display: none; }

.message-navigator-track {
  position: relative;
  width: 18px;
  pointer-events: auto;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: background 160ms ease, border-color 160ms ease;
}
.message-navigator:hover .message-navigator-track,
.message-navigator[data-open] .message-navigator-track {
  background: rgba(15, 23, 42, 0.55);
  border-color: rgba(255, 255, 255, 0.16);
}

.message-nav-marker {
  position: absolute;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 16px;
  height: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.message-nav-marker::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 6px;
  height: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  transition: width 160ms ease, height 160ms ease, background 160ms ease, box-shadow 160ms ease;
}
.message-nav-marker--user::before {
  width: 9px;
  background: rgba(255, 255, 255, 0.38);
}
.message-nav-marker:hover::before,
.message-nav-marker:focus-visible::before {
  background: rgba(255, 255, 255, 0.7);
}
.message-nav-marker.active::before {
  width: 12px;
  height: 3px;
  background: #5b8cff;
  box-shadow: 0 0 12px rgba(91, 140, 255, 0.5);
}
.message-nav-marker:focus-visible {
  outline: 1px solid rgba(91, 140, 255, 0.8);
  outline-offset: 1px;
  border-radius: 999px;
}

.message-navigator-panel {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%) translateX(6px);
  width: 320px;
  max-height: min(420px, 100%);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  border-radius: 16px;
  background: rgba(21, 23, 29, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 160ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1), visibility 160ms;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.message-navigator[data-open] .message-navigator-panel {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(-50%) translateX(0);
}

.message-navigator-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12px;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  border-radius: 10px;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.62);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.35;
  text-align: right;
  transition: background 120ms ease, color 120ms ease;
}
.message-navigator-item--user .message-navigator-text { font-weight: 600; }
.message-navigator-item--ai {
  color: rgba(255, 255, 255, 0.42);
  text-align: left;
  font-size: 12.5px;
}
.message-navigator-item:hover,
.message-navigator-item:focus-visible {
  background: rgba(255, 255, 255, 0.06);
  color: #ffffff;
}
.message-navigator-item.active {
  color: #6ea0ff;
  background: rgba(91, 140, 255, 0.10);
}
.message-navigator-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-navigator-dash {
  width: 10px;
  height: 3px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.85;
  justify-self: end;
}

/* Compact variant (AI side panel) */
.message-navigator--compact { width: 18px; }
.message-navigator--compact .message-navigator-track { width: 14px; }
.message-navigator--compact .message-navigator-panel {
  right: calc(100% + 8px);
  width: 238px;
  max-height: min(340px, 100%);
  padding: 6px;
  border-radius: 14px;
}
.message-navigator--compact .message-navigator-item {
  padding: 7px 9px;
  font-size: 12px;
}
.message-navigator--compact .message-navigator-item--ai { font-size: 11.5px; }

/* Light theme (body without .night is light mode — see light-mode.css) */
body:not(.night) .message-navigator-track {
  background: rgba(37, 99, 235, 0.07);
  border-color: rgba(37, 99, 235, 0.18);
}
body:not(.night) .message-navigator:hover .message-navigator-track,
body:not(.night) .message-navigator[data-open] .message-navigator-track {
  background: rgba(37, 99, 235, 0.12);
  border-color: rgba(37, 99, 235, 0.28);
}
body:not(.night) .message-nav-marker::before { background: rgba(23, 32, 51, 0.28); }
body:not(.night) .message-nav-marker--user::before { background: rgba(23, 32, 51, 0.48); }
body:not(.night) .message-nav-marker:hover::before,
body:not(.night) .message-nav-marker:focus-visible::before { background: rgba(23, 32, 51, 0.7); }
body:not(.night) .message-nav-marker.active::before {
  background: #2563eb;
  box-shadow: 0 0 10px rgba(37, 99, 235, 0.4);
}
body:not(.night) .message-navigator-panel {
  background: rgba(255, 255, 255, 0.97);
  border-color: rgba(37, 99, 235, 0.22);
  box-shadow: 0 18px 46px rgba(37, 99, 235, 0.16);
  scrollbar-color: rgba(37, 99, 235, 0.3) transparent;
}
body:not(.night) .message-navigator-item { color: #53647f; }
body:not(.night) .message-navigator-item--ai { color: #6b7b94; }
body:not(.night) .message-navigator-item:hover,
body:not(.night) .message-navigator-item:focus-visible {
  background: rgba(37, 99, 235, 0.08);
  color: #172033;
}
body:not(.night) .message-navigator-item.active {
  color: #2563eb;
  background: rgba(37, 99, 235, 0.10);
}

@media (max-width: 720px) {
  .message-navigator { display: none; }
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

let _msgIdSeq = 0;

/** First meaningful line of a message, markdown/KaTeX junk stripped. */
function extractSnippet(src: HTMLElement | null): string {
  if (!src) return '…';
  const clone = src.cloneNode(true) as HTMLElement;
  // KaTeX renders the TeX source twice (MathML + HTML); drop the hidden copy.
  // Sender/meta chrome would pollute previews with "Minallo AI · Copy".
  clone
    .querySelectorAll('.katex-mathml, .msg-sender, .msg-meta, .ncb-bubble-head, style, script')
    .forEach((n) => n.remove());
  const text = (clone.textContent || '')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '…';
  return text.length > 56 ? text.slice(0, 56).trimEnd() + '…' : text;
}

export function attachMessageNavigator(opts: MessageNavigatorOptions): MessageNavigatorHandle {
  ensureStyles();
  const compact = !!opts.compact;
  const minMessages = opts.minMessages ?? 4;
  const navWidth = compact ? 18 : 22;
  const rightGap = compact ? 6 : 10;
  const markerPitch = compact ? 11 : 13;

  if (getComputedStyle(opts.host).position === 'static') {
    opts.host.style.position = 'relative';
  }

  const nav = document.createElement('div');
  nav.className = 'message-navigator' + (compact ? ' message-navigator--compact' : '');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Message navigator');
  nav.dataset.hidden = '1';
  const track = document.createElement('div');
  track.className = 'message-navigator-track';
  const panel = document.createElement('div');
  panel.className = 'message-navigator-panel';
  nav.appendChild(track);
  nav.appendChild(panel);
  opts.host.appendChild(nav);

  let rows: HTMLElement[] = [];
  let activeIdx = -1;
  let destroyed = false;
  let rafId = 0;
  let settleTimer = 0;
  let closeTimer = 0;

  const isOpen = (): boolean => nav.dataset.open === '1';

  function collectRows(): HTMLElement[] {
    const found = Array.from(
      opts.container.querySelectorAll<HTMLElement>(opts.messageSelector)
    );
    found.forEach((row) => {
      if (!row.dataset.messageId) row.dataset.messageId = 'msg_' + ++_msgIdSeq;
    });
    return found;
  }

  function updateGeometry(): void {
    const sRect = opts.scroller.getBoundingClientRect();
    const guard = opts.bottomGuard ? opts.bottomGuard() : null;
    const guardH =
      guard && guard.offsetParent !== null ? guard.getBoundingClientRect().height : 0;
    const gap = 14;
    const height = sRect.height - gap * 2 - guardH;
    if (rows.length < minMessages || height < 110 || sRect.width < 300) {
      nav.dataset.hidden = '1';
      delete nav.dataset.open;
      return;
    }
    delete nav.dataset.hidden;
    nav.style.width = navWidth + 'px';
    nav.style.height = Math.round(height) + 'px';
    // Delta-correct against the live rect instead of assuming which ancestor
    // is the containing block (it changes when #aiPanel is hosted in the
    // document-rail drawer with position:static forced inline).
    const inset = rightGap + Math.max(0, opts.rightInset ? opts.rightInset() : 0);
    const nRect = nav.getBoundingClientRect();
    const curLeft = parseFloat(nav.style.left) || 0;
    const curTop = parseFloat(nav.style.top) || 0;
    nav.style.left = Math.round(curLeft + (sRect.right - inset - navWidth) - nRect.left) + 'px';
    nav.style.top = Math.round(curTop + (sRect.top + gap) - nRect.top) + 'px';
  }

  function rebuildMarkers(): void {
    track.textContent = '';
    const n = rows.length;
    if (n === 0 || nav.dataset.hidden) return;
    const navH = parseFloat(nav.style.height) || 0;
    const pad = 10;
    const pitch = n > 1 ? Math.min(markerPitch, (navH - pad * 2 - 4) / (n - 1)) : 0;
    track.style.height = Math.round(pad * 2 + 4 + pitch * (n - 1)) + 'px';
    rows.forEach((row, i) => {
      const m = document.createElement('button');
      m.type = 'button';
      m.className =
        'message-nav-marker' +
        (opts.isUser(row) ? ' message-nav-marker--user' : '') +
        (i === activeIdx ? ' active' : '');
      m.style.top = Math.round(pad + 2 + i * pitch) + 'px';
      m.setAttribute(
        'aria-label',
        'Jump to ' + (opts.isUser(row) ? 'your message ' : 'AI reply ') + (i + 1)
      );
      m.addEventListener('click', () => jumpTo(i));
      track.appendChild(m);
    });
  }

  function buildPanel(): void {
    panel.textContent = '';
    rows.forEach((row, i) => {
      const user = opts.isUser(row);
      const item = document.createElement('button');
      item.type = 'button';
      item.className =
        'message-navigator-item ' +
        (user ? 'message-navigator-item--user' : 'message-navigator-item--ai') +
        (i === activeIdx ? ' active' : '');
      item.dataset.idx = String(i);
      const text = document.createElement('span');
      text.className = 'message-navigator-text';
      const src = opts.snippetSource ? opts.snippetSource(row) : row;
      const snippet = extractSnippet(src);
      text.textContent = snippet;
      item.title = snippet;
      const dash = document.createElement('span');
      dash.className = 'message-navigator-dash';
      item.appendChild(text);
      item.appendChild(dash);
      item.addEventListener('click', () => jumpTo(i));
      panel.appendChild(item);
    });
  }

  function setActive(idx: number): void {
    if (idx === activeIdx) return;
    activeIdx = idx;
    const markers = track.children;
    for (let i = 0; i < markers.length; i++) {
      markers[i]?.classList.toggle('active', i === idx);
    }
    const items = panel.children;
    for (let i = 0; i < items.length; i++) {
      items[i]?.classList.toggle('active', i === idx);
    }
  }

  function updateActive(): void {
    if (rows.length === 0) return;
    const s = opts.scroller;
    if (s.scrollTop + s.clientHeight >= s.scrollHeight - 8) {
      setActive(rows.length - 1);
      return;
    }
    if (s.scrollTop <= 8) {
      setActive(0);
      return;
    }
    const sRect = s.getBoundingClientRect();
    const mid = sRect.top + sRect.height / 2;
    let best = Infinity;
    let idx = activeIdx;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    setActive(idx);
  }

  function jumpTo(idx: number): void {
    const row = rows[idx];
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setActive(idx);
  }

  function openPanel(): void {
    if (isOpen() || nav.dataset.hidden) return;
    updateGeometry();
    buildPanel();
    nav.dataset.open = '1';
    panel.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function closePanel(): void {
    delete nav.dataset.open;
  }

  function scheduleClose(): void {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(closePanel, 280);
  }

  function refreshNow(): void {
    if (destroyed) return;
    rows = collectRows();
    activeIdx = -1; // force class re-sync after rebuild
    updateGeometry();
    rebuildMarkers();
    if (isOpen()) buildPanel();
    updateActive();
  }

  function schedule(): void {
    if (destroyed) return;
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      refreshNow();
    });
    // Trailing pass: catches layout that settles after transitions (drawer
    // slide-in, context-panel collapse) which ResizeObserver can miss.
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(refreshNow, 360);
  }

  nav.addEventListener('pointerenter', () => {
    window.clearTimeout(closeTimer);
    openPanel();
  });
  nav.addEventListener('pointerleave', scheduleClose);
  track.addEventListener('click', (ev) => {
    if (ev.target === track) openPanel();
  });
  nav.addEventListener('focusin', () => {
    window.clearTimeout(closeTimer);
    openPanel();
  });
  nav.addEventListener('focusout', (ev) => {
    const next = ev.relatedTarget;
    if (!(next instanceof Node) || !nav.contains(next)) scheduleClose();
  });
  nav.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closePanel();
      (document.activeElement as HTMLElement | null)?.blur();
    }
  });

  let scrollRaf = 0;
  const onScroll = (): void => {
    if (destroyed || scrollRaf) return;
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0;
      updateGeometry();
      updateActive();
    });
  };
  opts.scroller.addEventListener('scroll', onScroll, { passive: true });

  const mo = new MutationObserver(schedule);
  mo.observe(opts.container, { childList: true });

  const ro = new ResizeObserver(schedule);
  ro.observe(opts.scroller);
  ro.observe(opts.host);

  window.addEventListener('resize', schedule);

  schedule();

  return {
    refresh: schedule,
    destroy(): void {
      destroyed = true;
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      opts.scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(settleTimer);
      window.clearTimeout(closeTimer);
      if (rafId) window.cancelAnimationFrame(rafId);
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
      nav.remove();
    },
  };
}
