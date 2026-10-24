import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const paths = ['/student-journey.html', '/german-learning.html'];
test('no-JS visitor can choose either complete journey and follow legal links', async ({
  browser,
  baseURL,
  viewport
}, info) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
    viewport: viewport!
  });
  const page = await context.newPage();
  for (const path of paths) {
    await page.goto('/');
    await page.locator(`main a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(path.replace('.', '\\.')));
    await expect(page.locator('h1')).toBeVisible();
    for (const node of await page.locator('.oct-node').all()) {
      await expect(node).toBeVisible();
      await expect(node.locator('p')).toBeVisible();
      await expect(node.locator('a')).toBeVisible();
    }
    await expect(page.locator('#pricing')).toContainText('€11.99/month');
    await expect(page.locator('#trust')).toContainText('AI can make mistakes');
    await expect(page.locator('#plan-form button[type=submit]')).toBeDisabled();
    if (path === paths[0]) await page.locator('.octopus-scroll').screenshot({
      path: `audit/cinematic/student-no-js-${info.project.name}.png`
    });
    await page.locator('footer a[href="/privacy.html"]').click();
    await expect(page).toHaveURL(/privacy/);
  }
  await context.close();
});

test('direct links to later samples initialize controls and small screens remain usable', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/german-learning.html#german-words');
  await expect(page.locator('#vocab-card')).toBeEnabled();
  await page.locator('#vocab-card').click();
  await expect(page.locator('#vocab-front')).toHaveText('Where does the train depart?');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/student-journey.html#student-practice');
  await expect(page.locator('#demo-flashcard')).toBeEnabled();
  await page.locator('#demo-flashcard').click();
  await expect(page.locator('#demo-flash-text')).toHaveText('F = m × a');
});

test('static routes, metadata, 404 and crawler discovery', async ({ request }) => {
  for (const path of ['/', ...paths]) {
    for (const userAgent of ['Googlebot', 'OAI-SearchBot']) {
      const response = await request.get(path, { headers: { 'User-Agent': userAgent } });
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(`https://minallo.de${path}`);
      expect(await response.text()).toContain('AI can make mistakes');
    }
  }
  expect((await request.get('/this-page-does-not-exist')).status()).toBe(404);
  const sitemap = await (await request.get('/sitemap.xml')).text();
  for (const path of paths) expect(sitemap).toContain(path);
});

