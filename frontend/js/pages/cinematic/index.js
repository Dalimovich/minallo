import { initFeatureMap } from './feature-map.js?v=5';
import { initStory } from './story.js?v=1';
import { initPlan } from './plan.js?v=3';
import { openAuth } from './auth.js?v=3';

// Classic deferred auth scripts and this module can finish in either order.
// Announce the already-rendered page only after all deferred scripts ran,
// otherwise the app watchdog reloads an idle marketing page after 15 seconds.
const announceReady = () => window.dispatchEvent(new Event('ss-ready'));
if (document.readyState !== 'complete') {
  document.addEventListener('DOMContentLoaded', announceReady, { once: true });
} else announceReady();

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

initStory();
initFeatureMap();
initPlan();
const journey = document.querySelector('[data-journey]');
if (journey) {
  const loadDemo = () => {
    const module =
      journey.dataset.journey === 'student'
        ? import('./student-demo.js?v=3')
        : import('./german-demo.js?v=3');
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
