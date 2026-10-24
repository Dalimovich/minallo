// Run against an owner-approved staging URL after deployment. Local runs check
// the artifact; they cannot establish Cloudflare WAF access or search indexing.
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
const base = process.argv[2];
const preview = process.argv.includes('--preview');
if (!base || !/^https?:\/\//.test(base)) {
  throw new Error('Usage: node scripts/verify-marketing-http.mjs https://approved-staging-host');
}
for (const path of ['/', '/student-journey.html', '/german-learning.html']) {
  let original;
  for (const agent of ['Minallo-Marketing-QA', 'Googlebot', 'OAI-SearchBot']) {
    const response = await fetch(new URL(path, base), {
      headers: { 'User-Agent': agent },
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(response.status, 200, `${agent}: ${path} must return 200`);
    const headerNoindex = /noindex/i.test(response.headers.get('x-robots-tag') || '');
    if (preview && headerNoindex) {
      console.log(`PREVIEW ${path}: hosting noindex header retained; production indexability not verified`);
    } else {
      assert.ok(!headerNoindex, 'unexpected noindex header');
    }
    const html = await response.text();
    const { document } = parseHTML(html);
    const text = document.querySelector('main')?.textContent;
    assert.ok(
      text?.includes('AI can make mistakes') && text.includes('€11.99/month'),
      'missing static copy / possible challenge'
    );
    assert.equal(
      document.querySelector('[rel=canonical]')?.getAttribute('href'),
      `https://minallo.de${path}`
    );
    assert.match(document.querySelector('[name=robots]')?.content || '', /index,\s*follow/);
    assert.ok(!document.querySelector('[name=robots]')?.content.includes('noindex'));
    if (original) assert.equal(text, original, 'public content varies by user-agent');
    original = text;
    console.log(
      `PASS ${agent} ${response.url}: ${text.length} characters of semantic product content`
    );
  }
}
for (const file of ['sitemap.xml', 'llms.txt', 'robots.txt']) {
  const response = await fetch(new URL(`/${file}`, base), { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  if (file === 'robots.txt') {
    assert.match(text, /User-agent: \*\s+Allow: \/\s+Disallow: \/app\//);
    assert.ok(!text.includes('GPTBot'), 'training policy unexpectedly changed');
  } else {
    for (const path of ['student-journey.html', 'german-learning.html']) {
      assert.ok(text.includes(`https://minallo.de/${path}`));
    }
  }
  console.log(`PASS /${file}`);
}
assert.equal((await fetch(new URL('/marketing-qa-missing-20261020', base))).status, 404);
console.log(
  'PASS missing route returns 404. These user-agent checks do not verify trusted crawler IP access.'
);
