import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const routes = ['index.html', 'student-journey.html', 'german-learning.html'];
for (const file of routes) {
  test(`built ${file} contains complete crawlable marketing HTML`, () => {
    const { document } = parseHTML(readFileSync(`dist/${file}`, 'utf8'));
    const main = document.querySelector('main');
    assert.ok(main, 'semantic main is present in the HTTP source');
    assert.equal(document.querySelectorAll('h1').length, 1);
    assert.ok(main.querySelectorAll('h2').length >= 4);
    const text = main.textContent;
    for (const phrase of ['Minallo', '7-day', '€11.99/month', 'eligible', 'AI can make mistakes']) {
      assert.ok(text.includes(phrase), `visible copy includes ${phrase}`);
    }
    assert.equal(
      document.querySelector('[rel=canonical]').getAttribute('href'),
      `https://minallo.de/${file === 'index.html' ? '' : file}`
    );
    assert.match(document.querySelector('[name=robots]').content, /index,\s*follow/);
    assert.ok(document.querySelector('[property="og:description"]'));
    assert.ok(document.querySelector('[name="twitter:description"]'));
    assert.equal(document.documentElement.lang, 'en');
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    assert.equal(ids.length, new Set(ids).size, 'IDs are unique');
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) assert.ok(document.getElementById(href.slice(1)), href);
      if (href.startsWith('/') && !href.startsWith('//')) {
        const path = href.split('#')[0].split('?')[0];
        assert.ok(existsSync(`dist${path.endsWith('/') ? `${path}index.html` : path}`), href);
      }
    }
    for (const legal of ['privacy', 'terms', 'impressum', 'withdrawal']) {
      assert.ok(document.querySelector(`a[href="/${legal}.html"]`));
    }
    if (file === 'index.html') {
      for (const route of routes.slice(1)) assert.ok(main.querySelector(`a[href="/${route}"]`));
    } else {
      assert.equal(main.querySelectorAll('.octopus-scroll').length, 1);
      assert.equal(main.querySelectorAll('.oct-node').length, 5);
      for (const el of main.querySelectorAll('.oct-node, .experience-block, .pace-section')) {
        assert.ok(el.querySelector('h2,h3'), 'each chapter/arm has a real heading');
        assert.ok(el.querySelector('p')?.textContent.trim().length > 20);
        assert.ok(el.querySelector('a[href]'), 'each feature links to more information');
        assert.equal(el.closest('[hidden]'), null, 'feature content is visible without JS');
      }
      assert.ok(main.querySelector('#plan-form'));
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      assert.doesNotThrow(() => JSON.parse(script.textContent));
    }
  });
}

test('built discovery files include both public journeys and preserve training policy', () => {
  for (const file of ['sitemap.xml', 'llms.txt']) {
    const text = readFileSync(`dist/${file}`, 'utf8');
    for (const path of routes.slice(1)) assert.ok(text.includes(`https://minallo.de/${path}`));
  }
  const robots = readFileSync('dist/robots.txt', 'utf8');
  assert.match(robots, /User-agent: \*\s+Allow: \/\s+Disallow: \/app\//);
  assert.ok(!robots.includes('GPTBot'), 'no new training-policy override');
  assert.ok(existsSync('dist/404.html'), 'Pages must not use SPA fallback for missing routes');
});
