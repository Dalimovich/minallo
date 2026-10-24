export function initFeatureMap() {
  const section = document.querySelector('.octopus-scroll');
  if (!section) return;
  const query = matchMedia(
    '(min-width: 1100px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)'
  );
  const nodes = [...section.querySelectorAll('.oct-node')];
  const lines = [...section.querySelectorAll('.oct-line')];
  let frame = 0;
  let focused = 0;
  function paint() {
    frame = 0;
    if (!query.matches) return;
    const rect = section.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, -rect.top / (section.offsetHeight - innerHeight)));
    const count = Math.max(focused, Math.min(5, Math.floor(progress * 6)));
    nodes.forEach((node, index) => {
      node.classList.toggle('pending', index >= count);
      node.classList.toggle('active', index === count - 1);
      lines[index].classList.toggle('revealed', index < count);
    });
    section.querySelector('.oct-index').textContent = `${String(count).padStart(2, '0')} / 05`;
    section.querySelector('.oct-title').textContent = count
      ? nodes[count - 1].querySelector('h3').textContent
      : 'A system built around you';
    section.querySelector('.oct-description').textContent = count
      ? nodes[count - 1].querySelector('p').textContent
      : 'Scroll to connect the first feature, or skip to the examples.';
    section.querySelector('.oct-meter i').style.width = `${count * 20}%`;
  }
  function schedule() {
    if (!frame && query.matches) frame = requestAnimationFrame(paint);
  }
  function configure() {
    section.classList.toggle('map-enhanced', query.matches);
    nodes.forEach((node) => node.classList.remove('pending'));
    paint();
  }
  // A keyboard user reveals an arm as soon as its link receives focus.
  nodes.forEach((node, i) =>
    node.addEventListener('focusin', () => {
      focused = Math.max(focused, i + 1);
      paint();
    })
  );

  // position: sticky alone only *looks* pinned — it does not resist scroll
  // speed, so one fast wheel/trackpad flick can cross the whole runway in a
  // single frame and the arms never get a rendered frame to appear on. Pace
  // real scroll to a fixed max speed while progress is strictly between the
  // two ends, so every arm is actually seen; release immediately at either
  // end so this never traps the user (Skip stays available throughout).
  const MAX_STEP_PER_FRAME = 26;
  let queuedDelta = 0;
  let draining = false;
  function drain() {
    draining = false;
    if (!query.matches || queuedDelta === 0) {
      queuedDelta = 0;
      return;
    }
    const rect = section.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, -rect.top / (section.offsetHeight - innerHeight)));
    if ((queuedDelta > 0 && progress >= 1) || (queuedDelta < 0 && progress <= 0)) {
      queuedDelta = 0;
      return;
    }
    const step = Math.sign(queuedDelta) * Math.min(Math.abs(queuedDelta), MAX_STEP_PER_FRAME);
    queuedDelta -= step;
    window.scrollBy({ top: step, left: 0, behavior: 'instant' });
    paint();
    if (queuedDelta !== 0) {
      draining = true;
      requestAnimationFrame(drain);
    }
  }
  function onWheel(event) {
    // Ctrl+wheel is browser zoom. Horizontal gestures and form controls
    // must retain their native behavior too.
    if (
      !query.matches ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.deltaY === 0 ||
      event.target.closest('a, button, input, select, textarea')
    )
      return;
    const rect = section.getBoundingClientRect();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    const end = rect.bottom - innerHeight;
    // Catch a gesture that crosses the entrance before it can skip the map.
    // Listen on the window because that gesture can start in the prior chapter.
    if ((rect.top > 0 && delta >= rect.top) || (end < 0 && delta <= end)) {
      event.preventDefault();
      queuedDelta = 0;
      window.scrollBy({ top: rect.top > 0 ? rect.top + 1 : end - 1, behavior: 'instant' });
      paint();
      return;
    }
    if (rect.top > 0 || end < 0) return;
    const progress = Math.max(0, Math.min(1, -rect.top / (section.offsetHeight - innerHeight)));
    const goingDown = delta > 0;
    if ((goingDown && progress >= 1) || (!goingDown && progress <= 0)) return;
    event.preventDefault();
    const remaining = goingDown ? section.offsetHeight - innerHeight + rect.top : -rect.top;
    queuedDelta =
      Math.sign(delta) * Math.min(Math.abs(queuedDelta + delta), Math.max(0, remaining));
    if (!draining) {
      draining = true;
      requestAnimationFrame(drain);
    }
  }
  window.addEventListener('wheel', onWheel, { passive: false });

  // Never replay queued wheel input after the user chooses another action.
  const cancelQueuedScroll = () => {
    queuedDelta = 0;
  };
  section.addEventListener('click', cancelQueuedScroll);
  window.addEventListener('keydown', cancelQueuedScroll);
  window.addEventListener('pointerdown', cancelQueuedScroll);
  window.addEventListener('hashchange', cancelQueuedScroll);

  query.addEventListener('change', configure);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  configure();
}
