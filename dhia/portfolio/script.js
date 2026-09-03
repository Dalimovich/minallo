const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#site-nav');

toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!open));
  nav.classList.toggle('open', !open);
});

nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('open');
  toggle?.setAttribute('aria-expanded', 'false');
}));

const animatedElements = document.querySelectorAll([
  '.reveal',
  '.skill-card',
  '.project',
  '.timeline article',
  '.details-grid > div'
].join(','));

animatedElements.forEach((element, index) => {
  element.classList.add('scroll-reveal');
  element.style.setProperty('--reveal-delay', `${Math.min(index % 3, 2) * 90}ms`);
});

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -7% 0px' });

  animatedElements.forEach((element) => observer.observe(element));
} else {
  animatedElements.forEach((element) => element.classList.add('visible'));
}