test('keyboard, physics, tutoring, flashcard, summary, checklist and plan', async ({
  page
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/student-journey.html');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('#student-lab').scrollIntoViewIfNeeded();
  const force = page.locator('#force');
  await expect(force).toBeEnabled();
  await force.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#force-value')).toHaveText('7');
  await expect(page.locator('#accel')).toHaveText('3.5');
  await page.getByRole('button', { name: 'What if I double the force?' }).click();
  await expect(page.locator('[data-answer="force"]')).toBeVisible();
  await page.getByText('Explore the sample takeaways').click();
  await expect(page.locator('#summary-points')).toBeVisible();
  await page.locator('#demo-flashcard').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#demo-flash-text')).toHaveText('F = m × a');
  await page.getByRole('button', { name: 'Next card' }).click();
  await expect(page.locator('#demo-flash-text')).toContainText('force doubles');
  await page.locator('#student-exam input').nth(1).check();
  await expect(page.locator('#exam-progress')).toHaveText('2 / 4');
  await page.getByRole('button', { name: 'I understand this topic' }).click();
  await expect(page.locator('#pace-heading')).toHaveText('Try an exam-style problem');
  await page.locator('#subject').fill('<img src=x onerror=alert(1)>');
  await page.locator('#deadline').selectOption('21');
  await page.locator('#duration').selectOption('20');
  await page.getByRole('button', { name: 'Reveal my starting plan' }).click();
  await expect(page.locator('#plan-result')).toBeFocused();
  await expect(page.locator('#result-title')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#result-title img')).toHaveCount(0);
  await expect(page.locator('#result-desc')).toContainText('three weeks');
  await expect(page.locator('#result-tasks')).toContainText('10 minutes');
  await page.getByRole('button', { name: 'Change answers' }).click();
  await expect(page.locator('#subject')).toBeFocused();
  expect(errors).toEqual([]);
  await page.screenshot({ path: `audit/cinematic/student-plan-${info.project.name}.png` });
});

test('German grammar, vocabulary, writing, checklist and level', async ({ page }, info) => {
  await page.goto('/german-learning.html#german-grammar');
  await expect(page.getByRole('button', { name: 'bin müde', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'bin müde', exact: true }).click();
  await expect(page.locator('#grammar-feedback')).toContainText('Not quite');
  await page.getByRole('button', { name: 'müde bin', exact: true }).click();
  await expect(page.locator('#grammar-feedback')).toContainText('Correct!');
  await page.locator('#vocab-card').click();
  await expect(page.locator('#vocab-front')).toHaveText('Where does the train depart?');
  await expect(page.locator('#vocab-front')).toHaveAttribute('lang', 'en');
  await page.getByRole('link', { name: 'See the guided correction' }).click();
  await expect(page.locator('#writing-response')).toContainText('gegangen');
  await page.locator('#german-exam input').first().check();
  await expect(page.locator('#gexam-progress')).toHaveText('1 / 4');
  await page.getByRole('button', { name: 'B1 practice', exact: true }).click();
  await expect(page.locator('#gpace-heading')).toContainText('B1');
  await expect(page.getByRole('button', { name: 'B1 practice', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.screenshot({ path: `audit/cinematic/german-pace-${info.project.name}.png` });
});

test('feature map sequential reveal, skip and reduced-motion fallback', async ({ page }, info) => {
  await page.goto('/student-journey.html');
  if (info.project.name === 'desktop') {
    const section = page.locator('.octopus-scroll');
    await expect(section).toHaveClass(/map-enhanced/);
    await section.evaluate((el) => window.scrollTo(0, (el as HTMLElement).offsetTop + 300));
    await expect(page.locator('.oct-node.pending')).toHaveCount(5);
    await section.evaluate((el) => window.scrollTo(0, (el as HTMLElement).offsetTop + 1000));
    await expect(page.locator('.oct-node.pending')).toHaveCount(3);
    await page.getByRole('link', { name: 'Skip feature reveal' }).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    await expect(page.locator('.oct-node').last().locator('a')).toBeFocused();
    await expect(page.locator('.oct-node.pending')).toHaveCount(0);
    await page.screenshot({ path: 'audit/cinematic/feature-map-desktop.png', animations: 'disabled' });
  }
  await page.getByRole('link', { name: 'Skip feature reveal' }).click();
  await expect(page).toHaveURL(/#student-lab$/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.oct-pin')).toHaveCSS('position', 'relative');
  for (const node of await page.locator('.oct-node').all()) {
    await expect(node).toBeVisible();
    await expect(node).toHaveCSS('opacity', '1');
  }
});

test('public pages pass automated WCAG A/AA checks', async ({ page }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/', ...paths]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map(v => ({
      id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary }))
    }))).toEqual([]);
  }
});

test('mobile and desktop layout, no WebGL, home screenshot and auth handoff', async ({
  page
}, info) => {
  await page.addInitScript(() => {
    // The experience needs no canvas or WebGL to communicate anything.
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  for (const path of ['/', ...paths]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await expect(page.locator('h1')).toBeVisible();
    await page.screenshot({
      path: `audit/cinematic/${path === '/' ? 'home' : path.slice(1, -5)}-${info.project.name}.png`
    });
  }
  // Stop at the existing app handoff: do not submit credentials or start a trial.
  await page.route('**/app/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Existing Minallo authentication handoff</h1>'
    })
  );
  await page.locator('.site-nav [data-auth]').first().click();
  await expect(page).toHaveURL(/\/app\//);
});
