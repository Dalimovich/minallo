// Enhance the existing semantic chapters; without JS every chapter stays visible.
export function initStory() {
  const section = document.querySelector('.journey-chapters');
  if (!section) return;
  const chapters = [...section.querySelectorAll('.journey-chapter')];
  const runway = document.createElement('div');
  runway.className = 'story-runway';
  const stage = document.createElement('div');
  stage.className = 'story-stage';
  section.append(runway);
  runway.append(stage);
  stage.append(...chapters);
  const controls = document.createElement('div');
  controls.className = 'story-controls';
  controls.innerHTML = '<button type="button" data-direction="-1" aria-label="Previous chapter">←</button><span class="story-counter"></span><button type="button" data-direction="1" aria-label="Next chapter">→</button><a class="chapter-link">Skip introduction ↓</a>';
  controls.querySelector('a').href = `#${section.nextElementSibling.id}`;
  stage.append(controls);
  const query = matchMedia('(min-width: 1100px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)');
  let current = 0;
  let frame = 0;
  function paint() {
    frame = 0;
    const distance = runway.offsetHeight - innerHeight;
    current = Math.max(0, Math.min(chapters.length - 1, Math.floor(-runway.getBoundingClientRect().top / Math.max(1, distance) * chapters.length)));
    chapters.forEach((chapter, index) => {
      const inactive = query.matches && index !== current;
      chapter.classList.toggle('story-active', !inactive);
      chapter.inert = inactive;
      if (inactive) chapter.setAttribute('aria-hidden', 'true');
      else chapter.removeAttribute('aria-hidden');
    });
    controls.querySelector('.story-counter').textContent = `${String(current + 1).padStart(2, '0')} / 03 · SCROLL TO CONTINUE`;
    controls.querySelector('[data-direction="-1"]').disabled = current === 0;
  }
  function configure() {
    runway.classList.toggle('story-enhanced', query.matches);
    paint();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  controls.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    const target = current + Number(button.dataset.direction);
    const start = runway.getBoundingClientRect().top + scrollY;
    window.scrollTo({ top: start + target * (runway.offsetHeight - innerHeight) / chapters.length + 2, behavior: 'instant' });
  }));
  window.addEventListener('wheel', event => {
    if (!query.matches || event.defaultPrevented || event.ctrlKey || !event.deltaY || event.target.closest('a, button, input, select, textarea')) return;
    const rect = runway.getBoundingClientRect();
    const end = rect.bottom - innerHeight;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    if ((rect.top > 0 && delta >= rect.top) || (end < 0 && delta <= end)) {
      event.preventDefault();
      window.scrollBy({ top: rect.top > 0 ? rect.top + 1 : end - 1, behavior: 'instant' });
    } else if (rect.top <= 0 && end >= 0 && !(end === 0 && delta > 0) && !(rect.top === 0 && delta < 0)) {
      event.preventDefault();
      window.scrollBy({ top: Math.sign(delta) * Math.min(Math.abs(delta), innerHeight * 0.65), behavior: 'instant' });
    }
  }, { passive: false });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  query.addEventListener('change', configure);
  configure();
}
