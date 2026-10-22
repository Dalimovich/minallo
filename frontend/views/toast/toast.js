// Minallo toast/notification system.
// Public API (kept backward compatible with the old 2-arg signature):
//   showToast(title, sub)
//   showToast(title, sub, { variant, icon, action: { label, onClick }, duration })
var MINALLO_TOAST_MAX_VISIBLE = 3;
var MINALLO_TOAST_DEFAULT_DURATION = 6000;
var MINALLO_TOAST_STACK_GAP = 10;
var minalloToastReduceMotion =
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var MINALLO_TOAST_ICONS = {
  info:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8.5v.01M12 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.6"/></svg>',
  success:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.6"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4.5l9 15.5H3l9-15.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v4.2M12 17v.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.6"/></svg>',
  feature:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5.2c-1.4-1-3.4-1.3-5.2-.6-.4.15-.6.6-.5 1a10 10 0 000 12.8c-.1.4.1.85.5 1 1.8.7 3.8.4 5.2-.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 5.2c1.4-1 3.4-1.3 5.2-.6.4.15.6.6.5 1a10 10 0 010 12.8c.1.4-.1.85-.5 1-1.8.7-3.8.4-5.2-.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 5.2V19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.6 3.4l.35 1.05.35-1.05.35 1.05.35-1.05" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/></svg>',
};

var MINALLO_TOAST_ARROW =
  '<svg viewBox="0 0 16 16" fill="none" class="ss-toast-arrow"><path d="M3.5 8h9M8.5 4.2L12.3 8l-3.8 3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

var MINALLO_TOAST_CLOSE =
  '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function minalloEnsureToastStack() {
  var stack = document.getElementById('ss-toast-stack');
  if (!stack) return null;
  return stack;
}

function minalloRenderSparkles(container) {
  if (minalloToastReduceMotion) return;
  var count = 3 + Math.floor(Math.random() * 3); // 3-5
  for (var i = 0; i < count; i++) {
    var s = document.createElement('span');
    s.className = 'ss-toast-sparkle';
    var angle = Math.random() * 360;
    var dist = 14 + Math.random() * 16;
    var x = Math.cos((angle * Math.PI) / 180) * dist;
    var y = Math.sin((angle * Math.PI) / 180) * dist;
    s.style.setProperty('--sx', x.toFixed(1) + 'px');
    s.style.setProperty('--sy', y.toFixed(1) + 'px');
    s.style.setProperty('--sr', (Math.random() * 40 - 20).toFixed(0) + 'deg');
    s.style.setProperty('--sd', (500 + Math.random() * 400).toFixed(0) + 'ms');
    s.style.setProperty('--sdelay', (Math.random() * 150).toFixed(0) + 'ms');
    container.appendChild(s);
  }
}

function minalloDismissToast(el) {
  if (!el || el.dataset.dismissing === '1') return;
  el.dataset.dismissing = '1';
  clearTimeout(el._toastTimer);
  el.classList.remove('is-visible');
  el.classList.add('is-leaving');
  var cleanup = function () {
    el.removeEventListener('transitionend', cleanup);
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  if (minalloToastReduceMotion) {
    setTimeout(cleanup, 120);
  } else {
    el.addEventListener('transitionend', cleanup);
    setTimeout(cleanup, 320); // safety net
  }
}

function minalloTrimToastStack(stack) {
  var toasts = stack.querySelectorAll('.ss-toast:not(.is-leaving)');
  if (toasts.length <= MINALLO_TOAST_MAX_VISIBLE) return;
  for (var i = MINALLO_TOAST_MAX_VISIBLE; i < toasts.length; i++) {
    minalloDismissToast(toasts[i]);
  }
}

function showToast(title, sub, options) {
  var stack = minalloEnsureToastStack();
  if (!stack) return;

  var opts = options || {};
  var variant = opts.variant || 'info';
  var iconKey = opts.icon || variant;
  var iconMarkup = MINALLO_TOAST_ICONS[iconKey] || MINALLO_TOAST_ICONS.info;
  var hasAction = opts.action && typeof opts.action.onClick === 'function';
  var duration = typeof opts.duration === 'number' ? opts.duration : (hasAction ? 8000 : MINALLO_TOAST_DEFAULT_DURATION);

  var el = document.createElement('div');
  el.className = 'ss-toast ss-toast--' + variant;
  el.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  var iconWrap = document.createElement('div');
  iconWrap.className = 'ss-toast-icon';
  iconWrap.innerHTML = iconMarkup;
  el.appendChild(iconWrap);

  var body = document.createElement('div');
  body.className = 'ss-toast-body';

  var titleRow = document.createElement('div');
  titleRow.className = 'ss-toast-title-row';
  var titleEl = document.createElement('div');
  titleEl.className = 'ss-toast-title';
  titleEl.textContent = title || '';
  titleRow.appendChild(titleEl);
  body.appendChild(titleRow);

  if (sub) {
    var subEl = document.createElement('div');
    subEl.className = 'ss-toast-sub';
    subEl.textContent = sub;
    body.appendChild(subEl);
  }

  if (hasAction) {
    var actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'ss-toast-action';
    actionBtn.innerHTML = '<span>' + (opts.action.label || 'Open') + '</span>' + MINALLO_TOAST_ARROW;
    actionBtn.addEventListener('click', function () {
      try {
        opts.action.onClick();
      } finally {
        minalloDismissToast(el);
      }
    });
    body.appendChild(actionBtn);
  }

  el.appendChild(body);

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ss-toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.innerHTML = MINALLO_TOAST_CLOSE;
  closeBtn.addEventListener('click', function () {
    minalloDismissToast(el);
  });
  el.appendChild(closeBtn);

  if (duration > 0) {
    var progress = document.createElement('div');
    progress.className = 'ss-toast-progress';
    var progressBar = document.createElement('span');
    progressBar.style.animationDuration = duration + 'ms';
    progress.appendChild(progressBar);
    el.appendChild(progress);
  }

  minalloRenderSparkles(iconWrap);

  stack.insertBefore(el, stack.firstChild);
  minalloTrimToastStack(stack);

  // Force layout before adding the visible class so the entrance transition runs.
  void el.offsetWidth;
  requestAnimationFrame(function () {
    el.classList.add('is-visible');
  });

  if (duration > 0) {
    el._toastTimer = setTimeout(function () {
      minalloDismissToast(el);
    }, duration);
  }

  return el;
}

window.showToast = showToast;
