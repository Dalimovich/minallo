import { initFeatureMap } from './feature-map.js?v=2';
import { initPlan } from './plan.js?v=2';
import { openAuth } from './auth.js?v=2';

document.querySelectorAll('[data-auth]').forEach((element) => {
  element.addEventListener('click', async (event) => {
    event.preventDefault();
    document.getElementById('auth-status').textContent = 'Opening secure sign-in…';
    try {
      await openAuth();
    } catch {
      document.getElementById('auth-status').textContent =
        'Sign-in could not load. Please reload the page and try again.';
    }
  });
});

initFeatureMap();
initPlan();
const journey = document.querySelector('[data-journey]');
if (journey) {
  const loadDemo = () => {
    const module =
      journey.dataset.journey === 'student'
        ? import('./student-demo.js?v=2')
        : import('./german-demo.js?v=2');
    module.catch(() => {
      // Static explanations and native details remain usable when loading fails.
      document.getElementById('auth-status').textContent =
        'Some sample controls could not load. Reload to try the interactive examples.';
    });
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadDemo();
        }
      },
      { rootMargin: '800px' }
    );
    journey
      .querySelectorAll('.experience-block, .pace-section')
      .forEach((demo) => observer.observe(demo));
  } else loadDemo();
}
