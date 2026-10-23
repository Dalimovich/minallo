export function initFeatureMap() {
  const section = document.querySelector('.octopus-scroll');
  if (!section) return;
  const query = matchMedia(
    '(min-width: 1100px) and (min-height: 800px) and (prefers-reduced-motion: no-preference)'
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
  query.addEventListener('change', configure);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  configure();
}
